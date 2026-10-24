# 独立 AI 入口恢复与完整对象交接

<!-- 6f2d9a84-current -->
1.1.90后续：五域37种原命令统一网关及原核对页交接已完成局部验证与清理，见[原命令接入](erp-agent-commands.md)。本文旧读取/Assist/恢复协议不变；旧read/finish模型循环仍仅两个读取工具，新网关尚未连接模型写计划。MCP和普通148采用继续。
<!-- /6f2d9a84-current -->

<!-- 68018aa3-current -->
1.1.89后续：新有界Agent循环已沿两个原业务读取完成局部验证及清理。本文原Assist、入口恢复及旧协议继续保留；新独立运行/步骤、逐轮模型费用和软停止见[Agent循环契约](erp-agent-loop.md)。未完成全ERP工具注册、业务写入或MCP，日常148未采用。
<!-- /68018aa3-current -->

2026-10-22，c4a83b17。本地切片已完成35项去重定向检查及3条个人会话编译版浏览器验收，临时输出和隔离资源已清并独立复核。最新结论以[专项进度](../project-control/ERP_AGENT_ENTRY_PROGRESS_20261022.md)为准。

## 入口与原任务

独立知识聊天 `KnowledgeChat` 与订单批量 AI 预审 `OrderBulkPanel` 复用既有普通 Assist 的七字段纯 ID 标识和本人 GET receipt。标识不含问题、订单正文、模型密钥或提示词；保存成功才提交。模型、队列、预算和回执继续使用原 owner，没有新增任务事实表或迁移。

未知原请求阻止以改模型、换问题或刷新更换 requestId。GET 回执不会重派发、排队、调用模型或释放预算。`not_found` 仍不证明从未提交；明确另起任务的操作保留可能重复付费的确认。

知识聊天在刷新后必须重新读取已知和未知原标识。实际可读原请求确定 scopeId、检索范围、账户证据范围和 previousRunId；不以刷新时随机生成的 scopeId 重建历史。当前内存核对过的已完成回答可以由用户明确追问，创建另一笔新付费任务；未读正文或到期原任务不自动解锁。最近对话及单对话列表仍沿用原 20 条边界，纯 ID 恢复独立于最近列表，不能把列表称为全量历史。

订单批量 AI 在第一笔 POST 前核对所有所选订单的原标识。发现后面的订单已有原请求时，前面的订单也不会提前提交。每笔读取原订单当前版本，再保存原标识并提交；未知、失败、取消或超时停止后续商品。已经登记的原任务不因停止而取消，恢复结果只回到真实 orderLineId。旧非 AI 的预览、绑定、逐笔业务写入和原请求编号保持原流程。

## 当前身份与退出

两入口所有模型、任务、回执、知识会话和 AI 使用的订单详情请求带当前 ERP authority。返回内容须核对相同 identity、kind、实际 scope、requestId 和完整原请求摘要；组件代次、原对象及活动请求一致才采用。当前权限拒绝或主体变化清私有内容；同主体权限变化保留纯 ID 标识，退出或换主体清除。

`ASSIST_INTENT_CLEAR_EVENT` 是无数据的同步失效事件。在非保留的 `clearSessionTaskDrafts()` 清除存储前发出，两独立入口、共享 AssistPanel 和原回执组件立即失效已有准备与返回代次。迟到响应只能更新仍存在、摘要与原对象完全一致的标识，不能重建已清标识。七字段标识格式和历史指纹序列化保持原版本。

个人 BFF 对带 authority 的 GET `/api/order-centers/lines/:id` 和 `/api/knowledge-governance/conversations` 增加前后身份核对、无查询参数、只接受 HTTP200、有界 JSON 与原 DTO 校验；订单必须匹配原行 ID，会话最多 20 条且 scopeId 唯一。错误正文不外传，仅传允许的状态和字面 `authority_changed`。未带此 header 的旧手工调用继续原兼容分支，不能据此宣称已改造所有旧 BFF。`centerRequest` 仅增加可选第四参数。

## 版本化对象分页

新个人 API 为 GET `/v1/ai-assists/task-target-pages`，BFF 为 `/api/ai-assists/task-target-pages`，契约 `assist-target-page-v1`。严格参数 `kind`、`q`（最长 200）、`pageSize`（默认 40、最多 100）及可选加密 `cursor`；BFF 强制当前 authority。仅有读取效应，不是新通用 Agent 工具或付费运行入口，不开放委派 API Client 的路径白名单。

旧 `task-targets` v1 的 40 项及 hasMore、签名、顺序和评测 pin 保持。两者共用原源过滤和 id/label/detail/href 投影；新版本对全部已授权投影计算有序 SHA256 和真实总数，按 ID 的 C 排序降序分片，采购库存品和库位先去重。知识问答明确为空对象集合。全集合指纹保护返回元数据；选择对象后仍须通过原 task-basis/start 固定和复核真实业务版本。

每页在原非 owner RLS、withTenant 的 repeatable-read 事务内核对 active membership 与调用者上限交集；目录、Listing、模板继续逐对象和资产 owner/team 过滤。订单、审稿和售后对象需要 OrderRead 与 OrderPiiRead 的 tenant 范围；经营需要 FinanceRead 与 OrderRead 的 tenant 范围；采购需要 ProcurementRead 与 InventoryRead 的 tenant 范围。一个无关宽权限不能扩大另一个业务范围。新 UI 提前禁用范围不足的对象类型，合法的其他任务和历史仍可使用。

游标绑定完整主体、当前权限、查询、页大小、全投影指纹、真实锚点、总数、已读数和最初 15 分钟期限，续页不延寿。集合、锚点或原条件变化返回字面 `assist_target_collection_changed`，页面清旧页、选择和依据，要求从第一页重新读取。累计已读数必须等于最终 total 才称完整；相同投影指纹不是跨请求 MVCC 快照。单条 SQL 设 10 秒限时，调用有 15 秒截止与返回门，大租户性能还需实测。

## 验收与保留边界

新 suite 为 `agent-entry-integration` 和 `agent-entry-browser`，沿统一 disposable acceptance runner。配置在连接前要求 `E2E_AGENT_ENTRY_ISOLATED=1`、`E2E_AGENT_READ_ISOLATED=1`、`E2E_ISOLATED_DAILY=1`、同 nonce 数据库/私有桶/Redis 及 current171。浏览器使用同源码编译候选的 3130/8130 个人 OIDC 路径；仅外部模型 HTTP 为 synthetic，实际 ERP/BFF、数据库/RLS、预算、队列和 Worker 仍执行。

普通148环境尚未采用。原生 OrderArtworkAudit 的 automaticAudit 仍是独立 policy 和原复用证明，本批不迁移为普通意图，不制作、改变或批准生产图。九类 Assist、工作流、无限画布、无人设计、知识库和原手工页面保留。原两个窄读取工具沿[读取契约](erp-agent-read-tools.md)，旧11域24项完整覆盖描述仍不可调用；通用规划、跨域工具循环、其余原写命令及实际 MCP 接入继续实施。
