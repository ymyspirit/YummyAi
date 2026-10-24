"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, FileSearch, RefreshCw } from "lucide-react";
import { z } from "zod";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import type { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import { AGENT_FULFILLMENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { bindAgentFulfillmentCompletion, type AgentFulfillmentSuggestion } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { AGENT_NATIVE_V4_CLEAR_EVENT, type AgentNativeV4View, type AgentNativeV4ResolvedProposal, type AgentNativeV4ItemReceipt } from "@yummyai/contracts/ai/agent-native-v4";
import { normalizeFulfillmentCommand, type FulfillmentCommandKind, type PrepareFulfillmentCommand } from "@yummyai/contracts/order/fulfillment-command";
import { useErpAccess } from "../identity/erp-access";
import { agentNativeV4ReadDenied, AgentNativeV4RequestError, readAgentNativeV4Run, readAgentNativeV4ItemReceipt, prepareAgentNativeV4Item } from "./agent-native-v4-client";
import { useAgentNativeV4Intents, readAgentNativeV4PreparationIntents, saveAgentNativeV4PreparationIntent, updateAgentNativeV4PreparationIntent } from "./agent-native-v4-intent";
import "./agent-native-v4.css";

export const AGENT_NATIVE_V4_ITEM_QUERY = "agentNativeV4Item";
export const AGENT_NATIVE_V4_RUN_QUERY = "agentNativeV4";
const parentCoordinates = ["run", "agentRun", "agentPlan", "agentDependencyPlan", "agentNative", "agentNativeV2", "agentNativeV3", AGENT_NATIVE_V4_RUN_QUERY, "agentCommand"] as const;
/** Preserve exact parent references, never inherited form data or a nested return URL. */
export function agentFulfillmentProposalParentQuery(rawQuery: string, runId?: string | null) {
  const original = new URLSearchParams(rawQuery), query = new URLSearchParams();
  for (const key of parentCoordinates) {
    const values = original.getAll(key), parsed = values.length === 1 ? z.uuidv7().safeParse(values[0]) : null;
    if (parsed?.success) query.set(key, parsed.data.toLowerCase());
  }
  if (runId) query.set(AGENT_NATIVE_V4_RUN_QUERY, z.uuidv7().parse(runId).toLowerCase());
  return query;
}
export function agentFulfillmentProposalOperationHref(rawQuery: string, runId: string, id: string,
  protocol: typeof AGENT_COMMAND_VERSION | typeof AGENT_FULFILLMENT_COMMAND_VERSION, orderId?: string) {
  const query = agentFulfillmentProposalParentQuery(rawQuery, runId), coordinate = z.uuidv7().parse(id).toLowerCase();
  if (protocol === AGENT_FULFILLMENT_COMMAND_VERSION) {
    query.set("agentFulfillmentCommand", coordinate); query.set("order", z.uuidv7().parse(orderId).toLowerCase());
  } else query.set("agentCommand", coordinate);
  return "/ai-tasks?" + query;
}
export function agentFulfillmentProposalFormIdentity(input: { authority: string; runId: string | null; itemId: string | null;
  proposalChecksum: string | null; suggestion: AgentFulfillmentSuggestion | null; orderSequence?: number }) {
  const original = input.suggestion?.original;
  return JSON.stringify([input.authority, input.runId, input.itemId, input.proposalChecksum, input.suggestion?.source ?? null,
    original ? [original.kind, original.targetId, original.kind === "delivery_feedback" ? original.packageId : null,
      original.kind === "shipment_review" ? original.versionId : null] : null, input.orderSequence ?? null]);
}
type ProposalDraft = { identity: string; suggestion: AgentFulfillmentSuggestion };
/** A new HTTP object does not replace the same pinned suggestion in an edited form. */
export function retainAgentFulfillmentProposalDraft(previous: ProposalDraft | null, identity: string, suggestion: AgentFulfillmentSuggestion | null): ProposalDraft | null {
  return !suggestion ? null : previous?.identity === identity ? previous : { identity, suggestion };
}
const formGuidance: Record<FulfillmentCommandKind, string> = {
  delivery_create: "在本单工厂交付清单核对原生产单及固定版本 再点击只准备交由 Agent 核对",
  delivery_feedback: "在所引交付包的真实文件提交凭据或可选补充回执中填写 本人核对框需要重新勾选",
  production_milestone: "打开查看本商品生产记录与异常处理 核对所引原生产单 再填写实际进度",
  quality_inspection: "打开原生产记录中的登记质检结果 按实物逐项核对",
  quality_group_inspection: "打开实物分组 复检与补做 选择本次实际检验范围 再逐组检查",
  production_recovery: "在原生产记录选择按组补做或当前审核稿返工 重新核对原实物 制造单位与工厂产能",
  whole_production_milestone: "在整单生产区域核对全部原商品及生产依据 再填写实际进度",
  whole_quality_inspection: "在整单生产区域逐项检查全部商品 本人核对框需要重新勾选",
  shipment_create: "打开按包裹分配本次发货 选择本单商品和装箱数量 逐包核对原生产来源与实物 再只准备交由 Agent 核对",
  whole_shipment_create: "在整单包裹中补齐运单 按实物核对各商品生产版本及装箱来源",
  shipment_version: "在核对生产来源并建立新版本中补齐原包裹来源 不替换原商品或运单",
  shipment_review: "在所引原包裹填写核对说明 核对固定版本后只保存原准备",
  shipment_dispatch: "在所引原包裹填写实际交运依据与发生时间 不把工厂观察当作已交运",
  shipment_platform_confirmation: "打开登记平台发货确认 核对原平台实际记录后填写凭据",
};
type InputByKind = { [Kind in FulfillmentCommandKind]: Extract<AgentFulfillmentSuggestion["original"], { kind: Kind }>["input"] };
type SuggestedInput<Kind extends FulfillmentCommandKind> = InputByKind[Kind];
type FormTarget = { kind: FulfillmentCommandKind; targetId: string; packageId?: string; versionId?: string };
export type AgentFulfillmentProposalHandoffState = {
  active: true; ready: boolean; busy: boolean; blocked: boolean; formKey: string; slotId: string;
  suggestion: AgentFulfillmentSuggestion | null;
  matches(target: FormTarget): boolean;
  prepare(command: PrepareFulfillmentCommand): Promise<void>;
};
type Handoff = AgentFulfillmentProposalHandoffState;
const Context = createContext<Handoff | null>(null);
export function useAgentFulfillmentProposalHandoff() { return useContext(Context); }
export function useAgentFulfillmentProposalInput<Kind extends FulfillmentCommandKind>(kind: Kind, targetId: string, pins?: { packageId?: string; versionId?: string }): SuggestedInput<Kind> | null {
  const handoff = useContext(Context);
  return agentFulfillmentProposalInputFor(handoff, kind, targetId, pins);
}
export function agentFulfillmentProposalInputFor<Kind extends FulfillmentCommandKind>(handoff: Handoff | null, kind: Kind, targetId: string, pins?: { packageId?: string; versionId?: string }): SuggestedInput<Kind> | null {
  if (!handoff?.ready || !handoff.matches({ kind, targetId, ...pins }) || handoff.suggestion?.original.kind !== kind) return null;
  // The discriminant was compared above; the shared parser recursively excludes all operator assertions.
  return handoff.suggestion.original.input as SuggestedInput<Kind>;
}
export function agentFulfillmentProposalLocalTime(value: unknown, timeZone?: string) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return "";
  const date = new Date(value);
  if (timeZone) {
    try { const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
      const values = Object.fromEntries(parts.map(part => [part.type, part.value])); return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}`;
    } catch { return ""; }
  }
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 23);
}
export function bindAgentFulfillmentProposalForm(suggestion: AgentFulfillmentSuggestion, slotId: string, raw: PrepareFulfillmentCommand) {
  const original = normalizeFulfillmentCommand(raw);
  assertSuggestedSourcePins(suggestion.original.input, original.input);
  const input = original.kind === "production_milestone" ? { ...original.input, externalEventId: slotId } : { ...original.input, idempotencyKey: slotId };
  return bindAgentFulfillmentCompletion(suggestion, slotId, { version: AGENT_FULFILLMENT_COMMAND_VERSION,
    orderId: suggestion.source.orderId, original: { ...original, requestId: slotId, input } });
}
const sourceFields = new Set(["expectedRevision", "expectedProjectionVersion", "expectedSequence", "expectedProductionProjectionVersion", "expectedCurrentVersion", "expectedVersion",
  "productionOrderId", "originalProductionOrderId", "productionVersionId", "qualityInspectionId", "qualityGroupId", "fileChecksum", "manufacturingChecksum", "renderId"]);
const rowIdentityFields = ["lineId", "orderLineId", "productionOrderId", "productionVersionId", "packageReferenceId", "qualityInspectionId", "qualityGroupId"];
function hasSuggestedSourcePins(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSuggestedSourcePins);
  return !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => sourceFields.has(key) || hasSuggestedSourcePins(child));
}
function assertSuggestedSourcePins(suggested: unknown, actual: unknown): void {
  if (!suggested || typeof suggested !== "object") return;
  if (Array.isArray(suggested)) {
    if (!Array.isArray(actual)) throw new Error("原建议的固定来源与表单不符 请返回原任务核对 不改用新版本");
    const matched = new Set<unknown>();
    suggested.forEach(value => {
      const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
      const fields = row ? rowIdentityFields.filter(key => typeof row[key] === "string") : [];
      if (!fields.length) {
        if (hasSuggestedSourcePins(value)) throw new Error("原建议缺少能唯一核对的原行或生产来源编号 请核对缺项 不按列表顺序补猜来源");
        return;
      }
      const candidates = (actual as unknown[]).filter(candidate => {
        const current = candidate && typeof candidate === "object" && !Array.isArray(candidate) ? candidate as Record<string, unknown> : null;
        return current && fields.every(field => current[field] === row?.[field]);
      });
      if (candidates.length !== 1 || matched.has(candidates[0])) throw new Error("原建议的来源未能唯一匹配本页原记录 请核对来源编号与缺项 不替换为新版本");
      matched.add(candidates[0]); assertSuggestedSourcePins(value, candidates[0]);
    });
    return;
  }
  const current = actual && typeof actual === "object" && !Array.isArray(actual) ? actual as Record<string, unknown> : {};
  for (const [key, value] of Object.entries(suggested)) {
    if (sourceFields.has(key) && value !== current[key] && !(value === null && current[key] === undefined)) throw new Error("原建议的固定来源或版本与本页不符 请核对原来源 不用当前新版本替换");
    assertSuggestedSourcePins(value, current[key]);
  }
}
/** Only scalar coordinates cross routes. Source values are re-read under the current person. */
export function agentFulfillmentProposalFormHref(run: AgentNativeV4View, proposal: AgentNativeV4ResolvedProposal, originalQuery = ""): string | null {
  const suggestion = proposal.draft.fulfillment;
  if (!run.privateAvailable || !suggestion) return null;
  const observation = run.observations.find(value => value.stepId === suggestion.source.stepId), result = observation?.results[suggestion.source.resultIndex];
  if (result?.tool !== "orders.fulfillment" || result.dataChecksum !== suggestion.source.dataChecksum || result.data.order.id !== suggestion.source.orderId
    || result.data.order.sequence !== suggestion.source.expectedSequence) return null;
  const target = suggestion.original, data = result.data;
  let lineId: string | undefined;
  if (target.kind === "shipment_create") {
    if (target.targetId !== data.order.id) return null;
    const selected = target.input.packages?.flatMap(pkg => pkg.lines?.flatMap(line => line.orderLineId ? [line.orderLineId] : []) ?? []) ?? [];
    if (selected.some(id => !data.order.lines.some(line => line.id === id))) return null;
    // Navigation only. A partial suggestion must not silently choose packing lines, quantities or production sources.
    lineId = [...new Set(selected)].sort()[0] ?? data.order.lines.map(line => line.id).sort()[0];
  } else if (["production_milestone", "quality_inspection", "quality_group_inspection", "production_recovery", "delivery_feedback"].includes(target.kind)) {
    if (data.kind !== "production") return null;
    const row = data.rows.find(value => target.kind === "delivery_feedback" ? value.delivery.data?.itemId === target.targetId : value.id === target.targetId);
    lineId = row?.orderLineId;
  } else if (["shipment_version", "shipment_review", "shipment_dispatch", "shipment_platform_confirmation"].includes(target.kind)) {
    if (data.kind !== "shipments") return null;
    lineId = data.rows.find(value => value.id === target.targetId)?.packageLines[0]?.orderLineId;
  } else lineId = data.order.lines[0]?.id;
  if (!lineId || !data.order.lines.some(value => value.id === lineId)) return null;
  const parent = agentFulfillmentProposalParentQuery(originalQuery, run.id), query = new URLSearchParams(parent); query.set(AGENT_NATIVE_V4_ITEM_QUERY, proposal.id);
  query.set("order", suggestion.source.orderId); query.set("line", lineId); query.delete("agentFulfillmentCommand");
  if (target.kind === "delivery_feedback") query.set("delivery", target.packageId);
  query.set("returnTo", "/ai-tasks?" + parent);
  return (target.kind.startsWith("shipment_") || target.kind === "whole_shipment_create" ? "/shipments?" : "/production?") + query;
}
export function AgentFulfillmentProposalHandoff({ orderId, orderSequence, children }: { orderId: string; orderSequence?: number; children: ReactNode }) {
  const access = useErpAccess(), params = useSearchParams(), run = params.get(AGENT_NATIVE_V4_RUN_QUERY), item = params.get(AGENT_NATIVE_V4_ITEM_QUERY);
  const active = params.has(AGENT_NATIVE_V4_ITEM_QUERY), identity = useRef({ authority: access.authority, scope: access.preferenceScope });
  identity.current = { authority: access.authority, scope: access.preferenceScope };
  if (!active) return <Context.Provider value={null}>{children}</Context.Provider>;
  const validIds = params.getAll(AGENT_NATIVE_V4_RUN_QUERY).length === 1 && params.getAll(AGENT_NATIVE_V4_ITEM_QUERY).length === 1
    && z.uuidv7().safeParse(run).success && z.uuidv7().safeParse(item).success;
  return <ProposalHandoff key={JSON.stringify([access.authority, access.preferenceScope, orderId, run, item])} orderId={orderId} orderSequence={orderSequence}
    runId={validIds ? run!.toLowerCase() : null} itemId={validIds ? item!.toLowerCase() : null} identity={identity}>{children}</ProposalHandoff>;
}
function ProposalHandoff({ orderId, orderSequence, runId, itemId, identity, children }: {
  orderId: string; orderSequence?: number; runId: string | null; itemId: string | null;
  identity: { current: { authority: string | null; scope: string | null } }; children: ReactNode;
}) {
  const access = useErpAccess(), authority = access.authority ?? "", scope = access.preferenceScope, router = useRouter(), params = useSearchParams();
  const canRead = access.can(Permission.WorkflowRead) && access.canTenant(Permission.OrderRead) && access.canTenant(Permission.OrderPiiRead);
  const canWrite = canRead && access.can(Permission.WorkflowRun) && access.canTenant(Permission.OrderWrite);
  const intents = useAgentNativeV4Intents(scope), live = useRef({ authority, scope, canRead, canWrite, orderSequence });
  live.current = { authority, scope, canRead, canWrite, orderSequence };
  const alive = useRef(true), cleared = useRef(false), epoch = useRef(0), sequence = useRef(0), active = useRef<AbortController | null>(null), mutation = useRef(false), proof = useRef(false);
  const draft = useRef<ProposalDraft | null>(null);
  const [run, setRun] = useState<AgentNativeV4View | null>(null), [reading, setReading] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [denied, setDenied] = useState(false), [submitted, setSubmitted] = useState(false), [verified, setVerified] = useState(false);
  const valid = useCallback((token: number) => alive.current && !cleared.current && token === epoch.current && identity.current.authority === authority
    && identity.current.scope === scope && live.current.authority === authority && live.current.scope === scope, [authority, scope, identity]);
  const clear = useCallback(() => { epoch.current++; sequence.current++; proof.current = false; draft.current = null; active.current?.abort(); setRun(null); setVerified(false); setReading(false); setBusy(false); setError("当前身份或来源已不可读取 原建议与本人确认已清除"); setDenied(true); }, []);
  useLayoutEffect(() => {
    alive.current = true;
    const purge = () => { cleared.current = true; clear(); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, purge); window.addEventListener(AGENT_NATIVE_V4_CLEAR_EVENT, purge);
    return () => { alive.current = false; epoch.current++; active.current?.abort(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, purge); window.removeEventListener(AGENT_NATIVE_V4_CLEAR_EVENT, purge); };
  }, [clear]);
  const load = useCallback(async () => {
    if (!runId || !itemId || !canRead || cleared.current || mutation.current) return;
    const token = epoch.current, request = ++sequence.current, abort = new AbortController(); active.current?.abort(); active.current = abort;
    proof.current = false; setVerified(false); setReading(true); setError("");
    try {
      const value = await readAgentNativeV4Run(runId, authority, abort.signal);
      if (!valid(token) || request !== sequence.current || abort.signal.aborted) return;
      const suggestion = value.result?.proposals.find(proposal => proposal.id === itemId)?.draft.fulfillment;
      const selectedItem = value.items.find(item => item.id === itemId);
      if (!value.privateAvailable || !suggestion || suggestion.source.orderId !== orderId || !selectedItem) throw new AgentNativeV4RequestError(403, "当前原提案与本单资料无法核对");
      if (Date.parse(value.expiresAt) <= Date.now() || selectedItem.blockReason === "read_sources_changed" || suggestion.source.expectedSequence !== live.current.orderSequence) { clear(); return; }
      setRun(value); proof.current = true; setVerified(true); setDenied(false);
    } catch (failure) { if (valid(token) && request === sequence.current && !abort.signal.aborted) { if (agentNativeV4ReadDenied(failure)) clear(); else setError("原建议暂不可读取 请只读重试 不重建原准备"); } }
    finally { if (valid(token) && request === sequence.current) setReading(false); }
  }, [runId, itemId, canRead, authority, valid, orderId, clear]);
  useEffect(() => { void load(); return () => { sequence.current++; active.current?.abort(); }; }, [load]);
  useLayoutEffect(() => {
    const original = run?.result?.proposals.find(value => value.id === itemId)?.draft.fulfillment;
    if (run && original && (original.source.expectedSequence !== orderSequence || Date.parse(run.expiresAt) <= Date.now())) clear();
  }, [run, orderSequence, itemId, clear]);
  useEffect(() => {
    if (!run) return;
    const remaining = Date.parse(run.expiresAt) - Date.now();
    if (remaining <= 0) { clear(); return; }
    const timer = window.setTimeout(clear, Math.min(remaining, 2_147_483_647)); return () => window.clearTimeout(timer);
  }, [run, clear]);
  const proposal = run?.result?.proposals.find(value => value.id === itemId), item = run?.items.find(value => value.id === itemId);
  const formKey = agentFulfillmentProposalFormIdentity({ authority, runId, itemId, proposalChecksum: item?.proposalChecksum ?? null,
    suggestion: proposal?.draft.fulfillment ?? null, orderSequence });
  draft.current = retainAgentFulfillmentProposalDraft(draft.current, formKey, proposal?.draft.fulfillment ?? null);
  const suggestion = draft.current?.suggestion ?? null;
  const sourceCurrent = !!suggestion && orderSequence !== undefined && suggestion.source.expectedSequence === orderSequence;
  const marker = intents.preparations.find(value => value.runId === runId && value.itemId === itemId);
  const ready = valid(epoch.current) && canRead && !denied && !!run && Date.parse(run.expiresAt) > Date.now() && !!item && !!suggestion && sourceCurrent;
  const blocked = !ready || !verified || reading || !canWrite || !intents.ready || busy || submitted || !!marker || !item?.canPrepare;
  const matches = useCallback((target: FormTarget) => !!suggestion && target.kind === suggestion.original.kind && target.targetId === suggestion.original.targetId
    && (suggestion.original.kind !== "delivery_feedback" || suggestion.original.packageId === target.packageId)
    && (suggestion.original.kind !== "shipment_review" || suggestion.original.versionId === target.versionId), [suggestion]);
  const openKnown = (value: AgentNativeV4ItemReceipt) => {
    if (!valid(epoch.current) || !runId || !run || Date.parse(run.expiresAt) <= Date.now() || value.disposition !== "known" || !value.fulfillmentIntentId || value.originalProtocol !== AGENT_FULFILLMENT_COMMAND_VERSION) return;
    router.push(agentFulfillmentProposalOperationHref(params.toString(), runId, value.fulfillmentIntentId, value.originalProtocol, orderId));
  };
  async function recover() {
    if (!valid(epoch.current) || !canRead || denied || reading || mutation.current || !run || !item) return;
    const token = epoch.current, abort = new AbortController(); active.current?.abort(); active.current = abort; mutation.current = true; setBusy(true); setError("");
    try {
      const value = await readAgentNativeV4ItemReceipt(run, item, authority, abort.signal);
      if (!valid(token) || !live.current.canRead || abort.signal.aborted || Date.parse(run.expiresAt) <= Date.now()) return;
      if (value.disposition === "known") { if (marker) updateAgentNativeV4PreparationIntent({ ...marker, state: "known" }); openKnown(value); }
      else setError("尚未查到已完成的原准备 不代表未提交 保留原项编号继续只读核对 不重新准备");
    } catch (failure) { if (valid(token)) { if (agentNativeV4ReadDenied(failure)) clear(); else setError("原准备结果尚待核对 不重复提交"); } }
    finally { mutation.current = false; if (valid(token)) { setBusy(false); intents.reload(); } }
  }
  async function prepare(command: PrepareFulfillmentCommand) {
    if (blocked || !proof.current || mutation.current || !run || Date.parse(run.expiresAt) <= Date.now() || !item || !suggestion || !intents.ownerScope) throw new AgentNativeV4RequestError(409, "请先核对当前提案 原来源及原准备回执");
    const completed = bindAgentFulfillmentProposalForm(suggestion, item.id, command), token = epoch.current;
    mutation.current = true; setBusy(true); setError("");
    try {
      if (!valid(token) || !live.current.canWrite || live.current.orderSequence !== suggestion.source.expectedSequence) throw new AgentNativeV4RequestError(409, "原来源已变化", "authority_changed");
      if (readAgentNativeV4PreparationIntents(intents.ownerScope).some(value => value.runId === run.id && value.itemId === item.id)) throw new AgentNativeV4RequestError(409, "该项已有原准备标识 请只读核对");
      const saved = saveAgentNativeV4PreparationIntent({ version: 1, ownerScope: intents.ownerScope, runId: run.id, itemId: item.id,
        proposalChecksum: item.proposalChecksum, state: "prepared", createdAt: new Date().toISOString() });
      if (!valid(token) || !live.current.canWrite) return;
      updateAgentNativeV4PreparationIntent({ ...saved, state: "unknown" }); setSubmitted(true);
      const value = await prepareAgentNativeV4Item(run, item, authority, completed, () => valid(token) && proof.current && live.current.canWrite && live.current.orderSequence === suggestion.source.expectedSequence && Date.parse(run.expiresAt) > Date.now());
      if (!valid(token) || !live.current.canWrite) return;
      if (value.disposition === "known") { updateAgentNativeV4PreparationIntent({ ...saved, state: "known" }); openKnown(value); }
      else throw new AgentNativeV4RequestError(409, "原准备结果待核对");
    } catch (failure) { if (valid(token)) { if (agentNativeV4ReadDenied(failure)) clear(); else setError("本项准备结果尚未核对 只读取原回执 不换键或改正文重发"); } throw failure; }
    finally { mutation.current = false; if (valid(token)) { setBusy(false); intents.reload(); } }
  }
  const value: Handoff = { active: true, ready, busy, blocked, slotId: itemId ?? "", formKey,
    suggestion: ready ? suggestion : null, matches, prepare };
  const parent = agentFulfillmentProposalParentQuery(params.toString(), runId);
  function leave() { epoch.current++; sequence.current++; proof.current = false; active.current?.abort(); setVerified(false); setReading(false); setBusy(false); }
  return <Context.Provider value={value}><section className="an4-handoff" aria-label="模型履约提案补项" aria-busy={reading || busy}>
    <header><h3><FileSearch size={16} />在原表单补齐本次建议</h3><Link href={"/ai-tasks?" + parent} onClick={event => { if (!event.defaultPrevented && event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) leave(); }}><ArrowLeft size={14} />返回原模型任务</Link></header>
    <p>模型建议不等于本人已核对 本页只保存原准备 不自动登记质检 交运或工厂事实</p>
    {!runId || !itemId ? <p role="alert">原父任务或项编号无效 不采用替代提案</p> : <>
      {reading && <p role="status">正在只读核对原提案与本单来源</p>}{error && <p role="alert">{error}</p>}
      {suggestion && <p>原订单事件序号 {suggestion.source.expectedSequence} · 当前 {orderSequence ?? "尚未提供"} · 本人确认全部重新核对</p>}
      {suggestion && <p>{formGuidance[suggestion.original.kind]}</p>}
      {suggestion && !sourceCurrent && <p role="status">当前订单依据与模型所引版本不一致 请返回原任务核对 不用今天资料悄悄替换原来源</p>}
      <div className="an4-actions"><button type="button" disabled={!canRead || busy || reading || cleared.current} onClick={() => void load()}><RefreshCw size={14} />只读重查原建议</button>
        <button type="button" disabled={!canRead || denied || !run || !item || reading || busy} onClick={() => void recover()}>只读取本项原准备回执</button></div>
    </>}</section>{children}</Context.Provider>;
}
