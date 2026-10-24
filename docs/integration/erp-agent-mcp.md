# ERP Agent MCP 接入口

<!-- 8d6f2a19-extension -->
PRD1.1.95：独立resources-v1六类原业务事实完成本批局部验证；可信启动参数 --allow-resource=<key> 逐项允许，默认仍49目录项及五读取，允许后55项元数据，五个公开协议工具不变。原读取定义补实际executionContract，native/start补原模型/限制/pin，官方客户端已通过协议发现后调用，测试不从夹具补pin。23项去重功能检查、4组隔离检查和本批自有清理通过。旧MCP共享v1 schema及历史pin保持；原版本、有界投影和未接入旧原生模型循环等限制见[资源契约](erp-agent-resources.md)。实际用户宿主与普通环境未采用，全平台未验收。
<!-- /8d6f2a19-extension -->

日期：2026-10-22。ABI：`erp-agent-mcp-v1`。对应 B09 / B28 / B50。

本机 stdio 适配复用原生 Agent、工具网关、本人 OIDC 和原业务拥有者。它不另建事实库、权限系统或执行器。首次采用官方 Apache-2.0 TypeScript SDK 2.3.1；原有 Node 24、Zod 4、PostgreSQL、BullMQ、模型账本和人工确认继续使用。依赖来源：[官方仓库](https://github.com/modelcontextprotocol/typescript-sdk)、[v2 文档](https://ts.sdk.modelcontextprotocol.io/v2/)。精确锁文件变更见本批 dependencies 记录。

源码实现、隔离测试成功、实际宿主配置、本人日常使用和完整 ERP 业务验收是不同状态。页面恒定显示“当前客户端连接状态未知”，不能从服务端支持协议推断 Codex 已经连接。本批结果以 `ERP_AGENT_MCP_PROGRESS_20261022.md` 为准；实现或测试尚未完成时不得标成已验收。

## 接口与能力范围

仅注册五个 MCP 工具，严格输入，不接受模型指定 URL、租户、SQL、文件路径、额外命令或业务执行端点。

| 入口 | 行为 |
| --- | --- |
| `erp_capabilities_search` | 搜索固定能力元数据，投影当前本人权限及启动策略。目录分页的 complete 只表示目录条目，不代表业务数据全量 |
| `erp_tool_schema` | 按 key 加载一项原契约及校验值，不因查看契约准备命令 |
| `erp_execute` | 读取原工具，或在显式启动策略下提交模型任务、停止后续调度、准备一项已封存提案 |
| `erp_saved_result` | 按原 ID / requestId / SHA 读取任务及回执；原命令仅返回已关联元数据和安全相对核对链接 |
| `erp_usage` | 读取单笔原任务账本费用与未知费用状态。scope 为 run，不提供组织余额或推算剩余额度 |

固定目录是 5 个 reader、37 项原命令定义及 7 个原生任务操作，共 49 条。五个 reader 是订单异常分页、库存余额分页、已发布知识检索、创意执行历史、工厂产能窗口。旧目录里尚未实现的描述不能成为可执行工具。知识检索仍是排名子集，创作历史和产能窗口仍有界；调用方必须保留原 coverage。

原生操作 key：`native/start`、`stop`、`prepare`、`run`、`receipt`、`item_receipt`、`usage`。读取 key 形如 `read/knowledge.search`，命令 key 形如 `command/<原 domain>/<原 kind>`。命令必须通过原共享分支校验，不能仅依据标签或模型生成的 JSON Schema 判断有效。

`erp_execute` 的 `requestJson` 是一份原请求 JSON 文本，UTF-8 限 1 MiB；随后必须再经所选原 Zod 分支解析。操作和对象 ID 相互约束。注册入口里没有业务 confirm、execute、付款、发布、发消息或工厂正式生产。原准备只产生待核对命令；人工继续在 `/ai-tasks?agentCommand=<真实ID>` 查看原文及确认。

## 本人身份与启动策略

仅两个进程环境变量用于 ERP 接入：

```text
YUMMYAI_MCP_ERP_API_URL=<可信 ERP API origin>
YUMMYAI_MCP_ERP_ACCESS_TOKEN=<本人短时 OIDC access token>
```

ERP access token 和模型供应商 API key 是两种凭据。此进程不读 `.env`，不接收 CLI 密钥，不提供凭据输入框。不得把令牌写入源码、日志、聊天、普通配置或提交记录。令牌应由实际身份提供方针对 ERP API 的受支持 OIDC 流程获取，并由可信客户端在启动进程时注入；当前适配器尚未实现宿主 OAuth 获取/刷新或远程 HTTP MCP。旧集成 API client key 不获得这些新通路。

每次调用前后读取真实 `/v1/identity/session`，以 `erpSessionAuthority()` 关联原 DTO 的 contextAuthority。成员关系、逐权限范围、对象和当前来源继续由原 API / RLS 检查；迟到身份变化时丢弃私文。直接 API 不依赖 Web BFF 才提供的 authority 响应头。

现有 OIDC 校验 `iss`、`aud`、签名及 `exp`，没有单 JWT 即时吊销查询。因此成员停用、角色/团队撤权和令牌过期可拒绝后续请求；不能声称 IdP 注销会立即吊销尚未过期的 JWT。令牌到期后需由可信身份流程更新并重启 MCP 进程。

可信本机启动参数在进程创建时冻结，工具调用无法修改：

- 默认五项读取，付费模型任务和原提案准备关闭。
- 重复 `--allow-read=<reader key>` 可缩小读取集合；省略时为已知五项。
- `--allow-model-run` 必须配 `--max-cost-usd=<单任务上限>`，正数，最多六位小数且不超过 100 USD。它是每次提交的上限；组织预算继续由原账本判断，不代表进程总额度。
- 重复 `--allow-command=<domain>/<kind>` 指定原命令白名单，默认空。
- `--allow-prepare` 必须有非空原命令白名单，且每笔仍核对原提案和当前业务权限。
- 未知或重复参数拒绝，错误不回显参数。

API 地址只能为可信 origin，禁止 userinfo、query、hash 或路径。HTTP 仅限 loopback；其他地址要求 HTTPS。重定向始终拒绝。响应成功最多 8 MiB，错误最多 8 KiB，120 秒截止。ERP 操作错误及已注册工具参数校验只返回固定安全 code，不转发上游正文、参数值、未知字段名或认证信息。调用不存在的工具由官方 SDK 拒绝，其协议错误可能包含调用方自己传入的工具名；客户端不能把凭据放在工具名或 JSON-RPC ID 中。本适配没有替换 SDK 的私有派发实现。

## 启动与真实宿主验收

人工终端可运行 `pnpm --filter @yummyai/agent-mcp start`。实际 MCP 宿主宜直接启动 Node，避免包管理器的终端日志进入 stdio 协议：

```json
{
  "command": "node",
  "args": ["--import", "D:/YummyAI/apps/agent-mcp/node_modules/tsx/dist/loader.mjs", "D:/YummyAI/apps/agent-mcp/src/main.ts"],
  "cwd": "D:/YummyAI"
}
```

上面是无密钥模板，并非已写入宿主的配置。两项 ERP 环境由宿主的受保护启动环境注入。不同宿主的配置外壳由该宿主文档确定，不能把此片段当全局设置直接覆盖。宿主需完成 initialize、listTools 精确五项及一次本人受权查询，才可记录它实际接通。

## 断线、回执与完整性

提交前固定原 requestId、规范请求 SHA 和允许范围。保留的恢复信息只含 ID / SHA，不缓存原目标、提示词、令牌或业务正文。调用方应在提交前可靠保存这些非私有恢复引用。

已提交的 POST 不因客户端取消而盲目中止或自动重试。响应丢失、状态/结构/校验无法确认时返回 submission_unknown 和原恢复引用；后续使用 `erp_saved_result`。重启宿主后继续按原引用读回执，不更换编号重新付费或准备。未找到回执不能证明尚在途的请求未提交；unknown 保持未知。

任务恢复验证原 ID、请求 SHA、固定绑定和原来源。提案回执关联原父任务、请求、item、proposal SHA、preparation SHA 及已知原命令 ID。共享 `agent-transport` 是从原 Web / BFF 校验机械提取的纯实现，原 definition、input、data、claim、proposal 和原命令规范 SHA 算法不变。读取历史时保留当时来源 authority，不能用今日身份重写旧来源。

费用读取只展示原账本，包括未知费用和已有预留；不把预留与已知支出相加伪造实际花费。只读搜索、定义、结果、回执和费用不会调度付费模型或准备业务命令。停止任务仅阻止后续调度，不撤销现实交易或伪造已完成消费退款。

## 隔离验证与尚未完成的工作

统一 disposable runner 提供 `--suite=agent-mcp-integration` 与 `--suite=agent-mcp-browser --compiled-web --candidate=<本批源码一致候选>`。配置必须在连接前验证 MCP 及原 11 项隔离旗标、current schema、相同 nonce 的数据库/私有桶/Redis。普通 148 数据库不用于本批测试，新源码不能对普通库运行。

验证使用官方 SDK Client + stdio、真实签名 OIDC、数据库成员与权限、真实 owner / RLS、真实队列及标准 Worker 版本路由；仅模型 HTTP 使用合成响应。隔离模型的账本金额不能当真实供应商账单或质量证明。浏览器沿本人编译页面；所有测试数据、候选、原始日志、截图与缓存验后清理并记录。历史被策略拒绝的路径保持冻结。

完整 ERP 仍需补齐领域 reader/owner 工具、真实模型任务评测、实际宿主身份接入、普通环境采用、跨模块业务验收及 CI/发布验证。37 项定义可发现不等于 37 种真实业务已验收，协议接通也不等于允许无人值守生产。
