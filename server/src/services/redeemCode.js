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
 *
 * 容忍大小写、空格、连字符、可选的 MD2PDF 前缀，以及 O/I/L 与 0/1 的混淆。
 * 任何无法规约到恰好 15 位合法字符的输入返回空串。
 *
 * 前缀剥离有一个刻意的限制：只有当剥掉之后**恰好**剩 15 位时才认为是前缀。
 * 否则一个正巧以 MD2PDF 开头的合法码（几率约 32^-6，虽极小但存在）会被误剥成
 * 9 位而被判非法。加上长度条件后，「带前缀的展示形式」仍能正常解析，
 * 而「裸码本身以 MD2PDF 开头」也不会被误伤。
 */
function normalize(input) {
  if (typeof input !== 'string') return '';

  let text = input.toUpperCase().replace(/[\s-]/g, '');
  if (text.startsWith(PREFIX) && text.length === PREFIX.length + BODY_LENGTH) {
    text = text.slice(PREFIX.length);
  }
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
