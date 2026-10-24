# Agent 运行前只读诊断

版本：erp.agent.readiness.v1，PRD 1.1.110，2026-10-23。本片已通过定向技术验证并采用到本机日用183；完整平台及真实模型、业务验收仍未完成。

## 问题与复用

日用183的原账户可以打开AI任务与原业务读取，但原生任务模型列表为空。现有workspace的canStart只合并运行权限、合格模型和原工具或命令；并未检查预算占额、未知费用、任务并发、模型提供方或消费者在线情况。因而统一的“核对模型 额度与原运行权限”提示不能作为具体故障诊断。

本批采用后，原账户可独立读取原有四个文本模型，实际诊断显示缺输入或输出报价、缺正数单任务费用上限。已有配置和密钥域保留，未代填价格、启用消费者或探测模型。配置可读不证明提供方连通或付费执行成功。

沿用已有开源Next.js、Nest、Zod、PostgreSQL/RLS及原五种Agent owner，不引入新Agent框架。独立版本的只读诊断接口不改变旧loop/plan/native v1/v2/v3 workspace、任务、意图、回执或执行ABI。

## 接口与权限

GET /v1/ai/agent-readiness/:family，BFF为GET /api/agent-readiness/:family。family固定为loop、plan、native_v1、native_v2、native_v3。拒绝额外路径、查询参数和所有业务POST。

调用者必须具有当前WorkflowRead，当前membership与既有凭据ceiling相交。先读取原owner workspace，再在新的租户事务中重读membership并核对authority；BFF亦须在返回前重新核对本人身份。请求、响应header及DTO的contextAuthority和family精确一致。权限变化不得返回旧私有结果。

诊断仅返回固定阻断码、检查结果、当前模型配置权限和时间，不返回凭据、端点、其他用户任务或组织费用总额。没有WorkflowRun时报告缺运行权，组织预算及并发标为not_checked。配置入口仍由ModelConfigure原权限保护。

## 诊断语义

模型诊断区分没有配置、停用、供应商/路由结构不支持、缺输入输出报价及缺正单任务上限。合格模型仍按原owner规则计算，不能借用诊断扩大模型范围。

原能力沿对应owner：loop为两类只读工具，plan为原命令，native v1为五类工具，v2再含六类资源，v3再含履约工具。目录可用不等于某个对象可读，更不等于已检索知识或已固定来源。

有运行权时沿原admission读取预算策略、UTC当月reserved/committed账本、原未知费用规则及三表未过期活动任务。loop使用erp_agent/default任务上限；plan和native使用erp_agent_plan与erp_agent/default的较小值；无策略时保持原100美元默认门。金额按整数微美元计算。

接口没有具体modelId和maxCostUsd，因此只判断是否连最小0.000001美元预留都不可能、月度费用是否未知或并发是否已满。no_known_blocker只表示此时没有这些已知阻断，不表示具体请求预算会通过。具体请求金额、所选来源、提供方连通及消费者在线始终列为未检查；提交仍须原start重新鉴权、核模型、锁定和预留。

读取不解密渠道凭据、不探测提供方、不调用模型、不预留、不入队、不写业务，也不自动重发未知请求。旧任务和回执继续沿原读取路径恢复。

## 界面与配置入口

在现有五类任务面板展示同一诊断组件，authority/family变化时清除旧结果，取消未完成读取。检查失败显示读取失败，不能推导额度不足或改为可启动。固定阻断码映射为可理解原因；有原配置权的模型问题链接到/settings/ai#analysis-model-settings。

复用原AnalysisModelSettings，费用设置区独立于画布iframe的settings.view事件可展开。画布、渠道和默认模型入口保留；原runtime离线时明确说明受影响范围。完全没有已启用渠道仍属显式缺项，不虚构渠道或价格，不自动启动整个画布runtime。

## 验收与剩余项

使用专属一次性DB、私有桶和Redis，检查真实membership、模型配置、原预算与并发阻断，以及诊断零预留/零派发/零模型。增加契约、BFF和同编译个人页面定向检查；验证1440及390宽度、读取失败及原回执读取入口。新Vitest使用--no-cache。验后删除本批临时输出和隔离资源，保留源码、简明结论和清理记录，885既有冻结路径不重试。

本片属于B09/B28/B50的执行透明度，不完成B21店铺授权/节点/发布、真实模型质量与账单、MCP诊断接入或完整平台验收。原183日用进程、1036积压任务、真实私有文件及既有备份保持。

本片的[交付结论](../project-control/checkpoints/2026-10-23-agent-readiness-f4b6d2a9-evidence.json)、[同候选页面验收](../project-control/checkpoints/2026-10-23-agent-readiness-f4b6d2a9-browser-result.json)及[清理后独立复核](../project-control/checkpoints/2026-10-23-agent-readiness-f4b6d2a9-resources-after-cleanup.json)保留。原始截图、日志、未采用候选和六份临时资源清单已删除，885历史冻结路径及旧合成历史不在本批清理范围内。
