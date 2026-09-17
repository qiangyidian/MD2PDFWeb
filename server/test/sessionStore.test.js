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

test('resolve 实时读取用户信息：改名后立即反映', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '旧名' });
  await pool.query('UPDATE users SET name = $1 WHERE id = $2', ['新名', UID]);

  const session = await sessionStore.resolve(token);
  assert.equal(session.name, '新名', '会话里不冗余存用户信息，改名即时生效');
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

test('destroy 幂等：重复登出不报错', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  await sessionStore.destroy(token);
  await sessionStore.destroy(token);
  await sessionStore.destroy('从未存在的 token');
});

test('destroyAllForUser 踢掉该用户全部会话并返回条数', async () => {
  const t1 = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  const t2 = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  const removed = await sessionStore.destroyAllForUser(UID);
  assert.equal(removed, 2);
  assert.equal(await sessionStore.resolve(t1), null);
  assert.equal(await sessionStore.resolve(t2), null);
});

test('删除用户时其会话被级联清除（无需手动清理）', async () => {
  await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  await pool.query('DELETE FROM users WHERE id = $1', [UID]);
  const { rowCount } = await pool.query('SELECT 1 FROM sessions');
  assert.equal(rowCount, 0);
});

test('用户被删除后其 token 立即失效', async () => {
  const token = await sessionStore.create({ id: UID, email: 'sess@example.com', name: '会话用户' });
  await pool.query('DELETE FROM users WHERE id = $1', [UID]);
  assert.equal(await sessionStore.resolve(token), null);
});
