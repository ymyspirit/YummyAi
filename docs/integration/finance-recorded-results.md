# 本人财务命令的历史执行结果

状态：2026-10-21本批定向验证通过：141单元/规则、25隔离集成及最终同编译2条个人会话；普通数据库仍148，未普通采用157，也未完成真人及完整财务业务验收。实现进度见[本批记录](../project-control/FINANCE_RECEIPT_PROGRESS_20261021.md)。

新能力扩展[财务原提交](finance-original-requests.md)，原操作、金额算法、十二类真实owner与0157事实约束保持。

## 查询入口

- `GET /v1/finance/commands?view=recorded`：本人的所有成功命令，包含已确认或已清原文；默认active仍只查未确认原提交。沿原kind/targetId/before继续分页。
- `GET /v1/finance/commands/:id/result`：独立读取这次实际执行保存的结果头、固定凭据、完整明细数量与当前核验说明。
- `GET /v1/finance/commands/:id/result/entries?section=...&limit=25&cursor=...`：六类明细中的一页；默认25，最多100，严格游标与实际锚点核对。

所有GET均private/no-store，由当前成员的FinanceRead或该操作权限及tenant范围授权。路径只接受commandId；同事务验证本人成功命令和自动proof的command/actor/tenant/kind/key/target/result/checksum，不允许任意ledger ID作为结果入口。本人窄读不提升为普通ledger能力。查询独立于Vault、原文解密和留存任务，确认或清文后仍按原业务结果读取。

## 原保存值和当前事实

更正使用原事件balanceAfter；账单、付款、核销和释放的原记录没有执行时完整余额，明确not_saved，不拿当前余额补齐。释放可显示原核销的金额与币种，不将今天released状态混成原执行字段。指标名称沿固定版本requestIdentity，不读取今天名称。

利润保存金额、状态、诊断与原贡献按原run读取；原breakdowns未保存，头部不重新生成。当前原owner证据核验单列，与原保存的complete、金额和checksum分开。批准版本的规则、来源、完整shares、权重、零份额、尾差及target快照来自原preview；当前来源、规则、目标变化只进入currentVerification，不替换旧数值。归属run保留原versionPins、金额、诊断和原slices。

## 分页与边界

事实、贡献、核销、批准来源、批准份额和归属行按原结果分页。批准份额携0基sourceIndex/shareIndex、原来源头和原share；与来源页互相独立。游标绑定tenant/user/command/result/section/limit及真实上页锚点，不用页内求和替代完整财务总额。页面只有读满服务端total且无后页，才能标为完整；缺页、失权、失败或迟到响应保留明确状态并禁止继续冒称全量。

共享契约为`@yummyai/contracts/finance/finance-command-result`，根响应最多8MiB、页最多4MiB，超限拒绝，不裁剪字段或行。当前版本不新增数据库事实或回填历史。

专用验收命令为`run-order-daily-acceptance.mts --suite=finance-command-result-integration`与`--suite=finance-command-result-browser --compiled-web --candidate=<id>`。独立标记E2E_FINANCE_COMMAND_RESULT_ISOLATED在连接前校验，只用一次性同nonce DB/私有桶/Redis与个人身份3130/8130，结束后独立核对并清理本批数据和文件。不得借此重试普通Web的自动审批拒绝。

大报表核验的三处连接查询仅取来源身份、校验值等元数据；原sourceInput保持原样，不逐贡献重复传输。独立明细的成功数据先提交，再释放读取状态；CSS入场与用户翻页过渡保留，动画不再决定数据是否显示。
