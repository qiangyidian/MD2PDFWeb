const test = require('node:test');
const assert = require('node:assert/strict');

const { insertUser, pool, setupSchema, truncateAll, closePool } = require('./helpers/db');
const redeemStore = require('../src/services/redeemStore');
const sessionStore = require('../src/services/sessionStore');
const config = require('../src/config');

// 用真实的 Express 应用 + 真实会话，走完整鉴权链（requireAuth / sameOriginGuard），
// 而不是注入 req.user 把中间件绕过去——那样测不到 CSRF 与登录校验是否真的生效。
const express = require('express');
const redeemRouter = require('../src/routes/redeem');

const USER = 'c1111111-1111-1111-1111-111111111111';
const OTHER = 'c2222222-2222-2222-2222-222222222222';

let server;
let baseUrl;
let token;

function buildApp() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/redeem', redeemRouter);
  // eslint-disable-next-line no-unused-vars
  instance.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.message });
  });
  return instance;
}

async function post(body, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.withAuth !== false) {
    headers.Cookie = `${config.auth.cookieName}=${token}`;
  }
  if (options.withOrigin !== false) {
    headers.Origin = baseUrl;
  }
  const res = await fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
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
  await insertUser({ id: USER, email: 'route@example.com', name: 'R' });
  await insertUser({ id: OTHER, email: 'other@example.com', name: 'O' });
  token = await sessionStore.create({ id: USER, email: 'route@example.com', name: 'R' });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

test('未登录时拒绝（401），不暴露任何兑换信息', async () => {
  const res = await post({ code: 'MD2PDF-ZZZZZ-ZZZZZ-ZZZZZ' }, { withAuth: false });
  assert.equal(res.status, 401);
});

test('缺少同源头时被 CSRF 防线拒绝（403）', async () => {
  const { codes } = await redeemStore.createBatch({ value: 10, count: 1 });
  const res = await post({ code: codes[0] }, { withOrigin: false });
  assert.equal(res.status, 403);
});

test('跨站 Origin 被拒绝（403），且不消耗兑换码', async () => {
  const { codes } = await redeemStore.createBatch({ value: 10, count: 1 });
  const res = await fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${config.auth.cookieName}=${token}`,
      Origin: 'https://evil.example.com'
    },
    body: JSON.stringify({ code: codes[0] })
  });
  assert.equal(res.status, 403);

  // 关键：被 CSRF 拦下的请求不得产生副作用
  const after = await redeemStore.listCodes({});
  assert.equal(after.codes[0].status, 'unused', '被拒的请求不得消耗兑换码');
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
  assert.match(res.body.message, /已经兑换过/);
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

test('带前缀连字符的展示格式可直接兑换', async () => {
  const { codes } = await redeemStore.createBatch({ value: 15, count: 1 });
  const { format } = require('../src/services/redeemCode');
  const res = await post({ code: format(codes[0]) });
  assert.equal(res.status, 200);
  assert.equal(res.body.value, 15);
});

test('兑换的是当前登录用户，攻击者拿到别人的 token 才可能换错人', async () => {
  const { codes } = await redeemStore.createBatch({ value: 40, count: 1 });
  await post({ code: codes[0] });

  const { rows } = await pool.query('SELECT used_by FROM redeem_codes WHERE code = $1', [codes[0]]);
  assert.equal(rows[0].used_by, USER);
});
