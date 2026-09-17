const fs = require('node:fs/promises');
const path = require('node:path');

const { pool } = require('./pool');

const MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations');

/**
 * 迁移执行器。
 *
 * 约定：server/migrations/NNNN_名称.sql，按文件名字典序执行。
 * 每个文件在**单个事务**内执行，成功后把版本号写入 schema_migrations；
 * 失败则整个文件回滚，绝不会留下执行了一半的 schema。
 * 已记录的版本直接跳过，因此重复执行是安全的。
 *
 * 建表语句本身也写了 IF NOT EXISTS，是第二层幂等保护：
 * 即使 schema_migrations 丢失，重跑也不会炸。
 */
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await fs.readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const { rows } = await pool.query('SELECT version FROM schema_migrations');
  const done = new Set(rows.map((r) => r.version));

  const applied = [];
  for (const file of files) {
    if (done.has(file)) continue;

    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
      console.log(`[db] 已应用迁移 ${file}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`迁移 ${file} 执行失败: ${error.message}`);
    } finally {
      client.release();
    }
  }

  return { applied };
}

module.exports = { MIGRATIONS_DIR, migrate };
