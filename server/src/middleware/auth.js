const crypto = require('node:crypto');

const config = require('../config');
const sessionStore = require('../services/sessionStore');
const userStore = require('../services/userStore');

/**
 * 鉴权中间件
 *
 * 安全设计：
 * - 会话凭据只走 HttpOnly Cookie，接口同时支持 X-Auth-Token 头（内部工具/脚本用）
 * - 写操作（POST/PUT/DELETE）要求同源：校验 Origin 头（缺失时回退 Referer），
 *   配合 SameSite=Lax 形成 CSRF 双保险；且不信任代理头，判定基于请求直达的本地端口
 * - isInternalRequest 仅供本机 Puppeteer 拉取任务源文件使用：必须来自 127.0.0.1/::1
 *   且携带一次性内部令牌，二者缺一不可（防外部伪造 X-Forwarded-For 绕过）
 * - 角色不缓存在会话里：每次请求实时读用户表，管理员提权/降权即时生效
 */

const TOKEN_TTL_SECONDS = Math.floor(config.auth.sessionIdleDays * 24 * 60 * 60);

const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function readToken(req) {
  const header = req.get('x-auth-token');
  if (header) return header;

  const cookies = req.get('cookie');
  if (!cookies) return null;
  for (const part of cookies.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === config.auth.cookieName) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

// Cookie 序列化（登录/登出共用；登出时 maxAge=0 立即清除）
function serializeSessionCookie(token, { clear = false } = {}) {
  const parts = [
    `${config.auth.cookieName}=${token ? encodeURIComponent(token) : ''}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${clear ? 0 : TOKEN_TTL_SECONDS}`
  ];
  if (config.auth.cookieSecure) parts.push('Secure');
  parts.push('SameSite=Lax');
  return parts.join('; ');
}

// 同源校验：Origin 优先，缺失（同源 GET/部分浏览器）回退 Referer
function isSameOrigin(req) {
  const origin = req.get('origin');
  const source = origin || req.get('referer');
  if (!source) return false;

  try {
    const url = new URL(source);
    const host = req.get('host');
    // 注意 URL.protocol 带尾冒号（"https:"），req.protocol 不带
    return !!host && url.host === host && url.protocol === `${req.protocol}:`;
  } catch {
    return false;
  }
}

// CSRF 防线：浏览器发起的跨站写请求都带 Origin/Referer，同源请求则二者一致
function sameOriginGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (isSameOrigin(req)) return next();
  res.status(403).json({ error: '跨站请求被拒绝' });
}

// 内部直连判定：本机回环地址 + 一次性内部令牌（Puppeteer 渲染时解析相对图片）
// 令牌由后端在构造 HTML base href 时注入，请求间轮换，外部无法预测
const INTERNAL_TOKEN_HEADER = 'x-md2pdf-internal';
let internalToken = crypto.randomBytes(24).toString('base64url');

function rotateInternalToken() {
  internalToken = crypto.randomBytes(24).toString('base64url');
  return internalToken;
}

function getInternalToken() {
  return internalToken;
}

// 令牌恒定时间比较
function tokenEquals(presented) {
  if (!presented || typeof presented !== 'string') return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(internalToken);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 内部直连判定（Puppeteer 拉取任务源文件专用通道），必须同时满足：
 * 1. TCP 对端是本机回环（Puppeteer 直连 127.0.0.1，不经 nginx）
 * 2. 请求无 X-Forwarded-For 头 —— 生产环境外部请求经 nginx 反代后对端同样是 127.0.0.1，
 *    但 nginx 必设 XFF；Puppeteer 直连不带。以此区分「转发的外部请求」与「本机直连」
 * 3. 一次性内部令牌匹配（恒定时间比较）
 *
 * 令牌传递：请求头（脚本/测试）或 URL 路径前缀 /internal/<token>/<jobId>/source/…
 * （<img> 等子资源无法带自定义头，且相对 URL 解析会丢弃 base 的 query，只能走 path）
 */
function isInternalRequest(req, presentedToken = null) {
  const loopback = LOCAL_ADDRESSES.has(req.socket?.remoteAddress || '');
  const direct = req.get('x-forwarded-for') === undefined;
  if (!loopback || !direct) return false;
  return tokenEquals(presentedToken || req.get(INTERNAL_TOKEN_HEADER) || req.query?._it || null);
}

// 内部通道基址（Puppeteer 专用，绝不能出现在返回给浏览器的 HTML 里）
function internalSourceBase(jobId, relDir = '') {
  return `${config.internalBaseUrl}/api/jobs/internal/${internalToken}/${jobId}/source/${relDir}`;
}

async function requireAuth(req, res, next) {
  try {
    // 内部直连（回环 + 无 XFF + 令牌）：仅用于 Puppeteer 拉取任务源文件。
    // 令牌可能在请求头，也可能在路径 /internal/<token>/… 里（子资源无法带自定义头）
    const pathMatch = req.path?.match(/^\/internal\/([^/]+)\//);
    if (isInternalRequest(req, pathMatch ? pathMatch[1] : null)) {
      req.internal = true;
      next();
      return;
    }

    const token = readToken(req);
    const session = await sessionStore.resolve(token);
    if (!session) {
      res.status(401).json({ error: '请先登录' });
      return;
    }
    // 角色实时读取（不缓存在会话里）：管理员提权/降权、用户删除即时生效
    const isAdmin = await userStore.isAdmin(session.userId);
    req.user = { id: session.userId, email: session.email, name: session.name, isAdmin };
    req.sessionToken = token;
    next();
  } catch (error) {
    next(error);
  }
}

// 管理员专用：requireAuth 之后链式使用
function requireAdmin(req, res, next) {
  if (!req.user?.isAdmin) {
    res.status(403).json({ error: '需要管理员权限' });
    return;
  }
  next();
}

module.exports = {
  isInternalRequest,
  internalSourceBase,
  requireAdmin,
  requireAuth,
  serializeSessionCookie,
  sameOriginGuard,
  getInternalToken,
  INTERNAL_TOKEN_HEADER
};
