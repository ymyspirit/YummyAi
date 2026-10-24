# ERP Agent 业务读取与原任务恢复

<!-- 6f2d9a84-current -->
1.1.90后续：五域37种原命令统一网关及原核对页交接已完成局部验证与清理，见[原命令接入](erp-agent-commands.md)。本文旧读取/Assist/恢复协议不变；旧read/finish模型循环仍仅两个读取工具，新网关尚未连接模型写计划。MCP和普通148采用继续。
<!-- /6f2d9a84-current -->

<!-- 68018aa3-current -->
1.1.89后续：新有界Agent循环已沿两个原业务读取完成局部验证及清理。本文原Assist、入口恢复及旧协议继续保留；新独立运行/步骤、逐轮模型费用和软停止见[Agent循环契约](erp-agent-loop.md)。未完成全ERP工具注册、业务写入或MCP，日常148未采用。
<!-- /68018aa3-current -->

<!-- c4a83b17-current -->
1.1.88后续：原两读取工具保持。独立KnowledgeChat/OrderBulkPanel已完成局部恢复验证，原生automaticAudit仍独立；完整对象选择沿新分页版本，详见[入口及对象契约](erp-agent-entry-recovery.md)。下面1.1.87段落是当时范围记录。
<!-- /c4a83b17-current -->

2026-10-22，e5f30d2a。本地切片已完成43项去重定向检查及清理；具体结果以[本批进度](../project-control/ERP_AGENT_READ_PROGRESS_20261022.md)和项目状态为准。无新迁移，不表示普通148环境已采用、通用Agent计划已上线或MCP已连接。

## 固定可执行读取

复用原 `HarnessRegistry`、Zod、Nest、Drizzle和原业务owner，没有引入第二套任务框架。新增工具契约版本为 `erp-agent-read-v1`，固定下面两个名称，不接受动态安装工具、任意HTTP、SQL或模型文本定义的执行器。

| 工具 | 原拥有者 | 本批资料范围 |
| --- | --- | --- |
| `orders.exceptions.page` | OrderService.agentExceptionPage | 当前授权且原来源仍可用的订单异常元数据；可按原内部订单ID及状态筛选 |
| `inventory.balances.page` | InventoryService.agentBalancePage | 原库存余额及全部精确数量、单位和投影版本；可按物料/库位内部ID筛选 |

订单工具不选择外部订单号、标题、自由code、message或resolution。没有PII权限的只读Client不能因此进入原订单私文/异常操作接口。缺少异常事件的历史行保留eventMissing、open及sequence0，不补造已审核或已解决。库存沿用原数量解析和减法，不能用浮点运算、截断或更换单位；零量与停用维度不默认隐藏。

GET `/v1/agent-reads/workspace`返回当前能力可用性、真正注册的输入/输出Schema描述及完整Harness pin。POST `/v1/agent-reads/call`只接受严格工具与原执行契约，成功明确HTTP200。输入默认25、最多100，输出最多100；未知字段、未知工具或改变的pin拒绝。

这两个窄读取与旧11域24项 `erp-agent-catalog-v1` 覆盖描述并列。旧覆盖描述全部callableViaAgent=false保持原含义：异常元数据不是完整订单读取，余额不是完整库存/预留/历史查询。只有新读取目录中的实际注册子集可执行，其余准备、执行、回执及跨域计划继续实施。

## 当前身份与逐项权限

业务owner在自己的withTenant及非owner RLS事务内重读真实active membership、逐权限范围和团队，与调用者上限相交。两工具首批分别只接受OrderRead:tenant、InventoryRead:tenant；一个无关权限的tenant不能扩大另一个业务的self/team。资料读取和集合计算在同一repeatable-read事务；先设10秒SQL时限，调用层15秒中止及最终返回门拒绝迟到结果。

API Client保留原九项read委派。POST传输只在具名 `ApiClientVerifiedReadTools` 入口识别这两个严格读取，不把业务正文标成元数据，也不开放原POST命令。原密钥有效性/当前成员、逐项scope及团队出生上限继续由原loader和最终HTTP拦截器复核。OIDC个人BFF读完有界正文后再次核对实际身份，客户端同步清私有内容和拒绝旧generation响应。

传输的contextAuthority与原ERP身份页一致，使用erpPermissionContext展示投影，排除工厂门户专用两项权限。原owner上下文、游标绑定及最终权限相等检查保留完整身份，不能把展示投影当授权裁剪或额外授予权限。

## 完整分页及资料变化

每页由owner对全部符合当前条件的投影计算有序SHA256、真实总数与页数据。异常按内部异常ID降序；库存按真实dimensionKey的C排序升序。库存集合指纹包含重建身份，投影重建更换UUID或空集合重建也使旧游标失效。

游标由集成加密域的现有vault封装，固定tenant、actor、权限摘要、工具/契约、筛选、页大小、集合指纹、原真实锚点、总数、累计读取数和最初15分钟截止时间。继续读取不延长截止时间，不接受手改游标。任何集合/锚点/当前权限变化拒绝续页；`agent_collection_changed`要求清空本轮旧列表并从第一页重新读取。

`checkedAt`是该页读取时点，不是跨请求的数据库MVCC快照。`consistency=unchanged_collection`仅说明各页投影集合指纹一致；最后页且累计数等于真实total才返回complete=true。没有最后页时只显示已读取数量和未完成，不得把首100条当全量。集合指纹每页读取完整匹配投影，当前有界页不等于无限数据量的性能承诺，大租户仍需实测和索引/查询成本评估。

## 普通Assist跨刷新恢复

GET `/v1/ai-assists/receipts?requestId=...&requestChecksum=...`仅查本人原owner/requestId及保存的requestFingerprint，排除独立benchmark记录。requestChecksum严格复用旧v1 `SHA256(JSON.stringify(CreateAssistSchema.parse(body)))`，没有改写旧输出、Schema pin或历史指纹；浏览器与服务端共享精确序列化。过期输入已清理时仍可核对原指纹，返回原get的到期状态和无正文记录。

此接口没有新建run、queue、预算预留、模型调用或重派发。已submitted的未知外部结果保持原执行状态；有原响应的恢复仍由既有worker执行边界处理。GET回执不能把未知状态改称完成、未提交、免费或已核账。

浏览器在真正提交前先成功保存 `AssistIntentSchema` 纯ID/摘要：身份与业务scope的SHA256、kind、原requestId、原requestChecksum及已知runId。没有prompt、完整body、secret或token。存储不可用时阻止提交，避免无法恢复的未知付费请求。提交结果未知时锁住原意图，改模型或输入也不偷偷换键；刷新后只查原回执。not_found表示未查到记录，不证明原请求从未提交，不自动重新发模型。

同一actor的权限变化清私文并保留这些纯ID，恢复授权后可继续核对；换actor或退出清除。重新发起任务需用户明确确认重复付费风险。旧九类Assist、手工业务页面、采用审批与无限画布继续保留。

本批恢复覆盖统一工作台及复用AssistPanel/BusinessAssist的入口。独立KnowledgeChat、订单批量及原生automaticAudit仍使用原控制器，尚未迁移全部跨刷新意图。原生自动核对可能按固定制作版本/修订/核对policy复用已有run；API只为实际符合的原记录返回严格x-yummyai-assist-reuse-proof，BFF逐项核对新提交摘要、原request/run摘要和原审稿basis。该证明明确existing_policy_run，不证明新requestId已登记。普通恢复标识禁止automaticAudit，避免把新键指向另一个旧任务；原审稿入口继续使用此原生复用行为，不改制作检查或批准门。原图片previewAttempt缓存标识仅本地严格识别并在上游转发前移除。

并发重放时队列暂时不可用，沿初次提交规则保留同一个持久queued任务和assist_dispatch_pending，不以队列错误隐藏已提交事实。只读receipt仍不补队列、不创建新预算，也不替worker处理不确定的付费边界。

## 验收及采用边界

新suite为agent-read-integration与agent-read-browser，由既有disposable acceptance runner串行管理nonce数据库、私有桶、Redis和个人身份夹具。配置在连接前拒绝缺隔离flag、非nonce数据库、不同bucket或错误schema目标。浏览器只使用同编译候选3130/8130个人路径；外部模型transport为synthetic，真实个人BFF、业务服务、DB/RLS、预算和worker路径仍执行。

保留源码测试、规格和简明校验/清理记录；主控检查后删除本批临时日志、截图、下载、缓存和编译候选，独立验证本批资源已不存在。普通148、原工厂Excel、真实备份及883冻结路径保持保护。正式日常采用、备份恢复、CI、全部ERP命令、Agent自动跨域计划及实际MCP客户端验收另有后续门。
