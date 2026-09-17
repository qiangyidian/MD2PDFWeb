const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, setupSchema, truncateAll, closePool } = require('./helpers/db');
const { migrate } = require('../src/db/migrate');

test.before(async () => {
  await setupSchema();
});

test.after(async () => {
  await truncateAll();
  await closePool();
});

test('迁移是幂等的：重复执行不报错且返回空 applied', async () => {
  await truncateAll();
  const second = await migrate();
  assert.deepEqual(second.applied, [], '已应用过的迁移不应再次执行');
});

test('五张业务表全部存在', async () => {
  const { rows } = await pool.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [['users', 'sessions', 'quota_accounts', 'quota_ledger', 'redeem_codes']]
  );
  const names = rows.map((r) => r.table_name).sort();
  assert.deepEqual(names, ['quota_accounts', 'quota_ledger', 'redeem_codes', 'sessions', 'users']);
});

test('quota_accounts.remaining 的 CHECK 约束拒绝负数', async () => {
  await truncateAll();
  await pool.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)`, [
    '11111111-1111-1111-1111-111111111111',
    'check@example.com',
    'C',
    'scrypt$1$1$1$aa$bb'
  ]);
  await assert.rejects(
    () =>
      pool.query(`INSERT INTO quota_accounts (user_id, remaining) VALUES ($1, $2)`, [
        '11111111-1111-1111-1111-111111111111',
        -1
      ]),
    /check|约束|constraint/i
  );
});

test('uq_quota_ledger_reference 只对非空 reference_id 生效', async () => {
  await truncateAll();
  const uid = '22222222-2222-2222-2222-222222222222';
  await pool.query(`INSERT INTO users (id, email, name, password_hash) VALUES ($1,$2,$3,$4)`, [
    uid,
    'ledger@example.com',
    'L',
    'scrypt$1$1$1$aa$bb'
  ]);
  await pool.query(`INSERT INTO quota_accounts (user_id, remaining) VALUES ($1, 0)`, [uid]);

  const insert = (refType, refId) =>
    pool.query(
      `INSERT INTO quota_ledger (id, user_id, entry_type, amount, remaining, reference_type, reference_id)
       VALUES (gen_random_uuid(), $1, 'grant', 1, 1, $2, $3)`,
      [uid, refType, refId]
    );

  // 空 reference_id 可重复插入（系统发放等无业务引用的流水）
  await insert('', '');
  await insert('', '');

  // 相同业务引用第二次必须失败
  await insert('redeem_code', 'CODE-1');
  await assert.rejects(() => insert('redeem_code', 'CODE-1'), /duplicate|唯一|unique/i);
});

test('ck_redeem_used 拒绝「已使用但没有兑付人」的码', async () => {
  await truncateAll();
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO redeem_codes (id, code, value, batch_id, status)
         VALUES (gen_random_uuid(), 'MD2PDF-AAAAA-AAAAA-AAAAA', 10, gen_random_uuid(), 'used')`
      ),
    /check|约束|constraint/i
  );
});
