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

  const keeper = await userStore.createUser({ email: 'keeper@example.com', password: 'password123' });
  await userStore.deleteUser(user.id, keeper.id);

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

test('adminCreateUser 可指定 admin 角色', async () => {
  const user = await userStore.adminCreateUser({
    email: 'boss@example.com',
    password: 'password123',
    role: 'admin'
  });
  assert.equal(user.role, 'admin');
  assert.equal(await userStore.isAdmin(user.id), true);
});

test('listUsers 按注册时间倒序且不含密码哈希', async () => {
  await insertUser({
    id: '33333333-3333-3333-3333-333333333333',
    email: 'old@example.com',
    createdAt: Date.now() - 3_600_000
  });
  await userStore.createUser({ email: 'new@example.com', password: 'password123' });

  const list = await userStore.listUsers();
  assert.equal(list.length, 2);
  assert.equal(list[0].email, 'new@example.com');
  assert.equal(list[0].passwordHash, undefined);
});

test('bootstrapAdmins 幂等地把指定邮箱提权为管理员', async () => {
  const user = await userStore.createUser({ email: 'boot@example.com', password: 'password123' });
  assert.equal(await userStore.isAdmin(user.id), false);

  const promoted = await userStore.bootstrapAdmins(['boot@example.com']);
  assert.deepEqual(promoted, ['boot@example.com']);
  assert.equal(await userStore.isAdmin(user.id), true);

  // 第二次调用不应再报「刚被提权」，因为角色已是 admin
  assert.deepEqual(await userStore.bootstrapAdmins(['boot@example.com']), []);
});

test('并发创建同一邮箱：只有一个成功，另一个 409', async () => {
  const attempts = await Promise.allSettled([
    userStore.createUser({ email: 'race@example.com', password: 'password123' }),
    userStore.createUser({ email: 'race@example.com', password: 'password123' })
  ]);
  assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n, 1);
});
