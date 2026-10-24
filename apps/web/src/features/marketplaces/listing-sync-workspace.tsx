"use client";

import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, FileSearch, History, LoaderCircle, RefreshCw, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { MarketplaceListingSyncActionSchema, type MarketplaceListingSyncAction, type MarketplaceListingSyncEventView, type MarketplaceListingSyncRequestView } from "@yummyai/contracts/marketplace/listing-operations";
import type { ListingSyncIntentWorkspace } from "@yummyai/contracts/marketplace/listing-sync-intent";
import { ErpIdentityContext, useErpAccess } from "../identity/erp-access";
import { createListingSyncRequest, ListingSyncError, listingSyncDenied, listingSyncErrorText, listingSyncHash, listingSyncSameId,
  readListingSyncEvents, readListingSyncReceipt, readListingSyncRequest, readListingSyncWorkspace, type ListingSyncContext } from "./listing-sync-client";
import { forgetKnownListingSyncIntent, listingSyncOwnerScope, prepareListingSyncRequest, readListingSyncIntents, recordListingSyncRequest,
  saveListingSyncIntent, type ListingSyncStoredIntent } from "./listing-sync-intent";
import { ListingSyncPair, ListingSyncReceipt, listingSyncActionLabels, listingSyncStatusLabels } from "./listing-sync-receipt";
import "./listing-sync.css";

type Props = { listingId: string; listingVersionId: string };
type Detail = { request: MarketplaceListingSyncRequestView; events: MarketplaceListingSyncEventView[] | null };
type Draft = Awaited<ReturnType<typeof prepareListingSyncRequest>>;
export function ListingSyncWorkspace(props: Props) {
  const access = useErpAccess(), session = useContext(ErpIdentityContext)?.session;
  const stamp = `${access.authority}:${props.listingId}:${props.listingVersionId}`, current = useRef(stamp); current.current = stamp;
  if (!session || !access.authority || !access.can(Permission.ListingRead)) return <section className="lsi" aria-label="在线 Listing 同步"><h3>在线 Listing 同步</h3><p role="status">当前无原刊登同步读取权限 原资料已隐藏</p></section>;
  return <ListingSyncPanel key={stamp} {...props} actorId={session.userId} tenantId={session.tenantId} preferenceScope={access.preferenceScope!}
    rawAuthority={access.authority} isCurrent={() => current.current === stamp} />;
}
function ListingSyncPanel({ listingId, listingVersionId, actorId, tenantId, preferenceScope, rawAuthority, isCurrent }: Props & {
  actorId: string; tenantId: string; preferenceScope: string; rawAuthority: string; isCurrent: () => boolean;
}) {
  const access = useErpAccess(), current = useRef(isCurrent); current.current = isCurrent;
  const alive = useRef(true), ended = useRef(false), epoch = useRef(0), draftSequence = useRef(0), readSequence = useRef(0), detailSequence = useRef(0), lock = useRef(false);
  const workspaceAbort = useRef<AbortController | null>(null), detailAbort = useRef<AbortController | null>(null), submitAbort = useRef<AbortController | null>(null);
  const closeTimer = useRef<number | null>(null), closingRef = useRef(false);
  const owner = useRef<string | null>(null), wire = useRef<string | null>(null), verified = useRef(new Set<string>());
  const [workspace, setWorkspace] = useState<ListingSyncIntentWorkspace | null>(null), [detail, setDetail] = useState<Detail | null>(null);
  const [markers, setMarkers] = useState<ListingSyncStoredIntent[]>([]), [storageReady, setStorageReady] = useState(false), [basisReady, setBasisReady] = useState(false), [denied, setDenied] = useState(false);
  const [reading, setReading] = useState(true), [detailLoading, setDetailLoading] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [message, setMessage] = useState("");
  const [sourceId, setSourceId] = useState(""), [action, setAction] = useState<MarketplaceListingSyncAction>("read"), [draft, setDraft] = useState<Draft | null>(null);
  const [confirmed, setConfirmed] = useState(false), [originalId, setOriginalId] = useState("");
  const [closing, setClosing] = useState(false);
  const valid = useCallback((version: number) => alive.current && !ended.current && current.current() && version === epoch.current, []);
  const cancelReviewClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null; closingRef.current = false; setClosing(false);
  }, []);
  const reloadMarkers = useCallback(() => {
    if (!owner.current) return; try { setMarkers(readListingSyncIntents(owner.current)); setStorageReady(true); }
    catch { setStorageReady(false); setError("本标签页原同步标识无法可靠读取 新提交已关闭 请核对原请求 ID 后重读"); }
  }, []);
  const context = useCallback((signal?: AbortSignal): ListingSyncContext => {
    if (!wire.current) throw new ListingSyncError(409, "authority_changed"); return { listingId, actorId, tenantId, authority: wire.current, signal };
  }, [listingId, actorId, tenantId]);
  const clearPrivate = useCallback(() => {
    cancelReviewClose();
    epoch.current++; readSequence.current++; detailSequence.current++; workspaceAbort.current?.abort(); detailAbort.current?.abort(); submitAbort.current?.abort();
    lock.current = false; verified.current.clear(); setBasisReady(false); setWorkspace(null); setDetail(null); setDraft(null); setSourceId(""); setAction("read"); setConfirmed(false); setOriginalId(""); setMessage(""); setBusy(false); setDetailLoading(false);
  }, [cancelReviewClose]);
  const failure = useCallback((caught: unknown) => {
    const value = caught instanceof ListingSyncError ? caught : new ListingSyncError(0);
    if (listingSyncDenied(value)) { clearPrivate(); setDenied(true); setReading(false); }
    setError(listingSyncErrorText(value));
  }, [clearPrivate]);
  const load = useCallback(async () => {
    if (lock.current || ended.current) return; const version = epoch.current, sequence = ++readSequence.current;
    workspaceAbort.current?.abort(); const abort = new AbortController(); workspaceAbort.current = abort; setReading(true); setBasisReady(false);
    try {
      const [scope, authority] = await Promise.all([listingSyncOwnerScope(preferenceScope, listingId), listingSyncHash(rawAuthority)]);
      if (!valid(version) || sequence !== readSequence.current || abort.signal.aborted) return;
      owner.current = scope; wire.current = authority; reloadMarkers();
      const value = await readListingSyncWorkspace(context(abort.signal));
      if (!valid(version) || sequence !== readSequence.current || abort.signal.aborted) return;
      cancelReviewClose(); setWorkspace(value); setBasisReady(true); setDenied(false); setError(""); draftSequence.current++; setDraft(null); setConfirmed(false);
      setSourceId(prior => value.sources.some(row => row.sourcePublicationRequestId === prior) ? prior : "");
    } catch (caught) { if (valid(version) && sequence === readSequence.current && !abort.signal.aborted) failure(caught); }
    finally { if (valid(version) && sequence === readSequence.current) setReading(false); }
  }, [cancelReviewClose, context, failure, listingId, preferenceScope, rawAuthority, reloadMarkers, valid]);
  useEffect(() => {
    alive.current = true; void load();
    const shown = () => { if (document.visibilityState !== "hidden") void load(); };
    const cleared = () => { ended.current = true; clearPrivate(); owner.current = null; wire.current = null; setMarkers([]); setStorageReady(false); setDenied(true); setReading(false); setError("本人会话已清除 原同步资料已隐藏 请重新进入"); };
    window.addEventListener("focus", shown); window.addEventListener("pageshow", shown); document.addEventListener("visibilitychange", shown); window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, cleared);
    const timer = window.setInterval(shown, 30000);
    return () => { alive.current = false; epoch.current++; workspaceAbort.current?.abort(); detailAbort.current?.abort(); submitAbort.current?.abort(); window.clearInterval(timer);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); closeTimer.current = null; closingRef.current = false;
      window.removeEventListener("focus", shown); window.removeEventListener("pageshow", shown); document.removeEventListener("visibilitychange", shown); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, cleared); };
  }, [clearPrivate, load]);
  const source = workspace?.sources.find(row => row.sourcePublicationRequestId === sourceId);
  const canSubmit = basisReady && !!workspace && workspace.access.canSubmit && access.can(Permission.ListingPublish) && workspace.listing.status === "approved" &&
    workspace.listing.currentVersionId !== null && listingSyncSameId(workspace.listing.currentVersionId, listingVersionId) && storageReady && markers.length === 0 && !reading && !denied;
  const invalidateDraft = () => { cancelReviewClose(); draftSequence.current++; setDraft(null); setConfirmed(false); setMessage(""); detailSequence.current++; detailAbort.current?.abort(); setDetail(null); setDetailLoading(false); };
  function closeReview() {
    if (lock.current || closingRef.current) return; const version = epoch.current, sequence = ++draftSequence.current; setConfirmed(false);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { cancelReviewClose(); setDraft(null); return; }
    closingRef.current = true; setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null; if (!valid(version) || sequence !== draftSequence.current) return;
      closingRef.current = false; setClosing(false); setDraft(null);
    }, 160);
  }
  async function reviewDraft() {
    if (lock.current || !canSubmit || !source || !owner.current) return; lock.current = true; setBusy(true); const version = epoch.current, sequence = ++draftSequence.current;
    cancelReviewClose(); setDraft(null); setConfirmed(false);
    try {
      if (readListingSyncIntents(owner.current).length) { reloadMarkers(); throw new ListingSyncError(409); }
      const value = await prepareListingSyncRequest({ accountId: source.accountId, listingId, listingVersionId,
        sourcePublicationRequestId: source.sourcePublicationRequestId, action }, owner.current);
      if (!valid(version) || sequence !== draftSequence.current) return; setDraft(value); setConfirmed(false); setError("");
    } catch (caught) { if (valid(version)) failure(caught); }
    finally { if (valid(version)) { lock.current = false; setBusy(false); } }
  }
  function recordKnown(marker: ListingSyncStoredIntent, request: MarketplaceListingSyncRequestView) {
    const saved = recordListingSyncRequest(marker, request.id); reloadMarkers(); verified.current.add(request.id.toLowerCase()); return saved;
  }
  async function submit() {
    if (lock.current || closingRef.current || !canSubmit || !draft || !confirmed || !owner.current || draft.intent.ownerScope !== owner.current) return;
    lock.current = true; setBusy(true); const version = epoch.current, original = draft; const abort = new AbortController(); submitAbort.current = abort;
    try {
      if (!valid(version)) return; saveListingSyncIntent(original.intent); reloadMarkers();
      if (!valid(version)) return;
      setDraft(null); setConfirmed(false); setError(""); setMessage("原请求标识已保存 正在核对原任务回执");
      const value = await createListingSyncRequest(context(abort.signal), original.input);
      if (!valid(version) || abort.signal.aborted) return; recordKnown(original.intent, value); setDetail({ request: value, events: null });
      setMessage("已核对原同步请求 ID 任务已保存 不代表已派发或平台已接受");
    } catch (caught) { if (valid(version) && !abort.signal.aborted) { reloadMarkers(); failure(caught instanceof ListingSyncError ? new ListingSyncError(caught.status, caught.code, true) : new ListingSyncError(0, undefined, true)); } }
    finally { if (valid(version)) { lock.current = false; setBusy(false); } }
  }
  async function openRequest(requestId: string, marker?: ListingSyncStoredIntent) {
    if (lock.current || !wire.current || denied) return; const parsed = EntityIdSchema.safeParse(requestId.toLowerCase());
    if (!parsed.success) { setError("请输入准确的原同步请求 ID"); return; }
    const version = epoch.current, sequence = ++detailSequence.current; detailAbort.current?.abort(); const abort = new AbortController(); detailAbort.current = abort; setDetailLoading(true); setDetail(null);
    try {
      const value = await readListingSyncRequest(context(abort.signal), parsed.data);
      if (!valid(version) || sequence !== detailSequence.current || abort.signal.aborted) return;
      if (marker && (!marker.requestId || !listingSyncSameId(marker.requestId, value.id))) throw new ListingSyncError(502);
      verified.current.add(value.id.toLowerCase()); setDetail({ request: value, events: null }); setError("");
    } catch (caught) { if (valid(version) && sequence === detailSequence.current && !abort.signal.aborted) failure(caught); }
    finally { if (valid(version) && sequence === detailSequence.current) setDetailLoading(false); }
  }
  async function receipt(marker: ListingSyncStoredIntent) {
    if (lock.current || !wire.current || denied) return; const version = epoch.current, sequence = ++detailSequence.current;
    detailAbort.current?.abort(); const abort = new AbortController(); detailAbort.current = abort; verified.current.clear(); setDetailLoading(true); setDetail(null);
    try {
      const value = await readListingSyncReceipt(context(abort.signal), { requestKey: marker.requestKey, requestChecksum: marker.requestChecksum });
      if (!valid(version) || sequence !== detailSequence.current || abort.signal.aborted) return;
      if (value.request) { recordKnown(marker, value.request); setDetail({ request: value.request, events: null }); setMessage("已找回原同步回执 本次只读取 没有再次提交"); }
      else setMessage("暂未找到原回执 不代表原请求未提交 原标识继续保留 新提交保持关闭"); setError("");
    } catch (caught) { if (valid(version) && sequence === detailSequence.current && !abort.signal.aborted) failure(caught); }
    finally { if (valid(version) && sequence === detailSequence.current) setDetailLoading(false); }
  }
  async function events() {
    if (lock.current || !detail || denied) return; const original = detail.request, version = epoch.current, sequence = ++detailSequence.current;
    detailAbort.current?.abort(); const abort = new AbortController(); detailAbort.current = abort; setDetailLoading(true);
    try { const rows = await readListingSyncEvents(context(abort.signal), original); if (valid(version) && sequence === detailSequence.current && !abort.signal.aborted) { setDetail({ request: original, events: rows }); setError(""); } }
    catch (caught) { if (valid(version) && sequence === detailSequence.current && !abort.signal.aborted) failure(caught); }
    finally { if (valid(version) && sequence === detailSequence.current) setDetailLoading(false); }
  }
  function forget(marker: ListingSyncStoredIntent) {
    if (lock.current || marker.state !== "known" || !marker.requestId || !verified.current.has(marker.requestId.toLowerCase())) return;
    try { forgetKnownListingSyncIntent(marker); reloadMarkers(); setDraft(null); setConfirmed(false); setMessage("已结束本次原请求核对 原任务和历史仍保留 此操作不会取消原任务"); } catch (caught) { failure(caught); }
  }
  const detailMarker = detail ? markers.find(row => row.requestId && listingSyncSameId(row.requestId, detail.request.id)) : undefined;
  return <section className="lsi" aria-label="在线 Listing 同步"><header className="lsi-heading"><h3><SlidersHorizontal size={17} />在线 Listing 同步</h3>
    <button type="button" disabled={busy || reading} onClick={() => void load()}><RefreshCw size={14} />重新读取同步依据</button></header>
    <p className="lsi-caption">固定原店铺 刊登版本 发布来源与动作 保存任务和读取回执分开核对 本区沿原同步流程 不表示已接入节点平台执行</p>
    {error && <p className="lsi-error" role="alert"><CircleAlert size={14} />{error}</p>}{message && <p className="lsi-notice" role="status">{message}</p>}
    {reading && <p role="status"><LoaderCircle className="spin" size={14} />正在核对本人原同步依据</p>}
    {!workspace && !reading && <p className="lsi-caption">新提交依据尚未核对 请重新读取 原标识可单独只读恢复</p>}
    {workspace && !denied && <>
      <p className="lsi-caption">本次可读来源 {workspace.sources.length} 条 来源清单最多 100 条 仅表示当前可读范围</p>
      {workspace.listing.currentVersionId && !listingSyncSameId(workspace.listing.currentVersionId, listingVersionId) && <p className="lsi-error">当前页面版本已经变化 新提交已关闭 请重新进入刊登核对 原请求仍可读取</p>}
      {workspace.access.canSubmit && access.can(Permission.ListingPublish) ? <form className="lsi-form" aria-label="在线同步目标填写" onSubmit={event => { event.preventDefault(); void reviewDraft(); }}>
        <fieldset disabled={!canSubmit || busy || detailLoading}><label><span>已发布 Listing</span><select required value={sourceId} onChange={event => { invalidateDraft(); setSourceId(event.target.value); }}>
          <option value="">请选择原已发布来源</option>{workspace.sources.map(row => <option key={row.sourcePublicationRequestId} value={row.sourcePublicationRequestId}>{row.accountName} · {row.marketplaceId} · {row.externalListingId}</option>)}</select></label>
          <label><span>本次同步动作</span><select value={action} onChange={event => { invalidateDraft(); setAction(MarketplaceListingSyncActionSchema.parse(event.target.value)); }}>{Object.entries(listingSyncActionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <button type="submit" disabled={!source}><ShieldCheck size={14} />核对本次同步</button></fieldset>
        {action.startsWith("push_") && <p className="lsi-notice">此动作会请求写入平台 需核对原批准内容 读取动作不会自动授权写回</p>}
      </form> : <p className="lsi-caption">当前仅可读取原请求 新同步另需发布权限及服务端当前依据允许</p>}
      {workspace.sources.length === 0 && <p className="lsi-caption">本次没有可读的已发布来源 无法从空来源发起新同步</p>}
      {!storageReady && <p className="lsi-error">恢复存储尚未可靠核对 新提交保持关闭</p>}
      {draft && <section className={`lsi-review${closing ? " lsi-review-closing" : ""}`} aria-label="固定原同步请求" inert={closing} aria-hidden={closing || undefined}><header className="lsi-heading"><h4>固定原同步请求</h4><button aria-label="关闭同步核对" disabled={busy || closing} type="button" onClick={closeReview}><X size={15} /></button></header>
        <dl className="lsi-facts"><ListingSyncPair label="原账户 ID"><code>{draft.input.accountId}</code></ListingSyncPair><ListingSyncPair label="原店铺与站点">{source?.accountName} · {source?.marketplaceId}</ListingSyncPair>
          <ListingSyncPair label="原外部 Listing">{source?.externalListingId}</ListingSyncPair><ListingSyncPair label="原发布来源版本 ID"><code>{source?.listingVersionId}</code></ListingSyncPair><ListingSyncPair label="原 Listing ID"><code>{draft.input.listingId}</code></ListingSyncPair>
          <ListingSyncPair label="本次 Listing 版本 ID"><code>{draft.input.listingVersionId}</code></ListingSyncPair><ListingSyncPair label="原发布来源 ID"><code>{draft.input.sourcePublicationRequestId}</code></ListingSyncPair>
          <ListingSyncPair label="原动作">{listingSyncActionLabels[draft.input.action]}</ListingSyncPair><ListingSyncPair label="原意图键"><code>{draft.intent.requestKey}</code></ListingSyncPair>
          <ListingSyncPair label="原目标校验值"><code>{draft.intent.requestChecksum}</code></ListingSyncPair></dl>
        <label className="lsi-check"><input type="checkbox" checked={confirmed} disabled={busy || reading || closing} onChange={event => setConfirmed(event.target.checked)} /><span>已核对原店铺 原 Listing 版本与本次动作</span></label>
        <button disabled={!canSubmit || busy || closing || !confirmed} onClick={() => void submit()} type="button"><Check size={14} />保存原同步任务</button>
      </section>}
    </>}
      {!denied && markers.length > 0 && <section className="lsi-recovery" aria-label="本人原同步请求恢复"><h4>本人原同步请求恢复</h4><p>本标签页仅保存原 ID 和校验值 未核对的标识会阻止新提交 刷新不会再次发送原请求</p>
        {markers.map(marker => <article key={marker.requestKey} aria-label={`原同步意图 ${marker.requestKey}`}><dl className="lsi-facts"><ListingSyncPair label="原意图键"><code>{marker.requestKey}</code></ListingSyncPair>
          <ListingSyncPair label="原目标校验值"><code>{marker.requestChecksum}</code></ListingSyncPair><ListingSyncPair label="原同步请求 ID"><code>{marker.requestId ?? "尚待读取原回执"}</code></ListingSyncPair></dl>
          <div className="lsi-actions"><button disabled={busy || detailLoading || reading} type="button" onClick={() => void receipt(marker)}>只读取原同步回执</button>
            {marker.state === "known" && marker.requestId && <button disabled={busy || detailLoading || !verified.current.has(marker.requestId.toLowerCase())} type="button" onClick={() => forget(marker)}>结束本次原请求核对</button>}</div>
          {marker.state !== "known" && <p className="lsi-caption">原结果尚未核对 不能丢弃此标识或换键重发</p>}</article>)}
        <p className="lsi-caption">结束核对只移除本页已读的恢复标记 不撤销原任务 后续新任务需重新明确核对</p>
      </section>}
      {workspace && !denied && <section className="lsi-history" aria-label="原同步请求读取"><header className="lsi-heading"><h4><History size={15} />原同步请求读取</h4><span>近期最多 20 条</span></header>
        <form className="lsi-id-form" onSubmit={event => { event.preventDefault(); void openRequest(originalId); }}><label><span>原同步请求 ID</span><input required value={originalId} onChange={event => { detailSequence.current++; detailAbort.current?.abort(); setDetail(null); setDetailLoading(false); setOriginalId(event.target.value); }} autoComplete="off" spellCheck={false} /></label>
          <button disabled={busy || detailLoading || reading} type="submit"><FileSearch size={14} />读取准确原请求</button></form>
        <p className="lsi-caption">近期清单不是完整历史 可输入准确原 ID 读取更早请求 不会用当前版本替换原版本</p>
        {workspace.recent.length ? <ol className="lsi-request-list">{workspace.recent.map(row => <li key={row.id}><div><strong>{listingSyncActionLabels[row.action]}</strong><span>{listingSyncStatusLabels[row.current.status]}</span><code>{row.id}</code></div>
          <button disabled={busy || detailLoading || reading} onClick={() => void openRequest(row.id)} type="button">读取原请求</button></li>)}</ol> : <p>本次没有可见的近期原请求 不代表没有更早历史</p>}
      </section>}
      {!denied && detailLoading && <p role="status">正在读取准确原请求</p>}
      {!denied && detail && <ListingSyncReceipt request={detail.request} events={detail.events} requestKey={detailMarker?.requestKey} requestChecksum={detailMarker?.requestChecksum}
        busy={busy || detailLoading || reading} onRefresh={() => void openRequest(detail.request.id)} onReadEvents={() => void events()} />}
  </section>;
}
