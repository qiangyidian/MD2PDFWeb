const { Pool } = require('pg');

const config = require('../config');

/**
 * PostgreSQL 连接池单例。
 *
 * 小机器（2 核 3.8G）上的保守配置：连接数上限 10，空闲 30s 回收。
 * 本服务是单进程 Express，池实际上只会被一条事件循环串行取用，
 * 10 条足够覆盖「一次事务内多次往返」的场景而不浪费 PG 侧的 backend 进程。
 */
const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000
});

// 空闲连接被 PG 侧断开时 pg 会发 error 事件；不监听会进程崩溃
pool.on('error', (error) => {
  console.error('[db] 空闲连接异常:', error.message);
});

function query(text, params) {
  return pool.query(text, params);
}

/**
 * 事务包装。回调抛错即 ROLLBACK，正常返回即 COMMIT。
 * 回调收到的是同一个 client，事务内的多次查询必须全部走它，
 * 否则会跑到池里另一条连接上，脱离事务。
 */
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* 连接已坏，ROLLBACK 失败不影响原始错误上抛 */
    }
    throw error;
  } finally {
    client.release();
  }
}

function close() {
  return pool.end();
}

module.exports = { close, pool, query, withTx };
