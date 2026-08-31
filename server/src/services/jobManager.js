const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const config = require('../config');
const scheduler = require('./scheduler');
const { renderMarkdownToHtml } = require('./renderer');
const { renderHtmlToPdf } = require('./pdf');
const { extractZip } = require('./zipExtract');
const { internalSourceBase } = require('../middleware/auth');
const quotaStore = require('./quotaStore');
const { buildOutputPath, isMarkdownFile, sanitizeRelPath, scanAllFiles, scanMarkdownFiles, safeJoin } = require('./fileScanner');

const jobs = new Map(); // id -> job

function nowString() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function friendlyError(error) {
  const message = error && error.message ? error.message : String(error);
  const code = error && error.code ? error.code : '';

  if (code === 'ENOENT') return `文件或目录不存在：${message}`;
  if (code === 'EACCES' || code === 'EPERM') return `权限不足或目标文件正在被占用：${message}`;
  if (code === 'EBUSY') return `目标文件正在被其他程序占用：${message}`;
  if (code === 'ENAMETOOLONG') return `文件名或路径过长：${message}`;
  if (/ERR_FILE_NOT_FOUND|net::ERR_NAME_NOT_RESOLVED/i.test(message)) return `图片或资源文件不存在：${message}`;
  if (/Failed to fetch|not allowed|permission/i.test(message)) return `资源加载失败：${message}`;

  return message;
}

function normalizeOptions(rawOptions = {}) {
  const marginMm = Number(rawOptions.marginMm);

  return {
    recursive: rawOptions.recursive !== false,
    pageSize: rawOptions.pageSize === 'Letter' ? 'Letter' : 'A4',
    marginMm: Number.isFinite(marginMm) && marginMm >= 0 ? Math.min(marginMm, 50) : 20,
    printBackground: rawOptions.printBackground !== false
  };
}

function jobDir(jobId) {
  return safeJoin(config.jobsDir, jobId);
}

function createJob(ip = '', user = null) {
  const id = crypto.randomUUID();
  const dir = jobDir(id);

  const job = {
    id,
    ip,
    userId: user ? user.id : null, // 任务归属：所有接口按此做所有权隔离
    dir,
    sourceDir: path.join(dir, 'source'),
    outputDir: path.join(dir, 'output'),
    status: 'created', // created | queued | converting | done | cancelled | failed
    queueInfo: null, // { position, estimatedWaitSec, paused } 排队状态
    queueHandle: null, // 调度器句柄
    error: null,
    options: null,
    stats: { total: 0, success: 0, failed: 0, skipped: 0 },
    tasks: [],
    records: [],
    archives: [],
    cancelFlag: false,
    createdAt: Date.now(),
    finishedAt: null,
    events: new EventEmitter(),
    logs: [] // 最近日志（快照里返回）
  };

  job.events.setMaxListeners(100);
  jobs.set(id, job);
  return job;
}

function getJob(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  return jobs.get(id) || null;
}

function appendLog(job, level, message) {
  const entry = { time: nowString(), level, message };
  job.logs.push(entry);
  if (job.logs.length > 500) job.logs.shift();
  emit(job, 'log', entry);
}

function emit(job, event, payload) {
  job.events.emit('event', { event, payload });
}

// 余额变动推送给前端（SSE quota 事件 + 快照字段）
function emitQuota(job, remaining) {
  job.quotaRemaining = remaining;
  emit(job, 'quota', { remaining });
}

function addRecord(job, record) {
  job.records.push({ time: nowString(), ...record });
}

function snapshot(job) {
  return {
    id: job.id,
    status: job.status,
    queueInfo: job.queueInfo,
    quotaRemaining: job.quotaRemaining,
    error: job.error,
    options: job.options,
    stats: job.stats,
    logs: job.logs,
    archives: job.archives,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    tasks: job.tasks.map((task) => ({
      index: task.index,
      inputRel: task.inputRel,
      outputRel: task.outputRel,
      status: task.status,
      error: task.error,
      missingImages: task.missingImages
    }))
  };
}

// SSE 订阅
function subscribe(job, listener) {
  job.events.on('event', listener);
  return () => job.events.off('event', listener);
}

/**
 * 将 multer 上传的文件搬入任务 source 目录；zip 自动解压。
 * @param {Array} files multer 文件数组 { originalname, path, size }
 * @param {Array} relPaths 与 files 对齐的相对路径（文件夹上传时前端提供，可含目录结构）
 */
async function addUploads(job, files, relPaths = []) {
  const limits = config.limits;
  const markdownFiles = [];
  const usedPaths = new Set();

  if (files.length > limits.maxUploadFiles) {
    const error = new Error(`单次上传文件数量超过上限（${limits.maxUploadFiles}）`);
    error.statusCode = 413;
    throw error;
  }

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    const providedPath = typeof relPaths[i] === 'string' ? relPaths[i].trim() : '';

    if (file.originalname.toLowerCase().endsWith('.zip')) {
      await extractZip(file.path, job.sourceDir);
      job.archives.push(file.originalname);
      appendLog(job, 'info', `已解压压缩包：${file.originalname}`);
      continue;
    }

    // 目标相对路径：优先用前端提供的相对路径（保留文件夹结构），否则平铺到根目录
    let targetRel = providedPath
      ? sanitizeRelPath(providedPath)
      : path.basename(file.originalname).replace(/[/\\]/g, '_');

    // U+FFFD（无法还原的字节）替换为下划线，避免损坏的文件名流入文件系统
    targetRel = targetRel.split('/').map((seg) => seg.replace(/�/g, '_')).join('/');

    if (isMarkdownFile(targetRel) && file.size > limits.maxMarkdownBytes) {
      const error = new Error(`Markdown 文件过大（上限 ${Math.floor(limits.maxMarkdownBytes / 1024 / 1024)}MB）：${file.originalname}`);
      error.statusCode = 413;
      throw error;
    }

    // 同路径冲突自动追加序号
    if (usedPaths.has(targetRel.toLowerCase())) {
      const ext = path.posix.extname(targetRel);
      const base = targetRel.slice(0, targetRel.length - ext.length);
      let counter = 1;
      while (usedPaths.has(`${base}-${counter}${ext}`.toLowerCase())) counter += 1;
      targetRel = `${base}-${counter}${ext}`;
    }
    usedPaths.add(targetRel.toLowerCase());

    const targetPath = safeJoin(job.sourceDir, targetRel);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.rename(file.path, targetPath).catch(async (error) => {
      if (error.code === 'EXDEV') {
        await fs.copyFile(file.path, targetPath);
        await fs.rm(file.path, { force: true });
        return;
      }
      throw error;
    });

    if (isMarkdownFile(targetRel)) {
      markdownFiles.push({ rel: targetRel, size: file.size });
    }
  }

  const all = await scanMarkdownFiles(job.sourceDir, { recursive: true });
  if (all.length > limits.maxFilesPerJob) {
    const error = new Error(`Markdown 文件数量超过上限（${limits.maxFilesPerJob}）`);
    error.statusCode = 413;
    throw error;
  }

  const allFiles = await scanAllFiles(job.sourceDir);

  return { uploaded: markdownFiles, allMarkdown: all, allFiles };
}

async function writePdfFile(outputDir, targetRel, pdfBuffer) {
  const outputAbs = safeJoin(outputDir, targetRel);
  const outputParent = path.dirname(outputAbs);
  const tempPath = path.join(outputParent, `.${path.basename(outputAbs)}.${Date.now()}.tmp`);

  await fs.mkdir(outputParent, { recursive: true });
  await fs.writeFile(tempPath, pdfBuffer);
  await fs.rename(tempPath, outputAbs);
}

async function convertOneFile(job, task) {
  const inputAbs = safeJoin(job.sourceDir, task.inputRel);

  if (job.cancelFlag) {
    throw Object.assign(new Error('已取消'), { cancelled: true });
  }

  // ===== 配额预扣：每个文件渲染前扣 1，防并发漏扣 =====
  // 匿名任务（userId 为空，理论上已不存在）不扣费直接放行
  if (job.userId) {
    const reserved = await quotaStore.tryReserve(job.userId, `job:${job.id}:${task.inputRel}`);
    if (!reserved.ok) {
      // 余额不足：该文件标记跳过并停掉整个任务后续（继续尝试只会重复失败）
      job.quotaExhausted = true;
      const error = new Error('剩余额度不足，该文件已跳过');
      error.quotaExhausted = true;
      throw error;
    }
    task.reserved = true;
    emitQuota(job, reserved.remaining);
  }

  try {
    const markdown = await fs.readFile(inputAbs, 'utf8');
    // 内部通道：令牌编入路径前缀（相对 URL 解析会丢弃 base 的 query，只能走 path）；
    // 该 URL 只进 Puppeteer 的 HTML，绝不返回给浏览器
    const relDir = task.inputRel.split('/').slice(0, -1).map(encodeURIComponent).join('/');
    const dirBaseUrl = `${internalSourceBase(job.id, relDir ? `${relDir}/` : '')}`;
    const html = renderMarkdownToHtml({
      markdown,
      title: path.basename(task.inputRel),
      baseUrl: dirBaseUrl,
      options: job.options
    });

    const { pdfBuffer, missingImages } = await renderHtmlToPdf(html, job.options);
    await writePdfFile(job.outputDir, task.outputRel, pdfBuffer);
    return { missingImages };
  } catch (error) {
    // 真实渲染失败（非取消/非余额不足）：退回本次预扣，用户不为系统故障买单
    if (task.reserved && !error.cancelled && !error.quotaExhausted) {
      task.reserved = false;
      const remaining = await quotaStore.release(job.userId, `refund:job:${job.id}:${task.inputRel}`);
      emitQuota(job, remaining);
    }
    throw error;
  }
}

async function writeConvertLog(job, cancelled) {
  const { options, stats } = job;
  const lines = [
    'Markdown 批量转 PDF 日志（MD2PDF Web）',
    `转换时间：${nowString()}`,
    `总文件数：${stats.total}`,
    `成功数量：${stats.success}`,
    `失败数量：${stats.failed}`,
    `跳过数量：${stats.skipped}`,
    `页面大小：${options.pageSize}`,
    `页面边距：${options.marginMm}mm`,
    `是否取消：${cancelled ? '是' : '否'}`,
    '',
    '文件明细：'
  ];

  for (const record of job.records) {
    const reason = record.reason ? `；原因：${record.reason}` : '';
    lines.push(`[${record.time}] ${record.status}：${record.inputRel} -> ${record.outputRel || ''}${reason}`);
  }

  const logAbs = safeJoin(job.outputDir, 'convert-log.txt');
  await fs.writeFile(logAbs, `${lines.join('\r\n')}\r\n`, 'utf8');
  return logAbs;
}

// 任务收尾：写日志、置终态、发事件
// cancelled 语义仅指「用户主动取消」；额度耗尽导致的提前停止仍视为正常完成（done），
// 因为已完成的文件产出了 PDF，结果可下载
async function finalizeJob(job, cancelled) {
  if (cancelled && !job.quotaExhausted) {
    addRecord(job, { status: '取消', inputRel: '', outputRel: '', reason: '用户取消转换' });
  }

  await writeConvertLog(job, cancelled && !job.quotaExhausted).catch(() => {});

  job.status = cancelled && !job.quotaExhausted ? 'cancelled' : 'done';
  job.finishedAt = Date.now();
  job.queueInfo = null;
  emit(job, cancelled ? 'cancelled' : 'finished', {
    ...job.stats,
    downloadUrl: `/api/jobs/${job.id}/download`,
    logDownloadUrl: `/api/jobs/${job.id}/files/log/download`
  });
}

function emitProgress(job, task) {
  emit(job, 'progress', {
    total: job.stats.total,
    completed: job.stats.success + job.stats.failed + job.stats.skipped,
    success: job.stats.success,
    failed: job.stats.failed,
    skipped: job.stats.skipped,
    currentFile: task ? path.basename(task.inputRel) : ''
  });
}

// 启动转换：准备任务后交给调度器（多用户消息队列）排队执行
async function startConversion(job, rawOptions) {
  if (job.status === 'converting' || job.status === 'queued') {
    const error = new Error('该任务已在队列或转换中');
    error.statusCode = 409;
    throw error;
  }

  job.options = normalizeOptions(rawOptions);
  job.cancelFlag = false;
  job.queueInfo = null;
  job.quotaExhausted = false;
  job.stats = { total: 0, success: 0, failed: 0, skipped: 0 };
  job.tasks = [];
  job.records = [];

  // 配额前置检查：余额为 0 直接拒绝（402），不进队列占位
  if (job.userId) {
    const remaining = await quotaStore.getRemaining(job.userId);
    job.quotaRemaining = remaining;
    if (remaining <= 0) {
      const error = new Error('剩余处理额度为 0，无法开始转换。每注册用户赠送 50 次文档处理额度。');
      error.statusCode = 402;
      throw error;
    }
  }

  const files = await scanMarkdownFiles(job.sourceDir, { recursive: job.options.recursive });
  if (files.length === 0) {
    job.status = 'failed';
    job.error = '没有找到 .md 文件。请确认上传的是 Markdown 文件或包含 .md 的压缩包。';
    job.finishedAt = Date.now();
    appendLog(job, 'error', job.error);
    emit(job, 'failed', { error: job.error });
    return snapshot(job);
  }

  files.forEach((inputRel, index) => {
    job.tasks.push({
      index,
      inputRel,
      outputRel: buildOutputPath(inputRel),
      status: 'pending',
      error: null,
      missingImages: []
    });
  });
  job.stats.total = job.tasks.length;

  // 单用户准入：同时排队/转换中的任务数受限，防止个别用户占满队列
  // 以登录用户为维度（未登录任务已不存在；userId 兜底退回 IP 维度）
  const ownerKey = job.userId || job.ip;
  if (ownerKey && scheduler.countByOwner(ownerKey) >= config.queue.maxJobsPerIp) {
    const error = new Error(`您已有 ${config.queue.maxJobsPerIp} 个任务在队列中，请等待完成后再提交`);
    error.statusCode = 429;
    throw error;
  }

  let handle;
  try {
    handle = scheduler.submit({
      jobId: job.id,
      ownerKey,
      tasks: job.tasks,
      runTask: (task) => convertOneFile(job, task),
      callbacks: {
        // 首个任务真正开始渲染（离开队列）
        onJobStart: () => {
          job.status = 'converting';
          job.queueInfo = null;
          emit(job, 'started', {
            total: job.stats.total,
            pageSize: job.options.pageSize,
            marginMm: job.options.marginMm
          });
        },
        onTaskDone: (task, { missingImages }) => {
          task.status = 'success';
          task.missingImages = missingImages || [];
          job.stats.success += 1;

          addRecord(job, {
            status: '完成',
            inputRel: task.inputRel,
            outputRel: task.outputRel,
            reason: task.missingImages.length
              ? `有 ${task.missingImages.length} 个图片未能加载：${task.missingImages.join('；')}`
              : ''
          });
          emit(job, 'file-success', { index: task.index, missingImages: task.missingImages });
          if (task.missingImages.length) {
            appendLog(job, 'warn', `${path.basename(task.inputRel)} 有图片未能加载：${task.missingImages.join('；')}`);
          }
          emitProgress(job, task);
        },
        onTaskError: (task, error) => {
          if ((error && error.cancelled) || job.cancelFlag) {
            return; // 用户取消导致的静默丢弃，不计失败
          }

          // 额度不足：计「跳过」不计「失败」，剩余文件全部标跳过后停掉任务
          if (error && error.quotaExhausted) {
            task.status = 'skipped';
            task.error = '剩余额度不足，已跳过';

            // 后续排队中的文件也一并标跳过（重试必然同样跳过，不留给队列）
            let skippedNow = 1;
            for (const pendingTask of job.tasks) {
              if (pendingTask.status === 'pending' && pendingTask.index !== task.index) {
                pendingTask.status = 'skipped';
                pendingTask.error = '剩余额度不足，已跳过';
                addRecord(job, {
                  status: '跳过',
                  inputRel: pendingTask.inputRel,
                  outputRel: '',
                  reason: '剩余额度不足'
                });
                emit(job, 'file-skip', { index: pendingTask.index, error: '剩余额度不足' });
                skippedNow += 1;
              }
            }
            job.stats.skipped += skippedNow;
            addRecord(job, {
              status: '跳过',
              inputRel: task.inputRel,
              outputRel: '',
              reason: '剩余额度不足'
            });
            emit(job, 'file-skip', { index: task.index, error: '剩余额度不足' });
            emitProgress(job, task);
            if (job.queueHandle) scheduler.cancel(job.queueHandle);
            job.quotaExhausted = true;
            appendLog(job, 'warn', `剩余额度不足，共 ${skippedNow} 个文件未处理`);
            return;
          }

          const reason = friendlyError(error);
          task.status = 'failed';
          task.error = reason;
          job.stats.failed += 1;
          addRecord(job, { status: '失败', inputRel: task.inputRel, outputRel: task.outputRel, reason });
          emit(job, 'file-error', { index: task.index, error: reason });
          emitProgress(job, task);
        },
        // 排队位置变化（含内存保护暂停提示）
        onQueueUpdate: (info) => {
          job.queueInfo = { ...info };
          emit(job, 'queue-update', info);
        },
        onJobDone: (cancelled) => {
          finalizeJob(job, cancelled || job.cancelFlag).catch(() => {});
        }
      }
    });
  } catch (error) {
    // 准入失败（429/503）：任务回到可重新提交状态
    job.status = 'created';
    throw error;
  }

  job.queueHandle = handle;
  job.status = 'queued';
  const pos = scheduler.positionOf(handle);
  job.queueInfo = { ...pos, paused: scheduler.paused };
  emit(job, 'queued', { ...pos, paused: scheduler.paused });

  return snapshot(job);
}

function cancelJob(job) {
  if (job.status === 'queued') {
    // 还在队列中：直接移除并立即收敛到取消态
    job.cancelFlag = true;
    if (job.queueHandle) scheduler.remove(job.queueHandle);
    appendLog(job, 'info', '已取消（排队中）');
    finalizeJob(job, true).catch(() => {});
    return true;
  }

  if (job.status !== 'converting') return false;
  job.cancelFlag = true;
  if (job.queueHandle) scheduler.cancel(job.queueHandle);
  appendLog(job, 'info', '已请求取消转换…');
  return true;
}

// TTL 清理
async function sweepExpiredJobs() {
  const now = Date.now();

  for (const [id, job] of jobs) {
    const expired = now - (job.finishedAt || job.createdAt) > config.limits.jobTtlMs;
    if (!expired) continue;

    if (job.queueHandle) scheduler.remove(job.queueHandle);
    jobs.delete(id);
    job.events.removeAllListeners();
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }

  // 清理孤儿目录（进程重启留下的）
  try {
    const entries = await fs.readdir(config.jobsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || jobs.has(entry.name)) continue;
      await fs.rm(path.join(config.jobsDir, entry.name), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // 目录不存在则忽略
  }
}

function startSweeper() {
  setInterval(() => {
    sweepExpiredJobs().catch(() => {});
  }, config.limits.sweepIntervalMs).unref();
}

module.exports = {
  addUploads,
  normalizeOptions,
  cancelJob,
  createJob,
  getJob,
  snapshot,
  startConversion,
  startSweeper,
  subscribe
};
