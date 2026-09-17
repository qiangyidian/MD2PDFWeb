# 兑换码与 PostgreSQL 迁移 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 MD2PDFWeb 增加「管理员生成兑换码、用户兑码充值额度」功能，并把账号/额度/会话从 JSON 文件迁移到 PostgreSQL。

**Architecture:** 三个既有 store（`userStore` / `sessionStore` / `quotaStore`）替换为 PG 实现但**导出签名一字不改**，调用点零改动。新增 `redeemStore` 承载兑换码，兑换走单事务 + `SELECT ... FOR UPDATE` 行锁保证不双花。

**Tech Stack:** Node.js 20.20.2 (CommonJS) · Express 5 · PostgreSQL 14 · `pg` 8 · `node:test` 内置测试运行器 · Vue 3 + Vite

**Spec:** `docs/superpowers/specs/2026-09-17-redeem-codes-and-postgres-design.md`

## Global Constraints

- **Node 运行时是 20.20.2**（服务器 `/usr/bin/node`）。不可使用 `node:sqlite`、`Array.prototype.findLast` 之外更新的 API；`node --test` 可用。
- **CommonJS**（`require` / `module.exports`），不是 ESM。`server/package.json` 为 `"type": "commonjs"`。
- **不引入 ORM**。只用 `pg` + 手写 SQL。
- **三个既有 store 的导出函数签名不得改动**，调用点（`jobManager.js` 3 处、`routes/auth.js` 4 处、`routes/admin.js` 5 处、`index.js` 1 处）保持零修改。
- **术语统一为「额度」**，不得引入「积分」字样。
- 数据库连接串一律读环境变量 `MD2PDF_DATABASE_URL`。
- 所有新增代码注释用中文，与既有代码风格一致。
- 服务器工作目录 `/root/MD2PDFWeb`，通过 `ssh md2pdf` 访问（已配置免密）。
- 测试库为 `md2pdf_test`，**测试代码必须拒绝在非 `_test` 结尾的库上运行**。

---

### Task 1: PG 连接池、迁移执行器与建表

**Files:**
- Create: `server/src/db/pool.js`
- Create: `server/src/db/migrate.js`
- Create: `server/migrations/0001_init.sql`
- Create: `server/test/helpers/db.js`
- Create: `server/test/migrate.test.js`
- Modify: `server/package.json`（加 `pg` 依赖与 `test` 脚本）
- Modify: `server/src/config.js`（加 `databaseUrl`）

**Interfaces:**
- Consumes: 无
- Produces:
  - `pool.js` 导出 `{ pool, query, withTx, close }`
    - `query(text, params) => Promise<pg.Result>`
    - `withTx(fn) => Promise<any>`，`fn` 收到一个 `client`，有 `client.query(text, params)`
  - `migrate.js` 导出 `{ migrate, MIGRATIONS_DIR }`，`migrate() => Promise<{ applied: string[] }>`

- [ ] **Step 1: 装依赖并加配置**

```bash
ssh md2pdf 'cd /root/MD2PDFWeb/server && npm install pg@^8.23.0'
```

修改 `server/package.json` 的 `scripts`，加：

```json
    "test": "node --test test/"
```

在 `server/src/config.js` 的 `port` 定义之后加：

```js
// PostgreSQL 连接串（账号/额度/会话/兑换码的权威存储）。
// 未设置时启动即失败——绝不静默降级回文件存储，双存储的数据分裂比宕机更难查。
const databaseUrl = process.env.MD2PDF_DATABASE_URL || '';
```

并在 `module.exports` 中 `port,` 后加一行：

```js
  databaseUrl,
```

- [ ] **Step 2: 写建表 SQL**

Create `server/migrations/0001_init.sql`：

```sql
-- 0001_init：账号 / 会话 / 额度 / 兑换码
-- 幂等：全部 IF NOT EXISTS，可重复执行

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_id     text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions (last_seen_at);

CREATE TABLE IF NOT EXISTS quota_accounts (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  remaining  integer NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quota_ledger (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_type     text NOT NULL,
  amount         integer NOT NULL,
  remaining      integer NOT NULL,
  note           text NOT NULL DEFAULT '',
  reference_type text NOT NULL DEFAULT '',
  reference_id   text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quota_ledger_user_idx ON quota_ledger (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_ledger_reference
  ON quota_ledger (reference_type, reference_id) WHERE reference_id <> '';

CREATE TABLE IF NOT EXISTS redeem_codes (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  value      integer NOT NULL CHECK (value > 0),
  batch_id   uuid NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  status     text NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used', 'revoked')),
  used_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  used_at    timestamptz,
  used_ip    text,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  note       text NOT NULL DEFAULT '',
  CONSTRAINT ck_redeem_used CHECK (
    status <> 'used' OR (used_by IS NOT NULL AND used_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS redeem_codes_batch_idx ON redeem_codes (batch_id);
CREATE INDEX IF NOT EXISTS redeem_codes_status_idx ON redeem_codes (status, created_at DESC);
```

- [ ] **Step 3: 写连接池**

Create `server/src/db/pool.js`：

```js
const { Pool } = require('pg');

const config = require('../config');

/**
 * PostgreSQL 连接池单例。
 *
 * 小机器（2 核 3.8G）上的保守配置：连接数上限 10，空闲 30s 回收。
 * 本服务是单进程 Express，池实际上只会被一条事件循环串行取用，
 * 10 条足够覆盖「一次事务内多次往返」的场景而不浪费 PG 侧的 backend 进程。
 */
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

// 空闲连接被 PG 侧断开时 pg 会发 error 事件；不监听会进程崩溃
pool.on('error', (error) => {
  console.error('[db] 空闲连接异常:', error.message);
});

function query(text, params) {
  return pool.query(text, params);
}

/**
 * 事务包装。回调抛错即 ROLLBACK，正常返回即 COMMIT。
 * 回调收到的是同一个 client，事务内的多次查询必须全部走它，
 * 否则会跑到池里另一条连接上，脱离事务。
 */
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 连接已坏，ROLLBACK 失败不影响原始错误上抛 */
    }
    throw error;
  } finally {
    client.release();
  }
}

function close() {
  return pool.end();
}

module.exports = { close, pool, query, withTx };
```

- [ ] **Step 4: 写迁移执行器**

Create `server/src/db/migrate.js`：

```js
const fs = require('node:fs/promises');
const path = require('node:path');

const { pool } = require('./pool');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

/**
 * 迁移执行器。
 *
 * 约定：server/migrations/NNNN_名称.sql，按文件名字典序执行。
 * 每个文件在**单个事务**内执行，成功后把版本号写入 schema_migrations；
 * 失败则整个文件回滚，绝不会留下执行了一半的 schema。
 * 已记录的版本直接跳过，因此重复执行是安全的。
 *
 * 建表语句本身也写了 IF NOT EXISTS，是第二层幂等保护：
 * 即使 schema_migrations 丢失，重跑也不会炸。
 */
async function migrate() {
  if (!MIGRATIONS_DIR) throw new Error('迁移目录未配置');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const done = new Set(rows.map((r) => r.version));

  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;

    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      console.log(`[db] 已应用迁移 ${file}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`迁移 ${file} 执行失败: ${error.message}`);
    } finally {
      client.release();
    }
  }

  return { applied };
}

module.exports = { MIGRATIONS_DIR, migrate };
```

- [ ] **Step 5: 写测试基建**

Create `server/test/helpers/db.js`：

```js
const { pool } = require('../../src/db/pool');
const { migrate } = require('../../src/db/migrate');

/**
 * 测试数据库辅助。
 *
 * 安全阀：库里带 md2pdf_test 才允许清表。防的是「把 MD2PDF_DATABASE_URL
 * 指向了生产库，然后跑测试清空了真实数据」这种一次就够致命的事故。
 */
function assertTestDatabase() {
  const name = pool.options.database || '';
  if (!name.endsWith('_test')) {
    throw new Error(
      `拒绝在非测试库上执行：当前数据库为 "${name}"，必须以 _test 结尾。` +
        '请设置 MD2PDF_DATABASE_URL=postgres://...@127.0.0.1:5432/md2pdf_test'
    );
  }
}

// 建表（幂等，重复调用无副作用）
async function setupSchema() {
  assertTestDatabase();
  await migrate();
}

// 清空业务表。TRUNCATE ... CASCADE 一次性清掉外键关联，且比重启序列快
async function truncateAll() {
  assertTestDatabase();
  await pool.query('TRUNCATE users, sessions, quota_accounts, quota_ledger, redeem_codes CASCADE');
}

async function closePool() {
  await pool.end();
}

async function insertUser({ id, email, name = 'U', role = 'user', hash = 'scrypt$1$1$1$aa$bb' }) {
  await pool.query(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
    [id, email, name, hash, role]
  );
  return id;
}

module.exports = { assertTestDatabase, closePool, insertUser, pool, setupSchema, truncateAll };
```

- [ ] **Step 6: 写迁移测试**

Create `server/test/migrate.test.js`：

```js
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
```

- [ ] **Step 7: 建测试库并跑测试**

```bash
ssh md2pdf "sudo -u postgres psql -c \"CREATE ROLE md2pdf LOGIN PASSWORD 'md2pdf'\" 2>/dev/null; \
sudo -u postgres psql -c 'CREATE DATABASE md2pdf OWNER md2pdf' 2>/dev/null; \
sudo -u postgres psql -c 'CREATE DATABASE md2pdf_test OWNER md2pdf' 2>/dev/null; \
cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' npm test"
```

Expected: 5 个测试全部 PASS。

- [ ] **Step 8: 验证安全阀真的会拦住生产库**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf' node --test test/migrate.test.js 2>&1 | grep -m1 '拒绝在非测试库'"
```

Expected: 打印出「拒绝在非测试库上执行」。若没有输出说明安全阀失效，必须修复后才能继续。

- [ ] **Step 9: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m 'PG 基础设施：连接池 + 迁移执行器 + 建表 + 测试基建'"
```

---

### Task 2: userStore 迁移到 PostgreSQL

**Files:**
- Modify: `server/src/services/userStore.js`（整体替换内部实现，导出签名不变）
- Create: `server/test/userStore.test.js`

**Interfaces:**
- Consumes: Task 1 的 `../db/pool` 的 `query` / `withTx`
- Produces: 导出签名**与现在完全一致**：
  `{ adminCreateUser, adminResetPassword, allUserIds, authenticate, createUser, deleteUser, findByEmail, findById, hashPassword, isAdmin, listUsers, publicUser, setRole, validateEmailFormat, validateRegistration, verifyPassword }`
  - `createUser({email, password, name}) => Promise<PublicUser>`
  - `authenticate(email, password) => Promise<User|null>`
  - `findById(id) => Promise<User|null>`（返回**含 `passwordHash`** 的完整行）
  - `publicUser(user) => {id, email, name, role, createdAt}`，`createdAt` 为**毫秒时间戳数字**
  - `setRole(id, role) => Promise<PublicUser>`
  - `deleteUser(id, operatorId) => Promise<PublicUser>`
  - `listUsers() => Promise<PublicUser[]>`

- [ ] **Step 1: 写失败测试**

Create `server/test/userStore.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { insertUser, pool, setupSchema, truncateAll, closePool } = require('./helpers/db');
const userStore = require('../src/services/userStore');

test.before(async () => {
  await setupSchema();
});
test.beforeEach(async () => {
  await truncateAll();
});
test.after(async () => {
  await closePool();
});

test('createUser 落库并返回公开字段，不含 passwordHash', async () => {
  const user = await userStore.createUser({ email: 'A@Example.com ', password: 'password123', name: '阿甲' });
  assert.equal(user.email, 'a@example.com', '邮箱应小写去空格规范化');
  assert.equal(user.name, '阿甲');
  assert.equal(user.role, 'user');
  assert.equal(user.passwordHash, undefined);
  assert.equal(typeof user.createdAt, 'number');

  const { rows } = await pool.query('SELECT email FROM users WHERE id = $1', [user.id]);
  assert.equal(rows.length, 1);
});

test('createUser 对重复邮箱抛 409', async () => {
  await userStore.createUser({ email: 'dup@example.com', password: 'password123' });
  await assert.rejects(
    () => userStore.createUser({ email: 'DUP@example.com', password: 'password123' }),
    (error) => error.statusCode === 409
  );
});

test('authenticate 正确密码通过、错误密码返回 null', async () => {
  await userStore.createUser({ email: 'auth@example.com', password: 'password123' });
  const ok = await userStore.authenticate('auth@example.com', 'password123');
  assert.ok(ok);
  assert.equal(ok.email, 'auth@example.com');
  assert.equal(await userStore.authenticate('auth@example.com', 'wrong-password'), null);
  assert.equal(await userStore.authenticate('nobody@example.com', 'password123'), null);
});

test('authenticate 对不存在的账号也返回 null（不区分账号是否存在）', async () => {
  const result = await userStore.authenticate('ghost@example.com', 'whatever123');
  assert.equal(result, null);
});

test('findById 返回含 passwordHash 的完整行', async () => {
  const created = await userStore.createUser({ email: 'full@example.com', password: 'password123' });
  const found = await userStore.findById(created.id);
  assert.equal(found.email, 'full@example.com');
  assert.match(found.passwordHash, /^scrypt\$/);
});

test('setRole 可升降级，且最后一个管理员不可被降级', async () => {
  const admin = await userStore.createUser({ email: 'admin@example.com', password: 'password123' });
  const other = await userStore.createUser({ email: 'other@example.com', password: 'password123' });

  await userStore.setRole(admin.id, 'admin');
  assert.equal((await userStore.findById(admin.id)).role, 'admin');

  await assert.rejects(
    () => userStore.setRole(admin.id, 'user'),
    (error) => error.statusCode === 400,
    '仅剩一名管理员时不得降级'
  );

  await userStore.setRole(other.id, 'admin');
  const demoted = await userStore.setRole(admin.id, 'user');
  assert.equal(demoted.role, 'user');
});

test('deleteUser 不可删自己，也不可删最后一个管理员', async () => {
  const admin = await userStore.createUser({ email: 'a1@example.com', password: 'password123' });
  await userStore.setRole(admin.id, 'admin');

  await assert.rejects(
    () => userStore.deleteUser(admin.id, admin.id),
    (error) => error.statusCode === 400
  );

  const admin2 = await userStore.createUser({ email: 'a2@example.com', password: 'password123' });
  await userStore.setRole(admin2.id, 'admin');
  const removed = await userStore.deleteUser(admin2.id, admin.id);
  assert.equal(removed.email, 'a2@example.com');
  assert.equal(await userStore.findById(admin2.id), null);
});

test('删除用户级联清掉其会话与额度', async () => {
  const user = await userStore.createUser({ email: 'cascade@example.com', password: 'password123' });
  await pool.query(`INSERT INTO quota_accounts (user_id, remaining) VALUES ($1, 7)`, [user.id]);
  await pool.query(
    `INSERT INTO sessions (token_id, user_id, created_at, last_seen_at) VALUES ('tok', $1, now(), now())`,
    [user.id]
  );

  await userStore.deleteUser(user.id, 'some-other-admin');

  assert.equal((await pool.query('SELECT 1 FROM quota_accounts WHERE user_id = $1', [user.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM sessions WHERE user_id = $1', [user.id])).rowCount, 0);
});

test('isAdmin 实时反映角色变更', async () => {
  const user = await userStore.createUser({ email: 'live@example.com', password: 'password123' });
  assert.equal(await userStore.isAdmin(user.id), false);
  await userStore.setRole(user.id, 'admin');
  assert.equal(await userStore.isAdmin(user.id), true);
});

test('allUserIds 返回全部用户 id', async () => {
  const a = await userStore.createUser({ email: 'x1@example.com', password: 'password123' });
  const b = await userStore.createUser({ email: 'x2@example.com', password: 'password123' });
  const ids = await userStore.allUserIds();
  assert.deepEqual(ids.sort(), [a.id, b.id].sort());
});

test('adminResetPassword 后旧密码失效、新密码可用', async () => {
  const user = await userStore.createUser({ email: 'reset@example.com', password: 'oldpassword1' });
  await userStore.adminResetPassword(user.id, 'newpassword1');
  assert.equal(await userStore.authenticate('reset@example.com', 'oldpassword1'), null);
  assert.ok(await userStore.authenticate('reset@example.com', 'newpassword1'));
});

test('listUsers 按注册时间倒序且不含密码哈希', async () => {
  await insertUser({ id: '33333333-3333-3333-3333-333333333333', email: 'old@example.com' });
  await userStore.createUser({ email: 'new@example.com', password: 'password123' });
  const list = await userStore.listUsers();
  assert.equal(list[0].email, 'new@example.com');
  assert.equal(list[0].passwordHash, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/userStore.test.js 2>&1 | tail -20"
```

Expected: FAIL —— 现有实现写的是 `users.json`，`users` 表始终为空，`createUser` 后的 `pool.query` 查不到行。

- [ ] **Step 3: 重写 userStore**

整体替换 `server/src/services/userStore.js`：

```js
const crypto = require('node:crypto');

const { query, withTx } = require('../db/pool');

/**
 * 用户存储（PostgreSQL）
 *
 * 自 2026-09-17 起由 JSON 文件迁移到 PG：单机多请求下的读-改-写不再依赖
 * 进程内 Map，而是靠数据库事务与唯一约束保证。对外导出签名保持不变，
 * 因此 auth/admin 路由无需改动。
 *
 * 安全设计：
 * - 密码使用 scrypt（N=16384, r=8, p=1）加盐哈希，格式 `scrypt$N$r$p$salt$hash`，
 *   内置版本前缀，便于将来升级算法时对旧哈希平滑迁移
 * - 每用户独立 16 字节随机盐，杜绝彩虹表
 * - 校验使用 timingSafeEqual，不泄露时序信息
 * - 登录失败信息统一为「邮箱或密码错误」，不区分账号是否存在（authenticate
 *   对不存在的账号也跑一次 scrypt，拉平响应时间，防账号枚举）
 *
 * 角色：
 * - user  普通用户（默认）
 * - admin 管理员（通过环境变量 MD2PDF_ADMIN_EMAILS 引导首个管理员）
 */

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('base64'), hash.toString('base64')].join('$');
}

// 恒定时间校验：长度差异时也做一次假比对，避免通过耗时探测哈希格式
function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p)
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{1,24}$/;

function validateEmailFormat(email) {
  if (!email || typeof email !== 'string') return '请输入邮箱';
  if (!EMAIL_RE.test(email)) return '邮箱格式不正确';
  return null;
}

function validateRegistration({ email, password, name }) {
  const emailError = validateEmailFormat(email);
  if (emailError) return emailError;
  if (!password || typeof password !== 'string') return '请输入密码';
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 200) return '密码过长（上限 200 字符）';
  if (name !== undefined) {
    if (typeof name !== 'string' || name.length > 40) return '昵称不能超过 40 字符';
  }
  return null;
}

// 数据库行 -> 内部对象。createdAt 统一转成毫秒时间戳，与迁移前保持一致，
// 前端与管理后台的排序/展示代码因此无需改动。
function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    role: row.role,
    createdAt: row.created_at.getTime()
  };
}

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role === 'admin' ? 'admin' : 'user',
    createdAt: user.createdAt
  };
}

async function findByEmail(email) {
  const { rows } = await query('SELECT * FROM users WHERE email = $1', [
    String(email).trim().toLowerCase()
  ]);
  return fromRow(rows[0]);
}

async function findById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return fromRow(rows[0]);
}

async function createUser({ email, password, name }) {
  const normalizedEmail = String(email).trim().toLowerCase();
  const nickname = (typeof name === 'string' && name.trim()) || normalizedEmail.split('@')[0];

  const { rows } = await query(
    `INSERT INTO users (id, email, name, password_hash, role)
     VALUES ($1, $2, $3, $4, 'user')
     ON CONFLICT (email) DO NOTHING
     RETURNING *`,
    [crypto.randomUUID(), normalizedEmail, nickname, hashPassword(password)]
  );

  if (!rows.length) {
    const error = new Error('该邮箱已注册');
    error.statusCode = 409;
    throw error;
  }
  return publicUser(fromRow(rows[0]));
}

async function authenticate(email, password) {
  const user = await findByEmail(email);
  if (!user) {
    // 对不存在的账号也做一次 scrypt，拉平响应时间，防账号枚举
    crypto.scryptSync(password, Buffer.alloc(16), KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    return null;
  }
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

async function allUserIds() {
  const { rows } = await query('SELECT id FROM users');
  return rows.map((r) => r.id);
}

// ---------- 管理员操作 ----------

async function listUsers() {
  const { rows } = await query('SELECT * FROM users ORDER BY created_at DESC');
  return rows.map((row) => publicUser(fromRow(row)));
}

// 设置角色。guard：最后一个管理员不可被降级（避免系统失去管理员而锁死）。
// 计数与写入在同一事务内完成并对目标行加锁，防止两个管理员并发互降导致零管理员。
async function setRole(id, role) {
  if (!['user', 'admin'].includes(role)) {
    const error = new Error('无效的角色');
    error.statusCode = 400;
    throw error;
  }

  return withTx(async (client) => {
    const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    const user = fromRow(rows[0]);
    if (!user) {
      const error = new Error('用户不存在');
      error.statusCode = 404;
      throw error;
    }
    if (user.role === role) return publicUser(user);

    if (user.role === 'admin' && role === 'user') {
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin'`
      );
      if (countRows[0].n <= 1) {
        const error = new Error('系统至少需要保留一名管理员，请先指定其他管理员');
        error.statusCode = 400;
        throw error;
      }
    }

    await client.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
    return publicUser({ ...user, role });
  });
}

async function adminResetPassword(id, newPassword) {
  if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 8) {
    const error = new Error('新密码至少 8 位');
    error.statusCode = 400;
    throw error;
  }
  const { rows } = await query(
    'UPDATE users SET password_hash = $1 WHERE id = $2 RETURNING *',
    [hashPassword(newPassword), id]
  );
  if (!rows.length) {
    const error = new Error('用户不存在');
    error.statusCode = 404;
    throw error;
  }
  return publicUser(fromRow(rows[0]));
}

async function deleteUser(id, operatorId) {
  if (id === operatorId) {
    const error = new Error('不能删除当前登录的管理员账号');
    error.statusCode = 400;
    throw error;
  }

  return withTx(async (client) => {
    const { rows } = await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [id]);
    const user = fromRow(rows[0]);
    if (!user) {
      const error = new Error('用户不存在');
      error.statusCode = 404;
      throw error;
    }
    if (user.role === 'admin') {
      const { rows: countRows } = await client.query(
        `SELECT count(*)::int AS n FROM users WHERE role = 'admin'`
      );
      if (countRows[0].n <= 1) {
        const error = new Error('系统至少需要保留一名管理员');
        error.statusCode = 400;
        throw error;
      }
    }

    // sessions / quota_accounts / quota_ledger 由外键 ON DELETE CASCADE 自动清理
    await client.query('DELETE FROM users WHERE id = $1', [id]);
    return publicUser(user);
  });
}

async function adminCreateUser({ email, password, name, role = 'user' }) {
  const invalid = validateRegistration({ email, password, name });
  if (invalid) {
    const error = new Error(invalid);
    error.statusCode = 400;
    throw error;
  }
  const user = await createUser({ email, password, name });
  if (role === 'admin') {
    await query(`UPDATE users SET role = 'admin' WHERE id = $1`, [user.id]);
    return { ...user, role: 'admin' };
  }
  return user;
}

async function isAdmin(id) {
  const { rows } = await query('SELECT role FROM users WHERE id = $1', [id]);
  return rows[0]?.role === 'admin';
}

// 启动引导：把 MD2PDF_ADMIN_EMAILS 中的邮箱提权为 admin（幂等）
async function bootstrapAdmins(emails) {
  if (!emails.length) return [];
  const { rows } = await query(
    `UPDATE users SET role = 'admin'
      WHERE email = ANY($1) AND role <> 'admin'
      RETURNING email`,
    [emails]
  );
  return rows.map((r) => r.email);
}

module.exports = {
  adminCreateUser,
  adminResetPassword,
  allUserIds,
  authenticate,
  bootstrapAdmins,
  createUser,
  deleteUser,
  findByEmail,
  findById,
  hashPassword,
  isAdmin,
  listUsers,
  publicUser,
  setRole,
  validateEmailFormat,
  validateRegistration,
  verifyPassword
};
```

- [ ] **Step 4: 跑测试确认通过**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/userStore.test.js 2>&1 | tail -20"
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m 'userStore 迁移到 PostgreSQL（导出签名不变）'"
```

---

### Task 3: sessionStore 迁移到 PostgreSQL

**Files:**
- Modify: `server/src/services/sessionStore.js`（整体替换，导出签名不变）
- Create: `server/test/sessionStore.test.js`
- Modify: `server/src/config.js`（加 `sessionTouchIntervalMs`）

**Interfaces:**
- Consumes: `../db/pool`，Task 2 的 `users` 表
- Produces: 导出签名与现在一致：
  `{ create, destroy, destroyAllForUser, resolve, startSweeper }`
  - `create(user) => Promise<string>`（返回明文 token）
  - `resolve(token) => Promise<{tokenId, userId, email, name, createdAt, lastSeenAt}|null>`
  - `destroy(token) => Promise<void>`
  - `destroyAllForUser(userId) => Promise<number>`

- [ ] **Step 1: 写失败测试**

Create `server/test/sessionStore.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { pool, setupSchema, truncateAll, closePool, insertUser } = require('./helpers/db');
const sessionStore = require('../src/services/sessionStore');
const config = require('../src/config');

const UID = '44444444-4444-4444-4444-444444444444';

test.before(async () => {
  await setupSchema();
});
test.beforeEach(async () => {
  await truncateAll();
  await insertUser({ id: UID, email: 'sess@example.com', name: '会话用户' });
});
test.after(async () => {
  await closePool();
});

test('create 返回明文 token，库里只存 sha256', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  assert.ok(token.length > 20);

  const { rows } = await pool.query('SELECT token_id FROM sessions');
  assert.equal(rows.length, 1);
  const expected = crypto.createHash('sha256').update(token).digest('hex');
  assert.equal(rows[0].token_id, expected);
  assert.notEqual(rows[0].token_id, token, '明文 token 绝不能落库');
});

test('resolve 用有效 token 换回会话，并带上用户邮箱与昵称', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  const session = await sessionStore.resolve(token);
  assert.equal(session.userId, UID);
  assert.equal(session.email, 'sess@example.com');
  assert.equal(session.name, '会话用户');
});

test('resolve 对无效/空 token 返回 null', async () => {
  assert.equal(await sessionStore.resolve('not-a-real-token'), null);
  assert.equal(await sessionStore.resolve(''), null);
  assert.equal(await sessionStore.resolve(null), null);
});

test('resolve 在空闲超时后失效并删除该行', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  const idleMs = config.auth.sessionIdleDays * 24 * 60 * 60 * 1000;
  await pool.query('UPDATE sessions SET last_seen_at = $1', [new Date(Date.now() - idleMs - 1000)]);

  assert.equal(await sessionStore.resolve(token), null);
  const { rowCount } = await pool.query('SELECT 1 FROM sessions');
  assert.equal(rowCount, 0, '过期会话应在 resolve 时被删除');
});

test('resolve 在绝对超时后失效（即使一直活跃）', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  const absMs = config.auth.sessionAbsoluteDays * 24 * 60 * 60 * 1000;
  await pool.query('UPDATE sessions SET created_at = $1, last_seen_at = now()', [
    new Date(Date.now() - absMs - 1000)
  ]);
  assert.equal(await sessionStore.resolve(token), null);
});

test('resolve 的续期是节流的：短时间内不重复写 last_seen_at', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  const before = (await pool.query('SELECT last_seen_at FROM sessions')).rows[0].last_seen_at;

  await sessionStore.resolve(token);
  await sessionStore.resolve(token);

  const after = (await pool.query('SELECT last_seen_at FROM sessions')).rows[0].last_seen_at;
  assert.equal(after.getTime(), before.getTime(), '刚写过的 last_seen_at 不应被重复刷新');
});

test('resolve 在超过节流窗口后确实续期', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  const stale = new Date(Date.now() - config.auth.sessionTouchIntervalMs - 5000);
  await pool.query('UPDATE sessions SET last_seen_at = $1', [stale]);

  await sessionStore.resolve(token);

  const after = (await pool.query('SELECT last_seen_at FROM sessions')).rows[0].last_seen_at;
  assert.ok(after.getTime() > stale.getTime(), '超过节流窗口后应刷新 last_seen_at');
});

test('destroy 立即吊销会话', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  await sessionStore.destroy(token);
  assert.equal(await sessionStore.resolve(token), null);
});

test('destroyAllForUser 踢掉该用户全部会话并返回条数', async () => {
  const t1 = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  const t2 = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  const removed = await sessionStore.destroyAllForUser(UID);
  assert.equal(removed, 2);
  assert.equal(await sessionStore.resolve(t1), null);
  assert.equal(await sessionStore.resolve(t2), null);
});

test('删除用户时其会话被级联清除', async () => {
  await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  await pool.query('DELETE FROM users WHERE id = $1', [UID]);
  const { rowCount } = await pool.query('SELECT 1 FROM sessions');
  assert.equal(rowCount, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/sessionStore.test.js 2>&1 | tail -20"
```

Expected: FAIL —— 现有实现写 `sessions.json`，`sessions` 表查询为空；且 `config.auth.sessionTouchIntervalMs` 未定义。

- [ ] **Step 3: 加配置项**

在 `server/src/config.js` 的 `auth` 对象内，`sessionAbsoluteDays` 之后加：

```js
    // 滑动续期的写库节流窗口：距上次续期超过该值才 UPDATE。
    // 不加节流的话每个已登录请求都会写一次 sessions，读放大成写放大。
    sessionTouchIntervalMs: Number(process.env.MD2PDF_SESSION_TOUCH_INTERVAL_SECONDS || 60) * 1000
```

- [ ] **Step 4: 重写 sessionStore**

整体替换 `server/src/services/sessionStore.js`：

```js
const crypto = require('node:crypto');

const config = require('../config');
const { query } = require('../db/pool');

/**
 * 会话存储（PostgreSQL）
 *
 * 为什么不用 JWT：本服务是单进程 Express，无跨服务校验诉求；
 * opaque token 可以随时服务端吊销（登出即失效），不存在 JWT 无法主动作废的问题，
 * 也不需要把会话状态泄漏到客户端。
 *
 * 安全设计：
 * - token 为 32 字节 CSPRNG（base64url），仅通过 HttpOnly+Secure+SameSite=Lax Cookie 传输，
 *   XSS 拿不到；库里只存 sha256(token)，库被拖也无法反查出 token
 * - 滑动过期（默认 7 天活跃续期）+ 绝对过期（默认 30 天强制重新登录）
 * - 进程重启会话保持，用户不被登出
 * - 定期清扫过期会话，防表无限膨胀
 *
 * 迁移到 PG 后新增的取舍：滑动续期做写库节流。原实现写进程内 Map，
 * 每请求改一次内存无成本；现在每请求一次 UPDATE 就变成读放大成写放大，
 * 因此距上次续期不足 sessionTouchIntervalMs 时跳过写入。
 */

const IDLE_TTL_MS = config.auth.sessionIdleDays * 24 * 60 * 60 * 1000;
const ABSOLUTE_TTL_MS = config.auth.sessionAbsoluteDays * 24 * 60 * 60 * 1000;

function tokenId(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function create(user) {
  const token = crypto.randomBytes(32).toString('base64url');
  await query(
    `INSERT INTO sessions (token_id, user_id, created_at, last_seen_at)
     VALUES ($1, $2, now(), now())`,
    [tokenId(token), user.id]
  );
  return token;
}

async function resolve(token) {
  if (!token) return null;
  const id = tokenId(token);

  const { rows } = await query(
    `SELECT s.user_id, s.created_at, s.last_seen_at, u.email, u.name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_id = $1`,
    [id]
  );
  const row = rows[0];
  if (!row) return null;

  const now = Date.now();
  if (
    now - row.last_seen_at.getTime() >= IDLE_TTL_MS ||
    now - row.created_at.getTime() >= ABSOLUTE_TTL_MS
  ) {
    await query('DELETE FROM sessions WHERE token_id = $1', [id]);
    return null;
  }

  // 滑动续期（节流）：超过窗口才写库
  if (now - row.last_seen_at.getTime() > config.auth.sessionTouchIntervalMs) {
    await query('UPDATE sessions SET last_seen_at = now() WHERE token_id = $1', [id]);
  }

  return {
    tokenId: id,
    userId: row.user_id,
    email: row.email,
    name: row.name,
    createdAt: row.created_at.getTime(),
    lastSeenAt: now
  };
}

async function destroy(token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_id = $1', [tokenId(token)]);
}

// 吊销某用户的全部会话（管理员重置密码/删除用户时调用，即刻踢下线）
async function destroyAllForUser(userId) {
  const { rowCount } = await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  return rowCount;
}

// 定期清扫过期会话（登录后存活，间隔 10 分钟）
function startSweeper() {
  const timer = setInterval(async () => {
    try {
      await query(
        `DELETE FROM sessions
          WHERE last_seen_at < now() - ($1::bigint || ' milliseconds')::interval
             OR created_at   < now() - ($2::bigint || ' milliseconds')::interval`,
        [IDLE_TTL_MS, ABSOLUTE_TTL_MS]
      );
    } catch (error) {
      console.error('[auth] 过期会话清扫失败:', error.message);
    }
  }, config.limits.sweepIntervalMs);
  timer.unref?.();
}

module.exports = { create, destroy, destroyAllForUser, resolve, startSweeper };
```

- [ ] **Step 5: 跑测试确认通过**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/sessionStore.test.js 2>&1 | tail -20"
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m 'sessionStore 迁移到 PostgreSQL，滑动续期加写库节流'"
```

---

### Task 4: quotaStore 迁移到 PostgreSQL

**Files:**
- Modify: `server/src/services/quotaStore.js`（整体替换，导出签名不变）
- Create: `server/test/quotaStore.test.js`

**Interfaces:**
- Consumes: `../db/pool` 的 `query` / `withTx`
- Produces: 导出签名与现在一致：
  `{ adjust, getRemaining, getRemainingMap, grant, grantMissing, release, removeUser, tryReserve }`
  - `tryReserve(userId, note) => Promise<{ok: boolean, remaining: number}>`
  - `release(userId, note) => Promise<number>`
  - `grant(userId, amount, note) => Promise<number>`
  - `adjust(userId, delta, note) => Promise<number>`
  - `getRemaining(userId) => Promise<number>`
  - `getRemainingMap(userIds) => Promise<Record<string, number>>`
  - `grantMissing(userIds, amount, note) => Promise<Array<{userId, amount}>>`
  - `removeUser(userId) => Promise<void>`

- [ ] **Step 1: 写失败测试**

Create `server/test/quotaStore.test.js`：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/quotaStore.test.js 2>&1 | tail -20"
```

Expected: FAIL —— 现有实现写 `quotas.json`，PG 中查不到余额。

- [ ] **Step 3: 重写 quotaStore**

整体替换 `server/src/services/quotaStore.js`：

```js
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
 *    判定与扣减，不再依赖「进程内 Map 读改写无 await 间隙」这个隐含前提
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

// 确保账户行存在（余额 0），返回当前余额
async function ensureAccount(client, userId) {
  const { rows } = await client.query(
    `INSERT INTO quota_accounts (user_id, remaining) VALUES ($1, 0)
     ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
     RETURNING remaining`,
    [userId]
  );
  return rows[0].remaining;
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

async function grant(userId, amount, note = '') {
  const value = Math.round(Number(amount) || 0);
  return withTx(async (client) => {
    await ensureAccount(client, userId);
    const { rows } = await client.query(
      `UPDATE quota_accounts SET remaining = remaining + $2, updated_at = now()
        WHERE user_id = $1 RETURNING remaining`,
      [userId, value]
    );
    const remaining = rows[0].remaining;
    await appendLedger(client, { userId, entryType: 'grant', amount: value, remaining, note });
    return remaining;
  });
}

/**
 * 预扣 1 次。余额足够则扣减并返回 { ok: true, remaining }；
 * 不足返回 { ok: false, remaining: 0 }（调用方据此跳过该文件）。
 *
 * 判定与扣减合并为一条带条件的 UPDATE：这是并发正确性的关键，
 * 不能拆成先 SELECT 再 UPDATE。
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
    await ensureAccount(client, userId);
    const { rows } = await client.query(
      `UPDATE quota_accounts SET remaining = remaining + 1, updated_at = now()
        WHERE user_id = $1 RETURNING remaining`,
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
    await ensureAccount(client, userId);
    // GREATEST(0, ...) 保证不为负；数据库层的 CHECK 是第二道防线
    const { rows } = await client.query(
      `UPDATE quota_accounts SET remaining = GREATEST(0, remaining + $2), updated_at = now()
        WHERE user_id = $1 RETURNING remaining`,
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/quotaStore.test.js 2>&1 | tail -25"
```

Expected: 全部 PASS，其中并发用例是重点。

- [ ] **Step 5: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m 'quotaStore 迁移到 PostgreSQL，预扣改为条件 UPDATE 原子扣减'"
```

---

### Task 5: 兑换码的生成与规范化

**Files:**
- Create: `server/src/services/redeemCode.js`
- Create: `server/test/redeemCode.test.js`

**Interfaces:**
- Consumes: 无（纯函数，不碰数据库）
- Produces:
  - `generate() => string`，返回**已规范化**的裸码，如 `9F3K2M7QX8BT4VZ`
  - `normalize(input) => string`，用户输入 → 规范化裸码；非法输入返回 `''`
  - `format(code) => string`，裸码 → 带连字符展示形式 `MD2PDF-9F3K2-M7QX8-BT4VZ`
  - `isValidCode(code) => boolean`

- [ ] **Step 1: 写失败测试**

Create `server/test/redeemCode.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { format, generate, isValidCode, normalize } = require('../src/services/redeemCode');

test('generate 产出 15 位裸码，字符集不含易混字符 I L O U', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generate();
    assert.equal(code.length, 15);
    assert.equal(normalize(code), code, 'generate 的输出本身应已规范化');
    assert.doesNotMatch(code, /[ILOU]/, '不得出现 I/L/O/U');
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]+$/);
  }
});

test('generate 大量生成不重复（15000 个）', () => {
  const seen = new Set();
  for (let i = 0; i < 15000; i += 1) seen.add(generate());
  assert.equal(seen.size, 15000, '15000 次生成不应出现任何碰撞');
});

test('normalize 容忍大小写、空格与连字符', () => {
  const code = generate();
  const withDashes = format(code);
  assert.equal(normalize(withDashes), code);
  assert.equal(normalize(withDashes.toLowerCase()), code);
  assert.equal(normalize(`  ${withDashes}  `), code);
  assert.equal(normalize(withDashes.replace(/-/g, ' ')), code);
  assert.equal(normalize('md2pdf 9f3k2 m7qx8 bt4vz'), normalize('MD2PDF-9F3K2-M7QX8-BT4VZ'));
});

test('normalize 做易混字符映射：O->0、I/L->1', () => {
  assert.equal(normalize('O'), '0');
  assert.equal(normalize('I'), '1');
  assert.equal(normalize('L'), '1');
  assert.equal(normalize('MD2PDF-OOOO0-IIIII-LLLL1'), 'MD2PDF-00000-11111-11111');
});

test('normalize 剥离 MD2PDF 前缀', () => {
  assert.equal(normalize('MD2PDF-9F3K2-M7QX8-BT4VZ'), '9F3K2M7QX8BT4VZ');
  assert.equal(normalize('MD2PDF9F3K2M7QX8BT4VZ'), '9F3K2M7QX8BT4VZ');
});

test('normalize 对非法输入返回空串', () => {
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize('!!!'), '');
  assert.equal(normalize('ABC'), '', '长度不足应返回空串');
  assert.equal(normalize('9F3K2M7QX8BT4VZX'), '', '长度超出应返回空串');
  assert.equal(normalize('9F3K2M7QX8BT4VZ@'), '', '含非法字符应返回空串');
});

test('isValidCode 只认真实规范的码', () => {
  assert.equal(isValidCode(generate()), true);
  assert.equal(isValidCode('MD2PDF-9F3K2-M7QX8-BT4VZ'), true);
  assert.equal(isValidCode('ABC'), false);
  assert.equal(isValidCode('9F3K2M7QX8BT4VZ@'), false);
  assert.equal(isValidCode(''), false);
});

test('format 输出 MD2PDF-XXXXX-XXXXX-XXXXX 形态', () => {
  assert.equal(format('9F3K2M7QX8BT4VZ'), 'MD2PDF-9F3K2-M7QX8-BT4VZ');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && node --test test/redeemCode.test.js 2>&1 | tail -10"
```

Expected: FAIL with `Cannot find module '../src/services/redeemCode'`。

- [ ] **Step 3: 实现 redeemCode.js**

Create `server/src/services/redeemCode.js`：

```js
const crypto = require('node:crypto');

/**
 * 兑换码的编码规则（纯函数，不碰数据库）
 *
 * 字符集采用 Crockford Base32 的裁剪版：A-Z 与 0-9 去掉 I L O U。
 * - 去掉 I/L/O 是因为手抄或口述时与 1/0 无法区分
 * - 去掉 U 是 Crockford 原始设计，避免出现脏话组合
 * 剩 32 个字符，恰为 5 bit/字符。
 *
 * 15 位随机字符 = 75 bit 熵（约 3.8×10^22 种），配合兑换限流，
 * 暴力枚举在实际时间内不可行。
 *
 * 展示形式为 MD2PDF-XXXXX-XXXXX-XXXXX，便于人工抄写与分段核对；
 * 数据库只存规范化后的裸码（大写、无连字符），保证查询与唯一索引的一致。
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // 32 字符，无 I L O U
const BODY_LENGTH = 15;
const GROUP_SIZE = 5;
const PREFIX = 'MD2PDF';

// 用户可能把 0 抄成 O、1 抄成 I 或 L，这里做容错映射
const CONFUSABLE_MAP = { O: '0', I: '1', L: '1' };

// 逐字符均匀取样：32 整除 256，直接用 % 取模不引入偏置
function randomBody() {
  const bytes = crypto.randomBytes(BODY_LENGTH);
  let out = '';
  for (let i = 0; i < BODY_LENGTH; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

function generate() {
  return randomBody();
}

/**
 * 用户输入 -> 规范化裸码。
 * 容忍大小写、空格、连字符、缺失或多余的 MD2PDF 前缀，
 * 以及 O/I/L 与 0/1 的混淆。任何无法规约到 15 位合法字符的输入返回空串。
 */
function normalize(input) {
  if (typeof input !== 'string') return '';

  let text = input.toUpperCase().replace(/[\s-]/g, '');
  if (text.startsWith(PREFIX)) text = text.slice(PREFIX.length);
  // 剥离后再清一次可能残留的分隔符
  text = text.replace(/[\s-]/g, '');
  if (!text) return '';

  let mapped = '';
  for (const char of text) {
    const resolved = CONFUSABLE_MAP[char] || char;
    if (!ALPHABET.includes(resolved)) return '';
    mapped += resolved;
  }

  return mapped.length === BODY_LENGTH ? mapped : '';
}

function format(code) {
  const bare = normalize(code);
  if (!bare) return '';
  const groups = [];
  for (let i = 0; i < bare.length; i += GROUP_SIZE) {
    groups.push(bare.slice(i, i + GROUP_SIZE));
  }
  return `${PREFIX}-${groups.join('-')}`;
}

function isValidCode(code) {
  return normalize(code) !== '';
}

module.exports = { ALPHABET, BODY_LENGTH, PREFIX, format, generate, isValidCode, normalize };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && node --test test/redeemCode.test.js 2>&1 | tail -15"
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m '兑换码编码规则：Crockford Base32、生成、规范化、易混字符容错'"
```

---

### Task 6: 兑换事务

**Files:**
- Create: `server/src/services/redeemStore.js`（本任务只实现 `redeem`，Task 7 补管理端函数）
- Create: `server/test/redeemStore.redeem.test.js`

**Interfaces:**
- Consumes: `../db/pool` 的 `query` / `withTx`；`./redeemCode` 的 `normalize`；`./quotaStore` 的 `appendLedger` 等价逻辑（本任务在 redeemStore 内自带一条，见下）
- Produces:
  - `redeem({ code, userId, ip }) => Promise<{ value: number, remaining: number, alreadyRedeemed: boolean }>`
    - 抛错时错误对象带 `statusCode`；`alreadyRedeemed` 分支为**成功返回**（不抛错）
  - 错误文案与 statusCode：
    - 格式非法/不存在 → 404 `兑换码不存在，请核对后重试`
    - 已作废 → 400 `该兑换码已被作废`
    - 已过期 → 400 `该兑换码已过期`
    - 已被他人使用 → 400 `该兑换码已被使用`

- [ ] **Step 1: 写失败测试**

Create `server/test/redeemStore.redeem.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, setupSchema, truncateAll, closePool, insertUser } = require('./helpers/db');
const redeemStore = require('../src/services/redeemStore');
const quotaStore = require('../src/services/quotaStore');
const { generate } = require('../src/services/redeemCode');

const UID = 'a1111111-1111-1111-1111-111111111111';
const UID2 = 'a2222222-2222-2222-2222-222222222222';

// 直接插码，绕开管理端生成逻辑，让本任务聚焦兑换事务
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

test('并发兑换同一个码：恰好 1 个成功，额度只增加一次', async () => {
  const code = generate();
  await insertCode({ code, value: 500 });

  const attempts = await Promise.allSettled(
    Array.from({ length: 10 }, () => redeemStore.redeem({ code, userId: UID }))
  );
  const ok = attempts.filter((a) => a.status === 'fulfilled');
  const failed = attempts.filter((a) => a.status === 'rejected');

  assert.equal(ok.length, 1, '恰好 1 次成功');
  assert.equal(failed.length, 9, '其余 9 次被拒绝');
  assert.equal(await quotaStore.getRemaining(UID), 500, '额度只增加一次，绝不双花');

  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM quota_ledger WHERE user_id = $1`, [UID]);
  assert.equal(rows[0].n, 1, '流水只有一条');
});

test('两个不同用户并发兑同一个码：只有一个拿到额度', async () => {
  const code = generate();
  await insertCode({ code, value: 80 });

  const results = await Promise.allSettled([
    redeemStore.redeem({ code, userId: UID }),
    redeemStore.redeem({ code, userId: UID2 })
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);

  const total = (await quotaStore.getRemaining(UID)) + (await quotaStore.getRemaining(UID2));
  assert.equal(total, 80, '两个账户的到账总和只能等于面额');
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

test('拒绝：不存在的码', async () => {
  await assert.rejects(
    () => redeemStore.redeem({ code: generate(), userId: UID }),
    (error) => error.statusCode === 404 && /不存在/.test(error.message)
  );
});

test('拒绝：格式非法的输入（不泄露「格式错」与「不存在」的差别）', async () => {
  await assert.rejects(
    () => redeemStore.redeem({ code: '!!!垃圾输入!!!', userId: UID }),
    (error) => error.statusCode === 404 && /不存在/.test(error.message)
  );
  await assert.rejects(
    () => redeemStore.redeem({ code: '', userId: UID }),
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
```

- [ ] **Step 2: 跑测试确认失败**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/redeemStore.redeem.test.js 2>&1 | tail -10"
```

Expected: FAIL with `Cannot find module '../src/services/redeemStore'`。

- [ ] **Step 3: 实现 redeemStore.redeem**

Create `server/src/services/redeemStore.js`：

```js
const crypto = require('node:crypto');

const { query, withTx } = require('../db/pool');
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
 * 格式非法与码不存在返回同一条文案，避免通过错误差异探测码是否存在。
 */
async function redeem({ code, userId, ip = null }) {
  const bare = normalize(code);
  if (!bare) fail('兑换码不存在，请核对后重试', 404);

  return withTx(async (client) => {
    const { rows } = await client.query(
      'SELECT * FROM redeem_codes WHERE code = $1 FOR UPDATE',
      [bare]
    );
    const row = rows[0];
    if (!row) fail('兑换码不存在，请核对后重试', 404);

    // 重复兑换：本人已兑过，幂等返回（必须在「已被使用」之前判断）
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

    // 到账。ON CONFLICT 兜底从未建立过账户行的用户
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
```

- [ ] **Step 4: 跑测试确认通过**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/redeemStore.redeem.test.js 2>&1 | tail -25"
```

Expected: 全部 PASS。其中「并发兑换同一个码」是核心用例。

- [ ] **Step 5: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m '兑换事务：行锁 + 单事务到账 + 重复兑换幂等返回'"
```

---

### Task 7: 兑换码管理端操作

**Files:**
- Modify: `server/src/services/redeemStore.js`（追加管理函数与导出）
- Create: `server/test/redeemStore.admin.test.js`

**Interfaces:**
- Consumes: Task 5 的 `redeemCode`，Task 6 的 redeemStore 内部
- Produces: `redeemStore` 增加导出：
  - `createBatch({ value, count, expiresAt = null, note = '', createdBy = null }) => Promise<{ batchId, codes: string[] }>`
    - `codes` 为**裸码**数组；`count` 超出 1..1000 抛 400；`value` 超出 1..100000 抛 400
  - `listCodes({ status = '', batchId = '', limit = 50, offset = 0 }) => Promise<{ total, codes: RedeemCodeRow[] }>`
    - `RedeemCodeRow = { id, code, value, batchId, status, createdAt, expiresAt, usedBy, usedAt, usedIp, revokedAt, note }`（时间字段为毫秒时间戳或 null）
  - `revoke({ ids = [], batchId = '', revokedBy = null }) => Promise<{ revoked: number }>`
  - `stats() => Promise<{ total, unused, used, revoked, expired, grantedTotal, batchCount }>`
  - `listForExport(batchId) => Promise<RedeemCodeRow[]>`

- [ ] **Step 1: 写失败测试**

Create `server/test/redeemStore.admin.test.js`：

```js
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

test('listCodes 返回的码带可用格式且时间字段为毫秒时间戳', async () => {
  const { codes } = await redeemStore.createBatch({ value: 10, count: 1 });
  const { codes: listed } = await redeemStore.listCodes({});
  assert.equal(listed[0].code, codes[0]);
  assert.equal(typeof listed[0].createdAt, 'number');
  assert.equal(listed[0].expiresAt, null);
  assert.equal(listed[0].usedAt, null);
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

  const expired = await redeemStore.createBatch({
    value: 7,
    count: 1,
    expiresAt: new Date(Date.now() - 60_000)
  });
  assert.ok(expired.batchId);

  const s = await redeemStore.stats();
  assert.equal(s.total, 8);
  assert.equal(s.used, 2);
  assert.equal(s.revoked, 2);
  assert.equal(s.unused, 3, '未使用的码里不含已过期那个');
  assert.equal(s.expired, 1);
  assert.equal(s.grantedTotal, 200, '已发放额度只统计已兑换的：2 × 100');
  assert.equal(s.batchCount, 3);
});

test('listForExport 按批次返回全部码', async () => {
  const { batchId } = await redeemStore.createBatch({ value: 10, count: 3 });
  const rows = await redeemStore.listForExport(batchId);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => normalize(r.code) === r.code));
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/redeemStore.admin.test.js 2>&1 | tail -10"
```

Expected: FAIL with `redeemStore.createBatch is not a function`。

- [ ] **Step 3: 追加管理端实现**

在 `server/src/services/redeemStore.js` 的 `redeem` 函数之后、`module.exports` 之前插入：

```js
// ---------- 行映射 ----------

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

// ---------- 管理端操作 ----------

const MAX_VALUE = 100_000;
const MAX_BATCH = 1000;

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
 * 唯一索引是碰撞的最终裁决者：INSERT 冲突时重试用新的随机码。
 * 75 bit 熵下碰撞概率可忽略，但这个重试让「理论上可能」变成「实际上不会失败」，
 * 也让将来调低熵时不会静默丢码。
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

async function listCodes({ status = '', batchId = '', limit = 50, offset = 0 } = {}) {
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

  const size = Math.min(Math.max(Number(limit) || 50, 1), 500);
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

// 作废：只对 unused 生效。已使用/已过期的码保持原状（历史不可篡改）
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
      count(*)::int                                                    AS total,
      count(*) FILTER (WHERE status = 'unused' AND (expires_at IS NULL OR expires_at > now()))::int AS unused,
      count(*) FILTER (WHERE status = 'unused' AND expires_at <= now())::int                        AS expired,
      count(*) FILTER (WHERE status = 'used')::int                     AS used,
      count(*) FILTER (WHERE status = 'revoked')::int                  AS revoked,
      COALESCE(sum(value) FILTER (WHERE status = 'used'), 0)::int      AS granted_total,
      count(DISTINCT batch_id)::int                                    AS batch_count
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

// 导出用：按批次返回全部码（无分页上限，导出是明确的批量动作）
async function listForExport(batchId) {
  const { rows } = await query(
    'SELECT * FROM redeem_codes WHERE batch_id = $1 ORDER BY created_at, code',
    [batchId]
  );
  return rows.map(rowToCode);
}
```

同时把文件顶部的引入改为：

```js
const { generate, normalize } = require('./redeemCode');
```

并把 `module.exports` 改为：

```js
module.exports = { createBatch, listCodes, listForExport, redeem, revoke, stats };
```

- [ ] **Step 4: 跑两个兑换测试文件确认全绿**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/redeemStore.redeem.test.js test/redeemStore.admin.test.js 2>&1 | tail -25"
```

Expected: 全部 PASS（Task 6 的用例也必须继续通过）。

- [ ] **Step 5: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m '兑换码管理端：批量生成、列表分页、批量作废、汇总统计、导出'"
```

---

### Task 8: 用户端兑换接口

**Files:**
- Create: `server/src/routes/redeem.js`
- Modify: `server/src/index.js`（挂载路由）
- Create: `server/test/redeem.route.test.js`

**Interfaces:**
- Consumes: `../services/redeemStore`、`../middleware/auth` 的 `requireAuth` / `sameOriginGuard`、`../services/quotaStore`
- Produces: `POST /api/redeem`，请求体 `{ code }`，成功响应
  `{ value, quotaRemaining, alreadyRedeemed, message }`；错误走统一错误处理，返回 `{ error }`

- [ ] **Step 1: 写失败测试**

Create `server/test/redeem.route.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { pool, setupSchema, truncateAll, closePool, insertUser } = require('./helpers/db');
const redeemStore = require('../src/services/redeemStore');

// 直接构造最小 Express 应用，只挂被测路由，避免拉起 Puppeteer 与调度器
const express = require('express');
const redeemRouter = require('../src/routes/redeem');

const USER = 'c1111111-1111-1111-1111-111111111111';

let app;
let server;
let baseUrl;

function buildApp() {
  const instance = express();
  instance.use(express.json());
  // 测试里不跑真实会话校验，改为直接注入 req.user
  instance.use((req, _res, next) => {
    req.user = { id: USER, email: 'route@example.com', name: 'R', isAdmin: false };
    next();
  });
  instance.use('/api/redeem', redeemRouter);
  // eslint-disable-next-line no-unused-vars
  instance.use((error, _req, res, _next) => {
    const status = error.statusCode || 500;
    res.status(status).json({ error: error.message });
  });
  return instance;
}

async function post(body, headers = {}) {
  const res = await fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

test.before(async () => {
  await setupSchema();
  app = buildApp();
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await truncateAll();
  await insertUser({ id: USER, email: 'route@example.com' });
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

test('兑换成功返回面额、新余额与提示文案', async () => {
  const { codes } = await redeemStore.createBatch({ value: 120, count: 1 });
  const res = await post({ code: codes[0] });
  assert.equal(res.status, 200);
  assert.equal(res.body.value, 120);
  assert.equal(res.body.quotaRemaining, 120);
  assert.equal(res.body.alreadyRedeemed, false);
  assert.match(res.body.message, /120/);
});

test('重复兑换返回 200 并标记 alreadyRedeemed', async () => {
  const { codes } = await redeemStore.createBatch({ value: 30, count: 1 });
  await post({ code: codes[0] });
  const res = await post({ code: codes[0] });
  assert.equal(res.status, 200);
  assert.equal(res.body.alreadyRedeemed, true);
  assert.equal(res.body.quotaRemaining, 30, '余额不因重复提交而增加');
});

test('不存在的码返回 404 与「不存在」文案', async () => {
  const res = await post({ code: 'MD2PDF-ZZZZZ-ZZZZZ-ZZZZZ' });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /不存在/);
});

test('缺少 code 字段返回 404 而非 500', async () => {
  const res = await post({});
  assert.equal(res.status, 404);
});

test('已作废的码返回 400', async () => {
  const { batchId, codes } = await redeemStore.createBatch({ value: 10, count: 1 });
  await redeemStore.revoke({ batchId });
  const res = await post({ code: codes[0] });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /作废/);
});

test('超过限流阈值后返回 429', async () => {
  const { codes } = await redeemStore.createBatch({ value: 10, count: 1 });
  const attempts = [];
  for (let i = 0; i < 12; i += 1) attempts.push(await post({ code: codes[0] }));

  const limited = attempts.filter((a) => a.status === 429);
  assert.ok(limited.length > 0, '超过每分钟上限后必须出现 429');
  assert.ok(limited[0].body.error.length > 0, '限流响应应带可读文案');
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/redeem.route.test.js 2>&1 | tail -10"
```

Expected: FAIL with `Cannot find module '../src/routes/redeem'`。

- [ ] **Step 3: 实现路由**

Create `server/src/routes/redeem.js`：

```js
const express = require('express');
const rateLimit = require('express-rate-limit');

const redeemStore = require('../services/redeemStore');
const { requireAuth, sameOriginGuard } = require('../middleware/auth');

const router = express.Router();

/**
 * 用户端兑换路由
 *
 * POST /api/redeem  { code } -> { value, quotaRemaining, alreadyRedeemed, message }
 *
 * 安全：
 * - requireAuth：必须登录，额度有明确的归属人
 * - sameOriginGuard：写操作防 CSRF，与其余写接口一致
 * - 双层限流：码空间有 75 bit 熵，暴力枚举不可行，限流是防脚本刷与
 *   防数据库泄露后有人拿码表来撞
 */

const redeemLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id || req.ip,
  message: { error: '兑换尝试过于频繁，请稍后再试。' }
});

router.use(requireAuth, sameOriginGuard, redeemLimiter);

router.post('/', async (req, res, next) => {
  try {
    const result = await redeemStore.redeem({
      code: req.body?.code,
      userId: req.user.id,
      ip: req.ip
    });

    res.json({
      value: result.value,
      quotaRemaining: result.remaining,
      alreadyRedeemed: result.alreadyRedeemed,
      message: result.alreadyRedeemed
        ? `这个兑换码你已经兑换过了，当时到账 ${result.value} 次额度`
        : `兑换成功，到账 ${result.value} 次额度`
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
```

在 `server/src/index.js` 中，`const adminRouter = require('./routes/admin');` 之后加：

```js
const redeemRouter = require('./routes/redeem');
```

并在 `app.use('/api/jobs', jobsRouter);` 之后加：

```js
// 用户端兑换码（requireAuth + 同源校验 + 限流在路由内部）
app.use('/api/redeem', redeemRouter);
```

- [ ] **Step 4: 跑测试确认通过**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/redeem.route.test.js 2>&1 | tail -20"
```

Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m '用户端兑换接口 POST /api/redeem（登录 + 同源 + 限流）'"
```

---

### Task 9: 管理端兑换码接口

**Files:**
- Modify: `server/src/routes/admin.js`
- Create: `server/test/admin.redeem.route.test.js`

**Interfaces:**
- Consumes: `../services/redeemStore`
- Produces: 挂在既有 `/api/admin` 之下
  - `POST /api/admin/redeem-codes` → `{ batchId, codes: string[], count }`（`codes` 为**展示格式** `MD2PDF-XXXXX-XXXXX-XXXXX`）
  - `GET /api/admin/redeem-codes?status=&batchId=&limit=&offset=` → `{ total, codes }`（`codes[].display` 为展示格式）
  - `POST /api/admin/redeem-codes/revoke` `{ ids?, batchId? }` → `{ revoked }`
  - `GET /api/admin/redeem-codes/export?batchId=` → `text/csv`，带 UTF-8 BOM
  - `GET /api/admin/redeem-stats` → stats 对象

- [ ] **Step 1: 写失败测试**

Create `server/test/admin.redeem.route.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSchema, truncateAll, closePool, insertUser } = require('./helpers/db');

const express = require('express');
const adminRouter = require('../src/routes/admin');

const ADMIN = 'd1111111-1111-1111-1111-111111111111';

let server;
let baseUrl;

// 用真实 admin 路由，但把鉴权替换为注入管理员身份：
// 本文件测的是兑换码的接口契约，鉴权链路由既有测试覆盖
function buildApp() {
  const instance = express();
  instance.use(express.json());
  instance.use((req, _res, next) => {
    req.user = { id: ADMIN, email: 'admin@example.com', name: 'A', isAdmin: true };
    next();
  });
  instance.use('/api/admin', adminRouter);
  // eslint-disable-next-line no-unused-vars
  instance.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.message });
  });
  return instance;
}

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  const type = res.headers.get('content-type') || '';
  return {
    status: res.status,
    body: type.includes('json') ? await res.json() : await res.text()
  };
}

test.before(async () => {
  await setupSchema();
  server = buildApp().listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await truncateAll();
  await insertUser({ id: ADMIN, email: 'admin@example.com', role: 'admin' });
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

test('生成兑换码返回展示格式的码列表', async () => {
  const res = await call('POST', '/api/admin/redeem-codes', { value: 100, count: 3, note: '批量' });
  assert.equal(res.status, 201);
  assert.equal(res.body.count, 3);
  assert.equal(res.body.codes.length, 3);
  assert.ok(res.body.batchId);
  assert.ok(
    res.body.codes.every((c) => /^MD2PDF-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(c)),
    '返回的码应为 MD2PDF-XXXXX-XXXXX-XXXXX 展示格式'
  );
});

test('生成参数非法返回 400', async () => {
  assert.equal((await call('POST', '/api/admin/redeem-codes', { value: 0, count: 1 })).status, 400);
  assert.equal((await call('POST', '/api/admin/redeem-codes', { value: 10, count: 9999 })).status, 400);
});

test('列表支持按批次筛选并带展示格式', async () => {
  const created = await call('POST', '/api/admin/redeem-codes', { value: 50, count: 4 });
  const res = await call('GET', `/api/admin/redeem-codes?batchId=${created.body.batchId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 4);
  assert.ok(res.body.codes.every((c) => c.display.startsWith('MD2PDF-')));
  assert.ok(res.body.codes.every((c) => c.status === 'unused'));
});

test('按批次作废', async () => {
  const created = await call('POST', '/api/admin/redeem-codes', { value: 50, count: 3 });
  const res = await call('POST', '/api/admin/redeem-codes/revoke', { batchId: created.body.batchId });
  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, 3);

  const after = await call('GET', `/api/admin/redeem-codes?status=revoked`);
  assert.equal(after.body.total, 3);
});

test('作废时不带参数返回 400', async () => {
  const res = await call('POST', '/api/admin/redeem-codes/revoke', {});
  assert.equal(res.status, 400);
});

test('导出 CSV 带 UTF-8 BOM，表头与行数正确', async () => {
  const created = await call('POST', '/api/admin/redeem-codes', { value: 80, count: 2, note: '导出批次' });
  const res = await call('GET', `/api/admin/redeem-codes/export?batchId=${created.body.batchId}`);

  assert.equal(res.status, 200);
  assert.ok(res.body.startsWith('﻿'), 'Excel 打开中文 CSV 需要 BOM');

  const lines = res.body.replace('﻿', '').trim().split('\r\n');
  assert.equal(lines.length, 3, '1 行表头 + 2 行数据');
  assert.match(lines[0], /兑换码/);
  assert.ok(lines[1].includes('MD2PDF-'));
});

test('统计接口返回各项汇总', async () => {
  await call('POST', '/api/admin/redeem-codes', { value: 10, count: 2 });
  const res = await call('GET', '/api/admin/redeem-stats');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.unused, 2);
  assert.equal(res.body.used, 0);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/admin.redeem.route.test.js 2>&1 | tail -12"
```

Expected: FAIL —— 路由不存在，`POST /api/admin/redeem-codes` 落到 `/api` 的通配 404 或返回 HTML。

- [ ] **Step 3: 实现管理端接口**

在 `server/src/routes/admin.js` 顶部引入区，`const quotaStore = require('../services/quotaStore');` 之后加：

```js
const redeemStore = require('../services/redeemStore');
const { format } = require('../services/redeemCode');
```

在文件末尾 `module.exports = router;` 之前插入：

```js
// ---------- 兑换码管理 ----------

// 码在库里存裸码，返回给管理端一律转成带连字符的展示格式，便于抄写与核对
function toDisplay(row) {
  return { ...row, display: format(row.code) };
}

router.get('/redeem-stats', async (_req, res, next) => {
  try {
    res.json(await redeemStore.stats());
  } catch (error) {
    next(error);
  }
});

router.post('/redeem-codes', async (req, res, next) => {
  try {
    const { value, count, expiresAt, note } = req.body || {};
    const parsedExpiry = expiresAt ? new Date(expiresAt) : null;
    if (parsedExpiry && Number.isNaN(parsedExpiry.getTime())) {
      res.status(400).json({ error: '截止时间格式不正确' });
      return;
    }

    const { batchId, codes } = await redeemStore.createBatch({
      value: Number(value),
      count: Number(count),
      expiresAt: parsedExpiry,
      note: typeof note === 'string' ? note.slice(0, 200) : '',
      createdBy: req.user.id
    });

    res.status(201).json({ batchId, count: codes.length, codes: codes.map(format) });
  } catch (error) {
    next(error);
  }
});

router.get('/redeem-codes', async (req, res, next) => {
  try {
    const { status, batchId, limit, offset } = req.query || {};
    const result = await redeemStore.listCodes({
      status: status || '',
      batchId: batchId || '',
      limit,
      offset
    });
    res.json({ total: result.total, codes: result.codes.map(toDisplay) });
  } catch (error) {
    next(error);
  }
});

router.post('/redeem-codes/revoke', async (req, res, next) => {
  try {
    const { ids, batchId } = req.body || {};
    const result = await redeemStore.revoke({
      ids: Array.isArray(ids) ? ids : [],
      batchId: typeof batchId === 'string' ? batchId : '',
      revokedBy: req.user.id
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
});

router.get('/redeem-codes/export', async (req, res, next) => {
  try {
    const batchId = req.query?.batchId || '';
    if (!batchId) {
      res.status(400).json({ error: '请指定要导出的批次' });
      return;
    }
    const rows = await redeemStore.listForExport(batchId);

    // Excel 打开 UTF-8 CSV 需要 BOM，否则中文表头变乱码
    const STATUS_LABEL = { unused: '未使用', used: '已使用', revoked: '已作废' };
    const header = ['兑换码', '面额', '状态', '生成时间', '截止时间', '兑付人', '兑付时间'];
    const lines = [header.join(',')];

    for (const row of rows) {
      lines.push(
        [
          format(row.code),
          row.value,
          STATUS_LABEL[row.status] || row.status,
          new Date(row.createdAt).toISOString(),
          row.expiresAt ? new Date(row.expiresAt).toISOString() : '永久',
          row.usedBy || '',
          row.usedAt ? new Date(row.usedAt).toISOString() : ''
        ].join(',')
      );
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="redeem-codes-${batchId}.csv"`);
    res.send(`﻿${lines.join('\r\n')}\r\n`);
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: 跑测试确认通过**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/admin.redeem.route.test.js 2>&1 | tail -20"
```

Expected: 全部 PASS。

- [ ] **Step 5: 跑全量测试确认无回归**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' npm test 2>&1 | tail -20"
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m '管理端兑换码接口：生成/列表/作废/导出 CSV/统计'"
```

---

### Task 10: JSON → PostgreSQL 数据导入脚本

**Files:**
- Create: `server/scripts/import-json.js`
- Create: `server/test/importJson.test.js`

**Interfaces:**
- Consumes: `../src/db/pool`、`../src/db/migrate`
- Produces:
  - `server/scripts/import-json.js` 可执行：`node scripts/import-json.js [--data-dir=路径] [--dry-run]`
    - 读 `users.json`（数组）、`quotas.json`（对象）、`quota-ledger.jsonl`（每行一条）
    - 导入后把原文件改名为 `<原名>.migrated`
    - 幂等：`ON CONFLICT DO NOTHING`
  - 为可测试，导出 `importFrom({ dataDir, dryRun }) => Promise<{users, quotas, ledger, skipped}>`

- [ ] **Step 1: 写失败测试**

Create `server/test/importJson.test.js`：

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { pool, setupSchema, truncateAll, closePool } = require('./helpers/db');
const { importFrom } = require('../scripts/import-json');

let dataDir;

// 用真实形状的样本：与线上 server/data/ 里的结构一致
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

const LEDGER = [
  { id: 'f1', time: '2026-09-01T00:00:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'grant', amount: 50, remaining: 50, note: '注册赠送' },
  { id: 'f2', time: '2026-09-01T00:01:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 49, note: 'job:1:a.md' },
  { id: 'f3', time: '2026-09-01T00:02:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'release', amount: 1, remaining: 50, note: '退回' },
  { id: 'f4', time: '2026-09-01T00:03:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 49, note: 'job:2:b.md' },
  { id: 'f5', time: '2026-09-01T00:04:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 48, note: 'job:3:c.md' },
  { id: 'f6', time: '2026-09-01T00:05:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 47, note: 'job:4:d.md' },
  { id: 'f7', time: '2026-09-01T00:06:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 46, note: 'job:5:e.md' },
  { id: 'f8', time: '2026-09-01T00:07:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 45, note: 'job:6:f.md' },
  { id: 'f9', time: '2026-09-01T00:08:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 44, note: 'job:7:g.md' },
  { id: 'f10', time: '2026-09-01T00:09:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 43, note: 'job:8:h.md' },
  { id: 'f11', time: '2026-09-01T00:10:00.000Z', userId: 'e1111111-1111-1111-1111-111111111111', type: 'reserve', amount: 1, remaining: 42, note: 'job:9:i.md' },
  { id: 'f12', time: '2026-09-01T00:11:00.000Z', userId: 'e2222222-2222-2222-2222-222222222222', type: 'grant', amount: 7, remaining: 7, note: '注册赠送' }
];

async function writeFixtures() {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'md2pdf-import-'));
  await fs.writeFile(path.join(dataDir, 'users.json'), JSON.stringify(USERS, null, 2));
  await fs.writeFile(path.join(dataDir, 'quotas.json'), JSON.stringify(QUOTAS, null, 2));
  await fs.writeFile(path.join(dataDir, 'quota-ledger.jsonl'), `${LEDGER.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

test.before(async () => {
  await setupSchema();
});
test.beforeEach(async () => {
  await truncateAll();
  await writeFixtures();
});
test.after(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await closePool();
});

test('导入用户、余额与流水，条数逐条吻合', async () => {
  const result = await importFrom({ dataDir });
  assert.equal(result.users, 2);
  assert.equal(result.quotas, 2);
  assert.equal(result.ledger, 12);

  const users = (await pool.query('SELECT * FROM users ORDER BY email')).rows;
  assert.equal(users.length, 2);
  assert.equal(users[1].email, 'one@example.com');
  assert.equal(users[1].name, '甲');
  assert.equal(users[1].role, 'admin');
  assert.equal(users[1].created_at.getTime(), 1756700000000, 'createdAt 毫秒时间戳应无损还原');
  assert.match(users[1].password_hash, /^scrypt\$/, '密码哈希原样搬运，用户无需改密码');

  const accounts = (await pool.query('SELECT * FROM quota_accounts ORDER BY user_id')).rows;
  assert.equal(accounts.length, 2);
  assert.equal(
    accounts.find((a) => a.user_id === 'e1111111-1111-1111-1111-111111111111').remaining,
    42
  );

  const ledger = (await pool.query('SELECT * FROM quota_ledger')).rows;
  assert.equal(ledger.length, 12);
});

test('导入后余额与最后一条流水快照一致（对账）', async () => {
  await importFrom({ dataDir });
  const { rows } = await pool.query(`
    SELECT a.user_id, a.remaining,
           (SELECT l.remaining FROM quota_ledger l
             WHERE l.user_id = a.user_id ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS last_snapshot
      FROM quota_accounts a
  `);
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.equal(row.remaining, row.last_snapshot, `用户 ${row.user_id} 的余额与流水快照不一致`);
  }
});

test('导入是幂等的：重复执行不产生重复数据', async () => {
  await importFrom({ dataDir });
  await importFrom({ dataDir: dataDir.replace(/.*/, dataDir), force: true });

  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM quota_accounts')).rows[0].n, 2);
});

test('导入成功后原文件被改名为 .migrated 保留', async () => {
  await importFrom({ dataDir });
  const entries = await fs.readdir(dataDir);
  assert.ok(entries.includes('users.json.migrated'));
  assert.ok(entries.includes('quotas.json.migrated'));
  assert.ok(entries.includes('quota-ledger.jsonl.migrated'));
  assert.ok(!entries.includes('users.json'), '原文件应已改名');
});

test('dry-run 不写库也不改文件名', async () => {
  const result = await importFrom({ dataDir, dryRun: true });
  assert.equal(result.users, 2);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 0);

  const entries = await fs.readdir(dataDir);
  assert.ok(entries.includes('users.json'), 'dry-run 不得移动原文件');
});

test('数据目录不存在时抛错而不是静默跳过', async () => {
  await assert.rejects(() => importFrom({ dataDir: path.join(dataDir, 'nope') }), /不存在/);
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/importJson.test.js 2>&1 | tail -10"
```

Expected: FAIL with `Cannot find module '../scripts/import-json'`。

- [ ] **Step 3: 实现导入脚本**

Create `server/scripts/import-json.js`：

```js
#!/usr/bin/env node
/**
 * 一次性数据导入：JSON 文件 -> PostgreSQL
 *
 * 迁移前的数据落在 server/data/ 下三个文件：
 * - users.json        用户数组
 * - quotas.json       { userId: remaining } 余额表
 * - quota-ledger.jsonl 每行一条流水
 *
 * 设计要点：
 * - 幂等：全部走 ON CONFLICT DO NOTHING，重复执行不会产生重复数据
 * - 保真：密码哈希原样搬运（用户无需改密），createdAt 毫秒时间戳无损还原
 * - 可回退：导入成功后把原文件改名为 .migrated 保留而非删除，
 *   出问题时可连同代码一起回退到文件存储
 * - dry-run：只统计不写库、不改名，用于上线前预演
 *
 * 用法：
 *   MD2PDF_DATABASE_URL=postgres://... node scripts/import-json.js [--data-dir=路径] [--dry-run]
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { pool } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');

function parseArgs(argv) {
  const options = { dataDir: null, dryRun: false, force: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
  }
  return options;
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`读取 ${file} 失败: ${error.message}`);
  }
}

async function readJsonlIfExists(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null; // 半截行（进程崩溃时可能留下）跳过，不让一条坏数据阻断整个迁移
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`读取 ${file} 失败: ${error.message}`);
  }
}

async function importFrom({ dataDir, dryRun = false }) {
  if (!dataDir) throw new Error('未指定数据目录');

  try {
    const stat = await fs.stat(dataDir);
    if (!stat.isDirectory()) throw new Error('不是目录');
  } catch {
    throw new Error(`数据目录不存在: ${dataDir}`);
  }

  const users = (await readJsonIfExists(path.join(dataDir, 'users.json'))) || [];
  const quotas = (await readJsonIfExists(path.join(dataDir, 'quotas.json'))) || {};
  const ledger = await readJsonlIfExists(path.join(dataDir, 'quota-ledger.jsonl'));

  const summary = { users: users.length, quotas: 0, ledger: ledger.length, skipped: 0 };

  if (dryRun) return summary;

  await migrate();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const user of users) {
      const { rowCount } = await client.query(
        `INSERT INTO users (id, email, name, password_hash, role, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          user.id,
          String(user.email).trim().toLowerCase(),
          user.name || String(user.email).split('@')[0],
          user.passwordHash,
          user.role === 'admin' ? 'admin' : 'user',
          new Date(user.createdAt || Date.now())
        ]
      );
      if (!rowCount) summary.skipped += 1;
    }

    for (const [userId, remaining] of Object.entries(quotas)) {
      const { rowCount } = await client.query(
        `INSERT INTO quota_accounts (user_id, remaining) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, Math.max(0, Math.round(Number(remaining) || 0))]
      );
      if (rowCount) summary.quotas += 1;
    }

    const TYPE_MAP = { grant: 'grant', reserve: 'reserve', release: 'release', revoke: 'revoke' };
    for (const entry of ledger) {
      const entryType = TYPE_MAP[entry.type] || 'grant';
      await client.query(
        `INSERT INTO quota_ledger
           (id, user_id, entry_type, amount, remaining, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          entry.id,
          entry.userId,
          entryType,
          Math.max(0, Math.round(Number(entry.amount) || 0)),
          Math.max(0, Math.round(Number(entry.remaining) || 0)),
          entry.note || '',
          new Date(entry.time || Date.now())
        ]
      );
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // 落库成功后才改名：先改名后失败会既丢原文件又没进库
  for (const name of ['users.json', 'quotas.json', 'quota-ledger.jsonl']) {
    const from = path.join(dataDir, name);
    try {
      await fs.rename(from, `${from}.migrated`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = options.dataDir || path.resolve(__dirname, '..', 'data');

  console.log(`[import] 数据目录: ${dataDir}${options.dryRun ? '（dry-run，不写库）' : ''}`);
  const summary = await importFrom({ dataDir, dryRun: options.dryRun });
  console.log(
    `[import] 用户 ${summary.users} 条，余额 ${summary.quotas} 条，流水 ${summary.ledger} 条` +
      (summary.skipped ? `，跳过已存在用户 ${summary.skipped} 条` : '')
  );
  if (!options.dryRun) console.log('[import] 完成，原文件已改名为 .migrated 保留');
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error('[import] 失败:', error.message);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { importFrom };
```

- [ ] **Step 4: 跑测试确认通过**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node --test test/importJson.test.js 2>&1 | tail -20"
```

Expected: 全部 PASS。

- [ ] **Step 5: 用真实线上数据做 dry-run 预演**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' node scripts/import-json.js --data-dir=./data --dry-run"
```

Expected: 打印真实的用户/余额/流水条数，且**不修改 `server/data/` 下任何文件**（这是 dry-run 的意义）。记录下条数，Task 13 上线时用于比对。

- [ ] **Step 6: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m 'JSON 到 PostgreSQL 数据导入脚本（幂等、保真、可回退）'"
```

---

### Task 11: 前端 —— 用户兑换入口

**Files:**
- Modify: `web/src/api.js`（加 `redeemCode`）
- Modify: `web/src/components/UserBadge.vue`（加兑换按钮与弹窗）
- Modify: `web/src/App.vue`（处理兑换成功后的余额同步）
- Modify: `web/src/components/AppDialog.vue`（仅在需要新 prop 时）

**Interfaces:**
- Consumes: `POST /api/redeem`（Task 8）
- Produces:
  - `api.js` 导出 `redeemCode(code) => Promise<{value, quotaRemaining, alreadyRedeemed, message}>`
  - `UserBadge` 新增 emit `redeemed`，载荷为新余额（number）

- [ ] **Step 1: 加 API 函数**

在 `web/src/api.js` 末尾追加：

```js
// 兑换码：兑换成功后返回新余额，交由父组件同步到 UserBadge 与 Workbench
export function redeemCode(code) {
  return request('/api/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code })
  })
}
```

- [ ] **Step 2: 改 UserBadge**

在 `web/src/components/UserBadge.vue` 的 `<script setup>` 中：

把 `import` 区补上 API 与弹窗组件：

```js
import { ref, computed } from 'vue'
import { redeemCode } from '../api'
import AppDialog from './AppDialog.vue'
```

`defineEmits` 改为：

```js
const emit = defineEmits(['logout', 'open-admin', 'redeemed'])
```

新增状态与提交逻辑：

```js
// ---- 兑换码 ----
const showRedeem = ref(false)
const redeemInput = ref('')
const redeemBusy = ref(false)
const redeemError = ref('')
const redeemSuccess = ref('')

function openRedeem() {
  redeemInput.value = ''
  redeemError.value = ''
  redeemSuccess.value = ''
  showRedeem.value = true
}

async function submitRedeem() {
  const code = redeemInput.value.trim()
  if (!code) {
    redeemError.value = '请输入兑换码'
    return
  }
  redeemBusy.value = true
  redeemError.value = ''
  redeemSuccess.value = ''
  try {
    const result = await redeemCode(code)
    redeemSuccess.value = result.message
    redeemInput.value = ''
    // 余额变化交给父组件统一同步到 UserBadge 与 Workbench
    emit('redeemed', result.quotaRemaining)
  } catch (e) {
    redeemError.value = e.message
  } finally {
    redeemBusy.value = false
  }
}
```

在模板中，紧邻现有的 `admin-btn` 按钮之前插入兑换入口：

```html
    <button class="redeem-btn" title="输入兑换码充值额度" @click="openRedeem">兑换</button>
```

在模板最外层容器内、文件末尾追加弹窗：

```html
  <AppDialog v-if="showRedeem" title="兑换额度" @close="showRedeem = false">
    <p class="redeem-hint">输入你的兑换码，额度将立即到账。</p>
    <input
      v-model="redeemInput"
      class="redeem-input"
      type="text"
      placeholder="MD2PDF-XXXXX-XXXXX-XXXXX"
      autocomplete="off"
      spellcheck="false"
      :disabled="redeemBusy"
      @keyup.enter="submitRedeem"
    />
    <p v-if="redeemError" class="redeem-error">{{ redeemError }}</p>
    <p v-if="redeemSuccess" class="redeem-success">{{ redeemSuccess }}</p>
    <template #footer>
      <button class="redeem-cancel" :disabled="redeemBusy" @click="showRedeem = false">关闭</button>
      <button class="redeem-submit" :disabled="redeemBusy" @click="submitRedeem">
        {{ redeemBusy ? '兑换中…' : '确认兑换' }}
      </button>
    </template>
  </AppDialog>
```

在 `<style scoped>` 末尾追加样式（沿用既有变量）：

```css
.redeem-btn {
  border: none;
  background: var(--accent-soft);
  color: var(--accent-dark);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  flex-shrink: 0;
}

.redeem-btn:hover {
  background: var(--accent);
  color: #fff;
}

.redeem-hint {
  margin: 0 0 10px;
  font-size: 13px;
  color: var(--ink-soft);
}

.redeem-input {
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  font-size: 15px;
  letter-spacing: 0.06em;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-transform: uppercase;
}

.redeem-input:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.redeem-error {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--err);
}

.redeem-success {
  margin: 10px 0 0;
  font-size: 13px;
  color: var(--ok, #15803d);
  font-weight: 600;
}

.redeem-cancel,
.redeem-submit {
  border: none;
  border-radius: 10px;
  padding: 9px 16px;
  font-size: 13.5px;
  font-weight: 600;
  cursor: pointer;
}

.redeem-cancel {
  background: #f1f5f9;
  color: var(--ink-soft);
}

.redeem-submit {
  background: var(--accent);
  color: #fff;
}

.redeem-submit:disabled,
.redeem-cancel:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
```

**注意**：`AppDialog` 的插槽名称（默认插槽 + `footer`）与 `close` 事件需与既有实现一致。先读 `web/src/components/AppDialog.vue` 确认；若它用的是 `props.title` + 默认插槽 + `@close`，上述代码可直接用；若插槽名不同（如 `#actions`），按实际名称调整。

- [ ] **Step 3: 在 App.vue 接线**

在 `web/src/App.vue` 中，`<UserBadge ...>` 处加事件监听：

```html
        <UserBadge
          :user="user"
          :quota="remainingQuota"
          @logout="onLogout"
          @open-admin="showAdmin = true"
          @redeemed="onRedeemed"
        />
```

并在 `<script setup>` 中新增：

```js
// 兑换成功后后端返回权威余额，直接覆盖本地值即可，
// 无需再拉一次 /api/auth/me（少一次往返，且避免竞态）
function onRedeemed(newRemaining) {
  remainingQuota.value = newRemaining
}
```

- [ ] **Step 4: 构建前端确认无语法错误**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/web && npm run build 2>&1 | tail -15"
```

Expected: 构建成功，无 Vue 编译错误。

- [ ] **Step 5: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m '前端：用户兑换入口（UserBadge 兑换按钮 + 弹窗 + 余额同步）'"
```

---

### Task 12: 前端 —— 管理后台兑换码页签

**Files:**
- Modify: `web/src/api.js`（5 个管理端函数）
- Modify: `web/src/components/AdminView.vue`（第 4 个页签）

**Interfaces:**
- Consumes: Task 9 的 5 个管理端接口
- Produces: `api.js` 导出
  - `adminRedeemStats()`
  - `adminCreateRedeemCodes({value, count, expiresAt, note})`
  - `adminListRedeemCodes({status, batchId, limit, offset})`
  - `adminRevokeRedeemCodes({ids, batchId})`
  - `adminExportRedeemCodes(batchId)` → 返回 CSV 文本

- [ ] **Step 1: 加 API 函数**

在 `web/src/api.js` 末尾追加：

```js
// ---- 管理端：兑换码 ----

export function adminRedeemStats() {
  return request('/api/admin/redeem-stats')
}

export function adminCreateRedeemCodes({ value, count, expiresAt, note }) {
  return request('/api/admin/redeem-codes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value, count, expiresAt, note })
  })
}

export function adminListRedeemCodes({ status = '', batchId = '', limit = 100, offset = 0 } = {}) {
  const params = new URLSearchParams()
  if (status) params.set('status', status)
  if (batchId) params.set('batchId', batchId)
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  return request(`/api/admin/redeem-codes?${params}`)
}

export function adminRevokeRedeemCodes({ ids, batchId }) {
  return request('/api/admin/redeem-codes/revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, batchId })
  })
}

// 导出走原生下载：CSV 含 BOM 且文件名由后端决定，用 fetch 拿文本会丢掉这些
export function redeemExportUrl(batchId) {
  return `/api/admin/redeem-codes/export?batchId=${encodeURIComponent(batchId)}`
}
```

- [ ] **Step 2: 在 AdminView 加页签**

在 `web/src/components/AdminView.vue` 中：

`import` 区补上新增的 API：

```js
import {
  adminStats, adminListUsers, adminCreateUser, adminSetRole, adminAdjustQuota,
  adminResetPassword, adminDeleteUser, adminListJobs, adminCancelJob, adminDeleteJob,
  adminRedeemStats, adminCreateRedeemCodes, adminListRedeemCodes,
  adminRevokeRedeemCodes, redeemExportUrl
} from '../api'
```

（保留文件中已有的引入项，把它们合并到同一条 import 语句里。）

状态：

```js
// ---- 兑换码 ----
const redeemStats = ref(null)
const redeemCodes = ref([])
const redeemTotal = ref(0)
const redeemStatusFilter = ref('')
const redeemBatchFilter = ref('')
const redeemForm = ref({ value: 100, count: 10, expiresAt: '', note: '' })
const generatedCodes = ref([])
const generatedBatchId = ref('')
const copyHint = ref('')
```

把 `tab` 的注释与取值范围扩展为 `'overview' | 'users' | 'jobs' | 'redeem'`。

数据加载：在 `refreshAll()` 里追加

```js
    redeemStats.value = await adminRedeemStats()
```

（若 `refreshAll` 用的是 `Promise.all`，把 `adminRedeemStats()` 加进数组并解构。）

新增函数：

```js
async function loadRedeemCodes() {
  const result = await adminListRedeemCodes({
    status: redeemStatusFilter.value,
    batchId: redeemBatchFilter.value
  })
  redeemCodes.value = result.codes
  redeemTotal.value = result.total
}

async function submitGenerateCodes() {
  dialogBusy.value = true
  dialogError.value = ''
  try {
    const result = await adminCreateRedeemCodes({
      value: Number(redeemForm.value.value),
      count: Number(redeemForm.value.count),
      expiresAt: redeemForm.value.expiresAt || null,
      note: redeemForm.value.note
    })
    generatedCodes.value = result.codes
    generatedBatchId.value = result.batchId
    dialog.value = 'generatedCodes'
    redeemStats.value = await adminRedeemStats()
    await loadRedeemCodes()
  } catch (e) {
    dialogError.value = e.message
  } finally {
    dialogBusy.value = false
  }
}

async function copyGeneratedCodes() {
  try {
    await navigator.clipboard.writeText(generatedCodes.value.join('\n'))
    copyHint.value = `已复制 ${generatedCodes.value.length} 个兑换码`
  } catch {
    copyHint.value = '复制失败，请手动全选复制'
  }
  setTimeout(() => { copyHint.value = '' }, 2500)
}

function downloadGeneratedCodes() {
  window.location.href = redeemExportUrl(generatedBatchId.value)
}

async function revokeBatch(batchId) {
  if (!window.confirm('确认作废该批次的全部未使用兑换码？此操作不可撤销。')) return
  await adminRevokeRedeemCodes({ batchId })
  redeemStats.value = await adminRedeemStats()
  await loadRedeemCodes()
}

async function revokeOne(code) {
  if (!window.confirm('确认作废这个兑换码？')) return
  await adminRevokeRedeemCodes({ ids: [code.id] })
  redeemStats.value = await adminRedeemStats()
  await loadRedeemCodes()
}

const REDEEM_STATUS = {
  unused: ['未使用', 'ok'],
  used: ['已使用', 'muted'],
  revoked: ['已作废', 'err']
}

function redeemStatusLabel(s) { return (REDEEM_STATUS[s] || [s, ''])[0] }
function redeemStatusClass(s) { return (REDEEM_STATUS[s] || ['', ''])[1] }
```

模板部分：在页签栏加第 4 项（沿用既有页签按钮写法）：

```html
      <button :class="{ active: tab === 'redeem' }" @click="tab = 'redeem'; loadRedeemCodes()">兑换码</button>
```

并在内容区加对应分支：

```html
    <section v-if="tab === 'redeem'" class="redeem-pane">
      <div v-if="redeemStats" class="redeem-stats">
        <span>总计 <b>{{ redeemStats.total }}</b></span>
        <span>未使用 <b>{{ redeemStats.unused }}</b></span>
        <span>已使用 <b>{{ redeemStats.used }}</b></span>
        <span>已作废 <b>{{ redeemStats.revoked }}</b></span>
        <span>已过期 <b>{{ redeemStats.expired }}</b></span>
        <span>已发放额度 <b>{{ redeemStats.grantedTotal }}</b></span>
      </div>

      <div class="redeem-actions">
        <button class="primary" @click="dialog = 'generateCodes'; dialogError = ''">生成兑换码</button>
        <select v-model="redeemStatusFilter" @change="loadRedeemCodes">
          <option value="">全部状态</option>
          <option value="unused">未使用</option>
          <option value="used">已使用</option>
          <option value="revoked">已作废</option>
        </select>
        <button v-if="redeemBatchFilter" @click="revokeBatch(redeemBatchFilter)">作废当前批次</button>
      </div>

      <table class="redeem-table">
        <thead>
          <tr>
            <th>兑换码</th><th>面额</th><th>状态</th><th>生成时间</th><th>兑付人</th><th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in redeemCodes" :key="c.id">
            <td class="mono">{{ c.display }}</td>
            <td>{{ c.value }}</td>
            <td><span :class="redeemStatusClass(c.status)">{{ redeemStatusLabel(c.status) }}</span></td>
            <td>{{ fmtTime(c.createdAt) }}</td>
            <td>{{ ownerLabel({ userId: c.usedBy }) }}</td>
            <td>
              <button v-if="c.status === 'unused'" class="danger" @click="revokeOne(c)">作废</button>
            </td>
          </tr>
        </tbody>
      </table>
      <p v-if="!redeemCodes.length" class="empty">暂无兑换码</p>
    </section>
```

对话框（沿用既有 dialog 结构）：生成表单与生成结果两个。生成结果对话框的 `footer` 放「复制全部」「下载 CSV」：

```html
  <AppDialog v-if="dialog === 'generateCodes'" title="生成兑换码" @close="dialog = null">
    <label>每个码的面额<input v-model.number="redeemForm.value" type="number" min="1" max="100000" /></label>
    <label>生成数量<input v-model.number="redeemForm.count" type="number" min="1" max="1000" /></label>
    <label>截止时间（留空为永久）<input v-model="redeemForm.expiresAt" type="datetime-local" /></label>
    <label>备注<input v-model="redeemForm.note" type="text" maxlength="200" /></label>
    <p v-if="dialogError" class="err">{{ dialogError }}</p>
    <template #footer>
      <button :disabled="dialogBusy" @click="dialog = null">取消</button>
      <button class="primary" :disabled="dialogBusy" @click="submitGenerateCodes">
        {{ dialogBusy ? '生成中…' : '生成' }}
      </button>
    </template>
  </AppDialog>

  <AppDialog v-if="dialog === 'generatedCodes'" title="兑换码已生成" @close="dialog = null">
    <p>本批共 {{ generatedCodes.length }} 个，每个面额 {{ redeemForm.value }}。请及时复制或下载保存。</p>
    <textarea class="codes" readonly :value="generatedCodes.join('\n')" rows="10" />
    <p v-if="copyHint" class="hint">{{ copyHint }}</p>
    <template #footer>
      <button @click="downloadGeneratedCodes">下载 CSV</button>
      <button class="primary" @click="copyGeneratedCodes">复制全部</button>
    </template>
  </AppDialog>
```

样式（追加到 `<style scoped>`）：

```css
.redeem-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 13px;
  color: var(--ink-soft);
  margin-bottom: 14px;
}

.redeem-stats b {
  color: var(--ink);
}

.redeem-actions {
  display: flex;
  gap: 10px;
  align-items: center;
  margin-bottom: 16px;
}

.redeem-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.redeem-table th,
.redeem-table td {
  text-align: left;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.04em;
}

.codes {
  width: 100%;
  box-sizing: border-box;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  resize: vertical;
}

.empty {
  text-align: center;
  color: var(--ink-soft);
  font-size: 13px;
  padding: 24px 0;
}
```

**注意**：`AppDialog` 的插槽名、既有页签按钮的 class 与选中态写法、`fmtTime` / `ownerLabel` 的签名，都以文件里的实际实现为准；上面给出的是接入点，不是替换。

- [ ] **Step 3: 构建前端确认无语法错误**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/web && npm run build 2>&1 | tail -15"
```

Expected: 构建成功。

- [ ] **Step 4: 提交**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m '前端：管理后台兑换码页签（生成/列表/作废/导出）'"
```

---

### Task 13: 上线部署与验收

**Files:**
- Modify: `/etc/systemd/system/md2pdf-backend.service`（加 `MD2PDF_DATABASE_URL`）
- Create: `deploy/POSTGRES-MIGRATION.md`（运维记录）

**Interfaces:**
- Consumes: 前面全部任务的产物
- Produces: 线上运行 PostgreSQL 版本的 MD2PDFWeb

- [ ] **Step 1: 备份现有数据**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && tar czf /root/md2pdf-data-backup-\$(date +%Y%m%d-%H%M%S).tar.gz data/ && ls -la /root/md2pdf-data-backup-*.tar.gz"
```

Expected: 生成一个备份 tar.gz。**记下文件名**，回退时要用。

- [ ] **Step 2: 创建生产库并跑迁移**

```bash
ssh md2pdf "sudo -u postgres psql -c \"CREATE DATABASE md2pdf OWNER md2pdf\" 2>&1 | head -2; \
cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf' node -e \"require('./src/db/migrate').migrate().then(r=>{console.log('applied:',r.applied);process.exit(0)})\""
```

Expected: `applied: [ '0001_init.sql' ]`。

- [ ] **Step 3: 导入数据并校验**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf' node scripts/import-json.js --data-dir=./data"
```

把输出的条数与 Task 10 Step 5 的 dry-run 数比对，必须一致。

再用 SQL 独立核对：

```bash
ssh md2pdf "PGPASSWORD=md2pdf psql -h 127.0.0.1 -U md2pdf -d md2pdf -c \"
  SELECT u.email, u.role, a.remaining,
         (SELECT l.remaining FROM quota_ledger l WHERE l.user_id=u.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS last_snapshot
    FROM users u LEFT JOIN quota_accounts a ON a.user_id=u.id ORDER BY u.created_at;\""
```

Expected: 每个用户的 `remaining` 等于 `last_snapshot`。若不等，停止上线并排查。

- [ ] **Step 4: 配置 systemd 并重启**

```bash
ssh md2pdf "systemctl edit --full md2pdf-backend" 
```

在 `Environment=MD2PDF_MAIL_FROM=...` 之后加一行（注意 systemd 里 `%` 需转义，本连接串无 `%`）：

```
# 账号/额度/会话的权威存储。数据库不可用时后端拒绝启动，不降级回文件存储
Environment=MD2PDF_DATABASE_URL=postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf
```

```bash
ssh md2pdf "systemctl daemon-reload && systemctl restart md2pdf-backend && sleep 3 && systemctl is-active md2pdf-backend && journalctl -u md2pdf-backend -n 30 --no-pager | tail -20"
```

Expected: `active`，日志中有「后端已启动」且无 PG 报错。

- [ ] **Step 5: 冒烟测试**

```bash
ssh md2pdf "
curl -s -o /dev/null -w 'health=%{http_code}\n' http://127.0.0.1:8002/api/health
curl -s http://127.0.0.1:8002/api/health
echo
" && timeout 20 curl -s -o /dev/null -w 'frontend=%{http_code}\n' https://md2pdf.qiangi.top/
```

浏览器侧验证（用 wmux browser，用户可实时观看）：

```bash
wmux browser open https://md2pdf.qiangi.top/
wmux browser snapshot
```

逐项确认：
1. 未登录访问被引导到登录页
2. 用管理员账号登录成功，`UserBadge` 显示「剩余 N 个文件」且与数据库一致
3. 管理员入口进入后台，第四个页签「兑换码」存在
4. 生成 3 个面额 10 的码，复制其中一个
5. 退出登录，用一个普通用户账号登录
6. 点「兑换」粘贴码 → 提示「兑换成功，到账 10 次额度」，余额 +10
7. 再兑一次同一个码 → 提示「这个兑换码你已经兑换过了」
8. 管理后台可见该码状态为「已使用」且记录了兑付人

- [ ] **Step 6: 写运维记录并提交**

Create `deploy/POSTGRES-MIGRATION.md`：

```markdown
# 上线记录：迁移到 PostgreSQL

## 变更

- 账号、会话、额度、兑换码由 `server/data/*.json` 迁移到 PostgreSQL 库 `md2pdf`
- 新增兑换码功能（管理员生成 / 用户兑换）
- 后端启动依赖 `MD2PDF_DATABASE_URL`，数据库不可用时拒绝启动

## 回退步骤

1. `systemctl stop md2pdf-backend`
2. 代码回退：`git checkout <迁移前最后一个提交>`
3. 恢复数据：`cd /root/MD2PDFWeb/server && tar xzf /root/md2pdf-data-backup-<时间戳>.tar.gz`
4. 从 systemd unit 移除 `Environment=MD2PDF_DATABASE_URL=...`
5. `systemctl daemon-reload && systemctl start md2pdf-backend`

数据库 `md2pdf` 可保留不删，回退后不影响运行。
```

把实际的时间戳备份文件名、执行时间、校验结果填进去，然后：

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git add -A && git commit -q -m '上线记录：PostgreSQL 迁移与兑换码上线'"
```

- [ ] **Step 7: 全量回归测试**

```bash
ssh md2pdf "cd /root/MD2PDFWeb/server && MD2PDF_DATABASE_URL='postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf_test' npm test 2>&1 | tail -25"
```

Expected: 全部 PASS。

- [ ] **Step 8: 推送并加 CI**

```bash
ssh md2pdf "cd /root/MD2PDFWeb && git push origin main 2>&1 | tail -5"
```

仓库当前**没有任何 `.github/workflows`**，因此推送不会触发任何 Action。若希望每次推送自动跑测试，需另开任务添加 CI 工作流（需要 GitHub 上的 PostgreSQL service 容器）。这一步是否要做，由使用者决定。

---

## 自检结果

**Spec 覆盖核对：**

| Spec 章节 | 对应任务 |
| --- | --- |
| 4.1 表结构 | Task 1 |
| 4.3 迁移工具 | Task 1 |
| 5 兑换事务 | Task 6 |
| 6 兑换码规格 | Task 5 |
| 6 限流 | Task 8 |
| 7 用户端接口 | Task 8 |
| 7 管理端接口 | Task 9 |
| 8 前端（管理端） | Task 12 |
| 8 前端（用户端） | Task 11 |
| 9 迁移与上线 | Task 13 |
| 10 测试 | 各任务的测试步骤 + Task 13 Step 7 |
| 三个 store 重写 | Task 2 / 3 / 4 |

**占位符扫描：** 无 TBD / TODO / 「类似上文」。每个代码步骤都给了完整代码。

**类型一致性核对：**

- `redeemStore.redeem` 返回 `{ value, remaining, alreadyRedeemed }`（Task 6 定义）→ Task 8 路由读取 `result.remaining` 并映射为响应字段 `quotaRemaining`（HTTP 层改名，前端契约与 spec 一致）。
- `redeemStore.createBatch` 返回 `codes: string[]`（裸码）→ Task 9 路由用 `format()` 转为展示格式后返回 → Task 12 前端展示 `c.display`。
- `redeemStore.listCodes` 返回 `{ total, codes }`，`codes[]` 含 `id/code/value/batchId/status/createdAt/expiresAt/usedBy/usedAt/revokedAt/note` → Task 9 的 `toDisplay` 追加 `display` 字段后原样透传 → Task 12 使用 `c.display`、`c.status`、`c.value`、`c.createdAt`、`c.usedBy`、`c.id`，全部在列。
- `quotaStore.appendLedger`（Task 4 内部函数）与 `redeemStore.appendLedger`（Task 6 内部函数）是同构的两份实现，各自私有、不跨模块引用，避免 store 之间产生循环依赖。
- `config.auth.sessionTouchIntervalMs` 在 Task 3 Step 3 定义，Task 3 的测试与实现均引用它。
- 前端 `redeemCode()` 返回体含 `quotaRemaining`（Task 8 的响应字段名），Task 11 的 `onRedeemed(result.quotaRemaining)` 一致。

**已知的待确认点（不是占位符，是需要在执行时对着实际文件核对的接入点）：**

1. `AppDialog.vue` 的插槽名与事件名——Task 11 Step 2 与 Task 12 Step 2 都标注了需先读该文件确认。
2. `AdminView.vue` 既有页签按钮的 class 名与 `fmtTime` / `ownerLabel` 的签名——Task 12 Step 2 已标注以实际实现为准。
3. `refreshAll()` 是否用 `Promise.all`——Task 12 Step 2 已给出两种接法。
