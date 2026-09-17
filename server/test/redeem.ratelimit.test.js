// 必须在任何 require 之前设置：config.js 在模块加载时读取环境变量。
// 限流器是进程级单例，若与功能用例同处一个文件，前面的请求会把额度吃掉，
// 导致无关用例随机变成 429。因此单独成文件、单独一个进程、用一个很低的上限。
process.env.MD2PDF_REDEEM_RATE_LIMIT_PER_MINUTE = '3';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { insertUser, setupSchema, truncateAll, closePool } = require('./helpers/db');
const redeemStore = require('../src/services/redeemStore');
const sessionStore = require('../src/services/sessionStore');
const config = require('../src/config');

const express = require('express');
const redeemRouter = require('../src/routes/redeem');

let server;
let baseUrl;
let token;
let userId;

test.before(async () => {
  await setupSchema();
  const instance = express();
  instance.use(express.json());
  instance.use('/api/redeem', redeemRouter);
  // eslint-disable-next-line no-unused-vars
  instance.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ error: error.message });
  });
  server = instance.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

// 每个用例换一个全新用户：限流按 user id 分桶，复用同一用户会让上一个用例
// 消耗掉的额度泄漏到下一个用例，导致随机 429
test.beforeEach(async () => {
  await truncateAll();
  userId = crypto.randomUUID();
  const email = `limit-${userId.slice(0, 8)}@example.com`;
  await insertUser({ id: userId, email });
  token = await sessionStore.create({ id: userId, email, name: 'L' });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await closePool();
});

function attempt(code) {
  return fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${config.auth.cookieName}=${token}`,
      Origin: baseUrl
    },
    body: JSON.stringify({ code })
  }).then(async (res) => ({ status: res.status, headers: res.headers, body: await res.json() }));
}

test('超过每分钟上限后返回 429 且带可读文案', async () => {
  const limit = config.redeem.rateLimitPerMinute;
  assert.equal(limit, 3, '本文件依赖的低上限未生效');

  const results = [];
  for (let i = 0; i < limit + 3; i += 1) {
    results.push(await attempt('MD2PDF-ZZZZZ-ZZZZZ-ZZZZZ'));
  }

  const ok = results.filter((r) => r.status !== 429);
  const limited = results.filter((r) => r.status === 429);

  assert.equal(ok.length, limit, `前 ${limit} 次应被正常处理`);
  assert.equal(limited.length, 3, '超出部分应被限流');
  assert.ok(
    limited.every((r) => r.body.error && r.body.error.length > 0),
    '限流响应应带可读文案'
  );
});

test('限流响应带标准限流头，便于前端与运维观察', async () => {
  const res = await attempt('MD2PDF-ZZZZZ-ZZZZZ-ZZZZZ');
  assert.equal(res.status, 404, '第一次请求不应被限流（码不存在返回 404）');
  assert.ok(
    res.headers.get('ratelimit') || res.headers.get('ratelimit-policy'),
    '应返回 draft-7 限流头'
  );
});

test('被限流时不消耗兑换码', async () => {
  const { codes } = await redeemStore.createBatch({ value: 10, count: 1 });
  const limit = config.redeem.rateLimitPerMinute;

  // 先把该用户的额度打满
  for (let i = 0; i < limit; i += 1) await attempt('MD2PDF-ZZZZZ-ZZZZZ-ZZZZZ');

  // 这次带着真码来，但应被限流挡下
  const res = await attempt(codes[0]);
  assert.equal(res.status, 429);

  const after = await redeemStore.listCodes({});
  assert.equal(after.codes[0].status, 'unused', '被限流的请求不得消耗兑换码');
});

test('限流按用户分桶：一个用户被限流不影响另一个用户', async () => {
  const limit = config.redeem.rateLimitPerMinute;
  for (let i = 0; i < limit + 1; i += 1) await attempt('MD2PDF-ZZZZZ-ZZZZZ-ZZZZZ');

  // 换一个用户
  const otherId = crypto.randomUUID();
  const otherEmail = `other-${otherId.slice(0, 8)}@example.com`;
  await insertUser({ id: otherId, email: otherEmail });
  const otherToken = await sessionStore.create({ id: otherId, email: otherEmail, name: 'O' });

  const res = await fetch(`${baseUrl}/api/redeem`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `${config.auth.cookieName}=${otherToken}`,
      Origin: baseUrl
    },
    body: JSON.stringify({ code: 'MD2PDF-ZZZZZ-ZZZZZ-ZZZZZ' })
  });
  assert.equal(res.status, 404, '另一个用户不应受前一个用户的限流影响');
});
