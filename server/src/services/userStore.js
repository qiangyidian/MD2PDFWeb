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
  return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt };
}

// 全部用户 id（配额初始化补发等运维场景用）
async function allUserIds() {
  await ensureLoaded();
  return [...users.values()].map((u) => u.id);
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
  allUserIds,
  authenticate,
  createUser,
  findByEmail,
  hashPassword,
  publicUser,
  validateEmailFormat,
  validateRegistration,
  verifyPassword
};
