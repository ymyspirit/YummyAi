# 上架准备 Agent

入口：**商品与刊登 → 上架工作台 → 选择销售方案 → 上新任务 → 上架准备 Agent**。

目标固定为「准备当前销售方案至可提交刊登审核」。点击 **检查并准备草稿** 后，系统逐项核对载体与工艺、印花组合与套图；资料齐备时调用原销售方案服务创建或同步本地刊登草稿，再检查实际草稿的提交条件。缺项显示原业务页面的处理入口，补齐后点击 **继续原任务**。

## 日常使用

1. 先保存销售方案，再开始任务。未保存改动时沿用工作台的禁用提示。
2. 查看四个步骤的核对结果、固定版本、草稿入口和执行记录。任务按当前租户和创建人隔离，历史选择器显示自己的最近十个任务，记录显示最近三十个检查点。
3. 若要分析原创方向或刊登文案，选择分析环节并点击 **读取 Agent 分析依据**。核对来源和缺项，选择已配置模型后，点击 **确认依据并开始分析** 才创建模型任务。每个准备任务最多两次分析；单次费用与组织预算沿用原 AI 服务。未知费用保持未知。
4. 分析完成后点击 **查看并核对建议**，在原差异面板勾选字段并采纳。采纳创建销售方案新版本，回到原准备任务，明确点击 **按 Vx 继续任务**，重新检查并同步草稿。
5. 出现 **可提交审核** 后，在刊登编辑器核对并提交审核，后续沿用原审核、封存及正式平台 API 流程。

“可提交审核”是对固定版本的技术核对结果。资料、图片或刊登状态变化后会提示重新核对，原记录保留。它不表示运营审核通过、Amazon 接受或实际可售，也不批准生产或购买物流面单。

## 中断、失败与停止

- 任务 ID 保存在 `preparation` URL 参数。刷新、回到页面、读取历史和后台轮询只读状态，不创建草稿或发送模型请求。
- 同一方案、同一操作者已有未完成任务时，重复开始返回原任务。每次开始、继续、停止和分析都有幂等编号；相同编号不能替换参数。
- 执行前先保存意图和业务请求编号。草稿或分析响应丢失时，点击 **继续原任务** 会使用同一个业务请求编号核对结果，避免重复版本和重复计费任务。
- 页面关闭后已发送的服务端请求及模型 Worker 可以完成；服务进程中断后，需要重新打开任务并继续。准备协调器每次请求最多推进四轮，不会在无人确认时无限循环。模型执行和结果保存由现有 Worker 负责。
- 单次执行有 60 秒租约。租约有效时阻止并发推进，过期后允许接管原检查点。原执行者不能覆盖新执行者或已停止任务的记录。
- **停止任务** 停止后续协调动作，不回滚已有草稿，也不撤回已经派发或正在提交的模型/业务操作。相关结果仍在原业务模块中。已停止任务不能恢复，可以建立新任务；分析结果不确定时应先继续原任务核对，不能通过新建绕过核对。
- 对权限、版本和预算错误，先修复提示的业务条件再继续。取消任务不删除版本和审计历史。

## API 与权限

公共前缀：`/v1/sales-plans/:id/launch/agent`。浏览器同源代理前缀为 `/api/sales-plans/:id/launch/agent`。

| 方法与路径 | 请求与行为 |
| --- | --- |
| `GET /` | 最近十个本人任务 |
| `POST /` | `{ expectedRevision, idempotencyKey }`，开始或返回原任务 |
| `GET /:run` | 当前任务、当前方案版本、来源变化、执行权、分析状态及费用、最近三十条记录 |
| `POST /:run/resume` | `{ expectedRevision, expectedRunRevision, idempotencyKey }`，确认当前方案版本后继续 |
| `POST /:run/cancel` | 同上，停止后续协调动作 |
| `POST /:run/basis` | `{ kind, expectedRevision, expectedRunRevision }`，只预览分析依据 |
| `POST /:run/analyze` | 在继续请求字段上增加 `{ kind, modelId, expectedFingerprint }`，创建已确认分析 |

`kind` 仅允许 `creative` 或 `sku_package`。共享 Zod 契约拒绝任意工具名、租户、执行路径、字段写值和审核状态。所有响应 `private, no-store`；浏览器写入检查同源与 JSON 格式。

读取需要当前 ProductRead、DesignRead、AssetRead、ListingRead 和租户数据范围。命令另需 ProductWrite、ListingWrite；分析依据、创建和结果读取还检查原分析种类对应权限。租户由认证成员上下文取得，所有业务数据库操作通过非 owner 角色的 `withTenant()`。任务仅创建人可见；原销售方案及产物仍遵循各模块自己的授权。

## 持久化与业务边界

准备任务复用追加式 `development_events`，事件为 `sales_plan.preparation_started` 和 `sales_plan.preparation_checkpoint`。每次命令及检查点追加新修订；最新状态按任务修订号读取，不能按事务时间戳推断先后。协调记录包含计划、步骤、方案/规格/印花/刊登版本引用、已创建分析和草稿引用、待确认意图、租约和幂等哈希。协调器内部意图、租约和请求哈希不暴露给客户端；分析依据指纹用于预览后的版本核对。

状态为 `running`、`blocked`、`waiting`、`ready`、`cancelled`。资料不足或执行受阻进入 `blocked`；已派发可选分析进入 `waiting`；四个步骤全部通过才为 `ready`。读取时另外计算 `sourceChanged`，历史 `ready` 不会被解释为当前资料已通过。

协调器调用 SalesPlanService、SalesPlanLaunchService 和 AssistService。草稿写入、依据核对、模型费用、建议采纳、人工审核和封存分别由原领域服务负责；没有跨模块直接写表。模型不能挑选任意工具、自己采纳建议或决定审批。没有新增表、迁移、环境变量、队列、凭据域或独立知识库。

参考开源项目中持久计划、有限循环和审批边界的设计，保留 YummyAI 原有业务实现，未复制上游源码或安装其运行时。固定来源与范围见 [Ivyea 对照记录](../architecture/2026-10-13-ivyea-reference-alignment.md)。订单及履约 Agent 的进一步协调是后续范围。

## 验收

本批结果与清理记录见[2026-10-13 本地验收](../operations/2026-10-13-sales-plan-agent-acceptance.md)。

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e:order-daily --suite=ai-tasks-integration src/catalog/sales-plan-agent.integration.test.ts
pnpm test:e2e:order-daily --suite=all-integration
pnpm test:e2e:order-daily --suite=sales-launch
pnpm build
pnpm start:local
pnpm check:local-runtime
```

集成覆盖真实版本写入、响应丢失恢复、重复命令、当前版本重核对、租户/创建人/权限、过期租约和取消。浏览器覆盖实际登录、API、RLS、分析处理器与建议采纳、草稿同步、资料失效、刷新恢复、1440/390 px 页面及无重复模型提交。测试中的产品资料、已审核图片和模型传输使用隔离合成夹具；这些检查不证明真实付费模型的输出质量或实物质量。

浏览器截图与产物 ID 位于忽略目录 `tmp/sales-launch-e2e`，集成夹具清单位于 `tmp/sales-preparation-integration`；运行器在 finally 删除测试数据库、私有桶和 Redis，并在 `tmp/order-daily-e2e-<token>.json` 逐项核对清理结果。永久业务资料不用于验收写入。运行 E2E 或构建前应停止同工作区 Next 开发服务，完成后恢复本地运行。
