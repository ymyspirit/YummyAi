# ERP 原生工具与按需契约

2026-10-22 · erp-agent-tools-v1 · f6c1a208

本协议把真实原生读取接到独立工具网关。它与原 read-v1、loop-v1、plan-v1 分开；原模型循环仍仅调用订单异常和库存余额。本批没有模型调用、图片读取、业务命令准备/执行或 MCP 认证接入。整个平台仍按原48需求、54工作包、8阶段推进。

## 原生读取

| key | 原服务 | 真实范围 |
| --- | --- | --- |
| orders.exceptions.page | AgentReadService / OrderService | 原订单异常元数据与原集合游标 |
| inventory.balances.page | AgentReadService / InventoryService | 原精确数量及单位与原集合游标 |
| knowledge.search | KnowledgeService.search | 已发布有效版本；最多扫描500条、排名前6条，永远不声称全库完整 |
| creative.history | CreativeExecutionOperatorService.history | 原对象执行历史，每页20次执行、每次最多10条人工事件；仅进度/费用/原产物标识，不代表看过图片 |
| factory.capacity | FactoryCapacityService.workspace | 指定工厂、资源池版本、最多31个当地日及实际净余额；未知额度仍为null |

不新建业务事实表，不添加迁移、依赖或密钥。全部业务读取沿原owner对象检查和租户事务。网关在调用前后重新取得有效成员，与入站权限上限相交；原服务继续核对对象权限。元数据中的“可用”只代表基础权限，具体对象可能继续拒绝。知识关联SPU必须能通过原ProductPlan owner/team范围。运营工厂产能权限不能代替工厂本人grant/assignment或生产文件访问权。

## 身份与接口

个人ERP身份调用API的 GET `/v1/agent-tools/workspace`、POST `/v1/agent-tools/definition`、POST `/v1/agent-tools/call`。API Client默认拒绝本协议，不能借旧read-v1许可扩权。Web同名BFF使用个人会话、同源POST、完整authority标识、请求/响应大小上限及无缓存；读取后身份变化丢弃结果。

workspace只列5项原生读取与五域37种原命令元数据。definition只返回所选的一项原输入/输出JSON Schema及摘要。命令schema从严格原Zod分支导出，不能把JSON Schema当作已经通过业务检查或人工批准。call仅接受5个读取key，拒绝任意SQL、URL、shell、命令准备、恢复及执行。调用同时固定Harness pin和所选definitionChecksum。没有自动分页重试；原读取失败可明确重读，不触发付费服务。

Web POST `/api/agent-tools/objects`额外桥接三个原创意列表，只传有权对象的ID和标题：design_batch/mockup_batch各最多200，inspection最多500，候选列表始终注明近期有界。工作室generation的工具输入仍沿原owner检查，但新页面尚无其项目对象选择桥。缺少对象时给出空态，禁止自由填写UUID冒充对象选择。

## 来源与覆盖

`dataChecksum = SHA256(canonicalJson(nativeData))`。definition摘要的精确payload由共享`agentToolDefinitionPayload`给出，不包含会变化的authority、available和blockReason；基础权限仍每次重新校验。

结果带server callId、原工具、checkedAt、definitionChecksum、inputChecksum、dataChecksum及原生data。inputChecksum为严格解析后input的canonicalJson摘要，客户端须绑定本次请求，知识原生结果没有query回显也不能串查询。coverage必须与原生data一致。只有两个旧分页工具可以给出未变化集合的complete/total；知识为ranked_subset，创意为bounded_history，产能为bounded_snapshot。后三者的complete固定false。数据是读取时观察，不能作为后来执行的永久资格；原命令在准备和确认时仍重新核对来源、版本与权限。

读取是无业务副作用的原owner调用。HTTP信号和最终时限可以丢弃迟到结果，不能据此声称已取消正在执行的数据库查询；不自动重放。工厂完整业务历史或源文件不在此读取中。

## 工厂分页修复

原工作站授权列表、指派列表及工厂本人任务列表使用PostgreSQL六位微秒UTC文本和原ID复合排序，不再经过JS Date截断。旧三位毫秒游标只能在当前原可见及过滤集合内找到同ID锚点，核对原毫秒后补回真实精度；锚点失效或过滤变化返回400要求重读。新游标同样核对原锚点。此修复不承诺跨时间变化的历史全集快照。

## 验证与续做

使用disposable runner的`agent-tools-integration`与`agent-tools-browser`，连接前必须同时核对TOOLS/READ/DAILY隔离标志、current174及同nonce数据库/私有桶/Redis。复用真实夹具时由runner显式启用COMMAND、FACTORY_ERP_IMPORT、ROLE/BUSINESS/KNOWLEDGE_BENCHMARK及KNOWLEDGE_EVALUATION隔离标志，不能在测试中改环境绕过guard。编译浏览器使用个人3130/8130及产品源码字节未变的同一编译产物，不使用日常148。验收脚本单文件修复单独保留构建和最终源码摘要；分次通过的两条叶按名称去重，已通过叶不重复执行，不据此宣称完整源码与构建时相同或正式候选。真实模型质量、账单、跨域计划的新工具调度、MCP完整授权及日常采用继续独立验收。最终结果与清理见[本批进度](../project-control/ERP_AGENT_TOOLS_PROGRESS_20261022.md)。
