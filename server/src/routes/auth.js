const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const userStore = require('../services/userStore');
const sessionStore = require('../services/sessionStore');
const { requireAuth, serializeSessionCookie } = require('../middleware/auth');

const router = express.Router();

/**
 * 认证路由：注册 / 登录 / 登出 / 当前用户
 *
 * 安全设计：
 * - 注册与登录分开限流（登录更严：15 分钟窗口 10 次），暴力破解成本高于密码价值
 * - 登录/注册失败不区分具体原因（账号不存在 vs 密码错误），防账号枚举
 * - 密码只接受明文一次（HTTPS 传输），服务端即刻哈希，日志永不落密码
 * - Cookie：HttpOnly + Secure + SameSite=Lax，配合同源中间件防 CSRF
 * - 登出即刻吊销会话（opaque token 服务端可作废，这是不用 JWT 的原因）
 */

// 注册限流：每 IP 每 15 分钟最多 5 次
const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '注册尝试过于频繁，请稍后再试。' }
});

// 登录限流：每 IP 每 15 分钟最多 10 次（按 IP；账号维度的慢速分布破解由统一错误信息+scrypt 成本对抗）
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '登录尝试过于频繁，请 15 分钟后再试。' }
});

// 通用限流（/me 轻量查询）
const meLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '请求过于频繁。' }
});

function setSessionCookie(res, token) {
  res.setHeader('Set-Cookie', serializeSessionCookie(token));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', serializeSessionCookie('', { clear: true }));
}

// 注册
router.post('/register', registerLimiter, async (req, res, next) => {
  try {
    const { email, password, name } = req.body || {};
    const invalid = userStore.validateRegistration({ email, password, name });
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }

    const user = await userStore.createUser({ email, password, name });
    const token = await sessionStore.create(user);

    setSessionCookie(res, token);
    res.status(201).json({ user: userStore.publicUser(user) });
  } catch (error) {
    next(error);
  }
});

// 登录
router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: '请输入邮箱和密码' });
      return;
    }

    const user = await userStore.authenticate(email, password);
    if (!user) {
      res.status(401).json({ error: '邮箱或密码错误' });
      return;
    }

    const token = await sessionStore.create(user);
    setSessionCookie(res, token);
    res.json({ user: userStore.publicUser(user) });
  } catch (error) {
    next(error);
  }
});

// 登出（需登录；即刻吊销会话并清 Cookie）
router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    await sessionStore.destroy(req.sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// 当前登录用户（前端刷新后恢复会话）
router.get('/me', meLimiter, requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
