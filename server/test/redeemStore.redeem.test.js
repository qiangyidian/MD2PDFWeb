const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, setupSchema, truncateAll, closePool, insertUser } = require('./helpers/db');
const redeemStore = require('../src/services/redeemStore');
const quotaStore = require('../src/services/quotaStore');
const { generate } = require('../src/services/redeemCode');

const UID = 'a1111111-1111-1111-1111-111111111111';
const UID2 = 'a2222222-2222-2222-2222-222222222222';

// 直接插码，绕开管理端生成逻辑，让本文件聚焦兑换事务本身
async function insertCode({ code, value = 10, status = 'unused', expiresAt = null, usedBy = null }) {
  const { rows } = await pool.query(
    `INSERT INTO redeem_codes (id, code, value, batch_id, status, expires_at, used_by, used_at)
     VALUES (gen_random_uuid(), $1, $2, gen_random_uuid(), $3, $4, $5,
             CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [code, value, status, expiresAt, usedBy]
  );
  return rows[0].id;
}

test.before(async () => {
  await setupSchema();
});
test.beforeEach(async () => {
  await truncateAll();
  await insertUser({ id: UID, email: 'r1@example.com' });
  await insertUser({ id: UID2, email: 'r2@example.com' });
});
test.after(async () => {
  await closePool();
});

test('兑换成功后额度到账，返回面额与新余额', async () => {
  const code = generate();
  await insertCode({ code, value: 100 });

  const result = await redeemStore.redeem({ code, userId: UID, ip: '1.2.3.4' });
  assert.equal(result.value, 100);
  assert.equal(result.remaining, 100);
  assert.equal(result.alreadyRedeemed, false);
  assert.equal(await quotaStore.getRemaining(UID), 100);
});

test('兑换码被标记为已用，记录兑付人/时间/IP', async () => {
  const code = generate();
  const id = await insertCode({ code, value: 30 });
  await redeemStore.redeem({ code, userId: UID, ip: '9.9.9.9' });

  const { rows } = await pool.query('SELECT * FROM redeem_codes WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'used');
  assert.equal(rows[0].used_by, UID);
  assert.equal(rows[0].used_ip, '9.9.9.9');
  assert.ok(rows[0].used_at instanceof Date);
});

test('兑换写入 redeem_code 引用类型的流水', async () => {
  const code = generate();
  const id = await insertCode({ code, value: 42 });
  await redeemStore.redeem({ code, userId: UID });

  const { rows } = await pool.query(
    `SELECT entry_type, amount, remaining, reference_type, reference_id
       FROM quota_ledger WHERE user_id = $1`,
    [UID]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entry_type, 'redeem');
  assert.equal(rows[0].amount, 42);
  assert.equal(rows[0].remaining, 42);
  assert.equal(rows[0].reference_type, 'redeem_code');
  assert.equal(rows[0].reference_id, id);
});

test('用户输入的码可带前缀/连字符/小写，兑换照常成功', async () => {
  const code = generate();
  await insertCode({ code, value: 5 });
  const messy = `md2pdf-${code.slice(0, 5)}-${code.slice(5, 10)}-${code.slice(10)}`.toLowerCase();
  const result = await redeemStore.redeem({ code: messy, userId: UID });
  assert.equal(result.value, 5);
});

test('兑换叠加在已有余额之上，而不是覆盖', async () => {
  await quotaStore.grant(UID, 20, '初始');
  const code = generate();
  await insertCode({ code, value: 30 });

  const result = await redeemStore.redeem({ code, userId: UID });
  assert.equal(result.remaining, 50);
  assert.equal(await quotaStore.getRemaining(UID), 50);
});

test('并发兑换同一个码：额度只增加一次，绝不双花', async () => {
  const code = generate();
  await insertCode({ code, value: 500 });

  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, () => redeemStore.redeem({ code, userId: UID }))
  );
  const fulfilled = attempts.filter((a) => a.status === 'fulfilled').map((a) => a.value);

  // 关键不变量：真正加额度的只有一次。其余 9 次因为持有同一个 userId，
  // 在行锁释放后重新读到 status='used' 且 used_by 就是自己，命中幂等分支，
  // 以 alreadyRedeemed=true 成功返回（这正是防「用户以为码被别人抢了」的设计）。
  const real = fulfilled.filter((r) => !r.alreadyRedeemed);
  assert.equal(real.length, 1, '真正完成兑换的恰好 1 次');
  assert.equal(fulfilled.length, 10, '10 次并发都拿到响应，没有连接池耗尽或超时');

  assert.equal(await quotaStore.getRemaining(UID), 500, '额度只增加一次，绝不双花');

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM quota_ledger WHERE user_id = $1`, [UID]);
  assert.equal(rows[0].n, 1, '流水只有一条');

  const { rows: codeRows } = await pool.query('SELECT status, used_by FROM redeem_codes WHERE code = $1', [
    code
  ]);
  assert.equal(codeRows[0].status, 'used');
  assert.equal(codeRows[0].used_by, UID);
});

test('并发兑换同一个码：所有成功返回者回报的余额一致，不存在中间态', async () => {
  const code = generate();
  await insertCode({ code, value: 500 });

  const results = (
    await Promise.allSettled(Array.from({ length: 10 }, () => redeemStore.redeem({ code, userId: UID })))
  )
    .filter((a) => a.status === 'fulfilled')
    .map((a) => a.value);

  assert.ok(results.every((r) => r.remaining === 500), '每个成功响应回报的都必须是最终余额 500');
  assert.ok(results.every((r) => r.value === 500), '每个成功响应回报的面额都必须是 500');
});

test('并发兑换同一个码（不同用户）：只有 1 个成功，其余收到「已被使用」', async () => {
  const code = generate();
  await insertCode({ code, value: 90 });

  const attempts = await Promise.allSettled([
    redeemStore.redeem({ code, userId: UID }),
    redeemStore.redeem({ code, userId: UID2 })
  ]);

  const ok = attempts.filter((a) => a.status === 'fulfilled');
  const failed = attempts.filter((a) => a.status === 'rejected');

  assert.equal(ok.length, 1, '跨用户时只有 1 个成功（没有幂等分支可走）');
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason.message, /已被使用/);
  assert.equal(ok[0].value.alreadyRedeemed, false);

  const total = (await quotaStore.getRemaining(UID)) + (await quotaStore.getRemaining(UID2));
  assert.equal(total, 90, '两个账户的到账总和只能等于面额');
});

test('并发兑换 10 个不同的码：全部成功且互不干扰', async () => {
  const codes = [];
  for (let i = 0; i < 10; i += 1) {
    const code = generate();
    await insertCode({ code, value: 3 });
    codes.push(code);
  }

  const results = await Promise.all(codes.map((code) => redeemStore.redeem({ code, userId: UID })));
  assert.equal(results.length, 10);
  assert.equal(await quotaStore.getRemaining(UID), 30, '10 × 3 = 30');
});

test('同一用户重复兑同一个码：幂等友好返回，额度不再增加', async () => {
  const code = generate();
  await insertCode({ code, value: 60 });

  const first = await redeemStore.redeem({ code, userId: UID });
  assert.equal(first.value, 60);
  assert.equal(first.alreadyRedeemed, false);

  const second = await redeemStore.redeem({ code, userId: UID });
  assert.equal(second.alreadyRedeemed, true, '应标记为重复兑换');
  assert.equal(second.value, 60, '回报当初到账的面额');
  assert.equal(second.remaining, 60, '回报当前余额');
  assert.equal(await quotaStore.getRemaining(UID), 60, '额度不得再增加');
});

test('重复兑换的幂等返回也反映期间的其他余额变动', async () => {
  const code = generate();
  await insertCode({ code, value: 60 });
  await redeemStore.redeem({ code, userId: UID });
  await quotaStore.grant(UID, 15, '管理员补发');

  const again = await redeemStore.redeem({ code, userId: UID });
  assert.equal(again.alreadyRedeemed, true);
  assert.equal(again.remaining, 75, '回报的是当前余额 60+15，而不是当初的 60');
});

test('拒绝：不存在的码', async () => {
  await assert.rejects(
    () => redeemStore.redeem({ code: generate(), userId: UID }),
    (error) => error.statusCode === 404 && /不存在/.test(error.message)
  );
});

test('拒绝：格式非法的输入与「不存在」文案一致（不泄露码是否存在）', async () => {
  await assert.rejects(
    () => redeemStore.redeem({ code: '!!!垃圾输入!!!', userId: UID }),
    (error) => error.statusCode === 404 && /不存在/.test(error.message)
  );
  await assert.rejects(
    () => redeemStore.redeem({ code: '', userId: UID }),
    (error) => error.statusCode === 404
  );
  await assert.rejects(
    () => redeemStore.redeem({ code: null, userId: UID }),
    (error) => error.statusCode === 404
  );
});

test('拒绝：已被他人使用的码', async () => {
  const code = generate();
  await insertCode({ code, value: 10, status: 'used', usedBy: UID2 });

  await assert.rejects(
    () => redeemStore.redeem({ code, userId: UID }),
    (error) => error.statusCode === 400 && /已被使用/.test(error.message)
  );
  assert.equal(await quotaStore.getRemaining(UID), 0);
});

test('拒绝：已作废的码', async () => {
  const code = generate();
  await insertCode({ code, value: 10, status: 'revoked' });

  await assert.rejects(
    () => redeemStore.redeem({ code, userId: UID }),
    (error) => error.statusCode === 400 && /作废/.test(error.message)
  );
  assert.equal(await quotaStore.getRemaining(UID), 0);
});

test('拒绝：已过期的码', async () => {
  const code = generate();
  await insertCode({ code, value: 10, expiresAt: new Date(Date.now() - 60_000) });

  await assert.rejects(
    () => redeemStore.redeem({ code, userId: UID }),
    (error) => error.statusCode === 400 && /过期/.test(error.message)
  );
});

test('未过期的码（截止时间在未来）可正常兑换', async () => {
  const code = generate();
  await insertCode({ code, value: 10, expiresAt: new Date(Date.now() + 60_000) });
  const result = await redeemStore.redeem({ code, userId: UID });
  assert.equal(result.value, 10);
});

test('过期码不会被标记为已用（拒绝路径不动数据）', async () => {
  const code = generate();
  const id = await insertCode({ code, value: 10, expiresAt: new Date(Date.now() - 60_000) });
  await redeemStore.redeem({ code, userId: UID }).catch(() => {});

  const { rows } = await pool.query('SELECT status, used_by FROM redeem_codes WHERE id = $1', [id]);
  assert.equal(rows[0].status, 'unused', '被拒绝的兑换不得把码标成已用');
  assert.equal(rows[0].used_by, null);
});

test('兑换失败时不产生任何流水', async () => {
  const code = generate();
  await insertCode({ code, value: 10, status: 'revoked' });
  await redeemStore.redeem({ code, userId: UID }).catch(() => {});

  const { rows } = await pool.query('SELECT count(*)::int AS n FROM quota_ledger');
  assert.equal(rows[0].n, 0, '拒绝路径不得留下流水');
});

test('兑换后账户余额等于最后一条流水的快照', async () => {
  const code = generate();
  await insertCode({ code, value: 37 });
  await redeemStore.redeem({ code, userId: UID });

  const balance = await quotaStore.getRemaining(UID);
  const { rows } = await pool.query(
    `SELECT remaining FROM quota_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [UID]
  );
  assert.equal(balance, rows[0].remaining);
});

test('兑换后的额度可被 tryReserve 正常消费（与转换流程打通）', async () => {
  const code = generate();
  await insertCode({ code, value: 3 });
  await redeemStore.redeem({ code, userId: UID });

  assert.deepEqual(await quotaStore.tryReserve(UID, 'job:1:a.md'), { ok: true, remaining: 2 });
  assert.deepEqual(await quotaStore.tryReserve(UID, 'job:1:b.md'), { ok: true, remaining: 1 });
  assert.deepEqual(await quotaStore.tryReserve(UID, 'job:1:c.md'), { ok: true, remaining: 0 });
  assert.deepEqual(await quotaStore.tryReserve(UID, 'job:1:d.md'), { ok: false, remaining: 0 });
});
