# AI 对话入口与真实流式回复

`/ai-tasks` 默认显示知识、工艺与运营对话。会话记录、回答、来源与费用继续由原生知识问答和 Assist 持有。业务分析与高级工具按需打开；`?tools=1`、原 `run` 和原生 Agent 深链接仍进入原工作台，旧版本与业务确认没有转换。

本次对话提供已发布知识检索与连续问答。它没有把订单审核、生产放行、付款或外部提交改为自动执行。该类操作保留原业务入口和确认记录。

## 原生输入和执行

- `GET /v1/agent-chat/workspace` 返回当前本人可用模型与近期对话
- `GET /v1/agent-chat/conversations/:scopeId` 返回最近四十轮及 `hasMore`，每轮复核当前权限与原范围
- `POST /v1/agent-chat/turns` 将共享 `agentChatAssistRequest` 映射为原 `knowledge_answer` 请求，返回原 Assist 记录
- `POST /v1/agent-chat/runs/:id/stream` 核对原 `requestId` 和 `inputFingerprint` 后，仅执行该笔原生问答
- `GET /v1/agent-chat/runs/:id/stream` 只观察原任务，绝不派发或调用模型

Web BFF 为 `/api/agent-chat/*`，沿用本人 OIDC、同源 POST、当前 authority、原始路径和 Zod 契约。无新数据库表或迁移，无新增密钥域或环境变量。

浏览器在创建前保存现有 Assist 恢复标识。私有提问、回答和模型增量不写浏览器持久存储。创建响应未知时只读取原回执，不另造请求。上一轮必须属于本人、同一 scope、同一检索范围、未到保留期且已完成。模型上下文最多携带最近八轮；更早历史保留并明确显示范围限制。完整提问最多两千字符，知识检索键取前三百字符的原前缀，全文始终进入本轮原生问题并接受凭证和身份资料校验。

## 流式和回执

复用共享 `DurableAssistExecution`，不启动普通 Worker 或其他付费队列。原 Worker 路径保留包导出兼容层。原幂等、租约、固定来源、会员权限、提交未知、加密回执、预算和计量逻辑保持。

Responses 渠道有 `onTextDelta` 才请求 `stream: true`，仅读取官方 `response.output_text.delta`。服务端从结构化回复中提取根 `summary` 的真实增量；不发送模型推理、工具参数或其他 JSON 字段。短增量至多等待八十毫秒合并。最终结构化校验与原生采纳通过前，界面明确标为正在生成。JSON 或不支持增量的渠道仅一次显示最终结果，没有定时拆字。

每帧含原 run/request、当前 authority 和连续序号。API 在推送前重新核对当前会员和原私有任务；BFF 每帧复核本人会话并验证绑定。失权时停止输出并清除私有正文。首段显示不表示最终审核通过，完整响应才写入原回执和实际 token 用量。缺失用量或费用保持未知，不补零，不把估算写成提供方账单。

停止接收只关闭浏览器连接。已提交模型请求继续完成并记录已发生用量，之后通过 GET 读取原结果。刷新、断流和 GET 重连都不自动发起另一笔付费请求。API 进程重启后仅靠 GET 找回原持久结果；不会重放可能已提交的模型调用。当前增量预览为所在 API 进程内临时内容，跨实例只保证原持久结果可读。

## 复用与验证

交互参考 [assistant-ui](https://github.com/assistant-ui/assistant-ui) 与 [Vercel AI SDK](https://github.com/vercel/ai)，沿用现有 React、Next、Lucide 与 CSS，不新增聊天 SDK 依赖、不改开源画布 vendor。

流协议以 [OpenAI Responses 流式文档](https://developers.openai.com/api/docs/guides/streaming-responses) 为依据。验证分为提供方字节解析、summary 提取、共享契约、个人 BFF、隔离原生执行与编译本人浏览器。具体执行结论见本批交付记录；未通过正式采用的候选不得称为已上线。
