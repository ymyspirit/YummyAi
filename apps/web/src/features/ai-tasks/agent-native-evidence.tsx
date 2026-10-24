"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CheckCheck, ChevronLeft, ChevronRight, FileSearch, ListChecks } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import {
  AGENT_NATIVE_CLEAR_EVENT, AgentNativePreparationIntentSchema,
  type AgentNativeBinding, type AgentNativeView, type AgentNativeObservation, type AgentNativeItemReceipt, type AgentNativePreparationIntent,
} from "@yummyai/contracts/ai/agent-native";
import { useErpAccess } from "../identity/erp-access";
import { AgentLoopCostEvidence, agentLoopStatusLabels } from "./agent-loop-evidence";
import { AgentToolReadResult } from "./agent-tool-read-result";
import { AgentToolDefinitionView } from "./agent-tool-browser";
import { ModelDraft } from "./agent-plan-items";
import { agentOperationName } from "./agent-operation-summary";
import { AgentNativeRequestError, agentNativeReadDenied, prepareAgentNativeItem, readAgentNativeItemReceipt } from "./agent-native-client";
import { readAgentNativePreparationIntents, saveAgentNativePreparationIntent, updateAgentNativePreparationIntent, useAgentNativeIntents } from "./agent-native-intent";

export const agentNativeToolLabels = { "orders.exceptions.page": "订单异常", "inventory.balances.page": "库存余额", "knowledge.search": "知识检索", "creative.history": "创意执行进度", "factory.capacity": "工厂产能" };
export const agentNativeStatusLabels: Record<AgentNativeView["status"], string> = { ...agentLoopStatusLabels, completed: "原生工具模型阶段已完成", partial: "原生工具模型阶段部分完成" };
const phases = { preparing: "准备中", submitted: "已提交 等待原响应", response_ready: "已收到原响应", completed: "本步已完成", failed: "本步失败", uncertain: "本步提交结果不确定" };
const blocks = { missing_information: "提案缺少必要资料", permission_denied: "当前原领域权限不足", plan_stopped: "原任务已请求停止", input_unavailable: "原提案正文不可完整读取", expired: "原提案已到期", read_sources_changed: "原读取来源已变化 不替换为今天的依据", planning_incomplete: "模型阶段尚未完成" };
const errorText = (failure: unknown) => failure instanceof AgentNativeRequestError ? failure.message : "原准备响应尚未确认 请只读取原回执 不换键或改正文";
function Pair({ label, children }: { label: string; children: ReactNode }) { return <div><dt>{label}</dt><dd>{children}</dd></div>; }
export function AgentNativeBindingSummary({ bindings }: { bindings: AgentNativeBinding[] }) {
  return <section aria-label="原任务固定读取范围"><h4>原任务固定读取范围 · {bindings.length} 个</h4><ol className="an-bindings">{bindings.map((binding, index) => <li key={index}><strong>{index + 1} · {agentNativeToolLabels[binding.tool]}</strong>
    {binding.tool === "orders.exceptions.page" ? <p>异常状态 {{ all: "全部", open: "待处理", resolved: "已解决" }[binding.scope.status]} · 原订单 <code>{binding.scope.orderId ?? "未限定单个订单"}</code></p> :
      binding.tool === "inventory.balances.page" ? <p>原货品 <code>{binding.scope.stockItemId ?? "未限定单个货品"}</code> · 原库位 <code>{binding.scope.locationId ?? "未限定单个库位"}</code></p> :
        binding.tool === "knowledge.search" ? <><p>主题 {binding.scope.topic} · 平台 {binding.scope.platform === "all" ? "通用知识" : binding.scope.platform} · 站点 {binding.scope.market === "ALL" ? "通用站点" : binding.scope.market}</p><p className="al-muted">关键词由模型选择 通用范围不等于跨平台或跨站点全集</p>{binding.scope.spuIds.length > 0 && <p>原产品范围 {binding.scope.spuIds.map(id => <code key={id}>{id} </code>)}</p>}</> :
          binding.tool === "creative.history" ? <p>原对象类型 {{ design_batch: "批量设计", inspection: "PSD 模板检查", mockup_batch: "批量套图", studio_generation: "工作台生成" }[binding.scope.scope]} · <code>{binding.scope.ownerId}</code></p> :
            <><p>原工厂 <code>{binding.scope.factoryId}</code> · 当地 {binding.scope.query.from ?? "原服务首次确定的当地起日"} 起 {binding.scope.query.days} 天</p>{binding.scope.query.capabilityVersionId && <p>原能力版本 <code>{binding.scope.query.capabilityVersionId}</code></p>}<p className="al-muted">使用原工厂时区 不按浏览器当地日期换算</p></>}
  </li>)}</ol></section>;
}
export function AgentNativeEvidence({ run, onDenied }: { run: AgentNativeView; onDenied(): void }) {
  const [observationIndex, setObservationIndex] = useState(0);
  const privateNow = run.privateAvailable && Date.parse(run.expiresAt) > Date.now(), selected = Math.min(observationIndex, Math.max(0, run.observations.length - 1));
  return <section className="an-evidence" aria-label="原生工具任务实际依据"><header><h3><ListChecks size={16} />{privateNow ? run.goal : "原生工具任务"}</h3><span className="al-badge" data-state={run.status}>{agentNativeStatusLabels[run.status]}</span></header>
    <AgentLoopCostEvidence cost={run.cost} /><p className="al-muted">模型阶段完成即结算与释放剩余额度 不等待人工 不自动准备或执行业务 MCP 尚未连接</p>
    {!privateNow ? <p role="status" className="al-warning">原目标 对象范围 步骤与来源私文当前不可读取 只保留原标识 状态和费用 不重新启动模型</p> : <>
      {run.contextText && <details><summary>原用户补充资料 未经事实核验</summary><p className="al-prose">{run.contextText}</p></details>}
      <AgentNativeBindingSummary bindings={run.bindings} />
      <section aria-label="原生工具任务步骤"><h4>全部已登记步骤 · {run.steps.length} 步</h4><p className="al-muted">实际工具调用 {run.toolCalls} 次 · 已观察 {run.observedRows} 条 不以观察数推断全量</p>
        <ol className="al-steps">{run.steps.map(step => <li className="al-step" key={step.id} id={"native-step-" + step.id}><header><h4>{step.sequence} · {step.kind === "definition" ? "按需加载所选定义" : step.kind === "model" ? "模型决策" : "读取原业务"}{step.tool ? " · " + agentNativeToolLabels[step.tool] : ""}</h4><span className="al-badge" data-state={step.phase}>{phases[step.phase]}</span></header>
          <p>{step.label || "原步骤未另存说明"}</p><p className="al-muted">{{ not_submitted: "尚未提交", submitted: "已向原执行方提交", received: "已收到原执行方响应" }[step.submissionState]} · {step.createdAt} · {step.completedAt ?? "尚无完成时间"}</p>
          {step.kind === "model" && <p>原输入 token {step.inputTokens ?? "未知"} · 输出 token {step.outputTokens ?? "未知"} · 本步费用 {step.costUsd === null ? "未知" : "USD " + step.costUsd}</p>}
          {step.errorCode && <p className="al-warning">原错误代码 <code>{step.errorCode}</code> 不自动重发本步</p>}
          <details><summary>本步原凭据</summary><dl className="al-pairs"><Pair label="原步骤 ID"><code>{step.id}</code></Pair><Pair label="原输入校验"><code>{step.inputChecksum}</code></Pair><Pair label="原输出校验"><code>{step.outputChecksum ?? "未提供"}</code></Pair><Pair label="提供方原请求"><code>{step.providerRequestId ?? "未记录"}</code></Pair></dl></details>
        </li>)}</ol>{!run.steps.length && <p>尚无已登记步骤 不推断模型已调用或业务资料已读取</p>}
      </section>
      <details><summary>实际按需加载的定义 · {run.definitions.length} 项</summary>{run.definitions.map(evidence => <details key={evidence.stepId}><summary>{evidence.definition.selection.kind === "read" ? agentNativeToolLabels[evidence.definition.selection.tool] : agentOperationName(evidence.definition.selection.command.domain, evidence.definition.selection.command.kind)} · 原定义步骤</summary><a href={"#native-step-" + evidence.stepId}><code>{evidence.stepId}</code></a><div className="agent-tool-browser"><AgentToolDefinitionView definition={evidence.definition} /></div></details>)}{!run.definitions.length && <p>尚无已保存定义 不把目录元数据当作模型已加载的 schema</p>}</details>
      <section aria-label="原生工具任务来源"><h4>已保存的原读取观察 · {run.observations.length} 组</h4>{run.observations.length ? <><label>查看原读取步骤<select aria-label="查看原读取步骤" value={selected} onChange={event => setObservationIndex(Number(event.target.value))}>{run.observations.map((observation, index) => <option key={observation.stepId} value={index}>{index + 1} · {agentNativeToolLabels[observation.tool]} · {observation.observedRows} 条</option>)}</select></label><NativeObservation key={run.observations[selected]!.stepId} observation={run.observations[selected]!} /></> : <p>尚无已保存来源 在途分页只显示原观察计数</p>}</section>
      <section aria-label="原生工具模型结论"><h4><CheckCheck size={15} />模型结论与核对范围</h4><p>{{ pending: "尚未完成来源核对", native_scalar_values_and_current_source_basis_only: "仅核对原生返回的标量值与当前来源依据", not_adopted: "未采用为已核对结论" }[run.verification]}</p>
        <p className="al-warning">来源校验不证明建议正确 数学推理或业务结果仍需复核 原业务操作必须逐项准备并明确确认</p>
        {run.result ? <><p className="al-prose">{run.result.summary}</p><NativeClaims claims={run.result.claims} />{run.result.missingInformation.length > 0 && <><h5>模型列出的整体缺项</h5><ul>{run.result.missingInformation.map((text, index) => <li key={index}>{text}</li>)}</ul></>}</> : <p>尚无保存的模型结论 不从状态或步骤拼造建议</p>}
      </section>
    </>}
    <details><summary>原任务身份与执行边界</summary><dl className="al-pairs"><Pair label="原任务 ID"><code>{run.id}</code></Pair><Pair label="原请求 ID"><code>{run.requestId}</code></Pair><Pair label="原完整请求校验"><code>{run.requestChecksum}</code></Pair><Pair label="原模型">{run.modelLabel}</Pair><Pair label="原修订">{run.revision}</Pair><Pair label="原执行器"><code>{run.executionContract.executorKey}</code></Pair><Pair label="原执行契约"><code>{run.executionContract.checksum}</code></Pair><Pair label="截止时间">{run.deadlineAt}</Pair><Pair label="私文保留至">{run.expiresAt}</Pair><Pair label="模型 / 工具 / 行数上限">{run.limits.maxModelTurns} / {run.limits.maxToolCalls} / {run.limits.maxRows}</Pair></dl></details>
    {run.errorCode && <p className="al-warning">原任务错误代码 <code>{run.errorCode}</code> 请核对原回执 不自动新发付费请求</p>}
    <NativeItems run={run} onDenied={onDenied} />
  </section>;
}
function NativeObservation({ observation }: { observation: AgentNativeObservation }) {
  const [index, setIndex] = useState(0), page = Math.min(index, observation.results.length - 1), result = observation.results[page]!;
  return <section className="an-observation" aria-label={agentNativeToolLabels[observation.tool] + "原读取观察"}>
    <p>原固定范围 {observation.request.bindingIndex + 1} · 已观察 {observation.observedRows} 条 · {observation.collectionComplete === null ? "有界原生结果 不称全量" : observation.collectionComplete ? "该原集合已完整读取" : "该原集合尚未完整读取"}</p>
    {observation.request.keyword && <p>模型本次知识关键词 <span className="al-prose">{observation.request.keyword}</span></p>}
    {observation.truncatedBy && <p className="al-warning">已达到{observation.truncatedBy === "row_limit" ? "本任务行数" : "工具调用"}上限 未读来源不纳入全量结论</p>}
    <p className="al-muted">下方保留各页当时的原生回执 单页计数不替代这次观察的最终完整性</p>
    <div className="al-actions" aria-label="已保存原结果分页"><span>原结果 {page + 1} / {observation.results.length}</span><button type="button" disabled={page === 0} onClick={() => setIndex(value => value - 1)}><ChevronLeft size={14} />上一原结果</button><button type="button" disabled={page + 1 === observation.results.length} onClick={() => setIndex(value => value + 1)}>下一原结果<ChevronRight size={14} /></button></div>
    <div className="agent-tool-browser" id={"native-source-" + observation.stepId + "-" + page}><AgentToolReadResult key={result.callId} result={result} /></div>
    <details><summary>原观察固定依据</summary><dl className="al-pairs"><Pair label="原步骤"><a href={"#native-step-" + observation.stepId}>{observation.stepId}</a></Pair><Pair label="原观察依据校验"><code>{observation.basisChecksum}</code></Pair></dl></details>
  </section>;
}
export function NativeClaims({ claims }: { claims: NonNullable<AgentNativeView["result"]>["claims"] }) {
  return <section aria-label="原生标量来源引用"><h5>原生标量来源引用 · {claims.length} 项</h5>{claims.length ? <ol className="al-claims">{claims.map((claim, index) => <li key={index}><p><code>{claim.path.join(".")}</code> · <span className="al-prose">{claim.value === null ? "原值为空 null" : typeof claim.value === "boolean" ? claim.value ? "是" : "否" : String(claim.value)}</span></p><details><summary>核对原引用依据</summary><dl className="al-pairs"><Pair label="原读取步骤"><a href={"#native-step-" + claim.stepId}>{claim.stepId}</a></Pair><Pair label="原结果位置">{claim.resultIndex + 1}</Pair><Pair label="原结果完整校验"><code>{claim.dataChecksum}</code></Pair></dl></details></li>)}</ol> : <p>没有原生标量引用 不补造数值或业务正确性证明</p>}</section>;
}
function NativeItems({ run, onDenied }: { run: AgentNativeView; onDenied(): void }) {
  const access = useErpAccess(), intents = useAgentNativeIntents(access.preferenceScope);
  return <section className="an-items" aria-label="逐项核对原生工具提案"><h3>逐项保存原准备并核对 · {run.items.length} 项</h3><p className="al-warning">模型提案尚未通过原业务拥有者核验 保存只形成原准备 还须进入原命令逐笔确认执行</p>
    {intents.error && <p className="al-error" role="alert">{intents.error}</p>}<ol className="ap-item-list">{run.items.map(item => <NativeItem key={item.id + ":" + item.proposalChecksum} run={run} item={item} authority={access.authority ?? ""} canRun={access.can(Permission.WorkflowRun)} ownerScope={intents.ownerScope} storageReady={intents.ready} marker={intents.preparations.find(value => value.runId === run.id && value.itemId === item.id)} onDenied={onDenied} />)}</ol>
    {!run.items.length && <p>尚无已登记提案 不根据模型步骤补造操作</p>}
  </section>;
}
function NativeItem({ run, item, authority, canRun, ownerScope, storageReady, marker, onDenied }: { run: AgentNativeView; item: AgentNativeView["items"][number]; authority: string; canRun: boolean; ownerScope: string; storageReady: boolean; marker?: AgentNativePreparationIntent; onDenied(): void }) {
  const router = useRouter(), access = useErpAccess(), stamp = JSON.stringify([authority, run.id, run.requestId, run.revision, item.id, item.proposalChecksum]);
  const current = useRef({ stamp, authority: access.authority }), callback = useRef(onDenied); current.current = { stamp, authority: access.authority }; callback.current = onDenied;
  const alive = useRef(true), cleared = useRef(false), epoch = useRef(0), lock = useRef<symbol | null>(null), controller = useRef<AbortController | null>(null);
  const [receipt, setReceipt] = useState<{ stamp: string; value: AgentNativeItemReceipt } | null>(null), [reading, setReading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState(""), [retry, setRetry] = useState(false);
  const proposal = run.privateAvailable && Date.parse(run.expiresAt) > Date.now() ? run.result?.proposals.find(value => value.id === item.id) : undefined;
  const valid = useCallback((token: number) => alive.current && !cleared.current && token === epoch.current && current.current.stamp === stamp && current.current.authority === authority, [stamp, authority]);
  const load = useCallback(async () => {
    if (!authority || lock.current || cleared.current) return;
    const token = ++epoch.current, abort = new AbortController(); controller.current?.abort(); controller.current = abort; setReading(true); setReceipt(null); setRetry(false); setError("");
    try {
      const value = await readAgentNativeItemReceipt(run, item, authority, abort.signal); if (!valid(token) || abort.signal.aborted) return;
      const saved = ownerScope ? readAgentNativePreparationIntents(ownerScope).find(candidate => candidate.runId === run.id && candidate.itemId === item.id) : undefined;
      if (saved && saved.proposalChecksum !== item.proposalChecksum) throw new AgentNativeRequestError(502, "原恢复标识对应另一份提案 不采用替代正文");
      if (saved && value.disposition === "known" && saved.state !== "known") updateAgentNativePreparationIntent({ ...saved, state: "known" });
      setReceipt({ stamp, value });
    } catch (failure) { if (valid(token) && !abort.signal.aborted) { setError(errorText(failure)); if (agentNativeReadDenied(failure)) callback.current(); } }
    finally { if (valid(token)) setReading(false); }
  }, [run, item, authority, ownerScope, stamp, valid]);
  useLayoutEffect(() => {
    alive.current = true; setReceipt(null); setRetry(false); setPending(false); lock.current = null;
    const clear = () => { cleared.current = true; epoch.current++; controller.current?.abort(); setReceipt(null); setRetry(false); setPending(false); };
    window.addEventListener(AGENT_NATIVE_CLEAR_EVENT, clear);
    return () => { alive.current = false; epoch.current++; controller.current?.abort(); window.removeEventListener(AGENT_NATIVE_CLEAR_EVENT, clear); };
  }, [stamp]);
  useEffect(() => { if (storageReady) void load(); }, [load, storageReady]);
  const result = receipt?.stamp === stamp ? receipt.value : null, knownId = result?.disposition === "known" ? result.agentCommandId : item.preparationState === "known" ? item.agentCommandId : null;
  const hasOriginal = Boolean(proposal?.draft.original), needsRetry = Boolean(marker || item.preparationState === "requested_unknown" || result?.disposition === "unknown");
  const eligible = Boolean(hasOriginal && item.canPrepare && canRun && storageReady && marker?.state !== "known" && result && ["not_requested", "unknown"].includes(result.disposition) && !knownId);
  async function prepare() {
    if (!eligible || lock.current || reading || pending || needsRetry && !retry || !run.privateAvailable || Date.parse(run.expiresAt) <= Date.now()) return;
    const lease = Symbol("native-item"), token = epoch.current; lock.current = lease; setPending(true); setError(""); setRetry(false);
    try {
      const old = readAgentNativePreparationIntents(ownerScope).find(value => value.runId === run.id && value.itemId === item.id);
      const saved = old ?? saveAgentNativePreparationIntent(AgentNativePreparationIntentSchema.parse({ version: 1, ownerScope, runId: run.id, itemId: item.id, proposalChecksum: item.proposalChecksum, state: "prepared", createdAt: new Date().toISOString() }));
      if (saved.proposalChecksum !== item.proposalChecksum || saved.state === "known") throw new AgentNativeRequestError(409, "原准备标识不同或结果已知 请只读核对");
      const frozen = updateAgentNativePreparationIntent({ ...saved, state: "unknown" }); if (!valid(token)) return;
      const value = await prepareAgentNativeItem(run, item, authority); if (!valid(token)) return;
      setReceipt({ stamp, value });
      if (value.disposition === "known") { updateAgentNativePreparationIntent({ ...frozen, state: "known" }); router.push("/ai-tasks?" + new URLSearchParams({ agentCommand: value.agentCommandId! })); }
    } catch (failure) { if (valid(token)) { setReceipt(null); setError(errorText(failure)); if (agentNativeReadDenied(failure)) callback.current(); } }
    finally { if (lock.current === lease) { lock.current = null; if (valid(token)) setPending(false); } }
  }
  return <li className="ap-item" aria-label={"原生工具提案 " + (item.position + 1)}><header><h4>{item.position + 1} · {proposal?.draft.label ?? "原提案正文当前不可读"}</h4><span className="al-badge">{knownId ? "原准备回执已知 尚须核对实际业务状态" : needsRetry ? "原准备结果待核对" : "模型建议 尚未原业务核验"}</span></header>
    <dl className="al-pairs"><Pair label="原提案 ID"><code>{item.id}</code></Pair><Pair label="固定提案校验"><code>{item.proposalChecksum}</code></Pair></dl>
    {proposal && <><h5>{agentOperationName(proposal.draft.capability.domain, proposal.draft.capability.kind)}</h5><p className="al-prose">{proposal.draft.reason}</p><NativeClaims claims={proposal.claimIndexes.map(index => run.result!.claims[index]!)} />
      {proposal.draft.missingInformation.length > 0 && <div className="al-warning"><h5>缺少资料 不能保存原准备</h5><ul>{proposal.draft.missingInformation.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}{proposal.draft.original && <ModelDraft original={proposal.draft.original} />}</>}
    {item.blockReason && <p className="al-warning">{blocks[item.blockReason]}</p>}{reading && <p role="status">正在只读核对这项原准备回执</p>}{pending && <p role="status">正在保存这项原准备 不执行业务</p>}{error && <p className="al-error" role="alert">{error}</p>}
    {result && <p>{{ not_requested: "尚未找到原准备登记 不证明先前请求未提交", unknown: "原准备结果未知 不能视为失败", known: "已取得真实原命令引用 不等于业务已执行", blocked: "当前原准备被阻断 不发起替代提交" }[result.disposition]}</p>}
    {eligible && needsRetry && <label className="ap-retry"><input type="checkbox" checked={retry} disabled={pending || reading} onChange={event => setRetry(event.target.checked)} />已核对同一原提案 使用原键重试准备</label>}
    <div className="al-actions"><button type="button" disabled={reading || pending} onClick={() => void load()}><FileSearch size={14} />读取这项原准备回执</button>{knownId ? <Link href={"/ai-tasks?" + new URLSearchParams({ agentCommand: knownId })}>核对这项原操作<ArrowRight size={14} /></Link> : <button type="button" className="al-primary" disabled={!eligible || reading || pending || needsRetry && !retry} onClick={() => void prepare()}>{needsRetry ? "使用原键重试准备" : "保存这项原准备并核对"}</button>}</div>
    {!canRun && <p className="al-muted">当前只能读取原提案与回执 没有工作流运行权限</p>}
  </li>;
}
