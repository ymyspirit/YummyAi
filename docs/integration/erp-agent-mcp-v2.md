# 个人 Agent 与显式 MCP-v2

2026-10-22 · PRD1.1.99 局部技术验证通过 · 7c4e1b92

P6 版本边界：网页可以使用 native-v4；本 MCP-v2 仍只显式接入 native-v3 及原有只读能力，不接受 v4 的履约执行请求。下文 177 是本功能最初落地的历史基线；当前验收跟随仓库 current 迁移，不回退数据库。个人 PKCE、凭据保护与撤销按本篇实现；旧 MCP-v1 文档中的环境 bearer 限制不能作为 v2 未实现个人登录的判断。实际宿主是否连接仍须单独核验。

本机 stdio 使用既有官方 MCP SDK 2.3.1。五个公开入口保持能力搜索、单项定义、受控调用、原结果与任务费用；不增加任意 HTTP、SQL 或 Shell。显式 `native-v3/` 能力与带 `erp-agent-native-v3` 版本的请求路由到已有 v3 owner，原 `native/`、无版本外层请求及旧 ID 继续原 v1 语义。网页内置任务与外部宿主复用同一原业务及持久任务，不创建第二套事实。

PRD1.1.111 本机局部技术验证与采用通过：v2 可另用逐项 `--allow-readiness=<family>` 开放已有五类 ERP 只读启动诊断。新分支不扩展模型/准备权限，也不修改上述旧请求；原诊断与本机冻结策略分开。个人 JWT 只有 subject/tenant，权限取当前 membership，不保存登录时权限快照。输入、执行边界与定向验收见[诊断适配说明](agent-mcp-readiness.md)。

## 可信启动与原任务

旧 `pnpm --filter @yummyai/agent-mcp start` 保持原行为。新入口为 `pnpm --filter @yummyai/agent-mcp start:v2 --personal-auth --allow-native-v3`。新版本默认关闭模型付费与原操作准备；`--allow-native-v3` 只允许发现和读取该版本，付费仍需 `--allow-model-run --max-cost-usd=<单任务上限>`。六类资源、订单履约及命令种类均沿原显式允许参数。命令准备还须 `--allow-prepare` 与逐种命令白名单。

Agent 先搜索、读取所选定义，再使用原输入。启动定义返回实际模型、上限、主执行及三种读取版本；从资源/履约候选选择原对象。旧创意与工厂工具的对象 ID 由操作者明确选择，不伪造为全平台枚举结果。每次原业务读取仍检查本人当前身份与 owner 对象范围。模型没有业务确认入口。

新外层 execute 使用 `{version:"erp-agent-native-v3",operation:"start"|"stop"|"prepare",id,itemId,requestJson}`；requestJson 是原 v3 严格 JSON。原结果读取同样显式携带版本及 run/request_receipt/item_receipt kind；费用读取为 `{version:"erp-agent-native-v3",id}`。丢失提交响应只读原回执，恢复信息保留版本、原 ID 与原摘要，不换请求重买或重准备。费用是单任务记录，未提供组织余额。

若宿主连 adapter 的恢复回包也没有收到，可向 `erp_saved_result` 提交 `{version:"erp-agent-native-v3",kind:"request_receipt_from_request",requestJson:<原严格JSON>}`。适配器仅本地按原 canonical 规则计算原 requestId/checksum，再 GET 原回执；不会调用 start。保留原文使调用者无需猜 SHA，原纯 ID/摘要方式继续有效。

## 个人登录与凭据

配置示例见 [无密钥个人配置](../../apps/agent-mcp/auth-profile.example.json)。在可信本机环境将 `YUMMYAI_MCP_AUTH_PROFILE` 指向自己的绝对配置文件路径。配置固定 ERP API origin、issuer、public client、API audience 与精确 loopback callback；不可由工具参数更改。个人模式拒绝同时注入旧 `YUMMYAI_MCP_ERP_ACCESS_TOKEN`。可用可信 `YUMMYAI_MCP_AUTH_STORE_DIR` 改凭据库绝对目录，隔离验收必须指定本批自有目录。

身份管理员需预先登记 dedicated public client。供审阅的 [Keycloak client 示例](../../infra/keycloak/agent-mcp-client.example.json) 只允许 Authorization Code + PKCE S256，禁用密码/隐式/service-account grant，使用精确 127.0.0.1 callback。tenant_id 继续来自管理员管理的用户属性，ERP 以真实当前成员关系为权威；新增 client 不新增用户、角色或 ERP 权限。本批不会自动导入示例或修改真实 Keycloak，现有 Web client 也不意味着已登记本机 callback。

操作者在本机运行 `pnpm --filter @yummyai/agent-mcp auth login` 后使用系统浏览器登录；`auth status` 核对，`auth logout` 清除本机授权。网页 Cookie 与模型 API key 不能替代个人身份。启动或重新登录后须新开 MCP 进程；运行中不自动改用后来登录的其他身份。

Windows 凭据只以 CurrentUser DPAPI 密文和专用 ACL 保存在本机。密码不由 CLI 接收，token 不进入网页、argv、环境、日志或宿主模板；旧环境 bearer 模式仅作为原 v1 兼容路径保留。OAuth 代码交换和刷新复用 SDK helper，JWT 再核验 issuer、audience、client、subject、tenant 和 nonce，并调用 ERP 本人会话门。

刷新前持久化不可重放标记，以跨进程短锁和 CAS 提交旋转结果。未知刷新响应或损坏缓存要求重登；不会再用已可能消耗的 refresh token。每个 ERP 权限围栏持有同一个短时 token lease，提交前和结果返回前检查 grant 仍有效。刷新在新围栏前发生；不会因 ERP 401 自动重发付费或准备 POST。`logout` 使本机旧 lease 失效，不承诺已签发 bearer 在身份服务器/ERP 的全部副本瞬间撤销。

本机退出不会取消已受权提交的持久任务。需要停止后续派发时按原任务 ID 使用原停止入口，已经提交的请求仍只读原回执。

## 宿主与验证

面板提供 Codex TOML 和通用 MCP JSON 无密钥模板。Node 的 cwd 必须是 `<ERP根>/apps/agent-mcp`，这样 `--import tsx` 从对应 workspace 解析。宿主模板不含付款或准备开关。配置文件存在、命令复制成功或官方 SDK 测试通过，都不等于实际宿主接入。

Codex 的本机 stdio 配置使用 command、args、cwd 和 env。具体选项以 [OpenAI Codex MCP 文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) 为准。stdio 对 ERP 的个人登录与 HTTP MCP OAuth discovery 是不同边界；本适配器不在 ERP REST 外套自动重试的 OAuth HTTP 编排。

新增专项由 disposable runner 的 `agent-mcp-v2-integration` 与 `agent-mcp-v2-browser` 执行。连接前必须通过旧 native-v3 十七个标记及新 MCP-v2 标记，并核验同 nonce DB/桶/Redis。schema 仍177，无新迁移。普通148及2598源保持，不能直接以177源码启动，不重试旧普通 Web 策略拒绝。具体检查、实际宿主与普通采用结果在 [本批进度](../project-control/ERP_AGENT_MCP_V2_PROGRESS_20261022.md) 分别记录。

本批30项去重检查及实际安装CLI原SKU读取、4图检视通过，5组资源和全部自有输出已清并独立复核。真实身份client登记、普通日常采用及全平台业务仍待验收；完整证据与失败修复见[本批进度](../project-control/ERP_AGENT_MCP_V2_PROGRESS_20261022.md)。
