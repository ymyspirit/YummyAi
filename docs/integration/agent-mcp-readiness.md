# MCP 运行前只读诊断

版本 erp-agent-mcp-readiness-v1，PRD 1.1.111，2026-10-23。本批已完成定向技术验证并采用到本机日用183，自有测试输出已清；完整平台、实际宿主和真实执行仍另验。沿用已固定的官方 MCP SDK 2.3.1、五个协议入口、原个人 OIDC/凭据 lease 和五类 ERP 只读诊断，不引入新的执行框架或数据事实。

## 输入和启动权限

仅 MCP v2 支持可信启动参数 `--allow-readiness=<family>`，按 loop、plan、native_v1、native_v2、native_v3 逐项允许；省略时保持旧目录和旧行为，重复或未知 family 拒绝。工具输入不能修改启动范围、API origin、用户、租户或预算，也不能启用模型或准备权限。原 v1、native/、native-v3/、旧请求和回执语义保持。

通过原 `erp_capabilities_search` 发现 `readiness/<family>`；它是元数据读取。`erp_tool_schema` 读取这一 key 的严格定义。`erp_execute` 的新独立分支仅接受 `{version:"erp-agent-mcp-readiness-v1",family:<固定family>}`。不接受目标、prompt、ID、任意路径、query、模型或金额。`erp_saved_result` 和 `erp_usage` 没有诊断分支，诊断不创建持久任务。

## 原身份与真实诊断

复用固定个人 token lease，读取前后核对 `/v1/identity/session` 和当前 authority；仅 GET 固定 `/v1/ai/agent-readiness/<family>`。原诊断服务以本次 incoming request context 与刷新后的 membership 相交，诊断 family、DTO authority 与当前 lease 精确一致。个人 OIDC JWT 仅携带 subject 和 tenant，没有登录时权限快照；MCP 进程的冻结启动策略才是此适配器的启动上限，原持久任务的 owner 和创建时上下文另由原入口约束。迟到撤权、改租户、grant 注销、错误 family、伪造 effects 或错误响应均不返回旧私文；不自动刷新重发，不调用模型、预留费用、入队或执行业务。HTTP 成功体沿原有 8 MiB 上限，错误体 8 KiB，严格 JSON/200、无重定向和固定安全错误码。

返回原 `erp.agent.readiness.v1` 诊断，并独立返回冻结的本机启动策略。原 ERP 的“没有已知阻断”不说明本机允许付费任务。loop、plan、native_v2 的 MCP 启动入口尚未登记，明确 `not_registered`；native_v1 沿原入口，native_v3 仍须 `--allow-native-v3`。付费仍由原 `--allow-model-run` 和每次费用上限限制，原工具、资源、履约和命令白名单继续生效；本次选中工具及具体输入未被诊断核验。

原诊断的四项未检查内容保持：具体请求金额、所选来源、提供方连通、消费者在线。缺报价不代填免费，不以预算或任务目录推断消费者在线。

## 配置说明和验收

网页保留原五个协议入口、旧启动/个人模板和“客户端连接状态未知”。新增独立的只读诊断启动命令，明确只复制，不读本机凭据、不修改宿主、IdP 或全局安全设置。实际个人客户端登记、登录及发现/调用需独立验收。

新增协议/策略单位、真实受权 API 与官方 SDK stdio 定向验收：五 family、只读无运行权、本次请求权限与刷新后 membership 相交、同一个人 token 的迟到撤权、冻结启动允许范围、错误 family/版本、伪 effects 与零新任务/预留/模型。专属 runner 连接前拒绝缺隔离标记或非同 nonce 资源；新测试输出只入本批自有临时目录，验后清理。旧已通过全量套件不重复运行。

对应 B09、B28、B50、B51。本片不完成整个 Harness、真实提供方/账单/工厂业务、实际用户 MCP 宿主或全平台验收。原本机183日用版、1036积压任务、21个备份目录和885历史冻结范围保持。
