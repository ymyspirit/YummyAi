# 外部集成、开源复用与证据台账

<!-- studio-paid-image-73e2c9b1-current -->
PRD1.1.127 继续复用固定Infinite Canvas与sub2api接入，保留上游文件字节；图片操作员预估独立于文本token计价，缺实际账单不填零。当前为开发与隔离验收中，事实以[本片进度](../project-control/STUDIO_PAID_IMAGE_PROGRESS_20261024.md)及[专项契约](../integration/studio-paid-image.md)为准。以下旧版本保留当时状态。
<!-- /studio-paid-image-73e2c9b1-current -->

PRD1.1.126 复用现有开源Infinite Canvas、PostgreSQL/Drizzle、Sharp和ClamAV与原vault/存储，无新外部依赖。本片开始实施，尚未验收或采用，当前事实以[本片进度](../project-control/CREATIVE_RESPONSE_ADOPTION_PROGRESS_20261024.md)及[采用契约](../integration/creative-response-adoption.md)为准。下方旧版本段落保留对应历史时点的状态。

1.1.122启动协调复用现有开源Node.js 24.17运行时与操作系统锁，无新增生产依赖、数据库迁移或锁文件变化。Windows沿用既有命名管道命名空间，嵌套只借用同进程/同根活gate，避免重复加锁；行为、定向证据及支持入口见[协调契约](../integration/runtime-startup-serialization.md)。此处不声称Node进程退出后外部Docker工作也已终止。

<!-- studio-original-c14d7a62-current -->
1.1.120 原件检查、固定方案送审与画布隔离已通过本批定向验收并采用本机日用187：16项去重API、2项最终同源编译页面，原件事实和断线原回执可查，A/B画布及原viewport恢复互不串写，同工作区重复通知不再取消检查。vendor184原字节保留，自有adapter2.3.0；一个yummyai组12个独立容器，原46单、29业务备份及1036队列保持。本批自有raw/缓存与unused构建已定向清理；历史冻结项按台账保留。真实付费及普通Worker关闭，全平台48需求/54包/43进行中/11待核验/0完整技术/0业务验收不变。 见[实施规格](../integration/studio-original-handoff.md)及[本片进度](../project-control/STUDIO_ORIGINAL_PROGRESS_20261024.md)。
<!-- /studio-original-c14d7a62-current -->

<!-- shipment-create-0c7e35a1-current -->
1.1.118 原部分数量 多包裹与本人来源核对表单已通过本片定向验证并应用本机日用187 支持原AFC准备 确认和原键恢复 数据库无升级 真实付费关闭 全平台与业务验收继续 见[装箱工作区](../integration/shipment-create-workspace.md)及[本片交付](../project-control/SHIPMENT_CREATE_PROGRESS_20261023.md)
<!-- /shipment-create-0c7e35a1-current -->

<!-- e7c41a92-current -->
1.1.117 实施独立native-v4的51项模型提案与原表单本人补项 同一原履约确认及三层原键恢复 先开发 暂不启用真实付费调用 未验收 日用186保持 见[履约模型提案](../integration/erp-agent-native-v4.md)
<!-- /e7c41a92-current -->

<!-- d6b2f901-current -->
1.1.116 原14类履约的独立版本Agent准备 核对 确认及只读恢复已过42项定向检查 日用已配对升级186并完成本批清理 原13表单可达 旧37与native-v3保留 新模型提案协议及完整平台仍未验收 见[履约Agent适配](../integration/erp-agent-fulfillment-command.md)
<!-- /d6b2f901-current -->

<!-- a4d9e821-current -->
1.1.115 订单摘要来源状态及晚清理防护已定向验收并应用日用185 区分可用 已清理 到期 归档和暂时失败 7契约 9原拥有者接口及2个人编译页通过 1440/390实测 保留原账户及46单 本批临时输出已清理 无数据库迁移 全平台继续推进 见[摘要状态契约](../integration/order-summary-availability.md)
<!-- /a4d9e821-current -->

<!-- c1e5a7b9-current -->
1.1.114 同单履约原提交与只读恢复已定向验收并采用185 覆盖十四类交付 进度 质检 补做 包裹与交运操作 15单元 28接口 真184升级及2个人编译页通过 工厂表格状态仍独立于质检和实际交运 未重复全平台套件或CI 全平台继续推进 见[履约恢复契约](../integration/order-fulfillment-command.md)
<!-- /c1e5a7b9-current -->

<!-- 3f7c2a91-current -->
1.1.113 原采购发票到财务应付的首类持久依赖已完成本批定向验证并接入本机日用184 前置真实凭据与每步原确认保留 17单元 8接口 真正183升级及2条同候选本人页面通过 备份恢复与自有清理另有实证 全平台仍进行中 见[依赖计划契约](../integration/agent-dependency-plan.md)
<!-- /3f7c2a91-current -->

<!-- 5a91d7c3-current -->
1.1.112 独立 Agent 执行服务观察已定向验证并采用到原账户日用183 消费循环与实际恢复调度按同实例核对 短时证明只影响网页新提交 原五类任务和回执保持 五组测试资源与本批自有输出已清 普通消费者仍关闭 真实模型和完整平台另验 见[本批结论](../project-control/checkpoints/2026-10-23-agent-runtime-readiness-5a91d7c3-evidence.json)
<!-- /5a91d7c3-current -->

<!-- 8b2c6d14-current -->
1.1.111 MCP五family只读诊断已按显式启动允许范围接入原五协议入口 原ERP诊断与本机策略分开 17功能用例及2guard通过并采用到原账户日用183 两组资源及本批自有输出已清 实际MCP宿主和模型/消费者仍待独立验收 全平台继续 见[本批交付结论](../project-control/checkpoints/2026-10-23-agent-mcp-readiness-8b2c6d14-evidence.json)
<!-- /8b2c6d14-current -->

<!-- f4b6d2a9-current -->
1.1.110 Agent五family只读诊断及独立费用入口已定向技术验证并采用到原账户日用183 原四文本模型保留 实际阻断为缺报价和正任务上限 六组隔离资源及本批自有输出已清 全平台与真实付费执行仍未验收 见[交付结论](../project-control/checkpoints/2026-10-23-agent-readiness-f4b6d2a9-evidence.json)
<!-- /f4b6d2a9-current -->

<!-- c8e4a173-current -->
1.1.109 原日用ERP已从148受控采用183迁移版本 网页与API源快照及候选一致 localhost:3000原账户和56权限逐bit范围保持 七个副本真实页面及原日用订单与首页验收通过 原353表105925条记录 148账本前缀及1834私有文件严格保留 已修复Next生产归一loopback导致BFF摘要误拒 9回归通过 见[本批验收](../project-control/checkpoints/2026-10-23-ordinary-adoption-c8e4a173-evidence.json)与[升级保全契约](../integration/legacy-runtime-upgrade.md)

本批6个临时目录及淘汰候选已清理 15副本数据库7桶3临时客户端及Redis均已清空 原有19备份目录保持并新增2份验证备份 必要访问审计及既有冻结共享缓存保留 Worker未启动 1036队列保留 完整48需求54工作包8阶段仍继续 实际AI运行与真实店铺发布继续按原服务器能力 预算和授权显式验收
<!-- /c8e4a173-current -->

1.1.87完成两项原业务owner读取与部分普通Assist跨刷新恢复的本地验证：订单异常元数据、精确库存余额使用固定Harness契约、完整分页和当前逐项权限；统一工作台及AssistPanel/BusinessAssist按原键GET找回回执，不重复付费提交。43项去重定向检查含两条个人编译浏览器通过；本批输出和8组隔离资源已清并独立复核。旧11域24项覆盖目录仍不可调用，其他Agent工具、跨域计划与MCP继续；普通148未采用171，完整48需求/54工作包/8阶段及B27缺口保持。见[运行契约](../integration/erp-agent-read-tools.md)及[进度](../project-control/ERP_AGENT_READ_PROGRESS_20261022.md)。以下旧版本段落保留当时状态，当前范围以本段和专项为准。

1.1.86实现ERP Agent委派前置：固定原membership/逐bit范围/团队并与当前权限相交，旧NULL凭据须重签；创建/撤销事件与审计同事务。原开放集成区域新增个人管理和11域24项只读能力覆盖描述，全部统一adapter/MCP仍待接入。本批36项去重定向检查（含同编译2条个人浏览器）通过；6组隔离资源及9个本地目标清理前后均独立核对。普通148未采用，完整48需求/54工作包/8阶段及B27缺口继续。见[运行契约](../integration/erp-agent-delegation.md)及[进度](../project-control/ERP_AGENT_DELEGATION_PROGRESS_20261022.md)。

1.1.85补全ERP统一Agent接入规格与源码覆盖表：扩现有AI任务工作台，内置与外部Agent共用受控工具及原业务拥有者。当前九类Assist、部分工作流和原命令可复用；全域委派、跨模块工具网关和MCP仍待实现。本轮仅勘察及规格，不增加功能通过数；1.1.84局部72项及清理保持。完整48需求/54工作包/8阶段不缩小，见[接入规格](18-erp-agent-integration-specification.md)及[本轮进度](../project-control/ERP_AGENT_INTEGRATION_PROGRESS_20261022.md)。

1.1.71实现广告七类完整原填写、原幂等键和跨会话恢复。准备、列表和原文读取不执行，操作者明确核对后由原owner同事务产生实际不可变结果、fullxid证明及双审计。独立密钥、七天数据库时钟留存，取消/确认/到期只清原文，原事实和键保留。99项单元/规则、39项去重集成、同编译3条个人OIDC页面验证通过；本批输出已清理，普通148未采用158，完整平台与业务验收继续。

应付与采购退款流程参考开源ERPNext的[Payment Entry](https://docs.frappe.io/erpnext/payment-entry)及[Debit Note](https://docs.frappe.io/erpnext/debit-note)，借鉴发票、分配和已发生退款各自留痕的流程，代码沿用YummyAI现有拥有者与SQL约束，没有引入另一套财务事实库。

1.1.57先研究开源ERPNext采购贷项与退回，采用关联原票和财务/实物效果分离的对象边界；实现继续复用现有Zod、PostgreSQL/Drizzle、个人OIDC、Lucide及ERP交互，未加依赖。新GET实际核对入口和原九类命令均走当前个人BFF及API授权。原本地Responses配置加密保留；当前普通API与本地模型代理未运行，本轮未重验鉴权或生成，不沿用历史可用结论。见[发票纠正设计](../architecture/procurement-invoice-reconciliation.md)与[供应商凭证与后到货验收](../project-control/INVOICE_RECONCILIATION_PROGRESS_20261021.md)。

1.1.56复用原Zod/PostgreSQL/Drizzle、个人OIDC、Lucide与ERP组件，无新增依赖；发票业务对象关系参考开源ERPNext。新UI统一走/api/procurement-commands/commands及原REST命令入口，既有raw invoices/BFF继续兼容。ERP已授权回读本地Responses通道enabled，使用库中加密密钥实际鉴权目录成功19模型且含gpt-6.1-sol；本轮无生成请求、不改其他默认值。见[发票命令设计](../architecture/procurement-invoice-commands.md)与[发票原提交验收](../project-control/INVOICE_COMMAND_PROGRESS_20261020.md)。

1.1.55的采购与库存单位分离参考ERPNext购买单位/按单位价格及Odoo同类单位的公开设计，沿用本仓库BigInt、PostgreSQL numeric、Zod及原业务拥有者，不新增依赖或照搬浮点舍入。新个人发票BFF复用已有同源、个人OIDC及apiFetch，POST /api/procurement-invoices/:purchaseOrderId对应原REST invoices入口。原本地Responses渠道与加密凭据保留，本轮新增实际模型调用为零。来源与实现差异见[计量与发票设计](../architecture/procurement-measurement-and-invoices.md)。

生产持久恢复继续复用现有开源PostgreSQL/Drizzle、Nest、Zod、React/Next与Lucide及原生产服务；新增薄适配与事务凭据，不引入新的工作流数据库或第三方依赖。API/状态与实际验证见[生产恢复](../integration/production-command-recovery.md)。

1.1.42沿用已有POD/创作调度的内部租户选择模式补强工作流维护隔离，并在库存拥有者复用PostgreSQL共享/排他事务咨询锁。没有新增框架或依赖版本。库存并发按[库存契约](../integration/inventory.md)和[本批记录](../project-control/EXECUTION_ISOLATION_PROGRESS_20261020.md)验证，未移植另一套ERP的账本事实。

核对日期：2026-10-15。外部资料只构成能力线索或规则依据；真实账户、权限、版本、限频、费用及返回数据仍须受控验收。

## 1. 先看开源，再决定做什么

| 项目 | 本次核对来源与范围 | 决策 | 理由 |
| --- | --- | --- | --- |
| ERPNext | [官方仓库](https://github.com/frappe/erpnext)、[许可说明](https://frappe.io/erpnext/license-trademark)，代码 GPLv3 | 研究制造、采购、库存、工单与质检模型；可评估财务/制造系统对接 | 通用 ERP 能力完整；不能直接替代现有定制版本链与租户策略 |
| Medusa | [官方仓库](https://github.com/medusajs/medusa)、[模块文档](https://docs.medusajs.com/resources/commerce-modules)，核心 MIT，企业材料单独许可 | 参考订单、库存和履约模块边界；本版不整体迁移 | 核心电商模型可借鉴；多套框架并存会增加运行和迁移成本 |
| Fabric.js | [官方仓库](https://github.com/fabricjs/fabric.js)，MIT；当前 web 已声明 fabric 7.4.0 | 复用现有编辑与图形能力 | 避免重复画布引擎；生产检查继续由服务端负责 |
| BullMQ | [官方仓库](https://github.com/taskforcesh/bullmq)、[幂等模式](https://docs.bullmq.io/patterns/idempotent-jobs)，MIT | 复用现有队列，补数据库持久意图与对账 | 队列重试不等于外部付费动作可重复执行 |
| Next Shadcn Dashboard Starter | [官方仓库](https://github.com/Kiranism/next-shadcn-dashboard-starter)，MIT | 参考布局、数据表和表单，不复制认证及账单系统 | 与现有 Next/React 工作台接近，改动可局限在 UI |
| shadcn/ui | [官方数据表文档](https://ui.shadcn.com/docs/components/data-table) | 按需参考已有组件模式 | 优先保留当前组件与状态习惯，避免为视觉重装架构 |
| Lucide | [官方许可](https://lucide.dev/license)，ISC | 沿用现有开源图标 | 统一按钮、导航和状态语言；原型内嵌已有包导出的图标 |
| PostgreSQL RLS | [官方说明](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | 沿用非 owner 与 FORCE RLS 边界 | 表 owner、超级用户和 BYPASSRLS 有特殊行为，应用凭据不能承担这些角色 |

这些是选择与适配结论，不声称已经安装、集成或验证所有上游功能。采用源码时固定 commit/version 并保留对应许可；企业版材料不按核心开源许可推断。现有 Infinite Canvas vendor 边界继续沿用项目的升级和校验流程。

## 2. 买、接、建的落地选择

1.1.51的中心与店铺节点方案优先沿用上表已有开源及内部模块：PostgreSQL/Drizzle 保存中央业务事实与持久意图，BullMQ/Worker 处理派发，Nest/共享 Zod 契约承载受限接口，现有 marketplace-connectors 提供平台执行适配。节点是独立部署目标，统一 MCP 是中央集成入口；具体 SDK、制品和协议版本在实施时依据现有锁文件与官方接口重新核验。本次没有新增第三方依赖或部署节点。[总体架构](03-system-architecture.md)明确各部分权限和数据边界。

SIF、XYDC、SellerSprite、Sorftime 及其他数据/模型/媒体工具的完整品牌、身份和最低能力以[专项最终范围](../upgrade-plans/data-tools-mcp-2026-10-18/FINAL-INTEGRATION-SCOPE.md)、[56项连接器目录](../upgrade-plans/data-tools-mcp-2026-10-18/INTEGRATION-CATALOG.md)及其结构化登记为准。官方 MCP、API、合同数据和本地推理分别准入；节点部署决策不扩大供应商授权、转售权或实际接口能力，现有证据状态保持。

| 能力 | 首选策略 | 自建的独特部分 |
| --- | --- | --- |
| 身份、对象存储、监控 | 复用成熟基础设施与当前集成 | 租户、工厂对象关系和数据分域 |
| 图形引擎与编辑基础 | 复用 Fabric 与现有画布 | 定制字段、多面配方、实际像素与工艺检查 |
| 财务总账、报税 | 评估现有会计系统与导出/接口 | 订单制造成本、返工、供应商证据与管理利润 |
| 通用库存采购 | 沿用已建模块并评估与外部 ERP 的职责 | 按单生产的坯料、工艺、配方及数量关联 |
| 店铺与物流 | 官方接口或已验证服务商 | 能力台账、固定意图、失败恢复与对账 |
| AI 模型 | 可替换路由与少量候选实测 | 业务快照、授权工具、质量门禁和成本控制 |
| 工厂网络 | 简单门户/交付包起步，对接已有 ERP | 能力核验、指定版本回执、质检和结算关系 |

每一项购买都核对数据导出、退出成本、接口权限与维护责任。每一项自建都给出高频需求或独特价值，不只因为能写代码。

## 3. 平台与服务能力台账

| 集成 | 工作树依据 | 本轮证据级别 | 下一次必须验证 |
| --- | --- | --- | --- |
| Amazon Custom 履约 | [官方项目说明](https://sell.amazon.com/programs/custom) | 官方要求卖家履约；支持图片、文字与配置型定制 | 对应站点、类目和真实 ASIN 的定制能力与限制 |
| Amazon 订单报告 | [官方字段](https://developer-docs.amazon/sp-api/docs/report-type-values-order)、本地 amazon-order-reports.md | 官方列定制链接字段；本地有导入/解析/版本文档与源码 | 获授权样本逐行核对文字、选项、原图、预览和保留期 |
| Amazon SP-API 读取 | 当前 marketplace-connectors、orders 与授权模块 | 有连接器和接单抽象；本轮未做账户 live 调用 | 固定准确 Seller Orders 版本、角色与响应；不把 Vendor 接口样例混用 |
| 普通 Listing 发布与同步 | 本地 marketplace-accounts / publications 文档及源码 | 有授权、能力与发布结构；不是本轮上线证明 | 精确账户操作权限、类目 Schema、提交/接受/可售的实际结果 |
| Custom 配置与批量资料 | 官方 Custom 页面指向 Seller Central 批量流程 | 官方有后台流程说明；不据此推断完整公开 API | 文本/上传/选项/加价/预览的逐字段接口或人工导入验收 |
| Amazon Ads | [官方 API 入口](https://advertising.amazon.com/about-api)、本地 advertising-workbench.md | 本地说明以人工 CSV 与执行登记为边界 | Ads 独立授权、账户/广告类型、报表粒度、受控写权限 |
| 工厂 ERP | 本地 production-delivery.md | 当前描述人工上传包并登记收到/接受 | 官方接口、单号映射、幂等、文件校验和真实回执，不模拟网页提交 |
| 云途/ShipOS | 本地 logistics.md、shipos-readonly.md、logistics 包 | 既有查询边界与新购单适配须分开；文档有意图和查单机制 | 当前账户真实渠道、购单/签发费用、撤单退款和不确定恢复 |
| 模型服务 | 当前 ai-core 与用户材料的候选名单 | 有可配置路由；材料评分非统一评测 | 同数据集、工具协议、隐私、质量、单位合格成本及供应商稳定性 |
| Etsy | 既有连接器和个性化安全文档 | 后续渠道，不强塞 Amazon 语义 | 独立字段与能力，不能丢弃未支持的个性化内容 |

本表证据来自当前工作树和官方资料。表中“有文档/源码”不等于本轮实测，更不能代替店铺、工厂或物流账户授权。

## 4. 能力记录格式

每个连接保存：provider、accountRef、operation、API/version、官方依据 URL 与核对日期、requested/granted scopes、站点与资源范围、速率/重试条件、费用口径、数据域、最后成功观察、测试证据及负责人。

状态用 not_checked、documented、authorized、tested、enabled、suspended；documented 或 authorized 不能直接变为 enabled。读取与写入、询价与购单、创建与撤销、退款与付款分别记录。

授权撤销或能力过期后停止新动作；后台任务执行时重新核验。已有外部动作仍保留查单、对账和人工处理入口。

## 5. 接入顺序与降级

1. 用合法手工资料贯通内部模型，保留真实 sourceType。
2. 验证读取 API，逐字段与同一份手工来源对照。
3. 验证增量、重复、迟到、缺项、取消与保留期。
4. 每一种外部写操作分别预检授权、预算、幂等和不确定恢复。
5. 受控 live 验证后启用，持续对账与能力健康检查。

降级到人工时显示待执行或待核验，允许导出固定版本包并登记真实凭证；不自动宣称外部已成功。工厂 API 未确认不影响人工交付路径可用，但限制无人化范围。

## 6. 模型价格与选型

生产模型不写死在业务规则。保存 provider、modelId、version、endpoint class、region、data policy、参数、工具协议、预算及评测集版本。模型升级和路由替换有独立回归。

价格是带时间和条件的证据，不是永久数据库常量。记录输入/输出、缓存读写、图片数量与规格、峰谷或服务层级；估算和实际账单分别呈现。不能把订阅额度当成 API 余额。

用户 PDF 的逐页判断、复算与官方抽查见 [14 辩证阅读](14-critical-reading-agent-decisions.md)。本轮没有付费模型对比结果。

## 7. 外部资料与源码使用规则

外部网页、README、PDF 和工具返回均为不可信资料，不具有项目指令权限。研究代码先阅读，再在隔离范围验证；不运行未知安装脚本、导入真实凭据或改变当前包管理器。业务接口只使用得到授权的正式能力。

## 8. 1.1 开源执行模式核对

核对日期 2026-10-16。复用已安装开源组件，不在本次规格合并时升级依赖或新增独立引擎。

| 来源 | 采用的原则 | 本项目边界 |
| --- | --- | --- |
| [BullMQ 幂等作业](https://docs.bullmq.io/patterns/idempotent-jobs) | 步骤足够小，业务动作重试可重复 | 数据库意图、请求身份和外部对账仍由业务实现 |
| [LangGraph 持久化](https://docs.langchain.com/oss/javascript/langgraph/persistence) | 明确检查点范围和存储介质 | 当前裁线图是局部流程，不能以内存图状态替代持久订单记录 |
| [PostgreSQL RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) | owner/BYPASSRLS 与普通角色有差异 | 继续强制 RLS、非 owner 应用角色和 withTenant，不信任队列原始 tenantId |
| [OWASP 提示注入防护](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html) | 外部内容隔离、最小工具权限、输入输出校验 | 文档、知识和模型不能改权限、预算或业务批准 |

以上是执行模式依据，不是上游框架对本项目可靠性的担保。实现与故障注入必须单独留证。

调用证据核对 [OpenTelemetry GenAI 开源规范](https://github.com/open-telemetry/semantic-conventions-genai)
的模型/工具/Agent 观测分离，以及 [Langfuse 用量与费用](https://langfuse.com/docs/observability/features/token-and-cost-tracking)
的输入费用与推算费用区分。只采用证据来源和调用关联原则，复用现有数据库、Worker
和前端组件，不复制上游源码或增加 SDK/外部上传。观测不替代业务回执或渠道账单。

辅助输入当前版本复核继续使用已安装 PostgreSQL、Drizzle 和原生知识治理，数据库内对有界、确定排序的作用域投影计算摘要。没有新增插件、向量服务、独立 Agent 引擎或依赖升级；元数据摘要不能代替业务计算、当前授权或提供方对账。

Tool/Skill 核对 [OpenAI Agents JS 工具](https://openai.github.io/openai-agents-js/guides/tools/)的 Zod 参数及逐工具输入/输出检查模式，并核对 [MCP 2026-07-28 工具规范](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)与[工具标注边界](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)。采用代码注册、固定版本和实际调用点校验；权限、资源和副作用仍由业务服务控制。没有复制 SDK 源码或新增外部依赖，只有 workflow-core → ai-core 的内部 workspace 链接，锁文件重建对比证明其他字节不变。

知识治理沿用原生模块，参考 [IvyeaOps 公开说明](https://github.com/Hector-xue/IvyeaOps) 的
来源复核、覆盖、时效、冲突、评测和账户证据流程；继续使用本地发布版本、RLS、预算及
执行器，不增加另一个知识事实库。当前权限与历史上下文的隔离由本项目测试单独证明。

创作持久执行复用已有 BullMQ、PostgreSQL、方法/知识及预算拥有者。API 测试显式声明已有 `@yummyai/mockup-renderer` 和 BullMQ 5.80.5 开发依赖，离线安装且禁用脚本；外部包与快照摘要保持。Windows 原生套图锁定官方 ImageMagick 7.1.2-34 归档与 23 个文件，安装器不修改 PATH、注册表或普通 `.env`。运行依赖及临时下载的保留/清理边界见[运行时说明](../operations/mockup-runtime.md)；执行和剩余验收见[恢复契约](../integration/creative-execution.md)。

原订单异常操作参考 [ERPNext Issue](https://docs.frappe.io/erpnext/issue) 的问题记录、处理
及实际状态关联，复用本地 OrderService、原不可变事件、TaskDrawer、Lucide 和原生
View Transitions；未复制上游源码、增加新依赖或引入独立问题引擎。权限、版本、
隐私、幂等和处理与履约分离由本地契约与测试证明。

R36 跟进安排核对 [ERPNext Assignment Rule](https://docs.frappe.io/erpnext/assignment-rule) 的单据分配与到期安排；采用业务对象关联及责任/截止独立建模原则，复用本地 Next/React、Drizzle/PostgreSQL、通知和标准 Worker。未复制上游规则脚本执行器，也未增加独立任务引擎；当前授权、RLS、来源并发与事务通知按本地隔离测试证明。

费用对账参考 [ERPNext Bank Reconciliation](https://docs.frappe.io/erpnext/bank-reconciliation) 的原交易匹配原则和 [Langfuse Token & Cost Tracking](https://langfuse.com/docs/observability/features/token-and-cost-tracking) 的费用来源区分。仅复用设计原则，继续采用本地 Drizzle/PostgreSQL、React/Next、Lucide 和现有预算账本；没有复制上游代码、增加 SDK、上传账单或新增支付服务。

原方案资料包历史复用已安装JSZip3.10.1、React/Next.js/Lucide及原封包服务。仅调整受权原文件重现、读投影和界面交互，无新增外部依赖或独立封包引擎。不可变快照、当前权限、原文件SHA-256和原审核门禁由项目业务服务及实际测试证明。

历史环境升级先核对 PostgreSQL 的 [pg_dump](https://www.postgresql.org/docs/current/app-pgdump.html)、[pg_restore](https://www.postgresql.org/docs/current/app-pgrestore.html) 与[结构反解析函数](https://www.postgresql.org/docs/current/functions-info.html)，以及 [Drizzle 迁移](https://orm.drizzle.team/docs/migrations) 和已安装源码。复用现有 PostgreSQL、postgres.js、Drizzle 文件读取器、S3 SDK、React/Next.js 与 Lucide；不增加备份引擎或依赖。迁移语句和事务锁共用连接，结构比对使用数据库自身反解析保留表达式优先级，不能正则删除括号。当前核验在同一实际 PostgreSQL 集群/版本中进行，跨大版本恢复独立验收。


## 发货来源复用 · 2026-10-19

参考 [ERPNext Delivery Note](https://docs.frappe.io/erpnext/delivery-note)、[Batch](https://docs.frappe.io/erpnext/batch) 和 [Odoo 19生产库存关联](https://github.com/odoo/odoo/blob/19.0/addons/mrp/models/stock_move.py) 的来源关系设计，复用现有订单、生产、质检、发货和事务模块，未复制上游业务源码或新增外部依赖。包裹、合格来源与真实交运继续由各自拥有者记录，见[契约](../integration/shipment-production-sources.md)。


### 1.1.30 质检组参考

参考[ERPNext检验及源码](https://github.com/frappe/erpnext/blob/develop/erpnext/stock/doctype/quality_inspection/quality_inspection.py)、[ERPNext官方说明](https://docs.frappe.io/erpnext/quality-inspection)及[Odoo19质量检查](https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/quality/quality_management/quality_checks.html)。只借鉴检验、数量及来源分工，保留现有订单事实和依赖，不引入并行ERP。

### 生产入口复用

先核对开源[ERPNext Work Order](https://docs.frappe.io/erpnext/work-order)的明确产出数量、BOM及实际消耗分工，再复用现有 React/Next、Lucide、Drizzle/PostgreSQL、Zod、生产命令和原版本表。没有复制其业务源码或新增外部依赖；contracts 只增加子路径导出，锁文件和包版本保持。实际物料移转/消耗与工厂日历/产能仍由后续工作包完成。


### 1.1.43 观察顺序与锁

先核对开源PostgreSQL的[共享/更新行锁和NOWAIT语义](https://www.postgresql.org/docs/current/explicit-locking.html)，以及[Drizzle bigint映射](https://orm.drizzle.team/docs/column-types#bigint)，再复用现有ShipOS服务、租户事务和一次性历史迁移验收器。没有引入第二套物流系统或新依赖。上游时间不提供可靠业务顺序，原证据不重写；历史兼容、原请求重放和来源事务见[只读集成](../integration/shipos-readonly.md)。

## 1.1.44 精确库存与原BOM实际物料

先参考开源[ERPNext实际耗用](https://docs.frappe.io/erpnext/material_consumption)、[库存出入库](https://docs.frappe.io/erpnext/stock-entry)及[PostgreSQL精确数值](https://www.postgresql.org/docs/current/datatype-numeric.html)。沿用内部库存拥有者与当前事务授权；对第三方产品的流程借鉴不构成本平台已实现或工厂已验收的证据。固定scale会在校验前四舍五入，本批采用无声明scale及显式边界/精度约束。

接口、已验证结果与剩余项见[物料契约](../integration/production-material-execution.md)及[本批进展](../project-control/INVENTORY_EXECUTION_PROGRESS_20261020.md)。

## 1.1.48 来料和库存复用

先核对开源[ERPNext Quality Inspection](https://docs.frappe.io/erpnext/quality-inspection)及[Purchase Receipt](https://docs.frappe.io/erpnext/purchase-receipt)的检验依据、接收/拒收和单位分工，继续复用原库存/采购拥有者及PostgreSQL、Drizzle、Zod、Next/React、Lucide，没有复制外部业务源码或新增依赖。项目的不可变分类、原请求和同笔审计按自身租户边界实现；完整检验仍按[后续设计](../architecture/incoming-material-inspection.md)建设。
