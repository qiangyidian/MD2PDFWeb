# 上线记录：PostgreSQL 迁移与兑换码

**执行时间**：2026-09-17
**变更提交**：`6404bfb`（迁移前最后一个提交）→ 本次上线

## 做了什么

1. 账号、会话、额度由 `server/data/*.json` 迁移到 PostgreSQL 库 `md2pdf`
2. 新增兑换码功能：管理员批量生成 / 用户兑换 / 作废 / 导出 CSV
3. 后端启动依赖 `MD2PDF_DATABASE_URL`，数据库不可用时**拒绝启动**（不降级回文件存储）

## 线上配置

systemd unit `/etc/systemd/system/md2pdf-backend.service` 新增：

```
Environment=MD2PDF_DATABASE_URL=postgres://md2pdf:md2pdf@127.0.0.1:5432/md2pdf
```

数据库：`md2pdf`（owner `md2pdf`），与 sql2er 同实例不同库。备份见 unit 文件旁的 `.bak-*`。

## 数据处置说明（重要）

**本次没有导入旧的 JSON 数据。** 原因是一次事故：

迁移到 PG 之前先跑了一次 `userStore` 测试来确认「测试会失败」，但那一刻 `userStore`
还是旧的 JSON 文件实现——测试夹具直接写进了 `server/data/users.json`，覆盖了真实账号。
受影响的是 5 个开发期账号（创建于 08-31 / 09-01，全部是开发测试用途；
9-12 上线登录制后无人注册，`users.json` 的 mtime 从 09-01 起未变动）。

**不可恢复**：磁盘无备份；进程内存里也没有（服务启动于 09-16，而 `userStore.load()`
是惰性的，在文件被覆盖前从未执行过，原始记录从未进入任何存活进程的内存——
已用 `/proc/<pid>/mem` 扫描 4 个真实用户 ID 验证，其周围 4KB 内既无邮箱也无密码哈希）。

**留存证据**：
- `/root/md2pdf-INCIDENT-20260917.tar.gz` — 事故后的 `data/` 原样
- `server/data/_legacy-20260917/` — 旧 `users.json` / `quotas.json` / `quota-ledger.jsonl` / `sessions.json`
- `/root/md2pdf-deploy-backup-20260917-*.tar.gz` — 上线前的 `data/`

**防复发**（见提交 `f9c0f04`）：`test/helpers/db.js` 在模块加载时立即校验数据目录，
必须带 `test` 字样且不得是 `server/data`；`package.json` 的 test 脚本显式设置
`MD2PDF_DATA_DIR=/tmp/md2pdf-test-data`。

## 回退步骤

1. `systemctl stop md2pdf-backend`
2. 代码回退：`git checkout 6404bfb`
3. 恢复数据：`cd /root/MD2PDFWeb/server && tar xzf /root/md2pdf-deploy-backup-<时间戳>.tar.gz`
   （注意：恢复后 `data/` 里是被测试污染的文件，需先清掉才能得到干净的文件存储状态）
4. 从 systemd unit 移除 `Environment=MD2PDF_DATABASE_URL=...`
5. `systemctl daemon-reload && systemctl start md2pdf-backend`

数据库 `md2pdf` 可保留不删，回退后不影响运行。

## 上线后待办

管理员账号需要重新注册：

1. 访问 https://md2pdf.qiangi.top/ 用 `qiangi22@163.com` 注册（走邮箱验证码）
2. 重启后端：`systemctl restart md2pdf-backend`
3. 启动时 `MD2PDF_ADMIN_EMAILS` 会把该账号提权为管理员（幂等，每次启动都会检查）

## 验收记录

- 单元/集成测试：143 项全绿（`cd server && npm test`）
- 生产端到端冒烟：27 项全过（临时账号走真实 HTTP 跑完「登录 → 生成码 → 兑换 →
  重复兑换幂等 → 作废 → 导出 CSV → 预扣/退回」，跑完自动清理）
- 迁移幂等：`0001` / `0002` 重复执行均返回空 applied

## 已知取舍

- **会话不迁移**：`sessions.json` 当时为空，所有人本就要重新登录一次
- **`tryReserve` 变为每文件一次 PG 往返**：500 文件任务即 500 次本机回环调用，
  亚毫秒级；换来 `UPDATE ... WHERE remaining >= 1 RETURNING` 的原子扣减
- **`sessionStore.resolve` 的 `last_seen_at` 续期节流 60s**：避免每请求一次写库
- **兑换码存明文**：管理后台可随时重看与再导出；威胁模型是库被拖，缓解手段是
  有效期 + 一键整批作废