# ERP 原生工具 Agent 调度

2026-10-22 · `erp-agent-native-v1` · a72d5e31 · 局部技术验证通过，普通环境未采用

整个 ERP 的 Agent 接入按原业务 owner 推进。本协议将五个真实读取和按需加载的五域37种原命令定义接到独立模型循环。它不代表全领域已经接入、日常环境已经升级或无人生产已经验收。当前进度以 `state.json.erpAgentNative` 与本批证据为准。

## 三层实现

| 层 | 实现与职责 |
| --- | --- |
| 数据层 | 保留原订单、库存、知识、创意与工厂事实。统一执行只复用原 Agent 计划的 runs/steps/items 元数据表和费用账，不新建第二套业务事实 |
| Harness 层 | 当前成员与原权限上限相交，校验固定对象、版本化契约、定义/输入/数据摘要、逐轮回执、租约、费用与实际来源，管理原请求恢复和明确准备意图 |
| Agent 层 | 在操作员给定的目标、对象范围、模型、预算和原命令类型内，选择 definition、read 或 finish；模型只可为知识读取选择关键词，不能扩大对象范围 |

知识 search、创意执行 history/act、工厂 capacity owner/calendar 已抽到相应共享 core；API 保留原 Nest 适配与异常响应，Worker 直接组合相同实现。原规则、审计、查询排序、精度、幂等、对象授权及生产质量门继续由领域服务负责。参考开源 [Agents SDK](https://developers.openai.com/api/docs/guides/agents/sdk) 的工具与运行边界，当前复用已有持久化 Harness、PostgreSQL 和 BullMQ，没有为本协议引入第二套运行框架。

## 操作与对象范围

AI 任务页的“原生工具模型任务”需要本人会话。操作者输入目标和补充资料，选择模型、预算和最多8个固定 binding；前端可见5种工具，历史记录完整保留全部 binding。相同 binding 不重复登记。

- 订单异常与库存：固定原查询条件，由服务器选择真实页大小和不透明游标，最多收集预算允许的连续页；只有完整集合可引用总数
- 知识：固定 topic/platform/market/SPU 范围，模型只选关键词；原检索最多扫描500条、返回排名前6条，保留发布状态、版本、来源与审阅规则
- 创意：固定 design、mockup 或 inspection 对象，沿原对象授权读取有限执行记录；元数据不证明模型看过图片，也不触发生成、恢复或生产审批
- 工厂：固定工厂和最多31个当地日；界面要求明确起始日，历史未给 from 时核对原首次实际日期；额度未知保持 null，产能窗口不代替工厂授权、实际排产或生产放行

开始新任务前先通过原 owner 核对所有固定 binding，非法对象不出生、不占费用账、不入队。已有相同 requestId 先读取原记录；跨协议或不同 checksum 的同键请求返回冲突，不新建替代付费请求。

可不选择任何命令，仅完成读取。选择原命令时，模型必须先取得该单项定义，提案的 draftJson 再经服务器解析为原严格输入。不会把全部37个业务输入 union 一次发送给模型。采购、来料、生产、财务、广告的真实权限、版本、金额、数量、币种、来源、审批与幂等门不变。

官方 [function calling](https://developers.openai.com/api/docs/guides/function-calling) 和 [tool search](https://developers.openai.com/api/docs/guides/tools-tool-search) 作为接口设计参考；本协议沿用现有兼容提供者的受控 JSON 决策，未假定其支持 OpenAI 原生 tool_search，也没有据此声称采用原生 function-call wire。

## 运行上限和证据

默认12轮模型、32次工具调用、2000条观察、4096输出 token、1 MiB 实际提示、600秒和最多8提案。服务器允许上限16轮、10000条和8192输出 token，其余边界不扩大。界面可调整本次模型轮数和记录上限。定义、读取和完成决策都占模型轮数；每项定义、每次分页及 finish 的所有定义/来源重核都占工具次数。多个 binding 或命令可能提前达到限制，上限不保证所有所选范围都已读取。

模型原响应、已发生用量和费用先保存为 checkpoint，再解码、核对与采用。没有收到响应或没有可信用量时，保留原预算上限并标明未知，不换键、换路由或自动重新购买。已有 response_ready 可在租约恢复后解码原响应，不能再次请求模型。停止可在丢失领域读取权限后使用，阻止后续付费步骤并保留已发生回执。

每项引用绑定 observation stepId、resultIndex、原 dataChecksum、实际业务标量路径和值。权限、可用性与观察时钟不能作为业务事实引用。提案 checksum 绑定原草稿和所引用 claims；原 slot、命令 key、originalChecksum 和 preparationRequestChecksum 保持原算法。

finish 与显式准备重新核对全部已加载定义和来源。订单/库存使用原查询集合 fingerprint 与 total；知识、创意和产能使用原业务依据。观察时钟、当前 authority/access 和游标不作为业务版本，但完整原 envelope 的摘要与来源仍原样保存。知识撤回、产能变更、对象失权或定义变化会阻止采用，不用今天的值悄悄替换旧证据。三个有界原生结果的 complete=false 表示各自检索范围，不能据此令一个已完成的有界任务永久 partial。

跨业务读取不是同一时点的原子快照。严格标量相等和原 schema 通过不证明建议金额、商业参数、自由文字含义或业务因果正确。

## 私文、恢复和原操作确认

GET/receipt 不派发模型，不准备命令，也不改变原执行费用/步骤。返回历史私文前，沿当前原 owner 复核全部 binding 的对象范围；这类授权读取是非模型的实时检查，不将今日数值写回历史或计作旧执行工具调用。除领域 bit 外，仍核对具体 creative 对象、SPU 和工厂。权限从 tenant 缩到 self/team 时，不能仅按任务 owner 判断历史对象可读。

失权或私文过期时清除目标、补充资料、binding、步骤、定义、观察与结果，保留可读的任务标识、费用及原操作回执元数据。源服务的 SQL 超时采用 result_deadline，超时返回不代表可以强制取消数据库查询。

操作员逐项点击“准备原操作”，服务器核对冻结提案、claims、当前定义/来源与权限，再沿原 AgentCommand.prepare 登记真实原命令。已知回执必须同时含协调命令 ID 和原 owner command ID。明确跳转原核对页后，操作者仍需核对原填写并确认；模型不会 prepare、confirm、execute、publish、付款或发消息。

父任务与单项准备各使用7个标量字段保存会话内原意图，不保存私文。未知响应先查原回执，刷新不自动重复付费或准备。注销同步发出原生意图清理事件并清除两类标识；同一本人权限刷新保留原键但清私文。个人登录仅在 /ai-tasks 白名单保留单个 UUIDv7 agentNative 回跳参数。

## API、迁移与验收

本人 API `/v1/agent-native` 与 BFF `/api/agent-native`：GET workspace、POST runs(201)、GET runs/:id、GET receipt、POST runs/:id/stop(200)、POST runs/:id/items/:itemId/prepare(201)、POST runs/:id/items/:itemId/receipt(200，仅恢复原回执)。禁止未知查询参数；BFF 校验同源、本人 authority、迟到身份、严格响应、固定范围、页链及全部摘要。

追加0175，按不可变 parent.version 路由原174和 native guards。旧 run/step guard 函数、账本 taskType=erp_agent_plan、审计 agent.plan.*、原 slot/命令算法和旧 read/loop/plan pin 保持。新旧共用组织月预算锁和原最多4个活跃任务。旧 API/Runtime 仅处理 plan-v1；Worker 原 AgentPlan 队列读取 DB 版本后派给对应运行器。无 native 回填、无旧请求重哈希。

定向 runner 为 agent-native-integration、agent-native-upgrade-integration、agent-native-browser；连接前校验 NATIVE/TOOLS/PLAN/LOOP/COMMAND/READ、复用夹具隔离标志、DAILY、同 nonce 的一次性库/私有桶/Redis 和目标 schema。浏览器仅使用本人 OIDC 的编译3130/8130。升级使用逐文件校验的3245个真实原174源文件和独立 workspace graph，实际制造 completed、queued、response_ready 和 uncertain 后再迁移；不以新代码写旧版本冒充历史。

知识、生产与原 owner 读写为真实实现；身份、媒体、订单及模型 HTTP 决策为隔离合成资料。未进行本批付费模型、真实外部交易、真实工厂生产或市场发布。普通148与其2598源快照、8份备份和用户 Excel 保持，未将本批开发源直接用于普通库。

仍需继续全领域真实工具、跨域依赖与受控付费子任务、MCP 真实授权客户端、实际模型质量与账单、CI、配套升级/备份恢复及完整平台验收。48需求、54工作包和8阶段不缩小；无限画布、无人设计与知识库保留。

## 本批验证结论

49项去重检查通过：16契约/证据/网关单元、17验收工具检查、3仓库规则、10当前API、1真实174→175和2编译本人页面。API受影响第5/6/10项在修复后定向重验，其余通过叶保留；浏览器两叶在同一新构建分次通过，保留第一叶并仅复验失败叶。类型、限定lint、构建及1440/390页面检查通过。它们是增量局部验收，未全仓重跑或CI确认。

自有18目标/10735文件/1871833608字节、358链接与10组隔离资源已清并独立前后复核。2份JSON报告因自动审查blocked by policy仍保留，未重试；不声明全部历史临时文件已清。详细见[进度](../project-control/ERP_AGENT_NATIVE_PROGRESS_20261022.md)。
