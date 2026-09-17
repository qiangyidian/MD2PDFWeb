-- 0002：放宽 ck_redeem_used
--
-- 0001 的约束要求 status = 'used' 时 used_by 与 used_at 都非空。
-- 但 redeem_codes.used_by 的外键是 ON DELETE SET NULL：管理员删除一个
-- 兑换过码的用户时，外键把 used_by 置空，随即撞上这条 CHECK，
-- 结果是「删不掉兑换过码的用户」，删除接口直接 500。
--
-- （这不是推测：生产冒烟测试的清理步骤真实踩到——
--   new row for relation "redeem_codes" violates check constraint "ck_redeem_used"）
--
-- 语义上真正要守的不变量是「已使用的码必须有兑付时间」：过期判定与审计都依赖它。
-- 兑付人身份在用户被删除后本就无法保留，不该作为硬约束。
-- 兑付人未删时仍可追溯；被删后该字段为 NULL，表示「兑付人已注销」。

ALTER TABLE redeem_codes DROP CONSTRAINT IF EXISTS ck_redeem_used;
ALTER TABLE redeem_codes ADD CONSTRAINT ck_redeem_used CHECK (
  status <> 'used' OR used_at IS NOT NULL
);