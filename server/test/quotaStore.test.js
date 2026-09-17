const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, setupSchema, truncateAll, closePool, insertUser } = require('./helpers/db');
const quotaStore = require('../src/services/quotaStore');

const UID = '55555555-5555-5555-5555-555555555555';
const UID2 = '66666666-6666-6666-6666-666666666666';

test.before(async () => {
  await setupSchema();
});
test.beforeEach(async () => {
  await truncateAll();
  await insertUser({ id: UID, email: 'q1@example.com' });
  await insertUser({ id: UID2, email: 'q2@example.com' });
});
test.after(async () => {
  await closePool();
});

test('grant 累加余额并写流水', async () => {
  assert.equal(await quotaStore.grant(UID, 50, '注册赠送'), 50);
  assert.equal(await quotaStore.grant(UID, 30, '再送'), 80);
  assert.equal(await quotaStore.getRemaining(UID), 80);

  const { rows } = await pool.query(
    `SELECT entry_type, amount, remaining FROM quota_ledger WHERE user_id = $1 ORDER BY created_at`,
    [UID]
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].entry_type, 'grant');
  assert.equal(rows[0].amount, 50);
  assert.equal(rows[1].remaining, 80);
});

test('无账户记录的用户余额为 0', async () => {
  assert.equal(await quotaStore.getRemaining('77777777-7777-7777-7777-777777777777'), 0);
});

test('tryReserve 余额足够时扣 1，余额为 0 时拒绝', async () => {
  await quotaStore.grant(UID, 2, '初始');
  assert.deepEqual(await quotaStore.tryReserve(UID, 'a'), { ok: true, remaining: 1 });
  assert.deepEqual(await quotaStore.tryReserve(UID, 'b'), { ok: true, remaining: 0 });
  assert.deepEqual(await quotaStore.tryReserve(UID, 'c'), { ok: false, remaining: 0 });
  assert.equal(await quotaStore.getRemaining(UID), 0);
});

test('tryReserve 对没有账户的用户直接拒绝，不建行', async () => {
  assert.deepEqual(await quotaStore.tryReserve(UID2, '无账户'), { ok: false, remaining: 0 });
  const { rowCount } = await pool.query('SELECT 1 FROM quota_accounts WHERE user_id = $1', [UID2]);
  assert.equal(rowCount, 0, 'tryReserve 不应为无账户用户建出余额为 0 的行');
});

test('release 退回 1 次', async () => {
  await quotaStore.grant(UID, 1, '初始');
  await quotaStore.tryReserve(UID, 'a');
  assert.equal(await quotaStore.release(UID, '渲染失败退回'), 1);
});

test('并发 tryReserve 绝不超扣（余额 5，20 并发恰好 5 成功）', async () => {
  await quotaStore.grant(UID, 5, '初始');
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => quotaStore.tryReserve(UID, `并发-${i}`))
  );
  const okCount = results.filter((r) => r.ok).length;
  assert.equal(okCount, 5, '恰好 5 次成功');
  assert.equal(await quotaStore.getRemaining(UID), 0);
  assert.ok(
    results.every((r) => r.remaining >= 0),
    '任何一次返回的余额都不得为负'
  );

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM quota_ledger WHERE user_id = $1 AND entry_type = 'reserve'`,
    [UID]
  );
  assert.equal(rows[0].n, 5, '流水条数必须等于成功次数');
});

test('并发 grant 不丢更新（20 次 +1 后余额为 20）', async () => {
  await Promise.all(Array.from({ length: 20 }, (_, i) => quotaStore.grant(UID, 1, `并发赠 ${i}`)));
  assert.equal(await quotaStore.getRemaining(UID), 20);

  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM quota_ledger WHERE user_id = $1`,
    [UID]
  );
  assert.equal(rows[0].n, 20, '20 次发放必须有 20 条流水');
});

test('adjust 正数充值、负数扣减，且不为负；delta 为 0 抛 400', async () => {
  await quotaStore.grant(UID, 10, '初始');
  assert.equal(await quotaStore.adjust(UID, 5, '管理员调整'), 15);
  assert.equal(await quotaStore.adjust(UID, -7, '管理员调整'), 8);
  assert.equal(await quotaStore.adjust(UID, -100, '扣到负数应被钳制'), 0);

  await assert.rejects(
    () => quotaStore.adjust(UID, 0, '零'),
    (error) => error.statusCode === 400
  );
});

test('adjust 对没有账户的用户也能创建并调整', async () => {
  assert.equal(await quotaStore.adjust(UID2, 12, '管理员调整'), 12);
  assert.equal(await quotaStore.getRemaining(UID2), 12);
});

test('adjust 对无账户用户的负数扣减钳制为 0，不触发 CHECK 报错', async () => {
  assert.equal(await quotaStore.adjust(UID2, -50, '扣一个不存在的账户'), 0);
});

test('getRemainingMap 批量返回，缺记录的用户为 0', async () => {
  await quotaStore.grant(UID, 3, '初始');
  const map = await quotaStore.getRemainingMap([UID, UID2, '88888888-8888-8888-8888-888888888888']);
  assert.equal(map[UID], 3);
  assert.equal(map[UID2], 0);
  assert.equal(map['88888888-8888-8888-8888-888888888888'], 0);
});

test('grantMissing 只给没有记录的用户补发，重复调用不重复发', async () => {
  await quotaStore.grant(UID, 7, '已有记录');

  const first = await quotaStore.grantMissing([UID, UID2], 50, '存量初始化');
  assert.deepEqual(first, [{ userId: UID2, amount: 50 }]);
  assert.equal(await quotaStore.getRemaining(UID), 7, '已有记录的用户不被覆盖');
  assert.equal(await quotaStore.getRemaining(UID2), 50);

  const second = await quotaStore.grantMissing([UID, UID2], 50, '存量初始化');
  assert.deepEqual(second, [], '第二次调用无补发');
});

test('grantMissing 的补发额固定为传入值，不受已有余额影响', async () => {
  await quotaStore.grant(UID, 7, '已有记录');
  await quotaStore.grantMissing([UID, UID2], 50, '存量初始化');
  assert.equal(await quotaStore.getRemaining(UID), 7, '已有记录者余额不变，而不是被改成 50');
});

test('removeUser 清掉账户记录', async () => {
  await quotaStore.grant(UID, 5, '初始');
  await quotaStore.removeUser(UID);
  assert.equal(await quotaStore.getRemaining(UID), 0);
});

test('余额与流水快照始终一致', async () => {
  await quotaStore.grant(UID, 10, '初始');
  await quotaStore.tryReserve(UID, 'a');
  await quotaStore.tryReserve(UID, 'b');
  await quotaStore.release(UID, '退回');
  await quotaStore.adjust(UID, -2, '管理员扣减');

  const balance = await quotaStore.getRemaining(UID);
  const { rows } = await pool.query(
    `SELECT remaining FROM quota_ledger WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [UID]
  );
  assert.equal(balance, rows[0].remaining, '账户余额必须等于最后一条流水的快照');
});

test('失败路径不留残留：tryReserve 被拒时不写流水', async () => {
  await quotaStore.grant(UID, 1, '初始');
  const before = (await pool.query('SELECT count(*)::int AS n FROM quota_ledger')).rows[0].n;

  await quotaStore.tryReserve(UID, 'a');
  await quotaStore.tryReserve(UID, 'b'); // 已被扣空，这次应失败
  await quotaStore.tryReserve(UID, 'c');

  const after = (await pool.query('SELECT count(*)::int AS n FROM quota_ledger')).rows[0].n;
  assert.equal(after - before, 1, '三次预扣只有一次成功，因此只应新增一条流水');
});
