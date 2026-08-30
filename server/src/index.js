const express = require('express');
const fs = require('node:fs');

const config = require('./config');
const authRouter = require('./routes/auth');
const jobsRouter = require('./routes/jobs');
const jobManager = require('./services/jobManager');
const sessionStore = require('./services/sessionStore');
const verificationStore = require('./services/verificationStore');
const { closeBrowser } = require('./services/browser');
const { requireAuth } = require('./middleware/auth');

const scheduler = require('./services/scheduler');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '25mb' }));

// 安全响应头（Content-Type 嗅探防护；CSP/HSTS 由 nginx 层负责，避免与静态资源策略冲突）
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

// 任务工作区
fs.mkdirSync(config.jobsDir, { recursive: true });

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'md2pdf-web', ...config.reportSystemInfo });
});

// 登录注册（无需鉴权，自带限流）
app.use('/api/auth', authRouter);

// 队列状态（多用户排队透明化）——登录后可见
app.get('/api/queue', requireAuth, (req, res) => {
  res.json({
    ...scheduler.stats(),
    yourActiveJobs: scheduler.countByOwner(req.user.id),
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
sessionStore.startSweeper();
verificationStore.startSweeper();

// 邮件服务就绪提示（配置缺失时登录验证码模式不可用，密码登录不受影响）
if (config.mail.enabled) {
  if (config.mail.host && config.mail.username && config.mail.password) {
    console.log(`[mail] 邮箱验证码服务已启用（${config.mail.host}:${config.mail.port}）`);
  } else {
    console.warn('[mail] MD2PDF_MAIL_ENABLED=true 但 host/username/password 不完整，验证码发送将失败');
  }
} else {
  console.log('[mail] 邮箱验证码服务未启用（MD2PDF_MAIL_ENABLED!=true），注册功能不可用');
}

// 会话密钥兜底提示：生产环境未显式配置时每次重启会登出全部用户
if (process.env.NODE_ENV === 'production' && !process.env.MD2PDF_SESSION_SECRET) {
  console.warn('[auth] 生产环境未设置 MD2PDF_SESSION_SECRET，进程重启将使所有会话失效');
}

// 非回环监听告警：鉴权设计假定后端只在本机回环 + nginx 反代下暴露
const hostIsLoopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host);
if (!hostIsLoopback) {
  console.warn(
    `[auth] 警告：后端正监听 ${config.host}（非回环地址）。请确认已有防火墙/nginx TLS 前置，` +
      '否则登录凭据将以明文暴露在网络上。'
  );
}

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
