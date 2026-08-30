const crypto = require('node:crypto');

const config = require('../config');

/**
 * 验证码存储 + 限流事件表（进程内实现，语义移植自 SQL2ER code_store）
 *
 * 安全设计（与 SQL2ER 一致）：
 * - 命名空间隔离：register 码与 login 码互不通用（一个被偷的注册码无法解锁登录）
 * - 一次性消费：验证尝试即销毁（错码也烧掉），被读过的码不可重放
 * - 验证尝试次数上限（3 次）：超过作废当前码，防止对 6 位码在线穷举
 * - 恒定时间比较：验证码比对不泄露时序
 * - 双维度限流：邮箱级（60s 间隔 + 5 次/10min）挡单账号轰炸；
 *   IP 级（20 次/10min）挡换邮箱绕过；邮件发送失败会撤销已记事件
 * - 密码登录失败锁定：邮箱 5 次/15min、IP 20 次/15min，防字典/喷洒
 */

const ALLOWED_PURPOSES = new Set(['register', 'login']);
const MAX_VERIFY_ATTEMPTS = 3;

const codes = new Map();    // `${purpose}:${email}` -> { value, expiresAt, attempts }
const events = new Map();   // `${namespace}:${key}` -> number[]（时间戳）

function sweep(now) {
  for (const [key, entry] of codes) {
    if (entry.expiresAt <= now) codes.delete(key);
  }
  const horizon = now - 3600 * 1000; // 事件只对限流窗口有意义，1 小时后清理
  for (const [key, list] of events) {
    const kept = list.filter((t) => t > horizon);
    if (kept.length === 0) events.delete(key);
    else if (kept.length !== list.length) events.set(key, kept);
  }
}

function startSweeper() {
  const timer = setInterval(() => sweep(Date.now()), 60 * 1000);
  timer.unref?.();
}

// ---------- 验证码 ----------

function issueCode(purpose, email) {
  const code = String(parseInt(crypto.randomBytes(4).toString('hex'), 16)).padStart(6, '0').slice(-6);
  codes.set(`${purpose}:${email}`, {
    value: code,
    expiresAt: Date.now() + config.mail.verificationCodeTtlSeconds * 1000,
    attempts: 0
  });
  return code;
}

function constantTimeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * 验证并消费：每次尝试都会递增计数，第 MAX_VERIFY_ATTEMPTS 次失败后销毁（防在线穷举）。
 * 成功立即销毁。返回 true 仅当码有效且匹配。
 */
function verifyAndConsume(purpose, email, presented) {
  const key = `${purpose}:${email}`;
  const entry = codes.get(key);
  if (!entry || entry.expiresAt <= Date.now()) {
    codes.delete(key);
    return false;
  }

  const matched = constantTimeEq(entry.value, presented);

  if (matched) {
    codes.delete(key); // 一次性：成功即作废
    return true;
  }

  entry.attempts += 1;
  if (entry.attempts >= MAX_VERIFY_ATTEMPTS) {
    codes.delete(key); // 尝试次数用尽：烧掉，必须重新获取
  } else {
    codes.set(key, entry); // Map 里是引用，此处仅显式化意图
  }
  return false;
}

// ---------- 限流事件 ----------

function recordEvent(namespace, key) {
  const k = `${namespace}:${key}`;
  const list = events.get(k) || [];
  list.push(Date.now());
  events.set(k, list);
}

function discardEvent(namespace, key) {
  // 尽力而为撤销最近一次事件：业务失败不应消耗限流配额
  const k = `${namespace}:${key}`;
  const list = events.get(k);
  if (list && list.length) list.pop();
}

function countRecent(namespace, key, windowMs) {
  const cutoff = Date.now() - windowMs;
  return (events.get(`${namespace}:${key}`) || []).filter((t) => t > cutoff).length;
}

function lastEventWithin(namespace, key, windowMs) {
  const list = events.get(`${namespace}:${key}`) || [];
  const last = list[list.length - 1];
  return !!last && Date.now() - last < windowMs;
}

// ---------- 验证码请求限流（邮箱 + IP 双维度） ----------

function enforceCodeRequestLimit(email, ip) {
  const { verificationCodeRequestIntervalMs, verificationCodeBurstWindowMs, verificationCodeBurstLimit, ipCodeRequestBurstLimit } = config.mail;

  if (lastEventWithin('code_interval', email, verificationCodeRequestIntervalMs)) {
    const error = new Error('验证码请求过于频繁，请稍后再试');
    error.statusCode = 429;
    throw error;
  }
  if (countRecent('code_burst', email, verificationCodeBurstWindowMs) >= verificationCodeBurstLimit) {
    const error = new Error('验证码请求过于频繁，请稍后再试');
    error.statusCode = 429;
    throw error;
  }
  if (ip && countRecent('code_burst', `ip:${ip}`, verificationCodeBurstWindowMs) >= ipCodeRequestBurstLimit) {
    const error = new Error('验证码请求过于频繁，请稍后再试');
    error.statusCode = 429;
    throw error;
  }
}

function recordCodeRequest(email, ip) {
  recordEvent('code_interval', email);
  recordEvent('code_burst', email);
  if (ip) recordEvent('code_burst', `ip:${ip}`);
}

function discardCodeRequest(email, ip) {
  discardEvent('code_interval', email);
  discardEvent('code_burst', email);
  if (ip) discardEvent('code_burst', `ip:${ip}`);
}

// ---------- 密码登录失败锁定 ----------

function enforcePasswordLoginLimit(email, ip) {
  const { passwordLoginMaxAttempts, passwordLoginIpMaxAttempts, passwordLoginLockoutMs } = config.mail;
  if (countRecent('pw_fail', email, passwordLoginLockoutMs) >= passwordLoginMaxAttempts) {
    const error = new Error('密码错误次数过多，请稍后再试或使用验证码登录');
    error.statusCode = 429;
    throw error;
  }
  if (ip && countRecent('pw_fail', `ip:${ip}`, passwordLoginLockoutMs) >= passwordLoginIpMaxAttempts) {
    const error = new Error('该网络密码错误次数过多，请稍后再试');
    error.statusCode = 429;
    throw error;
  }
}

function recordPasswordLoginFailure(email, ip) {
  recordEvent('pw_fail', email);
  if (ip) recordEvent('pw_fail', `ip:${ip}`);
}

module.exports = {
  ALLOWED_PURPOSES,
  constantTimeEq,
  discardCodeRequest,
  enforceCodeRequestLimit,
  enforcePasswordLoginLimit,
  issueCode,
  recordCodeRequest,
  recordPasswordLoginFailure,
  startSweeper,
  verifyAndConsume
};
