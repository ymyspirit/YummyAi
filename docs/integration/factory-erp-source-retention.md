# 工厂导出来源的到期保留与清理

更新于 2026-10-21，PRD 1.1.78。实现和本地技术验收分别记录在[当前进度](../project-control/FACTORY_ERP_LIFECYCLE_PROGRESS_20261021.md)。普通数据库仍为148，本功能尚未在普通环境采用。

## 到期后的实际行为

工厂导出文件有固定30天访问期。到期后立即拒绝新应用和原文读取，网页按服务端的 checkedAt 与单调计时隐藏已展示的原表，不等待下一次刷新。时钟回拨不能使已清除的来源重新可读。

来源的私有内容有三份：imports的文件名、解析选项与原表，bindings的外部编号，observations的逐行原值。0164迁移允许这三处密文在到期后定向置空并登记privateRedactedAt；原ID、校验值、行hash、数量、状态、原请求、原结果及审计保持。独立加密来源证明只含核验所需的非私有声明，不保留原订单号、运单或单元格。

数据库的置空属于业务数据库清文，不承诺擦除已经存在的备份、WAL或底层磁盘块。备份依原备份保留及恢复后删除重放流程管理。对象存储的“已清理”要求实际删除精确源对象的全部版本和删除标记，并再次确认不存在；只写一个删除标记不能完成此状态。

页面区分以下状态，不将404或访问到期当作清理成功：

| 状态 | 页面含义 |
| --- | --- |
| not_due | 尚在访问期 |
| pending | 已到期，原文隐藏，清理待完成 |
| running | 已有有效清理租约 |
| failed | 上次清理未完成，按固定退避等待重试 |
| purged | 数据库私有副本已清除，源对象全部版本已确认不存在，清理回执及审计已提交 |

浏览器期限已到而未取得新服务端凭据时，显示“已到期 原文已隐藏 清理状态待读取”。工厂停用导致原文不可读时，可继续读取本人当前有权的非私有凭据，不据此声称永久删除。

## 数据层与Harness

`factory_erp_source_now()`默认使用数据库实际时钟。只有来源到期及清理租约使用它，订单、制作和其他隐私期限继续使用各自原时钟；验收仅在精确一次性数据库保存、调整并恢复该函数。

维护任务使用固定系统actor 0009和租户事务，不取得用户成员身份。迁移禁止该actor加入memberships。所有表强制RLS；应用仍以非owner角色操作。新应用、绑定和观察在提交前锁定原来源，避免清理后才提交新的私有副本。

每个短事务先清三处私有密文，再建立`factory_erp_source_purges`持久任务与source_redacted审计，缺少同事务闭包则回滚。领取任务采用行锁和SKIP LOCKED，固定原对象指针、密文SHA、尝试数、租约token和期限；事务提交后才进行S3 I/O。

Storage复用现有开源AWS SDK。逐页ListObjectVersions并严格筛选完整原key，使用原VersionId逐个删除，兼容未版本化对象的null版本。不得删除同前缀的邻居对象。403、桶不存在、分页异常和无法确认缺失都算失败；不绕过对象锁。删除完再次列举并确认原对象不存在、桶仍可访问。

只有有效原租约可以提交完成。source_purged回执和审计同事务；响应丢失后，同token可读取已提交结果，即使租约时间随后已到也不重复审计。失败释放租约并按30秒起、最多15分钟退避。进程中断或删除成功后写库失败时，新进程重核缺失再完成，不能凭一次尝试记成功。

Worker的`factoryErpSourceRetentionScheduler`在同租户短事务领取最多5个任务，每个实际S3请求受20秒AbortSignal约束，60秒租约；并行处理已领取任务。关闭过程等待I/O真正结束。独立本地入口`tools/scripts/factory-erp-source-retention-runtime.mjs`只运行该维护器，固定`WORKER_QUEUES=none`，不启动生产、模型或其他业务消费。

## 本人查询与原回执

以下GET归原factory-erp-import owner，全部重新核对当前四个tenant范围读取权限，并由个人会话BFF有界转发、严格验证响应，不返回文件名、对象路径、租约、原单号或单元格：

| GET /v1/factory-erp-imports 后缀 | 用途 |
| --- | --- |
| /lifecycle | 包含到期来源的完整游标分页 |
| /:id/lifecycle | 原ID的访问与清理凭据 |
| /:id/applications | 原应用历史的游标分页 |
| /:id/applications/:applicationId | 原不可变应用回执 |

成功应用在到期后仍可由原身份、原键及完全相同的请求体恢复旧回执；新请求或不同正文不能绕过到期限制。GET本身不执行清理或业务应用。撤权清除页面私文及待确认意图。知识库和Agent不自动索引、引用或再生成这些私有原文。

清理不改变已排产、工厂已发货或作废异常，不改原生产状态、质检、实际数量或物流凭据。来源保留任务本身不解除关联；绑定错误通过另行实现的[解除与更正入口](factory-erp-binding-corrections.md)明确核对并登记，旧观察仍归原组，当前普通采用边界见[更正进度](../project-control/FACTORY_ERP_BINDING_PROGRESS_20261021.md)。

## 运行与验收边界

沿用现有数据库、Redis、S3及私有密钥环境变量，不新增提供方凭据。来源保留由0164引入，当前源码另含0165，禁止从该工作树盲目启动或迁移普通148。受控采用前仍需配对备份、恢复验证、升级及业务核对。

隔离入口为`--suite=factory-erp-source-retention-integration`、`--suite=factory-erp-source-retention-upgrade-integration`和`--suite=factory-erp-source-retention-browser`。统一执行器在连接前要求两项factory隔离旗标、精确nonce数据库/桶和current或pre-0164目标。升级还要求重新核验的真实163源码目录`E2E_FACTORY_ERP_SOURCE_RETENTION_LEGACY_SOURCE`。浏览器使用新封存候选及`--compiled-web --candidate=<本次ID>`，普通Web审批拒绝不通过该入口绕过。

参考既有机制的官方定义：[S3 DeleteObject](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)、[ListObjectVersions](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListObjectVersions.html)、[PostgreSQL SELECT锁语义](https://www.postgresql.org/docs/current/sql-select.html)。
