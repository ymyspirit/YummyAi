# 单张图片付费生成开发契约

2026-10-24 · 73e2c9b1 · 开发中 尚未启用真实付费

本片复用 Infinite Canvas v0.20.0、自有 Studio adapter、原 Studio generation owner 和 Creative Execution Harness。保留上游文件原字节、原生一至四张入口及旧视频恢复暂停。ERP 图片页新增单张图片费用面板，支持文字生图和已审核参考图编辑。真实付费默认关闭，日用188及其固定配对不在本片修改。

报价是操作员配置的每张图片预估与预留金额，币种 USD。它不是渠道实际账单或强制渠道扣款上限。文本默认每百万 token 一美元及显式无限任务额度继续属于文本计价；不得复制成图片价格。实际费用缺失时保留 null 和预算预留；渠道确认费用超额时留证并阻断后续同模型调用。

`studio.image-pricing.save` 由 ModelConfigure 配置单个 image route 的 `imagePricing`：`estimatedUsd` 为八位小数字符串，`reservationUsd` 为六位正小数字符串，`reference` 为报价依据。估价不得大于预留，修改报价更新 selectionRevision，历史固定报价不改。

`paid.image.budget.get/save` 提供组织预算的正式入口。当前 ModelConfigure 必须具有 tenant 范围；月预算由全部 AI 共享，默认任务预留上限影响未单配任务，单张图片上限仅覆盖 studio_image。三个金额必须由操作者显式填写，读取及保存按完整原 policy 的版本核对，保留其他任务设置与所有既有费用/占用。已占用额来自 UTC 当月原 ledger 的 reserved/committed，低于占用的预算设置只阻断新任务，不释放或改写占用。配置保存不会开启真实付费。

本人原 RPC 增加 `paid.image.prepare`、`paid.image.commit`、`paid.image.lookup`、`paid.image.requests`、`paid.image.cancel`。prepare 持久保存精确本人原请求和五分钟固定报价，不预留费用、不排队、不调用模型；同 requestId 不得改 scope 或输入。commit 只接受原 requestId 和 quoteHash，必须重新核对当前权限、项目、参考图版本、模型/报价 revision、组织任务与月预算以及服务端准入。同一事务创建 generation、预算预留、执行意图及原准备的提交回执。重放只返回原结果，不再次排队。队列回执丢失不释放原预算，恢复只按原键 lookup。

lookup/requests 是纯读取，绝不调用旧 `generation.get` 的自动送审分支、创建新候选或恢复历史任务。产物保持未审核，显式送审继续使用既有固定原件流程。cancel 仅能取消尚未 commit 的准备；已外部提交结果未知不能取消后换键当作未收费。prepare 失回执且查无记录也不是取消证明；本人可明确执行 `paid.image.abandon`，服务端在同锁下写不可变取消键，阻断迟到 prepare。有 generation 的原键不能 abandon。失 abandon 回执只能本人明确重复同一取消，不自动发送；取消小回执不返回旧私有输入，因此当前具备本人写权限时可结束已取消或归档父项目中的未提交准备。

API 与 Worker 统一要求 `STUDIO_PAID_IMAGE_ENABLED=1` 且租户在 `STUDIO_PAID_IMAGE_TENANT_IDS` 中；默认均关闭，不写入日用环境。Worker 只接受有本片固定准备/费用证据的 image generation，不接管旧无报价记录、视频或文字任务。执行前仍经原当前权限、方法、来源与模型 pin 检查。现有普通 `create` 调用不得绕过暂停门。

新预留使用数据库实际时钟记账，不能把等待预算锁后的预留写进事务开始时的旧月份。首次外部提交在原预算锁事务内再次核对原预留属于数据库当前 UTC 月；跨月尚未提交的旧预留必须结束后重新核对，不挪动历史记账日期。该守卫只约束首次提交，既有已提交回执、费用和归档响应恢复继续走原流程。旧 JSON 图片上限按数据库原数值文本精确读取，超出六位小数的有效数值必须明确修正，不能被 JavaScript 舍入后当作合法上限。

主控拥有共享 contracts/schema/0190、generation service、原 RPC 接入、配置 service、文档、整合、资源生命周期及串行验收。前端 lane 只拥有新单张面板/client/CSS与 workspace 窄挂载；后端 lane 只拥有独立报价预算 helper、Worker 的新准入 helper及 processor/run 接入；测试审查 lane 只拥有新 API fixture/integration/browser 测试。三 lane 不启动资源或执行测试。主控串行验证和清理本片精确自有目录，不触碰历史896冻结边界、并行计费临时目录、33业务备份及原日用进程。

验收必须覆盖关闭零执行、报价缺失和过期、同键并发和失回执、未知外部结果不重发、当前撤权/跨人跨租户/参考变化、真实私有产物及费用保留；浏览器覆盖本人表单、原键恢复和桌面/窄屏。外部模型只用明确隔离传输，不能将模拟调用计为真实付费验收。完整平台和其他四类 C06 恢复继续，单片通过不代表项目、CI或正式发布完成。
