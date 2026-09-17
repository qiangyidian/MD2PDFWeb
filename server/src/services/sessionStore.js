const crypto = require('node:crypto');

const config = require('../config');
const { query } = require('../db/pool');

/**
 * 会话存储（PostgreSQL）
 *
 * 为什么不用 JWT：本服务是单进程 Express，无跨服务校验诉求；
 * opaque token 可以随时服务端吊销（登出即失效），不存在 JWT 无法主动作废的问题，
 * 也不需要把会话状态泄漏到客户端。
 *
 * 安全设计：
 * - token 为 32 字节 CSPRNG（base64url），仅通过 HttpOnly+Secure+SameSite=Lax Cookie 传输，
 *   XSS 拿不到；库里只存 sha256(token)，库被拖也无法反查出 token
 * - 滑动过期（默认 7 天活跃续期）+ 绝对过期（默认 30 天强制重新登录）
 * - 进程重启会话保持，用户不被登出
 * - 定期清扫过期会话，防表无限膨胀
 *
 * 迁移到 PG 后的取舍：滑动续期做写库节流。原实现写进程内 Map，
 * 每请求改一次内存零成本；现在每请求一次 UPDATE 就把读放大成了写放大，
 * 因此距上次续期不足 sessionTouchIntervalMs 时跳过写入。
 * 代价是 last_seen_at 最多滞后一个窗口，空闲过期判定因此有最多一个窗口的宽限，
 * 对 7 天量级的 TTL 可忽略。
 */

const IDLE_TTL_MS = config.auth.sessionIdleDays * 24 * 60 * 60 * 1000;
const ABSOLUTE_TTL_MS = config.auth.sessionAbsoluteDays * 24 * 60 * 60 * 1000;

function tokenId(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function create(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token_id, user_id, created_at, last_seen_at)
     VALUES ($1, $2, now(), now())`,
    [tokenId(token), user.id]
  );
  return token;
}

async function resolve(token) {
  if (!token) return null;
  const id = tokenId(token);

  // 用户信息从 users 表实时联查，不在会话里冗余存储：
  // 管理员改了昵称、删了账号，下一次请求即生效
  const { rows } = await query(
    `SELECT s.user_id, s.created_at, s.last_seen_at, u.email, u.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  if (
    now - row.last_seen_at.getTime() >= IDLE_TTL_MS ||
    now - row.created_at.getTime() >= ABSOLUTE_TTL_MS
  ) {
    // 过期即删：否则这行会一直留到下一次清扫，期间每次请求都白读一次
    await query('DELETE FROM sessions WHERE token_id = $1', [id]);
    return null;
  }

  // 滑动续期（节流）：超过窗口才写库
  if (now - row.last_seen_at.getTime() > config.auth.sessionTouchIntervalMs) {
    await query('UPDATE sessions SET last_seen_at = now() WHERE token_id = $1', [id]);
  }

  return {
    tokenId: id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at.getTime(),
    lastSeenAt: now
  };
}

async function destroy(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_id = $1', [tokenId(token)]);
}

// 吊销某用户的全部会话（管理员重置密码/删除用户时调用，即刻踢下线）
async function destroyAllForUser(userId) {
  const { rowCount } = await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return rowCount;
}

/**
 * 清扫过期会话，返回删除条数。
 *
 * 截止时间在 JS 侧算好再作为 timestamptz 参数传入，不在 SQL 里做时间运算。
 * 曾经的写法是 `now() - ($1::bigint || ' milliseconds')::interval`，
 * 而 PostgreSQL 解析 `NNN milliseconds` 用的是 int4：30 天的毫秒数
 * 2592000000 超过 int4 上限 2147483647，于是清扫每 10 分钟失败一次、
 * 静默地什么也没删（线上日志里连续刷了 20 分钟才被发现）。
 * 传时间戳既没有单位换算也没有溢出，且一眼能看懂。
 */
async function sweepExpired(now = Date.now()) {
  const { rowCount } = await query(
    `DELETE FROM sessions WHERE last_seen_at < $1 OR created_at < $2`,
    [new Date(now - IDLE_TTL_MS), new Date(now - ABSOLUTE_TTL_MS)]
  );
  return rowCount;
}

// 定期清扫（登录后存活，间隔 10 分钟）
function startSweeper() {
  const timer = setInterval(async () => {
    try {
      const removed = await sweepExpired();
      if (removed) console.log(`[auth] 已清扫 ${removed} 条过期会话`);
    } catch (error) {
      console.error('[auth] 过期会话清扫失败:', error.message);
    }
  }, config.limits.sweepIntervalMs);
  timer.unref?.();
}

module.exports = { create, destroy, destroyAllForUser, resolve, startSweeper, sweepExpired };