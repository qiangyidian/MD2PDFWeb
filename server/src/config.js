const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

const port = Number(process.env.PORT || 8002);

module.exports = {
  port,
  host: process.env.HOST || '127.0.0.1',

  // 运行时数据目录：任务工作区（上传的源文件 + 生成的 PDF）
  dataDir: process.env.MD2PDF_DATA_DIR || path.join(ROOT, 'data'),
  get jobsDir() {
    return path.join(this.dataDir, 'jobs');
  },

  // Puppeteer 渲染 HTML 时解析相对图片地址用的内部基址
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
