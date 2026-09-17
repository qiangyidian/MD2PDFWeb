const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const userStore = require('../services/userStore');
const sessionStore = require('../services/sessionStore');
const quotaStore = require('../services/quotaStore');
const verification = require('../services/verificationStore');
const { MailError, sendVerificationEmail } = require('../services/mailer');
const { requireAuth, serializeSessionCookie } = require('../middleware/auth');

const router = express.Router();

/**
 * 认证路由：验证码下发 / 注册 / 双模式登录（密码 | 邮箱验证码）/ 登出 / 当前用户
 *
 * 流程移植自 SQL2ER auth_service：
 * - POST /email/request  下发验证码（purpose=register|login，各自独立命名空间）
 * - POST /register       必须携带 register 用途的有效验证码
 * - POST /login/password 密码登录（失败锁定：邮箱 5/15min、IP 20/15min）
 * - POST /login/email    验证码登录（login 用途码，一次性消费）
 *
 * 安全设计（沿用本服务既有约定）：
 * - 统一错误信息防账号枚举（登录/验证码路径不区分「不存在/密码错/码错」）
 * - 验证码请求双维度限流：邮箱 60s 间隔 + 5 次/10min，IP 20 次/10min
 * - 邮件发送失败会撤销刚记录的限流事件（业务失败不消耗配额）
 * - Cookie：HttpOnly + Secure + SameSite=Lax；写操作同源校验防 CSRF
 */

// 验证码请求限流（兜底；精细的邮箱/IP 双维度在 verificationStore 内）
const codeRequestLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '验证码请求过于频繁，请稍后再试。' }
});

// 注册/登录提交限流
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '操作过于频繁，请稍后再试。' }
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

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// 下发邮箱验证码（注册/登录共用，purpose 隔离）
router.post('/email/request', codeRequestLimiter, async (req, res, next) => {
  try {
    const purpose = String(req.body?.purpose || '');
    if (!verification.ALLOWED_PURPOSES.has(purpose)) {
      res.status(400).json({ error: '不支持的验证码用途' });
      return;
    }

    const email = normalizeEmail(req.body?.email);
    const emailError = userStore.validateEmailFormat(email);
    if (emailError) {
      res.status(400).json({ error: emailError });
      return;
    }

    // 注册用途：已注册账号直接提示（这里明确提示是产品需要：引导用户去登录而非重复注册）
    const existing = await userStore.findByEmail(email);
    if (purpose === 'register' && existing) {
      res.status(409).json({ error: '该邮箱已注册，请直接登录' });
      return;
    }
    if (purpose === 'login' && !existing) {
      res.status(404).json({ error: '该邮箱尚未注册，请先完成注册' });
      return;
    }

    verification.enforceCodeRequestLimit(email, req.ip);
    const code = verification.issueCode(purpose, email);

    if (config.mail.debugEchoCodes && !config.mail.enabled) {
      // 本地调试：不发信，直接回显（与 SQL2ER debug_echo_codes 行为一致）
      verification.recordCodeRequest(email, req.ip);
      res.json({ ok: true, debugCode: code });
      return;
    }

    try {
      await sendVerificationEmail(email, code, purpose);
    } catch (error) {
      // 邮件没发出去：撤销限流事件，用户重试不受影响
      verification.discardCodeRequest(email, req.ip);
      throw error;
    }
    verification.recordCodeRequest(email, req.ip);

    res.json({ ok: true });
  } catch (error) {
    if (error instanceof MailError) {
      res.status(502).json({ error: error.message });
      return;
    }
    next(error);
  }
});

// 注册（必须携带 register 用途验证码）
router.post('/register', submitLimiter, async (req, res, next) => {
  try {
    const { email, password, name, code } = req.body || {};
    const normalized = normalizeEmail(email);

    const invalid = userStore.validateRegistration({ email: normalized, password, name });
    if (invalid) {
      res.status(400).json({ error: invalid });
      return;
    }
    if (!code || typeof code !== 'string') {
      res.status(400).json({ error: '请输入邮箱验证码' });
      return;
    }

    // 先验码（一次性消费，无论后续注册是否成功码都作废——防用码探测）
    if (!verification.verifyAndConsume('register', normalized, code)) {
      res.status(401).json({ error: '邮箱验证码错误或已过期' });
      return;
    }

    const user = await userStore.createUser({ email: normalized, password, name });

    // 注册赠送免费额度（按成功渲染的 PDF 个数计）
    await quotaStore.grant(user.id, config.quota.freeGrant, '注册赠送');

    const token = await sessionStore.create(user);

    setSessionCookie(res, token);
    res.status(201).json({
      user: userStore.publicUser(user),
      quotaRemaining: config.quota.freeGrant
    });
  } catch (error) {
    next(error);
  }
});

// 密码登录（失败锁定防字典攻击）
router.post('/login/password', submitLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || !password) {
      res.status(400).json({ error: '请输入邮箱和密码' });
      return;
    }

    verification.enforcePasswordLoginLimit(email, req.ip);
    const user = await userStore.authenticate(email, password);
    if (!user) {
      verification.recordPasswordLoginFailure(email, req.ip);
      res.status(401).json({ error: '邮箱或密码错误' });
      return;
    }

    const token = await sessionStore.create(user);
    setSessionCookie(res, token);
    // 登录响应附带剩余额度（与注册一致），避免前端登录后徽章显示占位
    res.json({
      user: userStore.publicUser(user),
      quotaRemaining: await quotaStore.getRemaining(user.id)
    });
  } catch (error) {
    next(error);
  }
});

// 验证码登录（login 用途码）
router.post('/login/email', submitLimiter, async (req, res, next) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = req.body?.code;
    if (!email || !code) {
      res.status(400).json({ error: '请输入邮箱和验证码' });
      return;
    }

    const user = await userStore.findByEmail(email);
    if (!user) {
      res.status(401).json({ error: '邮箱或验证码错误' });
      return;
    }
    if (!verification.verifyAndConsume('login', email, code)) {
      res.status(401).json({ error: '邮箱或验证码错误' });
      return;
    }

    const token = await sessionStore.create(user);
    setSessionCookie(res, token);
    // 登录响应附带剩余额度（与注册一致），避免前端登录后徽章显示占位
    res.json({
      user: userStore.publicUser(user),
      quotaRemaining: await quotaStore.getRemaining(user.id)
    });
  } catch (error) {
    next(error);
  }
});

// 兼容旧客户端：/login 由提交内容自动分流（密码存在→密码登录，否则验证码登录）
router.post('/login', submitLimiter, (req, res, next) => {
  if (req.body?.password) {
    router.handle({ ...req, url: '/password' }, res, next);
    return;
  }
  router.handle({ ...req, url: '/email' }, res, next);
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

// 当前登录用户（前端刷新后恢复会话；附带剩余额度与角色）
router.get('/me', meLimiter, requireAuth, async (req, res) => {
  const quotaRemaining = await quotaStore.getRemaining(req.user.id);
  res.json({
    user: { ...req.user, role: req.user.isAdmin ? 'admin' : 'user' },
    quotaRemaining
  });
});

module.exports = router;
