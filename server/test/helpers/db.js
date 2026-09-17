const path = require('node:path');

const { pool } = require('../../src/db/pool');
const { migrate } = require('../../src/db/migrate');
const config = require('../../src/config');

/**
 * 测试数据库与数据目录的辅助，兼安全阀。
 *
 * 两道阀，都很具体，都来自真实事故：
 *
 * 1) 数据目录（同步，模块加载时立即执行）：必须带 test 字样，且不得是 server/data。
 *    来自 2026-09-17 的真实事故：迁移到 PG 之前先跑了一次 userStore 测试，
 *    当时 userStore 还是「写 JSON 文件」的旧实现，测试夹具直接写进了
 *    server/data/users.json，把真实用户记录覆盖掉了。
 *    守数据库的那道阀当时完全没用——旧实现根本不碰数据库。
 *
 * 2) 数据库（异步）：库名带 _test 才允许建表/清表。
 *    判断依据是 SELECT current_database() 而非解析连接串——pg 在
 *    connectionString 模式下不会把库名填进 pool.options.database（那是空的，
 *    会让阀门永远放行或永远拦截），而数据库自己的回答无论连接怎么配都成立。
 */

// 这个检查必须在模块加载时立刻执行，而不是等某个用例调到它：
// 一旦测试进程碰了文件型存储，等到用例执行时已经晚了。
function assertTestDataDir() {
  const dataDir = config.dataDir || '';
  const normalized = path.resolve(dataDir).replace(/\\/g, '/');
  const productionDir = path.resolve(__dirname, '..', '..', 'data').replace(/\\/g, '/');

  if (normalized === productionDir || !/test/i.test(path.basename(normalized))) {
    throw new Error(
      `拒绝运行：数据目录 "${dataDir}" 不是测试专用目录。\n` +
        '测试进程绝不允许写进服务器数据目录——文件型存储会直接把测试夹具写进生产数据。\n' +
        '请用 npm test（已设好 MD2PDF_DATA_DIR），或手动设置 MD2PDF_DATA_DIR=/tmp/md2pdf-test-data'
    );
  }
  return dataDir;
}

assertTestDataDir();

let verifiedDatabase = null;

async function assertTestDatabase() {
  if (verifiedDatabase) return verifiedDatabase;

  const { rows } = await pool.query('SELECT current_database() AS db');
  const name = rows[0]?.db || '';
  if (!name.endsWith('_test')) {
    throw new Error(
      `拒绝在非测试库上执行：当前连接的是 "${name}"，数据库名必须以 _test 结尾。` +
        '请设置 MD2PDF_DATABASE_URL=postgres://...@127.0.0.1:5432/md2pdf_test'
    );
  }
  verifiedDatabase = name;
  return name;
}

// 建表（幂等，重复调用无副作用）
async function setupSchema() {
  await assertTestDatabase();
  await migrate();
}

// 清空业务表。TRUNCATE ... CASCADE 一次性清掉外键关联，且比重启序列快
async function truncateAll() {
  await assertTestDatabase();
  await pool.query('TRUNCATE users, sessions, quota_accounts, quota_ledger, redeem_codes CASCADE');
}

async function closePool() {
  await pool.end();
}

// createdAt 可选：涉及排序的用例必须显式指定，否则两个用户落在同一毫秒时排序不确定
async function insertUser({ id, email, name = 'U', role = 'user', hash = 'scrypt$1$1$1$aa$bb', createdAt = null }) {
  await pool.query(
    `INSERT INTO users (id, email, name, password_hash, role, created_at)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, now()))`,
    [id, email, name, hash, role, createdAt === null ? null : new Date(createdAt)]
  );
  return id;
}

module.exports = { assertTestDataDir, assertTestDatabase, closePool, insertUser, pool, setupSchema, truncateAll };
