# Agent 执行服务当前观察

PRD 1.1.112 本机定向技术验证与日用采用通过 自有测试资源及输出已清 完整平台与真实模型另验

五个 Agent 家族沿用原持久任务、版本路由、恢复调度与回执。loop 对应 agent-loop/agentLoopScheduler，其余四个家族对应 agent-plan/agentPlanScheduler。独立短时观察不修改旧 erp.agent.readiness.v1 或 MCP 诊断 ABI。

Worker 复用已安装 BullMQ 的公开消费循环、暂停与连接状态，仅在明确选择 Agent 队列时发布无租户、无任务与无模型内容的 15 秒 Redis 租约，每 3 秒更新。每个实例固定身份；正常停止先撤回，异常终止依靠租约过期。恢复调度必须实际完成一轮且没有派发失败；只有启动、挂起或 tick 不构成成功。成功循环 75 秒内有效。

API GET /v1/ai/agent-runtime-readiness/:family 仅个人 OIDC 与当前 WorkflowRead 可读，按原请求上下文和 fresh membership 相交并在 I/O 后重核。没有 WorkflowRun 时不访问 Redis。观察只读，不投探针任务、不更新队列 meta、不读 job payload。消费、调度及版本必须属于同一实例，原始观察最多 64 个实例。连接不确定时明确 unknown，原四项具体预算、所选来源、提供方及业务准入仍未检查。

Web GET /api/agent-runtime-readiness/:family 返回相同严格版本及本人 authority。新提交同时要求旧配置诊断通过和独立 observed_ready，最久 10 秒，并保守扣除请求时间。隐藏、离线、身份/家族变化立即撤销证明；回到前台真实读取后再启用。原 API 的持久排队准入、已存在任务的读取、停止与原键恢复保持。普通 Worker 不因打开页面自动启动。

验收使用独占数据库、桶、Redis 和标准 Worker 子进程，覆盖真实消费、完整调度、暂停、Redis 断连、SIGKILL 后真实 TTL、正常停止、并存实例和迟到撤权。禁止普通积压消费及真实模型请求。原输出和资源在核验后按精确所有权清理；885 历史冻结路径不重试。

[本批范围](../project-control/checkpoints/2026-10-23-agent-runtime-readiness-5a91d7c3-scope.json)
