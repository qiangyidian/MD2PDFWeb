const crypto = require('node:crypto');

const { query, withTx } = require('../db/pool');
const { generate, normalize } = require('./redeemCode');

/**
 * 兑换码存储（PostgreSQL）
 *
 * 兑换是本系统除「转换预扣」之外的第二条资金路径，纪律要求一致：
 * 单事务、行锁、幂等。核心不变量是「一个码最多只能产生一次额度增加」。
 *
 * 并发正确性从何而来：
 * 事务开始时对目标码行执行 SELECT ... FOR UPDATE。两个请求同时兑同一个码时，
 * 后者会阻塞在前者的行锁上，待前者提交后读到 status='used'，从而被拒绝。
 * 因此不存在「两边都读到 unused 然后各加一次额度」的窗口。
 *
 * 锁序：恒为 redeem_codes -> quota_accounts。tryReserve 只锁 quota_accounts，
 * 与之无环，不会死锁。
 */

const MAX_VALUE = 100_000;
const MAX_BATCH = 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 500;

function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  throw error;
}

// 追加额度流水。与余额变动处于同一事务，两者要么都成功要么都回滚。
async function appendLedger(client, { userId, entryType, amount, remaining, note, referenceType = '', referenceId = '' }) {
  await client.query(
    `INSERT INTO quota_ledger
       (id, user_id, entry_type, amount, remaining, note, reference_type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [crypto.randomUUID(), userId, entryType, amount, remaining, note, referenceType, referenceId]
  );
}

// ---------- 行映射 ----------

// 时间字段统一转成毫秒时间戳（null 保持 null），与 userStore.createdAt 的口径一致
function rowToCode(row) {
  return {
    id: row.id,
    code: row.code,
    value: row.value,
    batchId: row.batch_id,
    status: row.status,
    createdAt: row.created_at.getTime(),
    expiresAt: row.expires_at ? row.expires_at.getTime() : null,
    usedBy: row.used_by,
    usedAt: row.used_at ? row.used_at.getTime() : null,
    usedIp: row.used_ip,
    revokedAt: row.revoked_at ? row.revoked_at.getTime() : null,
    note: row.note
  };
}

// ---------- 兑换 ----------

/**
 * 兑换一个码。
 *
 * 成功返回 { value, remaining, alreadyRedeemed }。
 * 重复兑换（码已用且兑付人就是自己）不抛错，而是以 alreadyRedeemed=true 正常返回——
 * 网络重试或用户连点两次时，报「已被使用」会让用户误以为码被别人抢了。
 *
 * 格式非法与码不存在返回同一条文案，避免通过错误差异探测某个码是否存在。
 */
async function redeem({ code, userId, ip = null }) {
  const bare = normalize(code);
  if (!bare) fail('兑换码不存在，请核对后重试', 404);

  return withTx(async (client) => {
    const { rows } = await client.query('SELECT * FROM redeem_codes WHERE code = $1 FOR UPDATE', [bare]);
    const row = rows[0];
    if (!row) fail('兑换码不存在，请核对后重试', 404);

    // 重复兑换：本人已兑过，幂等返回。这一支必须在「已被使用」之前判断，
    // 否则用户重试时会收到误导性的「已被使用」。
    if (row.status === 'used' && row.used_by === userId) {
      const { rows: accountRows } = await client.query(
        'SELECT remaining FROM quota_accounts WHERE user_id = $1',
        [userId]
      );
      return {
        value: row.value,
        remaining: accountRows[0]?.remaining ?? 0,
        alreadyRedeemed: true
      };
    }

    if (row.status === 'revoked') fail('该兑换码已被作废', 400);
    if (row.status === 'used') fail('该兑换码已被使用', 400);
    if (row.expires_at && row.expires_at.getTime() <= Date.now()) fail('该兑换码已过期', 400);

    // 标记已用。带 status='unused' 条件是与行锁互为印证的第二道防线：
    // 即使将来有人误删 FOR UPDATE，这里也不会把已用的码再改一次。
    const { rowCount } = await client.query(
      `UPDATE redeem_codes
          SET status = 'used', used_by = $2, used_at = now(), used_ip = $3
        WHERE id = $1 AND status = 'unused'`,
      [row.id, userId, ip]
    );
    if (!rowCount) fail('该兑换码已被使用', 400);

    // 到账。ON CONFLICT 兜底从未建立过账户行的用户（正常路径下注册时已建行）
    const { rows: accountRows } = await client.query(
      `INSERT INTO quota_accounts (user_id, remaining, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET remaining = quota_accounts.remaining + EXCLUDED.remaining, updated_at = now()
       RETURNING remaining`,
      [userId, row.value]
    );
    const remaining = accountRows[0].remaining;

    await appendLedger(client, {
      userId,
      entryType: 'redeem',
      amount: row.value,
      remaining,
      note: `兑换码 ${row.code}`,
      referenceType: 'redeem_code',
      referenceId: row.id
    });

    return { value: row.value, remaining, alreadyRedeemed: false };
  });
}

// ---------- 管理端操作 ----------

function validateBatch({ value, count }) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_VALUE) {
    fail(`面额必须是 1 到 ${MAX_VALUE} 之间的整数`, 400);
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_BATCH) {
    fail(`单批数量必须是 1 到 ${MAX_BATCH} 之间的整数`, 400);
  }
}

/**
 * 批量生成兑换码。
 *
 * 唯一索引是碰撞的最终裁决者：INSERT 冲突时换一个新的随机码重试。
 * 75 bit 熵下碰撞概率可忽略，但这个重试让「理论上可能」变成「实际上不会失败」，
 * 也让将来若有人调低熵时不会静默丢码（生成 N 个却只入库 N-1 个）。
 */
async function createBatch({ value, count, expiresAt = null, note = '', createdBy = null }) {
  validateBatch({ value: Number(value), count: Number(count) });
  const amount = Number(value);
  const total = Number(count);
  const batchId = crypto.randomUUID();

  return withTx(async (client) => {
    const codes = [];
    for (let i = 0; i < total; i += 1) {
      let inserted = false;
      for (let attempt = 0; attempt < 5 && !inserted; attempt += 1) {
        const code = generate();
        const { rowCount } = await client.query(
          `INSERT INTO redeem_codes (id, code, value, batch_id, created_by, expires_at, note)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (code) DO NOTHING`,
          [crypto.randomUUID(), code, amount, batchId, createdBy, expiresAt, note]
        );
        if (rowCount) {
          codes.push(code);
          inserted = true;
        }
      }
      if (!inserted) fail('兑换码生成失败，请重试', 500);
    }
    return { batchId, codes };
  });
}

async function listCodes({ status = '', batchId = '', limit = DEFAULT_PAGE_SIZE, offset = 0 } = {}) {
  const conditions = [];
  const params = [];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (batchId) {
    params.push(batchId);
    conditions.push(`batch_id = $${params.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows: countRows } = await query(`SELECT count(*)::int AS n FROM redeem_codes ${where}`, params);

  const size = Math.min(Math.max(Number(limit) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const skip = Math.max(Number(offset) || 0, 0);
  params.push(size, skip);
  const { rows } = await query(
    `SELECT * FROM redeem_codes ${where}
      ORDER BY created_at DESC, id
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return { total: countRows[0].n, codes: rows.map(rowToCode) };
}

// 作废：只对 unused 生效。已使用/已过期的码保持原状，历史不可篡改
async function revoke({ ids = [], batchId = '', revokedBy = null }) {
  if (!ids.length && !batchId) {
    fail('请指定要作废的兑换码或批次', 400);
  }

  const conditions = [`status = 'unused'`];
  const params = [];
  if (ids.length) {
    params.push(ids);
    conditions.push(`id = ANY($${params.length})`);
  }
  if (batchId) {
    params.push(batchId);
    conditions.push(`batch_id = $${params.length}`);
  }
  params.push(revokedBy);

  const { rowCount } = await query(
    `UPDATE redeem_codes
        SET status = 'revoked', revoked_at = now(), revoked_by = $${params.length}
      WHERE ${conditions.join(' AND ')}`,
    params
  );
  return { revoked: rowCount };
}

async function stats() {
  const { rows } = await query(`
    SELECT
      count(*)::int                                                                                  AS total,
      count(*) FILTER (WHERE status = 'unused' AND (expires_at IS NULL OR expires_at > now()))::int  AS unused,
      count(*) FILTER (WHERE status = 'unused' AND expires_at <= now())::int                         AS expired,
      count(*) FILTER (WHERE status = 'used')::int                                                   AS used,
      count(*) FILTER (WHERE status = 'revoked')::int                                                AS revoked,
      COALESCE(sum(value) FILTER (WHERE status = 'used'), 0)::int                                    AS granted_total,
      count(DISTINCT batch_id)::int                                                                  AS batch_count
    FROM redeem_codes
  `);
  const r = rows[0];
  return {
    total: r.total,
    unused: r.unused,
    expired: r.expired,
    used: r.used,
    revoked: r.revoked,
    grantedTotal: r.granted_total,
    batchCount: r.batch_count
  };
}

// 导出用：按批次返回全部码。导出是明确的批量动作，不分页
async function listForExport(batchId) {
  const { rows } = await query(
    'SELECT * FROM redeem_codes WHERE batch_id = $1 ORDER BY created_at, code',
    [batchId]
  );
  return rows.map(rowToCode);
}

module.exports = { createBatch, listCodes, listForExport, redeem, revoke, stats };
