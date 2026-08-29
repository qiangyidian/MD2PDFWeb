# MD2PDF Web

原 Electron 桌面工具 [MD2PDF](/root/MD2PDF) 的 Web 版重构：用户在浏览器里批量上传 Markdown（支持 ZIP 压缩包），在线转换为 PDF 并打包下载。

## 架构

```text
浏览器
  │  上传 .md / .zip            │  SSE 实时进度        │  下载 PDF / zip
  ▼                             ▼                      ▼
前端 vite preview :5002  ──/api──►  后端 Express :8002
                                    │  markdown-it + highlight.js 渲染 HTML
                                    │  Puppeteer(Chromium) printToPDF
                                    │  任务工作区 data/jobs/<uuid>/{source,output}
nginx md2pdf.qiangi.top ──► / → 5002；/api/ → 8002
```

## 多用户调度队列

转换请求不直接执行，而是进入进程内调度队列（`server/src/services/scheduler.js`），
在 2 核 / 3.8G 的小机器上承载真实多用户：

- **统一并发闸门**：所有渲染（批量任务 + 文本直转）由调度器控制，默认 2 路（`MD2PDF_CONCURRENCY`）
- **任务级 Round-Robin**：多用户批量文件交错渲染，小任务不被先来用户的大批量饿死
- **内存水位保护**：空闲内存低于 500MB（`MD2PDF_MIN_FREE_MEM`）自动暂停派发、恢复后继续，
  这是「不压垮系统」的核心背压机制
- **准入控制**：全局排队上限 100（`MD2PDF_MAX_WAITING_JOBS`）、单 IP 同时 3 个任务
  （`MD2PDF_MAX_JOBS_PER_IP`），超限返回 429/503 而非默默堆积
- **任务超时**：单文件渲染超时（`MD2PDF_TASK_TIMEOUT`，默认 120s）自动失败并继续批次
- **排队透明**：`GET /api/queue` 查询水位；SSE 推送 `queued` / `queue-update` / `job-start`
  事件，前端显示「排队中 · 第 N 位 · 预计等待 ~Xs」

渲染管线与桌面版完全一致（Typora 风格：标题/表格/引用/行号代码高亮），仅把 Electron 的
`printToPDF` 替换为 Puppeteer 驱动的无头 Chromium。ZIP 内的目录结构与相对图片
（含中文、空格文件名）在转换时通过 `<base href>` 指向后端源文件路由原样还原。

## 功能

- **整文件夹上传**：`选择文件夹` 按钮或直接拖入文件夹，递归读取全部内容（含图片等资源）并保留目录结构；`.md`/`.zip` 也可散装上传
- **IDE 式工作台**：上传后进入三栏界面——顶部为进度条/转换设置/开始按钮，左侧目录树，中间 Markdown 源文件渲染，右侧 PDF 转换结果，转换过程中树节点实时点亮 ✅/❌ 并可即时对照
- 拖拽/点选批量上传 `.md` 与 `.zip`（ZIP 自动解压，保留子目录结构）
- A4 / Letter、0–40mm 页边距、打印背景、递归子目录
- SSE 实时进度：进度条、当前文件、成功/失败/跳过计数、运行日志
- 单文件失败不中断批次；结果与 `convert-log.txt` 支持单个或整包下载
- 中文文件名/路径/内容、代码高亮（Go/Python/JS 等 190+ 语言）
- 任务文件保留 2 小时后自动清理；上传/转换接口有限流保护

## 目录结构

```text
MD2PDFWeb/
├─ server/            后端 (端口 8002)
│  ├─ src/index.js             Express 入口
│  ├─ src/routes/jobs.js       上传/SSE/下载/取消/预览
│  ├─ src/services/renderer.js  Markdown→HTML（移植自桌面版 converter.js）
│  ├─ src/services/pdf.js       HTML→PDF（Puppeteer + 并发信号量）
│  ├─ src/services/jobManager.js 任务生命周期/SSE 事件/TTL 清理
│  ├─ src/services/scheduler.js  多用户调度队列（并发闸门/轮转公平/内存背压/准入控制）
│  ├─ src/services/zipExtract.js ZIP 解压（防路径穿越/zip 炸弹，GBK 文件名回退解码）
│  └─ src/services/zipDecode.js  ZIP 文件名解码器（严格 UTF-8 优先，GBK 回退）
├─ web/               前端 (端口 5002, Vue 3 + Vite)
│  ├─ src/App.vue              主界面（双模式、SSE 进度、结果下载）
│  ├─ src/components/Workbench.vue IDE 三栏工作台（顶部进度/设置/动作 + 树|源文件|PDF）
│  └─ src/components/
│     ├─ FileDrop.vue          上传区（文件/ZIP/整文件夹，目录拖拽递归遍历）
│     ├─ FileTree.vue          文件树（扁平路径→目录树）
│     ├─ TreeNode.vue          递归树节点（目录折叠、md 状态点亮）
│     ├─ PreviewPane.vue       预览面板（源文件/PDF/对比 三态、骨架屏加载）
│     ├─ OptionsForm.vue       转换选项
│     └─ OptionsForm.vue       转换选项
├─ deploy/            部署产物
│  ├─ md2pdf-backend.service   systemd 后端服务
│  ├─ md2pdf-web.service       systemd 前端服务
│  ├─ nginx-md2pdf.conf        nginx 站点配置（含 certbot 注入的 443 块）
│  └─ ensure-cert.sh           DNS 生效后一键签发 HTTPS 证书（可选）
└─ restart-dev.sh     开发期重启后端
```

## 运维

```bash
systemctl status md2pdf-backend   # 后端 :8002
systemctl status md2pdf-web       # 前端 :5002
systemctl restart md2pdf-backend md2pdf-web
tail -f /var/log/nginx/error.log
```

前端改动后需要重新构建：`cd web && npm run build`（vite preview 服务的是 `dist/`）。

## HTTPS 签发（DNS 生效后执行一次）

`md2pdf.qiangi.top` 的 A 记录（→ 103.212.187.98）添加并生效后：

```bash
certbot --nginx -d md2pdf.qiangi.top
# 或等价地：
/root/MD2PDFWeb/deploy/ensure-cert.sh
```

签发后 nginx 自动完成 80→443 跳转与证书挂载（与 sql2er.qiangi.top 相同模式）。

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/jobs` | multipart 上传；文件夹上传时逐文件附 `path` 相对路径字段 |
| GET | `/api/jobs/:id` | 任务快照（刷新页面恢复状态） |
| POST | `/api/jobs/:id/start` | 启动转换 `{pageSize,marginMm,printBackground,recursive}` |
| GET | `/api/jobs/:id/events` | SSE 进度流 |
| POST | `/api/jobs/:id/cancel` | 取消转换 |
| GET | `/api/jobs/:id/download` | 打包下载全部 PDF + 转换日志 |
| GET | `/api/jobs/:id/files/:n/download` | 下载单个 PDF（`:n` 为任务序号） |
| GET | `/api/jobs/:id/files/log/download` | 下载 convert-log.txt |
| GET | `/api/jobs/:id/files/:n/download?inline=1` | 浏览器内嵌预览 PDF（inline） |
| GET | `/api/jobs/:id/preview?path=…` | 在线预览 Markdown 源文件（复用转换渲染管线） |
| GET | `/api/queue` | 队列水位（running/queued/内存/你的在队数） |
| GET | `/api/health` | 健康检查 |

## 系统依赖

- Node.js ≥ 20
- Puppeteer 自带 Chromium 的运行库：libnss3、libatk-bridge2.0-0、libgbm1、libasound2 等
- 中文字体：`fonts-noto-cjk`（PDF 中文渲染必需）
