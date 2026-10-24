# Agent 持久依赖计划

PRD 1.1.113 本批定向验收与本机日用184采用完成 全平台继续

最终范围仍是全 ERP 受控跨域任务。当前新增独立 `erp-agent-dependency-plan-v1`，先贯穿真实的采购发票登记到财务采购应付登记；其它依赖类型明确未实现。原 plan/native-v1/v2/v3 的封存提案、请求和执行契约保持，不把原并列位置解释成依赖。

协调记录保存本人请求及规范摘要、出生权限上限、固定依赖类型、原采购 AgentCommand 引用、出生即固定的后继 requestId/nativeKey、明确 dueAt、解析后的来源/原文摘要以及真实后继命令引用。发票、供应商、金额和财务账均由原拥有者负责。协调记录不复制买家资料、提示词、模型结果、确认令牌或另一份账本。

前置原命令必须为本人的 procurement/invoice_record。`known` 仅表示找到了命令；唯有原 owner 的 succeeded、真实 invoiceResult、原 proof 和采购单关系核对后，才可从实际发票解析未来 invoiceId、发票号、金额、币种和日期。供应商由采购 owner 的窄读取给出。后继严格构造原 finance/bill_record(kind=procurement_invoice)；dueAt 由操作者明确选择或为 null。不能补造供应商、改写原发票号、舍入金额或将登记应付当付款。

创建和准备各有独立本人幂等身份。锁协调记录保存固定准备摘要，提交后调用原 AgentCommandService，再用短事务链接原结果；禁止持协调锁进入业务 owner。未知响应和页面刷新只查询原请求及实际回执，不自动 prepare/execute，不更换请求标识。GET 可以修复同一原键的协调引用，不能推进业务。前置取消、未知、未完成、失权和来源冲突明确阻断新后继。每一步实际执行均通过原具体确认；前一步批准不能批准后一步。

API 仅个人 OIDC。有效权限是原请求、协调出生上限及当前成员的交集；前置原命令另保留自己的出生上限。新协调任务不继承前置的执行批准。每次原 owner I/O 前后核对 authority，旧快照和迟到响应不能扩大权限。新表使用非 owner 应用角色、强制 RLS、本人约束、不可变出生字段、单调引用和同事务审计，不回填旧记录。

网页新增依赖状态、原操作交接和本人计划分页目录。只保存最小本人请求标识；清理事件先失效在途结果再删除标量。既有 V3 注销清理遗漏和 Plan 交接丢父任务上下文在本批修复。隐藏、退出、权限变化和失败状态保持明确；本人1440/390页面已验证两次原确认、丢201后只读恢复、真实撤权清文及迟到响应不重开抽屉。

七字段恢复标识通过 `unknown`、`prepare_unknown`、`cancel_unknown` 区分创建、准备和取消的未知结果，不能用旧准备凭据证明本次取消成功。准备未知仅凭原准备时间/精确 child 引用核对，取消未知仅凭实际 `cancelledAt` 核对；缺凭据保持 GET，不自动重新提交。登录回跳保留合法且唯一的 `agentDependencyPlan` 和原 `agentCommand` 参数，重复或无效 ID 丢弃，私文不进 URL。失权时仍可本地关闭抽屉，并使迟到详情读取失效。

HTTP 白名单为 `/v1/agent-dependency-plans/workspace`、`/requests`、`/receipts`、`/requests/:id` 和 `/requests/:id/{prepare,cancel}`。创建和准备返回201，取消返回200；实际执行没有依赖任务专属接口，继续使用原 `/v1/agent-commands/requests/:id/confirm`。网页 BFF 在 `/api/agent-dependency-plans` 下逐段对应，只代理已列路径，校验请求/响应大小、规范摘要、状态码及前后本人授权。

隔离 runner 入口为 `agent-dependency-plan-integration`、`agent-dependency-plan-upgrade-integration`、`agent-dependency-plan-browser`；最后一个要求 `--compiled-web --candidate <ID>` 和本人3130/8130。连接前检查 `E2E_AGENT_DEPENDENCY_PLAN_ISOLATED`、`E2E_AGENT_COMMAND_ISOLATED`、`E2E_PROCUREMENT_PROCESS_ISOLATED`、`E2E_INVOICE_COMMAND_ISOLATED`、`E2E_ISOLATED_DAILY` 五标志及同nonce的本机 DB/桶/Redis。升级要求 `pre-0184` 和真正旧183的独立源码图，普通检查为 `current`。`E2E_AGENT_DEPENDENCY_PLAN_CONTENT_KEY` 仅在升级夹具的父子进程环境中共享本批临时正文密钥，不写源码、清单或日志；日用服务没有新增环境变量。

沿用原 PostgreSQL、Nest、Zod 和原命令服务。已复核 [BullMQ Flows](https://docs.bullmq.io/guide/flows/) 与 [Temporal TypeScript SDK](https://github.com/temporalio/sdk-typescript)：队列依赖或新引擎不能提供原业务批准和回执，本批不新增执行平台或后台消费者。

验收覆盖两次原确认、前置阻断、真实提交后丢响应、同键并发及错内容、跨步骤确认拒绝、当前授权/出生上限、来源变化、原业务审计回滚与协调引用恢复。新增184仅先在同 nonce 一次性资源运行；真正183升级须证明历史逐列保持。所有测试输出置新的 owned 路径，辅助 TSX 显式 `TSX_DISABLE_CACHE=1`，检查后清理并独立查无。普通1036积压及原21个备份目录保持；新增真实183私有备份已完成恢复升级演练，日用采用184。885历史冻结未重试。

[本批范围](../project-control/checkpoints/2026-10-23-agent-dependency-plan-3f7c2a91-scope.json)

## 本批证据与运行范围

最终3773源 fc598294 与编译候选 e5332c3b／BUILD C226Jye6IeNpV0H56OemG 完全对应。17个去重单元、8个接口叶、1个真正183升级叶和2个本人页面叶通过，共28个去重功能检查；初始失败与38次实际执行分别记录，未重复旧全量套件。网络审计保留未知HTTP、取消、POST和console失败门，只接受有真实请求、原EOF或精确导航证据的既有读取分类；新页面的literal链接须在本代真实DOM采到。

真实日常183备份经完整原表逐列、183历史迁移前缀、规范schema/强制RLS与私有对象恢复核对后才apply184；原运营账户已只读核验入口。本批9组一次性DB/桶/Redis和升级演练资源独立查无，自有日志、截图、trace、测试副本与外层候选已清理，原业务备份和运行源保留。复跑升级时从对应183原源重新构建一次性图，不能把已删除临时副本的清单当作可执行源码。

当前仅这一类依赖，仍需操作者逐步核对原命令；模型自动编排、其它业务依赖、实际提供方/宿主、正式CI及完整平台业务验收继续。无新增日用变量、依赖版本、后台消费者或真实付费模型调用。见[最终记录](../project-control/checkpoints/2026-10-23-agent-dependency-plan-3f7c2a91-final-result.json)。
