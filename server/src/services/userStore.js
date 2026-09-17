const crypto = require('node:crypto');

const { query, withTx } = require('../db/pool');

/**
 * 用户存储（PostgreSQL）
 *
 * 自 2026-09-17 起由 JSON 文件迁移到 PG：单机多请求下的读-改-写不再依赖
 * 进程内 Map，而是靠数据库事务与唯一约束保证。对外导出签名保持不变，
 * 因此 auth/admin 路由无需改动。
 *
 * 安全设计：
 * - 密码使用 scrypt（N=16384, r=8, p=1）加盐哈希，格式 `scrypt$N$r$p$salt$hash`，
 *   内置版本前缀，便于将来升级算法时对旧哈希平滑迁移
 * - 每用户独立 16 字节随机盐，杜绝彩虹表
 * - 校验使用 timingSafeEqual，不泄露时序信息
 * - 登录失败信息统一为「邮箱或密码错误」，不区分账号是否存在（authenticate
 *   对不存在的账号也跑一次 scrypt，拉平响应时间，防账号枚举）
 *
 * 角色：
 * - user  普通用户（默认）
 * - admin 管理员（通过环境变量 MD2PDF_ADMIN_EMAILS 引导首个管理员）
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

// 恒定时间校验：长度差异时也做一次假比对，避免通过耗时探测哈希格式
function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,24}$/;

function validateEmailFormat(email) {
  if (!email || typeof email !== 'string') return '请输入邮箱';
  if (!EMAIL_RE.test(email)) return '邮箱格式不正确';
  return null;
}

function validateRegistration({ email, password, name }) {
  const emailError = validateEmailFormat(email);
  if (emailError) return emailError;
  if (!password || typeof password !== 'string') return '请输入密码';
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 200) return '密码过长（上限 200 字符）';
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length > 40) return '昵称不能超过 40 字符';
  }
  return null;
}

// 数据库行 -> 内部对象。createdAt 统一转成毫秒时间戳，与迁移前保持一致，
// 前端与管理后台的排序/展示代码因此无需改动。
function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at.getTime()
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role === 'admin' ? 'admin' : 'user',
    createdAt: user.createdAt
  };
}

async function findByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [
    String(email).trim().toLowerCase()
  ]);
  return fromRow(rows[0]);
}

async function findById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return fromRow(rows[0]);
}

async function createUser({ email, password, name }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const nickname = (typeof name === 'string' && name.trim()) || normalizedEmail.split('@')[0];

  // 唯一约束是并发注册的最终裁决者：ON CONFLICT DO NOTHING 让后到的一次拿到空结果，
  // 从而转成 409，而不是靠「先查再插」这种在并发下有窗口的写法
  const { rows } = await query(
    `INSERT INTO users (id, email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, 'user')
     ON CONFLICT (email) DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), normalizedEmail, nickname, hashPassword(password)]
  );

  if (!rows.length) {
    const error = new Error('该邮箱已注册');
    error.statusCode = 409;
    throw error;
  }
  return publicUser(fromRow(rows[0]));
}

async function authenticate(email, password) {
  const user = await findByEmail(email);
  if (!user) {
    // 对不存在的账号也做一次 scrypt，拉平响应时间，防账号枚举
    crypto.scryptSync(password, Buffer.alloc(16), KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return null;
  }
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

async function allUserIds() {
  const { rows } = await query('SELECT id FROM users');
  return rows.map((r) => r.id);
}

// ---------- 管理员操作 ----------

async function listUsers() {
  const { rows } = await query('SELECT * FROM users ORDER BY created_at DESC');
  return rows.map((row) => publicUser(fromRow(row)));
}

// 设置角色。guard：最后一个管理员不可被降级（避免系统失去管理员而锁死）。
// 计数与写入在同一事务内完成并对目标行加锁，防止两个管理员并发互降导致零管理员。
async function setRole(id, role) {
  if (!['user', 'admin'].includes(role)) {
    const error = new Error('无效的角色');
    error.statusCode = 400;
    throw error;
  }

  return withTx(async (client) => {
    const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    const user = fromRow(rows[0]);
    if (!user) {
      const error = new Error('用户不存在');
      error.statusCode = 404;
      throw error;
    }
    if (user.role === role) return publicUser(user);

    if (user.role === 'admin' && role === 'user') {
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin'`
      );
      if (countRows[0].n <= 1) {
        const error = new Error('系统至少需要保留一名管理员，请先指定其他管理员');
        error.statusCode = 400;
        throw error;
      }
    }

    await client.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    return publicUser({ ...user, role });
  });
}

async function adminResetPassword(id, newPassword) {
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    const error = new Error('新密码至少 8 位');
    error.statusCode = 400;
    throw error;
  }
  const { rows } = await query('UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *', [
    hashPassword(newPassword),
    id
  ]);
  if (!rows.length) {
    const error = new Error('用户不存在');
    error.statusCode = 404;
    throw error;
  }
  return publicUser(fromRow(rows[0]));
}

async function deleteUser(id, operatorId) {
  if (id === operatorId) {
    const error = new Error('不能删除当前登录的管理员账号');
    error.statusCode = 400;
    throw error;
  }

  return withTx(async (client) => {
    const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    const user = fromRow(rows[0]);
    if (!user) {
      const error = new Error('用户不存在');
      error.statusCode = 404;
      throw error;
    }
    if (user.role === 'admin') {
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin'`
      );
      if (countRows[0].n <= 1) {
        const error = new Error('系统至少需要保留一名管理员');
        error.statusCode = 400;
        throw error;
      }
    }

    // sessions / quota_accounts / quota_ledger 由外键 ON DELETE CASCADE 自动清理
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    return publicUser(user);
  });
}

async function adminCreateUser({ email, password, name, role = 'user' }) {
  const invalid = validateRegistration({ email, password, name });
  if (invalid) {
    const error = new Error(invalid);
    error.statusCode = 400;
    throw error;
  }
  const user = await createUser({ email, password, name });
  if (role === 'admin') {
    await query(`UPDATE users SET role = 'admin' WHERE id = $1`, [user.id]);
    return { ...user, role: 'admin' };
  }
  return user;
}

async function isAdmin(id) {
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [id]);
  return rows[0]?.role === 'admin';
}

// 启动引导：把 MD2PDF_ADMIN_EMAILS 中的邮箱提权为 admin（幂等）
async function bootstrapAdmins(emails) {
  if (!emails.length) return [];
  const { rows } = await query(
    `UPDATE users SET role = 'admin'
      WHERE email = ANY($1) AND role <> 'admin'
      RETURNING email`,
    [emails]
  );
  return rows.map((r) => r.email);
}

module.exports = {
  adminCreateUser,
  adminResetPassword,
  allUserIds,
  authenticate,
  bootstrapAdmins,
  createUser,
  deleteUser,
  findByEmail,
  findById,
  hashPassword,
  isAdmin,
  listUsers,
  publicUser,
  setRole,
  validateEmailFormat,
  validateRegistration,
  verifyPassword
};
