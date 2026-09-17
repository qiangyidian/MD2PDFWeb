# 兑换码与 PostgreSQL 迁移 — 设计文档

- 日期：2026-09-17
- 状态：已批准，待实现
- 基线：`6404bfb`（服务器 `main`）

## 1. 背景与问题

`md2pdf.qiangi.top` 已上线账号体系与额度计费，但**没有任何充值通道**——不接支付，用户额度用完即止。需要一条「管理员发码、用户兑码」的通道。

排查发现两件事与初始假设不符：

1. **本地仓库落后远端与服务器 5 个提交**。`D:\Gitee\MD2PDFWeb` 停在 `a853bf5`，而服务器 `main` 已到 `6404bfb`（登录注册、强制登录、额度系统、管理后台）。远端 `origin/main` 同样停在 `a853bf5`，即这些功能从未推送。
2. **账号与额度存储是 JSON 文件，不是数据库**。`server/data/{users,quotas,sessions}.json` 加 `quota-ledger.jsonl`，单进程内存 Map 为权威副本，去抖 500ms 落盘。

因此本设计包含两部分：**新增兑换码**，以及**把账号/额度/会话迁移到 PostgreSQL**。

### 已确认的决策

| 议题 | 决策 |
| --- | --- |
| 身份模型 | 邮箱 + 密码（账号体系已存在，不新建） |
| 计费口径 | 按成功渲染的 PDF 个数，预扣 → 成功结算 / 失败退差（已存在） |
| 免费层 | 全站强制登录，无匿名通道（已存在） |
| 存储 | **全量迁移到 PostgreSQL**（`md2pdf` 库，与 sql2er 同实例不同库） |
| 兑换码形态 | 一次性，面额生成时自由指定，可选截止时间，可批量生成与作废 |
| 术语 | 沿用「额度」，不改为「积分」 |
| 码存储 | 数据库存明文（管理后台可重看/再导出） |

## 2. 目标与非目标

### 目标

- 管理员可批量生成兑换码、查看/导出/作废
- 用户输入兑换码，额度原子到账
- 账号、额度、会话持久化到 PostgreSQL，具备真正的事务与行锁
- 现有文件存储数据无损迁移

### 非目标（YAGNI）

不做：兑换码绑定指定用户、码的分销/佣金、额度过期、额度转赠、支付接口、多进程水平扩展。

## 3. 架构

```
浏览器 ──/api──► Express :8002 ──pg Pool──► PostgreSQL 14
                    │                       库 md2pdf @ 127.0.0.1:5432
                    ├─ userStore    实现换 SQL，导出签名不变
                    ├─ sessionStore 实现换 SQL，导出签名不变
                    ├─ quotaStore   实现换 SQL，导出签名不变
                    └─ redeemStore  新增
```

**核心约束：三个既有 store 的导出函数签名一个字都不改。** 调用点共 13 处（`jobManager` 3、`auth.js` 4、`admin.js` 5、`index.js` 1）零改动，把回归面锁死在 store 内部。

## 4. 数据模型

### 4.1 表结构

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,          -- 小写规范化
  name          text NOT NULL,
  password_hash text NOT NULL,                 -- scrypt$N$r$p$salt$hash，沿用现有格式
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_id     text PRIMARY KEY,               -- sha256(token) hex
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX sessions_user_id_idx     ON sessions (user_id);
CREATE INDEX sessions_last_seen_idx   ON sessions (last_seen_at);

CREATE TABLE quota_accounts (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  remaining  integer NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quota_ledger (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_type     text NOT NULL,                -- grant|reserve|release|revoke|redeem
  amount         integer NOT NULL,             -- 恒为正数
  remaining      integer NOT NULL,             -- 变动后余额快照
  note           text NOT NULL DEFAULT '',
  reference_type text NOT NULL DEFAULT '',
  reference_id   text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quota_ledger_user_idx ON quota_ledger (user_id, created_at DESC);
CREATE UNIQUE INDEX uq_quota_ledger_reference
  ON quota_ledger (reference_type, reference_id) WHERE reference_id <> '';

CREATE TABLE redeem_codes (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE,             -- 规范化后的裸码（大写、无连字符）
  value      integer NOT NULL CHECK (value > 0),
  batch_id   uuid NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,                      -- NULL = 永久
  status     text NOT NULL DEFAULT 'unused' CHECK (status IN ('unused','used','revoked')),
  used_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  used_at    timestamptz,
  used_ip    text,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  note       text NOT NULL DEFAULT '',
  CONSTRAINT ck_redeem_used CHECK (
    status <> 'used' OR (used_by IS NOT NULL AND used_at IS NOT NULL)
  )
);
CREATE INDEX redeem_codes_batch_idx  ON redeem_codes (batch_id);
CREATE INDEX redeem_codes_status_idx ON redeem_codes (status, created_at DESC);
```

### 4.2 约束的意图

- `quota_accounts.remaining >= 0`：把现有 `quotaStore.adjust` 里 `Math.max(0, ...)` 的软钳制升级为数据库硬保证，越扣直接报错。
- `uq_quota_ledger_reference`：业务引用幂等，同一 `(reference_type, reference_id)` 只能入账一次。对齐 sql2er 的 `uq_credit_ledger_reference`。
- `ck_redeem_used`：状态自洽，`used` 必须能追溯到兑付人与时间。

### 4.3 迁移工具

- `server/src/db/pool.js` — pg Pool 单例，连接串取 `MD2PDF_DATABASE_URL`
- `server/src/db/migrate.js` — 读 `server/migrations/*.sql`，按文件名排序，每条在事务内执行，成功后写入 `schema_migrations(version, applied_at)`；已应用的跳过，幂等
- `server/migrations/0001_init.sql` — 上述建表语句
- `server/scripts/import-json.js` — 一次性导入

**启动顺序**：`await migrate()` 成功后才 `listen()`。PG 连不上则启动失败，**绝不静默降级回文件存储**——双存储的数据分裂比直接宕机更难排查。

## 5. 兑换事务

唯一的资金路径，单事务完成：

```
BEGIN
  SELECT * FROM redeem_codes WHERE code = $1 FOR UPDATE
  ├─ 不存在            → 「兑换码不存在，请核对后重试」
  ├─ status='revoked'  → 「该兑换码已被作废」
  ├─ expires_at < now()→ 「该兑换码已过期」
  ├─ status='used' AND used_by = 当前用户
  │                    → 「你已经兑换过这个码了，当时到账 N」（幂等友好返回）
  ├─ status='used'     → 「该兑换码已被使用」
  └─ 通过
  UPDATE redeem_codes SET status='used', used_by=$2, used_at=now(), used_ip=$3
    WHERE id=$4 AND status='unused'
  UPDATE quota_accounts SET remaining = remaining + $5, updated_at = now()
    WHERE user_id = $2 RETURNING remaining
  INSERT INTO quota_ledger (entry_type='redeem', reference_type='redeem_code',
                            reference_id=$4, amount=$5, remaining=<上方返回>, ...)
COMMIT
```

### 并发正确性

两个请求同时兑同一个码：第二个在 `FOR UPDATE` 上阻塞，第一个提交后它读到 `status='used'`，返回「已被使用」。**不可能双花。**

### 锁序

恒为 `redeem_codes` → `quota_accounts`。`tryReserve` 只锁 `quota_accounts`。无环，不产生死锁。

### 幂等语义

网络重试或连点两次时，`used_by` 已是当前用户，返回友好提示而非「已被使用」，避免误导用户以为码被别人抢了。

## 6. 兑换码规格

| 项 | 值 |
| --- | --- |
| 字符集 | Crockford Base32，剔除 `I L O U`（防 1/l、0/O 手抄混淆） |
| 格式 | `MD2PDF-XXXXX-XXXXX-XXXXX` |
| 熵 | 15 位 × 5 bit = 75 bit（约 3.8×10²²，暴力枚举不可行） |
| 输入容错 | 忽略大小写/空格/连字符；`O→0`、`I/L→1` 映射 |
| 面额 | 1 ~ 100000，生成时指定 |
| 批量上限 | 单批 1000 个 |
| 有效期 | 可选，不填为永久 |
| 作废 | 单个或整批，仅对 `unused` 生效 |

### 限流

码空间不可爆破，限流用于防脚本刷与防库被拖后撞码：

- 单用户 10 次/分钟
- 单 IP 30 次/分钟
- 连续失败 15 次锁定 1 小时

## 7. 接口

### 用户端

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/redeem` | `{code}` → `{quotaRemaining, value, message}`；requireAuth + sameOriginGuard + 限流 |

### 管理端（挂在既有 `router.use(requireAuth, requireAdmin, sameOriginGuard)` 与 `adminLimiter` 之下）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/admin/redeem-codes` | 生成 `{value, count, expiresAt?, note?}` |
| GET | `/api/admin/redeem-codes` | 分页列表，可按 `status`/`batchId` 筛选 |
| POST | `/api/admin/redeem-codes/revoke` | 作废 `{ids[]}` 或 `{batchId}` |
| GET | `/api/admin/redeem-codes/export` | 导出 CSV（带 BOM，防 Excel 中文乱码） |
| GET | `/api/admin/redeem-stats` | 汇总：总数/已用/未用/作废/已发放额度 |

## 8. 前端

- `AdminView.vue` 增加第 4 个页签**「兑换码」**，沿用既有页签与对话框惯例：生成表单（面额/数量/有效期/备注）→ 生成后弹窗展示码列表 → 一键复制全部 / 下载 CSV；下方为码列表（状态筛选、单条与整批作废）
- `UserBadge.vue` 增加「兑换」入口 → 弹窗输入码 → 调 `/api/redeem` → 余额即时更新，并经既有 SSE `quota` 事件通道同步到 `Workbench`

## 9. 迁移与上线

### 步骤（停机 < 2 分钟）

1. 备份 `server/data/`
2. 建库 `md2pdf` 与角色 → 跑迁移 → 跑导入脚本
3. 校验：用户数、每用户余额、流水条数逐条比对
4. systemd unit 增加 `MD2PDF_DATABASE_URL` → 重启 → 验证

### 回退

代码回退到 `6404bfb`，恢复 `server/data/` 下的 JSON 文件即可回到文件存储。导入脚本会把原文件改名为 `.migrated` 保留而非删除。

### 明确取舍

1. **会话不迁移**。`sessions.json` 当前为空，所有人本就要重新登录一次。
2. **`tryReserve` 变为每文件一次 PG 往返**。500 文件任务即 500 次本机回环调用，亚毫秒级可接受；换来 `UPDATE ... WHERE remaining >= 1 RETURNING` 的原子扣减，比现有内存读改写更严谨。
3. **`sessionStore.resolve` 的 `last_seen_at` 续期做节流**：距上次写入超过 60 秒才 UPDATE，避免每请求一次写。

## 10. 测试

`node:test` + 服务器上的 `md2pdf_test` 库。

| 用例 | 断言 |
| --- | --- |
| 并发兑同一个码 | 10 并发恰好 1 成功 9 失败，额度只增一次 |
| 并发 `tryReserve` | `remaining=5` 时 20 并发恰好 5 成功，余额为 0 不为负 |
| 同用户重复兑同一码 | 幂等友好返回，额度不再增加 |
| 五类拒绝分支 | 不存在/已用/过期/作废/格式错，文案各自正确 |
| 兑换后一致性 | `quota_accounts.remaining` 等于 `quota_ledger` 最后一条快照 |
| 导入脚本 | 对真实 `data/` 跑一遍，用户数/余额/流水条数逐条吻合 |
| 迁移幂等 | 连跑两次结果一致 |
| 既有回归 | 登录、注册送额度、转换预扣/退差、管理后台 CRUD 全部保持通过 |

## 11. 风险

| 风险 | 缓解 |
| --- | --- |
| 迁移期间数据不一致 | 停机切换，导入后逐条校验，原文件保留 |
| 三 store 重写引入回归 | 签名不变 + 调用点零改动 + 全量回归测试 |
| PG 不可用导致全站不可用 | 迁移到本机 PG，与既有 sql2er 同实例（该实例已在生产运行）；启动失败快速暴露而非静默降级 |
| 兑换码泄露 | 一次性 + 可作废 + 可选有效期 + 限流 |
