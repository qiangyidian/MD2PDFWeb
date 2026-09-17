const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, setupSchema, truncateAll, closePool, insertUser } = require('./helpers/db');
const redeemStore = require('../src/services/redeemStore');
const { normalize } = require('../src/services/redeemCode');

const ADMIN = 'b1111111-1111-1111-1111-111111111111';
const USER = 'b2222222-2222-2222-2222-222222222222';

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

test('createBatch 按数量生成，码全部规范且互不重复', async () => {
  const { batchId, codes } = await redeemStore.createBatch({
    value: 100,
    count: 50,
    note: '测试批次',
    createdBy: ADMIN
  });

  assert.ok(batchId);
  assert.equal(codes.length, 50);
  assert.equal(new Set(codes).size, 50, '批次内不得重复');

  const { rows } = await pool.query('SELECT code, value, batch_id, note FROM redeem_codes');
  assert.equal(rows.length, 50);
  assert.ok(rows.every((r) => r.value === 100));
  assert.ok(rows.every((r) => r.batch_id === batchId));
  assert.ok(rows.every((r) => r.note === '测试批次'));
});

test('createBatch 的码全部满足规范形态（可直接被用户兑换）', async () => {
  const { codes } = await redeemStore.createBatch({ value: 5, count: 100 });
  for (const code of codes) {
    assert.equal(normalize(code), code, '生成即规范，无需用户做任何转换');
  }
});

test('createBatch 带截止时间时写入 expires_at，不带时为 NULL', async () => {
  const when = new Date(Date.now() + 86_400_000);
  const { batchId } = await redeemStore.createBatch({ value: 5, count: 2, expiresAt: when });
  const { rows } = await pool.query('SELECT expires_at FROM redeem_codes WHERE batch_id = $1', [batchId]);
  assert.ok(rows.every((r) => Math.abs(r.expires_at.getTime() - when.getTime()) < 2000));

  const plain = await redeemStore.createBatch({ value: 5, count: 1 });
  const { rows: plainRows } = await pool.query('SELECT expires_at FROM redeem_codes WHERE batch_id = $1', [
    plain.batchId
  ]);
  assert.equal(plainRows[0].expires_at, null);
});

test('createBatch 参数越界抛 400', async () => {
  await assert.rejects(
    () => redeemStore.createBatch({ value: 0, count: 1 }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    () => redeemStore.createBatch({ value: 100001, count: 1 }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    () => redeemStore.createBatch({ value: 10, count: 0 }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    () => redeemStore.createBatch({ value: 10, count: 1001 }),
    (error) => error.statusCode === 400
  );
  await assert.rejects(
    () => redeemStore.createBatch({ value: 1.5, count: 1 }),
    (error) => error.statusCode === 400,
    '小数面额应被拒绝'
  );
});

test('createBatch 生成的码可被用户正常兑换（端到端）', async () => {
  const { codes } = await redeemStore.createBatch({ value: 25, count: 1, createdBy: ADMIN });
  const result = await redeemStore.redeem({ code: codes[0], userId: USER });
  assert.equal(result.value, 25);
  assert.equal(result.remaining, 25);
});

test('createBatch 分批生成互不干扰，各自有独立 batchId', async () => {
  const a = await redeemStore.createBatch({ value: 10, count: 3 });
  const b = await redeemStore.createBatch({ value: 20, count: 2 });
  assert.notEqual(a.batchId, b.batchId);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM redeem_codes')).rows[0].n, 5);
});

test('listCodes 支持按状态与批次筛选并分页', async () => {
  const a = await redeemStore.createBatch({ value: 10, count: 3, note: 'A 批' });
  const b = await redeemStore.createBatch({ value: 20, count: 2, note: 'B 批' });

  const all = await redeemStore.listCodes({});
  assert.equal(all.total, 5);
  assert.equal(all.codes.length, 5);

  const onlyA = await redeemStore.listCodes({ batchId: a.batchId });
  assert.equal(onlyA.total, 3);
  assert.ok(onlyA.codes.every((c) => c.note === 'A 批'));

  await redeemStore.redeem({ code: b.codes[0], userId: USER });
  const used = await redeemStore.listCodes({ status: 'used' });
  assert.equal(used.total, 1);
  assert.equal(used.codes[0].value, 20);

  const page = await redeemStore.listCodes({ limit: 2, offset: 0 });
  assert.equal(page.codes.length, 2);
  assert.equal(page.total, 5);
});

test('listCodes 返回的码为裸码且时间字段为毫秒时间戳', async () => {
  const { codes } = await redeemStore.createBatch({ value: 10, count: 1 });
  const { codes: listed } = await redeemStore.listCodes({});
  assert.equal(listed[0].code, codes[0]);
  assert.equal(typeof listed[0].createdAt, 'number');
  assert.equal(listed[0].expiresAt, null);
  assert.equal(listed[0].usedAt, null);
  assert.equal(listed[0].revokedAt, null);
  assert.equal(typeof listed[0].id, 'string');
  assert.equal(typeof listed[0].batchId, 'string');
});

test('revoke 按 id 作废，只对未使用的生效', async () => {
  const { codes } = await redeemStore.createBatch({ value: 10, count: 3 });
  const { codes: listed } = await redeemStore.listCodes({});
  const target = listed.find((c) => c.code === codes[0]);

  const result = await redeemStore.revoke({ ids: [target.id], revokedBy: ADMIN });
  assert.equal(result.revoked, 1);

  const after = await redeemStore.listCodes({ status: 'revoked' });
  assert.equal(after.total, 1);
  assert.ok(after.codes[0].revokedAt > 0);
});

test('revoke 按批次整批作废；已使用的码不被改动', async () => {
  const { batchId, codes } = await redeemStore.createBatch({ value: 10, count: 4 });
  await redeemStore.redeem({ code: codes[0], userId: USER });

  const result = await redeemStore.revoke({ batchId, revokedBy: ADMIN });
  assert.equal(result.revoked, 3, '已使用的那个码不应被作废');

  const used = await redeemStore.listCodes({ status: 'used' });
  assert.equal(used.total, 1, '已使用的码保持 used 状态');
});

test('revoke 幂等：重复作废同一批返回 0', async () => {
  const { batchId } = await redeemStore.createBatch({ value: 10, count: 2 });
  assert.equal((await redeemStore.revoke({ batchId, revokedBy: ADMIN })).revoked, 2);
  assert.equal((await redeemStore.revoke({ batchId, revokedBy: ADMIN })).revoked, 0);
});

test('revoke 不带任何参数抛 400', async () => {
  await assert.rejects(
    () => redeemStore.revoke({}),
    (error) => error.statusCode === 400
  );
});

test('作废后的码无法兑换', async () => {
  const { batchId, codes } = await redeemStore.createBatch({ value: 10, count: 1 });
  await redeemStore.revoke({ batchId, revokedBy: ADMIN });
  await assert.rejects(
    () => redeemStore.redeem({ code: codes[0], userId: USER }),
    (error) => error.statusCode === 400 && /作废/.test(error.message)
  );
});

test('stats 汇总各状态数量与已发放额度', async () => {
  const { codes } = await redeemStore.createBatch({ value: 100, count: 5 });
  await redeemStore.redeem({ code: codes[0], userId: USER });
  await redeemStore.redeem({ code: codes[1], userId: USER });

  const one = await redeemStore.createBatch({ value: 50, count: 2 });
  await redeemStore.revoke({ batchId: one.batchId, revokedBy: ADMIN });

  await redeemStore.createBatch({ value: 7, count: 1, expiresAt: new Date(Date.now() - 60_000) });

  const s = await redeemStore.stats();
  assert.equal(s.total, 8);
  assert.equal(s.used, 2);
  assert.equal(s.revoked, 2);
  assert.equal(s.unused, 3, '未使用的码里不含已过期那个');
  assert.equal(s.expired, 1);
  assert.equal(s.grantedTotal, 200, '已发放额度只统计已兑换的：2 × 100');
  assert.equal(s.batchCount, 3);
});

test('stats 在空库上返回全 0 而不是 undefined', async () => {
  const s = await redeemStore.stats();
  assert.deepEqual(s, {
    total: 0,
    unused: 0,
    expired: 0,
    used: 0,
    revoked: 0,
    grantedTotal: 0,
    batchCount: 0
  });
});

test('listForExport 按批次返回全部码，且为规范裸码', async () => {
  const { batchId } = await redeemStore.createBatch({ value: 10, count: 3 });
  const rows = await redeemStore.listForExport(batchId);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => normalize(r.code) === r.code));
});

test('listForExport 只返回指定批次', async () => {
  const a = await redeemStore.createBatch({ value: 10, count: 3 });
  await redeemStore.createBatch({ value: 10, count: 2 });
  const rows = await redeemStore.listForExport(a.batchId);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.batchId === a.batchId));
});

test('作废人不存在时（创建者被删）不阻塞作废', async () => {
  const { batchId } = await redeemStore.createBatch({ value: 10, count: 2, createdBy: ADMIN });
  const result = await redeemStore.revoke({ batchId, revokedBy: null });
  assert.equal(result.revoked, 2, 'revokedBy 为 null 应可正常作废（外键为 SET NULL）');
});
