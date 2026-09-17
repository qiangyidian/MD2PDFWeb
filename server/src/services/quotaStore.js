const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const config = require('../config');

/**
 * 用户配额：剩余可处理文档数
 *
 * 计费模型（按成功渲染的 PDF 个数）：
 * - reserve：文件开始渲染前预扣 1（并发下不漏扣的关键）
 * - release：渲染真实失败（超时/崩溃等）时退回，用户不为系统故障买单
 * - 余额不足：调用方将该文件标记「跳过（额度不足）」并停止后续文件
 *
 * 存储：
 * - quotas.json     余额表 { userId: remaining }，0600、去抖合并写（tmp+rename 原子）
 * - quota-ledger.jsonl 追加型流水（grant/reserve/release 各一行，含余量快照），
 *   用于对账与后续客服排查；写入失败不影响主流程
 * - 单进程内存为权威副本，磁盘仅恢复/审计用（与 sessions 同生命周期的取舍）
 */

const quotasFile = path.join(config.dataDir, 'quotas.json');
const ledgerFile = path.join(config.dataDir, 'quota-ledger.jsonl');

/** @type {Map<string, number>} userId -> remaining */
let quotas = new Map();
let loadPromise = null;
let persistTimer = null;

async function load() {
  try {
    const raw = await fs.readFile(quotasFile, 'utf8');
    const obj = JSON.parse(raw);
    quotas = new Map(Object.entries(obj).map(([k, v]) => [k, Number(v) || 0]));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('[quota] quotas.json 读取失败，按空表启动:', error.message);
    }
    quotas = new Map();
  }
}

function ensureLoaded() {
  if (!loadPromise) loadPromise = load();
  return loadPromise;
}

// 去抖合并写：500ms 内多次变更只落一次盘
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      const payload = JSON.stringify(Object.fromEntries(quotas), null, 2);
      const tmp = `${quotasFile}.${crypto.randomUUID()}.tmp`;
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.writeFile(tmp, payload, { mode: 0o600 });
      await fs.rename(tmp, quotasFile);
    } catch (error) {
      console.error('[quota] quotas.json 写入失败:', error.message);
    }
  }, 500);
  persistTimer.unref?.();
}

// 流水：追加一行 JSONL（尽力而为，绝不阻塞主流程）
async function appendLedger(userId, type, amount, remaining, note = '') {
  const line = JSON.stringify({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    userId,
    type, // grant | reserve | release
    amount, // 正数
    remaining,
    note
  });
  try {
    await fs.appendFile(ledgerFile, `${line}\n`, 'utf8');
  } catch {
    /* 审计文件失败不影响业务 */
  }
}

// ---------- 查询 ----------

async function getRemaining(userId) {
  await ensureLoaded();
  return quotas.get(userId) || 0;
}

// ---------- 变更 ----------

// 发放（注册赠送 / 后续充值），返回新余额
async function grant(userId, amount, note = '') {
  await ensureLoaded();
  const next = (quotas.get(userId) || 0) + amount;
  quotas.set(userId, next);
  schedulePersist();
  appendLedger(userId, 'grant', amount, next, note);
  return next;
}

// 批量补发：给没有配额记录的用户发放初始额度（老用户迁移用）
// 返回补发的 { userId, amount } 列表
async function grantMissing(userIds, amount, note = '初始化赠送') {
  await ensureLoaded();
  const granted = [];
  for (const userId of userIds) {
    if (!quotas.has(userId)) {
      quotas.set(userId, amount);
      granted.push({ userId, amount });
      appendLedger(userId, 'grant', amount, amount, note);
    }
  }
  if (granted.length) schedulePersist();
  return granted;
}

/**
 * 预扣 1 次。余额足够则扣减并返回 { ok: true, remaining }；
 * 不足返回 { ok: false, remaining }（调用方据此跳过该文件）。
 */
async function tryReserve(userId, note = '') {
  await ensureLoaded();
  const current = quotas.get(userId) || 0;
  if (current <= 0) {
    return { ok: false, remaining: 0 };
  }
  const next = current - 1;
  quotas.set(userId, next);
  schedulePersist();
  appendLedger(userId, 'reserve', 1, next, note);
  return { ok: true, remaining: next };
}

// 退回（渲染真实失败时调用），返回新余额
async function release(userId, note = '') {
  await ensureLoaded();
  const next = (quotas.get(userId) || 0) + 1;
  quotas.set(userId, next);
  schedulePersist();
  appendLedger(userId, 'release', 1, next, note);
  return next;
}

// ==================== 管理员操作 ====================

// 管理员调整余额：delta 为正数充值、负数扣减（不低于 0），返回新余额
async function adjust(userId, delta, note = '') {
  await ensureLoaded();
  const amount = Math.round(Number(delta) || 0);
  if (!amount) {
    const error = new Error('调整数额不能为 0');
    error.statusCode = 400;
    throw error;
  }
  const next = Math.max(0, (quotas.get(userId) || 0) + amount);
  quotas.set(userId, next);
  schedulePersist();
  appendLedger(userId, amount > 0 ? 'grant' : 'revoke', Math.abs(amount), next, note);
  return next;
}

// 批量查询余额（管理后台用户列表）
async function getRemainingMap(userIds) {
  await ensureLoaded();
  return Object.fromEntries(userIds.map((id) => [id, quotas.get(id) || 0]));
}

// 用户删除时清理余额记录
async function removeUser(userId) {
  await ensureLoaded();
  if (quotas.delete(userId)) schedulePersist();
}

module.exports = { adjust, getRemaining, getRemainingMap, grant, grantMissing, release, removeUser, tryReserve };
