const crypto = require('node:crypto');

const { query, withTx } = require('../db/pool');

/**
 * 用户额度：剩余可处理文档数（PostgreSQL）
 *
 * 计费模型（按成功渲染的 PDF 个数）：
 * - reserve：文件开始渲染前预扣 1（并发下不漏扣的关键）
 * - release：渲染真实失败（超时/崩溃等）时退回，用户不为系统故障买单
 * - 余额不足：调用方将该文件标记「跳过（额度不足）」并停止后续文件
 *
 * 自 2026-09-17 起由 JSON 文件迁移到 PG。相比原实现的两点强化：
 * 1. tryReserve 用 `UPDATE ... WHERE remaining >= 1 RETURNING` 一条语句完成
 *    判定与扣减，不再依赖「进程内 Map 读改写之间没有 await 间隙」这个隐含前提
 * 2. 余额与流水写在同一事务里，两者要么都成功要么都回滚，
 *    不会出现「扣了额度但流水没记」的对账黑洞
 *
 * 流水（quota_ledger）为追加型，含变动后余额快照，用于对账与客服排查。
 */

// 追加一条流水。必须在调用方的事务里执行，余额与流水才具备原子性。
async function appendLedger(client, { userId, entryType, amount, remaining, note = '', referenceType = '', referenceId = '' }) {
  await client.query(
    `INSERT INTO quota_ledger
       (id, user_id, entry_type, amount, remaining, note, reference_type, reference_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [crypto.randomUUID(), userId, entryType, amount, remaining, note, referenceType, referenceId]
  );
}

// ---------- 查询 ----------

async function getRemaining(userId) {
  const { rows } = await query('SELECT remaining FROM quota_accounts WHERE user_id = $1', [userId]);
  return rows[0]?.remaining ?? 0;
}

async function getRemainingMap(userIds) {
  if (!userIds.length) return {};
  const { rows } = await query('SELECT user_id, remaining FROM quota_accounts WHERE user_id = ANY($1)', [
    userIds
  ]);
  const found = new Map(rows.map((r) => [r.user_id, r.remaining]));
  return Object.fromEntries(userIds.map((id) => [id, found.get(id) ?? 0]));
}

// ---------- 变更 ----------

/**
 * 加额度。
 *
 * 用 INSERT ... ON CONFLICT DO UPDATE 一条语句完成「无行则建、有行则累加」，
 * 不需要先 SELECT 再 UPDATE：少一次往返，也少一个「查完到写之间被别人插队」的窗口。
 */
async function grant(userId, amount, note = '') {
  const value = Math.round(Number(amount) || 0);

  return withTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO quota_accounts (user_id, remaining, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (user_id)
       DO UPDATE SET remaining = quota_accounts.remaining + EXCLUDED.remaining, updated_at = now()
       RETURNING remaining`,
      [userId, value]
    );
    const remaining = rows[0].remaining;
    await appendLedger(client, { userId, entryType: 'grant', amount: value, remaining, note });
    return remaining;
  });
}

/**
 * 预扣 1 次。余额足够则扣减并返回 { ok: true, remaining }；
 * 不足或账户不存在返回 { ok: false, remaining: 0 }（调用方据此跳过该文件）。
 *
 * 判定与扣减合并为一条带条件的 UPDATE：这是并发正确性的关键，
 * 拆成「先 SELECT 再 UPDATE」就会在两次查询之间留下超扣窗口。
 * 与 grant 不同，这里刻意不建行——账户不存在等价于余额为 0，应当被拒绝。
 */
async function tryReserve(userId, note = '') {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `UPDATE quota_accounts
          SET remaining = remaining - 1, updated_at = now()
        WHERE user_id = $1 AND remaining >= 1
        RETURNING remaining`,
      [userId]
    );
    if (!rows.length) return { ok: false, remaining: 0 };

    const remaining = rows[0].remaining;
    await appendLedger(client, { userId, entryType: 'reserve', amount: 1, remaining, note });
    return { ok: true, remaining };
  });
}

async function release(userId, note = '') {
  return withTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO quota_accounts (user_id, remaining, updated_at)
       VALUES ($1, 1, now())
       ON CONFLICT (user_id)
       DO UPDATE SET remaining = quota_accounts.remaining + 1, updated_at = now()
       RETURNING remaining`,
      [userId]
    );
    const remaining = rows[0].remaining;
    await appendLedger(client, { userId, entryType: 'release', amount: 1, remaining, note });
    return remaining;
  });
}

// ---------- 管理员操作 ----------

// 管理员调整余额：delta 为正数充值、负数扣减（不低于 0），返回新余额
async function adjust(userId, delta, note = '') {
  const amount = Math.round(Number(delta) || 0);
  if (!amount) {
    const error = new Error('调整数额不能为 0');
    error.statusCode = 400;
    throw error;
  }

  return withTx(async (client) => {
    // GREATEST(0, ...) 保证不为负；数据库层的 CHECK 是第二道防线。
    // 插入分支也要钳制：否则账户不存在时，一次负数调整会以负值建行并触发 CHECK 报错，
    // 而调用方期望的是「扣到 0 为止」。
    const { rows } = await client.query(
      `INSERT INTO quota_accounts (user_id, remaining, updated_at)
       VALUES ($1, GREATEST(0, $2), now())
       ON CONFLICT (user_id)
       DO UPDATE SET remaining = GREATEST(0, quota_accounts.remaining + $2), updated_at = now()
       RETURNING remaining`,
      [userId, amount]
    );
    const remaining = rows[0].remaining;
    await appendLedger(client, {
      userId,
      entryType: amount > 0 ? 'grant' : 'revoke',
      amount: Math.abs(amount),
      remaining,
      note
    });
    return remaining;
  });
}

/**
 * 批量补发：给没有额度记录的用户发放初始额度（老用户迁移用）。
 * 返回补发的 { userId, amount } 列表；已有记录的用户原样保留。
 *
 * ON CONFLICT DO NOTHING + RETURNING 是这里的要点：只把真正新建的行返回回来，
 * 因此重复调用天然幂等，不会给已有账户二次发放。
 */
async function grantMissing(userIds, amount, note = '初始化赠送') {
  if (!userIds.length) return [];
  const value = Math.round(Number(amount) || 0);

  return withTx(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO quota_accounts (user_id, remaining)
       SELECT u.id, $2 FROM unnest($1::uuid[]) AS u(id)
       ON CONFLICT (user_id) DO NOTHING
       RETURNING user_id, remaining`,
      [userIds, value]
    );

    for (const row of rows) {
      await appendLedger(client, {
        userId: row.user_id,
        entryType: 'grant',
        amount: value,
        remaining: row.remaining,
        note
      });
    }
    return rows.map((row) => ({ userId: row.user_id, amount: value }));
  });
}

// 用户删除时清理余额记录（流水由外键级联删除）
async function removeUser(userId) {
  await query('DELETE FROM quota_accounts WHERE user_id = $1', [userId]);
}

module.exports = { adjust, getRemaining, getRemainingMap, grant, grantMissing, release, removeUser, tryReserve };
