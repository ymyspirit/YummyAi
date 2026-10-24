"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Plus, Trash2, ArrowRight, CheckCheck, ChevronLeft, ChevronRight, FileSearch, ListChecks } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentResourceKeySchema } from "@yummyai/contracts/ai/agent-resources";
import { KNOWLEDGE_TOPICS, type KnowledgeSearch } from "@yummyai/contracts/knowledge";
import { useErpAccess } from "../identity/erp-access";
import { AgentToolObjectPicker, type AgentToolCreativeScope } from "./agent-tool-object-picker";
import { AgentResourceInputs } from "./agent-resource-inputs";
import { AgentLoopCostEvidence, agentLoopStatusLabels } from "./agent-loop-evidence";
import { AgentResourceReadResult } from "./agent-resource-result";
import { AgentToolReadResult } from "./agent-tool-read-result";
import { AgentToolDefinitionView } from "./agent-tool-browser";
import { AgentFulfillmentBinding } from "./agent-fulfillment-binding";
import { AgentFulfillmentEvidence } from "./agent-fulfillment-evidence";
import { AgentFulfillmentDefinitionView } from "./agent-fulfillment-context";
import { agentFulfillmentKindLabels } from "./agent-fulfillment-client";
import { ModelDraft } from "./agent-plan-items";
import { agentOperationName } from "./agent-operation-summary";
import { nativeTaskErrorText, type NativeTaskAdapter, type NativeTaskBinding, type NativeTaskWorkspace, type NativeTaskView, type NativeTaskObservation, type NativeTaskDefinitionEvidence, type NativeTaskItemReceipt, type NativeTaskPreparationIntent } from "./agent-native-task-adapter";
import type { LegacyNativeTaskView } from "./agent-native-task-adapter";
import { AgentNativeV4Proposals } from "./agent-native-v4-proposals";

const stepPrefix = (adapter: NativeTaskAdapter) => adapter.urlKey === "agentNativeV2" ? "native-v2" : adapter.urlKey === "agentNativeV4" ? "native-v4" : "native-v3";
export function nativeTaskReadChoices(workspace: NativeTaskWorkspace) {
  const common = [...workspace.toolWorkspace.tools, ...workspace.resourceWorkspace.tools];
  return workspace.version === "erp-agent-native-v3" || workspace.version === "erp-agent-native-v4" ? [...common, { key: "orders.fulfillment" as const, available: workspace.fulfillmentWorkspace.definition.available, blockReason: workspace.fulfillmentWorkspace.definition.blockReason }] : common;
}
export const nativeTaskReadLabels: Record<NativeTaskBinding["tool"], string> = {
  "orders.exceptions.page": "订单异常", "inventory.balances.page": "库存余额", "knowledge.search": "知识检索",
  "creative.history": "创意执行进度", "factory.capacity": "工厂产能", "research.evidence": "研究原捕获",
  "catalog.sku": "SKU 与配方", "listing.version": "刊登原版本", "orders.order": "订单原版本",
  "finance.profit_run": "财务原计算", "advertising.analysis": "广告原分析", "orders.fulfillment": "本单履约",
};

export function NativeTaskBindingSummary({ bindings, onRemove, disabled = false, removing = null, adapter }: {
  adapter: NativeTaskAdapter; bindings: readonly NativeTaskBinding[]; onRemove?(index: number): void; disabled?: boolean; removing?: string | null;
}) {
  return <section className="anv2-bindings" aria-label={adapter.text("十一类任务固定读取范围")}><h4>固定读取范围 · {bindings.length} / 16</h4>
    <ol>{bindings.map((binding, index) => <li key={canonicalJson(binding)} data-exiting={removing === canonicalJson(binding)} inert={removing === canonicalJson(binding)}><header><strong>{index + 1} · {nativeTaskReadLabels[binding.tool]}</strong>
      {onRemove && <button type="button" aria-label={"移除固定读取范围 " + (index + 1)} disabled={disabled} onClick={() => onRemove(index)}><Trash2 size={13} />移除</button>}</header><BindingFields binding={binding} /></li>)}</ol>
    {!bindings.length && <p className="al-muted">尚未加入读取范围 请先选择工具和真实对象 不通过自由填写 UUID 建立业务依据</p>}
  </section>;
}

function BindingFields({ binding }: { binding: NativeTaskBinding }) {
  switch (binding.tool) {
    case "orders.exceptions.page": return <p>异常状态 {{ all: "全部", open: "待处理", resolved: "已解决" }[binding.scope.status]} · 原订单 <code>{binding.scope.orderId ?? "未限定单个订单"}</code></p>;
    case "inventory.balances.page": return <p>原货品 <code>{binding.scope.stockItemId ?? "未限定单个货品"}</code> · 原库位 <code>{binding.scope.locationId ?? "未限定单个库位"}</code></p>;
    case "knowledge.search": return <><p>主题 {binding.scope.topic} · 平台 {binding.scope.platform === "all" ? "通用知识" : binding.scope.platform} · 站点 {binding.scope.market === "ALL" ? "通用站点" : binding.scope.market}</p><p className="al-muted">关键词由模型选择 通用资料不等于跨平台全集</p>{binding.scope.spuIds.length > 0 && <p>原产品范围 {binding.scope.spuIds.map(id => <code key={id}>{id} </code>)}</p>}</>;
    case "creative.history": return <p>原对象类型 {{ design_batch: "批量设计", inspection: "PSD 模板检查", mockup_batch: "批量套图", studio_generation: "工作台生成" }[binding.scope.scope]} · <code>{binding.scope.ownerId}</code></p>;
    case "factory.capacity": return <><p>原工厂 <code>{binding.scope.factoryId}</code> · 当地 {binding.scope.query.from ?? "原服务首次确定的当地起日"} 起 {binding.scope.query.days} 天</p>{binding.scope.query.capabilityVersionId && <p>原能力版本 <code>{binding.scope.query.capabilityVersionId}</code></p>}<p className="al-muted">工厂当地日期窗口 本次读取不预留产能</p></>;
    case "research.evidence": return <><p>原研究对象 <code>{binding.scope.researchItemId}</code> · 捕获版本 <code>{binding.scope.snapshotId}</code></p><p>{binding.scope.studyRevisionId ? <>原研究结论版本 <code>{binding.scope.studyRevisionId}</code></> : "未选择研究结论 只读取原捕获快照"}</p></>;
    case "catalog.sku": return <><p>原 SKU <code>{binding.scope.skuId}</code></p><p>{binding.scope.recipeId ? <>明确固定的配方 <code>{binding.scope.recipeId}</code></> : "配方未固定为某个版本 采用实际读取时的原当前配方"}</p></>;
    case "listing.version": return <p>原刊登 <code>{binding.scope.listingId}</code> · 原版本 <code>{binding.scope.versionId}</code></p>;
    case "orders.fulfillment": return <p>原订单 <code>{binding.scope.orderId}</code> · 固定事件修订 {binding.scope.expectedSequence} · 原{agentFulfillmentKindLabels[binding.scope.kind]}来源</p>;
    case "orders.order": return <p>原订单 <code>{binding.scope.orderId}</code> · 固定事件修订 {binding.scope.expectedSequence}</p>;
    case "finance.profit_run": return <p>原利润计算 <code>{binding.scope.runId}</code> · 不重新计算 不按当前分页贡献拼总额</p>;
    case "advertising.analysis": return <p>原广告账户 <code>{binding.scope.accountId}</code> · 原分析 <code>{binding.scope.analysisId}</code> · 不重新运行分析</p>;
  }
}

export function NativeTaskBindings({ workspace, authority, value, disabled, onChange, onDenied, onPendingChange, adapter }: {
  adapter: NativeTaskAdapter; workspace: NativeTaskWorkspace; authority: string; value: NativeTaskBinding[]; disabled: boolean;
  onChange(value: NativeTaskBinding[]): void; onDenied(): void; onPendingChange(pending: boolean): void;
}) {
  const [tool, setTool] = useState<NativeTaskBinding["tool"] | "">(""), [editor, setEditor] = useState(0);
  const [draft, setDraft] = useState<NativeTaskBinding | null>(null), [error, setError] = useState("");
  const [removing, setRemoving] = useState<string | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); onPendingChange(false); }, [onPendingChange]);
  const choices = nativeTaskReadChoices(workspace);
  const selected = choices.find(item => item.key === tool), blocked = disabled || removing !== null, enabled = !blocked && Boolean(selected?.available);
  function remove(index: number) {
    if (blocked || !value[index]) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { onChange(value.filter((_, position) => position !== index)); return; }
    onPendingChange(true); setRemoving(canonicalJson(value[index]));
    timer.current = setTimeout(() => { onChange(value.filter((_, position) => position !== index)); setRemoving(null); timer.current = null; onPendingChange(false); }, 120);
  }
  function add() {
    if (!enabled || !draft || value.length >= 16) return;
    const parsed = adapter.bindingSchema.safeParse(draft);
    if (!parsed.success || parsed.data.tool !== tool) { setError("原范围尚不完整 请从真实候选选择所需对象与版本"); return; }
    if (value.some(item => canonicalJson(item) === canonicalJson(parsed.data))) { setError("这份完整固定范围已经加入 不重复添加相同范围"); return; }
    onChange([...value, parsed.data]); setDraft(null); if (tool !== "orders.fulfillment") setEditor(index => index + 1); setError("");
  }
  return <section className="anv2-binding-editor" aria-label={adapter.text("配置十一类原读取范围")}>
    <NativeTaskBindingSummary adapter={adapter} bindings={value} disabled={blocked} removing={removing} onRemove={remove} />
    <label>选择本次读取工具<select aria-label="选择本次读取工具" disabled={blocked || value.length >= 16} value={tool} onChange={event => { setTool(event.target.value as NativeTaskBinding["tool"] | ""); setDraft(null); setError(""); setEditor(index => index + 1); }}><option value="">选择一项再确定原对象与范围</option>{choices.map(item => <option key={item.key} value={item.key} disabled={!item.available}>{nativeTaskReadLabels[item.key]}{!item.available ? " · 当前不可读取" : ""}</option>)}</select></label>
    {selected && !selected.available && <p className="al-warning">当前原领域不允许读取 {selected.blockReason ?? "请重新核对原拥有者权限"}</p>}
    {tool && <fieldset className="anv2-binding-fields" disabled={!enabled || value.length >= 16}><legend>{nativeTaskReadLabels[tool]} · 加入前核对实际范围</legend>
      <BindingEditor adapter={adapter} workspace={workspace} key={tool + ":" + editor} tool={tool} authority={authority} enabled={enabled} onChange={setDraft} onDenied={onDenied} />
      <button type="button" disabled={!enabled || !draft || value.length >= 16} onClick={add}><Plus size={14} />加入本次固定读取范围</button>
    </fieldset>}
    {error && <p className="al-error" role="alert">{error}</p>}
    <p className="al-muted">最多 16 个固定范围 可为同一工具选择多个真实对象 只允许模型读取已加入的范围 候选列表的有界范围不等于全部历史</p>
  </section>;
}

function BindingEditor({ tool, authority, enabled, onChange, onDenied, adapter, workspace }: {
  adapter: NativeTaskAdapter; workspace: NativeTaskWorkspace; tool: NativeTaskBinding["tool"]; authority: string; enabled: boolean;
  onChange(binding: NativeTaskBinding | null): void; onDenied(): void;
}) {
  if (tool === "orders.fulfillment") return workspace.version === "erp-agent-native-v3" || workspace.version === "erp-agent-native-v4" ? <AgentFulfillmentBinding workspace={workspace.fulfillmentWorkspace} authority={authority} enabled={enabled} onChange={onChange} onDenied={onDenied} /> : null;
  const resource = AgentResourceKeySchema.safeParse(tool);
  if (resource.success) return <div className="agent-resource-browser anv2-resource"><AgentResourceInputs tool={resource.data} authority={authority} enabled={enabled} result={null} onChange={scope => {
    const parsed = scope === null ? null : adapter.bindingSchema.safeParse({ tool, scope }); onChange(parsed?.success ? parsed.data : null);
  }} onDenied={onDenied} /></div>;
  return <LegacyBindingEditor adapter={adapter} tool={tool} authority={authority} enabled={enabled} onChange={onChange} onDenied={onDenied} />;
}

function LegacyBindingEditor({ tool, authority, enabled, onChange, onDenied, adapter }: {
  adapter: NativeTaskAdapter; tool: NativeTaskBinding["tool"]; authority: string; enabled: boolean;
  onChange(binding: NativeTaskBinding | null): void; onDenied(): void;
}) {
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [topic, setTopic] = useState<KnowledgeSearch["topic"]>("all"), [platform, setPlatform] = useState<KnowledgeSearch["platform"]>("all"), [market, setMarket] = useState("ALL");
  const [creativeScope, setCreativeScope] = useState<AgentToolCreativeScope>("design_batch"), [ownerId, setOwnerId] = useState("");
  const [factoryId, setFactoryId] = useState(""), [from, setFrom] = useState(""), [days, setDays] = useState("14");
  function emit(scope: unknown) { const parsed = adapter.bindingSchema.safeParse({ tool, scope }); onChange(parsed.success ? parsed.data : null); }
  switch (tool) {
    case "orders.exceptions.page": return <><label>原订单异常范围<select aria-label="原订单异常范围" value={status} onChange={event => { const next = event.target.value as typeof status; setStatus(next); onChange(null); }}><option value="open">当前受权租户待处理异常</option><option value="resolved">当前受权租户已解决异常</option><option value="all">当前受权租户全部异常状态</option></select></label><button type="button" onClick={() => emit({ status })}>确定原订单异常范围</button></>;
    case "inventory.balances.page": return <><p>使用原服务当前受权库存集合 不手填货品或库位 ID 由服务端串行核对页链和完整性</p><button type="button" onClick={() => emit({})}>确定原库存读取范围</button></>;
    case "knowledge.search": return <><div className="al-fields"><label>知识主题<select aria-label="知识主题" value={topic} onChange={event => { setTopic(event.target.value as typeof topic); onChange(null); }}><option value="all">全部主题</option>{Object.entries(KNOWLEDGE_TOPICS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label>知识平台<select aria-label="知识平台" value={platform} onChange={event => { setPlatform(event.target.value as typeof platform); onChange(null); }}><option value="all">通用知识</option><option value="amazon">Amazon</option><option value="etsy">Etsy</option></select></label><label>知识站点<input aria-label="知识站点" pattern="ALL|[A-Z]{2}" value={market} onChange={event => { setMarket(event.target.value.toUpperCase()); onChange(null); }} /></label></div><p className="al-muted">关键词由模型选择 通用知识和 ALL 仅匹配原通用资料 不等于跨平台全集 知识匹配有界 不称全库已读</p><button type="button" onClick={() => emit({ topic, platform, market, spuIds: [] })}>确定原知识范围</button></>;
    case "creative.history": return <><label>创意执行范围<select aria-label="创意执行范围" value={creativeScope} onChange={event => { setCreativeScope(event.target.value as AgentToolCreativeScope); setOwnerId(""); onChange(null); }}><option value="design_batch">批量设计</option><option value="inspection">PSD 模板检查</option><option value="mockup_batch">批量套图</option></select></label><div className="agent-tool-browser anv2-native"><AgentToolObjectPicker key={creativeScope} kind="creative" scope={creativeScope} authority={authority} value={ownerId} enabled={enabled} disabled={!enabled} onChange={id => { setOwnerId(id); emit({ scope: creativeScope, ownerId: id }); }} onDenied={onDenied} /></div><p className="al-muted">只选原拥有者返回的近期有界对象 工作台生成任务仍从原创作项目读取 不以项目 ID 代替任务 ID</p></>;
    case "factory.capacity": return <><div className="agent-tool-browser anv2-native"><AgentToolObjectPicker kind="factory" authority={authority} value={factoryId} enabled={enabled} disabled={!enabled} onChange={id => { setFactoryId(id); onChange(null); }} onDenied={onDenied} /></div><div className="al-fields"><label>工厂当地起始日期<input type="date" aria-label="工厂当地起始日期" value={from} onChange={event => { setFrom(event.target.value); onChange(null); }} /></label><label>产能读取天数<input type="number" min={1} max={31} step={1} aria-label="产能读取天数" value={days} onChange={event => { setDays(event.target.value); onChange(null); }} /></label></div><p className="al-muted">按所选工厂时区明确填写日期 不自动采用浏览器今天 本次读取不预留或释放产能</p><button type="button" disabled={!factoryId || !from || !/^\d+$/.test(days)} onClick={() => emit({ factoryId, query: { from, days: Number(days) } })}>确定原工厂日期窗口</button></>;
    default: return null;
  }
}

export const nativeTaskStatusLabels: Record<NativeTaskView["status"], string> = { ...agentLoopStatusLabels, completed: "原生工具模型阶段已完成", partial: "原生工具模型阶段部分完成" };
const phases = { preparing: "准备中", submitted: "已提交 等待原响应", response_ready: "已收到原响应", completed: "本步已完成", failed: "本步失败", uncertain: "本步提交结果不确定" };
const blocks = { missing_information: "提案缺少必要资料", permission_denied: "当前原领域权限不足", plan_stopped: "原任务已请求停止", input_unavailable: "原提案正文不可完整读取", expired: "原提案已到期", read_sources_changed: "原读取来源已变化 不替换为今天的依据", planning_incomplete: "模型阶段尚未完成" };
const errorText = nativeTaskErrorText;
function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
export function NativeTaskEvidence({ run, onDenied, adapter }: { run: NativeTaskView; onDenied(): void; adapter: NativeTaskAdapter }) {
  const [observationIndex, setObservationIndex] = useState(0);
  const privateNow = run.privateAvailable && Date.parse(run.expiresAt) > Date.now(), selected = Math.min(observationIndex, Math.max(0, run.observations.length - 1));
  return <section className="an-evidence" aria-label={adapter.text("十一类工具任务实际依据")}><header><h3><ListChecks size={16} />{privateNow ? run.goal : "原生工具任务"}</h3><span className="al-badge" data-state={run.status}>{nativeTaskStatusLabels[run.status]}</span></header>
    <AgentLoopCostEvidence cost={run.cost} /><p className="al-muted">模型阶段完成即结算与释放剩余额度 不等待人工 不自动准备或执行业务 连接状态按实际宿主另行核验</p>
    {!privateNow ? <p role="status" className="al-warning">原目标 对象范围 步骤与来源私文当前不可读取 只保留原标识 状态和费用 不重新启动模型</p> : <>
      {run.contextText && <details><summary>原用户补充资料 未经事实核验</summary><p className="al-prose">{run.contextText}</p></details>}
      <NativeTaskBindingSummary adapter={adapter} bindings={run.bindings} />
      <details className="anv2-steps"><summary>全部已登记步骤 · {run.steps.length} 步</summary><p className="al-muted">证据工具及结案复查 {run.toolCalls} 次 · 已观察 {run.observedRows} 条 不以观察数推断全量</p>
        <p className="al-muted">每轮提交前另核对已读对象的当前访问权 这些检查有额外查询开销 不形成新证据 不额外调用模型</p>
        <ol className="al-steps">{run.steps.map(step => <li className="al-step" key={step.id} id={(stepPrefix(adapter) + "-step-") + step.id}><header><h4>{step.sequence} · {step.kind === "definition" ? "按需加载所选定义" : step.kind === "model" ? "模型决策" : "读取原业务"}{step.tool ? " · " + nativeTaskReadLabels[step.tool] : ""}</h4><span className="al-badge" data-state={step.phase}>{phases[step.phase]}</span></header>
          <p>{step.label || "原步骤未另存说明"}</p><p className="al-muted">{{ not_submitted: "尚未提交", submitted: "已向原执行方提交", received: "已收到原执行方响应" }[step.submissionState]} · {step.createdAt} · {step.completedAt ?? "尚无完成时间"}</p>
          {step.kind === "model" && <p>原输入 token {step.inputTokens ?? "未知"} · 输出 token {step.outputTokens ?? "未知"} · 本步费用 {step.costUsd === null ? "未知" : "USD " + step.costUsd}</p>}
          {step.errorCode && <p className="al-warning">原错误代码 <code>{step.errorCode}</code> 不自动重发本步</p>}
          <details><summary>本步原凭据</summary><dl className="al-pairs"><Pair label="原步骤 ID"><code>{step.id}</code></Pair><Pair label="原输入校验"><code>{step.inputChecksum}</code></Pair><Pair label="原输出校验"><code>{step.outputChecksum ?? "未提供"}</code></Pair><Pair label="提供方原请求"><code>{step.providerRequestId ?? "未记录"}</code></Pair></dl></details>
        </li>)}</ol>{!run.steps.length && <p>尚无已登记步骤 不推断模型已调用或业务资料已读取</p>}
      </details>
      <details><summary>实际按需加载的定义 · {run.definitions.length} 项</summary>{run.definitions.map(evidence => <SavedDefinition adapter={adapter} key={evidence.stepId} evidence={evidence} />)}{!run.definitions.length && <p>尚无已保存定义 不把能力摘要当作模型已加载的 schema</p>}</details>
      <section aria-label={adapter.text("十一类工具任务来源")}><h4>已保存的原读取观察 · {run.observations.length} 组</h4>{run.observations.length ? <><label>{adapter.text("查看十一类原读取步骤")}<select aria-label={adapter.text("查看十一类原读取步骤")} value={selected} onChange={event => setObservationIndex(Number(event.target.value))}>{run.observations.map((observation, index) => <option key={observation.stepId} value={index}>{index + 1} · {nativeTaskReadLabels[observation.tool]} · {observation.observedRows} 条</option>)}</select></label><NativeObservation adapter={adapter} key={run.observations[selected]!.stepId} observation={run.observations[selected]!} /></> : <p>尚无已保存来源 在途分页只显示原观察计数</p>}</section>
      <section aria-label={adapter.text("十一类工具模型结论")}><h4><CheckCheck size={15} />模型结论与核对范围</h4><p>{{ pending: "尚未完成来源核对", native_scalar_values_and_current_source_basis_only: "仅核对原生返回的标量值与当前来源依据", not_adopted: "未采用为已核对结论" }[run.verification]}</p>
        <p className="al-warning">来源校验不证明建议正确 数学推理或业务结果仍需复核 原业务操作必须逐项准备并明确确认</p>
        {run.result ? <><p className="al-prose">{run.result.summary}</p><NativeClaims stepPrefix={stepPrefix(adapter)} claims={run.result.claims} />{run.result.missingInformation.length > 0 && <><h5>模型列出的整体缺项</h5><ul>{run.result.missingInformation.map((text, index) => <li key={index}>{text}</li>)}</ul></>}</> : <p>尚无保存的模型结论 不从状态或步骤拼造建议</p>}
      </section>
    </>}
    <details><summary>原任务身份与执行边界</summary><dl className="al-pairs"><Pair label="原任务 ID"><code>{run.id}</code></Pair><Pair label="原请求 ID"><code>{run.requestId}</code></Pair><Pair label="原完整请求校验"><code>{run.requestChecksum}</code></Pair><Pair label="原模型">{run.modelLabel}</Pair><Pair label="原修订">{run.revision}</Pair><Pair label="原执行器"><code>{run.executionContract.executorKey}</code></Pair><Pair label="原执行契约"><code>{run.executionContract.checksum}</code></Pair><Pair label="截止时间">{run.deadlineAt}</Pair><Pair label="私文保留至">{run.expiresAt}</Pair><Pair label="模型 / 工具 / 行数上限">{run.limits.maxModelTurns} / {run.limits.maxToolCalls} / {run.limits.maxRows}</Pair></dl></details>
    {run.errorCode && <p className="al-warning">原任务错误代码 <code>{run.errorCode}</code> 请核对原回执 不自动新发付费请求</p>}
    {run.version === "erp-agent-native-v4" ? <AgentNativeV4Proposals run={run} onDenied={onDenied} /> : <NativeItems adapter={adapter} run={run} onDenied={onDenied} />}
  </section>;
}
function NativeObservation({ observation, adapter }: { observation: NativeTaskObservation; adapter: NativeTaskAdapter }) {
  const [index, setIndex] = useState(0), page = Math.min(index, observation.results.length - 1), result = observation.results[page]!;
  return <section className="an-observation" aria-label={nativeTaskReadLabels[observation.tool] + "原读取观察"}>
    <p>原固定范围 {observation.request.bindingIndex + 1} · 已观察 {observation.observedRows} 条 · {observation.tool === "orders.fulfillment" && "indexComplete" in observation ? observation.indexComplete ? "本次原索引已读尽 仍非完整业务履约" : "本次原索引尚未读尽 仍非完整业务履约" : observation.collectionComplete === null ? "有界原生结果 不称全量" : observation.collectionComplete ? "该原集合已完整读取" : "该原集合尚未完整读取"}</p>
    {observation.request.keyword && <p>模型本次知识关键词 <span className="al-prose">{observation.request.keyword}</span></p>}
    {observation.truncatedBy && <p className="al-warning">已达到{observation.truncatedBy === "row_limit" ? "本任务行数" : "工具调用"}上限 未读来源不纳入全量结论</p>}
    <p className="al-muted">下方保留各页当时的原生回执 单页计数不替代这次观察的最终完整性</p>
    <div className="al-actions" aria-label="已保存原结果分页"><span>原结果 {page + 1} / {observation.results.length}</span><button type="button" disabled={page === 0} onClick={() => setIndex(value => value - 1)}><ChevronLeft size={14} />上一原结果</button><button type="button" disabled={page + 1 === observation.results.length} onClick={() => setIndex(value => value + 1)}>下一原结果<ChevronRight size={14} /></button></div>
    <p className="al-muted">以下为当时原只读工具的回执 其中不调用模型仅指该次资料读取 本任务模型费用以上方登记为准</p>
    <div className={result.version === "erp-agent-fulfillment-v1" ? "agent-fulfillment native-fulfillment-result" : result.version === "erp-agent-tools-v1" ? "agent-tool-browser anv2-native" : "agent-resource-browser anv2-resource"} id={(stepPrefix(adapter) + "-source-") + observation.stepId + "-" + page}>{result.version === "erp-agent-fulfillment-v1" ? <AgentFulfillmentEvidence key={result.callId} result={result} /> : result.version === "erp-agent-tools-v1" ? <AgentToolReadResult key={result.callId} result={result} /> : <AgentResourceReadResult key={result.callId} result={result} />}</div>
    <details><summary>原观察固定依据</summary><dl className="al-pairs"><Pair label="原步骤"><a href={("#" + stepPrefix(adapter) + "-step-") + observation.stepId}>{observation.stepId}</a></Pair><Pair label="原观察依据校验"><code>{observation.basisChecksum}</code></Pair></dl></details>
  </section>;
}
export function NativeClaims({ claims, stepPrefix = "native-v2" }: { claims: NonNullable<NativeTaskView["result"]>["claims"]; stepPrefix?: string }) {
  return <section aria-label="原生标量来源引用"><h5>原生标量来源引用 · {claims.length} 项</h5>{claims.length ? <ol className="al-claims">{claims.map((claim, index) => <li key={index}><p><code>{claim.path.join(".")}</code> · <span className="al-prose">{claim.value === null ? "原值为空 null" : typeof claim.value === "boolean" ? claim.value ? "是" : "否" : String(claim.value)}</span></p><details><summary>核对原引用依据</summary><dl className="al-pairs"><Pair label="原读取步骤"><a href={("#" + stepPrefix + "-step-") + claim.stepId}>{claim.stepId}</a></Pair><Pair label="原结果位置">{claim.resultIndex + 1}</Pair><Pair label="原结果完整校验"><code>{claim.dataChecksum}</code></Pair></dl></details></li>)}</ol> : <p>没有原生标量引用 不补造数值或业务正确性证明</p>}</section>;
}
function NativeItems({ run, onDenied, adapter }: { run: LegacyNativeTaskView; onDenied(): void; adapter: NativeTaskAdapter }) {
  const access = useErpAccess(), intents = adapter.useIntents(access.preferenceScope);
  return <section className="an-items" aria-label={adapter.text("逐项核对十一类工具提案")}><h3>逐项保存原准备并核对 · {run.items.length} 项</h3><p className="al-warning">模型提案尚未通过原业务拥有者核验 保存只形成原准备 还须进入原命令逐笔确认执行</p>
    {intents.error && <p className="al-error" role="alert">{intents.error}</p>}<ol className="ap-item-list">{run.items.map(item => <NativeItem adapter={adapter} key={item.id + ":" + item.proposalChecksum} run={run} item={item} authority={access.authority ?? ""} canRun={access.can(Permission.WorkflowRun)} ownerScope={intents.ownerScope} storageReady={intents.ready} marker={intents.preparations.find(value => value.runId === run.id && value.itemId === item.id)} onDenied={onDenied} />)}</ol>
    {!run.items.length && <p>尚无已登记提案 不根据模型步骤补造操作</p>}
  </section>;
}
function NativeItem({ run, item, authority, canRun, ownerScope, storageReady, marker, onDenied, adapter }: { adapter: NativeTaskAdapter; run: LegacyNativeTaskView; item: LegacyNativeTaskView["items"][number]; authority: string; canRun: boolean; ownerScope: string; storageReady: boolean; marker?: NativeTaskPreparationIntent; onDenied(): void }) {
  const router = useRouter(), searchParams = useSearchParams(), access = useErpAccess(), stamp = JSON.stringify([authority, run.id, run.requestId, run.revision, item.id, item.proposalChecksum]);
  const current = useRef({ stamp, authority: access.authority }), callback = useRef(onDenied); current.current = { stamp, authority: access.authority }; callback.current = onDenied;
  const alive = useRef(true), cleared = useRef(false), epoch = useRef(0), lock = useRef<symbol | null>(null), controller = useRef<AbortController | null>(null);
  const [receipt, setReceipt] = useState<{ stamp: string; value: NativeTaskItemReceipt } | null>(null), [reading, setReading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(""), [retry, setRetry] = useState(false);
  const proposal = run.privateAvailable && Date.parse(run.expiresAt) > Date.now() ? run.result?.proposals.find(value => value.id === item.id) : undefined;
  const valid = useCallback((token: number) => alive.current && !cleared.current && token === epoch.current && current.current.stamp === stamp && current.current.authority === authority, [stamp, authority]);
  const load = useCallback(async () => {
    if (!authority || lock.current || !valid(epoch.current)) return;
    const token = ++epoch.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort; setReading(true); setReceipt(null); setRetry(false); setError("");
    try {
      const value = await adapter.readItemReceipt(run, item, authority, abort.signal); if (!valid(token) || abort.signal.aborted) return;
      const saved = ownerScope ? adapter.readPreparations(ownerScope).find(candidate => candidate.runId === run.id && candidate.itemId === item.id) : undefined;
      if (saved && saved.proposalChecksum !== item.proposalChecksum) throw new adapter.RequestError(502, "原恢复标识对应另一份提案 不采用替代正文");
      if (saved && value.disposition === "known" && saved.state !== "known") adapter.updatePreparation({ ...saved, state: "known" });
      setReceipt({ stamp, value });
    } catch (failure) { if (valid(token) && !abort.signal.aborted) { setError(errorText(failure)); if (adapter.readDenied(failure)) callback.current(); } }
    finally { if (valid(token)) setReading(false); }
  }, [run, item, authority, ownerScope, stamp, valid, adapter]);
  useLayoutEffect(() => {
    alive.current = true; setReceipt(null); setRetry(false); setPending(false); lock.current = null;
    const clear = () => { cleared.current = true; epoch.current++; controller.current?.abort(); setReceipt(null); setRetry(false); setPending(false); };
    window.addEventListener(adapter.clearEvent, clear);
    return () => { alive.current = false; epoch.current++; controller.current?.abort(); window.removeEventListener(adapter.clearEvent, clear); };
  }, [stamp, adapter.clearEvent]);
  useEffect(() => { if (storageReady) void load(); }, [load, storageReady]);
  const result = receipt?.stamp === stamp ? receipt.value : null, knownId = result?.disposition === "known" ? result.agentCommandId : item.preparationState === "known" ? item.agentCommandId : null;
  const knownQuery = new URLSearchParams(searchParams.toString()); knownQuery.set(adapter.urlKey, run.id); if (knownId) knownQuery.set("agentCommand", knownId);
  const hasOriginal = Boolean(proposal?.draft.original), needsRetry = Boolean(marker || item.preparationState === "requested_unknown" || result?.disposition === "unknown");
  const eligible = Boolean(hasOriginal && item.canPrepare && canRun && storageReady && marker?.state !== "known" && result && ["not_requested", "unknown"].includes(result.disposition) && !knownId);
  async function prepare() {
    if (!eligible || lock.current || !valid(epoch.current) || reading || pending || needsRetry && !retry || !run.privateAvailable || Date.parse(run.expiresAt) <= Date.now()) return;
    const lease = Symbol("native-item"), token = epoch.current; lock.current = lease; setPending(true); setError(""); setRetry(false);
    try {
      const old = adapter.readPreparations(ownerScope).find(value => value.runId === run.id && value.itemId === item.id);
      const saved = old ?? adapter.savePreparation(adapter.preparationSchema.parse({ version: 1, ownerScope, runId: run.id, itemId: item.id, proposalChecksum: item.proposalChecksum, state: "prepared", createdAt: new Date().toISOString() }));
      if (saved.proposalChecksum !== item.proposalChecksum || saved.state === "known") throw new adapter.RequestError(409, "原准备标识不同或结果已知 请只读核对");
      const frozen = adapter.updatePreparation({ ...saved, state: "unknown" }); if (!valid(token)) return;
      const value = await adapter.prepareItem(run, item, authority); if (!valid(token)) return;
      setReceipt({ stamp, value });
      if (value.disposition === "known") { adapter.updatePreparation({ ...frozen, state: "known" }); const url = new URL(window.location.href); url.searchParams.set("agentCommand", value.agentCommandId!); router.push(url.pathname + url.search + url.hash); }
    } catch (failure) { if (valid(token)) { setReceipt(null); setError(errorText(failure)); if (adapter.readDenied(failure)) callback.current(); } }
    finally { if (lock.current === lease) { lock.current = null; if (valid(token)) setPending(false); } }
  }
  return <li className="ap-item" aria-label={adapter.text("十一类工具提案 ") + (item.position + 1)}><header><h4>{item.position + 1} · {proposal?.draft.label ?? "原提案正文当前不可读"}</h4><span className="al-badge">{knownId ? "原准备回执已知 尚须核对实际业务状态" : needsRetry ? "原准备结果待核对" : "模型建议 尚未原业务核验"}</span></header>
    <dl className="al-pairs"><Pair label="原提案 ID"><code>{item.id}</code></Pair><Pair label="固定提案校验"><code>{item.proposalChecksum}</code></Pair></dl>
    {proposal && <><h5>{agentOperationName(proposal.draft.capability.domain, proposal.draft.capability.kind)}</h5><p className="al-prose">{proposal.draft.reason}</p><NativeClaims stepPrefix={stepPrefix(adapter)} claims={proposal.claimIndexes.map(index => run.result!.claims[index]!)} />
      {proposal.draft.missingInformation.length > 0 && <div className="al-warning"><h5>缺少资料 不能保存原准备</h5><ul>{proposal.draft.missingInformation.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}{proposal.draft.original && <ModelDraft original={proposal.draft.original} />}</>}
    {item.blockReason && <p className="al-warning">{blocks[item.blockReason]}</p>}{reading && <p role="status">正在只读核对这项原准备回执</p>}{pending && <p role="status">正在保存这项原准备 不执行业务</p>}{error && <p className="al-error" role="alert">{error}</p>}
    {result && <p>{{ not_requested: "尚未找到原准备登记 不证明先前请求未提交", unknown: "原准备结果未知 不能视为失败", known: "已取得真实原命令引用 不等于业务已执行", blocked: "当前原准备被阻断 不发起替代提交" }[result.disposition]}</p>}
    {eligible && needsRetry && <label className="ap-retry"><input type="checkbox" checked={retry} disabled={pending || reading} onChange={event => setRetry(event.target.checked)} />已核对同一原提案 使用原键重试准备</label>}
    <div className="al-actions"><button type="button" disabled={reading || pending} onClick={() => void load()}><FileSearch size={14} />读取这项原准备回执</button>{knownId ? <Link href={"/ai-tasks?" + knownQuery.toString()}>核对这项原操作<ArrowRight size={14} /></Link> : <button type="button" className="al-primary" disabled={!eligible || reading || pending || needsRetry && !retry} onClick={() => void prepare()}>{needsRetry ? "使用原键重试准备" : "保存这项原准备并核对"}</button>}</div>
    {!canRun && <p className="al-muted">当前只能读取原提案与回执 没有工作流运行权限</p>}
  </li>;
}

function SavedDefinition({ evidence, adapter }: { evidence: NativeTaskDefinitionEvidence; adapter: NativeTaskAdapter }) {
  const definition = evidence.definition, selection = "selection" in definition ? definition.selection : { kind: "read" as const, tool: definition.tool };
  const label = selection.kind === "read" ? nativeTaskReadLabels[selection.tool] : selection.command.domain==="fulfillment" ? "履约建议 · "+selection.command.kind : agentOperationName(selection.command.domain, selection.command.kind);
  return <details><summary>{label} · 原定义步骤</summary><a href={("#" + stepPrefix(adapter) + "-step-") + evidence.stepId}><code>{evidence.stepId}</code></a>{definition.version === "erp-agent-command-definition-v2" ? <section className="anv2-definition" aria-label={label+"已加载建议定义"}><p>原准备协议 <code>{definition.protocol}</code></p><p>仅封存模型建议 仍需本人补项和原操作确认</p><ul>{definition.limitations.map((text,index)=><li key={index}>{text}</li>)}</ul><details><summary>本次可建议输入结构</summary><pre tabIndex={0}>{JSON.stringify(definition.inputSchema,null,2)}</pre></details><p>原定义校验 <code>{definition.definitionChecksum}</code></p></section> : definition.version === "erp-agent-fulfillment-v1" ? <div className="agent-fulfillment"><AgentFulfillmentDefinitionView definition={definition} /></div> : definition.version === "erp-agent-tools-v1" ? <div className="agent-tool-browser anv2-native"><AgentToolDefinitionView definition={definition} /></div> : <section className="anv2-definition" aria-label={label + "已加载严格定义"}><p>原拥有者 {definition.owner} · 只读所选原对象投影</p>{definition.limitations.length > 0 && <ul>{definition.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>}<details><summary>本次加载的完整输入结构</summary><pre tabIndex={0}>{JSON.stringify(definition.inputSchema, null, 2)}</pre></details><details><summary>本次加载的完整返回结构</summary><pre tabIndex={0}>{JSON.stringify(definition.outputSchema, null, 2)}</pre></details><p>原定义校验 <code>{definition.definitionChecksum}</code></p></section>}</details>;
}
