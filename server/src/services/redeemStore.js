const crypto = require('node:crypto');

const { withTx } = require('../db/pool');
const { normalize } = require('./redeemCode');

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

module.exports = { redeem };
