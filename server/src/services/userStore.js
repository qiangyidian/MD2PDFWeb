const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config');

/**
 * 用户存储（磁盘 JSON 持久化，无第三方依赖）
 *
 * 安全设计：
 * - 密码使用 scrypt（N=16384, r=8, p=1）加盐哈希，格式 `scrypt$N$r$p$salt$hash`，
 *   内置版本前缀，便于将来升级算法时对旧哈希平滑迁移
 * - 每用户独立 16 字节随机盐，杜绝彩虹表
 * - 校验使用 timingSafeEqual（先比长度再恒定时间比对），不泄露时序信息
 * - users.json 权限 0600、仅属主可读；写入走 tmp+rename 原子替换，进程崩溃不会留下半截文件
 * - 登录失败信息统一为「邮箱或密码错误」，不区分账号是否存在
 *
 * 角色：
 * - user  普通用户（默认）
 * - admin 管理员（管理后台、用户/配额/任务管理；通过环境变量 MD2PDF_ADMIN_EMAILS
 *   在启动时指定，首个管理员由此产生，后续可在管理后台授予/回收）
 */

const usersFile = path.join(config.dataDir, 'users.json');
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

/** @type {Map<string, object>} email(lower) -> user */
let users = new Map();
let loadPromise = null;

async function load() {
  try {
    const raw = await fs.readFile(usersFile, 'utf8');
    const list = JSON.parse(raw);
    users = new Map(list.map((u) => [u.email, u]));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[auth] users.json 读取失败，按空库启动:', error.message);
    }
    users = new Map();
  }

  // 启动提权：MD2PDF_ADMIN_EMAILS（逗号分隔）中的账号设为 admin（幂等）。
  // 这是产生首个管理员的引导通道，之后可在管理后台维护角色
  const adminEmails = config.admin.bootstrapEmails;
  if (adminEmails.length) {
    let promoted = false;
    for (const email of adminEmails) {
      const user = users.get(email);
      if (user && user.role !== 'admin') {
        user.role = 'admin';
        promoted = true;
        console.log(`[auth] 已将 ${email} 提升为管理员（MD2PDF_ADMIN_EMAILS）`);
      }
    }
    if (promoted) await persist();
  }
}

// 原子落盘：先写同目录临时文件再 rename，避免崩溃产生半截 JSON
async function persist() {
  const payload = JSON.stringify([...users.values()], null, 2);
  const tmp = `${usersFile}.${crypto.randomUUID()}.tmp`;
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(tmp, payload, { mode: 0o600 });
  await fs.rename(tmp, usersFile);
}

function ensureLoaded() {
  if (!loadPromise) loadPromise = load();
  return loadPromise;
}

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
      N: Number(n), r: Number(r), p: Number(p)
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

async function findByEmail(email) {
  await ensureLoaded();
  return users.get(String(email).trim().toLowerCase()) || null;
}

async function createUser({ email, password, name }) {
  await ensureLoaded();
  const normalizedEmail = String(email).trim().toLowerCase();
  if (users.has(normalizedEmail)) {
    const error = new Error('该邮箱已注册');
    error.statusCode = 409;
    throw error;
  }

  const user = {
    id: crypto.randomUUID(),
    email: normalizedEmail,
    name: (typeof name === 'string' && name.trim()) || normalizedEmail.split('@')[0],
    passwordHash: hashPassword(password),
    role: 'user', // user | admin（管理员只能由现有管理员或启动引导指定）
    createdAt: Date.now()
  };
  users.set(normalizedEmail, user);
  await persist();
  return { ...user, passwordHash: undefined };
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

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role === 'admin' ? 'admin' : 'user',
    createdAt: user.createdAt
  };
}

// 全部用户 id（配额初始化补发等运维场景用）
async function allUserIds() {
  await ensureLoaded();
  return [...users.values()].map((u) => u.id);
}

// ==================== 管理员操作 ====================

// 用户列表（管理后台用；按注册时间倒序，不含密码哈希）
async function listUsers() {
  await ensureLoaded();
  return [...users.values()]
    .map(publicUser)
    .sort((a, b) => b.createdAt - a.createdAt);
}

async function findById(id) {
  await ensureLoaded();
  return [...users.values()].find((u) => u.id === id) || null;
}

// 设置角色。guard：最后一个管理员不可被降级（避免系统失去管理员而锁死）
async function setRole(id, role) {
  await ensureLoaded();
  if (!['user', 'admin'].includes(role)) {
    const error = new Error('无效的角色');
    error.statusCode = 400;
    throw error;
  }
  const user = await findById(id);
  if (!user) {
    const error = new Error('用户不存在');
    error.statusCode = 404;
    throw error;
  }
  if (user.role === role) return publicUser(user);

  if (user.role === 'admin' && role === 'user') {
    const adminCount = [...users.values()].filter((u) => u.role === 'admin').length;
    if (adminCount <= 1) {
      const error = new Error('系统至少需要保留一名管理员，请先指定其他管理员');
      error.statusCode = 400;
      throw error;
    }
  }

  user.role = role;
  await persist();
  return publicUser(user);
}

// 重置密码（管理员操作，返回新密码明文——仅此一次展示给管理员）
async function adminResetPassword(id, newPassword) {
  await ensureLoaded();
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    const error = new Error('新密码至少 8 位');
    error.statusCode = 400;
    throw error;
  }
  const user = await findById(id);
  if (!user) {
    const error = new Error('用户不存在');
    error.statusCode = 404;
    throw error;
  }
  user.passwordHash = hashPassword(newPassword);
  await persist();
  return publicUser(user);
}

// 删除用户（guard：不可删自己、不可删最后一个管理员）
async function deleteUser(id, operatorId) {
  await ensureLoaded();
  if (id === operatorId) {
    const error = new Error('不能删除当前登录的管理员账号');
    error.statusCode = 400;
    throw error;
  }
  const user = await findById(id);
  if (!user) {
    const error = new Error('用户不存在');
    error.statusCode = 404;
    throw error;
  }
  if (user.role === 'admin' && [...users.values()].filter((u) => u.role === 'admin').length <= 1) {
    const error = new Error('系统至少需要保留一名管理员');
    error.statusCode = 400;
    throw error;
  }
  users.delete(user.email);
  await persist();
  return publicUser(user);
}

// 管理员直接创建用户（不要求邮箱验证码；可指定初始角色与额度由路由层处理）
async function adminCreateUser({ email, password, name, role = 'user' }) {
  const invalid = validateRegistration({ email, password, name });
  if (invalid) {
    const error = new Error(invalid);
    error.statusCode = 400;
    throw error;
  }
  const user = await createUser({ email, password, name });
  if (role === 'admin') {
    const stored = await findByEmail(user.email);
    stored.role = 'admin';
    await persist();
    return publicUser(stored);
  }
  return user;
}

// 用户是否为管理员（requireAuth 每次请求实时读取，保证提权/降权即时生效）
async function isAdmin(id) {
  await ensureLoaded();
  const user = [...users.values()].find((u) => u.id === id);
  return user?.role === 'admin';
}

// 启动时确保数据文件存在且权限正确（首次部署即收紧到 0600）
(async () => {
  await ensureLoaded();
  try {
    const stat = fsSync.statSync(usersFile);
    if ((stat.mode & 0o777) !== 0o600) fsSync.chmodSync(usersFile, 0o600);
  } catch {
    /* 文件尚不存在，首次 persist 时会带 0600 创建 */
  }
})();

module.exports = {
  adminCreateUser,
  adminResetPassword,
  allUserIds,
  authenticate,
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
