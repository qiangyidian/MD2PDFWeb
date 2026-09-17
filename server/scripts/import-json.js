#!/usr/bin/env node
/**
 * 一次性数据导入：JSON 文件 -> PostgreSQL
 *
 * 迁移前的数据落在 server/data/ 下三个文件：
 * - users.json         用户数组
 * - quotas.json        { userId: remaining } 余额表
 * - quota-ledger.jsonl 每行一条流水
 *
 * 设计要点：
 * - 幂等：全部走 ON CONFLICT DO NOTHING，重复执行不会产生重复数据
 * - 保真：密码哈希原样搬运（用户无需改密），createdAt 毫秒时间戳无损还原
 * - 可回退：导入成功后把原文件改名为 .migrated 保留而非删除，
 *   出问题时可连同代码一起回退到文件存储
 * - dry-run：只统计不写库、不改名，用于上线前预演
 *
 * 用法：
 *   MD2PDF_DATABASE_URL=postgres://... node scripts/import-json.js [--data-dir=路径] [--dry-run]
 */

const fs = require('node:fs/promises');
const path = require('node:path');

const { pool } = require('../src/db/pool');
const { migrate } = require('../src/db/migrate');

const DATA_FILES = ['users.json', 'quotas.json', 'quota-ledger.jsonl'];

// 原实现里出现过的流水类型；未知类型一律归为 grant，宁可多记不可丢
const LEDGER_TYPE_MAP = { grant: 'grant', reserve: 'reserve', release: 'release', revoke: 'revoke' };

function parseArgs(argv) {
  const options = { dataDir: null, dryRun: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg.startsWith('--data-dir=')) options.dataDir = arg.slice('--data-dir='.length);
  }
  return options;
}

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`读取 ${file} 失败: ${error.message}`);
  }
}

async function readJsonlIfExists(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          // 进程崩溃时可能留下半截行，跳过它而不是让一条坏数据阻断整个迁移
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`读取 ${file} 失败: ${error.message}`);
  }
}

async function importFrom({ dataDir, dryRun = false }) {
  if (!dataDir) throw new Error('未指定数据目录');

  try {
    const stat = await fs.stat(dataDir);
    if (!stat.isDirectory()) throw new Error('不是目录');
  } catch {
    throw new Error(`数据目录不存在: ${dataDir}`);
  }

  const users = (await readJsonIfExists(path.join(dataDir, 'users.json'))) || [];
  const quotas = (await readJsonIfExists(path.join(dataDir, 'quotas.json'))) || {};
  const ledger = await readJsonlIfExists(path.join(dataDir, 'quota-ledger.jsonl'));

  // 文件里的条数先如实报出来。注意不能把「文件里有几条」和「本次入库几条」
  // 混为一个字段：dry-run 时只有前者可算，真实导入时只有后者可算，
  // 混用会让 dry-run 对三个分类中的两个恒报 0（本文件初版就是这么错的，
  // 差点让人以为线上数据是空的）。
  const summary = {
    users: users.length,
    quotas: Object.keys(quotas).length,
    ledger: ledger.length,
    totalUsers: users.length,
    totalQuotas: Object.keys(quotas).length,
    totalLedger: ledger.length,
    insertedUsers: 0,
    insertedQuotas: 0,
    insertedLedger: 0,
    skipped: 0
  };

  if (dryRun) return summary;

  await migrate();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (const user of users) {
      const { rowCount } = await client.query(
        `INSERT INTO users (id, email, name, password_hash, role, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          user.id,
          String(user.email).trim().toLowerCase(),
          user.name || String(user.email).split('@')[0],
          user.passwordHash,
          user.role === 'admin' ? 'admin' : 'user',
          new Date(user.createdAt || Date.now())
        ]
      );
      if (rowCount) summary.insertedUsers += 1;
      else summary.skipped += 1;
    }

    for (const [userId, remaining] of Object.entries(quotas)) {
      const { rowCount } = await client.query(
        `INSERT INTO quota_accounts (user_id, remaining) VALUES ($1, $2)
         ON CONFLICT (user_id) DO NOTHING`,
        [userId, Math.max(0, Math.round(Number(remaining) || 0))]
      );
      if (rowCount) summary.insertedQuotas += 1;
    }

    for (const entry of ledger) {
      const { rowCount } = await client.query(
        `INSERT INTO quota_ledger
           (id, user_id, entry_type, amount, remaining, note, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO NOTHING`,
        [
          entry.id,
          entry.userId,
          LEDGER_TYPE_MAP[entry.type] || 'grant',
          Math.max(0, Math.round(Number(entry.amount) || 0)),
          Math.max(0, Math.round(Number(entry.remaining) || 0)),
          entry.note || '',
          new Date(entry.time || Date.now())
        ]
      );
      if (rowCount) summary.insertedLedger += 1;
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }

  // 落库成功后才改名：先改名后失败会既丢原文件又没进库
  for (const name of DATA_FILES) {
    const from = path.join(dataDir, name);
    try {
      await fs.rename(from, `${from}.migrated`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  return summary;
}

/**
 * 对账：校验每个账户的余额等于其最后一条流水的快照。
 * 迁移最怕的是「余额搬过来了但流水没搬全」，这个检查专抓这种情况。
 * 返回不一致的明细，空数组表示一致。
 */
async function verifyConsistency() {
  const { rows } = await pool.query(`
    SELECT a.user_id, a.remaining,
           (SELECT l.remaining FROM quota_ledger l
             WHERE l.user_id = a.user_id
             ORDER BY l.created_at DESC, l.id DESC LIMIT 1) AS last_snapshot
      FROM quota_accounts a
  `);
  return rows.filter((r) => r.remaining !== r.last_snapshot);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = options.dataDir || path.resolve(__dirname, '..', 'data');

  console.log(`[import] 数据目录: ${dataDir}${options.dryRun ? '（dry-run，不写库）' : ''}`);

  const summary = await importFrom({ dataDir, dryRun: options.dryRun });

  if (options.dryRun) {
    console.log(
      `[import] 待导入：用户 ${summary.totalUsers} 条，余额 ${summary.totalQuotas} 条，流水 ${summary.totalLedger} 条`
    );
    console.log('[import] dry-run 结束，未写库、未改动任何文件');
    return;
  }

  console.log(
    `[import] 已导入：用户 ${summary.insertedUsers}/${summary.totalUsers} 条` +
      (summary.skipped ? `（跳过已存在 ${summary.skipped} 条）` : '') +
      `，余额 ${summary.insertedQuotas}/${summary.totalQuotas} 条，流水 ${summary.insertedLedger}/${summary.totalLedger} 条`
  );

  // 没导进任何用户是个强烈的异常信号（比如数据目录填错了），必须响亮地失败
  if (summary.totalUsers > 0 && summary.insertedUsers === 0) {
    throw new Error(
      `读到 ${summary.totalUsers} 条用户记录但一条也没入库——通常意味着重复执行或数据目录有误，请核对后再上线`
    );
  }

  console.log('[import] 原文件已改名为 .migrated 保留');

  const mismatches = await verifyConsistency();
  if (mismatches.length) {
    console.error('[import] 对账失败，以下账户余额与最后一条流水快照不一致：');
    for (const m of mismatches) {
      console.error(`  用户 ${m.user_id}: 余额 ${m.remaining}，流水快照 ${m.last_snapshot}`);
    }
    throw new Error('导入后对账不一致，请勿上线');
  }
  console.log('[import] 对账通过：所有账户余额与流水快照一致');
}

if (require.main === module) {
  main()
    .then(() => pool.end())
    .catch(async (error) => {
      console.error('[import] 失败:', error.message);
      await pool.end().catch(() => {});
      process.exit(1);
    });
}

module.exports = { importFrom, verifyConsistency };
