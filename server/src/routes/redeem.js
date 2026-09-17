const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const redeemStore = require('../services/redeemStore');
const { requireAuth, sameOriginGuard } = require('../middleware/auth');

const router = express.Router();

/**
 * 用户端兑换路由
 *
 * POST /api/redeem  { code } -> { value, quotaRemaining, alreadyRedeemed, message }
 *
 * 安全：
 * - requireAuth：必须登录，额度有明确的归属人
 * - sameOriginGuard：写操作防 CSRF，与其余写接口一致
 * - 限流：码空间有 75 bit 熵，暴力枚举不可行，限流是防脚本刷
 *   与防数据库泄露后有人拿码表来撞。按用户 id 计数（同一账号多 IP 也受限），
 *   未登录时回退到 IP。
 */

const redeemLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.redeem.rateLimitPerMinute,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: '兑换尝试过于频繁，请稍后再试。' }
});

router.use(requireAuth, sameOriginGuard, redeemLimiter);

router.post('/', async (req, res, next) => {
  try {
    const result = await redeemStore.redeem({
      code: req.body?.code,
      userId: req.user.id,
      ip: req.ip
    });

    res.json({
      value: result.value,
      quotaRemaining: result.remaining,
      alreadyRedeemed: result.alreadyRedeemed,
      message: result.alreadyRedeemed
        ? `这个兑换码你已经兑换过了，当时到账 ${result.value} 次额度`
        : `兑换成功，到账 ${result.value} 次额度`
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
