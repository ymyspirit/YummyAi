# 发票纠正与后到货核对接口

0151只在隔离环境验收，普通数据库仍148。业务边界见[设计](../architecture/procurement-invoice-reconciliation.md)，验收、清理和恢复见[最新进度](../project-control/INVOICE_RECONCILIATION_PROGRESS_20261021.md)。

## 当前身份与读取

API使用现有采购命令边界；新增GET /v1/procurement/invoice-reconciliations和GET /v1/procurement/invoice-reconciliations/:invoiceId，Web使用/api/procurement-invoice-reconciliations及其单ID路径。列表支持before、purchaseOrderId及pendingOnly=true/false，严格拒绝重复或未知查询，最多50项并返回游标和不可读计数。分页前应用待审核/原PO筛选，详情重新授权并计算当前余额；输入租户ID不能替代已验证成员身份。

ProcurementRead允许读取实际详情，ProcurementWrite允许登记凭证，ProcurementApprove允许审核或匹配。只有审批权限的成员也可匹配。每次准备/执行按保存时权限上限与当前权限交集授权；已成功历史命令在仍有Read时可恢复结果，prepared失去所需权限仍403。

## 三种持久处理

通过现有采购commands prepare/execute/get/list/cancel/ack，kind=invoice_reconcile，targetId始终为原发票ID。input为严格联合：adjustment_record携带真实单据/明细；adjustment_review引用pending事件ID及approved/rejected；receipt_match携带真实invoiceLineId/receiptLineId/quantity/unit。每个分支都要expectedFingerprint、reason和idempotencyKey；不允许调用方伪造结果或执行时替换正文。

数量最多9位小数，件/双/套为整数。纯金额补差数量固定0；新数量开票继续invoice_record。凭证号按供应商/种类/规范号唯一，本版一单据只关联一张原票。当前余额按真实事实重算，命令事件的balance只代表执行时。确认已读不等于批准，也不修改库存或付款。

## 专项运行

所有TSX调用显式设置TSX_DISABLE_CACHE=1，Vitest使用--cache=false。当前集成入口为pnpm test:e2e:order-daily --suite=invoice-reconciliation-integration --cache=false；只有该隔离suite允许它拥有的两次真实API故障注入。升级使用--suite=invoice-reconciliation-upgrade-integration，必须提供E2E_INVOICE_RECONCILIATION_LEGACY_SOURCE的真正150旧源，并按源码测试中记录验证受保护148旧源；runner实际先建148，不能用151源码冒充旧服务。

浏览器使用--suite=invoice-reconciliation-browser --compiled-web --candidate <新自有候选>，个人夹具和端口由runner拥有，与普通应用分开。当前两个临时候选和旧150复制已清理，历史路径不能复用。每次必须另设YUMMYAI_TEST_CACHE_DIR为新自有目录，验收后核对DB/桶/Redis不存在并按精确清单删除自有文件及junction。不要启动普通Web作为隔离检查的替代。
