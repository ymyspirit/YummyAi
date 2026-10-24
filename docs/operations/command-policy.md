# 本机命令策略拒绝排查

先按实际返回判断发生层，保留原 call ID、时间、命令摘要和进程是否创建。不要仅凭 `blocked by policy` 将错误归因到自动审批模型。

| 证据 | 发生层 | 处理方式 |
| --- | --- | --- |
| `CreateProcess Rejected`、耗时0、没有进程退出码 | Codex执行策略在进程启动前拒绝 | 核当前审批模式、规则及同版本命令分类器，不修改ERP权限或Windows执行策略 |
| 进程已启动，返回`PSSecurityException`、`EACCES`或原生退出码 | PowerShell或操作系统执行错误 | 按实际错误定位脚本、端口、文件或依赖，保留原生证据 |
| HTTP403、当前账户权限或业务错误码 | ERP业务边界 | 核本人身份、租户、用途、审批及费用状态，不绕过业务门 |

## 本轮核实结果

本机证据核实了Codex core `0.164.0-alpha.11.1`，其二进制包含官方提交`6905ecede7816e91373e9eabda3f6b0368fc747b`。最近两条删除命令均含`Remove-Item -Force`。该版本的Windows分类器只需同一命令段同时出现删除命令和`-Force`便判为危险，不要求`-Recurse`；执行策略在`Never`下将需要审批的危险命令判为`Forbidden`，`Other`类型最终只显示`blocked by policy`。

这构成实际命令、有效权限及同版本源码的高置信静态对应。原日志未保留Rust实际分支跟踪，不能称为直接运行了分类器或已证明自动审批模型作出拒绝。官方文档也说明`approval_policy="never"`没有交给Auto-review的审批请求。

早期core `0.163.0-alpha.11`的启动拒绝另有源码对应：不透明PowerShell脚本回退可能把不同语句的URL与`start`词合并识别。该历史判断不能替代当前版本或删除命令的逐条调查。

## 项目内执行约定

- 日用先执行`pnpm daily:status`，健康即保留；确实缺失才使用`pnpm daily:start`。使用固定来源、构建和共享启动门，不将诊断、健康请求与生命周期动作拼入宽泛的内联脚本。
- 清理先核明确所有权、绝对路径、链接和活跃进程。新产生的普通文件使用无需强制权限的项目清理流程；只读、未知或无法证明归属的对象保留并报告。
- 已拒绝的目标保持原记录，不用换shell、编码、移到脚本、删除祖先目录或改权限的方式重试。日用发布与这些历史留存项分别记录。
- `cleanupPolicy.frozenPathCount`是累积目标集合大小，不能当成拒绝事件次数。事件数量按原call ID去重。
- 不修改全局审批模式、增加宽泛allow规则或降低Windows执行策略来让本项目通过检查。

## 原始依据

[同版本Windows命令分类器](https://github.com/openai/codex/blob/6905ecede7816e91373e9eabda3f6b0368fc747b/codex-rs/shell-command/src/command_safety/windows_dangerous_commands.rs#L272)、[执行策略决策与拒绝文本](https://github.com/openai/codex/blob/6905ecede7816e91373e9eabda3f6b0368fc747b/codex-rs/core/src/exec_policy.rs#L770)、[OpenAI Auto-review说明](https://learn.chatgpt.com/docs/sandboxing/auto-review)。含本机路径和事件定位的详细报告仅保留在本机checkpoint，不提交公开仓库。
