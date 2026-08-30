# MD2PDF Web

原 Electron 桌面工具 [MD2PDF](/root/MD2PDF) 的 Web 版重构：用户在浏览器里批量上传 Markdown（支持 ZIP 压缩包），在线转换为 PDF 并打包下载。**全站登录制**：注册/登录后才能使用，任务按用户隔离。

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

## 登录与安全设计

用户必须登录才能使用任何功能（`server/src/middleware/auth.js` 统一拦截，`/api/auth/*` 与 `/api/health` 除外）。

**认证方案：opaque session token + HttpOnly Cookie（无 JWT、无第三方依赖，全部 Node 内置 crypto 实现）**

**注册需要邮箱验证码；登录「密码」与「邮箱验证码」二选一**（邮件通道为 QQ 邮箱 SMTP，配置与 [SQL2ER](/root/SQL2ER) 共用的发信账号，`MD2PDF_MAIL_*` 环境变量）。

| 环节 | 设计 | 威胁模型 |
| --- | --- | --- |
| 密码存储 | scrypt（N=16384,r=8,p=1）+ 16B 独立随机盐，`timingSafeEqual` 恒定时间校验 | 数据库泄露不还原明文；无彩虹表 |
| 会话凭据 | 32B CSPRNG token，仅存于 HttpOnly+Secure+SameSite=Lax Cookie；磁盘只存 sha256(token) | XSS 偷不到 token；sessions.json 泄露无法反查 |
| 会话生命周期 | 滑动过期 7 天 + 绝对过期 30 天；登出即刻服务端吊销；重启不登出（持久化） | 被盗 token 有限窗口；不用 JWT 正是为了可主动作废 |
| 邮箱验证码 | 6 位数字、5 分钟有效、**用途命名空间隔离**（注册码不能当登录码用）、最多 3 次验证尝试后作废 | 被截获的码无法跨流程重放；在线穷举空间被封死 |
| 验证码下发限流 | 单邮箱 60s 间隔 + 5 次/10min；单 IP 20 次/10min；发送失败自动退回配额 | 邮件轰炸 / 换邮箱绕过 |
| 密码登录锁定 | 单邮箱 5 次失败/15min、单 IP 20 次/15min（IP 上限更高，避免 NAT 用户互相牵连） | 字典攻击 / 密码喷洒 |
| 账号枚举 | 登录失败统一返回「邮箱或密码错误」；不存在的账号也跑一次 scrypt 拉平时序 | 无法探测有效邮箱 |
| CSRF | 写操作强制 Origin/Referer 同源校验 + SameSite=Lax 双保险 | 跨站表单/IMG 无法携带凭据写操作 |
| 越权隔离 | 任务绑定 `userId`，所有 job 接口先验所有权；他人任务与不存在任务同样返回 404 | 拿到任务 URL 也读不到别人的文件，且无法确认任务存在 |
| Puppeteer 内部通道 | 渲染图片走 `/api/jobs/internal/<token>/…`：回环直连 + 无 XFF + 一次性令牌三重判定 | 经 nginx 的外部请求必带 XFF，伪造路径/头均无法命中；令牌绝不出现在返回浏览器的 HTML |
| 传输层 | nginx TLS + HSTS(180d)；后端只监听 127.0.0.1；启动时非回环监听告警 | 凭据不明文过网络 |
| 数据文件 | users.json/sessions.json 权限 0600，tmp+rename 原子写 | 崩溃不留半截文件；其他系统用户不可读 |

**内部通道为什么这样设计**：HTML 里 `<base href>` 的 query 参数在相对 URL 解析时会被丢弃，
所以令牌只能编入路径；而 Puppeteer 直连 127.0.0.1、外部流量经 nginx 必带 `X-Forwarded-For`，
用「回环 + 无 XFF + 令牌」三元判定即可精确区分内外流量，且该 URL 只进 Puppeteer 的内存 HTML，不落任何面向用户的响应。

**部署清单**（详见 `server/.env.example`）：

```bash
# 1. 生成会话密钥并写入 systemd unit（保持重启后登录态）
openssl rand -hex 32   # → deploy/md2pdf-backend.service 的 MD2PDF_SESSION_SECRET
systemctl daemon-reload && systemctl restart md2pdf-backend

# 2. 邮箱验证码：在同一个 unit 里填 MD2PDF_MAIL_*（QQ 邮箱授权码）
#    MD2PDF_MAIL_ENABLED=true MD2PDF_MAIL_HOST=smtp.qq.com MD2PDF_MAIL_PORT=465
#    MD2PDF_MAIL_USERNAME=… MD2PDF_MAIL_PASSWORD=…（授权码）MD2PDF_MAIL_FROM=…

# 3. nginx 增加安全响应头（HSTS 等，配置已更新在 deploy/nginx-md2pdf.conf）
nginx -t && systemctl reload nginx
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
│  ├─ src/index.js             Express 入口（auth 挂载/安全响应头/启动告警）
│  ├─ src/config.js            配置（含 auth 会话参数）
│  ├─ src/routes/auth.js       注册/登录/登出/me（限流、统一错误）
│  ├─ src/routes/jobs.js       上传/SSE/下载/取消/预览（requireAuth + 所有权隔离）
│  ├─ src/middleware/auth.js   会话中间件/CSRF 同源校验/Puppeteer 内部通道判定
│  ├─ src/services/userStore.js     用户存储（scrypt 哈希、原子持久化）
│  ├─ src/services/sessionStore.js  会话存储（sha256 索引、滑动+绝对过期）
│  ├─ src/services/renderer.js  Markdown→HTML（移植自桌面版 converter.js）
│  ├─ src/services/pdf.js       HTML→PDF（Puppeteer + 并发信号量）
│  ├─ src/services/jobManager.js 任务生命周期/SSE 事件/TTL 清理
│  ├─ src/services/scheduler.js  多用户调度队列（并发闸门/轮转公平/内存背压/准入控制）
│  ├─ src/services/zipExtract.js ZIP 解压（防路径穿越/zip 炸弹，GBK 文件名回退解码）
│  └─ src/services/zipDecode.js  ZIP 文件名解码器（严格 UTF-8 优先，GBK 回退）
├─ web/               前端 (端口 5002, Vue 3 + Vite)
│  ├─ src/App.vue              主界面（登录 gate、双模式、SSE 进度、结果下载）
│  ├─ src/components/AuthView.vue   登录/注册卡片（Material 风格、密码可见切换）
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

除 `/api/auth/*` 与 `/api/health` 外全部需要登录（会话 Cookie）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/email/request` | 下发邮箱验证码 `{email,purpose:register\|login}`（邮箱 60s 间隔 + 5/10min，IP 20/10min） |
| POST | `/api/auth/register` | 注册 `{email,password,name?,code}`（必须携带 register 用途验证码） |
| POST | `/api/auth/login/password` | 密码登录 `{email,password}`（5 次失败锁 15 分钟） |
| POST | `/api/auth/login/email` | 验证码登录 `{email,code}`（login 用途码，一次性） |
| POST | `/api/auth/logout` | 登出（即刻吊销会话） |
| GET | `/api/auth/me` | 当前用户（前端刷新恢复登录态） |
| POST | `/api/jobs` | multipart 上传；文件夹上传时逐文件附 `path` 相对路径字段 |
| GET | `/api/jobs/:id` | 任务快照（刷新页面恢复状态；仅任务属主可见） |
| POST | `/api/jobs/:id/start` | 启动转换 `{pageSize,marginMm,printBackground,recursive}` |
| GET | `/api/jobs/:id/events` | SSE 进度流 |
| POST | `/api/jobs/:id/cancel` | 取消转换 |
| GET | `/api/jobs/:id/download` | 打包下载全部 PDF + 转换日志 |
| GET | `/api/jobs/:id/files/:n/download` | 下载单个 PDF（`:n` 为任务序号） |
| GET | `/api/jobs/:id/files/log/download` | 下载 convert-log.txt |
| GET | `/api/jobs/:id/files/:n/download?inline=1` | 浏览器内嵌预览 PDF（inline） |
| GET | `/api/jobs/:id/preview?path=…` | 在线预览 Markdown 源文件（复用转换渲染管线） |
| GET | `/api/queue` | 队列水位（running/queued/内存/你的在队数） |
| GET | `/api/health` | 健康检查（免登录） |

## 系统依赖

- Node.js ≥ 20
- Puppeteer 自带 Chromium 的运行库：libnss3、libatk-bridge2.0-0、libgbm1、libasound2 等
- 中文字体：`fonts-noto-cjk`（PDF 中文渲染必需）
