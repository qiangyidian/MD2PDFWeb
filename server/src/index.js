const express = require('express');
const fs = require('node:fs');

const config = require('./config');
const jobsRouter = require('./routes/jobs');
const jobManager = require('./services/jobManager');
const { closeBrowser } = require('./services/browser');

const scheduler = require('./services/scheduler');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '25mb' }));

// 任务工作区
fs.mkdirSync(config.jobsDir, { recursive: true });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'md2pdf-web', ...config.reportSystemInfo });
});

// 队列状态（多用户排队透明化）
app.get('/api/queue', (req, res) => {
  res.json({
    ...scheduler.stats(),
    yourActiveJobs: scheduler.countByIp(req.ip),
    maxJobsPerIp: config.queue.maxJobsPerIp
  });
});

app.use('/api/jobs', jobsRouter);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

// 统一错误处理
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  const statusCode = error.statusCode || (error.code === 'LIMIT_FILE_SIZE' ? 413 : 0) || 500;
  const message =
    error.code === 'LIMIT_FILE_SIZE'
      ? '上传文件过大'
      : error.message || '服务器内部错误';

  if (statusCode >= 500) {
    console.error('[md2pdf] error:', error);
  }

  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(statusCode).json({ error: message });
});

jobManager.startSweeper();

const server = app.listen(config.port, config.host, () => {
  console.log(`[md2pdf] 后端已启动: http://${config.host}:${config.port}`);
});

// 优雅退出：关闭 Chromium 与 HTTP 服务
async function shutdown(signal) {
  console.log(`[md2pdf] 收到 ${signal}，正在退出…`);
  server.close();
  await closeBrowser();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
