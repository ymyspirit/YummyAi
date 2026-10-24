# 数据模型、状态与接口契约

<!-- studio-paid-image-73e2c9b1-current -->
PRD1.1.127 schema190追加本人隔离图片准备和取消围栏；原generation、预算ledger及执行stage在同事务出生，旧业务表与历史输入不重写。当前为开发与隔离验收中，事实以[本片进度](../project-control/STUDIO_PAID_IMAGE_PROGRESS_20261024.md)及[专项契约](../integration/studio-paid-image.md)为准。以下旧版本保留当时状态。
<!-- /studio-paid-image-73e2c9b1-current -->

PRD1.1.126 冻结独立采用请求/来源basis/有限处理及不可变回执，拟新增0189，旧执行与0188字节保持。本片开始实施，尚未验收或采用，当前事实以[本片进度](../project-control/CREATIVE_RESPONSE_ADOPTION_PROGRESS_20261024.md)及[采用契约](../integration/creative-response-adoption.md)为准。下方旧版本段落保留对应历史时点的状态。

PRD1.1.121补充：拟新增 creative_studio_transfers，固定本人原请求、完整源/目标清单、原件pins及一次追加回执。条目和版本仍沿 creative_studio_entries/revisions；原媒体不重写，复制的业务动作意图不转移。188迁移当前仅源码，尚未日用采用。见[复制规格](../integration/studio-document-transfer.md)。

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

1.1.78的0164仅将三处私有密文允许到期置空并附清文时刻，新增强制RLS的source_purges；原ID/hash/观察/请求/结果/审计不变。来源时钟独立且清文不可复活，原应用序列和非私有来源分页不含原单元格、文件名和运单。新表租约与审计闭包由SQL约束。 见[来源保留](../integration/factory-erp-source-retention.md)及[本批进度](../project-control/FACTORY_ERP_LIFECYCLE_PROGRESS_20261021.md)。

1.1.77契约固定模板pillow-erp-2026-10-21-v1、5MiB/5000行、13表头、明确编码/分隔符和三原状态。外部编号按同工厂绑定整组原deliveryItem/production/version/file/manufacturing及数量，未知不猜。原文件和密文SHA分开；原日期无时区不转UTC。新0163只新增空来源/应用/绑定/绑定项/观察/应用行，真正162升级不改原列或私有JPG。 见[工厂导入契约](../integration/factory-erp-status-import.md)及[本批进度](../project-control/FACTORY_ERP_IMPORT_PROGRESS_20261021.md)。

1.1.76将工厂外部状态限定scheduled/shipped及其已确认中文原值。原始文件按真实字节hash，原表头/行号/单元格/原状态保留；factory+外部单号/条码绑定固定production/version/deliveryItem。歧义不自动取最新，缺数量保持未知，旧scheduled不倒退shipped。新清点0162为未采用草稿，未注册公开controller、未进入正常页面，不计完成。 见[工厂两态与表格契约](../integration/factory-erp-status-import.md)。

1.1.75的0161新增quality_scrap_reviews及quality_scrap_allocations两张不可变表，逐行固定sourceQuantityReviewId。新增批次量仅为本次S减前次S，零增量无新额度。scrap缺陷须有实际组链接；补做案件原production/defect/type来源固定，正常状态更新保留。 见[实物组报废归属](../integration/quality-scrap.md)。

1.1.74的0160新增清点报告、核准和原资源停做效果三张追加表。四个互斥实物桶允许未知，已分配及已交运是已完工的去向子集；四桶＋累积已核准停做＝原数量。初次覆盖和补做余量只减原固定版本已核准停做量，不从cancelled退整批。 见[实际数量与部分停单](../integration/production-physical-quantities.md)。

1.1.73新增明确计量的共享产能池、固定工厂当地日历和跨订单有限预约，0159以真实生产版本/里程碑出生事务证明绑定五张RLS账表。三种下达及三种补做均明确完整池版本与当地生产日，原owner同事务预约、审计、开工承诺及确认取消释放；预览聚合同池同日需求且不占额度。显式拒绝DST gap/fold、未知旧占用、缺绑定和过期版本；旧原文/成功回执精确恢复而不补造历史预约。64单元/规则、229去重集成及15去重个人页面通过，页面按失败增量复验，保留14项通过、最终编译复验1个整单场景，没有宣称15项全在同一候选。自有输出已清理。真实部分停单数量释放、普通环境采用及完整业务继续。原私有来源读取还补齐父订单先于子项的锁顺序，保留权限、隐私及版本检查；浏览器实际40P01促使增加确定性真实锁等待回归，未吞错或盲目重试。 规范见[工厂日历与共享产能](../integration/factory-capacity.md)。

1.1.72修复工厂租户读取与本人写入混合范围的越权门禁，各操作在事务内重核当前成员及请求上限；四种新版本与审计原子提交，原键精确回放不增版本或审计。历史固定真实工厂、不可变版本时间和权限标记，前端清除失权状态并拒绝迟到回填，专门识别I/O后的authority_changed。生产里程碑沿原状态机，将既有审计移入同事务。本批65项单元/规则、35项去重集成和同编译3条个人OIDC页面定向通过；自有输出已清理，无新迁移或普通采用。真实产能账及完整平台继续。 规范见[工厂权限与生产事务](../integration/factory-authority.md)。

1.1.71：独立子包@yummyai/contracts/advertising/command定义七类原写、本人摘要/原文/状态/实际结果及账户查询。0158新增原命令、实际INSERT证明、父对象两阶段变更证据及原owner审计收据四表，全部forced RLS；后三表应用角色只读。原命令成功只能由实际业务列投影、完整事务ID及同事务双审计闭合。原namespace沿tenant/account/kind，action/archive另含真实父对象，不冒领旧raw或换键同业务。完整规范原文32MiB、密文45MiB，原CSV单文件5MiB/批20MiB/HTTP28MiB边界保持。见[原提交契约](../integration/advertising-original-requests.md)。

1.1.70：正式子包@yummyai/contracts/advertising/history提供八类摘要分页、精确原ID和事件白名单；pageSize默认25上限100，事件必有原parentId。游标绑定当前身份/权限、账户/类型/父对象/页长及数据库微秒创建截止和真实锚点；固定创建队列不冒充跨请求MVCC。actionContext只含原目标ID、观察天数及最早复盘日，缺原目标明确legacy_default7天。工作区historyWindow明确200/10近期范围，动作预览eventsComplete=false，不能冒充原动作完整事件。原分析与封存JSON不回填，同账户同推荐key允许引用旧run动作。无新表或迁移。见[读取契约](../integration/advertising-history.md)。

1.1.69：measurement固定实际原列、adapter、转化模型/窗口/操作者核对来源和固定ISO金额依据；分析measurementPins按来源和币种保原SHA、采集日期/时区及撤回截止，补值前固定。新preview checksum绑定allowPartial和完整指标依据；旧raw公式与缺测量JSON不回填，新原提交仍同事务审计。CSV2显式有版本，旧无flag沿原算法。正式包出口为@yummyai/contracts/advertising/measurement，无新表或迁移。见[测量契约](../integration/advertising-measurement.md)。

1.1.68：广告workspace/facts显式固定请求账户、ERP规范JSON身份与当前逐项权限；BFF严格校验来源字节SHA、目标/动作修订及原操作回执。contextAuthority使用既有erpSessionAuthority，不能误作SHA或凭据。Write/Review回执不赋予任意历史Read。见[广告权限契约](../integration/advertising-authority.md)。

1.1.67：新增原财务执行结果与六类分页ABI；command/result/kind/target/原版本、币种和保存金额共同绑定。游标固定tenant/user/command/result/section/limit与真实上一行锚点，根8MiB、页4MiB超限拒绝。原余额缺项、原保存值与当前核验显式区分，不增事实或回填历史。见[历史读取契约](../integration/finance-recorded-results.md)。

1.1.64：迁移156追加finance_cost_allocation_versions、finance_allocated_profit_runs、finance_allocated_profit_slices，保留旧列/账本/hash。先一次FX折算原reporting minor，再BigInt最大余数，SQL使用精确div独立证明floor/余数/零份额及守恒；source family完整，真实tuple和版本集有checksum，直接归属或明确分摊只选一处。完整事务必须有全部原贡献及同actor同事务审计，审计后/已提交run不能晚追加。见[本批进度](../project-control/FINANCE_COST_ALLOCATION_PROGRESS_20261021.md)与[费用分摊契约](../integration/finance-cost-allocation.md)。

1.1.63：共享finance/ledger契约固定15类、真实父关系、完整children与nullable摘要。游标为canonical base64url版本位置，固定首次上界/末行及查询scope；它没有签名授权能力。排序使用原UUID，保留PostgreSQL微秒时间。下一页严格小于原末行，BFF核对原上界及next末行；来源诊断不伪造金额。见[本批进度](../project-control/FINANCE_LEDGER_PROGRESS_20261021.md)与[读取契约](../integration/finance-ledger.md)。

0155追加 finance_bill_adjustments / finance_payment_adjustments 两张强制RLS不可变表，原0153本金、151采购事实及旧迁移摘要不改。更正保存原对象/供应商/币种、规范输入/摘要、本人/幂等键和不可变balanceAfter；真实采购固定原record/review IDs，零额来源确认不伪造贷项。净额、剩余量和来源状态由全账本函数计算，有界列表与格式诊断不能代替容量。

当前1.1.62的应付更正、真实采购同步与已发生退款登记已完成局部验证；普通148仍停止、155未采用。以下版本段落保留历史观察，当前证据以[更正进度](../project-control/FINANCE_ADJUSTMENTS_PROGRESS_20261021.md)和[接口/边界](../integration/finance-payable-adjustments.md)为准。

0153 的 finance_payable_bills、finance_payable_payments、finance_payment_allocation_batches、finance_payment_allocations 和 finance_allocation_releases 是独立不可变账簿，不写回原成本或库存。供应商采用既有 fulfillment_suppliers；采购来源固定真实发票及149原凭据，金额依据未知保持未知。原批次输入/校验值、创建事务和同笔审计共同约束追加行；核销及释放按全部有效行精确计算余额。日期统一UTC毫秒，ID规范为小写UUIDv7，未知响应仅支持当前页原键恢复，完整契约见[实际应付与付款核销](../integration/finance-payables.md)。

1.1.60推进B45：独立工厂/供应商应付、人工登记的实际付款证据、部分及多账单核销与追加撤销；当前权限、同事务审计、整批闭合与双向余额由拥有者和SQL共同约束。100定向单元、34去重隔离（含真正148→152→153未知来源与全部旧列/账本保留）及同一编译包2个人浏览器通过。8个自有目标4667文件/779370026字节与313依赖链接已清，6组隔离资源两次独立查无；87保护项/2598普通源/8备份保持，883冻结路径和旧1缓存/2草稿保留。应付更正/付款退款、既有财务拥有者整改、普通153采用及完整平台继续，普通库仍148、六应用停止。见[本批进展](../project-control/FINANCE_PAYABLES_PROGRESS_20261021.md)与[集成契约](../integration/finance-payables.md)。

1.1.57新增invoice_reconcile三分支严格契约、当前详情/分页及第三种结果凭据外键；事件内balance是执行时结果，GET详情按原票+已核准事件重算当前余额。0151追加inventory_invoice_reconciliations和inventory_invoice_allocation_effects；consume/release必须追溯真实收货及原allocation/consume。原表只补必要来源唯一键与准入，不改旧迁移/checksum/密文。金额用精确余数检查后整除，非整最小货币单位不舍入，差额保持NULL及原因。缺149依据的真实148旧票继续未知，不能用今天规则重建历史，见[发票纠正设计](../architecture/procurement-invoice-reconciliation.md)。

1.1.56新增invoice_record命令的expectedVersion必填，但149 raw输入继续兼容省略值。canonicalProcurementInvoiceRequest逐字复用149的version/purchaseOrderId/input和原行序/日期规则；旧六类ProcurementWriteKind不扩展。发票result无自身版本，versionId/version为NULL；invoiceResult从真实149 proof按权限读取，含数量分配、币种、明细和nullable差额。0150不回填或重写旧事实、密文、摘要及账本；真实149→150保持已验，普通仍148。见[发票原提交验收](../project-control/INVOICE_COMMAND_PROGRESS_20261020.md)。

1.1.55采购、MOQ、补货和发票使用既有九位StockQuantity，真小数为规范十进制字符串。新增stockBasis与priceBasisQuantity固定单位换算/计价，库存批次unitCostQuantity保留整数minor对应的库存数量；不足一个minor或溢出拒绝，不隐式舍入。0149增加supplier invoice requests/allocations，发票和明细varianceMinor允许NULL表达真实未知，quantity allocation complete与金额matched独立。历史新列保持NULL，真实148→149原列/账本/146凭据/147密文/148标记保持已验；普通库未迁149，见[采购计量与发票进度](../project-control/PROCUREMENT_PRECISION_PROGRESS_20261020.md)。

1.1.54普通数据库已受控升级至148。351张原表的既有数据、145账本前缀和8份原采用记录在升级中逐项保留；采用后350张非receipt表105838行和8旧记录再次分别核对，只增加1份绑定本次备份、源码及完整schema的采用记录。1834私有对象保持；三项实际维护无到期原文可清，成功批次与原业务事实分开记录。新备份与双轮核对见[本轮采用与受阻状态](../project-control/PROCUREMENT_ADOPTION_PROGRESS_20261020.md)。

1.1.53追加0148，不修改0146/0147及原迁移账本。`inventory_procurement_rfqs.creation_transaction_id`只在真实INSERT由触发器写入当前完整事务号，之后不可改变；旧值保持NULL。新的rfq_create凭据必须匹配该插入事务，普通status更新不能制造新建事实。六类旧操作缺少原文时，在准备之前返回`procurement_input_unavailable`，不保存猜测的原文或待执行状态。本人恢复按kind/target筛选后再分页，权限和幂等域不因页面改善而改变。实际证据见[采购恢复进度](../project-control/PROCUREMENT_RECOVERY_PROGRESS_20261020.md)。

1.1.52的0146保存六类实际前段采购凭据，0147保存七种严格原文命令、本人、权限上限、独立密文、七天时效和实际结果引用。准备和事实共享operation/key域锁；新成功绑定同一事务的新凭据，反向延迟约束拒绝事实落地而命令仍待执行。数据库拒绝缺身份的authority快照，旧实际事实不得追认为新命令。来源、UUID/ISO语义和业务代码规范继续共用同一v1规则，错密钥保留原密文。普通库仍145，147只在隔离库，见[采购原请求](../integration/procurement-original-requests.md)。

1.1.49新增独立来料标准、到货头/行、检验修订、核准、入账及实际退回事实，并用私有原命令保存加密规范输入和最小实际结果。0143保持旧收货数量而转换精确类型；0144保留旧采购空声明并要求新采购走检验；0145将命令与实际拥有者事实绑定在同一非拥有者租户事务中。原文丢失不能由当前页面重建；版本变化保留原文重新核对；到期只清除副本和过期准备，不删实际业务历史。本地145已由最新业务配对备份与独立恢复演练采用，原表原列、历史迁移与七份旧采用记录保持；没有补造旧来料事实，详见[进度](../project-control/ARRIVAL_INSPECTION_PROGRESS_20261020.md)。

API正文与路径校验不通过返回400；当前权限变化、业务依据冲突与结果未知分别处理。接受入库继续调用采购和库存拥有者，不另建库存写入器；到货与拒收保管不计入可用量。交接凭据最多2000字并完整传递，原批号保留中文和大小写，数量不经过浮点取整。接口、精确数量及有界历史视图见[来料契约](../integration/incoming-inspection.md)。

1.1.48的0141以独立不可变分类修订保存物料类别、原因、原请求绑定及服务器时间；原物料、基本单位和库存流水不改写。0142将新收货头与私有原请求依据同笔约束，校验原采购单/版本、实际操作者和规范内容；旧收货无依据保持未知，不能事后补造。两项迁移已隔离验证，并经最新业务配对恢复/升级演练采用普通本地142；旧历史保持且不补造依据。具体API和分页见[库存](../integration/inventory.md)、[采购](../integration/procurement.md)；完整到货/检验/接受入账的数据关系仍按[后续设计](../architecture/incoming-material-inspection.md)实现。

1.1.47沿用0140，不增加迁移或另一套物料事实。原加密输入清除只更新允许的留存字段及prepared到expired，终态及entry引用保持。`worker.maintenance`仅输出固定调度器名、completed/deferred/failed和tenants/redacted/failures整数；不含对象ID、密文、填写或原错误。无实际批次的重叠触发不能输出completed。事件是运行观察，不是物料业务回执。

[规格事实V2](../integration/specification-facts.md)保存在原规格版本JSON中，明确物理口径、
测量值、单位、结构、包装、重量和核验依据。新确认由服务器版本记录投影操作者和
提交时间；旧布尔确认不补写新证据。新工作与原固定订单、包和请求重试分别检查。
产品规格的标签页草稿按原版本和当前身份隔离，两小时内可恢复，退出或失权清除。
本次没有新增数据表或迁移，通用表单仍默认使用内存。

[工厂能力契约](../integration/supplier-factories.md)复用原不可变 JSON 资料版本：
草稿中的未知时区和 MOQ 显式为 `null`，已有值不回填或替换；启用分别核对。
新生产选择要求本单有效尺寸和工厂完整的毫米范围，候选、下达与返工预览使用数据库
事务时钟。原生产单与包的快照不改写，本次没有新增数据库迁移或依赖版本。

历史多重绑定通过 `spus.legacy_plan_ambiguous` 明确保留；企划返回全部原 SPU 候选而不选择默认值。新关系仍唯一，共享企划修改与原 SPU 子资料分别授权。升级核验凭据属于只读基础设施元数据，由独立操作身份在原数据、原账本、私有对象和源码对应结构一致后追加；不承载租户业务事实。见[升级契约](../integration/legacy-runtime-upgrade.md)。

[商品界面权限](../integration/product-access.md)读取原个人会话，不另建授权事实副本。
客户端只控制入口和编辑状态，业务 API 继续校验当前角色、对象及原状态。无效字段
草稿阻止保存上次有效值，稳定编辑行身份不进入业务 Schema；所有提交仍通过原接口
校验和事务。此次没有新增数据表、外部依赖版本或生产配置。

[运营身份读取](../integration/erp-identity.md)新增严格的个人会话 DTO，包含当前成员、
租户标签、普通角色和资料范围；不接受调用者指定用户/租户，不把 API 客户端当作
个人会话。复用现有成员表和服务端加密 Redis 会话，无新增数据库迁移。返回业务响应
前检查会话和权限；变更返回 409 并要求核对原操作，不能推导事务已经回滚。

AI 辅助新增 `ai_assist_executions` 作为原模块的执行元数据，迁移 0116 随新 run 与预算
一起记录持久意图；不回填旧任务。固定输入/策略校验值、提交状态、租约、派发次数和
加密响应校验值分别保存。RLS 与复合外键绑定原租户和运行；响应不可替换，原件到期
可清理，非敏感引用与财务证据保留。恢复和兼容语义见 [Harness 运行说明](../integration/agent-harness.md)。

R36 的 [责任与提醒契约](../integration/workflow-responsibility.md) 复用工作流节点，保存负责人、内部截止、升级接收人、责任修订与派发检查点；真实变更追加事件。通知与节点检查点原子保存，唯一去重键跨重启有效；已读时间不改变业务完成状态。旧任务未设置的日期与责任修订保持缺失。通知分页用数据库原始时间与 ID，不用浏览器时间代替排序边界。

版本：1.1.121 · 目标设计与局部实施。表名区分“现有映射”和“拟新增概念”；实际迁移与接口状态以当前实施证据为准。

业务任务中的 [工作流待办投影](../integration/workflow-task-inbox.md) 复用原节点表，当前权限与产品范围在租户事务内重读。筛选后的完整计数和分页行使用同一只读快照，固定数据库时间与所选时区；归档商品不伪造任务完成。迁移 0113 仅加索引，不新增任务事实或历史补齐。

## 1. 身份与版本链

本地新增0136的`production_command_intents`与`production_command_attempts`用于三类[生产持久恢复](../integration/production-command-recovery.md)。原操作者/路径目标/正文指纹/权限上限不可变，加密正文与当前执行token分离；业务最小回执来自原生产事务。来源清理或本人确认仅清除正文和恢复投影，不删除生产、指纹或尝试。普通库当前仍为0135，独立定时扫描及其余域继续验收。

~~~mermaid
erDiagram
  TENANT ||--o{ MARKETPLACE_ACCOUNT : owns
  TENANT ||--o{ SPU : owns
  SPU ||--o{ SPECIFICATION_VERSION : versions
  ARTWORK_MASTER ||--o{ ARTWORK_VERSION : versions
  SALES_SKU ||--o{ RECIPE_VERSION : versions
  RECIPE_VERSION }o--|| SPECIFICATION_VERSION : pins
  RECIPE_VERSION ||--o{ PRINT_BINDING : contains
  PRINT_BINDING }o--|| ARTWORK_VERSION : pins
  SALES_PLAN ||--o{ SALES_PACKAGE_VERSION : seals
  SALES_PACKAGE_VERSION ||--o{ CHANNEL_MAPPING : fixes
  MARKETPLACE_ACCOUNT ||--o{ ORDER : receives
  ORDER ||--o{ ORDER_ITEM : contains
  ORDER_ITEM ||--o{ REQUIREMENT_REVISION : versions
  REQUIREMENT_REVISION }o--|| RECIPE_VERSION : pins
  ORDER_ITEM ||--o{ ARTWORK_TASK : requires
  ARTWORK_TASK ||--o{ ARTWORK_OUTPUT : versions
  ARTWORK_OUTPUT ||--o{ PRODUCTION_ALLOCATION : fulfills
  FACTORY_CAPABILITY_VERSION ||--o{ PRODUCTION_ALLOCATION : accepts
  PRODUCTION_ALLOCATION ||--o{ QC_EVENT : verifies
  PRODUCTION_ALLOCATION ||--o{ SHIPMENT_ITEM : dispatches
  ORDER_ITEM ||--o{ AFTERSALES_CASE : concerns
~~~

主档 ID 表达业务身份，version ID 表达当时事实。可变投影保存当前版本和可搜索字段；不可变版本保存执行与审核依据。外部编号不替代内部 UUID，不以文件名推断订单归属。

## 2. 数据域与实体清单

| 域 | 核心实体 | 必要字段与关系 | 当前工作树对应 |
| --- | --- | --- | --- |
| 身份 | tenant、member、role、scope | 认证主体、有效成员、权限版本 | authz、tenant-transaction |
| 研究媒体 | capture_snapshot、capture_media | 不变来源与原始位置、字段/归档状态、研究域校验值/扫描证据、租约、重试及补发；历史位置缺失保留 | capture.ts；0108/0111；分页预览与受权 Range 读取见[归档契约](../integration/capture-media-archive.md)，真实外部与完整 B13 另行验收 |
| 工厂权限 | factory_access_grants、factory_task_assignments、factory_task_receipts | 当前成员、具体工厂/文件分配、有效期、不可变回执来源和单向撤销 | 0125、个人OIDC加密会话、工厂专用入口和运营分配复用原交付拥有者；本地技术验证与正式身份/工厂试点分别登记，见[工厂协作](../integration/factory-portal.md) |
| 产品 | SPU、specification_version | 结构、尺寸口径、材质、重量、包装、确认状态 | catalog.ts、product-development.ts |
| 原创 | artwork_master、artwork_version | 来源、权利、原件、客户字段、适用范围 | product-development.ts |
| 组合 | sales_sku、recipe_version、print_binding | 规格、印花、制作面、区域、布局和字段映射 | salesSkuDefinitions、salesRecipeVersions、salesRecipePrintBindings |
| 销售 | sales_plan、sales_package_version | 市场定位、资料、价格、定制定义、审核、校验值 | sales-plans.ts、salesPackageVersions |
| 渠道 | account、capability、channel_mapping | 店铺、站点、平台 SKU/ASIN、能力来源、生效区间 | marketplaces、salesChannelBindings |
| 订单 | order、order_item、source_version | 外部订单商品身份、数量、来源、观察时间 | order.ts、amazon-order-reports 相关 Schema |
| 需求 | requirement_revision、rule_snapshot | 原图引用、文字、选项、映射、配方、规则版本 | order-intake、order-design 及规则快照；需核验字段覆盖 |
| 制图 | design_run、output_version、check、approval | 模型/配方/输入、实际像素、检查报告、审核身份 | production-editor、order-design |
| 供应 | supplier、factory_version、capability_version | 法人、实际地点、模板、工艺、样品、有效期 | factory-directory.ts、order-routing.ts |
| 制造 | 制造模板与不可变版本、BOM行、工序、审核及原回执 | 精确耗量、单位、损耗口径、材料/工序责任、原规格和独立工厂参数 | 0133基础实施中；页面、生产固定制造版本、实际耗用和产能预留继续建设，见制造契约 |
| 产能 | capacity_slot、capacity_reservation | 工厂能力、当地日期、计量单位、预留和释放 | supplierCapacityWindows 等；并发门禁需核验 |
| 生产 | production_order、allocation、delivery、feedback | 商品行、正式文件、工厂、数量、版本、交期、回执 | order-production.ts、order-production-delivery.ts |
| 品质 | inspection、nonconformance、remake | 检查项、证据、不良数量、责任、原单关联 | 现有生产/售后需扩展统一缺陷模型 |
| 采购 | requisition、RFQ、PO_version、receipt、invoice | 供应来源、数量、金额、收货、发票、差异 | inventory-procurement.ts、order-routing.ts |
| 库存 | stock_item、lot、movement、reservation、transfer | 所有权、位置、单位、数量、成本与依据 | inventory.ts |
| 物流 | parcel、quote、purchase_intent、label | 地址版本、尺寸重量、路线、预算、外部参考与结果 | logistics 相关 Schema 与 package |
| 售后 | case、refund_intent、replacement_entitlement | 商品、原因、数量、金额、批准范围和执行证据 | order-after-sales.ts 与相关服务 |
| 财务 | statement、fact、reversal、FX、profit_run | 来源唯一键、最小货币单位、币种、发生时间和口径 | finance 相关 Schema |
| 广告 | report_version、fact、goal、analysis、action | 粒度、时区、归因窗口、目标与审核 | advertising.ts |
| 运行 | job_intent、dispatch、inbox、audit、retention | 幂等、租约、重试、安全状态、到期与删除证据 | 各模块已有实现，通用化前逐项盘点 |
| 评测 | evaluation_set、run、judgement、cost | 脱敏样本、基线、模型路由、关键错误和完全成本 | 拟补充并复用 AI 任务基础 |

不得直接照本表创建重复表。先映射已有 Schema、服务和迁移，再写差距设计；目标概念与物理表允许多对一。

## 3. 通用字段与约束

- 所有租户表包含 tenant_id；跨表关系使用包含 tenant_id 的复合外键。普通角色不能绕过 RLS。
- 可编辑主档含 revision、status、created_at、updated_at；写入检查 expectedVersion。
- 版本含 parent_id、version、schema_version、effective_at、created_by、source_ref 和固定内容；批准后不原地改写。
- 非敏感审计保存 actor、action、object_ref、before/after version ref、reason_code 与 trace_id；不抄录买家要求全文。
- 归档与软停用影响新选择及日常列表，不删除历史外键。统计和搜索使用同一可见性条件。
- 采集时间、业务发生时间、外部观察时间、生效时间分别存储，均有 UTC 时刻；截止规则另带 IANA 时区和本地日期。

## 4. 订单数量账

对原销售承诺，始终满足：已取消的原承诺数量 + 已完成的原履约数量，不大于购买数量。未完成量从原承诺与实际履约计算，不用生产单总件数推算。

制造件数与销售件数分开。报废、补做、样品和返工都可能增加制造数量，但不能增加客户购买数量。补寄须引用批准的 replacement_entitlement，补寄出库不得超过其批准数量。

生产分配记录 orderItemId、purpose（original/replacement/sample）、entitlementRef、quantity、factoryCapabilityVersion、artworkOutputVersion。出库分配只消耗已合格、未取消、未被其他出库消耗的件或批次数量。

质检事件、报废与恢复采用唯一分配身份及状态机，防止同一不良件被重复减数。退款金额与数量另记；“退款一半”不能默认解释为“取消一件”。

## 5. 金额、单位和时间

金额采用整数最小货币单位，并保存 currency 和 minorUnit；不假定所有货币均为两位小数。Finance的新汇率通过rateUnit显式声明major_to_major，固定双方minorDigits和ISO表版本；新profit run固定v2算法和全部币种精度，按 A×n×10^目标精度/(d×10^来源精度) 逐事实用整数商余数半值远零舍入，再汇总。未知不当零，超界拒绝。旧basis为NULL且不回填；缺精度或跨精度单位的旧结果不显示确定利润。0152仅新增nullable monetary_basis，并校验来源/贡献/总额与同事务封口；见[财务契约](../integration/finance.md)。其他费用及付款/总账领域仍按各自规则建设，不能由这一局部公式推导完整结算完成。

区分 estimated、quoted、booked、paid、reversed；同一费用从报价转实际时关联原成本项目，不双重计入。税额单独分类；平台代收税不能默认成为营业收入。

物理尺寸用明确单位与 measurementBasis，区分可见图案、裁线、成品和包装。重量规范化到克，供应商接口所需公斤只在适配器边界转换。PPI 依据实际像素与放置尺寸计算。

工厂截单与产能按当地工作日历计算，保存日历版本与 DST 处理方式。供应商的自然日、工作日、预计与承诺交期不能互换。

## 6. 版本固定与失效

订单快照至少固定：sourceVersion、requirementRevision、channelMappingVersion、recipeVersion、manufacturingTemplateVersion、ruleSnapshot、buyerAssetRefs；历史缺失保留明确诊断。

生产单另固定：approvedOutputVersion、operatorApproval、适用客户确认、factoryVersion、capabilityVersion、quoteVersion、capacityReservation、quantity、dueAt。

版本变化只使实际依赖该变更的后续动作失效。仅修改备注不触发重新制图；修改买家图片则要求重新检查、审核及后续交付。工厂已接受后改稿须停止原安排并新建交付，不能给旧回执换文件。

## 7. API 设计原则

继续使用共享 Zod 契约、/v1 路由和同源白名单代理。新版本只在兼容性需要时引入；蓝图中的目标接口实施前必须与现有 controller 对齐。

| 能力 | 当前可复用入口或目标接口 | 边界 |
| --- | --- | --- |
| 商品规格与配方 | /v1/product-development | 优先扩展已有服务，不另建平行商品模型 |
| 报告导入 | 现有 Amazon order report controller | 手工来源仍需扫描、精确身份和资料版本 |
| 制作编辑 | 现有 production-editor controller | 产物固定版本，检查真实字节 |
| 工厂交付 | 现有 production-delivery 服务 | 沿用不可变包和独立回执 |
| 工厂协作 | 目标 GET /v1/factory-portal/work-items | 只返回已分配范围与必要字段 |
| 工厂接受 | 目标 POST /v1/factory-portal/work-items/:id/acceptances | 检查分配、文件、数量、版本和当前协作权 |
| 产能预留 | 目标 POST /v1/production/reservations | 竞争同一资源，失败返回明确不足原因 |
| 面单任务 | 现有 /v1/logistics/tasks | 默认询价，外部付费意图独立 |
| 财务利润 | 现有 /v1/finance/profit-runs | 固定证据、汇率和指标版本 |
| 模型评测 | 目标 /v1/ai-evaluations | 只使用获准样本，不自动更换生产路由 |

目标工厂接受命令示例，UUID 采用说明性占位，不是可执行请求：

~~~json
{
  "expectedVersion": 3,
  "deliveryPackageId": "PACKAGE_UUID",
  "fileSha256": "FIXED_FILE_HASH",
  "acceptedQuantity": 2,
  "promisedAt": "2026-10-20T08:00:00Z",
  "idempotencyKey": "OPAQUE_CLIENT_KEY"
}
~~~

tenant、actor、factory 和权限范围从认证与分配关系解析，不接受请求体替换。应答返回 acceptanceId、当前业务版本及安全状态，不返回秘密或原始外部响应。

错误至少区分 401 未认证、403 无权、404 当前范围不可见、409 版本/幂等/状态冲突、422 业务条件不足、429 限流、502/503 外部可恢复故障。外部响应不直接回显买家数据和令牌。

## 8. 任务与事件示例

~~~json
{
  "schemaVersion": 1,
  "eventId": "EVENT_UUID",
  "type": "production.delivery.accepted",
  "tenantRef": "TENANT_UUID",
  "aggregateRef": "PRODUCTION_UUID",
  "aggregateVersion": 4,
  "intentRef": "INTENT_UUID",
  "occurredAt": "2026-10-15T09:00:00Z",
  "traceRef": "TRACE_UUID"
}
~~~

事件 ID 去重，聚合版本检查顺序，非依赖事件可并行。延迟或乱序事件不能回滚新状态。消费者按可信调度记录恢复 actor 与授权范围，不能信任单个 tenantRef。

外部 Webhook 存安全 inbox：签名结果、接收时间、提供商事件 ID、加密原文引用和处理状态；签名有效仍要校验账户关联及当前操作权限。

## 9. 索引、搜索与导出

索引以租户、账户、状态、时间与稳定 ID 为前缀组合，按真实查询计划测量。订单商品外部身份唯一；映射生效区间不可重叠；费用来源唯一键防重复。

敏感文字和地址不进通用全文搜索；需要时提供有权限的精确查找。导出先固定查询范围和版本，再由 Worker 生成私有文件，附数量、校验值与过期时间。跨页选中与当前页选中必须明确区分。

## 10. 隐私清理与历史保留

PII 正文、原始 ZIP、图片、预览、面单、追踪信息和模型输入分别登记来源与派生关系。生命周期清理由政策快照与实际业务时间决定，重新导入不延长原始资料的保留期。

不可变清单只保留可合法保存的非敏感版本关系；需要删除的正文从独立加密存储移除，衍生内容一起清理。恢复测试必须证明旧备份不会重新开放到期资料。

## 11. 数据字典的完成条件

每次实际迁移都补：字段、空值语义、单位、默认值、业务唯一键、索引、RLS、复合外键、版本策略、数据分类、保留期、回填来源、回退方式和对应测试。未知历史字段不允许编造默认事实。

## 12. Harness 与知识的契约依赖

`harness-invocation-v1` 是原拥有者的有界读取投影，复用原接口，不保存第二套业务或
财务事实。迁移 0117 的 pod_artwork_invocations 保存任务/尝试、提交与响应元数据、
不可变服务报告金额和原产物引用；普通角色强制 RLS。记录不能复原原始输出，缺失
历史不回填。八位小数报告金额、辅助配置估价及原预算状态保持不同依据，见
[字段与对账边界](../integration/harness-invocations.md)。

执行契约至少固定执行器/方法/模型版本、对象版本、ruleSnapshot 或 legacy_missing、知识引用及校验值、工具权限和 effect、预算、稳定请求身份、步骤、租约、响应检查点、产物及各类审核。详细字段与恢复矩阵见 [Harness](15-agent-harness-specification.md)。

知识对象复用当前 contracts/knowledge、knowledge-core 和知识 Schema；候选、草稿、activeVersion 与来源分开，账户证据不进入通用知识域，见 [知识规格](16-knowledge-governance-specification.md)。新增通用字段之前先给现有记录建立兼容映射；历史缺字段明确缺失，不用当前规则回填事实。

九类辅助输入内的 `inputAuthority` 固定 version、capturedAt、fingerprint 及最多 64 个受限资源摘要；每项含静态 key、required、count、checksum。客户端创建契约不接受该字段，公开 AssistView 仅返回三个审计字段或 legacy null。创建前后及执行时使用原租户的只读一致性事务比较；单项超过 10,000 行拒绝而非接受截断。业务预览指纹排除该审计时钟，完整加密输入指纹仍包含快照。沿用原表和保留期，无新增迁移；完整契约见 [Harness](../integration/agent-harness.md#assist-input-authority-2026-10-16)。

AssistView 的可选 nullable `budgetState` 只读原租户账本的 reserved、committed 或 released；没有账本时为 null。界面据此显示“费用预留已释放”，不能从 costUsd 为 null 推导费用为零，也不能把已释放预留显示成仍待渠道确认。

`contracts/harness` 定义 native-harness-v1：executorKey、固定 skill 引用、至多 32 个 tool 引用和总 checksum；引用均有 key/version/checksum。方法正文、步骤、允许工具和工具 Schema/权限策略/资源策略/effect/限额/超时/恢复方式参与规范化摘要。JSONB 对象键重排不改变语义摘要。辅助加密输入及工作流原 input_snapshot 保存 executionContract，读取接口返回可选 nullable 引用，旧记录明确为 null。创建任务不接受客户端契约；非法创建参数返回固定 400 诊断。无新增表或迁移。

订单 0114 只新增以既有 work-item 为主键的责任安排旁表：负责人、内部截止、升级、revision、枚举原因和技术提醒检查点，不存另一份完成状态。业务来源校验值固定实际履约/异常投影；原订单/制作 revision 不随安排修改。订单与工作流复用 common/task-inbox 筛选契约，各领域决定实际状态；订单全量筛选计数和分页共享同一物化读取，见 [契约](../integration/order-line-responsibility.md)。

当前工作流执行沿用 workflow_node_attempts，0110 增加原操作者、不可变输入/校验值、输出引用、租约与恢复派发字段；旧记录保持缺失并进入人工核对。0109 的 catalog_operation_receipts 固定商品操作输入摘要和产物，商品拥有者事务提交回执，工作流仅保存引用。POD 沿用既有任务/设计版本，父子关系与实际权限在执行时重查。字段、私有下载及恢复限制见 [工作流执行](../integration/workflow-node-execution.md)。

迁移 0115 新增 procurement_order_followups、after_sales_case_followups、order_exception_followups 三个责任旁表。对象和成员均有租户组合外键、强制 RLS；保存修订与当前来源校验值，业务完成状态从原事件投影。内部截止独立于采购预计到货/制造/平台时限；相同安排无额外修订，冲突保留填写。完整契约见 [三类业务跟进](../integration/business-followups.md)。

独立异常的登记/解决仍追加原 order_exception_events 与 order_events，原事件 metadata
固定命令校验值，写入、父序号与审计同事务。交互命令新增必需的来源校验值及预期
序号；同键更改对象/动作/内容/依据返回冲突，合法原请求可重放原结果。没有新增
迁移、重复业务表或跨模块写入。详见 [异常处理契约](../integration/order-exception-operations.md)。

模型费用迁移 0118 增加 model_billing_reconciliations，只追加原拥有者、原调用、前序事件、八位美元证据、凭证摘要、核对人及预算前后投影。强制 RLS 与复合租户外键约束来源；原预算保持六位小数及微秒归属时间。新事件触发纠正投影，普通终态 UPDATE 继续受保护，原 cost/report 字段不改写。严格请求、幂等命令和安全读取投影见 [模型费用契约](../integration/model-billing.md)。

## 逐权限范围快照

TenantContext.permissionScopes 保存每项权限从当前角色合并得到的 self/team/tenant 范围；dataScope 仅为兼容及显示汇总。新增对象策略按具体权限授权，不以最大汇总替代。个人会话及其指纹包含该映射，名称集合不变而范围收窄也必须清除旧视图。旧内部上下文缺映射保持显式兼容，不补造历史当前授权。完整团队归属和其他模块的实施边界见[商品授权契约](../integration/product-authority.md)。

2026-10-18 / PRD 1.1.4：0126新增organization_teams、organization_team_members及只增不改的organization_team_commands，关系使用租户复合外键和强制RLS。企划与印花母版增加可空team_id；历史未分配记录不回填。团队revision表示编辑版本，access_generation表示归档/重新启用的授权代次，成员关系另有revision。当前身份发布teamIds和teamAuthority，版本重放不能恢复已撤销关系。详见[所属契约](../integration/catalog-scope.md)。

2026-10-18 / PRD 1.1.5：商品 options 的 contextAuthority 与普通运营会话共用权限投影，个人界面缺少或不匹配时不可操作；这不是调用方可选择的租户/权限参数。编辑器固定原 revision/版本，草稿按本人/权限/对象/字段隔离；规格批量草稿另固定版本集合。研究、创意和实际素材引用在幂等结果前检查当前范围，复用原强制 RLS 与不可变约束，不新增迁移。见[编辑契约](../integration/catalog-editor.md)。

### Listing 读取与来源授权增量

2026-10-18 / PRD 1.1.6：Listing 读取投影增加 ownerUserId，目录增加 productAccess；无权 SPU 的实时编码/名称不随可读 Listing 泄漏。GET /api/listings/:id 是本人身份的私有单对象读取，不接受调用方租户或工具权限。审批同时核对父 Listing 与当前 versionId；销售方案 mutateDevelopment 的 validateSources 在幂等结果前复核原请求引用。没有新增数据库迁移、跨模块表写入或依赖。见[对象与来源契约](../integration/listing-authority.md)。

### 销售方案读取与命令回执

PRD 1.1.7：SalesPlanOptions.contextAuthority 由服务端按普通 ERP 权限投影生成，与 preferenceScope 和本人会话共同核对；不是可提交授权参数。关联 Listing 读取提供可选 ownerUserId。现有 development event 的同步回执仍为 listingId/listingVersionId；validateCachedResult 在返回旧结果前验证实际父对象、所属方案、原版本与当前写范围。先检查当前方案来源，不补造旧来源快照。API/Web/contracts 共同部署，无新增数据表或迁移，见[会话与回执](../integration/sales-plan-session.md)。

### 只读的关联资料解析

PRD1.1.8：POST /v1/sales-plans/:id/reference-options 返回200，接收有界去重引用ID数组及可空项目/店铺ID。先检查实际父SPU当前读取权，再复用领域范围及来源状态规则；返回当前身份、方案/SPU和原选择，不创建版本、事件或任务，不接受租户、权限或执行参数。候选优先纳入所选可用记录，历史印花按原版核对；保存不采信客户端结果。无新增迁移/依赖，详见[引用契约](../integration/sales-plan-references.md)。

### 原方案资料包历史投影

PRD1.1.9复用salesPackageVersions、原Listing/方案与不可变快照。packages按当前来源范围先过滤后分页；currentPackages独立绑定当下SKU、配方、刊登与交付指纹，不以当前选择改写历史归属。共享严格查询契约固定packagePage与current/history用途；真实原文件和原审核字段继续由原快照及私有存储核验，无新增事实表或迁移。

## 渠道映射增量契约

共享 SalesChannelPreviewSchema 约束 POST channels/preview，保持只读，不接收身份或幂等字段。时间轴身份为店铺/站点/平台 SKU/Listing/完整选款，区间右侧为下一条同身份映射生效时间。原包摘要、当前可写权限及受权前后包信息分开返回；写入继续走原服务与幂等事件，新增读取契约不新增表或迁移。详见[渠道映射](../integration/channel-mapping.md)。

## 销售组合与生命周期投影

PRD1.1.11：默认 primary/front/whole/全区域且无字段重映射的单项与 legacy 输入兼容，其他绑定顺序/区域/字段映射保持身份意义。SalesSkuDetail 增加 lifecycle.active 和归档来源数组；这不是授权字段，命令继续服务端复核。API/Web/contracts 共同采用，不新增表、迁移或原历史回填。

销售编辑项目的 catalogSource 新增 active 投影，不新增可执行客户端权限。Worker 以原 render/requester 固定任务身份，并从当前成员恢复销售配方执行范围；企划/SPU/SKU 的共享锁覆盖结果采用事务。制作页缺少有效 active 投影时停止新操作，历史与已保存原字节仍需当前读取权；没有新增数据表或迁移。

0127 的 production_render_dispatch_tenants 只含路由 UUID，invoker 触发器在原任务事务登记；lease_until 和 next_dispatch_at 只管理原制作任务的执行与派发，不创建第二业务事实表。历史无租约采用原更新时间的有界兼容期限，原申请人及版本不重写。详见[恢复契约](../integration/catalog-render-recovery.md)。

研究索引尚无可信团队绑定，self/team 不能推导其他拥有者可见。研究计数与关联项目分别使用 research:read 和 design:read，旧研究结论及快照仍不可变；本批无新增表或迁移。见[研究范围契约](../integration/research-authority.md)。

订单尚无可信个人/团队拥有者绑定，责任旁表不提供该授权。当前每项订单权限需要其自身 tenant 范围；请求权限上限、当前权限及双方可信团队取交集。没有新增订单事实/迁移，也不回填历史归属。见[当前订单契约与缺口](../integration/order-authority.md)。

素材使用现有 owner_user_id，尚无可信团队绑定；self/team 仅能按实际上传者读取，旧无归属记录不回填。订单域额外沿用当前订单及 PII 权限；内容去重不重新授予拥有权，软删除不复活，无新迁移。见[素材契约](../integration/asset-authority.md)。

原生设计任务与创意版本使用已有created_by，素材使用owner_user_id，无可信设计团队绑定时不推导新授权。权属审批说明与文件内容版本分别管理；真实创意审批保存实际时刻，旧缺失不回填。版本号在父任务锁内分配，审核、主版本及固定素材在所属写事务复核，无新迁移，见[原生设计契约](../integration/native-design-authority.md)。

画布和创意批量请求 v2 固定实际申请人；旧 v1 只向原申请人复用原记录，不重写历史 checksum。印刷规格以最早版本创建人为家族拥有者，后续 created_by 继续表示实际编辑人，无新迁移。见[拥有者与重试](../integration/canvas-workflow-authority.md)。


0129_creative_execution_foundation 为五类原创作操作增加同租户拥有者外键、权限/输入/方法固定记录、父子调用、token 租约、预算关联、原提交/响应和产物交接。数据库拒绝改写原证据、扩大子权限或无真实文件的完成状态；Studio 视频 ID 需要原提交且不可替换。普通库误由数据库集成应用0129后，按独立备份/恢复补齐就绪；原业务摘要和确切测试记录单独核验，见[创作执行契约](../integration/creative-execution.md)。


模板检查详情返回 reviewFingerprint/executionEvidence，确认必须携带 expectedFingerprint。整款审核逐项固定结果依据；父批次锁、最新槽位尝试、实际文件版本和原完成凭据共同阻止并发替换。批次历史返回原模板槽位供受权只读展示。无新迁移或外部依赖，原五类执行输入格式与历史费用不改写，见[接口与历史边界](../integration/mockup-management-authority.md)。

## QualityAssessment V2 · 1.1.28

检验新增 assessmentVersion、criterionResults、requestChecksum、productionVersionId 和 productionProjectionVersion，全部为旧记录保留 NULL 的可空列；新应用写入必须具备完整 V2。每项 code、scoreBps、passed 和 evidenceAssetIds 与标准一一核对，权重总和 10000，评分以整数基点计算。标准、检验、缺陷禁止原地更新/删除。0130 仅在隔离库验收，普通库未迁移。见[数据与兼容说明](../integration/quality-assessment.md)。


## Shipment production sources · 1.1.29

0131为发货版本增加可空productionSourceVersion/requestChecksum，为物流事件增加可空recordedBy；旧值保留NULL。新shipmentProductionAllocations固定packageLine、productionOrder、productionVersion、qualityInspection、原projection和quantity。复合外键保证同租户、同商品及原通过检验；延迟约束保证每个新包裹行数量完整。来源及发货版本、包裹、审核、物流历史不可原地更新/删除。候选由当前生产和质检、其他已审核数量及所有原版本的真实物流计算，不能因取消释放实耗。GET来源/修订视图、POST新版本及原请求恢复见[接口说明](../integration/shipment-production-sources.md)，普通库尚未采用。


### 1.1.30 分组检验及恢复数量

新增不可变实物组、原组复检关系和独立缺陷影响数量，提交时数量完整覆盖生产版本或被复检原组。发货固定原通过组，恢复案例与补做子单关联原组，多个缺陷共享实物余额。旧V2检验和旧缺陷不补造组或数量，实际历史升级与新写入规则分别验证，详见[分组契约](../integration/quality-groups.md)。


## 制造页面传输与恢复 · 1.1.32

REST响应包装本次实际contextAuthority与业务data，原命令回执仅固定业务原响应，不能把旧权限快照当作当前授权。物料分页与已选物料分别读取，停用及不可读取显式保留；只返回编码、名称、基本单位和状态，不返回库存量、成本或仓库信息。新增references、material-options和history读取入口，版本历史按版本号分页。原命令成功但响应丢失/网关后验权限变化时保留原意图，新内容与旧回执分离。见[制造接口](../integration/manufacturing-recipes.md)。

## 制造交付 V3 · 1.1.33

0135新增交付商品的制造绑定ID、原完整内容指纹及工厂计划指纹，全部为空表示原历史，全部非空表示V3封存元数据。租户及确切生产版本组合外键、同创建事务插入检查和延迟非空包检查共同保护来源；普通应用不能新建旧格式包。包内加密快照固定严格制造投影，计划分数使用整数字符串。V3 manifest校验规范JSON的实际字节；V1/V2保留原算法、原密文及NULL，已有生产绑定也不补造旧包。接受新增可选且无默认值的manufacturingChecksum，新V3接受时必须明确匹配。详见[制造交付契约](../integration/manufacturing-delivery.md)。

### 运营响应语义 · 1.1.34

订单BFF只保留明确的409 `authority_changed`，与普通版本冲突区分，不转发任意上游代码。当前页面恢复使用原路径、原JSON正文及原幂等键/里程碑事件号，仍由原订单拥有者核对原操作者与当前权限；不新增数据库表或迁移。私有意图不写浏览器持久存储，跨刷新恢复和通用命令查询仍须继续，见[操作契约](../integration/production-operator-handoff.md)。

### 生产入口读模型与原数量

新增 NativeProductionWorkspace/Detail/Receipt 和单商品 ProductionAvailability 读契约，均沿用当前租户及源模块范围。生产可安排数与写入共享同一原生产占用函数：有实际交运证据的已取消原生产仍占用。原生采购版本须匹配本订单、本供应商、本路由、本行及原完整数量。nativeSpecificationVersionId 仅用于无审单商品的明确当前规格，与 originalProductionOrderId 互斥；不改原工作或原生产绑定。直接来源、工厂选项及请求均采用实际 SKU 和原规格，回执最小化且与原目标一致。本增量不新增迁移，仍依赖当前0134/0135链；详见[接口表](../integration/production-entry.md)。

### 待实现的生产命令恢复数据

计划由订单拥有者保存不可变命令意图和执行尝试，固定原申请人/权限上限、原Schema/路径/正文、幂等编号及来源版本；正文属于订单私有加密域。当前尚无该新表或迁移，候选实体名称不是已运行数据库事实。准备、认领、事务提交回执、结果封存和本人已读确认分别保存；服务端租约token须在业务事务内再次检查，具体设计与未完成验证见[持久恢复设计](../architecture/order-command-recovery.md)。

## 1.1.40 实际重启验收边界

本批沿0136原两表和原生产合同，不新增业务表或对外API。新容器身份变量仅供一次性测试，必须在连接前核验唯一标签、容器/命名卷、回环地址及一次性数据库；拒绝普通55432/5432和普通8000。证据按原意图、原尝试与实际业务编号对账，不能由验收直接写成功或补造制造批准。见[生产恢复](../integration/production-command-recovery.md)。

## 1.1.41 普通136事实

本地普通库已使用0136既有两表和原业务合同。最新配对备份固定337原表105787行、135原迁移及1834对象，恢复后逐项验证；普通升级保留原列内容及三条旧采用记录，只新增一条受约束的运维采用记录。该全局运维元数据不等于业务批准，十处历史哈希差异保持，不改旧SQL取得通过。私有完整备份不进入PRD。当前证据见[采用进度](../project-control/PRODUCTION_ADOPTION_PROGRESS_20261020.md)。

## 1.1.43 ShipOS观察序号

0137增加连接的非负bigint计数及同步请求的可空正bigint序号，连接内唯一。新请求每次递增1，同编号重放不分配新序号；配置版本不随同步变化。数据库保护同步身份与已分配序号，历史NULL不补号。快照保持原字节，旧已固定包裹来源不变。序号仅用于服务器排序与来源校验，不进入现有JSON传输契约，避免BigInt序列化或浮点精度问题。

## 1.1.44 精确库存与原BOM实际物料

开发迁移0138以无声明scale的numeric及显式约束保存最多9位精确值，旧整数以原JSON形式返回。0139增加production_material_entries及预留事件quantity_delta/movement_id，旧字段不改写，旧fulfilled事件两项新字段保持NULL。商家实际数量链接原库存流水；工厂自备报告为独立手工事实。新增耗用流水和部分预留事件均须同笔原生产回执，事实不可更新或删除。原生产绑定、原行码、原供料责任和当前身份共同限定新请求；更正累计受原事实数量限制。

接口、已验证结果与剩余项见[物料契约](../integration/production-material-execution.md)及[本批进展](../project-control/INVENTORY_EXECUTION_PROGRESS_20261020.md)。

## 1.1.45 原物料提交与最小恢复记录

0140的production_material_commands保存tenant/production/binding/actor、原请求编号及规范校验、原权限快照、7天加密正文、状态和原物料entry引用。状态仅prepared/succeeded/rejected/cancelled/expired；事务内执行不产生长期executing租约。本人/生产单最多一笔未确认结果，原身份与终态不可变。新增物料事实须携原命令事务凭据，成功命令与该原事实同笔提交。确认已读及独立到期清除只移除输入，不能改实际库存或历史。

原记录投影另提供当前可退/可释放余量、原库位和批次名称。库位游标为稳定物料/库位/批次维度，原预留游标为原entryId；25条分页外另提供至多一条selected以核对后页选择。所有读取按本人当前成员和租户范围，不因恢复要求无关的买家资料权限。详见[实际物料契约](../integration/production-material-execution.md)。

## 1.1.46 精确数量的页面边界

库存余额与流水的读取复用InventoryWorkspaceViewSchema，不能以旧number检查拒绝合法的精确十进制字符串，也不能把字符串转成浮点数。原整数形式与最多9位小数保持，页面原有内部租户、操作者和幂等字段拒绝继续执行。实际入账、服务返回和编译页面显示共同验证；缺失集合与无效数量仍进入明确失败状态。质检当前结果复用同一生产修订排序，历史记录时间和原内容不改写。

### 1.1.87 新契约与兼容

新增erp-agent-read-v1固定工具、严格输入/输出Schema及Harness pin；游标用原集成加密域，绑定完整身份、查询、集合和最初15分钟期限。assist-request-receipt-v1复用旧v1输入序列化及requestFingerprint，不重写旧记录、旧Schema或到期时间。纯ID恢复标识不保存prompt/body/token；原automaticAudit另有严格复用证明。无新数据库迁移，源码171与日常148采用状态分开。

<!-- c4a83b17-detail -->
### 1.1.88 兼容边界

新增assist-target-page-v1及严格个人GET task-target-pages。旧task-targets schema、评测pin、普通requestFingerprint序列化与七字段意图保持；同步清理事件无载荷，不落新私文。加密游标由原集成vault封装，固定原15分钟期限和全权限/query/limit/集合/锚点/count。GET旧订单详情/知识会话仅带authority时走新个人校验分支，无header保留旧ABI。无迁移、无新增依赖或凭据。
<!-- /c4a83b17-detail -->
