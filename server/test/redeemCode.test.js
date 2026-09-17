const test = require('node:test');
const assert = require('node:assert/strict');

const { ALPHABET, format, generate, isValidCode, normalize } = require('../src/services/redeemCode');

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

test('字符集恰为 32 个，每字符 5 bit，15 位即 75 bit 熵', () => {
  assert.equal(ALPHABET.length, 32);
  assert.equal(new Set(ALPHABET).size, 32, '字符集内不得有重复字符');
  assert.equal(15 * 5, 75);
});

test('normalize 容忍大小写、空格与连字符', () => {
  const code = generate();
  const withDashes = format(code);
  assert.equal(normalize(withDashes), code);
  assert.equal(normalize(withDashes.toLowerCase()), code);
  assert.equal(normalize(`  ${withDashes}  `), code);
  assert.equal(normalize(withDashes.replace(/-/g, ' ')), code);
  assert.equal(normalize(`md2pdf ${code.slice(0, 5)} ${code.slice(5, 10)} ${code.slice(10)}`), code);
});

test('normalize 做易混字符映射：O->0、I/L->1', () => {
  // 必须用满长度输入才能验证映射——短输入会先被长度校验拒绝
  assert.equal(normalize('O'.repeat(15)), '0'.repeat(15));
  assert.equal(normalize('I'.repeat(15)), '1'.repeat(15));
  assert.equal(normalize('L'.repeat(15)), '1'.repeat(15));
  assert.equal(normalize('MD2PDF-OOOO0-IIIII-LLLL1'), '000001111111111');
});

test('normalize 剥离 MD2PDF 前缀', () => {
  assert.equal(normalize('MD2PDF-9F3K2-M7QX8-BT4VZ'), '9F3K2M7QX8BT4VZ');
  assert.equal(normalize('MD2PDF9F3K2M7QX8BT4VZ'), '9F3K2M7QX8BT4VZ');
  assert.equal(normalize('md2pdf-9f3k2-m7qx8-bt4vz'), '9F3K2M7QX8BT4VZ');
});

test('前缀剥离不误伤「恰好以 MD2PDF 开头」的合法裸码', () => {
  // 32^-6 的巧合，但一旦发生就是「生成的码无法被本人兑换」的诡异故障。
  // 注意用 K 而不是 I——I 不在字符集里，真实的码不可能出现它。
  const lucky = 'MD2PDFABCDEFGHK';
  assert.equal(lucky.length, 15);
  assert.equal(normalize(lucky), lucky, '15 位且以 MD2PDF 开头时应视为裸码本身');
  assert.equal(isValidCode(lucky), true);
});

test('normalize 对非法输入返回空串', () => {
  assert.equal(normalize(''), '');
  assert.equal(normalize(null), '');
  assert.equal(normalize(undefined), '');
  assert.equal(normalize(123), '');
  assert.equal(normalize('!!!'), '');
  assert.equal(normalize('ABC'), '', '长度不足应返回空串');
  assert.equal(normalize('9F3K2M7QX8BT4VZX'), '', '长度超出应返回空串');
  assert.equal(normalize('9F3K2M7QX8BT4VZ@'), '', '含非法字符应返回空串');
  assert.equal(normalize('MD2PDF-9F3K2-M7QX8-BT4VZ-EXTRA'), '', '前缀过长也应拒绝');
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

test('format 对非法输入返回空串', () => {
  assert.equal(format('ABC'), '');
  assert.equal(format(''), '');
});

test('format 与 normalize 互为往返', () => {
  for (let i = 0; i < 50; i += 1) {
    const code = generate();
    assert.equal(normalize(format(code)), code, 'format 再 normalize 应还原出原码');
  }
});
