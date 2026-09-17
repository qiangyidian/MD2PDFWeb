const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * 限流键生成器的加载期校验。
 *
 * express-rate-limit 在模块加载时会校验 keyGenerator，发现用裸 req.ip 当键
 * 就报 ERR_ERL_KEY_GEN_IPV6——同一个 IPv6 地址有多种等价写法
 * （::1 / 0:0:0:0:0:0:0:1 / ::ffff:127.0.0.1），按原始字符串分桶会让
 * 攻击者靠换写法拿到无限额度，限流形同虚设。
 *
 * 这条测试锁住「加载时不报该错」，因为错误只发生在加载期，
 * 普通的接口用例完全覆盖不到。
 */
test('routes/redeem 加载时不产生 ERR_ERL_KEY_GEN_IPV6', () => {
  const target = require.resolve('../src/routes/redeem');
  delete require.cache[target];

  const captured = [];
  const original = console.error;
  console.error = (...args) => captured.push(args.map(String).join(' '));

  try {
    require('../src/routes/redeem');
  } finally {
    console.error = original;
    delete require.cache[target];
  }

  const offending = captured.filter((line) => line.includes('ERR_ERL_KEY_GEN_IPV6'));
  assert.deepEqual(offending, [], `限流键生成器未做 IPv6 归一化：\n${offending.join('\n')}`);
});

test('routes/redeem 加载时不产生任何限流器校验错误', () => {
  const target = require.resolve('../src/routes/redeem');
  delete require.cache[target];

  const captured = [];
  const original = console.error;
  console.error = (...args) => captured.push(args.map(String).join(' '));

  try {
    require('../src/routes/redeem');
  } finally {
    console.error = original;
    delete require.cache[target];
  }

  // express-rate-limit 的校验错误码统一以 ERR_ERL_ 开头
  const offending = captured.filter((line) => line.includes('ERR_ERL_'));
  assert.deepEqual(offending, [], `限流器配置有校验错误：\n${offending.join('\n')}`);
});