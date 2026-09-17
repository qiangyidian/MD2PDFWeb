const { pool } = require('../../src/db/pool');
const { migrate } = require('../../src/db/migrate');

/**
 * 测试数据库辅助。
 *
 * 安全阀：库名带 _test 才允许建表/清表。防的是「把 MD2PDF_DATABASE_URL
 * 指向了生产库，然后跑测试清空了真实数据」这种一次就够致命的事故。
 *
 * 判断依据是 SELECT current_database() 而非解析连接串：
 * pg 在 connectionString 模式下不会把库名填进 pool.options.database
 * （那是空的，会让安全阀永远放行或永远拦截），而数据库自己的回答
 * 无论连接是走 connectionString、PG* 环境变量还是默认值都成立。
 */
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

async function insertUser({ id, email, name = 'U', role = 'user', hash = 'scrypt$1$1$1$aa$bb' }) {
  await pool.query(
    `INSERT INTO users (id, email, name, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
    [id, email, name, hash, role]
  );
  return id;
}

module.exports = { assertTestDatabase, closePool, insertUser, pool, setupSchema, truncateAll };
