const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config');

/**
 * 会话存储（ opaque 随机 token + 服务端会话表）
 *
 * 为什么不用 JWT：本服务是单进程 Express，无跨服务校验诉求；
 * opaque token 可以随时服务端吊销（登出即失效），不存在 JWT 无法主动作废的问题，
 * 也不需要把会话状态泄漏到客户端。
 *
 * 安全设计：
 * - token 为 32 字节 CSPRNG（base64url），仅通过 HttpOnly+Secure+SameSite=Lax Cookie 传输，
 *   XSS 拿不到；磁盘上只存 sha256(token)，库文件泄露也无法反查出 token
 * - 滑动过期（默认 7 天活跃续期）+ 绝对过期（默认 30 天强制重新登录）
 * - 进程重启会话保持（sessions.json 持久化），用户不被登出
 * - 定期清扫过期会话，防表无限膨胀
 */

const sessionsFile = path.join(config.dataDir, 'sessions.json');

const IDLE_TTL_MS = config.auth.sessionIdleDays * 24 * 60 * 60 * 1000;       // 不活跃过期
const ABSOLUTE_TTL_MS = config.auth.sessionAbsoluteDays * 24 * 60 * 60 * 1000; // 最长生命周期

/** @type {Map<string, object>} sha256(token) -> session */
let sessions = new Map();
let loadPromise = null;
let persistTimer = null;

function tokenId(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function load() {
  try {
    const raw = await fs.readFile(sessionsFile, 'utf8');
    const entries = JSON.parse(raw);
    const now = Date.now();
    sessions = new Map();
    for (const s of entries) {
      if (now - s.lastSeenAt < IDLE_TTL_MS && now - s.createdAt < ABSOLUTE_TTL_MS) {
        sessions.set(s.tokenId, s);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[auth] sessions.json 读取失败，按空表启动:', error.message);
    }
    sessions = new Map();
  }
}

function ensureLoaded() {
  if (!loadPromise) loadPromise = load();
  return loadPromise;
}

// 合并写：短窗口内多次变更只落一次盘，避免登录高峰频繁 IO
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const payload = JSON.stringify([...sessions.values()], null, 2);
      const tmp = `${sessionsFile}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.writeFile(tmp, payload, { mode: 0o600 });
      await fs.rename(tmp, sessionsFile);
    } catch (error) {
      console.error('[auth] sessions.json 写入失败:', error.message);
    }
  }, 500);
  persistTimer.unref?.();
}

function isExpired(session, now = Date.now()) {
  return now - session.lastSeenAt >= IDLE_TTL_MS || now - session.createdAt >= ABSOLUTE_TTL_MS;
}

// 创建会话，返回明文 token（仅在创建时出现一次）
async function create(user) {
  await ensureLoaded();
  const token = crypto.randomBytes(32).toString('base64url');
  const session = {
    tokenId: tokenId(token),
    userId: user.id,
    email: user.email,
    name: user.name,
    createdAt: Date.now(),
    lastSeenAt: Date.now()
  };
  sessions.set(session.tokenId, session);
  schedulePersist();
  return token;
}

// 校验并续期（滑动过期）
async function resolve(token) {
  await ensureLoaded();
  if (!token) return null;
  const session = sessions.get(tokenId(token));
  if (!session) return null;
  if (isExpired(session)) {
    sessions.delete(session.tokenId);
    schedulePersist();
    return null;
  }
  session.lastSeenAt = Date.now();
  schedulePersist();
  return session;
}

async function destroy(token) {
  await ensureLoaded();
  if (token && sessions.delete(tokenId(token))) schedulePersist();
}

// 吊销某用户的全部会话（管理员重置密码/删除用户时调用，即刻踢下线）
async function destroyAllForUser(userId) {
  await ensureLoaded();
  let removed = 0;
  for (const [id, s] of sessions) {
    if (s.userId === userId) {
      sessions.delete(id);
      removed += 1;
    }
  }
  if (removed) schedulePersist();
  return removed;
}

// 定期清扫 + 持久化兜底（登录后存活，间隔 10 分钟）
function startSweeper() {
  const timer = setInterval(() => {
    const now = Date.now();
    let dirty = false;
    for (const [id, s] of sessions) {
      if (isExpired(s, now)) {
        sessions.delete(id);
        dirty = true;
      }
    }
    if (dirty) schedulePersist();
  }, config.limits.sweepIntervalMs);
  timer.unref?.();
}

module.exports = { create, destroy, destroyAllForUser, resolve, startSweeper };
