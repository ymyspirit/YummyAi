"use client";
import Link from "next/link";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, FileSearch, RefreshCw, RotateCcw, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import type { FulfillmentCommandKind, FulfillmentCommandView, PrepareFulfillmentCommand } from "@yummyai/contracts/order/fulfillment-command";
import { useErpAccess } from "../identity/erp-access";
import { dateTime } from "./order-center-model";
import {
  actOnFulfillmentCommand, prepareFulfillmentCommand, readFulfillmentCommand, readFulfillmentCommands,
  FulfillmentCommandRequestError, fulfillmentCommandDenied, fulfillmentCommandError,
} from "./fulfillment-command-client";
import { createFulfillmentCommandIntent, type FulfillmentCommandReference } from "./fulfillment-command-intent";
import { AGENT_FULFILLMENT_COMMAND_VERSION, AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, type AgentFulfillmentCommandView } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { prepareAgentFulfillmentCommand, readAgentFulfillmentCommandWorkspace, agentFulfillmentCommandDenied, agentFulfillmentCommandError } from "../ai-tasks/agent-fulfillment-command-client";
import { createAgentFulfillmentCommandIntent, saveAgentFulfillmentCommandIntent, recordAgentFulfillmentCommandIntent, useAgentFulfillmentCommandIntents } from "../ai-tasks/agent-fulfillment-command-intent";
import "../ai-tasks/agent-fulfillment-command.css";
import "./fulfillment-command-recovery.css";
import { useAgentFulfillmentProposalHandoff } from "../ai-tasks/agent-fulfillment-proposal-handoff";

const names: Record<FulfillmentCommandKind, string> = {
  delivery_create: "创建原交付包", delivery_feedback: "登记工厂原回执", production_milestone: "登记生产进度", quality_inspection: "登记逐项质检",
  quality_group_inspection: "登记实物分组质检", production_recovery: "登记原生产补做", whole_production_milestone: "登记整单生产进度",
  whole_quality_inspection: "登记整单质检", shipment_create: "建立原包裹", whole_shipment_create: "建立整单包裹", shipment_version: "保存包裹新版本",
  shipment_review: "审核原包裹版本", shipment_dispatch: "登记实际出库", shipment_platform_confirmation: "登记人工平台确认",
};
const states: Record<FulfillmentCommandView["status"], string> = {
  prepared: "原提交已保存 等待执行", executing: "原执行仍在处理中", uncertain: "原执行结果待核对", succeeded: "已有原业务回执",
  rejected: "原提交未执行成功", cancelled: "原提交已取消", expired: "原提交已到期", acknowledged: "原结果已核对",
};
// Local redaction keeps the last observed business status; only the server
// determines its next status. Expired private fields never re-enter the UI.
function currentPrivateIndex(value: FulfillmentCommandView): FulfillmentCommandView {
  return Date.parse(value.expiresAt) > Date.now() ? value
    : { ...value, summary: null, receipt: null, canExecute: false, canCancel: false };
}
type PendingReference = FulfillmentCommandReference & { action: "prepare" | "execute" | "cancel" | "acknowledge" };
type ScopeState = {
  orderId: string;
  blocked: boolean;
  busy: boolean;
  submit(command: PrepareFulfillmentCommand): Promise<FulfillmentCommandView>;
  canPrepareAgent: boolean;
  prepareAgent(command: PrepareFulfillmentCommand): Promise<AgentFulfillmentCommandView | void>;
};
type RecoveryState = ScopeState & {
  returnQuery: string;
  items: FulfillmentCommandView[]; reading: boolean; error: string; notice: string; truncated: boolean; pending: PendingReference | null;
  canRead: boolean; canWrite: boolean; denied: boolean; cleared: boolean; working: string;
  refresh(): void; read(item: FulfillmentCommandView): Promise<void>;
  verified(id: string): boolean;
  isAgentPreparation(item: FulfillmentCommandView): boolean;
  act(item: FulfillmentCommandView, action: "execute" | "cancel" | "acknowledge"): Promise<void>;
};
const CommandContext = createContext<RecoveryState | null>(null);
export function useFulfillmentCommandScope(): ScopeState | null { return useContext(CommandContext); }
export function FulfillmentCommandPrepareButton({ disabled = false, value }: { disabled?: boolean; value?: string }) {
  const state = useContext(CommandContext);
  if (!state?.canPrepareAgent) return null;
  return <button type="submit" className="oc-button afc-handoff-button" value={value} data-agent-fulfillment-prepare="true"
    disabled={disabled || state.blocked || state.busy}>只准备交由 Agent 核对</button>;
}

export function FulfillmentCommandScope({ orderId, onChanged, onStateChange, children, returnQuery = "" }: {
  orderId: string; onChanged(): void; onStateChange?(state: { busy: boolean; loading: boolean }): void; children: ReactNode; returnQuery?: string;
}) {
  const access = useErpAccess(), live = useRef({ authority: access.authority, scope: access.preferenceScope, orderId });
  live.current = { authority: access.authority, scope: access.preferenceScope, orderId };
  return <FulfillmentCommandContent key={`${access.authority ?? ""}:${access.preferenceScope ?? ""}:${orderId}`}
    orderId={orderId} identity={live} onChanged={onChanged} onStateChange={onStateChange} returnQuery={returnQuery}>{children}</FulfillmentCommandContent>;
}
function FulfillmentCommandContent({ orderId, identity, onChanged, onStateChange, children, returnQuery }: {
  orderId: string; identity: { current: { authority: string | null; scope: string | null; orderId: string } };
  onChanged(): void; onStateChange?(state: { busy: boolean; loading: boolean }): void; children: ReactNode; returnQuery: string;
}) {
  const access = useErpAccess(), authority = access.authority ?? "", ownerScope = access.preferenceScope;
  const proposalHandoff = useAgentFulfillmentProposalHandoff();
  const canRead = access.canTenant(Permission.OrderRead) && access.canTenant(Permission.OrderPiiRead), canWrite = access.canTenant(Permission.OrderWrite);
  const agentPermission = access.can(Permission.WorkflowRead) && access.can(Permission.WorkflowRun);
  const agentIntents = useAgentFulfillmentCommandIntents(ownerScope), [agentPrepared, setAgentPrepared] = useState<{ id: string; orderId: string } | null>(null);
  const live = useRef({ authority, ownerScope, canRead, canWrite, agentPermission }); live.current = { authority, ownerScope, canRead, canWrite, agentPermission };
  const alive = useRef(true), purged = useRef(false), epoch = useRef(0), sequence = useRef(0), deniedRef = useRef(false), sending = useRef(false);
  const admission = useRef({ blocked: true, reading: true });
  const activeRead = useRef<AbortController | null>(null), activeWrite = useRef<AbortController | null>(null);
  const verified = useRef(new Set<string>()), notified = useRef(new Set<string>());
  const callbacks = useRef({ onChanged, onStateChange }); callbacks.current = { onChanged, onStateChange };
  const [items, setItems] = useState<FulfillmentCommandView[]>([]), [reading, setReading] = useState(true), [truncated, setTruncated] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [working, setWorking] = useState("");
  const [denied, setDenied] = useState(false), [cleared, setCleared] = useState(false), [reload, setReload] = useState(0);
  const [pending, setPending] = useState<PendingReference | null>(null), pendingRef = useRef<PendingReference | null>(null);
  const valid = useCallback((token = epoch.current) => alive.current && !purged.current && token === epoch.current
    && identity.current.authority === authority && identity.current.scope === ownerScope && identity.current.orderId === orderId
    && live.current.authority === authority && live.current.ownerScope === ownerScope && live.current.canRead,
  [authority, identity, orderId, ownerScope]);
  const savePending = useCallback((value: PendingReference | null) => { pendingRef.current = value; setPending(value); }, []);
  const replace = useCallback((value: FulfillmentCommandView) => {
    const next = currentPrivateIndex(value);
    setItems(previous => previous.some(item => item.id === next.id) ? previous.map(item => item.id === next.id ? next : item) : [next, ...previous]);
  }, []);
  const deny = useCallback(() => {
    deniedRef.current = true; epoch.current++; sequence.current++; activeRead.current?.abort(); activeWrite.current?.abort();
    verified.current.clear(); setItems([]); setTruncated(false); setReading(false); setWorking(""); setNotice(""); setAgentPrepared(null); setDenied(true);
    setError("当前无法读取本单原履约提交 原摘要与回执已隐藏 请重新核对当前本人权限");
  }, []);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => {
      purged.current = true; epoch.current++; sequence.current++; activeRead.current?.abort(); activeWrite.current?.abort(); sending.current = false;
      verified.current.clear(); notified.current.clear(); setItems([]); savePending(null); setWorking(""); setReading(false); setNotice(""); setAgentPrepared(null); setError(""); setCleared(true);
    };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    window.addEventListener(AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, clear);
    return () => { alive.current = false; epoch.current++; sequence.current++; activeRead.current?.abort(); activeWrite.current?.abort(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); window.removeEventListener(AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT, clear); };
  }, [savePending]);
  useEffect(() => { callbacks.current.onStateChange?.({ busy: Boolean(working), loading: reading }); }, [working, reading]);
  useEffect(() => () => callbacks.current.onStateChange?.({ busy: false, loading: false }), []);
  const observed = useCallback((value: FulfillmentCommandView) => {
    const original = pendingRef.current;
    if (!original || value.requestId !== original.requestId || value.requestChecksum !== original.requestChecksum || original.id !== null && value.id !== original.id) return;
    const complete = original.action === "prepare" || original.action === "cancel" && value.status === "cancelled"
      || original.action === "acknowledge" && value.acknowledged
      || original.action === "execute" && ["succeeded", "rejected", "cancelled", "expired", "acknowledged"].includes(value.status);
    if (complete) savePending(null); else if (original.id === null) savePending({ ...original, id: value.id });
  }, [savePending]);
  const load = useCallback(async () => {
    if (!valid() || deniedRef.current || sending.current) return;
    const token = epoch.current, current = ++sequence.current, controller = new AbortController(); activeRead.current?.abort(); activeRead.current = controller;
    const options = { signal: controller.signal, isCurrent: () => valid(token) && !deniedRef.current && !controller.signal.aborted && current === sequence.current };
    admission.current = { blocked: true, reading: true };
    verified.current.clear(); setReading(true); setError(""); setNotice("");
    try {
      const page = await readFulfillmentCommands({ orderId }, authority, options); if (!options.isCurrent()) return;
      let next = page.items; const original = pendingRef.current;
      if (original) {
        let found = next.find(item => item.requestId === original.requestId && item.requestChecksum === original.requestChecksum);
        if (!found && original.id) found = await readFulfillmentCommand(original.id, orderId, authority, options);
        else if (!found) {
          const exact = await readFulfillmentCommands({ orderId, requestId: original.requestId, requestChecksum: original.requestChecksum }, authority, options);
          if (exact.truncated || exact.items.length > 1) throw new FulfillmentCommandRequestError(502, "原请求恢复范围无法核对 请保留原编号");
          found = exact.items[0];
        }
        if (!options.isCurrent()) return;
        if (found) {
          if (found.requestId !== original.requestId || found.requestChecksum !== original.requestChecksum || original.id && found.id !== original.id)
            throw new FulfillmentCommandRequestError(502, "读取到另一笔履约提交 未替换原请求");
          if (!next.some(item => item.id === found.id)) next = [found, ...next]; observed(found);
        } else setNotice("尚未找到本次原提交 不证明从未保存 请继续只读核对 不换键重新发送");
      }
      setItems(next.map(currentPrivateIndex)); setTruncated(page.truncated); setDenied(false);
      for (const item of next) {
        verified.current.add(item.id);
        if (item.status === "succeeded" && !notified.current.has(item.id)) { notified.current.add(item.id); callbacks.current.onChanged(); }
      }
    } catch (cause) { if (options.isCurrent()) { if (fulfillmentCommandDenied(cause)) deny(); else setError(fulfillmentCommandError(cause)); } }
    finally { if (options.isCurrent()) setReading(false); }
  }, [authority, deny, observed, orderId, valid]);
  useEffect(() => { void load(); }, [load, reload]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible" && navigator.onLine !== false && !sending.current) setReload(value => value + 1); };
    window.addEventListener("focus", refresh); window.addEventListener("pageshow", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("pageshow", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, []);
  useEffect(() => {
    const privateRows = items.filter(item => item.summary !== null || item.receipt !== null); if (!privateRows.length) return;
    const earliest = Math.min(...privateRows.map(item => Date.parse(item.expiresAt))), remaining = earliest - Date.now();
    const timer = setTimeout(() => {
      if (!valid()) return;
      verified.current.clear();
      setItems(previous => previous.map(currentPrivateIndex));
      setReload(value => value + 1);
    }, Math.max(0, Math.min(remaining, 2_147_483_647)));
    return () => clearTimeout(timer);
  }, [items, valid]);
  const blocked = !valid() || denied || reading || Boolean(error) || truncated || Boolean(pending) || items.some(item => !item.acknowledged)
    || Boolean(agentPermission && (!agentIntents.ready || agentIntents.items.some(item => item.orderId === orderId)));
  admission.current = { blocked, reading };
  const canPrepareAgent = agentPermission && agentIntents.ready && canWrite && (!proposalHandoff || !proposalHandoff.blocked);
  async function prepareAgent(command: PrepareFulfillmentCommand) {
    if (proposalHandoff) { await proposalHandoff.prepare(command); return; }
    if (!valid() || deniedRef.current || !live.current.canWrite || !live.current.agentPermission || sending.current || admission.current.blocked || !ownerScope)
      throw new FulfillmentCommandRequestError(409, "请先核对本单原提交及当前工作流权限 不重复保存准备");
    const token = epoch.current, controller = new AbortController(); sending.current = true; activeWrite.current = controller;
    admission.current.blocked = true; setWorking("agent-prepare"); setError(""); setNotice("");
    const options = { signal: controller.signal, isCurrent: () => valid(token) && live.current.canWrite && live.current.agentPermission && !controller.signal.aborted && !deniedRef.current };
    try {
      const workspace = await readAgentFulfillmentCommandWorkspace(authority, options);
      if (!workspace.capabilities.some(item => item.domain === "fulfillment" && item.kind === command.kind && item.available)) throw new FulfillmentCommandRequestError(403, "当前这项原履约准备未获授权");
      const prepared = await createAgentFulfillmentCommandIntent({ version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId, original: command }, ownerScope);
      if (!options.isCurrent()) throw new FulfillmentCommandRequestError(409, errorText(), "authority_changed");
      const marker = saveAgentFulfillmentCommandIntent(prepared.intent);
      if (!options.isCurrent()) throw new FulfillmentCommandRequestError(409, errorText(), "authority_changed");
      const result = await prepareAgentFulfillmentCommand(prepared.input, authority, options);
      if (!options.isCurrent()) throw new FulfillmentCommandRequestError(409, errorText(), "authority_changed");
      recordAgentFulfillmentCommandIntent({ ...marker, id: result.native.id, state: "known" });
      replace(result.native); verified.current.delete(result.native.id); setAgentPrepared({ id: result.native.id, orderId });
      setNotice("本次只交接原填写 未请求执行业务 请到 AI 工作台核对原实际状态和完整原文后逐笔明确执行");
      return result;
    } catch (cause) { if (valid(token)) { if (agentFulfillmentCommandDenied(cause) || fulfillmentCommandDenied(cause)) deny(); else setError(agentFulfillmentCommandError(cause)); } throw cause; }
    finally { sending.current = false; if (valid(token)) { setWorking(""); agentIntents.reload(); } }
  }
  async function submit(command: PrepareFulfillmentCommand) {
    if (proposalHandoff) throw new FulfillmentCommandRequestError(409, "当前是模型建议补项 请明确选择只准备 原执行须到全文核对区确认");
    if (!valid() || deniedRef.current || !live.current.canWrite || sending.current || admission.current.blocked)
      throw new FulfillmentCommandRequestError(409, "请先核对本单原履约提交 未知或未确认记录处理前不发送新请求");
    const token = epoch.current, controller = new AbortController(); sending.current = true; activeWrite.current = controller;
    admission.current.blocked = true;
    const options = { signal: controller.signal, isCurrent: () => valid(token) && live.current.canWrite && !controller.signal.aborted && !deniedRef.current };
    let original: PendingReference | null = null;
    verified.current.clear(); setWorking("new"); setError(""); setNotice("");
    try {
      const intent = await createFulfillmentCommandIntent(orderId, command); if (!options.isCurrent()) throw new FulfillmentCommandRequestError(409, errorText(), "authority_changed");
      original = { orderId, requestId: intent.command.requestId, requestChecksum: intent.requestChecksum, id: null, action: "prepare" };
      savePending(original);
      const prepared = await prepareFulfillmentCommand(intent, authority, options); if (!options.isCurrent()) throw new FulfillmentCommandRequestError(409, errorText(), "authority_changed");
      replace(prepared); original = { ...original, id: prepared.id, action: "execute" }; savePending(original); setWorking(prepared.id);
      const result = prepared.status === "succeeded" ? prepared : prepared.status === "prepared" && prepared.canExecute && Date.parse(prepared.expiresAt) > Date.now()
        ? await actOnFulfillmentCommand(prepared, "execute", authority, options, intent) : prepared;
      if (!options.isCurrent()) throw new FulfillmentCommandRequestError(409, errorText(), "authority_changed");
      replace(result); observed(result);
      if (result.status !== "succeeded" || !result.receipt) throw new FulfillmentCommandRequestError(409, "本次原执行尚未成功 请在同单恢复区只读核对原状态 不重复填写发送");
      verified.current.add(result.id); notified.current.add(result.id);
      setNotice("已取得本次原业务回执 请核对结果后确认已读"); callbacks.current.onChanged(); return result;
    } catch (cause) {
      if (valid(token)) { if (fulfillmentCommandDenied(cause)) deny(); else setError(fulfillmentCommandError(cause)); }
      throw cause;
    } finally { sending.current = false; if (valid(token)) setWorking(""); }
  }
  async function read(item: FulfillmentCommandView) {
    if (!valid() || deniedRef.current || sending.current) return;
    const token = epoch.current, current = ++sequence.current, controller = new AbortController(); activeRead.current?.abort(); activeRead.current = controller;
    const options = { signal: controller.signal, isCurrent: () => valid(token) && !controller.signal.aborted && current === sequence.current };
    admission.current = { blocked: true, reading: true };
    verified.current.delete(item.id); setReading(true); setError("");
    try {
      const value = await readFulfillmentCommand(item.id, orderId, authority, options);
      if (value.requestId !== item.requestId || value.requestChecksum !== item.requestChecksum || value.kind !== item.kind || value.targetId !== item.targetId
        || value.lineIds.length !== item.lineIds.length || !value.lineIds.every(line => item.lineIds.includes(line)))
        throw new FulfillmentCommandRequestError(502, "原提交的固定身份已变化 未采用替代回执");
      if (options.isCurrent()) {
        verified.current.add(value.id); replace(value); observed(value);
        if (value.status === "succeeded" && !notified.current.has(value.id)) { notified.current.add(value.id); callbacks.current.onChanged(); }
      }
    }
    catch (cause) { if (options.isCurrent()) { if (fulfillmentCommandDenied(cause)) deny(); else setError(fulfillmentCommandError(cause)); } }
    finally { if (options.isCurrent()) setReading(false); }
  }
  async function act(item: FulfillmentCommandView, action: "execute" | "cancel" | "acknowledge") {
    if (!valid() || deniedRef.current || sending.current || admission.current.reading || action !== "acknowledge" && !live.current.canWrite || !verified.current.has(item.id)
      || action === "execute" && (!item.canExecute || Date.parse(item.expiresAt) <= Date.now()) || action === "cancel" && !item.canCancel
      || action === "acknowledge" && !["succeeded", "rejected", "cancelled", "expired"].includes(item.status)) return;
    if (agentIntents.items.some(marker => marker.orderId === item.orderId && marker.requestId === item.requestId && marker.requestChecksum === item.requestChecksum)) return;
    if (action === "cancel" && !window.confirm("只取消这笔未完成的原履约提交\n" + item.id + "\n不会撤销已发生的生产 工厂回执或交运事实")) return;
    const token = epoch.current, controller = new AbortController(); sending.current = true; activeWrite.current = controller;
    const options = { signal: controller.signal, isCurrent: () => valid(token) && (action === "acknowledge" || live.current.canWrite) && !controller.signal.aborted && !deniedRef.current };
    admission.current.blocked = true;
    verified.current.clear(); savePending({ orderId, requestId: item.requestId, requestChecksum: item.requestChecksum, id: item.id, action }); setWorking(item.id); setError(""); setNotice("");
    try {
      const value = await actOnFulfillmentCommand(item, action, authority, options); if (!options.isCurrent()) return;
      replace(value); observed(value);
      if (["succeeded", "rejected", "cancelled", "expired", "acknowledged"].includes(value.status)) verified.current.add(value.id);
      if (action === "acknowledge" && value.acknowledged) setNotice("本次原结果已确认 私有摘要已清除 原业务历史保持");
      else if (value.status === "succeeded") setNotice("已找回原业务回执 未建立第二笔原请求");
      callbacks.current.onChanged();
    } catch (cause) { if (valid(token)) { if (fulfillmentCommandDenied(cause)) deny(); else setError(fulfillmentCommandError(cause)); } }
    finally { sending.current = false; if (valid(token)) setWorking(""); }
  }
  function refresh() {
    if (purged.current || !canRead || sending.current) return;
    if (deniedRef.current) { deniedRef.current = false; epoch.current++; }
    admission.current = { blocked: true, reading: true }; verified.current.clear();
    setReload(value => value + 1);
  }
  const isAgentPreparation = (item: FulfillmentCommandView) => agentIntents.items.some(marker => marker.orderId === item.orderId && marker.requestId === item.requestId && marker.requestChecksum === item.requestChecksum);
  const value: RecoveryState = { orderId, returnQuery, blocked, busy: Boolean(working), submit, canPrepareAgent, prepareAgent, items, reading, error, notice, truncated, pending, isAgentPreparation,
    canRead, canWrite, denied, cleared, working, refresh, read, act, verified: id => verified.current.has(id) };
  return <CommandContext.Provider value={value}>
    {agentPrepared && valid() && <p className="oc-notice"><Link className="afc-handoff-link" href={agentHref(agentPrepared.orderId, agentPrepared.id, returnQuery)}>到 AI 工作台核对原履约准备</Link> 本次只保存准备 不表示已执行</p>}
    {valid() && agentIntents.items.some(item => item.orderId === orderId) && !agentPrepared && <p className="oc-notice">本单有原 Agent 履约准备待核对 <Link href={agentHref(orderId, undefined, returnQuery)}>只读恢复原履约准备</Link> 不换键重复提交</p>}
    {cleared || denied || !canRead ? <div className="oc-fulfillment-recovery"><FulfillmentCommandRecovery />
      <p role="status">本单旧私有内容已隐藏 原业务请求仍由服务端保存 读取成功前不发起新提交</p></div> : children}
  </CommandContext.Provider>;
}
function errorText() { return "当前本人身份或授权已变化 不采用迟到响应 请读取原提交"; }
function agentHref(orderId: string, commandId?: string, original = "") {
  const query = new URLSearchParams(original); query.set("order", orderId);
  if (commandId) query.set("agentFulfillmentCommand", commandId); else query.delete("agentFulfillmentCommand");
  return "/ai-tasks?" + query;
}

export function FulfillmentCommandRecovery({ compact = false }: { compact?: boolean } = {}) {
  const state = useContext(CommandContext);
  if (!state) return null;
  const needsAttention = state.blocked || state.reading || state.busy || !!state.error || !!state.notice
    || state.denied || state.cleared || !!state.pending || state.truncated || !state.canRead
    || state.items.some(item => !item.acknowledged);
  const content = <section className="oc-fulfillment-recovery" aria-label="本单原履约提交恢复" aria-busy={state.reading || state.busy}>
    <header><h3><FileSearch size={15} aria-hidden="true" />本单原履约提交恢复</h3><button type="button" className="oc-text-button" disabled={!state.canRead || state.cleared || state.busy || state.reading} onClick={state.refresh}><RefreshCw size={14} />只读核对本单原提交</button></header>
    <p className="oc-hint">原交付 生产 质检与出库分别保留 关闭或刷新不会撤销已提交操作 读取不执行 原结果核对前暂停新的相关提交</p>
    {state.reading && <p role="status">正在读取本人同单原提交</p>}{state.error && <p role="alert" className="oc-error">{state.error}</p>}{state.notice && <p role="status" className="oc-notice">{state.notice}</p>}
    {state.cleared && <p role="status">本人会话已清除 迟到响应不会重新显示旧回执</p>}
    {state.pending && <div className="oc-fulfillment-pending" role="status"><p>本次{state.pending.action === "prepare" ? "保存" : state.pending.action === "execute" ? "执行" : state.pending.action === "cancel" ? "取消" : "确认已读"}结果待核对 只读取原记录 不换键</p><code>{state.pending.requestId}</code><code>{state.pending.requestChecksum}</code></div>}
    {!state.reading && !state.error && !state.items.some(item => !item.acknowledged) && !state.pending && <p className="oc-hint">本次读取没有未核对的原履约提交</p>}
    {state.items.map(item => <article key={item.id} hidden={item.acknowledged} className="oc-fulfillment-recovery-item" aria-label={`原履约提交 ${item.id}`}>
      <header><strong>{names[item.kind]} · {states[item.status]}</strong><time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time></header>
      {item.summary ? <p>{item.summary.orderNumber} · {item.summary.lineCount} 个商品 · {item.summary.label}</p> : <p className="oc-hint">原资料不可读取或已到期 仅保留原提交索引 不从今天的业务补造历史</p>}
      <dl><div><dt>原提交 ID</dt><dd><code>{item.id}</code></dd></div><div><dt>原请求 ID</dt><dd><code>{item.requestId}</code></dd></div><div><dt>原请求校验值</dt><dd><code>{item.requestChecksum}</code></dd></div></dl>
      {item.receipt && <FulfillmentCommandReceiptSummary value={item} />}
      {item.status === "executing" && <p className="oc-hint">等待原执行结束或租约到期 不能同时发起第二笔操作</p>}
      {item.status === "uncertain" && <p className="oc-hint">原结果未知 先只读核对 只有服务器允许时才能手动按同一原提交恢复</p>}
      {item.status === "rejected" && <p className="oc-hint">本次未完成 请核对原对象及版本 确认该结果后才填写新请求</p>}
      <div className="oc-fulfillment-recovery-actions"><button type="button" className="oc-button" disabled={state.busy || state.reading || state.denied || state.cleared} onClick={() => void state.read(item)}><RefreshCw size={13} />只读取这笔原提交</button>
        {state.isAgentPreparation(item) || ["prepared", "uncertain"].includes(item.status) && !item.canExecute && !item.summary ? <Link className="oc-text-button" href={agentHref(item.orderId, item.id, state.returnQuery)}>到 AI 工作台明确核对后执行</Link>
          : item.canExecute && <button type="button" className="oc-button" disabled={!state.canWrite || state.busy || state.reading || state.denied || state.cleared || !state.verified(item.id)} onClick={() => void state.act(item, "execute")}><RotateCcw size={13} />按原确认恢复执行</button>}
        {item.canCancel && !state.isAgentPreparation(item) && <button type="button" className="oc-button" disabled={!state.canWrite || state.busy || state.reading || state.denied || state.cleared || !state.verified(item.id)} onClick={() => void state.act(item, "cancel")}><X size={13} />取消未完成的原提交</button>}
        {["succeeded", "rejected", "cancelled", "expired"].includes(item.status) && !state.isAgentPreparation(item) && <button type="button" className="oc-button" disabled={!state.canRead || state.busy || state.reading || state.denied || state.cleared || !state.verified(item.id)} onClick={() => void state.act(item, "acknowledge")}><Check size={13} />已核对本次履约结果</button>}
      </div>
    </article>)}
    {state.truncated && <p role="status" className="oc-hint">仍有未显示的原提交 当前目录有界 未读尽前不开放新提交 请核对当前结果后重新读取</p>}
  </section>;
  // Presentation only: the provider and its recovery/admission checks stay mounted.
  return compact && !needsAttention
    ? <details className="oc-recovery-history"><summary><FileSearch size={14} aria-hidden="true" />已提交操作与恢复记录</summary>{content}</details>
    : content;
}
export function FulfillmentCommandReceiptSummary({ value }: { value: FulfillmentCommandView }) {
  const receipt = value.receipt; if (!receipt) return null;
  const rows: Array<[string, string]> = [];
  switch (receipt.kind) {
    case "delivery_create": rows.push(["原交付包", receipt.packageId], ["原清单校验值", receipt.packageChecksum], ...receipt.itemIds.map(item => ["原交付项", item] as [string, string])); break;
    case "delivery_feedback": rows.push(["原交付包", receipt.packageId], ["原交付项", receipt.itemId], ["实际工厂回执", receipt.feedbackId], ["原序号", String(receipt.sequence)]); break;
    case "production_milestone": rows.push(["原生产单", receipt.productionOrderId], ["实际进度事件", receipt.eventId], ["原序号", String(receipt.sequence)]); break;
    case "quality_inspection": rows.push(["原生产单", receipt.productionOrderId], ["实际质检", receipt.inspectionId]); break;
    case "quality_group_inspection": rows.push(["原生产单", receipt.productionOrderId], ["实际质检", receipt.inspectionId], ...receipt.groupIds.map(item => ["实际实物组", item] as [string, string])); break;
    case "production_recovery": rows.push(["原补做记录", receipt.recoveryId], ["关联生产单", receipt.replacementProductionOrderId ?? "本类原回执未建立生产单"]); break;
    case "whole_production_milestone": for (const item of receipt.items) rows.push(["原生产单", item.productionOrderId], ["实际进度事件", item.eventId], ["原序号", String(item.sequence)]); break;
    case "whole_quality_inspection": for (const item of receipt.items) rows.push(["原生产单", item.productionOrderId], ["实际质检", item.inspectionId]); break;
    case "shipment_create": case "whole_shipment_create": case "shipment_version": rows.push(["原发货单", receipt.shipmentId], ["固定原版本", `${receipt.versionNumber} · ${receipt.versionId}`]); break;
    case "shipment_review": rows.push(["原发货单", receipt.shipmentId], ["原版本", receipt.versionId], ["实际审核", receipt.reviewId]); break;
    case "shipment_dispatch": rows.push(["原发货单", receipt.shipmentId], ...receipt.trackingEventIds.map(item => ["实际交运事件", item] as [string, string])); break;
    case "shipment_platform_confirmation": rows.push(["原发货单", receipt.shipmentId], ["原版本", receipt.versionId], ["实际人工平台确认", receipt.confirmationId]); break;
  }
  const query = new URLSearchParams({ line: value.lineIds[0]!, order: value.orderId });
  if (receipt.kind === "delivery_create") query.set("delivery", receipt.packageId);
  return <div className="oc-fulfillment-receipt" aria-label="原业务履约回执"><p className="oc-notice">已读取原业务拥有者保存的实际回执 不是重新执行</p><dl>{rows.map(([label, content], index) => <div key={`${label}:${index}`}><dt>{label}</dt><dd><code>{content}</code></dd></div>)}</dl>
    {receipt.kind === "delivery_create" && <Link className="oc-text-button" href={`/production?${query}`}>读取该原交付包</Link>}
    {(receipt.kind.startsWith("shipment_") || receipt.kind === "whole_shipment_create") && <Link className="oc-text-button" href={`/shipments?${query}`}>核对本单原发货记录</Link>}
  </div>;
}
