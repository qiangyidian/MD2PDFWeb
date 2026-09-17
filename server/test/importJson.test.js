const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { pool, setupSchema, truncateAll, closePool } = require('./helpers/db');
const { importFrom, verifyConsistency } = require('../scripts/import-json');

let dataDir;

// 与线上 server/data/ 结构一致的样本
const USERS = [
  {
    id: 'e1111111-1111-1111-1111-111111111111',
    email: 'one@example.com',
    name: '甲',
    passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    role: 'admin',
    createdAt: 1756700000000
  },
  {
    id: 'e2222222-2222-2222-2222-222222222222',
    email: 'two@example.com',
    name: '乙',
    passwordHash: 'scrypt$16384$8$1$c2FsdA==$aGFzaA==',
    role: 'user',
    createdAt: 1756700001000
  }
];

const QUOTAS = {
  'e1111111-1111-1111-1111-111111111111': 42,
  'e2222222-2222-2222-2222-222222222222': 7
};

// 流水 id 必须是 UUID：线上由 crypto.randomUUID() 生成，quota_ledger.id 是 uuid 列
const LEDGER = [
  { id: 'f0000000-0000-4000-8000-000000000001', time: '2026-09-01T00:00:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'grant', amount: 50, remaining: 50, note: '注册赠送' },
  { id: 'f0000000-0000-4000-8000-000000000002', time: '2026-09-01T00:01:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 49, note: 'job:1:a.md' },
  { id: 'f0000000-0000-4000-8000-000000000003', time: '2026-09-01T00:02:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'release', amount: 1, remaining: 50, note: '退回' },
  { id: 'f0000000-0000-4000-8000-000000000004', time: '2026-09-01T00:03:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 49, note: 'job:2:b.md' },
  { id: 'f0000000-0000-4000-8000-000000000005', time: '2026-09-01T00:04:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 48, note: 'job:3:c.md' },
  { id: 'f0000000-0000-4000-8000-000000000006', time: '2026-09-01T00:05:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 47, note: 'job:4:d.md' },
  { id: 'f0000000-0000-4000-8000-000000000007', time: '2026-09-01T00:06:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 46, note: 'job:5:e.md' },
  { id: 'f0000000-0000-4000-8000-000000000008', time: '2026-09-01T00:07:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 45, note: 'job:6:f.md' },
  { id: 'f0000000-0000-4000-8000-000000000009', time: '2026-09-01T00:08:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 44, note: 'job:7:g.md' },
  { id: 'f0000000-0000-4000-8000-000000000010', time: '2026-09-01T00:09:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 43, note: 'job:8:h.md' },
  { id: 'f0000000-0000-4000-8000-000000000011', time: '2026-09-01T00:10:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 42, note: 'job:9:i.md' },
  { id: 'f0000000-0000-4000-8000-000000000012', time: '2026-09-01T00:11:00.000Z', userId: 'e2222222-2222-2222-2222-222222222222', type: 'grant', amount: 7, remaining: 7, note: '注册赠送' }
];

async function writeFixtures() {
  await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify(USERS, null, 2));
  await fs.writeFile(path.join(dataDir, 'quotas.json'), JSON.stringify(QUOTAS, null, 2));
  await fs.writeFile(
    path.join(dataDir, 'quota-ledger.jsonl'),
    `${LEDGER.map((l) => JSON.stringify(l)).join('\n')}\n`
  );
}

test.before(async () => {
  await setupSchema();
});

test.beforeEach(async () => {
  await truncateAll();
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'md2pdf-import-'));
  await writeFixtures();
});

test.afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

test.after(async () => {
  await closePool();
});

test('导入用户、余额与流水，条数逐条吻合', async () => {
  const result = await importFrom({ dataDir });
  // 文件里的条数
  assert.equal(result.totalUsers, 2);
  assert.equal(result.totalQuotas, 2);
  assert.equal(result.totalLedger, 12);
  // 实际入库的条数（首次导入两者应相等）
  assert.equal(result.insertedUsers, 2);
  assert.equal(result.insertedQuotas, 2);
  assert.equal(result.insertedLedger, 12);
  assert.equal(result.skipped, 0);

  const users = (await pool.query('SELECT * FROM users ORDER BY email')).rows;
  assert.equal(users.length, 2);
  // ORDER BY email：one@ < two@，所以下标 0 是 one
  assert.equal(users[0].email, 'one@example.com');
  assert.equal(users[0].name, '甲');
  assert.equal(users[0].role, 'admin');
  assert.equal(users[0].created_at.getTime(), 1756700000000, 'createdAt 毫秒时间戳应无损还原');
  assert.match(users[0].password_hash, /^scrypt\$/, '密码哈希原样搬运，用户无需改密码');
  assert.equal(users[1].email, 'two@example.com');
  assert.equal(users[1].role, 'user');
});

test('导入后每个账户余额与最后一条流水快照一致（对账）', async () => {
  await importFrom({ dataDir });
  const mismatches = await verifyConsistency();
  assert.deepEqual(mismatches, [], '迁移后余额必须与流水快照吻合');
});

test('对账能抓出不一致（自检这个检查本身有效）', async () => {
  await importFrom({ dataDir });
  await pool.query(
    `UPDATE quota_accounts SET remaining = 999 WHERE user_id = 'e2222222-2222-2222-2222-222222222222'`
  );
  const mismatches = await verifyConsistency();
  assert.equal(mismatches.length, 1, '被篡改的余额必须被对账抓出来');
  assert.equal(mismatches[0].user_id, 'e2222222-2222-2222-2222-222222222222');
});

test('导入是幂等的：原文件重新出现后再导入一次也不产生重复', async () => {
  await importFrom({ dataDir });

  // 重新写出原始 JSON（等价于「回退到文件存储后又切回 PG」），再导一次
  await writeFixtures();
  const second = await importFrom({ dataDir });

  assert.equal(second.totalUsers, 2, '文件里仍是 2 条');
  assert.equal(second.insertedUsers, 0, '一条都不应重复入库');
  assert.equal(second.insertedQuotas, 0);
  assert.equal(second.insertedLedger, 0);
  assert.equal(second.skipped, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM quota_accounts')).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM quota_ledger')).rows[0].n, 12);
});

test('导入成功后原文件被改名为 .migrated 保留', async () => {
  await importFrom({ dataDir });
  const entries = await fs.readdir(dataDir);
  assert.ok(entries.includes('users.json.migrated'));
  assert.ok(entries.includes('quotas.json.migrated'));
  assert.ok(entries.includes('quota-ledger.jsonl.migrated'));
  assert.ok(!entries.includes('users.json'), '原文件应已改名');
});

test('.migrated 文件内容与原名时完全一致（可原样回退）', async () => {
  await importFrom({ dataDir });
  const raw = await fs.readFile(path.join(dataDir, 'users.json.migrated'), 'utf8');
  assert.deepEqual(JSON.parse(raw), USERS, '备份必须能原样还原，否则回退方案不成立');
});

test('dry-run 如实报告待导入条数（三个分类都不能是 0）', async () => {
  const result = await importFrom({ dataDir, dryRun: true });

  // 这条断言针对一个真实踩过的坑：初版把「文件里有几条」和「本次入库几条」
  // 共用一个字段，dry-run 提前返回时后两个分类恒为 0，
  // 于是对着一份有 4 条余额、41 条流水的线上数据报告「余额 0 条，流水 0 条」。
  assert.equal(result.totalUsers, 2);
  assert.equal(result.totalQuotas, 2, 'dry-run 必须如实报告余额条数');
  assert.equal(result.totalLedger, 12, 'dry-run 必须如实报告流水条数');
  assert.equal(result.insertedUsers, 0, 'dry-run 不写库，入库数为 0');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);

  const entries = await fs.readdir(dataDir);
  assert.ok(entries.includes('users.json'), 'dry-run 不得移动原文件');
  assert.ok(!entries.includes('users.json.migrated'));
});

test('数据目录不存在时抛错而不是静默跳过', async () => {
  await assert.rejects(() => importFrom({ dataDir: path.join(dataDir, 'nope') }), /不存在/);
});

test('缺少某个文件时按空处理，不阻断其余数据的导入', async () => {
  await fs.rm(path.join(dataDir, 'quota-ledger.jsonl'));
  const result = await importFrom({ dataDir });
  assert.equal(result.users, 2);
  assert.equal(result.quotas, 2);
  assert.equal(result.ledger, 0, '缺失的流水文件按 0 条处理');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
});

test('流水中的半截行被跳过而不是阻断整个迁移', async () => {
  await fs.writeFile(
    path.join(dataDir, 'quota-ledger.jsonl'),
    `${LEDGER.map((l) => JSON.stringify(l)).join('\n')}\n{"id":"f0000000-0000-4000-8000-000000000013","userId":"e1111`
  );
  const result = await importFrom({ dataDir });
  assert.equal(result.ledger, 12, '合法的 12 条应全部导入，损坏的那条被跳过');
});

test('导入的密码哈希可直接用于登录校验（格式未损坏）', async () => {
  const userStore = require('../src/services/userStore');
  const hash = userStore.hashPassword('password123');
  const single = [
    {
      id: 'e3333333-3333-3333-3333-333333333333',
      email: 'login@example.com',
      name: '登录者',
      passwordHash: hash,
      role: 'user',
      createdAt: Date.now()
    }
  ];
  await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify(single));
  // 配额与流水里引用的还是旧用户，留着会撞外键（它们本就不属于这个场景）
  await fs.rm(path.join(dataDir, 'quotas.json'));
  await fs.rm(path.join(dataDir, 'quota-ledger.jsonl'));

  await importFrom({ dataDir });
  const authed = await userStore.authenticate('login@example.com', 'password123');
  assert.ok(authed, '迁移过来的用户必须能用原密码登录');
  assert.equal(authed.id, 'e3333333-3333-3333-3333-333333333333');
});
