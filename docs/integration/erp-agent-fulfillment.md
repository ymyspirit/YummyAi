# ERP Agent 的原履约依据读取

2026-10-22 · PRD1.1.97 · 6e2a9c74 · 本批局部技术验证及自有清理通过，尚未采用到日常环境。

这一批建立独立 `erp-agent-fulfillment-v1` 来源协议，将同一原订单下的生产、交付、工厂表格观察、质检、实际发货及物流记录提供给本人界面和显式允许的外部 Agent。它是全 ERP 接入的一个业务切片；旧 native-v1/v2 模型任务保持原来的十一类读取范围，新协议尚未加入付费模型循环。

## 入口和来源

个人 API 为 `/v1/agent-fulfillment/workspace`、`definition`、`candidates` 和 `call`；BFF 对应 `/api/agent-fulfillment/*`。只接受当前本人 OIDC 会话，复核当前成员逐项权限。浏览来源不需要 WorkflowRead，仍需原领域的 tenant 范围权限。未配置 API、加载、无候选、缺权限、到期、失败和集合变化均明确显示。

唯一工具为 `orders.fulfillment`。操作者固定原订单和事件序号，每次明确选择 production、shipments 或 logistics。候选沿原 OrderReadOwner/OrderService 的筛选和上限，只取必要 metadata；非正事件序号仅作防御性排除并计数，不补造事件。当前数据库原约束与默认值均要求正序号，本批没有合法零序号数据库历史反例。原整单详情从 OrderWorkspaceService 同事务返回真实 orderSequence；历史 DTO 缺序号或序号为零时不从商品 revision 猜值。页面打开只读取工作区，读取业务依据须点击按钮。

production 引用原生产投影及当前版本、制造 pin、里程碑、数量依据、原质检物理组、原正式交付包和工厂 Excel 观察。交付文件 SHA、制造内容 SHA、制造计划 SHA、包 SHA 分别保留。工厂观察须具备 OrderRead、OrderPiiRead、DesignRead、AssetRead 四项 tenant 权限；缺失时只隐藏该段。私有表格到期时原行值不返回；长期非私有回执仍由原模块解释。没有规则快照的历史制作任务继续显式缺失，不用新规则回填。

shipments 引用原运单版本、包裹与商品分配、生产版本和质检组分配、原实际交运聚合、轨迹状态、平台回执。trackingPresent 只说明原值存在，不包含运单号。工厂“已审核＝已排产”“已出库＝工厂已发货”“已作废＝异常待核对”分别保留；不能据此推导内部质检、实际数量、承运揽收或平台确认。面单完成也不能代替实际交运。

logistics 引用已有任务、连接版本、规则版本、生产版本和原快照 SHA，金额保留整数最小货币单位、币种及精度。报价、实际费用及未知值分开。OrderRead 与 OrderPiiRead 均需 tenant 范围。到期、地址撤回或原私有快照不存在时，trackingCount 和 labelCount 为 null，而不是零。

## Harness 与纯读取边界

复用锁定的 Zod、Nest、Drizzle/PostgreSQL、React/Lucide、MCP 官方 SDK 和现有 HarnessRegistry，不增加依赖或数据库迁移，schema 仍为176。独立 Skill、输入输出、权限政策与执行契约固定版本。原作废摘要的 UUID transform 通过 safeExtend 换成可描述为 JSON Schema 的同值规范化；原结构、约束和全部 refinement 保留，旧契约不改，也不采用任意类型降级。每次调用核验执行 pin、定义 SHA、原单修订、索引集合和页位置，并在读取前后重新核验当前成员及原来源。单次30秒结果期限不等于数据库查询会被中止；最多8MiB输出。

每页1至10条，默认5条；原 owner 索引按 ID 排序，最多10000条，超出显式拒绝。游标绑定原单、事件序号、种类、页大小和集合 SHA。子历史最多200条，包裹商品及生产分配最多1000条，各自返回原数量和截断标识。所有 coverage.complete 固定 false，不能把某页或索引读完称为整个业务已完整收集。子 owner 原有内部查询仍可能先加载较多历史，此处不承诺所有内部 I/O 已改成分页。

多次 owner 读取以原单、集合、投影及权限的前后复核保护，结果声明 `owner_reads_fenced_not_single_transaction_snapshot`，不声称整个结果是同一事务快照。段落无法读取保留独立原因；不补零、不把错误变成空记录。共享 transport 复核调用、原对象、版本关系、输入及数据 SHA，拒绝重新计算 SHA 后仍串单的投影。

新 LogisticsReadOwner 只调用租户查询和解密器，不包含 provider、对象存储、队列或 purge。旧 HTTP 物流入口仍按原逻辑先执行保留清理，再委托纯读取；原延迟 retention job 和 Worker 清理保持。现有实现尚未证明独立周期补扫，不能宣称完整清理补偿已经覆盖。新读取会先隐藏失效资料，但不代替物理清理。

不返回客户地址、联系方式、定制正文、下载路径、运单号、模型凭据或秘密。不调用模型，不新增任务，不批准、排产、发货、购单、同步、付款、发布或联系工厂。生产、质检、交付和物流数据仍由原模块拥有；Agent 不另建事实库。

## 外部 Agent

本机 MCP 只有可信启动时明确加入 `--allow-fulfillment` 才暴露 `fulfillment/orders.fulfillment`。默认五个 MCP 协议入口、旧49项目录和旧工具/资源/任务 ABI 保持；新能力可加载真实定义、取得有界候选、调用上述纯读取。MCP 复用当前本人会话，不接受原始 tenant 或任意 API URL。真实用户 Agent 宿主配置与远程 OAuth 另行验证。

## 验收、续做与采用

新增 disposable suite 为 `agent-fulfillment-integration` 和 `agent-fulfillment-browser`。连接前要求 FULFILLMENT、FACTORY_ERP_IMPORT、AGENT_RESOURCES、AGENT_READ、ROLE_BENCHMARK、KNOWLEDGE_EVALUATION、DAILY 七隔离标志及 current/同 nonce DB、私有桶和 Redis；浏览器只使用本人编译3130/8130。原单 admitted 输入是合成夹具，正式 JPG 渲染、release、交付、表格导入、质检和发货走原服务；这些合成上游工作项没有 Rule Center 快照，按 legacy 保留且不回填今天规则；这不证明无人设计、真实工厂生产或承运商揽收。模型及付费调用为零。

专项验收结论及清理结果在[本批进度](../project-control/ERP_AGENT_FULFILLMENT_PROGRESS_20261022.md)维护。全平台48需求、54工作包和8阶段保持，知识、无限画布、批量设计、无人设计继续保留。普通148及其2598源不直接使用当前176启动；配套采用、恢复演练、CI、真实模型质量和账单、其余领域及完整业务验收继续。

本批23项去重功能、3规则和4隔离组通过，含本人编译桌面/390真实页面及权限收窄后的旧正文丢弃。8组一次性DB/私有桶/Redis前后独立查无，本批10个自有目标/2970文件/3个仅链接已清；旧拒绝报告仍保留且未重试。原生产数据、Excel和备份保持。当前编译Web输入未变，最终全源与构建摘要差别见[源码关系](../project-control/checkpoints/2026-10-22-agent-fulfillment-6e2a9c74-source-equivalence.json)。
