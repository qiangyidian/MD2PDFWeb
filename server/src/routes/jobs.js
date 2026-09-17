const express = require('express');
const multer = require('multer');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const jobManager = require('../services/jobManager');
const { renderMarkdownToHtml } = require('../services/renderer');
const { safeJoin, sanitizeRelPath } = require('../services/fileScanner');
const { requireAuth, sameOriginGuard, isInternalRequest } = require('../middleware/auth');

const router = express.Router();

// 任务接口一律要求登录；写操作加同源校验（CSRF 防线）
router.use(requireAuth, sameOriginGuard);

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: '上传过于频繁，请稍后再试。' }
});

const tmpDir = path.join(config.dataDir, 'tmp');
fsSync.mkdirSync(tmpDir, { recursive: true });

const upload = multer({
  // 浏览器以原始 UTF-8 字节发送 multipart filename；busboy 默认按 latin1 解码会导致中文乱码
  defParamCharset: 'utf8',
  storage: multer.diskStorage({
    destination: tmpDir,
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
  }),
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: config.limits.maxUploadFiles
  }
  // 文件夹上传时资源文件（图片等）需一并入库，故不按扩展名过滤
});

// 任务查找 + 所有权校验：只能访问自己的任务，他人的任务与不存在的任务同样返回 404（不泄露存在性）
function findJobOr404(req, res) {
  const job = jobManager.getJob(req.params.id);
  if (!job || job.userId !== req.user.id) {
    res.status(404).json({ error: '任务不存在或已过期' });
    return null;
  }
  return job;
}

// 创建任务：上传 .md 文件 / .zip 压缩包 / 整个文件夹（附 path 相对路径字段）
router.post('/', uploadLimiter, upload.array('files', config.limits.maxUploadFiles), async (req, res, next) => {
  const job = jobManager.createJob(req.ip, req.user);

  try {
    await fs.mkdir(job.sourceDir, { recursive: true });
    await fs.mkdir(job.outputDir, { recursive: true });

    const relPaths = [].concat(req.body.path || []);
    const { uploaded, allMarkdown, allFiles } = await jobManager.addUploads(job, req.files || [], relPaths);
    res.status(201).json({
      ...jobManager.snapshot(job),
      uploaded,
      allMarkdown,
      allFiles
    });
  } catch (error) {
    // 失败则丢弃整个任务目录
    await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    next(error);
  } finally {
    // 清理 tmp 中残留的 zip 原件
    for (const file of req.files || []) {
      await fs.rm(file.path, { force: true }).catch(() => {});
    }
  }
});

// 任务快照（页面刷新后恢复状态）
router.get('/:id', (req, res) => {
  const job = findJobOr404(req, res);
  if (job) res.json(jobManager.snapshot(job));
});

// 启动转换（进入调度队列；队列满/单用户超限时返回 429/503；管理员任务免配额）
router.post('/:id/start', async (req, res, next) => {
  const job = findJobOr404(req, res);
  if (!job) return;

  try {
    await jobManager.startConversion(job, req.body || {}, { isAdmin: !!req.user?.isAdmin });
    res.json(jobManager.snapshot(job));
  } catch (error) {
    next(error);
  }
});

// SSE 实时进度
router.get('/:id/events', (req, res) => {
  const job = findJobOr404(req, res);
  if (!job) return;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`event: snapshot\ndata: ${JSON.stringify(jobManager.snapshot(job))}\n\n`);

  const unsubscribe = jobManager.subscribe(job, ({ event, payload }) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

// 取消转换
router.post('/:id/cancel', (req, res) => {
  const job = findJobOr404(req, res);
  if (!job) return;

  const ok = jobManager.cancelJob(job);
  res.json({ ok, ...jobManager.snapshot(job) });
});

// 打包下载全部 PDF（含 convert-log.txt）
router.get('/:id/download', (req, res) => {
  const job = findJobOr404(req, res);
  if (!job) return;

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (error) => {
    if (!res.headersSent) res.status(500);
    res.end();
  });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="pdf-${job.id.slice(0, 8)}.zip"`
  );

  archive.pipe(res);
  archive.directory(job.outputDir, false);
  archive.finalize();
});

// 下载单个文件：转换结果 PDF 或转换日志（?inline=1 用于浏览器内预览）
router.get('/:id/files/:name/download', async (req, res, next) => {
  const job = findJobOr404(req, res);
  if (!job) return;

  try {
    if (req.params.name === 'log') {
      const logPath = safeJoin(job.outputDir, 'convert-log.txt');
      await fs.access(logPath);
      return res.download(logPath, 'convert-log.txt');
    }

    const index = Number(req.params.name);
    const task = job.tasks[index];
    if (!task || !Number.isInteger(index)) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const pdfPath = safeJoin(job.outputDir, task.outputRel);
    await fs.access(pdfPath);
    const filename = path.basename(task.outputRel);

    if (req.query.inline === '1') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename*=UTF-8''${encodeURIComponent(filename)}`
      );
      return res.sendFile(pdfPath);
    }

    res.download(pdfPath, filename);
  } catch {
    res.status(404).json({ error: '文件不存在' });
  }
});

// 在线预览 Markdown 源文件（复用转换渲染管线，相对图片一并还原）
router.get('/:id/preview', async (req, res) => {
  const job = findJobOr404(req, res);
  if (!job) return;

  try {
    const rel = sanitizeRelPath(String(req.query.path || ''));
    if (!/\.md$/i.test(rel)) {
      return res.status(400).json({ error: '仅支持预览 .md 文件' });
    }

    const abs = safeJoin(job.sourceDir, rel);
    const stat = await fs.stat(abs);
    if (!stat.isFile()) {
      return res.status(404).json({ error: '文件不存在' });
    }

    const markdown = await fs.readFile(abs, 'utf8');
    // 预览页返回给浏览器：base 用同源相对路径（浏览器自动带会话 Cookie，
    // /:id/source 已做所有权校验）——绝不能把内部令牌通道写进面向用户的 HTML
    const dirUrl = `/api/jobs/${job.id}/source/${
      rel.split('/').slice(0, -1).map(encodeURIComponent).join('/')
    }/`;

    // style=print：以 A4/Letter 纸张效果渲染（转换前的右侧实时排版预览）。
    // 选项取任务已保存的；任务未开始时允许用查询参数临时预览当前设置。
    const options = job.options
      ? jobManager.normalizeOptions(job.options)
      : jobManager.normalizeOptions({
          pageSize: req.query.pageSize,
          marginMm: req.query.marginMm,
          printBackground: req.query.printBackground
        });

    const html = renderMarkdownToHtml({
      markdown,
      title: path.basename(rel),
      baseUrl: dirUrl,
      options,
      paperMode: req.query.style === 'print'
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }
    res.status(404).json({ error: '文件不存在' });
  }
});

// 内部通道（Puppeteer 专用）：/internal/<token>/<jobId>/source/<relPath>
// 令牌在路径里（子资源请求无法带自定义头）。命中条件：回环直连 + 无 XFF + 令牌匹配，
// 三者缺一不可 —— 经 nginx 转发的外部请求即使伪造路径也过不了直连判定
router.get('/internal/:token/:id/source/*splat', async (req, res) => {
  if (!isInternalRequest(req, req.params.token)) {
    res.status(404).json({ error: '任务不存在或已过期' });
    return;
  }

  const job = jobManager.getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: '任务不存在或已过期' });
    return;
  }

  try {
    const splat = Array.isArray(req.params.splat) ? req.params.splat.join('/') : (req.params.splat || '');
    const filePath = safeJoin(job.sourceDir, splat);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.sendFile(filePath);
  } catch {
    res.status(404).json({ error: '文件不存在' });
  }
});

// 任务源文件（用户通过浏览器访问，如 MD 在线预览中的相对图片）
router.get('/:id/source/*splat', async (req, res) => {
  const job = findJobOr404(req, res);
  if (!job) return;

  try {
    const splat = Array.isArray(req.params.splat)
      ? req.params.splat.join('/')
      : (req.params.splat || '');
    const filePath = safeJoin(job.sourceDir, splat);
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return res.status(404).json({ error: '文件不存在' });
    }
    res.sendFile(filePath);
  } catch {
    res.status(404).json({ error: '文件不存在' });
  }
});

module.exports = router;
