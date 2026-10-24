"use client";

import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, CloudSync, History, LoaderCircle, RefreshCw, Server, ShieldCheck, Square } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { type CreateStoreNodeExecutionInput, type StoreNodeExecutionHistory, type StoreNodeExecutionPhase, type StoreNodeExecutionState,
  type StoreNodeExecutionSummary, type StoreNodeExecutionView, type StoreNodeExecutionWorkspace as Workspace } from "@yummyai/contracts/marketplace/store-node-execution";
import { ErpIdentityContext, useErpAccess } from "../identity/erp-access";
import { marketplaceAuthorityDigest } from "./marketplace-lifecycle";
import { cancelStoreNodeExecution, createStoreNodeExecution, readStoreNodeExecution, readStoreNodeExecutionHistory, readStoreNodeExecutionReceipt,
  readStoreNodeExecutionWorkspace, StoreNodeExecutionError, storeNodeExecutionDenied, storeNodeExecutionErrorText, type StoreNodeExecutionContext } from "./store-node-execution-client";
import { clearStoreNodeExecutionIntents, forgetStoreNodeExecutionIntent, prepareStoreNodeExecution, readStoreNodeExecutionIntents, saveStoreNodeExecutionIntent,
  storeNodeExecutionOwnerScope, updateStoreNodeExecutionIntent, type StoreNodeExecutionIntent } from "./store-node-execution-intent";
import "./store-node-execution.css";

type Props = { accountId: string; contextAuthority: string; sourceBusy?: boolean; onDenied?: () => void; onCompleted?: () => void };
type Draft = { input: CreateStoreNodeExecutionInput; intent: StoreNodeExecutionIntent };
const states: Record<StoreNodeExecutionState, string> = { waiting_node: "等待原节点", claimed: "原节点已领取", running: "正在同步", unknown_outcome: "平台结果未知",
  succeeded: "原能力快照已保存", failed: "同步未完成", cancelled: "已取消未执行任务", expired: "原任务已到期", authority_changed: "原授权或绑定已变化" };
const phases: Record<StoreNodeExecutionPhase, string> = { queued: "已保存等待任务", credential_ready: "原凭据已就绪", refresh_pending: "凭据刷新已提交 待原检查点",
  credential_checkpointed: "原凭据检查点已保存", collecting: "正在读取原平台能力", finished: "本次执行已结案" };
const reasons: Record<Workspace["configuration"]["reason"], string> = { ready: "当前可保存任务", not_configured: "节点执行服务未配置", not_supported: "本授权方式尚不支持节点能力同步",
  not_bound: "尚无当前绑定节点", draining: "原节点租约排空中", credential_unavailable: "原凭据当前不可使用 请核对授权状态", not_authorized: "当前没有保存同步任务的权限" };
const active = (value: StoreNodeExecutionView) => ["waiting_node", "claimed", "running"].includes(value.state);
const terminal = (value: StoreNodeExecutionView) => ["succeeded", "failed", "cancelled", "expired", "authority_changed"].includes(value.state);
export function storeNodeExecutionNotice(error: StoreNodeExecutionError) {
  if (error.code === "store_node_application_reauthorization_required") return "公开应用依据需重新授权 请先核对节点本地应用配置 再到本店设置重新完成平台授权 原任务与原回执保留 不会自动重试平台请求";
  return storeNodeExecutionErrorText(error);
}
export function StoreNodeExecutionWorkspace(props: Props) {
  const access = useErpAccess(), session = useContext(ErpIdentityContext)?.session;
  if (!session || !access.authority || !access.can(Permission.StoreRead)) return <section className="sne" aria-label="绑定节点能力同步"><p role="status">当前无本店节点任务读取权限 原资料已隐藏</p></section>;
  return <ExecutionPanel key={`${access.authority}:${props.accountId.toLowerCase()}:${props.contextAuthority}`} {...props}
    actorId={session.userId} tenantId={session.tenantId} preferenceScope={access.preferenceScope!} rawAuthority={access.authority} />;
}
function ExecutionPanel({ accountId, contextAuthority, sourceBusy = false, onDenied, onCompleted, actorId, tenantId, preferenceScope, rawAuthority }:
  Props & { actorId: string; tenantId: string; preferenceScope: string; rawAuthority: string }) {
  const access = useErpAccess(), alive = useRef(true), epoch = useRef(0), sequence = useRef(0), detailSequence = useRef(0), historySequence = useRef(0);
  const pending = useRef(false), detailPending = useRef(false), workspaceRef = useRef<Workspace | null>(null), owner = useRef<string | null>(null), original = useRef<Draft | null>(null);
  const readControl = useRef<AbortController | null>(null), detailControl = useRef<AbortController | null>(null), historyControl = useRef<AbortController | null>(null), writeControl = useRef<AbortController | null>(null);
  const denied = useRef(false), detailRef = useRef<StoreNodeExecutionView | null>(null), notification = useRef(new Set<string>());
  const callbacks = useRef({ onDenied, onCompleted }); callbacks.current = { onDenied, onCompleted };
  const [workspace, setWorkspace] = useState<Workspace | null>(null), [reading, setReading] = useState(false), [unverified, setUnverified] = useState(true);
  const [markers, setMarkers] = useState<StoreNodeExecutionIntent[]>([]), [markerReady, setMarkerReady] = useState(false), [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null), [detail, setDetail] = useState<StoreNodeExecutionView | null>(null), [detailLoading, setDetailLoading] = useState(false);
  const [history, setHistory] = useState<StoreNodeExecutionHistory | null>(null), [historyLoading, setHistoryLoading] = useState(false), [cursors, setCursors] = useState<(string | undefined)[]>([]);
  const [formOpen, setFormOpen] = useState(false), [targets, setTargets] = useState(""), [ttl, setTtl] = useState("24"), [draft, setDraft] = useState<Draft | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false), [confirmed, setConfirmed] = useState(false), [notFound, setNotFound] = useState<string | null>(null), [retryConfirmed, setRetryConfirmed] = useState(false);
  const valid = useCallback((version = epoch.current) => alive.current && version === epoch.current, []);
  const closeReview = useCallback(() => { setReviewOpen(false); setConfirmed(false); setRetryConfirmed(false); }, []);
  const resetPrivate = useCallback(() => {
    epoch.current++; sequence.current++; detailSequence.current++; historySequence.current++; pending.current = false; detailPending.current = false;
    for (const control of [readControl, detailControl, historyControl, writeControl]) { control.current?.abort(); control.current = null; }
    workspaceRef.current = null; detailRef.current = null; original.current = null;
    setWorkspace(null); setDetail(null); setHistory(null); setCursors([]); setDraft(null); setTargets(""); setTtl("24"); setFormOpen(false); closeReview();
    setBusy(null); setReading(false); setDetailLoading(false); setHistoryLoading(false); setNotFound(null); setUnverified(true);
  }, [closeReview]);
  const deny = useCallback((text: string) => { denied.current = true; resetPrivate(); setMessage(text); callbacks.current.onDenied?.(); }, [resetPrivate]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => { resetPrivate(); alive.current = false; owner.current = null; setMarkers([]); setMarkerReady(false);
      try { clearStoreNodeExecutionIntents(); } catch { /* The synchronous epoch still prevents late writes. */ }
      setMessage("当前本人会话已清除 原任务正文已隐藏"); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); alive.current = false; epoch.current++;
      for (const control of [readControl, detailControl, historyControl, writeControl]) control.current?.abort(); original.current = null; };
  }, [resetPrivate]);
  const context = useCallback(async (signal: AbortSignal, version: number): Promise<StoreNodeExecutionContext> => {
    const authority = await marketplaceAuthorityDigest(rawAuthority);
    if (!valid(version) || signal.aborted) throw new StoreNodeExecutionError(0);
    if (authority !== contextAuthority) throw new StoreNodeExecutionError(409, "authority_changed");
    return { accountId, actorId, tenantId, authority, signal };
  }, [accountId, actorId, contextAuthority, rawAuthority, tenantId, valid]);
  const reloadMarkers = useCallback(() => { if (!owner.current) throw new StoreNodeExecutionError(0);
    const values = readStoreNodeExecutionIntents(owner.current); setMarkers(values); setMarkerReady(true); return values; }, []);
  const fail = useCallback((error: unknown, submitted = false) => {
    const value = error instanceof StoreNodeExecutionError ? error : new StoreNodeExecutionError(submitted ? 0 : 502, undefined, submitted);
    if (storeNodeExecutionDenied(value)) { deny(storeNodeExecutionErrorText(value)); return; }
    setMessage(storeNodeExecutionNotice(value));
  }, [deny]);
  const accept = useCallback((value: StoreNodeExecutionView) => {
    detailRef.current = value; setDetail(value); setNotFound(null);
    if (value.state === "succeeded" && value.snapshot && !notification.current.has(value.id)) { notification.current.add(value.id); callbacks.current.onCompleted?.(); }
  }, []);
  const recordKnown = useCallback((value: StoreNodeExecutionView) => {
    if (!owner.current) throw new StoreNodeExecutionError(0);
    const marker = readStoreNodeExecutionIntents(owner.current).find(row => row.requestId === value.requestId);
    if (marker) { if (marker.requestChecksum !== value.requestChecksum || marker.executionId && marker.executionId !== value.id) throw new StoreNodeExecutionError(502);
      updateStoreNodeExecutionIntent({ ...marker, state: "known", executionId: value.id }); reloadMarkers(); }
  }, [reloadMarkers]);
  const load = useCallback(async (manual = false) => {
    if (!valid() || denied.current && !manual) return;
    const version = epoch.current, number = ++sequence.current, abort = new AbortController(); readControl.current?.abort(); readControl.current = abort;
    closeReview(); setReading(true);
    try {
      const value = await readStoreNodeExecutionWorkspace(await context(abort.signal, version));
      if (!valid(version) || number !== sequence.current || abort.signal.aborted) return;
      const previous = workspaceRef.current;
      if (previous && previous.authorizationGeneration !== value.authorizationGeneration) { detailSequence.current++; historySequence.current++;
        detailControl.current?.abort(); historyControl.current?.abort(); writeControl.current?.abort(); original.current = null;
        detailRef.current = null; setDetail(null); setHistory(null); setCursors([]); setDraft(null); setTargets(""); setFormOpen(false); }
      denied.current = false; workspaceRef.current = value; setWorkspace(value); setUnverified(false);
    } catch (error) { if (valid(version) && number === sequence.current && !abort.signal.aborted) { setUnverified(true); fail(error); } }
    finally { if (valid(version) && number === sequence.current) { setReading(false); if (readControl.current === abort) readControl.current = null; } }
  }, [closeReview, context, fail, valid]);
  useEffect(() => {
    const version = epoch.current;
    void storeNodeExecutionOwnerScope(preferenceScope, accountId).then(value => { if (!valid(version)) return; owner.current = value;
      try { reloadMarkers(); } catch { setMarkerReady(false); setMessage("浏览器无法核对原请求标识 本次不保存新任务"); } }).catch(() => { if (valid(version)) setMessage("本人原请求摘要尚未核对 本次不保存新任务"); });
    void load(); const focus = () => { if (document.visibilityState !== "hidden") void load(); };
    window.addEventListener("focus", focus); window.addEventListener("pageshow", focus);
    return () => { window.removeEventListener("focus", focus); window.removeEventListener("pageshow", focus); };
  }, [accountId, load, preferenceScope, reloadMarkers, valid]);
  const openExecution = useCallback(async (id: string, poll = false) => {
    if (!valid() || detailPending.current || denied.current) return;
    const version = epoch.current, number = ++detailSequence.current, abort = new AbortController(); detailControl.current?.abort(); detailControl.current = abort;
    detailPending.current = true; setDetailLoading(true); if (!poll) { detailRef.current = null; setDetail(null); setNotFound(null); }
    try { const value = await readStoreNodeExecution(await context(abort.signal, version), id);
      if (!valid(version) || number !== detailSequence.current || abort.signal.aborted) return; recordKnown(value); accept(value); }
    catch (error) { if (valid(version) && number === detailSequence.current && !abort.signal.aborted) fail(error); }
    finally { if (valid(version) && number === detailSequence.current) { detailPending.current = false; setDetailLoading(false); if (detailControl.current === abort) detailControl.current = null; } }
  }, [accept, context, fail, recordKnown, valid]);
  useEffect(() => { if (!detail || !active(detail)) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden" && !pending.current) void openExecution(detail.id, true); }, 3000);
    return () => window.clearInterval(timer); }, [detail?.id, detail?.state, detail, openExecution]);
  async function receipt(marker: StoreNodeExecutionIntent) {
    if (!valid() || detailPending.current || pending.current || denied.current) return;
    const version = epoch.current, number = ++detailSequence.current, abort = new AbortController(); detailControl.current?.abort(); detailControl.current = abort;
    detailPending.current = true; setDetailLoading(true); setDetail(null); detailRef.current = null; setNotFound(null); setRetryConfirmed(false);
    try { const value = await readStoreNodeExecutionReceipt(await context(abort.signal, version), { requestId: marker.requestId, requestChecksum: marker.requestChecksum });
      if (!valid(version) || number !== detailSequence.current || abort.signal.aborted) return;
      if (!value.execution) { setNotFound(marker.requestId); setMessage("本次未找到原回执 不代表未提交 仍锁定原请求 不会换键再建"); return; }
      if (marker.executionId && value.execution.id !== marker.executionId) throw new StoreNodeExecutionError(502);
      recordKnown(value.execution); accept(value.execution); setMessage("已读取同一原请求回执 没有重新调用平台");
    } catch (error) { if (valid(version) && number === detailSequence.current && !abort.signal.aborted) fail(error); }
    finally { if (valid(version) && number === detailSequence.current) { detailPending.current = false; setDetailLoading(false); if (detailControl.current === abort) detailControl.current = null; } }
  }
  async function historyPage(nextCursors: (string | undefined)[]) {
    if (!valid() || denied.current) return;
    const version = epoch.current, number = ++historySequence.current, abort = new AbortController(); historyControl.current?.abort(); historyControl.current = abort;
    setHistoryLoading(true); setHistory(null);
    try { const value = await readStoreNodeExecutionHistory(await context(abort.signal, version), nextCursors.at(-1));
      if (valid(version) && number === historySequence.current && !abort.signal.aborted) { setHistory(value); setCursors(nextCursors); } }
    catch (error) { if (valid(version) && number === historySequence.current && !abort.signal.aborted) fail(error); }
    finally { if (valid(version) && number === historySequence.current) { setHistoryLoading(false); if (historyControl.current === abort) historyControl.current = null; } }
  }
  const canSubmit = !!workspace && workspace.access.canSubmit && access.can(Permission.StoreManage) && markerReady && !unverified && !reading && !sourceBusy;
  async function reviewDraft() {
    const before = workspaceRef.current;
    if (!before || !owner.current || !canSubmit || pending.current || markers.length || !valid()) return;
    pending.current = true; setBusy("review"); const version = epoch.current;
    try {
      if (reloadMarkers().length) throw new StoreNodeExecutionError(409);
      const parts = targets.split(/[,，\s]+/).map(value => value.trim()).filter(Boolean);
      const value = await prepareStoreNodeExecution(before, { amazonProductTypes: before.platform === "amazon" ? parts : [],
        etsyTaxonomyNodeIds: before.platform === "etsy" ? parts.map(part => /^[1-9][0-9]*$/.test(part) ? Number(part) : NaN) : [], ttlHours: Number(ttl) }, owner.current);
      if (!valid(version) || workspaceRef.current !== before) return; setDraft(value); setReviewOpen(true); setConfirmed(false); setMessage("");
    } catch (error) { if (valid(version)) { setMessage(error instanceof StoreNodeExecutionError ? storeNodeExecutionNotice(error) : "同步范围或有效时长需核对 每次最多 10 个范围"); } }
    finally { if (valid(version)) { pending.current = false; setBusy(null); } }
  }
  async function submit(value: Draft, retry = false) {
    const current = workspaceRef.current;
    if (!current || !canSubmit || pending.current || !valid() || (!retry && (!reviewOpen || !confirmed)) || retry && !retryConfirmed) return;
    if (current.authorizationGeneration !== value.input.authorizationGeneration || current.binding.nodeId !== value.input.nodeId || current.binding.revision !== value.input.bindingRevision || current.binding.certificateGeneration !== value.input.certificateGeneration) {
      closeReview(); setUnverified(true); setMessage("原绑定依据已变化 不会替换原请求中的节点或版本 请重新读取"); return; }
    pending.current = true; setBusy("save"); const version = epoch.current, abort = new AbortController(); writeControl.current = abort;
    try {
      if (!retry) saveStoreNodeExecutionIntent(value.intent);
      const saved = readStoreNodeExecutionIntents(value.intent.ownerScope).find(row => row.requestId === value.intent.requestId);
      if (!saved || saved.requestChecksum !== value.input.requestChecksum || saved.state === "known") throw new StoreNodeExecutionError(409);
      if (!valid(version)) return;
      updateStoreNodeExecutionIntent({ ...saved, state: "unknown" }); original.current = value; reloadMarkers(); closeReview(); setNotFound(null);
      const result = await createStoreNodeExecution(await context(abort.signal, version), value.input);
      if (!valid(version) || abort.signal.aborted) return; recordKnown(result); accept(result); original.current = null; setDraft(null); setTargets(""); setTtl("24"); setFormOpen(false);
      setMessage("原任务已保存 不代表同步已成功 离线时等待原节点 不改走中央连接");
    } catch (error) { if (valid(version)) { try { reloadMarkers(); } catch { setMarkerReady(false); } fail(error, true); } }
    finally { if (valid(version)) { pending.current = false; setBusy(null); if (writeControl.current === abort) writeControl.current = null; } }
  }
  async function cancel() {
    const value = detailRef.current;
    if (!value?.canCancel || !workspace?.access.canCancel || !access.can(Permission.StoreManage) || pending.current || !valid()) return;
    const version = epoch.current, abort = new AbortController(); pending.current = true; writeControl.current = abort; setBusy("cancel");
    try { const result = await cancelStoreNodeExecution(await context(abort.signal, version), value);
      if (valid(version) && !abort.signal.aborted) { recordKnown(result); accept(result); setMessage("已读取原任务取消回执 不代表撤回已经提交的平台请求"); } }
    catch (error) { if (valid(version)) fail(error, true); }
    finally { if (valid(version)) { pending.current = false; setBusy(null); if (writeControl.current === abort) writeControl.current = null; } }
  }
  function end(marker: StoreNodeExecutionIntent) {
    const value = detailRef.current;
    if (!valid() || pending.current || !value || !terminal(value) || marker.executionId !== value.id || marker.requestChecksum !== value.requestChecksum) return;
    try { forgetStoreNodeExecutionIntent(marker); reloadMarkers(); original.current = null; setDraft(null); closeReview(); setFormOpen(false); setTargets(""); setTtl("24"); setNotFound(null); setMessage("本次原任务核对已结束 原执行与能力历史仍保留"); }
    catch (error) { fail(error); }
  }
  return <section className="sne" aria-label="绑定节点能力同步" aria-busy={reading || !!busy}>
    <header className="sne-heading"><div><h2><CloudSync size={16} />通过绑定节点同步能力</h2><p>只同步本店原能力依据 离线不回退中央 发布 订单与其他平台操作仍待独立接入</p></div>
      <button type="button" disabled={reading} onClick={() => void load(true)}><RefreshCw size={14} />重新读取执行状态</button></header>
    {message && <p role="status" className="sne-notice">{message}</p>}
    {!workspace ? <p className="sne-empty">{reading ? "正在核对本店执行依据与当前本人权限" : "执行依据尚未核对 原资料已隐藏"}</p> : <>
      <dl className="sne-facts"><Pair label="原绑定节点" value={workspace.binding.nodeId ?? "尚未绑定"} /><Pair label="节点状态" value={workspace.binding.state === "draining" ? "原租约排空中" : workspace.binding.online ? "本次读取时有真实心跳" : "未见当前在线心跳"} />
        <Pair label="绑定修订" value={String(workspace.binding.revision)} /><Pair label="原证书代次" value={workspace.binding.certificateGeneration === null ? "未提供" : String(workspace.binding.certificateGeneration)} />
        <Pair label="最后心跳" value={time(workspace.binding.lastSeenAt)} /><Pair label="状态截至" value={time(workspace.observedAt)} /></dl>
      <p className="sne-caption">{reasons[workspace.configuration.reason]} {!workspace.binding.online && workspace.access.canSubmit ? "可保存等待任务 由原绑定节点恢复后领取" : ""}</p>
      {workspace.authorizationMode === "etsy_oauth" && <p className="sne-caption">Etsy 应用凭据须在节点本地配置 页面不会收取或下发 应用配置不匹配时节点不会执行</p>}
      {workspace.authorizationMode === "amazon_public" && <>
        <p className="sne-caption">节点需配置与本次授权相同的 Amazon 公开应用 使用 work 处理任务 run 仅心跳 在线不代表原任务已经执行</p>
        <details><summary>公开应用节点运行指引</summary><p>在节点主机本地配置 <code>STORE_NODE_AMAZON_APP_CLIENT_ID</code> 和 <code>STORE_NODE_AMAZON_APP_CLIENT_SECRET</code> 页面不收取 显示或下发应用秘密</p>
          <p>应用依据不一致时先核对节点配置 再到本店设置重新授权 原任务只按原请求读取 不因重新授权而自动重发</p></details>
      </>}
      {unverified && <p className="sne-notice">当前执行依据需重新读取 新任务已锁定</p>}
      {access.can(Permission.StoreManage) ? <details className="sne-editor" open={formOpen}><summary onClick={event => { event.preventDefault(); setFormOpen(value => !value); }}>准备本店能力同步</summary>
        <form aria-label="节点能力同步填写" onSubmit={event => { event.preventDefault(); void reviewDraft(); }}><fieldset disabled={!canSubmit || !!busy || !!markers.length}>
          <label><span>{workspace.platform === "amazon" ? "Amazon Product Types" : "Etsy Taxonomy IDs"}</span><input value={targets} maxLength={1400} onChange={event => { setTargets(event.target.value); closeReview(); setDraft(null); }} placeholder={workspace.platform === "amazon" ? "HOME, PILLOW" : "42, 123"} /></label>
          <label><span>能力快照有效时长 小时</span><input type="number" min={1} max={168} step={1} required value={ttl} onChange={event => { setTtl(event.target.value); closeReview(); setDraft(null); }} /></label>
          <p>范围最多 10 个 空白沿原能力同步输入含义 不代表已同步全部平台能力</p><button type="submit"><ShieldCheck size={14} />核对本次同步</button></fieldset></form></details> : <p className="sne-caption">当前仅可读取原任务 保存与取消另需店铺管理权限</p>}
      {draft && <details className="sne-review" open={reviewOpen}><summary onClick={event => { event.preventDefault(); setReviewOpen(value => !value); setConfirmed(false); }}>核对固定原请求</summary>
        {draft && <div><dl className="sne-facts"><Pair label="原请求 ID" value={draft.input.requestId} /><Pair label="原节点 ID" value={draft.input.nodeId} /><Pair label="原授权代次" value={draft.input.authorizationGeneration} />
          <Pair label="原绑定修订" value={String(draft.input.bindingRevision)} /><Pair label="原证书代次" value={String(draft.input.certificateGeneration)} /><Pair label="原请求校验值" value={draft.input.requestChecksum} />
          <Pair label="本次范围" value={[...draft.input.input.amazonProductTypes, ...draft.input.input.etsyTaxonomyNodeIds].join(" · ") || "未追加产品或分类范围"} /><Pair label="有效时长" value={`${draft.input.input.ttlHours} 小时`} /></dl>
          <label className="sne-check"><input type="checkbox" checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)} /><span>已核对本店 原绑定节点和本次能力范围</span></label>
          <div className="sne-actions"><button disabled={!canSubmit || !!busy || !confirmed || !!markers.length} onClick={() => void submit(draft)}><CloudSync size={14} />保存并交绑定节点同步</button><button disabled={!!busy} onClick={closeReview}>返回填写</button></div></div>}
      </details>}
      {markerReady && markers.length > 0 && <section className="sne-recovery" aria-label="原节点同步请求恢复"><h3>原节点同步请求恢复</h3><p>仅保存本人本店的原 ID 与摘要 刷新不重新提交 读取回执不会调用平台</p>{markers.map(marker => <article key={marker.requestId} aria-label={`原节点同步请求 ${marker.requestId}`}>
        <dl className="sne-facts"><Pair label="原请求 ID" value={marker.requestId} /><Pair label="原请求校验值" value={marker.requestChecksum} /><Pair label="原执行 ID" value={marker.executionId ?? "尚未取得 请只读核对"} /></dl>
        <div className="sne-actions"><button disabled={detailLoading || !!busy || reading} onClick={() => void receipt(marker)}><RefreshCw size={14} />只读取原同步回执</button>
          {detail && terminal(detail) && marker.executionId === detail.id && <button disabled={!!busy || detailLoading} onClick={() => end(marker)}><Check size={14} />结束本次任务核对</button>}</div>
        {notFound === marker.requestId && <p className="sne-notice">未找到回执不证明未提交 原请求继续保留 {original.current?.intent.requestId === marker.requestId ? "本页仍持有同一原正文" : "刷新后原正文未保留 当前仅可只读核对"}</p>}
        {notFound === marker.requestId && original.current?.intent.requestId === marker.requestId && <div><label className="sne-check"><input type="checkbox" checked={retryConfirmed} onChange={event => setRetryConfirmed(event.target.checked)} /><span>已核对原请求 使用同一原键重试保存任务</span></label><div className="sne-actions"><button disabled={!canSubmit || !!busy || !retryConfirmed} onClick={() => { if (original.current) void submit(original.current, true); }}>使用同一原键重试保存任务</button></div></div>}
      </article>)}</section>}
      {!markerReady && <p className="sne-notice">原请求恢复标识尚未核对 本次不发送新任务</p>}
      <section className="sne-history" aria-label="本店节点同步历史"><header><h3><History size={15} />原执行历史</h3><button disabled={historyLoading} onClick={() => void historyPage([undefined])}>读取任务历史</button></header>
        <p>近期摘要最多 20 条 读取历史可继续翻页 每条详情来自原执行 ID</p>
        {historyLoading ? <p role="status">正在读取原历史页</p> : <TaskList items={history ? history.items : workspace.recent} busy={detailLoading || !!busy} open={id => void openExecution(id)} />}
        {history && <nav className="sne-actions" aria-label="节点同步历史分页"><button disabled={historyLoading || cursors.length <= 1} onClick={() => void historyPage(cursors.slice(0, -1))}><ChevronLeft size={14} />上一页</button>
          <span>第 {cursors.length} 页 本页 {history.items.length} 条 {history.hasMore ? "仍有后续" : "本次历史已读至末页"}</span><button disabled={historyLoading || !history.nextCursor} onClick={() => { if (history.nextCursor) void historyPage([...cursors, history.nextCursor]); }}>下一页<ChevronRight size={14} /></button></nav>}
      </section>
      {detailLoading && <p className="sne-caption" role="status"><LoaderCircle size={14} className="spin" />正在只读核对原任务</p>}
      {detail && <section className="sne-detail" aria-label="原节点同步任务详情"><header><h3><Server size={15} />{states[detail.state]}</h3><button disabled={detailLoading || !!busy} onClick={() => void openExecution(detail.id)}>重新读取原任务</button></header>
        <dl className="sne-facts"><Pair label="原执行 ID" value={detail.id} /><Pair label="当前阶段" value={phases[detail.phase]} /><Pair label="原请求 ID" value={detail.requestId} /><Pair label="原节点 ID" value={detail.nodeId} />
          <Pair label="原授权代次" value={detail.authorizationGeneration} /><Pair label="原绑定修订" value={String(detail.bindingRevision)} /><Pair label="原证书代次" value={String(detail.certificateGeneration)} />
          <Pair label="原任务有效期" value={time(detail.expiresAt)} /><Pair label="原诊断代码" value={detail.errorCode ?? "未提供"} /></dl>
        <p>{detail.state === "waiting_node" ? "原任务已保存 等待绑定节点运行工作命令或恢复连接 不改走中央连接" : detail.state === "unknown_outcome" ? "平台提交结果未知 不会重发平台请求 请保留原执行标识核对" : "本次只读取原任务 任务状态不会被页面关闭或刷新撤销"}</p>
        {detail.errorCode === "store_node_application_reauthorization_required" && <p role="status" className="sne-notice">{storeNodeExecutionNotice(new StoreNodeExecutionError(409, detail.errorCode))}</p>}
        {detail.canCancel && workspace.access.canCancel && access.can(Permission.StoreManage) && <div className="sne-actions"><button disabled={!!busy || detailLoading} onClick={() => void cancel()}><Square size={13} />取消尚未执行的原任务</button></div>}
        {detail.snapshot ? <Snapshot value={detail} /> : <p className="sne-caption">本任务当前没有可读取的原能力快照 不会用最新快照替代</p>}
      </section>}
    </>}
  </section>;
}
function TaskList({ items, busy, open }: { items: StoreNodeExecutionSummary[]; busy: boolean; open: (id: string) => void }) {
  return items.length ? <ol className="sne-tasks">{items.map(value => <li key={value.id}><div><b>{states[value.state]}</b><span>{time(value.createdAt)}</span><code>{value.id}</code></div><button disabled={busy} onClick={() => open(value.id)}>读取原任务</button></li>)}</ol> : <p className="sne-caption">本次没有可见的原节点同步任务</p>;
}
function Snapshot({ value }: { value: StoreNodeExecutionView }) {
  const snapshot = value.snapshot!;
  return <section className="sne-snapshot" aria-label="本任务原能力快照"><h3>本任务原能力快照</h3><p>{snapshot.stale ? "原快照已到期或属于旧授权 仍保留原结果" : "本次读取未标记失效 请核对有效期和当前授权"} 不代表其他平台操作已接入节点</p>
    <dl className="sne-facts"><Pair label="原能力快照 ID" value={snapshot.id} /><Pair label="原能力版本" value={String(snapshot.version)} /><Pair label="原平台" value={snapshot.platform} />
      <Pair label="原来源版本" value={snapshot.sourceVersion} /><Pair label="原来源校验值" value={snapshot.sourceChecksum} /><Pair label="同步时间" value={time(snapshot.syncedAt)} /><Pair label="到期时间" value={time(snapshot.expiresAt)} />
      <Pair label="原 Marketplace" value={snapshot.marketplaceIds.join(" · ")} /><Pair label="原能力" value={snapshot.capabilities.join(" · ") || "未提供"} /></dl>
    <details><summary>核对本任务原能力数据</summary><SnapshotData data={snapshot.data} /></details></section>;
}
function SnapshotData({ data }: { data: Record<string, unknown> }) {
  const [open, setOpen] = useState(false);
  return <div className="sne-data"><p>完整原能力数据可能较长 按需展开核对 不包含节点票据或授权凭据</p><button onClick={() => setOpen(value => !value)}>{open ? "收起原能力数据" : "展开原能力数据"}</button>{open && <pre>{JSON.stringify(data, null, 2)}</pre>}</div>;
}
function Pair({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function time(value: string | null) { return value === null ? "未提供" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
