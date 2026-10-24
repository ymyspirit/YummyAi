# 系统架构与技术决策

<!-- studio-paid-image-73e2c9b1-current -->
PRD1.1.127 数据层保留不可变准备和取消键，Harness层统一报价预算、当前权限、单次外部提交和原响应恢复，Agent/界面仅提交固定原请求。当前为开发与隔离验收中，事实以[本片进度](../project-control/STUDIO_PAID_IMAGE_PROGRESS_20261024.md)及[专项契约](../integration/studio-paid-image.md)为准。以下旧版本保留当时状态。
<!-- /studio-paid-image-73e2c9b1-current -->

PRD1.1.126 沿原API业务拥有者、PostgreSQL和私有存储增加独立本地采用命令，不新增模型调用或执行平台。本片开始实施，尚未验收或采用，当前事实以[本片进度](../project-control/CREATIVE_RESPONSE_ADOPTION_PROGRESS_20261024.md)及[采用契约](../integration/creative-response-adoption.md)为准。下方旧版本段落保留对应历史时点的状态。

PRD1.1.121补充：跨项目完整文档复制由 Studio 原服务拥有，清单、原请求、追加副本和不可变回执沿原租户事务；源/目标按固定scope锁序核对，I/O后复查权限。集成runtime只负责编辑、保存屏障和冻结来源历史，不承接业务批准或模型执行。见[复制规格](../integration/studio-document-transfer.md)。

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

1.1.84完成其余六类原生角色固定评测的局部验证，补真实媒体字节、原资源权限和评测采用隔离；沿原prompt、工具、方法、预算及业务拥有者，知识v1与旧两业务家族保持。新增12当前/1真正169升级/57核心及BFF/同编译2个人页面共72项去重通过；本批21目标/312链接和16组资源完成清理。真实模型质量与完整B27/H12仍继续；普通148未采用，完整48需求/54工作包/8阶段及业务验收未完成。见[执行契约](../integration/role-benchmarks.md)与[本批进度](../project-control/ROLE_BENCHMARK_PROGRESS_20261021.md)。

1.1.83完成采购与经营两类原生业务固定评测的局部验证，沿用原拥有者、生产方法、预算及账单，固定业务样本与真实原生尝试，评测不直接采用到经营草稿。11知识核心/8业务核心/7BFF/2迁移/3规则/11当前隔离/1真正168升级/同编译2个人流程共45项去重通过；本批12目标/315链接及7组资源完成清理。知识v1和旧168任务继续，其余六类角色、真实模型质量与完整B27/H12仍继续；普通148未采用，完整48需求/54工作包/8阶段及业务验收未完成。见[执行契约](../integration/business-benchmarks.md)与[本批进度](../project-control/BUSINESS_BENCHMARK_PROGRESS_20261021.md)。

1.1.82完成知识问答固定多题数据集、真实规则基线/原生候选、结构化算术硬失败、全部尝试/人工/存储/维护成本及原报告的局部验证。11核心/1退出/4BFF/2迁移/3规则/13隔离/1真实167升级/同编译2个人流程共37项去重通过；本批16目标/318依赖链接及9组资源完成清理。旧工具/策略指纹保留，真正旧待执行任务由新Worker完成。其他角色适配、真实质量及完整B27/H12仍继续；普通148未采用，完整48需求/54工作包/8阶段及业务验收未完成。见[执行契约](../integration/knowledge-benchmarks.md)及[本批进度](../project-control/KNOWLEDGE_BENCHMARK_PROGRESS_20261021.md)。

1.1.81原生知识评测可信执行已完成局部验证：评测、原Assist、预算与执行意图同事务登记，原本人键恢复、实际Worker封存评分、完整历史和同依据比较已验证。16单元/3规则/15新隔离/1真实166升级/4旧回归/同编译2个人页面共41项去重定向通过，本批临时产物与10组资源已清理。完整B27/H12的固定数据集、规则基线、所有尝试及单位合格成本继续；普通148未采用，完整48需求/54工作包/8阶段及业务验收未完成。见[执行契约](../integration/knowledge-evaluation-execution.md)及[本批进度](../project-control/KNOWLEDGE_EVALUATION_PROGRESS_20261021.md)。

1.1.80完成工厂作废逐观察人工核对的局部实施验证：发货与作废来源分离，每条原作废保留独立线性核对和完整未结计数，新作废重新待核对，确认工厂作废仍提示订单后续。原请求可在来源到期后按本人原键恢复；生产/QC/数量/产能/库存/物流事实保持。41单元、3规则、13隔离及同编译2个人页面共59项定向通过，含真实165升级、5000行来源摘要与整单失权读取门；16自有目标/315链接及11组资源完成清理。普通148六应用停止，未采用166，完整54工作包与真实工厂业务未验收。见[执行契约](../integration/factory-erp-void-reviews.md)及[本批进度](../project-control/FACTORY_ERP_VOID_REVIEW_PROGRESS_20261021.md)。

1.1.79完成工厂绑定解除与更正的局部实施验证：解除为不可变事件，新修订只采用明确来源，原组、旧观察和成功回执保留，旧未提交意图须核对真实修订。9契约、15Web单元、3规则、9当前隔离、真正164升级1及同编译个人页面1共38项通过；两种真实并发锁环已修复，18张实物事实保持。15自有临时目标/315链接和10组隔离资源完成清理。普通148六应用停止、未采用165，完整54工作包及真实业务未验收。见[执行契约](../integration/factory-erp-binding-corrections.md)与[本批进度](../project-control/FACTORY_ERP_BINDING_PROGRESS_20261021.md)。

1.1.78复用现有PostgreSQL、租户事务、AWS SDK和Worker维护器。短事务清文/审计/出站任务，提交后真实S3 I/O，原租约完成/审计同事务。系统actor不可加入成员；零业务队列独立维护入口。三层边界保持，Agent不承担清理成功或状态真实性判定。 见[来源保留](../integration/factory-erp-source-retention.md)及[本批进度](../project-control/FACTORY_ERP_LIFECYCLE_PROGRESS_20261021.md)。

1.1.77工厂导入owner沿原订单/交付/生产边界，新增来源网关、服务及六张RLS不可变表。原字节经真实扫描加密保存在私有order域；来源声明与加密证明固定原预览，SQL独立约束逐行状态及审计闭包。外部I/O不持有业务锁。Agent可建议匹配，确定性Harness负责读取、授权和应用，不建立第二份生产状态账。 见[工厂导入契约](../integration/factory-erp-status-import.md)及[本批进度](../project-control/FACTORY_ERP_IMPORT_PROGRESS_20261021.md)。

1.1.76新增工厂表格同步的目标边界：原始私有文件、固定映射、逐行来源及唯一外部编号绑定由数据层保存；Harness校验、预览/应用、幂等、并发与审计；Agent只建议映射/解释异常。复用原交付/生产/物流owner，不能在Agent侧建第二状态账。实际导入owner未实现。 见[工厂两态与表格契约](../integration/factory-erp-status-import.md)。

1.1.75沿原质量/数量/补做owner扩展，SQL统一计算批次余额、当前分组树与退休父组份额，个人API/BFF核对当前权限。完整出生事务将声明分配行、投影+1及成功审计闭合，forced RLS和原始来源独立校验。 见[实物组报废归属](../integration/quality-scrap.md)。

1.1.74沿既有订单/产能/质量owner扩展实际数量核对，不另建制造系统。共享SQL basis统一当前来源、物理下界和净产能，个人API/BFF核权，forced-RLS不可变追加及完整事务ID独立约束全池效果和审计。 见[实际数量与部分停单](../integration/production-physical-quantities.md)。

1.1.73新增明确计量的共享产能池、固定工厂当地日历和跨订单有限预约，0159以真实生产版本/里程碑出生事务证明绑定五张RLS账表。三种下达及三种补做均明确完整池版本与当地生产日，原owner同事务预约、审计、开工承诺及确认取消释放；预览聚合同池同日需求且不占额度。显式拒绝DST gap/fold、未知旧占用、缺绑定和过期版本；旧原文/成功回执精确恢复而不补造历史预约。64单元/规则、229去重集成及15去重个人页面通过，页面按失败增量复验，保留14项通过、最终编译复验1个整单场景，没有宣称15项全在同一候选。自有输出已清理。真实部分停单数量释放、普通环境采用及完整业务继续。原私有来源读取还补齐父订单先于子项的锁顺序，保留权限、隐私及版本检查；浏览器实际40P01促使增加确定性真实锁等待回归，未吞错或盲目重试。 规范见[工厂日历与共享产能](../integration/factory-capacity.md)。

1.1.72修复工厂租户读取与本人写入混合范围的越权门禁，各操作在事务内重核当前成员及请求上限；四种新版本与审计原子提交，原键精确回放不增版本或审计。历史固定真实工厂、不可变版本时间和权限标记，前端清除失权状态并拒绝迟到回填，专门识别I/O后的authority_changed。生产里程碑沿原状态机，将既有审计移入同事务。本批65项单元/规则、35项去重集成和同编译3条个人OIDC页面定向通过；自有输出已清理，无新迁移或普通采用。真实产能账及完整平台继续。 规范见[工厂权限与生产事务](../integration/factory-authority.md)。

1.1.71实现广告七类完整原填写、原幂等键和跨会话恢复。准备、列表和原文读取不执行，操作者明确核对后由原owner同事务产生实际不可变结果、fullxid证明及双审计。独立密钥、七天数据库时钟留存，取消/确认/到期只清原文，原事实和键保留。99项单元/规则、39项去重集成、同编译3条个人OIDC页面验证通过；本批输出已清理，普通148未采用158，完整平台与业务验收继续。

1.1.64：Finance仍拥有原事实/指标/FX/贡献，新增分摊service/read/target适配器与三张不可变派生表；共享契约集中精确金额与canonical身份。原拥有者完整核对基础计算后才能投影，个人BFF限制体积并核对原body、hash、ID、query及游标；所有读写重新验证当前成员/范围与非owner强制RLS。见[本批进度](../project-control/FINANCE_COST_ALLOCATION_PROGRESS_20261021.md)与[费用分摊契约](../integration/finance-cost-allocation.md)。

1.1.63：新增FinanceLedgerService只读复用Finance/Payables拥有者，固定15类映射和当前FinanceRead事务，不增加财务写模型或数据库迁移。个人GET BFF绑定原类型/ID/parent/limit及游标位置；跨页重新核对当前成员与强制RLS。见[本批进度](../project-control/FINANCE_LEDGER_PROGRESS_20261021.md)与[读取契约](../integration/finance-ledger.md)。

当前1.1.62的应付更正、真实采购同步与已发生退款登记已完成局部验证；普通148仍停止、155未采用。以下版本段落保留历史观察，当前证据以[更正进度](../project-control/FINANCE_ADJUSTMENTS_PROGRESS_20261021.md)和[接口/边界](../integration/finance-payable-adjustments.md)为准。

1.1.60推进B45：独立工厂/供应商应付、人工登记的实际付款证据、部分及多账单核销与追加撤销；当前权限、同事务审计、整批闭合与双向余额由拥有者和SQL共同约束。100定向单元、34去重隔离（含真正148→152→153未知来源与全部旧列/账本保留）及同一编译包2个人浏览器通过。8个自有目标4667文件/779370026字节与313依赖链接已清，6组隔离资源两次独立查无；87保护项/2598普通源/8备份保持，883冻结路径和旧1缓存/2草稿保留。应付更正/付款退款、既有财务拥有者整改、普通153采用及完整平台继续，普通库仍148、六应用停止。见[本批进展](../project-control/FINANCE_PAYABLES_PROGRESS_20261021.md)与[集成契约](../integration/finance-payables.md)。

1.1.57保持数据/Harness/Agent三层：数据层追加0151不可变处理事件和来源化占用效果，强制RLS、同笔真实命令、规范正文摘要、源余额及延迟完整性校验；Harness固定整张PO相关图指纹、原权限上限和本人原文，执行前重新授权及加锁；Agent调用实际采购拥有者，不直接写表。read-only实际详情与执行时不可变结果独立，成功后自动重新读取，失权清私有页面。旧八命令摘要和旧发票字段/149分配不变，见[发票纠正设计](../architecture/procurement-invoice-reconciliation.md)。

1.1.56沿用数据/Harness/Agent分层：数据层追加0150的invoiceResultProofId指向149真实原凭据，旧resultProofId继续仅指146，二域互斥；Harness沿用七天密文、原操作者/当前权限交集、固定依据与原结果；Agent调用实际invoice owner。SQL正反向约束要求新发票完整事务标记及同事务命令结果，raw头记录亦先取原键、命令行再取PO锁，不靠应用层约定防绕过。旧七类契约和149摘要不变，见[发票命令设计](../architecture/procurement-invoice-commands.md)。

1.1.55继续复用采购/库存/来料拥有者与原租户事务。数据层追加0149，不改旧JSON、checksum或密文；采购/库存双单位与单价数量逐版本固定。Harness原七类命令只追加当前授权下的原版本reviewBasis，不从最新100条视图拼历史。新发票保存真实插入事务、规范原请求和不可变收货分配，同一采购及收货advisory锁与SQL余量约束共同防止重复占用；不授予不可变收货UPDATE权限。实现和部署边界见[计量与发票设计](../architecture/procurement-measurement-and-invoices.md)与[采购计量与发票进度](../project-control/PROCUREMENT_PRECISION_PROGRESS_20261020.md)。

1.1.54普通148采用固定2598项源码及独立运行快照，102个工作区链接指向快照，第三方依赖只读共享；同源码编译Web只提升封存产物，不重建或复制缓存。数据库、API、三维护与受限AI消费者已经采用，Web启动受自动审批限制而未恢复；运行证据和后续门槛见[本轮采用与受阻状态](../project-control/PROCUREMENT_ADOPTION_PROGRESS_20261020.md)。本地API继续使用原本地身份及独立加密域，不能推导为正式生产部署。

1.1.53把RFQ真实插入事务与普通元组更新分开保存，追加0148而不重写迁移历史。保留原拥有者和租户事务，旧事实准备门禁在拥有者验证入口统一处理；页面恢复范围与写请求生命周期独立于父视图刷新。真实API提交前后终止、旧JWT当前权限和零消费者定时维护使用隔离进程验证，普通145与新148源码严格分开。见[本批进度](../project-control/PROCUREMENT_RECOVERY_PROGRESS_20261020.md)。

1.1.52将前段采购实际事实保留在原拥有者与0146凭据，0147原文命令负责独立密文、本人恢复和七天副本留存。准备不建立采购事实，执行共用同一顶层租户事务；SQL同时要求真实凭据与命令结果一起提交。预校验只读，实际拥有者按原顺序加锁重验，避免恢复分页与业务锁循环等待。七种结构化入口复用已有人工建档和来源采购；新独立清除入口固定零业务消费者。同候选5项编译浏览器已通过，采购专属进程/维护周期继续验收，普通运行仍145，见[采购规格](../integration/procurement-original-requests.md)。

1.1.49的来料适配将实际标准、到货、检验、核准及库存事实留在数据层与既有业务拥有者中，原命令在Harness边界保存固定输入、授权上限及最小实际结果。API执行不接受替代正文；命令、事实、库存及审计共用租户非拥有者事务。独立来料维护固定零业务消费者，只清除到期副本。Agent接入仍需受控工具、当前权限与业务核准，不能以知识检索结果代替制造标准或真实接收。普通145采用和完整业务验收的状态见[来料进度](../project-control/ARRIVAL_INSPECTION_PROGRESS_20261020.md)。

生产首批三类[持久命令](../integration/production-command-recovery.md)复用原订单拥有者，意图/尝试属于订单执行边界，不另建生产事实。短事务认领后由业务事务重新授权并持有执行凭据行锁至提交；最小回执独立于详情读取。0136普通采用及剩余域继续。

运营 Web 的[个人身份边界](../integration/erp-identity.md)复用现有 OIDC/PKCE、
API 成员与 RLS；运营/工厂共享协议核心，但会话密钥、加密上下文、Cookie 和 Redis
命名空间独立。BFF/RSC 使用当前请求身份，服务凭据只保留在显式回环开发及隔离夹具。
任务和业务对象仍由各模块授权；登录不能扩大角色或对象范围。

版本：1.1.121 · 目标架构与局部实施。个人 MCP 及 Windows 店铺节点身份已有本地验证；节点平台执行、公网部署和普通环境采用继续。现状核对见 [11](11-current-state-and-migration.md)，外部依据见 [09](09-integrations-and-open-source.md)。

## 1. 架构选择

既有环境的[升级核验](../integration/legacy-runtime-upgrade.md)由独立运维凭据执行，应用启动只读检查。历史迁移哈希差异必须匹配不可变核验凭据及当前完整结构摘要，不能改写账本或设置跳过检查的开关。业务仓库继续使用原租户事务和强制 RLS。

调用证据继续由原拥有者供给：辅助执行/预算、工作流 attempt/商品回执、POD 调用
元数据使用共享只读结构，不另建财务或业务事实。POD 在提交前、收到响应时独立
持久留证；报告金额与产物质量分开。字段、当前权限、0117 及真实对账的剩余边界见
[调用与费用证据](../integration/harness-invocations.md)。

采用 TypeScript 模块化单体与分离 Worker，沿用现有 Next.js、NestJS、PostgreSQL、Drizzle、BullMQ 和私有对象存储边界。先靠明确模块契约与独立作业扩展；只有经负载和组织边界证明必要时才拆独立服务。

不整体替换为 ERPNext 或 Medusa。它们提供可研究的制造、库存和订单模型，但现有租户、安全、定制制作和历史版本关系需要保留。开源选型细节见 [09](09-integrations-and-open-source.md)。

## 2. 运行视图

~~~mermaid
flowchart TB
  U[运营端 设计端 工厂协同端] --> W[Next.js Web 与同源代理]
  X[公开页面采集扩展] --> A[API 认证与应用服务]
  W --> A
  A --> D[(PostgreSQL 业务事实 RLS)]
  A --> S[私有文件与独立加密域]
  A --> O[数据库持久意图 Outbox]
  O --> Q[Redis BullMQ 队列]
  Q --> K[Worker 与恢复扫描器]
  K --> D
  K --> S
  K --> C[共享数据 工厂 物流 模型适配器]
  C --> P[经授权的外部服务]
  E[外部 Agent] --> MC[统一 MCP 入口 规划]
  MC --> A
  K --> G[店铺任务与回执网关 规划]
  N[每店独立 API 节点 规划] -->|主动认证 领取本店意图 回传回执| G
  N --> AP[本店授权的 LWA SP-API Ads API]
  A --> M[审计 日志 指标 追踪]
  K --> M
~~~

Web 不连接业务数据库。浏览器使用共享契约和受控代理；API 解析成员关系、权限和对象范围。Worker 依据可信任务身份和当前权限再次授权，队列消息中的 tenantId 不能单独构成授权。

Outbox 是目标可靠性机制；现有各模块的持久派发实现要逐一盘点，采用兼容适配迁入，不能宣称全仓已具备通用 Outbox。

### 2.1 产品、仓库与运行服务的划分

确定采用“一个 YummyAI 产品与仓库，中心统一控制，每店节点独立部署”。这是在模块化主体与独立 Worker 基础上的执行部署扩展。1.1.101 已新增 `apps/store-api-node` 的 Windows 独立节点身份和持久心跳程序，与已存在的 web、api、worker、extension、agent-mcp 并列。真实 mTLS、一次票据、公钥绑定和断线恢复已通过本批局部隔离验收；平台意图领取、凭据迁移与平台请求尚未接入节点，Linux 部署也未验收。见[当前节点契约](../integration/store-node-identity.md)。

| 部分 | 部署与职责 | 数据和权限所有权 |
| --- | --- | --- |
| 控制中心 | 现有 Web/API/Worker 承载界面、认证、任务意图、审批、汇总与统一 MCP | 认证成员决定租户；中央业务拥有者经非 owner `withTenant()`/RLS 保存业务事实、结果与审计 |
| 店铺节点 | 统一节点制品按店铺独立部署和升级，单店独立服务器，领取有界意图和返回回执 | 本店最小必要平台秘密、节点私钥及有保留期的加密检查点；不连接中央数据库/Redis，不直接写业务表 |
| 共享连接器 | 按供应商和连接实例执行研究、广告平台或站点分析任务，依合同出口/并发部署 | 使用连接器专属加密域，与店铺、模型及 API Client/Webhook 密钥隔离；按当前账号授权、费用和数据使用许可执行，研究估算与经营事实分别保存 |
| 模型及媒体执行资源 | 中心选择模型路由，必要时独立 GPU/渲染进程池 | 复用 ai-core、现有产物域、预算和费用证据；不建立另一套 ERP 事实或审批系统 |
| 紫鸟环境 | 人工浏览器运营 | 只保留必要的外部环境引用；不读取或迁移浏览器 Cookie、密码或会话 |

共享包复用 `contracts`、`authz`、`jobs` 和 `marketplace-connectors` 中适用边界，节点构建只包含必要执行器与协议。共享仓库或包不意味着节点获得中央服务权限；环境、证书、密钥和依赖按部署目标隔离。中心/API/Worker 与节点独立发布，协议有明确版本及兼容区间；先小范围节点升级，再扩展部署。

### 2.2 调用路径与同步数据流

业务上的任务方向为“YummyAI → 店铺节点 → 平台 → 回执 → YummyAI”。实际网络连接由节点主动出站，通过短期 mTLS 身份连接中心的受限任务接口；节点只可心跳、领取本店意图及上传限定结果，不暴露通用公网代理或任意执行入口。

日常页面和跨店分析优先读取中心已保存的受权事实或投影，并明确 `sourceType`、`observedAt`、数据截至时间、同步时间、业务时区和覆盖范围；读取保存结果不会再次请求上游。用户选择刷新或定时同步时：

1. 中心当前认证与 Marketplaces 拥有者确认店铺、站点、操作能力、请求范围和预算，创建持久意图并固定原申请人、授权上限及输入。
2. 中央 Worker 负责可恢复派发、租约和对账；节点只领取当前活动绑定下的本店任务，执行前在线核验当前许可。
3. 节点通过本店授权访问 LWA、SP-API 或 Ads API，按平台能力处理限流、分页、报告轮询、下载和重试，保留安全来源证据与提交边界。
4. 中心验收当前租约、输入摘要、分页范围和回执，再由 Marketplaces、Orders、Advertising 等原拥有者校验、去重、保存原证据及更新同步检查点；跨模块通过原应用服务协作。
5. 汇总按逐店成功/失败/缺项范围计算，时区、币种和归因窗口明确。Agent 只分析当前可读结果；不能把研究销量估算写成真实店铺订单或将未完成分页标为完整。

异步 Webhook 仍经平台要求的签名接收入口和所属连接验签、去重，绑定可信店铺后创建中央持久意图；需要回查平台时路由本店节点。回调地址、Webhook 入口和平台请求出口分别核验，不因采用节点而改写平台规定的 OAuth 流程。

### 2.3 店铺身份、凭据与执行许可

一个店铺可登记历史或备用节点，但同一时刻只有一个活动绑定和有效执行租约。登记票据短时、单用途，绑定店铺及节点公钥；轮换、撤销和迁移固定绑定 revision 与证书代次。店铺网络地址属于运维资料，节点身份以登记公钥、证书与绑定核验。

Marketplaces 保持唯一逻辑授权拥有者，记录平台卖家身份、站点、授权能力及撤销状态；平台 Token 的物理保管和刷新按节点目标迁移，通过受限凭据访问协议衔接。迁移前核对现有凭据、刷新并发与旧任务，不同时运行两套独立刷新逻辑。Ads 另行核验对应广告账户及 scopes。

意图固定运行、申请人及授权上限、店铺、活动绑定 revision、能力/Schema 版本、参数摘要、效应类型、预算许可、到期时间和租约代次。许可按上游步骤有界签发，执行前在线复核当前授权；节点没有资格领取或执行其他店铺意图。外部 Agent 的 Token 只在中心解析，不能下传为节点身份，平台秘密不能进入队列、日志、模型上下文或返回结果。

### 2.4 离线、未知结果与节点接管

节点离线后停止新平台请求，中心保留排队/失败原因和最后数据时间，继续按当前权限提供已保存结果。不得自动改由中心直接访问本店平台来伪装恢复。恢复先核对原意图、提交边界和同步检查点；重新读取保存的响应不产生新的付费或写请求。

外部已提交而响应未知时进入 `unknown_outcome`/待对账，先查原平台参考号或人工核对，禁止盲目重发。迁移及备用接管须暂停新派发，处理原在途步骤、等待原许可失效，并确认相同卖家身份后激活新绑定。旧节点不能提交当前结果；其已发生外部动作的最小证据仍用于对账。绑定代次和数据库去重不能保证跨平台 exactly-once，也不能撤回已发生交易。

### 2.5 统一 MCP 与共享数据能力

YummyAI 对外统一提供 MCP：能力搜索、单项 Schema、受控查询/执行、保存结果读取、用量/余额五类入口；使用原成员、委派范围、店铺/对象授权和预算执行，收紧授权后历史结果也重新核验当前读取权。每店节点使用内部任务协议，无须各自建设独立公开 MCP 服务。

SIF、XYDC、SellerSprite、Sorftime、Keepa、独立站分析和通用模型按能力连接到中心连接器执行边界；供应商要求独立出口或特定部署时遵守合同，但不按店铺复制全部56个集成。Amazon SP-API 和 Amazon Ads 的店铺经营调用由对应店铺节点执行；其他广告平台按各自账号与资产授权处理。

供应商原生 MCP、官方 API、合同数据流和本地推理采用各自适配器，能力范围、Schema、费用与真实结果分别验收。[专项 PRD](../upgrade-plans/data-tools-mcp-2026-10-18/PRD.md)及[最终范围](../upgrade-plans/data-tools-mcp-2026-10-18/FINAL-INTEGRATION-SCOPE.md)保留44项最低目标、12项补充和客户端接入细项；旧专项冻结版本不覆盖当前主蓝图，实施前进行 U0 基线重新对齐。

## 3. 模块、数据所有权与服务接口

| 上下文 | 拥有的数据与行为 | 提供给其他模块的接口 |
| --- | --- | --- |
| Identity / Authz | 成员、角色、对象范围、外部协作授权 | resolveContext、authorizeAction |
| Research | 公开页面快照、证据、观察与缺项 | getEvidenceSnapshot |
| Catalog | SPU、规格、印花、销售 SKU 与配方 | resolveRecipe、getProductFacts |
| Rules / Knowledge | 规则、指南、来源、适用范围和版本 | pinRules、evaluateExecutableRules |
| Content / Listings | 图文、定制材料、渠道包、审核 | sealPackage、getApprovedPackage |
| Marketplaces | 店铺授权、操作能力、发布和同步检查点 | assertCapability、submitOperation、reconcile |
| Orders | 原始订单、商品行、定制来源、需求修订 | reviewItem、getPinnedRequirements |
| Design | 制作任务、编辑版本、技术检查、审核与费用 | produceCandidate、approveArtwork |
| Suppliers | 商务主体、工厂、能力、样品和报价 | eligibleCapabilities、getPinnedFactory |
| Production | 分配、产能、生产单、回执、质检和返工 | planWork、acceptDelivery、recordQc |
| Procurement | 请购、询价、采购版本、收货与发票匹配 | approvePurchase、matchReceiptInvoice |
| Inventory | 物料、批次、库位、预留与流水 | reserve、issue、receive、release |
| Logistics | 包裹、报价、购单意图、面单和轨迹 | quote、purchase、reconcileLabel |
| Fulfillment / After-sales | 实际交运、平台写回、售后与退款意图 | dispatch、openCase、reconcileRefund |
| Finance | 金额证据、冲销、固定货币精度与汇率、结算与利润版本；独立应付/付款与核销、更正和已发生退款证据拥有者，银行执行及完整总账继续 | recordStatement、calculateProfit、recordBillAdjustment、recordPaymentAdjustment |
| Advertising / Analytics | 报表、目标、诊断、建议和指标版本 | analyzeEvidence、reviewAction |
| Tasks / Integrations | 业务待办、通知、API 客户端与 Webhook | assignTask、emitDelivery |
| Platform | 文件、安全、模型路由、任务、审计和运维 | authorizeAsset、runJob、audit |

模块通过拥有者的应用服务发命令，不从另一模块直接写表。只读跨域列表采用受权查询服务或投影，明确来源及刷新时间，不把投影当原始事实。

涉及两个模块的业务操作由应用层编排：同一数据库事务可调用多个模块自己的事务方法；外部动作使用意图与事件衔接，不在长事务内等待 HTTP。

## 4. 代码组织目标

~~~text
apps/web           页面与交互、受控同源代理、工厂端入口
apps/api           认证边界、各业务模块应用服务、受权查询
apps/worker        制图、文件、渠道同步、物流、对账与清理
apps/extension     公开 DOM 采集、用户设置与诊断
apps/agent-mcp      固定五类入口的个人Agent协议适配 原业务事实与执行仍归原owner
apps/store-api-node Windows节点身份和心跳局部验证通过 平台执行与Linux部署继续
packages/contracts Zod、请求响应、状态、诊断、事件版本
packages/database  Schema、迁移、RLS、withTenant、持久意图
packages/authz     权限与对象关系策略
packages/storage   分域对象、授权读、扫描、生命周期
packages/ai-core   模型路由、预算、来源和调用结果
packages/jobs      作业契约、幂等、重试和恢复
packages/catalog-core / pod-core / workflow-core
                   API/Worker 共用业务拥有者与固定输入执行编排
packages/order-core 订单全量聚合读取、逐商品跟进责任与受权提醒
packages/followup-core 采购/售后/独立异常的受权投影、责任安排及持久提醒
packages/platform-rules / order-intake / order-design / production-editor
                   复用已有共享业务边界
~~~

具体新目录只在确认没有现有职责归属后添加。不要为了符合蓝图命名而批量重命名现有模块，也不要在前端重复服务器端 Schema。

## 5. 事务、事件与可靠任务

### 命令

命令携带对象 ID、expectedVersion、幂等键和明确意图。成员、租户、权限、价格与资源范围由服务端解析。相同键和相同内容返回原结果；同键不同内容冲突。

### 原子保存

在一个 tenant 事务内：校验不变量 → 保存业务事实或新版本 → 保存安全审计事件 → 保存待派发意图。事务提交后 dispatcher 投递 BullMQ。派发失败不会丢失已提交意图；恢复器可重新派发。

### 消费

队列采用至少一次投递。消费者按数据库意图 ID 去重并获取租约，重新检查版本、当前授权、资源和预算，再处理。执行结果与状态转换原子提交。Worker 崩溃后通过租约过期和幂等恢复。

不能承诺跨外部 API 的 exactly-once。外部参考号、提供商幂等能力和对账共同降低重复风险。外部结果不确定保持 unknown_outcome，阻止重复付费请求。

### 事件

事件携带非敏感身份、版本、类型、发生时间、traceId 和结构版本。PII、原图、令牌、原始提示词及签名下载地址不得进入 Redis、审计明文或 Webhook。需要资料时由消费者再次授权读取。

## 6. 工厂网络与权限隔离

卖家租户拥有订单和生产事实。供应商主体、实际工厂、协作人员身份、与卖家的合作关系分开建模。同一工厂服务多个租户时，每个租户的任务、文件和对账均隔离。

工厂协作用户经认证成员关系进入明确合作范围；服务器再验证本人的工厂授权、逐文件分配、操作权限与资料有效期。普通“租户成员”权限不足以读取全部订单。工厂任务只下载分配的指定版本 JPG，不读取整个运营生产包；直发所需配送资料尚不包含在此最小入口，后续独立授权和保留期验收。

当前运营 Web 的本地统一服务身份不能对外复用。同一 Next.js 产物以
`FACTORY_PORTAL_ONLY=1` 在独立源部署，仅开放工厂页面、个人登录、工厂 BFF 和
必要静态资源；服务器默认拒绝运营页面、运营 API、RSC/data 和图片代理绕行。
个人 OIDC/PKCE、可信 JWKS 和当前成员仍复用同一 API 权限拥有者。令牌在独立
加密域的 Redis 会话内，浏览器仅持随机 HttpOnly 标识。刷新先持久化不可重放
状态，CAS 保持原有效期，注销不能被刷新复活；代码或轮换响应不确定则重新登录。
运营端完整生产认证及正式网络配置继续按 B06 验收。见[工厂协作契约](../integration/factory-portal.md)。

## 7. 文件与隐私

至少划分 research、authorized、order-private、production-private 和 restricted-integration 五类逻辑域。原始文件加密保存；衍生预览继承来源权限和到期日，不因转成 PNG 就变成公共素材。

服务端签名读前检查租户、域、对象关系、版本、权利与保留期。高敏感下载可通过授权代理，避免不可撤销长链接。下载响应不缓存敏感内容；下载审计不保存秘密 URL。

不可变的版本事实与需要删除的 PII 文件解耦：保留合法的非敏感操作元数据，按政策销毁受保护正文与衍生件，显示“资料已清理”。备份恢复后先重新应用删除台账，禁止恢复已到期资料供日常使用。

## 8. AI 执行边界

AI 读取经授权的业务快照、证据和工具白名单，生成建议或候选文件。确定性服务负责金额、几何、数量、权限和状态门禁。

每次任务固定 modelRouteVersion、recipeVersion、ruleSnapshot、inputRefs、参数、预算预留和 outputRefs。外部模型只接收必要数据；买家资料进入模型前需要适用政策和处理协议核验。缺少依据时使用不外传的人工或确定性处理路径。

模型返回内容和检索文件均不具有系统指令权限。外部文档不能触发付款、授权、联系人消息或生产放行。模型请求超时但可能已计费时先核查结果与费用，不循环调用。

公开研究媒体的已提交记录同时作为持久归档意图，Worker 用租约和数据库时间恢复执行；字段采集完整度与媒体归档结果分别呈现。见 [媒体归档实现边界](../integration/capture-media-archive.md)。工作流命令的节点更新、事件与 revision 原子提交，审批只能通过明确审批命令；[当前修复与消费者缺口](../integration/workflow-command-safety.md) 分开验收。

知识库保存可引用依据，方法库保存有版本的执行规范，ERP 保存事实与事务，运行层保存可信任务状态。材料或记忆不能覆盖数据库事实；人工指南不能自动成为可执行约束。采用用户材料的判断框架，但不把其中主观模型评分视为选型证据，见 [辩证阅读](14-critical-reading-agent-decisions.md)。

首个自动化切片使用确定性工作流加必要的单 Agent 步骤。多 Agent 是后续经评测决定的执行策略，不是默认架构；额外交接、上下文复制、权限和费用必须进入评测。每次模型升级重跑固定样本，比较合格率、关键错误、复核分钟和单位合格交付完全成本。

## 9. 外部适配器

按能力拆分 authorization、catalog、listing、customization、orders、shipping、refund、ads、finance。店铺接通不等于所有能力可用；逐操作保存官方依据、实际授权、测试环境及最近成功结果。

平台适配器的逻辑拥有者仍在现有模块，运行出口遵守第2节的部署划分：店铺平台请求由本店节点发起，通用研究/站点分析走获准连接器，人工运营保留紫鸟环境。页面、外部 MCP 或模型不能直接绕过中央授权调用店铺节点。

平台状态保留 providerStatus、normalizedStatus 和 observedAt。更新缺少来源时不可猜测。轮询采用检查点、重叠窗口和去重，Webhook 采用签名、防重放与 inbox；两者由定期对账补偿。

手工上传与正式 API 最终进入相同校验和不可变版本服务，同时保留不同 sourceType。人工记录不会伪装成 API 证实的事实。

## 10. 容量、性能与部署

下列为首轮压测基准，待真实业务测量后调整，不是已验证能力：单租户 10 万订单商品索引、每日 1,000 商品件、20 个并发后台用户、10 个同时排队图像任务。媒体任务单独限并发，模型按供应商和租户预算限流。

运营列表采用游标或稳定分页、服务端过滤和有限投影；大导出转后台任务。API 与 Worker 独立扩容，存储容量、数据库连接池、队列年龄和外部限频分别监控。

开发使用现有本地运行手册。预发和生产使用独立数据库、Redis、对象前缀、OIDC 客户端与密钥。迁移先扩展、后切换、再清理；向后兼容的 API/Worker 可滚动发布。数据库、对象和密钥恢复演练是发布证据的一部分。

## 11. 架构验收

必须证明：RLS 在普通角色下生效；工厂对象关系生效；研究与买家资料不能跨域；业务提交与派发可恢复；重复事件不重复收费；旧版本可重现；清理后签名读和恢复路径都不能复活 PII。对应 T01、T02、T03、T06、T08、T12、T19—T24。

## 12. 三层架构的实施约束

原订单异常的操作与不可变事件由 OrderService 所有，责任旁表只跟进真实最新事件。
处理 API 与公开事件历史共享当前授权和订单资料可用性检查；采用现有非 owner/RLS
事务及拥有者锁，不建立第二套异常状态。见 [登记与实际处理](../integration/order-exception-operations.md)。

数据层、Harness 和 Agent 的详细边界见 [专项规格](15-agent-harness-specification.md)。优先在现有 ai-core、jobs、order-design 及拥有者服务提取公共策略，不因统一名称新建第二套运行事实、预算或审核数据库。

知识检索经发布、范围、时效与冲突过滤后固定引用；当前采用关键词检索，不宣称已有向量服务。现有 Infinite Canvas 和可选 LangGraph 裁线分别保留创作与局部执行职责，运行事实和外部副作用仍由数据库业务服务维护。

当前执行切片已提取 catalog-core、pod-core 与 workflow-core，标准 Worker 消费固定的 workflow-node 尝试，复用真实商品回执和 POD 子任务。租约、当前成员权限、输入校验与人工审核边界见 [执行契约](../integration/workflow-node-execution.md)；统一工具/预算/外部结果恢复及完整 B26 验收仍在建设。

新建九类 AI 辅助的执行意图由同一模块的 `ai_assist_executions` 承载，随原运行与预算
一起提交。标准 Worker 的分钟派发器恢复传输丢失与有界本地处理；租约 token 隔离
重复投递，提交标记和加密响应决定是否可恢复。旧运行保留原兼容策略；不另建业务
事实或预算表。迁移、保留期与真实提供方边界见 [Harness 运行说明](../integration/agent-harness.md)。

辅助输入依赖由 database 共享只读投影承载，全部经当前租户非 owner 的只读一致性事务；知识可用性继续复用 knowledge-core 的原治理判断。原业务服务组装上下文和执行计算，元数据层不写业务表。投影有确定排序与数量上限，超限明确停止；私有资源明细只在加密原输入中保存，读取接口仅返回审计版本、时间和总指纹。此切片不新增运行框架、表或迁移。

工具/方法注册与规范化摘要放在现有 ai-core。workflow-core 新增对这个仓库内包的依赖，API 能力校验和 Worker 执行共用同一工作流绑定；外部依赖版本保持原锁定值。业务计算与副作用仍由 catalog、POD 和原辅助拥有者实现，注册核心验证固定引用、逻辑参数与返回值。方法引用随原有输入保存，复用既有租约、响应检查点、预算与回执，不另建执行数据库。

订单读取投影现由 order-core 提供，原 API 查询模块保留兼容导出。逐商品责任和待办复用实际履约与异常事实，API/Worker 共享当前权限检查；列表不制造业务状态，提醒由标准 Worker 有界派发。新开关默认关闭，详见 [订单跟进](../integration/order-line-responsibility.md)。

采购、售后与独立订单异常由 followup-core 共享投影、责任和受权提醒协议，原模块保留审核/收货/退款/解决事件的所有权。API/Worker 共用当前授权与来源校验，三类对象的详情/提醒复用既有 UI 和通知；见 [业务跟进](../integration/business-followups.md)。

模型费用人工核对沿用原 AI/POD 拥有者和预算账本，新增不可变补证事件。当前权限、原请求匹配、依据指纹和事件链由 API/数据库共同约束，原预算通过同事务事件投影纠正；没有建立另一套任务、费用累计或财务事实。人工 attestation 与提供方自动验真分别标记，见 [模型费用核对](../integration/model-billing.md)。

2026-10-18 / PRD 1.1.4：身份模块拥有可信团队及有效成员关系，目录命令使用原身份/RLS/审计边界，未引入另一套认证平台。商品拥有者服务沿父企划解析对象范围，独立的素材、研究、Listing和账户授权仍由各自归属决定；共享契约与API错误转换分别处理。见[团队与商品范围](../integration/catalog-scope.md)。

### Listing 拥有者和共享执行边界

1.1.6 复用原 listings/listing_versions/listing_replications、catalog-core 范围策略和本人身份，不添加另一事实库。Listing 当前归属由其 created_by 决定，当前没有 Listing 团队字段，不从商品归属推断共享。事务内父锁与版本归属检查控制审核和复制；业务权限仍在原服务拥有者执行。见[Listing 契约](../integration/listing-authority.md)。

## 渠道预检与原幂等回执

PRD1.1.10：原生商品拥有者统一包计数/列表的配方及 Listing 读取策略；只读预检属于 SalesPackageService。前后时间边界可按当前店铺读取，关联原包摘要另受来源权限约束。登记沿用 mutateDevelopment 与渠道事务锁，当前来源复核在缓存回执之前执行。订单服务继续拥有按下单时间匹配和原已保存依据，前端不重建另一套匹配事实。详见[渠道映射契约](../integration/channel-mapping.md)。

## 组合兼容身份与新操作边界

PRD1.1.11：目录拥有者统一 legacy/显式默认单项身份，查询旧哈希别名，不改写旧业务引用。沿用目录事务锁与唯一约束，款式身份表的应用只读/新增权限不扩大。生命周期仅检查新制作性操作，并与原权限检查及幂等结果分离；历史导出和渠道事实由原业务拥有者继续授权。见[原生契约](../integration/sales-composition-lifecycle.md)。

销售配方编辑与排队出图复用 catalog-core 的来源/范围检查，编辑器在目录拥有者的同一租户事务完成内部写入；AsyncLocalStorage 不跨 tenant/user 复用事务。队列原申请人与持久任务一致，当前授权及来源在完成事务内复核；历史文件读取和订单路径保持各自拥有者。见[原生制作生命周期](../integration/sales-editor-lifecycle.md)。

销售制作恢复复用原数据库任务及 BullMQ，0127 增加原生制作路由 UUID 索引、执行租约和派发节流；目录、当前租户数据、传输和业务事实分别校验。详见[恢复契约](../integration/catalog-render-recovery.md)。

Worker 按明确的消费者/调度器计划延迟构造领域服务，实际装配与计划一致后整体启动；无关模型、平台和订单密钥域不因进程启动而初始化。默认完整能力保持，可选能力关闭时拒绝显式选择。运行选择不代替拥有者的权限、版本、预算及恢复边界，合法依赖任务仍可写入其他队列。离线状态盘点复用 PostgreSQL 只读事务与 Redis 状态键，禁止据此自动批准任务。详见[Worker 运行契约](../integration/worker-runtime.md)。

研究/采集拥有者复用共享逐权限授权，不用全局最大范围作对象授权。API 在所属事务中重读当前成员，Worker 在外部 I/O 前后重读原申请人；队列只承载原记录引用。见[研究授权](../integration/research-authority.md)。

订单与跟进共享 authz 的请求/当前权限交集，业务事务仍由 order-core 与原服务所有。读写范围按具体权限检查，不能借全局最大角色范围；外部文件 I/O 不持有授权锁，返回/关联前重新复核。其他域及订单拥有者/团队绑定继续建设，见[订单授权](../integration/order-authority.md)。

原生素材 API 复用 authz 当前权限交集、成员与文件共享锁，在外部 I/O 之外保持短事务；存储成功、素材关联和结果交付分别核验。按拥有者渐进接入，不新建授权引擎，见[素材契约](../integration/asset-authority.md)。

原生设计和创意审核共享当前成员/请求上限与数据库时间，拥有者按各项权限检查；原版本、素材、目标SKU及更新事务由既有模块持有。签名在外部I/O之外保持短事务，返回前复核父级，见[设计事务契约](../integration/native-design-authority.md)。

画布/工作区/独立生成入口复用当前授权及短事务；存储和扫描等待在事务外，I/O 后新事务复核再返回或关联产物。项目、规格家族、创意和素材分开授权；旧 Worker 仍需单独迁入原意图/预算/响应恢复。见[当前边界](../integration/canvas-workflow-authority.md)。


套图管理与实际消费者复用 catalog-core 当前对象/来源策略、pod-core 原完成凭据和原执行记录。治理服务拥有产物权利确认及候选绑定，不新增跨模块事实表或第二套批准来源，见[运行契约](../integration/mockup-management-authority.md)。

本地 Web 候选复用 Next.js 生产构建及既有启动器，独立保存源码/公共文件与运行产物，依赖保持明确的本地只读共享关系。启动前检查封存构建和个人身份设置，隔离验收固定实际候选；普通采用与正式发布继续按[运行契约](../integration/local-web-candidates.md)分别核验。

2026-10-20已把实际业务备份、恢复升级、2,459项源码及当前编译Web/API配对采用，普通库为0135，HTTP制品摘要与封存构建一致。个人登录表单可用，本人会话仍待确认，Worker保持停止。此本地部署仍共享依赖，正式干净制品、CI和全平台验收没有由此完成，见[普通运行采用](../integration/normal-runtime-adoption.md)。

## 逐项质检的三层分工 · 1.1.28

数据层在原质检表中保存不可变的 V2 逐项事实、标准版本和生产依据；Harness 层复用当前受权、确定性评分、原投影并发、原请求指纹和审计；Agent 层只提供辅助建议，不替实物检查、责任调查或生产批准。生产、质检与整单使用相同原生产锁，相关发货处理通过非等待锁返回可恢复冲突。未新增模型框架、队列或平行生产事实。见[质检契约](../integration/quality-assessment.md)。


## 发货批次关联的三层职责 · 1.1.29

数据层通过发货模块拥有的不可变分配连接包裹行、生产单、生产版本和原通过质检，复合外键及强制RLS约束归属。Harness在当前订单权限内按订单、商品、生产、发货锁顺序复查来源与可发量，保留原请求和当前失权边界；实际物流不能被重试当成新的出库许可。Agent只提出有来源的候选，不确认实物装箱或伪造原质检。整批合格来源不等同于部分合格实物分组，后者仍须建立事实。见[发货来源契约](../integration/shipment-production-sources.md)。


### 1.1.30 分组拥有者

订单生产模块拥有分组检验、组间替代及缺陷影响数量，发货模块只持有原组和合格依据引用。数据层提供租户复合约束及不可变历史，Harness负责原依据、当前组、权限、并发数量和回执恢复，Agent不确认实物。沿用既有开源依赖，见[分组契约](../integration/quality-groups.md)。

逐项及分组质检由同一事务入口协调检验、订单异常与审计；仍由各模块拥有者写入。商品状态采用共享业务锁和不可等待的行共享锁，兼容整单操作已持有的同事务锁，并阻止归档或资料清除与新检验相互越过。历史回执恢复不重新执行质量检查或补写历史事实。

## 制造基础增量 · 1.1.31

制造基础复用商品拥有者、当前成员与库存主数据读取，新增独立制造版本及审核/回执，不复制销售配方、工厂或库存账。请求锁后统一取得商品父对象及模板锁；不可变版本只读，可变身份单独加锁。材料/工序在版本创建事务封存，版本、回执与审计同笔提交。无新框架、队列或付费调用。见[制造契约](../integration/manufacturing-recipes.md)。


## 制造工作台三层职责 · 1.1.32

数据层保留制造版本、审核、原响应和审计；Harness在当前个人权限与商品范围内协调BFF/REST、短期草稿、并发版本、响应丢失和迟到响应；Agent仅辅助整理草稿与解释提案，不取得制造审核或生产事实权限。沿用现有Zod、Next、OIDC和原生ViewTransition，不增加框架或队列。见[制造契约](../integration/manufacturing-recipes.md)。

生产接入：0134以同事务不可变伴随证据固定生产的原制造来源；订单拥有者读取并校验原制作修订，商品拥有者核对当前ProductRead/对象范围及已批准制造版本，设计拥有者核对直接生产的原审核设计与生产文件。工厂候选和提交复用原SKU、产品计划、规格工艺和尺寸依据。新生产提交前要求绑定，历史缺项不补造。

### 制造交付三层职责 · 1.1.33

数据层由原订单拥有者封存V3制造快照和交付元数据，租户复合外键、原事务封存及不可变历史保护确切生产来源。Harness在当前订单或工厂任务范围内读取安全投影，确定性计算精确计划用量，核对原文件和制造指纹后同笔提交回执、里程碑与审计。Agent可以解释材料和工序，不能确认实际供料、工厂接受、完工或质检。复用现有模块和Zod/PostgreSQL/OIDC，无新执行框架或平行制造账。旧V1/V2原字节不变；工厂桌面/手机已局部验证，运营页面、候选恢复及普通采用继续。见[制造交付契约](../integration/manufacturing-delivery.md)。

### 运营命令恢复 · 1.1.34

运营页面沿用原订单拥有者命令，前端在结果未知时固定原路径/正文/请求编号并阻止新操作，BFF保留明确的提交后身份变更代码。服务器仍按当前成员和原操作员恢复原回执，页面不建立平行生产状态。制造读取的临时失败、当前失权及迟到响应分别处理；未将私有正文写入浏览器持久存储。此项不等于全部Harness、跨设备恢复或实际生产批准完成，见[操作契约](../integration/production-operator-handoff.md)。

### 生产来源拥有者与命令适配

数据层沿用订单行、原工作修订、规格/设计/制造版本、路由和采购版本及原生产数量账，无新增表。NativeProductionService 只组合已有拥有者的当前授权读投影，设计/素材对象范围在设计拥有者内核对；生产写入仍委托 OrderProductionService 的原锁、事务、制造封存、工厂检查和审计。BFF 严格限定路径、查询与同源输入并绑定回执的商品和订单。HTTP 输入格式错误在业务调用前成为已知400；业务或输出故障保留服务器错误语义。Harness 协调原意图恢复，Agent 不能替人批准来源或工厂认可，见[契约](../integration/production-entry.md)。

## 1.1.40 连接骤断与依赖身份

API与数据库实际中断验收复用独立PostgreSQL、Docker和原HTTP身份路径。断连事务及其迟到查询必须失败，重连不能继续旧事务，也不能自动重放生产。精确Postgres.js补丁的源码、依赖锁和封存副本共同进入运行身份与升级指纹。原普通环境仍须通过最新配对恢复及受控采用，见[本批证据边界](../project-control/PRODUCTION_RESTART_PROGRESS_20261020.md)。

## 1.1.41 普通运行身份

普通数据库已受控采用136，API/Web使用4472b6e5源码和88054构建。最新135业务备份先在独立库/桶恢复和升级，完整结构与规范库匹配后才应用普通库；原迁移历史和三条旧采用记录保留，仅追加一条运维采用记录。运行资源摘要、匿名保护和非拥有者就绪已有证据，Worker仍停止。其他部署、正式CI和完整业务验收不能由本地采用替代，见[采用进度](../project-control/PRODUCTION_ADOPTION_PROGRESS_20261020.md)。

## 1.1.43 只读观察的拥有者边界

ShipOS服务在原租户事务、连接咨询锁及幂等判断后预留同步序号；结果提交持有连接写锁。发货拥有者在所属包裹事务中验证当前权限、配置版本、运单和渠道，同时持有连接共享锁；反向等待时明确返回可重试冲突。Agent及Harness不能以缓存时间、旧观察或自动重试绕过该边界。复用PostgreSQL及Drizzle，无新增依赖或外部写接口，见[只读集成](../integration/shipos-readonly.md)。

## 1.1.44 精确库存与原BOM实际物料

数据层使用同一精确数量契约、库存账和不可变生产物料因果记录；原BOM校验由交付与耗用共用。Harness层在当前成员/权限事务内协调订单、生产、预留及库存维度锁，扣料、余量变化、回执和审计原子提交。Agent层可根据固定BOM提出计划及偏差提示，实际耗用仍须有获授权的操作员确认。页面跨刷新恢复还需要持久的原意图准入，不借用三类生产创建命令的生产单ID回执。

接口、已验证结果与剩余项见[物料契约](../integration/production-material-execution.md)及[本批进展](../project-control/INVENTORY_EXECUTION_PROGRESS_20261020.md)。

## 1.1.48 分类与收货的三层边界

数据层分别保存物料身份、分类修订、原采购/收货和私有成功请求依据，不重写旧物料或旧收货。Harness复用原库存/采购拥有者，在当前及原权限交集内协调版本、请求、行锁和同笔审计；最小成功依据不冒充跨刷新持久意图。Agent可整理候选分类或标准，不能制造实到、检验核准、特采或库存所有权。完整来料检验继续按[数据和事务设计](../architecture/incoming-material-inspection.md)实施，141/142已完成隔离验证及最新业务配对备份/独立恢复演练，普通本地142采用当前477c源码；完整业务验收继续。

### 1.1.87 受控读取实际路径

统一工作台/个人BFF或具名只读Client → AgentReadService → 原HarnessRegistry固定工具 → OrderService/InventoryService → withTenant非owner RLS。Owner在同一repeatable-read内核对真实成员和逐项范围、计算全集合指纹与有界页；最终返回再次核对身份。没有新增Agent业务表或第二套库存/订单事实。普通receipt沿原AssistService读取，不发queue、预算或模型调用。跨域计划和MCP仍是下一步。

<!-- c4a83b17-detail -->
### 1.1.88 完整上下文与原入口

个人BFF → AssistTargetPageService → AssistTargetPageOwner → 共享原源投影 → withTenant非owner RLS。旧v1用同一源和原排序/40+hasMore，新版本计算全投影、固定加密游标和有界页；返回再次核对完整身份。此API提供对象选择上下文，不冒充新的通用Agent工具。知识聊天和批量订单沿原AssistService/预算/队列/Worker及GET receipt，无新任务数据库。
<!-- /c4a83b17-detail -->
