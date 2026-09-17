const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, setupSchema, truncateAll, closePool, insertUser } = require('./helpers/db');
const redeemStore = require('../src/services/redeemStore');
const userStore = require('../src/services/userStore');

const ADMIN = 'd1111111-1111-1111-1111-111111111111';
const USER = 'd2222222-2222-2222-2222-222222222222';

/**
 * 「删除用户」与「已兑换的码」的交集。
 *
 * 这个组合在生产冒烟时才暴露：redeem_codes.used_by 是 ON DELETE SET NULL，
 * 而 0001 的 ck_redeem_used 要求 used 状态必须有兑付人——删用户时外键置空
 * 立刻撞上约束，导致管理员永远删不掉兑换过码的用户（接口 500）。
 * 迁移 0002 把约束放宽为「已使用必须有兑付时间」。
 */

test.before(async () => {
  await setupSchema();
});
test.beforeEach(async () => {
  await truncateAll();
  await insertUser({ id: ADMIN, email: 'admin@example.com', role: 'admin' });
  await insertUser({ id: USER, email: 'user@example.com' });
});
test.after(async () => {
  await closePool();
});

test('删除已兑换过码的用户可以成功（不撞 ck_redeem_used）', async () => {
  const { codes } = await redeemStore.createBatch({ value: 50, count: 1 });
  await redeemStore.redeem({ code: codes[0], userId: USER });

  // 这里就是生产上 500 的那一步
  const removed = await userStore.deleteUser(USER, ADMIN);
  assert.equal(removed.id, USER);

  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
});

test('用户被删后兑换码仍为已使用，兑付人置空、兑付时间保留', async () => {
  const { codes } = await redeemStore.createBatch({ value: 50, count: 1 });
  await redeemStore.redeem({ code: codes[0], userId: USER, ip: '1.2.3.4' });
  await userStore.deleteUser(USER, ADMIN);

  const { rows } = await pool.query('SELECT * FROM redeem_codes WHERE code = $1', [codes[0]]);
  assert.equal(rows[0].status, 'used', '码不能被「退回未使用」——那样会被二次兑换');
  assert.equal(rows[0].used_by, null, '兑付人随用户删除置空');
  assert.ok(rows[0].used_at instanceof Date, '兑付时间必须保留，审计依赖它');
  assert.equal(rows[0].used_ip, '1.2.3.4', '兑付 IP 是独立字段，不随用户删除丢失');
});

test('用户被删后该码不可被再次兑换（防二次兑换）', async () => {
  const { codes } = await redeemStore.createBatch({ value: 50, count: 1 });
  await redeemStore.redeem({ code: codes[0], userId: USER });
  await userStore.deleteUser(USER, ADMIN);

  await insertUser({ id: 'd3333333-3333-3333-3333-333333333333', email: 'other@example.com' });
  await assert.rejects(
    () => redeemStore.redeem({ code: codes[0], userId: 'd3333333-3333-3333-3333-333333333333' }),
    (error) => error.statusCode === 400 && /已被使用/.test(error.message)
  );
});

test('统计仍把该码算作已使用与已发放', async () => {
  const { codes } = await redeemStore.createBatch({ value: 70, count: 1 });
  await redeemStore.redeem({ code: codes[0], userId: USER });
  await userStore.deleteUser(USER, ADMIN);

  const s = await redeemStore.stats();
  assert.equal(s.used, 1, '兑付人没了，但码确实被用掉了，统计必须如实反映');
  assert.equal(s.grantedTotal, 70);
});

test('约束仍拒绝「已使用但没有兑付时间」的码（放宽后仍守住真正的不变量）', async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO redeem_codes (id, code, value, batch_id, status)
         VALUES (gen_random_uuid(), 'MD2PDF-AAAAA-AAAAA-AAAAA', 10, gen_random_uuid(), 'used')`
      ),
    /check|约束|constraint/i
  );
});

test('约束允许「已使用、有兑付时间、兑付人为空」（即用户已注销）', async () => {
  await pool.query(
    `INSERT INTO redeem_codes (id, code, value, batch_id, status, used_at)
     VALUES (gen_random_uuid(), 'MD2PDF-BBBBB-BBBBB-BBBBB', 10, gen_random_uuid(), 'used', now())`
  );
  const { rows } = await pool.query(`SELECT status FROM redeem_codes WHERE code = 'MD2PDF-BBBBB-BBBBB-BBBBB'`);
  assert.equal(rows[0].status, 'used');
});

test('删除未兑换过码的用户不受影响', async () => {
  await redeemStore.createBatch({ value: 50, count: 2 });
  const removed = await userStore.deleteUser(USER, ADMIN);
  assert.equal(removed.id, USER);
});

test('批量删除多个兑换过码的用户', async () => {
  const users = ['d4444444-4444-4444-4444-444444444444', 'd5555555-5555-5555-5555-555555555555'];
  for (const id of users) await insertUser({ id, email: `${id.slice(0, 8)}@example.com` });

  const { codes } = await redeemStore.createBatch({ value: 10, count: 2 });
  await redeemStore.redeem({ code: codes[0], userId: users[0] });
  await redeemStore.redeem({ code: codes[1], userId: users[1] });

  for (const id of users) await userStore.deleteUser(id, ADMIN);

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM redeem_codes WHERE status = 'used'`);
  assert.equal(rows[0].n, 2);
  const { rows: nulls } = await pool.query(
    `SELECT count(*)::int AS n FROM redeem_codes WHERE used_by IS NULL`
  );
  assert.equal(nulls[0].n, 2);
});