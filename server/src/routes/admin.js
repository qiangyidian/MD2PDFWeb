const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const userStore = require('../services/userStore');
const sessionStore = require('../services/sessionStore');
const quotaStore = require('../services/quotaStore');
const redeemStore = require('../services/redeemStore');
const { format } = require('../services/redeemCode');
const jobManager = require('../services/jobManager');
const scheduler = require('../services/scheduler');
const { requireAuth, requireAdmin, sameOriginGuard } = require('../middleware/auth');

const router = express.Router();

/**
 * 管理后台路由（全部要求管理员权限）
 *
 * - GET  /stats            系统概览（用户/任务/队列/内存）
 * - GET  /users            用户列表（含余额）
 * - POST /users            创建用户（免邮箱验证）
 * - PATCH /users/:id/role  设置角色（最后一道防线：最后一个 admin 不可降级）
 * - POST /users/:id/quota  调整余额（正充值负扣减）
 * - POST /users/:id/password 重置密码（生成随机密码返回一次）
 * - DELETE /users/:id      删除用户（不可删自己/最后一个 admin；踢全部会话）
 * - GET  /jobs             全量任务列表
 * - POST /jobs/:id/cancel  取消任意任务
 * - DELETE /jobs/:id       强制删除任务
 * - GET  /redeem-stats            兑换码汇总
 * - POST /redeem-codes            批量生成兑换码（面额/数量/截止时间/备注）
 * - GET  /redeem-codes            兑换码列表（按状态/批次筛选 + 分页）
 * - POST /redeem-codes/revoke     作废（按 id 列表或整批）
 * - GET  /redeem-codes/export     导出某批次的 CSV
 *
 * 安全：requireAuth（实时角色）→ requireAdmin → sameOriginGuard（写操作防 CSRF）
 */

router.use(requireAuth, requireAdmin, sameOriginGuard);

// 管理操作限流（防脚本失控）
const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '操作过于频繁，请稍后再试。' }
});
router.use(adminLimiter);

// ---------- 系统概览 ----------

router.get('/stats', async (_req, res, next) => {
  try {
    const users = await userStore.listUsers();
    const jobs = jobManager.listJobsForAdmin();
    const active = jobs.filter((j) => ['queued', 'converting'].includes(j.status));
    res.json({
      users: {
        total: users.length,
        admins: users.filter((u) => u.role === 'admin').length,
        newToday: users.filter((u) => {
          const dayStart = new Date();
          dayStart.setHours(0, 0, 0, 0);
          return u.createdAt >= dayStart.getTime();
        }).length
      },
      jobs: {
        total: jobs.length,
        active: active.length,
        filesProcessed: jobs.reduce((n, j) => n + (j.stats?.success || 0), 0),
        filesFailed: jobs.reduce((n, j) => n + (j.stats?.failed || 0), 0)
      },
      queue: scheduler.stats(),
      config: {
        freeGrant: config.quota.freeGrant,
        concurrency: config.concurrency,
        jobTtlHours: Math.round(config.limits.jobTtlMs / 3600 / 1000)
      }
    });
  } catch (error) {
    next(error);
  }
});

// ---------- 用户管理 ----------

// 用户列表 + 余额 + 当前任务数
router.get('/users', async (_req, res, next) => {
  try {
    const users = await userStore.listUsers();
    const quotaMap = await quotaStore.getRemainingMap(users.map((u) => u.id));
    res.json({
      users: users.map((u) => ({
        ...u,
        quotaRemaining: quotaMap[u.id] ?? 0,
        activeJobs: scheduler.countByOwner(u.id)
      }))
    });
  } catch (error) {
    next(error);
  }
});

// 创建用户（免邮箱验证码；可指定初始角色，默认普通用户并赠送注册额度）
router.post('/users', async (req, res, next) => {
  try {
    const { email, password, name, role } = req.body || {};
    const user = await userStore.adminCreateUser({ email, password, name, role });
    await quotaStore.grant(user.id, config.quota.freeGrant, '管理员创建账号赠送');
    res.status(201).json({ user });
  } catch (error) {
    next(error);
  }
});

// 设置角色
router.patch('/users/:id/role', async (req, res, next) => {
  try {
    const user = await userStore.setRole(req.params.id, String(req.body?.role || ''));
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

// 调整余额（delta 正数充值、负数扣减）
router.post('/users/:id/quota', async (req, res, next) => {
  try {
    const user = await userStore.findById(req.params.id);
    if (!user) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    const delta = Math.round(Number(req.body?.delta));
    if (!Number.isFinite(delta) || delta === 0) {
      res.status(400).json({ error: '请输入非零的调整数额' });
      return;
    }
    const quotaRemaining = await quotaStore.adjust(user.id, delta, '管理员调整');
    res.json({ user: userStore.publicUser(user), quotaRemaining });
  } catch (error) {
    next(error);
  }
});

// 重置密码：生成 12 位随机密码，返回一次；同时踢掉该用户全部会话
router.post('/users/:id/password', async (req, res, next) => {
  try {
    const user = await userStore.findById(req.params.id);
    if (!user) {
      res.status(404).json({ error: '用户不存在' });
      return;
    }
    const newPassword = req.body?.password || crypto.randomBytes(9).toString('base64url');
    await userStore.adminResetPassword(user.id, newPassword);
    await sessionStore.destroyAllForUser(user.id);
    res.json({ user: userStore.publicUser(user), newPassword });
  } catch (error) {
    next(error);
  }
});

// 删除用户：清余额 + 踢会话（不删历史任务，任务随 TTL 自然过期）
router.delete('/users/:id', async (req, res, next) => {
  try {
    const user = await userStore.deleteUser(req.params.id, req.user.id);
    await sessionStore.destroyAllForUser(user.id);
    await quotaStore.removeUser(user.id);
    res.json({ user });
  } catch (error) {
    next(error);
  }
});

// ---------- 任务管理 ----------

router.get('/jobs', (_req, res) => {
  const jobs = jobManager.listJobsForAdmin();
  // 附任务归属邮箱（前端展示用；Map 查找 O(1)，这里每请求构建一次索引）
  res.json({ jobs });
});

router.post('/jobs/:id/cancel', async (req, res, next) => {
  try {
    const job = jobManager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: '任务不存在或已过期' });
      return;
    }
    const ok = jobManager.cancelJob(job);
    res.json({ ok, ...jobManager.snapshot(job) });
  } catch (error) {
    next(error);
  }
});

router.delete('/jobs/:id', async (req, res, next) => {
  try {
    const job = jobManager.getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: '任务不存在或已过期' });
      return;
    }
    await jobManager.deleteJobForAdmin(job);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

// ---------- 兑换码管理 ----------

// 码在库里存裸码，返回给管理端一律转成带连字符的展示格式，便于抄写与核对
function toDisplay(row) {
  return { ...row, display: format(row.code) };
}

const REDEEM_STATUS_LABEL = { unused: '未使用', used: '已使用', revoked: '已作废' };

router.get('/redeem-stats', async (_req, res, next) => {
  try {
    res.json(await redeemStore.stats());
  } catch (error) {
    next(error);
  }
});

router.post('/redeem-codes', async (req, res, next) => {
  try {
    const { value, count, expiresAt, note } = req.body || {};

    let parsedExpiry = null;
    if (expiresAt) {
      parsedExpiry = new Date(expiresAt);
      if (Number.isNaN(parsedExpiry.getTime())) {
        res.status(400).json({ error: '截止时间格式不正确' });
        return;
      }
    }

    const { batchId, codes } = await redeemStore.createBatch({
      value: Number(value),
      count: Number(count),
      expiresAt: parsedExpiry,
      note: typeof note === 'string' ? note.slice(0, 200) : '',
      createdBy: req.user.id
    });

    res.status(201).json({ batchId, count: codes.length, codes: codes.map(format) });
  } catch (error) {
    next(error);
  }
});

router.get('/redeem-codes', async (req, res, next) => {
  try {
    const { status, batchId, limit, offset } = req.query || {};
    const result = await redeemStore.listCodes({
      status: status || '',
      batchId: batchId || '',
      limit,
      offset
    });
    res.json({ total: result.total, codes: result.codes.map(toDisplay) });
  } catch (error) {
    next(error);
  }
});

router.post('/redeem-codes/revoke', async (req, res, next) => {
  try {
    const { ids, batchId } = req.body || {};
    const result = await redeemStore.revoke({
      ids: Array.isArray(ids) ? ids : [],
      batchId: typeof batchId === 'string' ? batchId : '',
      revokedBy: req.user.id
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/redeem-codes/export', async (req, res, next) => {
  try {
    const batchId = req.query?.batchId || '';
    if (!batchId) {
      res.status(400).json({ error: '请指定要导出的批次' });
      return;
    }
    const rows = await redeemStore.listForExport(batchId);

    const header = ['兑换码', '面额', '状态', '生成时间', '截止时间', '兑付人', '兑付时间'];
    const lines = [header.join(',')];

    for (const row of rows) {
      lines.push(
        [
          format(row.code),
          row.value,
          REDEEM_STATUS_LABEL[row.status] || row.status,
          new Date(row.createdAt).toISOString(),
          row.expiresAt ? new Date(row.expiresAt).toISOString() : '永久',
          row.usedBy || '',
          row.usedAt ? new Date(row.usedAt).toISOString() : ''
        ].join(',')
      );
    }

    // 前置 \ufeff：Excel 打开 UTF-8 CSV 需要 BOM，否则中文表头变乱码
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="redeem-codes-${batchId}.csv"`);
    res.send(`\ufeff${lines.join('\r\n')}\r\n`);
  } catch (error) {
    next(error);
  }
});

module.exports = router;

