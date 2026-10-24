# ERP Agent 原业务命令接入

2026-10-22，6f2d9a84，PRD1.1.90。本地切片34项去重定向及2条本人编译页面通过，临时输出和5组隔离资源已清并前后独立复核；尚未采用到日常ERP。

复用已安装的 PostgreSQL、Drizzle、Nest、Zod 和既有持久命令，不引入新的 Agent 框架、依赖或业务账。参考开源 [Agent 审批及恢复](https://openai.github.io/openai-agents-js/zh/guides/human-in-the-loop/)和 [BullMQ 幂等任务](https://docs.bullmq.io/patterns/idempotent-jobs)的机制；具体授权、版本、回执及实际幂等仍由本项目原业务服务决定。

## 实际覆盖

采购9、来料6、生产3、财务12、广告7，共37种原命令接到统一适配器的准备、定位、读取、执行、取消及核对结果。准备只形成原业务命令，不实施业务事实。原生服务仍保留真实对象、金额/计量、审批、资料版本、产能/生产资料门、并发锁、事务审计、保留期和原结果。登记付款仍是内部账务登记，广告动作事件不代表平台实际投放，生产的已存在回执不算本次新下达。

新协议 `erp-agent-command-v1` 独立于 `erp-agent-loop-v1`。旧模型循环仍只有read/finish及两个原读取工具；本批统一命令网关不等于模型已经会自行规划或准备全部写入，MCP客户端也未连接。后续需要单独的版本化模型决策/工具调用适配及评测，不能改写旧循环契约或历史检查点。

## 原请求及确认

0173新增 `agent_command_requests`，只存本人原请求/摘要、原输入摘要、原owner绑定、出生权限上限和确认元信息；完整私文仍只在原owner加密保留。没有Agent采购、库存、生产、付款或广告事实表。

程序工具通过prepare传入严格原输入；普通操作在原业务核对页将已准备原命令adopt到AI工作台，不重建原命令。请求摘要为SHA256(canonicalAgentCommandRequest(operation,raw))。七标量纯ID意图在POST之前写入并回读，原输入和确认token不进浏览器恢复存储。原准备成功但协调引用未保存时，GET仅按本人、kind/target/account、原key摘要及原请求摘要在原owner精确定位；不调用prepare/execute，也不因为近期列表没找到就另起新键。

工作台重新读取原完整填写、真实版本和执行资格后，由用户针对具体原命令确认。加密短效token绑定本人、协调请求、原命令、原输入摘要、原权限上限及当前个人会话，默认5分钟，仅服务端依赖注入可缩短，HTTP不可设置。确认及其审计先同事务持久化，再调用原execute；不将模型回复或prepared/canExecute视为批准。原owner在真正写入前再次核对当前权限与原上限及业务版本。收到响应前断线时只读原回执；不得自动换原键或重复发起原执行。需要恢复原执行时由用户重新核对，原owner继续承担幂等。

WorkflowRead/Run可按本人self授权；领域读、写、审核及对象范围仍沿各原owner。每次I/O前后和最终响应核对当前逐bit/团队与出生上限交集；新增权限不会扩张旧任务。当前个人响应标识与旧任务授权分别保存。纯标识回执不自动授予私文读取权。

## 接口及页面

个人BFF `/api/agent-commands` 对应 `/v1/agent-commands`：GET workspace、GET receipts、POST prepare、POST adopt、GET requests/:id、POST requests/:id/confirm、cancel及acknowledge。prepare/adopt返回201，读取及动作返回200。现有只读API Client权限不开放这些写入口。

五个原业务核对页保留原流程，并提供“交给AI工作台核对”。AI任务页展示37项能力、本人最近20个原关联及明确的是否还有更多、原文/版本、实际状态和回执。确认、取消准备、核对结果分别操作；关闭页面不撤销事实。生产安排、模型费用和采购/付款授权各按自身事实解释，不能相互代替。

BFF校验完整路由、严格DTO、JSON/UTF-8、大小、Same Origin、当前个人authority、原请求/owner ID及状态码，并在读完整上游正文后再次复核身份。无权/失败时不透传原错误私文。业务命令保留自己的到期清理；协调记录不复制原私文，不篡改原7天期限以伪造验收。

## 验证与续做

仅使用一次性DB、私有桶、Redis及个人OIDC验收账户；真正旧172源码3169文件及350个依赖链接已固定，原文件SHA逐一相同，新命令导出不可从旧图访问。新current173的13组、真正172→173升级1组和同编译个人页面2条均已验收。失败只补必要叶子，主控串行管理资源、构建和清理；原样表、8备份、208保护文件、883冻结及普通2598源/148迁移保持。主状态见 `docs/project-control/state.json` 的erpAgentCommand，本批8目标5597文件930373448字节及353个链接已清，157共享目标保持，5组资源清理前后查无。最新PRD及依赖已同步1.1.90，真实旧源码/编译候选/日志/截图已按要求删除，复跑需重建。见[本批进度](../project-control/ERP_AGENT_COMMAND_PROGRESS_20261022.md)和[定向证据](../project-control/checkpoints/2026-10-22-agent-command-6f2d9a84-evidence.json)。48需求/54工作包/8阶段和0完整工作包/0业务验收保持。

出生上限SQL验证声明的每个权限、逐项scope及team均不超过实际成员；缺字段/错误JSON类型不能利用NULL通过。确认/链接/取消/核对均有同事务动作及反向审计闭包。已知401/403/404或409 authority_changed交接响应立即清除原Review私文和旧动作；未知网络及普通业务冲突保留纯标识按原回执核对。
