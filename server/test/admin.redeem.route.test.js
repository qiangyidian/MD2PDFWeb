const test = require('node:test');
const assert = require('node:assert/strict');

const { setupSchema, truncateAll, closePool, insertUser } = require('./helpers/db');
const sessionStore = require('../src/services/sessionStore');
const config = require('../src/config');

const express = require('express');
const adminRouter = require('../src/routes/admin');

const ADMIN = 'd1111111-1111-1111-1111-111111111111';
const PLAIN = 'd2222222-2222-2222-2222-222222222222';

let server;
let baseUrl;
let adminToken;
let plainToken;

async function call(method, path, body, token = adminToken) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${config.auth.cookieName}=${token}`,
      Origin: baseUrl
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const type = res.headers.get('content-type') || '';
  return {
    status: res.status,
    headers: res.headers,
    body: type.includes('json') ? await res.json() : await res.text()
  };
}

test.before(async () => {
  await setupSchema();
  const instance = express();
  instance.use(express.json());
  instance.use('/api/admin', adminRouter);
  // eslint-disable-next-line no-unused-vars
  instance.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.message });
  });
  server = instance.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.beforeEach(async () => {
  await truncateAll();
  await insertUser({ id: ADMIN, email: 'admin@example.com', name: 'A', role: 'admin' });
  await insertUser({ id: PLAIN, email: 'plain@example.com', name: 'P' });
  adminToken = await sessionStore.create({ id: ADMIN, email: 'admin@example.com', name: 'A' });
  plainToken = await sessionStore.create({ id: PLAIN, email: 'plain@example.com', name: 'P' });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

test('非管理员访问兑换码接口被拒绝（403）', async () => {
  const res = await call('GET', '/api/admin/redeem-stats', null, plainToken);
  assert.equal(res.status, 403);
  assert.match(res.body.error, /管理员/);
});

test('未登录访问兑换码接口被拒绝（401）', async () => {
  const res = await fetch(`${baseUrl}/api/admin/redeem-stats`, {
    headers: { Cookie: '', Origin: baseUrl }
  });
  assert.equal(res.status, 401);
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

test('截止时间格式非法返回 400', async () => {
  const res = await call('POST', '/api/admin/redeem-codes', {
    value: 10,
    count: 1,
    expiresAt: '不是日期'
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /时间/);
});

test('列表支持按批次筛选并带展示格式', async () => {
  const created = await call('POST', '/api/admin/redeem-codes', { value: 50, count: 4 });
  const res = await call('GET', `/api/admin/redeem-codes?batchId=${created.body.batchId}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 4);
  assert.ok(res.body.codes.every((c) => c.display.startsWith('MD2PDF-')));
  assert.ok(res.body.codes.every((c) => c.status === 'unused'));
});

test('列表支持按状态筛选', async () => {
  await call('POST', '/api/admin/redeem-codes', { value: 10, count: 2 });
  const res = await call('GET', '/api/admin/redeem-codes?status=used');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 0);
});

test('按批次作废', async () => {
  const created = await call('POST', '/api/admin/redeem-codes', { value: 50, count: 3 });
  const res = await call('POST', '/api/admin/redeem-codes/revoke', { batchId: created.body.batchId });
  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, 3);

  const after = await call('GET', '/api/admin/redeem-codes?status=revoked');
  assert.equal(after.body.total, 3);
});

test('按 id 作废单个码', async () => {
  await call('POST', '/api/admin/redeem-codes', { value: 50, count: 2 });
  const list = await call('GET', '/api/admin/redeem-codes');
  const target = list.body.codes[0];

  const res = await call('POST', '/api/admin/redeem-codes/revoke', { ids: [target.id] });
  assert.equal(res.status, 200);
  assert.equal(res.body.revoked, 1);
});

test('作废时不带参数返回 400', async () => {
  const res = await call('POST', '/api/admin/redeem-codes/revoke', {});
  assert.equal(res.status, 400);
});

test('导出 CSV 带 UTF-8 BOM（按原始字节校验）', async () => {
  const created = await call('POST', '/api/admin/redeem-codes', {
    value: 80,
    count: 2,
    note: '导出批次'
  });

  // 必须校验原始字节：fetch 的 text() 会按规范剥掉 BOM，
  // 用它断言的话「BOM 根本没发出」也会通过，测试就失去意义了
  const res = await fetch(`${baseUrl}/api/admin/redeem-codes/export?batchId=${created.body.batchId}`, {
    headers: {
      Cookie: `${config.auth.cookieName}=${adminToken}`,
      Origin: baseUrl
    }
  });
  const bytes = Buffer.from(await res.arrayBuffer());

  assert.equal(res.status, 200);
  assert.equal(bytes.subarray(0, 3).toString('hex'), 'efbbbf', 'Excel 打开中文 CSV 需要 UTF-8 BOM');

  const lines = bytes.subarray(3).toString('utf8').trim().split('\r\n');
  assert.equal(lines.length, 3, '1 行表头 + 2 行数据');
  assert.match(lines[0], /兑换码/);
  assert.ok(lines[1].includes('MD2PDF-'));
  assert.ok(lines[1].includes('未使用'));
});

test('导出缺少批次参数返回 400', async () => {
  const res = await call('GET', '/api/admin/redeem-codes/export');
  assert.equal(res.status, 400);
});

test('导出响应带下载文件名', async () => {
  const created = await call('POST', '/api/admin/redeem-codes', { value: 10, count: 1 });
  const res = await call('GET', `/api/admin/redeem-codes/export?batchId=${created.body.batchId}`);
  assert.match(res.headers.get('content-disposition') || '', /attachment/);
});

test('统计接口返回各项汇总', async () => {
  await call('POST', '/api/admin/redeem-codes', { value: 10, count: 2 });
  const res = await call('GET', '/api/admin/redeem-stats');
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 2);
  assert.equal(res.body.unused, 2);
  assert.equal(res.body.used, 0);
});

test('生成的码可被普通用户兑换（管理端到用户端全链路）', async () => {
  const created = await call('POST', '/api/admin/redeem-codes', { value: 77, count: 1 });
  const display = created.body.codes[0];

  const { normalize } = require('../src/services/redeemCode');
  const redeemStore = require('../src/services/redeemStore');
  const result = await redeemStore.redeem({ code: display, userId: PLAIN });

  assert.equal(result.value, 77);
  assert.equal(result.remaining, 77);
  assert.equal(normalize(display).length, 15);

  const after = await call('GET', '/api/admin/redeem-codes?status=used');
  assert.equal(after.body.total, 1);
  assert.equal(after.body.codes[0].usedBy, PLAIN);
});
