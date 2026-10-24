"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, FileSearch } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import { AGENT_FULFILLMENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { AGENT_NATIVE_V4_CLEAR_EVENT, type AgentNativeV4View, type AgentNativeV4ResolvedProposal, type AgentNativeV4ItemReceipt, type AgentNativeV4PreparationIntent } from "@yummyai/contracts/ai/agent-native-v4";
import type { AgentFulfillmentSuggestion } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { useErpAccess } from "../identity/erp-access";
import { agentOperationName } from "./agent-operation-summary";
import { ModelDraft } from "./agent-plan-items";
import { NativeClaims } from "./agent-native-reader-registry";
import { agentFulfillmentProposalFormHref, agentFulfillmentProposalOperationHref } from "./agent-fulfillment-proposal-handoff";
import { AgentNativeV4RequestError, agentNativeV4ReadDenied, prepareAgentNativeV4Item, readAgentNativeV4ItemReceipt } from "./agent-native-v4-client";
import { readAgentNativeV4PreparationIntents, saveAgentNativeV4PreparationIntent, updateAgentNativeV4PreparationIntent, useAgentNativeV4Intents } from "./agent-native-v4-intent";
import "./agent-native-v4.css";

type Item = AgentNativeV4View["items"][number];
const operationNames: Record<AgentFulfillmentSuggestion["original"]["kind"], string> = {
  delivery_create: "准备原工厂交付包", delivery_feedback: "登记原工厂回执", production_milestone: "记录原生产进度", quality_inspection: "登记原逐项质检",
  quality_group_inspection: "登记原实物分组检验", production_recovery: "安排原生产补做或返工", whole_production_milestone: "记录原整单生产进度",
  whole_quality_inspection: "登记原整单质检", shipment_create: "建立原包裹", whole_shipment_create: "建立原整单包裹", shipment_version: "修订原包裹生产来源",
  shipment_review: "审核原包裹版本", shipment_dispatch: "登记原实际出库", shipment_platform_confirmation: "登记原平台发货确认",
};
const blocks = { missing_information: "提案缺少必要资料", permission_denied: "当前原领域权限不足", plan_stopped: "原任务已请求停止", input_unavailable: "原提案正文不可完整读取",
  expired: "原提案已到期", read_sources_changed: "原读取来源已变化 不用今天的依据替换", planning_incomplete: "模型阶段尚未完成",
  operator_completion_required: "须到原表单补齐 并由本人核对", original_form_unavailable: "这项操作尚无可用的原补项表单" };
const checks = { verified_by_operator: "本人核对原工厂回执", physical_segregation: "本人隔离实物并逐项检验", physical_selection: "本人核对所选原组实物与数量", order_unit_confirmed: "本人核对制造数量与订单单位" };
const failureText = (failure: unknown) => failure instanceof AgentNativeV4RequestError ? failure.message : "原准备结果尚待核对 请只读取原回执 不换编号或改正文重发";

export function AgentNativeV4Proposals({ run, onDenied }: { run: AgentNativeV4View; onDenied(): void }) {
  const access = useErpAccess(), intents = useAgentNativeV4Intents(access.preferenceScope);
  const current = run.contextAuthority === access.authority && access.can(Permission.WorkflowRead) && run.privateAvailable && Date.parse(run.expiresAt) > Date.now();
  return <section className="an4-proposals" aria-label="逐项核对模型业务与履约提案"><h3>逐项核对原提案 · {run.items.length} 项</h3>
    <p className="al-warning">模型只给建议 履约项先到原表单补齐本人核对 再保存原准备 最后在原履约核对区明确执行 不自动勾选或执行</p>
    {intents.error && <p className="al-error" role="alert">{intents.error}</p>}
    <ol className="ap-item-list">{run.items.map(item => <ProposalItem key={[access.authority, run.id, item.id, item.proposalChecksum].join(":")}
      run={run} item={item} proposal={current ? run.result?.proposals.find(value => value.id === item.id) : undefined}
      ownerScope={intents.ownerScope} storageReady={intents.ready} marker={intents.preparations.find(value => value.runId === run.id && value.itemId === item.id)} onDenied={onDenied} />)}</ol>
    {!run.items.length && <p>尚无已登记提案 不从模型步骤补造操作</p>}
  </section>;
}
function ProposalItem({ run, item, proposal, ownerScope, storageReady, marker, onDenied }: {
  run: AgentNativeV4View; item: Item; proposal?: AgentNativeV4ResolvedProposal; ownerScope: string; storageReady: boolean; marker?: AgentNativeV4PreparationIntent; onDenied(): void;
}) {
  const access = useErpAccess(), router = useRouter(), params = useSearchParams(), authority = access.authority ?? "";
  const stamp = JSON.stringify([authority, access.preferenceScope, run.id, run.requestId, run.revision, item.id, item.proposalChecksum]);
  const live = useRef({ stamp, canRead: false, canRun: false });
  live.current = { stamp, canRead: !!authority && access.can(Permission.WorkflowRead), canRun: access.can(Permission.WorkflowRun) };
  const epoch = useRef(0), alive = useRef(true), cleared = useRef(false), lock = useRef<symbol | null>(null), active = useRef<AbortController | null>(null);
  const denied = useRef(onDenied); denied.current = onDenied;
  const [receipt, setReceipt] = useState<{ stamp: string; value: AgentNativeV4ItemReceipt } | null>(null), [reading, setReading] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState("");
  const valid = useCallback((token: number) => alive.current && !cleared.current && live.current.stamp === stamp && token === epoch.current, [stamp]);
  const load = useCallback(async () => {
    if (!authority || !live.current.canRead || lock.current || cleared.current) return;
    const token = ++epoch.current, abort = new AbortController(); active.current?.abort(); active.current = abort; setReceipt(null); setReading(true); setError("");
    try {
      const value = await readAgentNativeV4ItemReceipt(run, item, authority, abort.signal);
      if (!valid(token) || abort.signal.aborted || !live.current.canRead) return;
      const saved = ownerScope ? readAgentNativeV4PreparationIntents(ownerScope).find(value => value.runId === run.id && value.itemId === item.id) : undefined;
      if (saved && saved.proposalChecksum !== item.proposalChecksum) throw new AgentNativeV4RequestError(502, "原标识对应另一份提案 不采用替代内容");
      if (saved && value.disposition === "known") updateAgentNativeV4PreparationIntent({ ...saved, state: "known" });
      setReceipt({ stamp, value });
    } catch (failure) { if (valid(token) && !abort.signal.aborted) { setError(failureText(failure)); if (agentNativeV4ReadDenied(failure)) { setReceipt(null); denied.current(); } } }
    finally { if (valid(token)) setReading(false); }
  }, [authority, run, item, ownerScope, stamp, valid]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { cleared.current = true; epoch.current++; active.current?.abort(); setReceipt(null); setError(""); setPending(false); };
    window.addEventListener(AGENT_NATIVE_V4_CLEAR_EVENT, clear); window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { alive.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(AGENT_NATIVE_V4_CLEAR_EVENT, clear); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); };
  }, [stamp]);
  useEffect(() => { if (storageReady) void load(); }, [load, storageReady]);
  const result = valid(epoch.current) && receipt?.stamp === stamp ? receipt.value : null;
  const known = result?.disposition === "known" ? result : null;
  const knownProtocol = known?.originalProtocol ?? (item.preparationState === "known" ? item.originalProtocol : null);
  const knownId = knownProtocol === AGENT_FULFILLMENT_COMMAND_VERSION ? known?.fulfillmentIntentId ?? item.fulfillmentIntentId : knownProtocol === AGENT_COMMAND_VERSION ? known?.agentCommandId ?? item.agentCommandId : null;
  const unknown = !!marker && marker.state !== "known" || item.preparationState === "requested_unknown" || result?.disposition === "unknown";
  const privateNow = run.contextAuthority === authority && live.current.canRead && !cleared.current && run.privateAvailable && Date.parse(run.expiresAt) > Date.now();
  const original = privateNow ? proposal?.draft.original : null, fulfillment = privateNow ? proposal?.draft.fulfillment : null;
  const eligible = privateNow && !!original && item.originalProtocol === AGENT_COMMAND_VERSION && item.canPrepare && live.current.canRun && storageReady && !!ownerScope
    && !marker && !unknown && result?.disposition === "not_requested" && !knownId;
  const formHref = proposal && privateNow && fulfillment ? agentFulfillmentProposalFormHref(run, proposal, params.toString()) : null;
  function operationHref(id: string, protocol: typeof AGENT_COMMAND_VERSION | typeof AGENT_FULFILLMENT_COMMAND_VERSION) {
    return agentFulfillmentProposalOperationHref(params.toString(), run.id, id, protocol, fulfillment?.source.orderId);
  }
  async function prepare() {
    if (!eligible || !original || reading || pending || lock.current || !valid(epoch.current)) return;
    const token = epoch.current, lease = Symbol("v4-prepare"); lock.current = lease; setPending(true); setError("");
    try {
      if (readAgentNativeV4PreparationIntents(ownerScope).some(value => value.runId === run.id && value.itemId === item.id)) throw new AgentNativeV4RequestError(409, "本项已有原标识 请只读取回执");
      const saved = saveAgentNativeV4PreparationIntent({ version: 1, ownerScope, runId: run.id, itemId: item.id, proposalChecksum: item.proposalChecksum, state: "prepared", createdAt: new Date().toISOString() });
      if (!valid(token) || !live.current.canRun) return;
      updateAgentNativeV4PreparationIntent({ ...saved, state: "unknown" });
      const value = await prepareAgentNativeV4Item(run, item, authority, null, () => valid(token) && live.current.canRun && Date.parse(run.expiresAt) > Date.now());
      if (!valid(token) || !live.current.canRun) return;
      setReceipt({ stamp, value });
      if (value.disposition === "known" && value.agentCommandId && value.originalProtocol === AGENT_COMMAND_VERSION) {
        updateAgentNativeV4PreparationIntent({ ...saved, state: "known" }); router.push(operationHref(value.agentCommandId, value.originalProtocol));
      }
    } catch (failure) { if (valid(token)) { setError(failureText(failure)); setReceipt(null); if (agentNativeV4ReadDenied(failure)) denied.current(); } }
    finally { if (lock.current === lease) { lock.current = null; if (valid(token)) setPending(false); } }
  }
  return <li className="ap-item an4-proposal" aria-label={"模型原提案 " + (item.position + 1)} aria-busy={reading || pending}>
    <header><h4>{item.position + 1} · {privateNow ? proposal?.draft.label ?? "原提案正文当前不可读" : "原提案正文当前不可读"}</h4><span className="al-badge">{knownId ? "原准备已知 尚须逐笔核对" : unknown ? "原准备结果待核对" : "模型建议 尚未原业务核验"}</span></header>
    <dl className="al-pairs"><div><dt>原项编号</dt><dd><code>{item.id}</code></dd></div><div><dt>固定提案校验</dt><dd><code>{item.proposalChecksum}</code></dd></div></dl>
    {privateNow && proposal && <><h5>{fulfillment ? operationNames[fulfillment.original.kind] : proposal.draft.capability.domain === "fulfillment" ? "原履约建议" : agentOperationName(proposal.draft.capability.domain, proposal.draft.capability.kind)}</h5>
      <p className="al-prose">{proposal.draft.reason}</p><NativeClaims stepPrefix="native-v4" claims={proposal.claimIndexes.map(index => run.result!.claims[index]!)} />
      {!!proposal.draft.missingInformation.length && <section className="al-warning" aria-label="本项原建议缺少的资料"><h5>须补齐与核对的资料</h5><ul>{proposal.draft.missingInformation.map((text, index) => <li key={index}>{text}</li>)}</ul></section>}
      {original && <ModelDraft original={original} />}
      {fulfillment && <><FulfillmentSuggestionDetails suggestion={fulfillment} /><section aria-label="本人核对事项"><h5>本人核对事项</h5>{proposal.operatorChecks.length ? <ul>{proposal.operatorChecks.map(check => <li key={check.path.join(".")}>{checks[check.key]} · 尚待本人核对{check.requiredWhen === "quality_group_selected" ? " 所选实物组时必需" : check.requiredWhen === "manufacturing_selected" ? " 选择制造依据时必需" : ""}</li>)}</ul> : <p>仍须在原表单按实际资料检查 未提供的本人确认不补猜</p>}</section></>}
    </>}
    {item.blockReason && <p className="al-warning">{blocks[item.blockReason]}</p>}
    {fulfillment && !formHref && !knownId && <p className="al-warning">原来源没有可核对的同单商品入口 不能手填编号或改用今天来源 请返回原任务核对</p>}
    {reading && <p role="status">正在只读核对本项原准备回执</p>}{pending && <p role="status">正在保存本项原准备 不执行业务</p>}{error && <p className="al-error" role="alert">{error}</p>}
    {result && <p role="status">{{ not_requested: "暂未查到原准备 不证明先前没有提交", unknown: "原准备结果未知 继续只读核对 不重发准备", known: "已取得真实原准备引用 不代表业务已经执行", blocked: "原准备当前被阻断 不发送替代请求" }[result.disposition]}</p>}
    <div className="al-actions"><button type="button" disabled={!live.current.canRead || reading || pending || cleared.current} onClick={() => void load()}><FileSearch size={14} />读取这项原准备回执</button>
      {knownId && knownProtocol && (knownProtocol === AGENT_COMMAND_VERSION || fulfillment) ? <Link href={operationHref(knownId, knownProtocol)}>核对这项原操作<ArrowRight size={14} /></Link> : fulfillment ? formHref && <Link href={formHref}>到原表单补齐并本人核对<ArrowRight size={14} /></Link>
        : <button type="button" className="al-primary" disabled={!eligible || reading || pending} onClick={() => void prepare()}>保存这项原准备并核对</button>}</div>
    {knownId && knownProtocol === AGENT_FULFILLMENT_COMMAND_VERSION && !fulfillment && <p className="al-muted">原订单来源当前不可读取 请从原同单履约入口核对 不猜测另一笔订单恢复</p>}
    {!live.current.canRun && <p className="al-muted">当前没有工作流运行权限 只读取原提案和回执</p>}
    {unknown && <p className="al-muted">本项已保留原编号 刷新或重开只读取同一原回执 不换项或重复准备</p>}
  </li>;
}
const fieldNames: Record<string, string> = { input: "建议填写", targetId: "原目标编号", productionOrderId: "原生产单", productionVersionId: "原生产版本", qualityInspectionId: "原质检", qualityGroupId: "原实物组", packageId: "原交付包", versionId: "原包裹版本",
  expectedSequence: "固定事件序号", expectedProjectionVersion: "固定生产状态版本", expectedProductionProjectionVersion: "固定生产状态版本", expectedCurrentVersion: "固定包裹版本", quantity: "数量", remakeQuantity: "补做数量", occurredAt: "发生时间", inspectedAt: "检验时间", reason: "原因与依据", note: "补充说明", reference: "原凭据", packages: "原包裹", items: "原商品", productionAllocations: "装箱来源分配" };
function FulfillmentSuggestionDetails({ suggestion }: { suggestion: AgentFulfillmentSuggestion }) {
  return <details className="ap-draft an4-draft"><summary>核对原履约建议与来源</summary><p className="al-warning">以下是模型建议 尚未由原业务核验 未包含本人或实物确认 需到原表单补齐后明确保存原准备</p>
    <dl className="al-pairs"><div><dt>原订单</dt><dd><code>{suggestion.source.orderId}</code></dd></div><div><dt>原订单事件序号</dt><dd>{suggestion.source.expectedSequence}</dd></div><div><dt>来源步骤</dt><dd><a href={"#native-v4-step-" + suggestion.source.stepId}>{suggestion.source.stepId}</a></dd></div><div><dt>来源结果</dt><dd>{suggestion.source.resultIndex + 1}</dd></div><div><dt>来源完整校验</dt><dd><code>{suggestion.source.dataChecksum}</code></dd></div></dl>
    <SuggestionValue value={suggestion.original} />
  </details>;
}
function SuggestionValue({ value }: { value: unknown }) {
  const [page, setPage] = useState(0);
  if (value === null || value === undefined) return <>原建议未提供</>;
  if (typeof value === "boolean") return <>{value ? "建议值 是" : "建议值 否"}</>;
  if (typeof value === "number") return <>{String(value)}</>;
  if (typeof value === "string") return <span className="al-prose">{value || "空文本"}</span>;
  if (Array.isArray(value)) {
    const count = Math.max(1, Math.ceil(value.length / 20)), selected = Math.min(page, count - 1);
    return <>{value.length ? <ol>{value.slice(selected * 20, selected * 20 + 20).map((row, index) => <li key={selected * 20 + index}><SuggestionValue value={row} /></li>)}</ol> : "原建议空列表"}
      {count > 1 && <div className="al-actions"><button type="button" disabled={selected === 0} onClick={() => setPage(selected - 1)}>上一段建议</button><span>{selected + 1} / {count} · 共 {value.length} 项</span><button type="button" disabled={selected + 1 === count} onClick={() => setPage(selected + 1)}>下一段建议</button></div>}</>;
  }
  if (typeof value !== "object") return <>原建议未提供</>;
  return <dl className="al-pairs">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{fieldNames[key] ?? key}</dt><dd><SuggestionValue value={item} /></dd></div>)}</dl>;
}
