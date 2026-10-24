"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useSearchParams } from "next/navigation";
import { Check, ClipboardList, FileSearch, RefreshCw, RotateCcw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import type { AgentCommandIntent, AgentCommandReceipt, AgentCommandView, AgentCommandWorkspace } from "@yummyai/contracts/ai/agent-command";
import { useErpAccess } from "../identity/erp-access";
import { TaskDrawer } from "../navigation/task-drawer";
import {
  AGENT_OPERATION_CLEAR_EVENT, AgentOperationRequestError, actOnAgentOperation, agentOperationDenied, agentOperationError,
  forgetAgentOperationIntent, readAgentOperationIntents, readAgentOperationReceipt, readAgentOperationRequest,
  readAgentOperationWorkspace, updateAgentOperationIntent, useAgentOperationIntents,
} from "./agent-operation-client";
import { AgentOperationNativeSummary, AgentOperationOriginalSummary, AgentOperationPair, agentOperationDomainNames, agentOperationName, agentOperationStateNames } from "./agent-operation-summary";
import "./agent-operation.css";

function selectOperation(value: string | null) {
  const url = new URL(window.location.href); if (value) url.searchParams.set("agentCommand", value); else url.searchParams.delete("agentCommand");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}
export function AgentOperationWorkbench() {
  const access = useErpAccess(), identity = useRef({ authority: access.authority, scope: access.preferenceScope });
  identity.current = { authority: access.authority, scope: access.preferenceScope };
  if (!access.authority || !access.preferenceScope) return <section className="agent-operation" aria-label="Agent 操作核对"><h2><ClipboardList size={17} />Agent 操作核对</h2><p role="status">正在核对当前本人身份 暂不读取或执行操作</p></section>;
  return <AgentOperationContent key={access.authority + ":" + access.preferenceScope} identity={identity} />;
}
function AgentOperationContent({ identity }: { identity: RefObject<{ authority: string | null; scope: string | null }> }) {
  const access = useErpAccess(), authority = access.authority!, preferenceScope = access.preferenceScope!, params = useSearchParams();
  const canRead = access.can(Permission.WorkflowRead), canRun = access.can(Permission.WorkflowRun), intents = useAgentOperationIntents(preferenceScope);
  const raw = params.get("agentCommand"), parsed = EntityIdSchema.safeParse(raw), selected = params.getAll("agentCommand").length === 1 && parsed.success ? parsed.data.toLowerCase() : null;
  const current = useRef({ authority, preferenceScope, selected, canRead, canRun }); current.current = { authority: access.authority ?? "", preferenceScope: access.preferenceScope ?? "", selected, canRead, canRun };
  const alive = useRef(true), cleared = useRef(false), epoch = useRef(0), blocked = useRef(false), [lost, setLost] = useState(false), [denied, setDenied] = useState(false);
  const workspaceSequence = useRef(0), workspaceAbort = useRef<AbortController | null>(null), readSequence = useRef(0), readAbort = useRef<AbortController | null>(null), receiptSequence = useRef(0), receiptAbort = useRef<AbortController | null>(null);
  const actionLease = useRef<symbol | null>(null), readBusy = useRef(false), [pending, setPending] = useState(false);
  const [workspace, setWorkspace] = useState<AgentCommandWorkspace | null>(null), [workspaceReading, setWorkspaceReading] = useState(false), [workspaceError, setWorkspaceError] = useState("");
  const [view, setView] = useState<AgentCommandView | null>(null), viewRef = useRef<AgentCommandView | null>(null), [reading, setReading] = useState(false), [error, setError] = useState(""), [uncertain, setUncertain] = useState(false), [confirmed, setConfirmed] = useState(false), [tokenExpired, setTokenExpired] = useState(false);
  const [idDraft, setIdDraft] = useState(raw ?? ""), [receipt, setReceipt] = useState<AgentCommandReceipt | null>(null), [receiptReading, setReceiptReading] = useState<string | null>(null), [receiptError, setReceiptError] = useState("");
  const markerOwner = useRef(intents.ownerScope); markerOwner.current = intents.ownerScope;
  const valid = useCallback((token = epoch.current) => alive.current && !cleared.current && token === epoch.current && identity.current.authority === authority && identity.current.scope === preferenceScope && current.current.authority === authority && current.current.preferenceScope === preferenceScope, [authority, preferenceScope, identity]);
  const readable = useCallback(() => valid() && !blocked.current && current.current.canRead, [valid]);
  const clearPrivate = useCallback(() => { workspaceSequence.current++; readSequence.current++; receiptSequence.current++; workspaceAbort.current?.abort(); readAbort.current?.abort(); receiptAbort.current?.abort();
    readBusy.current = false; setWorkspace(null); setView(null); viewRef.current = null; setReceipt(null); setConfirmed(false); setIdDraft(""); setReading(false); setWorkspaceReading(false); setReceiptReading(null); setTokenExpired(false); }, []);
  const deny = useCallback(() => { blocked.current = true; clearPrivate(); setDenied(true); window.dispatchEvent(new Event("focus")); }, [clearPrivate]);
  useLayoutEffect(() => { alive.current = true;
    const clear = () => { cleared.current = true; epoch.current++; actionLease.current = null; clearPrivate(); setPending(false); setError(""); setWorkspaceError(""); setReceiptError(""); setLost(true); };
    window.addEventListener(AGENT_OPERATION_CLEAR_EVENT, clear);
    return () => { alive.current = false; epoch.current++; actionLease.current = null; workspaceSequence.current++; readSequence.current++; receiptSequence.current++; workspaceAbort.current?.abort(); readAbort.current?.abort(); receiptAbort.current?.abort(); window.removeEventListener(AGENT_OPERATION_CLEAR_EVENT, clear); };
  }, [clearPrivate]);
  const reloadWorkspace = useCallback(async () => {
    if (!readable()) return; const token = epoch.current, sequence = ++workspaceSequence.current, abort = new AbortController(); workspaceAbort.current?.abort(); workspaceAbort.current = abort; setWorkspaceReading(true); setWorkspaceError("");
    try { const value = await readAgentOperationWorkspace(authority, abort.signal); if (valid(token) && readable() && sequence === workspaceSequence.current && !abort.signal.aborted) setWorkspace(value); }
    catch (failure) { if (valid(token) && sequence === workspaceSequence.current && !abort.signal.aborted) { if (agentOperationDenied(failure)) deny(); else setWorkspaceError(agentOperationError(failure)); } }
    finally { if (valid(token) && sequence === workspaceSequence.current) setWorkspaceReading(false); }
  }, [authority, valid, readable, deny]);
  useEffect(() => { void reloadWorkspace(); }, [reloadWorkspace]);
  const remember = useCallback((value: AgentCommandView) => {
    if (!markerOwner.current) return;
    const marker = readAgentOperationIntents(markerOwner.current).find(item => item.requestId === value.requestId); if (!marker) return;
    if (marker.requestChecksum !== value.requestChecksum || marker.id !== null && marker.id !== value.id) throw new AgentOperationRequestError(502, "原操作与保存的请求摘要不一致 未采用替代记录");
    updateAgentOperationIntent({ ...marker, state: "known", id: value.id });
  }, []);
  const load = useCallback(async (id: string) => {
    if (!readable() || actionLease.current || readBusy.current || current.current.selected !== id) return;
    const token = epoch.current, sequence = ++readSequence.current, abort = new AbortController(); readAbort.current?.abort(); readAbort.current = abort; setReading(true); setError(""); setConfirmed(false); setTokenExpired(false);
    // Only a newly read token can be confirmed. The prior one is never reusable.
    readBusy.current = true;
    const prior = viewRef.current ? { ...viewRef.current, confirmationToken: null, confirmationExpiresAt: null, canConfirm: false } : null;
    viewRef.current = prior; setView(prior);
    try {
      const value = await readAgentOperationRequest(id, authority, abort.signal);
      if (!valid(token) || !readable() || sequence !== readSequence.current || abort.signal.aborted || current.current.selected !== id) return;
      remember(value); viewRef.current = value; setView(value); setUncertain(["preparing", "executing", "unknown"].includes(value.state));
    } catch (failure) {
      if (!valid(token) || sequence !== readSequence.current || abort.signal.aborted || current.current.selected !== id) return;
      if (agentOperationDenied(failure) && (!(failure instanceof AgentOperationRequestError) || failure.status !== 404 || viewRef.current?.id === id)) deny();
      else { setError(agentOperationError(failure)); if (failure instanceof AgentOperationRequestError && failure.status === 404) { setView(null); viewRef.current = null; } }
    } finally { if (sequence === readSequence.current) { readBusy.current = false; if (valid(token)) setReading(false); } }
  }, [authority, valid, readable, deny, remember]);
  useEffect(() => { readSequence.current++; readAbort.current?.abort(); readBusy.current = false; setView(null); viewRef.current = null; setError(""); setConfirmed(false); setUncertain(false); setReading(false); setTokenExpired(false);
    if (selected) { setIdDraft(selected); void load(selected); }
  }, [selected, load]);
  useEffect(() => {
    if (!selected || !view || !readable()) return;
    const refresh = () => { if (document.visibilityState === "visible" && !actionLease.current) void load(selected); };
    window.addEventListener("focus", refresh);
    const timer = ["preparing", "executing", "unknown"].includes(view.state) ? setInterval(refresh, 4000) : null;
    return () => { window.removeEventListener("focus", refresh); if (timer) clearInterval(timer); };
  }, [selected, view?.state, load, readable]);
  useEffect(() => {
    if (!view?.confirmationExpiresAt || !view.canConfirm) return;
    const id = view.id, expiresAt = view.confirmationExpiresAt, remaining = Date.parse(expiresAt) - Date.now();
    const timer = setTimeout(() => { if (valid() && viewRef.current?.id === id && viewRef.current.confirmationExpiresAt === expiresAt) {
      setConfirmed(false); setTokenExpired(true); const value = { ...viewRef.current, confirmationToken: null, confirmationExpiresAt: null, canConfirm: false }; viewRef.current = value; setView(value);
    } }, Math.max(0, Math.min(remaining, 2_147_483_647))); return () => clearTimeout(timer);
  }, [view?.id, view?.canConfirm, view?.confirmationExpiresAt, valid]);
  useEffect(() => {
    if (!view?.privateAvailable) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => { const remaining = Date.parse(view.expiresAt) - Date.now(); if (remaining > 0) { timer = setTimeout(expire, Math.min(remaining, 2_147_483_647)); return; }
      if (valid() && viewRef.current?.id === view.id) { const value = { ...view, privateAvailable: false, snapshot: null, confirmationToken: null, confirmationExpiresAt: null, canConfirm: false }; viewRef.current = value; setView(value); setConfirmed(false); }
    }; expire(); return () => clearTimeout(timer);
  }, [view, valid]);
  function open(id: string | null) {
    if (actionLease.current) return; readSequence.current++; readAbort.current?.abort(); readBusy.current = false; setConfirmed(false); setView(null); viewRef.current = null; setError(""); setReading(false); setUncertain(false);
    if (id && current.current.selected === id) void load(id); else selectOperation(id);
  }
  async function recover(marker: AgentCommandIntent) {
    if (!readable() || receiptReading || actionLease.current) return;
    const token = epoch.current, sequence = ++receiptSequence.current, abort = new AbortController(); receiptAbort.current?.abort(); receiptAbort.current = abort; setReceiptReading(marker.requestId); setReceipt(null); setReceiptError("");
    try { const result = await readAgentOperationReceipt({ requestId: marker.requestId, requestChecksum: marker.requestChecksum }, authority, abort.signal);
      if (!valid(token) || !readable() || abort.signal.aborted || sequence !== receiptSequence.current) return;
      if (result.disposition === "known") { if (marker.id && marker.id !== result.id) throw new AgentOperationRequestError(502, "原回执与已知操作 ID 不一致"); updateAgentOperationIntent({ ...marker, state: "known", id: result.id }); }
      setReceipt(result);
    } catch (failure) { if (valid(token) && !abort.signal.aborted && sequence === receiptSequence.current) { if (agentOperationDenied(failure)) deny(); else setReceiptError(agentOperationError(failure)); } }
    finally { if (valid(token) && sequence === receiptSequence.current) setReceiptReading(null); }
  }
  async function act(action: "confirm" | "cancel" | "acknowledge") {
    const original = viewRef.current;
    if (!original || original.id !== selected || actionLease.current || readBusy.current || reading || uncertain || !readable() || !current.current.canRun ||
      action === "confirm" && (!confirmed || !original.canConfirm || !original.privateAvailable || Date.parse(original.expiresAt) <= Date.now() || !original.snapshot?.native.view.canExecute || original.snapshot.native.view.status !== "prepared" || !original.confirmationExpiresAt || Date.parse(original.confirmationExpiresAt) <= Date.now()) || action === "cancel" && !original.canCancel) return;
    const token = epoch.current, lease = Symbol("agent-operation-action"); actionLease.current = lease; setPending(true); setError(""); setConfirmed(false);
    const frozen = { ...original, confirmationToken: null, confirmationExpiresAt: null, canConfirm: false }; viewRef.current = frozen; setView(frozen);
    try {
      const result = await actOnAgentOperation(original, action, authority);
      if (!valid(token) || current.current.selected !== original.id) return;
      viewRef.current = result; setView(result); setUncertain(["unknown", "executing", "preparing"].includes(result.state));
      if (action === "acknowledge" && result.snapshot?.native.view.acknowledged && intents.ownerScope) {
        for (const marker of readAgentOperationIntents(intents.ownerScope)) if (marker.requestId === result.requestId && marker.requestChecksum === result.requestChecksum) forgetAgentOperationIntent(marker);
      }
    } catch (failure) { if (valid(token) && current.current.selected === original.id) { if (agentOperationDenied(failure)) deny(); else setUncertain(true); setError(agentOperationError(failure)); } }
    finally { if (actionLease.current === lease) { actionLease.current = null; if (valid(token)) { setPending(false); intents.reload(); } } }
  }
  if (lost) return <section className="agent-operation" aria-label="Agent 操作核对"><h2><ClipboardList size={17} />Agent 操作核对</h2><p role="status">本人会话已清除 原文与确认已隐藏 请重新核对身份</p></section>;
  const retained = readable() && view?.id === selected && view.contextAuthority === authority ? view : null;
  const visible = retained && Date.parse(retained.expiresAt) <= Date.now() ? { ...retained, snapshot: null, privateAvailable: false, confirmationToken: null, confirmationExpiresAt: null, canConfirm: false } : retained;
  const native = visible?.snapshot?.native.view;
  const confirmable = visible?.canConfirm && native?.status === "prepared" && native.canExecute;
  const acknowledged = native?.acknowledged ?? false;
  const canAcknowledge = native && !acknowledged && ("canAcknowledge" in native ? native.canAcknowledge : ["succeeded", "cancelled", "rejected", "expired"].includes(native.status));
  return <section className="agent-operation" aria-label="Agent 操作核对"><header className="ao-heading"><div><h2><ClipboardList size={17} />Agent 操作核对</h2><p className="ao-muted">核对原业务准备 逐笔确认执行 原读取循环和九类分析入口继续保留</p></div><button type="button" disabled={!readable() || workspaceReading || pending} onClick={() => void reloadWorkspace()}><RefreshCw size={14} />重新读取操作能力</button></header>
    <p className="ao-notice">当前由原业务核对页交接已准备命令 引用不等于业务已执行 模型尚不能自主写入 MCP 尚未连接</p>
    {(!canRead || denied) && <p role="status" className="ao-notice">当前工作流读取权限尚未核对或已变化 原文和确认已隐藏 原业务页面仍按其自身权限使用</p>}
    {workspaceReading && <p role="status">正在读取当前操作能力与近期原请求</p>}{workspaceError && <p role="alert" className="ao-error">{workspaceError}</p>}
    {workspace && readable() && <details><summary>当前登记的原业务准备能力 · {workspace.capabilities.length} 项</summary><p className="ao-muted">可准备只表示可调用原命令拥有者 执行仍需当前人员的明确确认与原业务规则核验</p><ul className="ao-capabilities">{workspace.capabilities.map(item => <li key={item.domain + ":" + item.kind}><strong>{item.label}</strong><span>{agentOperationDomainNames[item.domain]} · {item.available ? "当前可准备" : "当前不可准备"} · {item.externalEffect === "original_production_release" ? "原生产下达影响" : "内部业务登记"}</span>{item.blockReason && <small>原阻断代码 <code>{item.blockReason}</code></small>}</li>)}</ul></details>}
    <section className="ao-recovery" aria-label="本人 Agent 操作原请求恢复"><h3><FileSearch size={15} />本人 Agent 操作原请求恢复</h3><p className="ao-muted">仅保存本人请求 ID 和摘要 不保存原正文 原键或确认凭据 读取不会执行业务</p>
      {!intents.ready && !intents.error && <p role="status">正在核对本人原请求标识</p>}{intents.error && <p role="alert" className="ao-error">{intents.error}</p>}
      {intents.ready && !intents.markers.length && <p>本标签页没有原操作恢复标识 可按真实 Agent 操作 ID 读取</p>}
      {intents.markers.map(marker => <article key={marker.requestId} aria-label={"原 Agent 操作请求 " + marker.requestId}><h4>原请求 <code>{marker.requestId}</code></h4><p>{marker.state === "known" ? "已取得原操作 ID" : "原交接响应尚未核对 不再次提交或换键"}</p>
        <div className="ao-actions"><button type="button" disabled={!readable() || Boolean(receiptReading) || pending} onClick={() => void recover(marker)}>只读取原操作回执</button>{marker.id && <button type="button" disabled={!readable() || pending} onClick={() => open(marker.id)}>核对这笔原操作</button>}</div></article>)}
      {receiptReading && <p role="status">正在只读核对原操作回执</p>}{receiptError && <p role="alert" className="ao-error">{receiptError}</p>}
      {receipt && <section className="ao-receipt" aria-label="已找回的原操作回执"><h4>原操作回执</h4><p>原请求 <code>{receipt.requestId}</code></p>{receipt.disposition === "not_found" ? <p className="ao-notice">尚未找到原回执 不等于原交接未登记 不自动重发 请继续只读核对</p> : <><p>Agent 操作 <code>{receipt.id}</code> · 原业务命令 <code>{receipt.ownerCommandId ?? "尚未取得"}</code></p><button type="button" disabled={!readable() || pending} onClick={() => open(receipt.id)}>核对找回的原操作</button></>}</section>}
    </section>
    {canRead && !denied && <><form className="ao-id-form" aria-label="按原 ID 读取 Agent 操作" onSubmit={event => { event.preventDefault(); const result = EntityIdSchema.safeParse(idDraft.trim()); if (result.success) open(result.data.toLowerCase()); else setError("请填写真实有效的 Agent 操作 ID"); }}><label>Agent 操作 ID<input value={idDraft} onChange={event => setIdDraft(event.target.value)} /></label><button disabled={reading || pending || !readable()}>按操作 ID 读取</button></form>
      {!selected && error && <p role="alert" className="ao-error">{error}</p>}
      {workspace && <details><summary>近期本人操作引用 · 已载入 {workspace.recent.length} 条{workspace.recentHasMore ? " 仍有更早原请求" : ""}</summary><p className="ao-muted">近期最多 {workspace.recentLimit} 条 不代表完整历史 更早记录可按原 ID 读取</p><ul className="ao-recent">{workspace.recent.map(item => <li key={item.id}><button type="button" disabled={pending} onClick={() => open(item.id)}><strong>{agentOperationName(item.domain, item.kind)}</strong><code>{item.id}</code><small>{item.createdAt}</small></button></li>)}</ul>{!workspace.recent.length && <p>当前没有近期本人操作引用</p>}</details>}
    </>}
    {raw && !selected && <p role="alert" className="ao-error">网址中的 Agent 操作 ID 无效 未读取替代记录</p>}
    {selected && <TaskDrawer title="核对 Agent 原操作" description="读取原业务准备 只有明确确认才执行" recordKey={selected} className="agent-operation-drawer" state={{ dirty: false, busy: pending, loading: reading }} onClose={() => open(null)} closeLabel="关闭操作核对" contentUnavailable={!readable()}
      footer={<div className="ao-actions">{visible?.canCancel && <button type="button" disabled={reading || pending || uncertain || Boolean(error) || !canRun} onClick={() => void act("cancel")}><RotateCcw size={14} />取消这笔原准备</button>}
        {confirmable && <button type="button" className="ao-primary" disabled={!confirmed || reading || pending || uncertain || Boolean(error) || !canRun} onClick={() => void act("confirm")}><Check size={14} />确认执行这笔原操作</button>}
        {canAcknowledge && <button type="button" disabled={reading || pending || uncertain || Boolean(error) || !canRun} onClick={() => void act("acknowledge")}>确认结果并清除原填写副本</button>}</div>}>
      <section className="agent-operation ao-review" aria-label="核对 Agent 原操作" aria-busy={reading || pending}><header><h3>{visible ? agentOperationName(visible.domain, visible.kind) : "本人原操作"}</h3><button type="button" disabled={!readable() || reading || pending} onClick={() => void load(selected)}><RefreshCw size={14} />重新读取原操作</button></header>
        <p>Agent 操作 ID <code>{selected}</code></p><p className="ao-muted">关闭只收起核对 不取消准备 不撤销已经登记的事实</p>
        {reading && <p role="status">正在读取原正文与当前确认依据 不执行业务</p>}{pending && <p role="status">正在处理这笔原操作 请等待读取实际回执</p>}{error && <p role="alert" className="ao-error">{error}</p>}
        {uncertain && <p role="status" className="ao-notice">原执行结果未知 只按这笔原请求 ID 重新读取 判明实际状态后再操作 不重发执行或替换原键</p>}
        {visible && <><dl className="ao-pairs"><AgentOperationPair label="Agent 引用状态">{agentOperationStateNames[visible.state]}</AgentOperationPair><AgentOperationPair label="原请求 ID"><code>{visible.requestId}</code></AgentOperationPair><AgentOperationPair label="原业务命令 ID"><code>{visible.ownerCommandId ?? "尚未取得"}</code></AgentOperationPair><AgentOperationPair label="原请求校验值"><code>{visible.requestChecksum}</code></AgentOperationPair><AgentOperationPair label="原完整正文校验值"><code>{visible.originalChecksum ?? "当前不可核对"}</code></AgentOperationPair><AgentOperationPair label="原引用保留至">{visible.expiresAt}</AgentOperationPair></dl>
          {visible.errorCode && <p className="ao-notice">原核对代码 <code>{visible.errorCode}</code> 请核对原业务状态 不自动重建输入</p>}
          {visible.snapshot ? <><AgentOperationNativeSummary snapshot={visible.snapshot} /><AgentOperationOriginalSummary key={visible.id + ":" + visible.originalChecksum} snapshot={visible.snapshot} /></> : <p className="ao-notice">原私文当前不可读取或已到期 只保留原 ID 与状态 不从当前业务数据补原文</p>}
          {tokenExpired && <p role="status" className="ao-notice">本次确认凭据已到期 请重新读取原操作再明确核对</p>}
          {confirmable && <label className="ao-confirm"><input type="checkbox" checked={confirmed} disabled={reading || pending || uncertain || Boolean(error) || !canRun} onChange={event => setConfirmed(event.target.checked)} />我已核对这笔原目标 原版本 全部原填写与业务影响 明确执行原提交</label>}
          {!canRun && <p className="ao-notice">当前只可读取原操作 没有工作流运行权限 不确认 取消或清理原填写</p>}
          {acknowledged && <p role="status">原填写副本已确认清理 原实际业务结果不因此撤销</p>}
        </>}
      </section>
    </TaskDrawer>}
  </section>;
}
