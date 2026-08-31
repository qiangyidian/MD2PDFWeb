const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');

const port = Number(process.env.PORT || 8002);

// 会话签名兜底密钥：生产必须显式设置 MD2PDF_SESSION_SECRET（长度>=32），
// 未设置时生成随机值（进程重启后旧会话全部失效，不影响正确性，只是体验降级）
const sessionSecret =
  process.env.MD2PDF_SESSION_SECRET && process.env.MD2PDF_SESSION_SECRET.length >= 32
    ? process.env.MD2PDF_SESSION_SECRET
    : crypto.randomBytes(32).toString('hex');

module.exports = {
  port,
  host: process.env.HOST || '127.0.0.1',
  isProduction: process.env.NODE_ENV === 'production',

  // 登录态（Cookie 会话）配置
  auth: {
    sessionSecret,
    cookieName: 'md2pdf_session',
    // 仅在 HTTPS（含 nginx 反代 https）下给 Cookie 加 Secure；本地 http 调试不加
    cookieSecure: process.env.MD2PDF_COOKIE_SECURE !== '0' && process.env.NODE_ENV === 'production',
    sessionIdleDays: Number(process.env.MD2PDF_SESSION_IDLE_DAYS || 7),       // 不活跃过期
    sessionAbsoluteDays: Number(process.env.MD2PDF_SESSION_ABSOLUTE_DAYS || 30) // 最长生命周期
  },

  // 用户配额：每个注册用户免费赠送的可处理文档数（按成功渲染的 PDF 个数计）
  quota: {
    freeGrant: Number(process.env.MD2PDF_FREE_QUOTA || 50)
  },

  // 邮箱验证码（SMTP 配置对齐 SQL2ER 的 SQL2ER_MAIL_*，此处前缀 MD2PDF_MAIL_）
  mail: {
    enabled: process.env.MD2PDF_MAIL_ENABLED === 'true',
    host: process.env.MD2PDF_MAIL_HOST || 'smtp.qq.com',
    port: Number(process.env.MD2PDF_MAIL_PORT || 465),
    username: process.env.MD2PDF_MAIL_USERNAME || '',
    password: process.env.MD2PDF_MAIL_PASSWORD || '',
    from: process.env.MD2PDF_MAIL_FROM || '',
    auth: process.env.MD2PDF_MAIL_AUTH !== 'false',
    // 调试用：邮件未启用时把验证码回显在响应里（本地开发用，生产必须 false）
    debugEchoCodes: process.env.MD2PDF_DEBUG_ECHO_CODES === 'true',

    verificationCodeTtlSeconds: Number(process.env.MD2PDF_VERIFICATION_CODE_TTL_SECONDS || 300),
    verificationCodeRequestIntervalMs: Number(process.env.MD2PDF_VERIFICATION_CODE_REQUEST_INTERVAL_SECONDS || 60) * 1000,
    verificationCodeBurstLimit: Number(process.env.MD2PDF_VERIFICATION_CODE_BURST_LIMIT || 5),
    verificationCodeBurstWindowMs: Number(process.env.MD2PDF_VERIFICATION_CODE_BURST_WINDOW_SECONDS || 600) * 1000,
    ipCodeRequestBurstLimit: Number(process.env.MD2PDF_IP_CODE_REQUEST_BURST_LIMIT || 20),
    passwordLoginMaxAttempts: Number(process.env.MD2PDF_PASSWORD_LOGIN_MAX_ATTEMPTS || 5),
    passwordLoginIpMaxAttempts: Number(process.env.MD2PDF_PASSWORD_LOGIN_IP_MAX_ATTEMPTS || 20),
    passwordLoginLockoutMs: Number(process.env.MD2PDF_PASSWORD_LOGIN_LOCKOUT_SECONDS || 900) * 1000
  },

  // 运行时数据目录：任务工作区（上传的源文件 + 生成的 PDF）
  dataDir: process.env.MD2PDF_DATA_DIR || path.join(ROOT, 'data'),
  get jobsDir() {
    return path.join(this.dataDir, 'jobs');
  },

  // Puppeteer 渲染 HTML 时解析相对图片地址用的内部基址（直连本机回环，不走 nginx）
  internalBaseUrl: process.env.MD2PDF_INTERNAL_BASE_URL || `http://127.0.0.1:${port}`,

  limits: {
    maxUploadBytes: 200 * 1024 * 1024,      // 单次上传总量
    maxUploadFiles: 2000,                   // 单次上传文件个数（文件夹上传场景）
    maxMarkdownBytes: 20 * 1024 * 1024,     // 单个 .md 文件
    maxFilesPerJob: 500,                    // 单个任务包含的 .md 数量
    jobTtlMs: 2 * 60 * 60 * 1000,           // 任务保留 2 小时后清理
    sweepIntervalMs: 10 * 60 * 1000
  },

  // 同时渲染的 PDF 页面数。服务器 2 核 3.8G，保守设为 2
  concurrency: Math.max(1, Number(process.env.MD2PDF_CONCURRENCY || 2)),

  // 多用户调度队列（消息队列）参数
  queue: {
    maxWaitingJobs: Number(process.env.MD2PDF_MAX_WAITING_JOBS || 100),   // 全局排队上限
    maxJobsPerIp: Number(process.env.MD2PDF_MAX_JOBS_PER_IP || 3),        // 单 IP 排队+转换中上限
    minFreeMemBytes: Number(process.env.MD2PDF_MIN_FREE_MEM || 500 * 1024 * 1024), // 内存水位：低于则暂停派发
    memoryCheckIntervalMs: 3000,                                          // 内存恢复轮询间隔
    taskTimeoutMs: Number(process.env.MD2PDF_TASK_TIMEOUT || 120 * 1000)  // 单文件转换超时
  },

  // 预留内存过低时禁用并发的开关（保留接口，当前固定并发）
  reportSystemInfo: {
    node: process.version,
    platform: `${os.type()} ${os.arch()}`
  }
};
