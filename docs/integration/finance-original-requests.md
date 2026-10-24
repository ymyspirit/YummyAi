# 财务原提交与跨会话恢复

状态：2026-10-21 PRD1.1.66，122单元/规则、111集成和同编译12条受影响页面分批通过并完成本批清理；普通数据库仍148、0157未普通采用，财务工作包尚未全部业务验收。详见[验证进度](../project-control/FINANCE_COMMAND_PROGRESS_20261021.md)。

`/finance/originals` 是独立本人入口，不依赖需要 FinanceRead 的业务工作台。原应付六类、费用归属两类入口使用同一命令流程；新增来源报表、历史汇率、利润口径及汇总计算四类结构化表单。实际记账、核销、更正、计算与版本批准仍属于原来的四个 Finance owner。

## 操作与实际结果

| kind | 固定目标 | 不可变结果 |
| --- | --- | --- |
| statement_record | 新建范围 | 报表ID |
| fx_rate_record | 新建范围 | 历史汇率ID |
| metric_upsert | 原metric ID或新建范围 | metric version ID及原版本号 |
| profit_calculate | 原metric ID | 原profit run ID |
| bill_record | 新建范围 | 原应付ID |
| payment_record | 新建范围 | 已发生付款证据ID |
| payment_allocate | 原payment ID | allocation batch ID |
| allocation_release | 原allocation ID | release event ID |
| bill_adjustment_record | 原bill ID | adjustment event ID |
| payment_adjustment_record | 原payment ID | adjustment event ID |
| cost_version_approve | 原allocation ID或新建范围 | allocation version ID及原版本号 |
| allocated_profit_calculate | 原base run ID | allocated run ID |

准备保存完整正文、原key、固定业务目标、权限快照与独立摘要，尚不记账。用户读取原填写并明确执行后，一个顶层 `withTenant()` 事务调用实际 owner，提交原业务、原审计、结果凭据及命令审计。读取不执行；提交前断开仍为prepared，提交后断开读取实际succeeded。收到不确定响应后，按原命令核对，不创建另一key替代未知结果。

确认仅清理本人填写副本；取消仅终止未执行准备。两者均不冲销事实、不执行银行转账或退款，不释放原命令key。已绑定命令的key不能绕回raw入口；原有非命令raw请求仍保留旧摘要和精确重放。旧事实、换key命中的同业务凭据和历史NULL不会追认为新命令成功。

## API与隐私

- `POST /v1/finance/commands` 准备，201；列表与 `GET /:id` 只返回小摘要和真实结果引用。
- `GET /:id/original` 明确读取单份完整原文，携带当前contextAuthority。
- `POST /:id/execute`、`cancel`、`acknowledge` 严格接受 `{}`，200；无正文、null和额外字段拒绝。
- 查询 `kind`、`targetId`、`before`；`targetId=root` 是明确的新建范围。列表每页最多50项，按原候选页推进游标，隐藏失权记录并报告数量，不因一条不可读记录饿死后续记录。
- 所有响应private/no-store。Web BFF仅同源写入，严格校验输入、回执ID与类型，受限传输，不转发私有数据库错误。

Write四类登记与Review八类操作分别要求当前对应权限及tenant范围。本人窄读允许当前FinanceRead或该操作权限，兼容Write-only和Review-only；执行再取准备权限、当前会话及数据库当前成员的逐权限交集。不能利用后来新增角色扩大旧准备权限，也不能利用本人窄读遍历其他账本。

原报表20,000行及现有28MiB HTTP请求边界保留；规范化及加密envelope完整UTF-8最多32MiB，密文最多45MiB。超限明确拒绝，不裁剪行数。列表不读取密文或大权限blob；详情和原文单笔读取。使用独立 `FINANCE_COMMAND_ENCRYPTION_KEY`，生产必须提供32字节base64url密钥，禁止复用模型、订单PII、采购或集成密钥。错密钥暂时阻断，保留密文供恢复。

## 数据库与维护

0157新增本人命令、数据库自动实际写入凭据及来源行索引。十二个实际owner表的INSERT触发器从真实列重建独立body摘要，铸造完整事务ID，应用仅可读凭据。命令成功必须绑定同一事务、原操作者、原kind/key/target/body；反向deferred约束要求实际结果与原owner/命令审计完整提交。应用session标记本身不能证明成功。历史事实与原迁移不回填、不改写。

未来报表的来源行索引由真实statement INSERT一次生成，按tenant/statement/lineKey查找，避免逐事实扫描完整两万行正文。原金额、字段、来源、关系及封闭审计检查保持，索引也仅应用可读、不可变并绑定完整创建事务。

七天使用数据库时钟。确认、取消或到期只清理留存填写，最小技术凭据、业务事实和原审计保留。维护入口 `tools/scripts/finance-command-retention-runtime.mjs` 固定 `WORKER_QUEUES=none` 和单一 `financeCommandRetentionScheduler`，不自动执行prepared。请按普通采用流程完成备份、独立恢复升级、源码配对和实际身份验收后再部署；不要从本开发树直接启动普通148服务。

## 当前恢复显示边界

跨会话核对提供原输入、固定版本/预览校验值、真实ID及版本回执。更正时的历史balanceAfter、分摊旧预览的全部shares/尾差未并入命令回执，需通过已有受权业务阅读器核对，不能拿今天的余额或重跑预览冒称当时结果。这项显示范围不代表完整财务业务验收。

专项运行使用 `run-order-daily-acceptance.mts` 的 `finance-command-business-integration`、`finance-command-guard-integration`、`finance-command-process-integration`、`finance-command-upgrade-integration`、`finance-command-read-lock-integration`、`finance-command-browser`。升级要求逐字节核验的实际156源码。每批仅一次性数据库、桶、Redis、个人身份服务和自有输出，结束后独立核对清理，普通服务和模型渠道不参与。
