"use client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Check, FileSearch, History, LoaderCircle, RefreshCw, ShieldCheck, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import type { PublicationPreviewWorkspace as Workspace, PublicationPreviewRequestView } from "@yummyai/contracts/marketplace/publication-preview";
import type { MarketplacePublicationEventView } from "@yummyai/contracts/marketplace/publication";
import { ErpIdentityContext, useErpAccess } from "../identity/erp-access";
import { createPublicationPreview, cancelPublicationPreview, readPublicationPreview, readPublicationReceipt, readPublicationWorkspace, readPublicationPreviewEvents,
  previewDenied, previewErrorText, previewHash, previewSameId, PublicationPreviewError, type PublicationPreviewContext } from "./publication-preview-client";
import { forgetKnownPublicationIntent, preparePublicationIntent, publicationPreviewOwnerScope, readPublicationIntents, recordPublicationIntent, savePublicationIntent,
  type PublicationPreviewIntent } from "./publication-preview-intent";
import { PreviewPair, PublicationPreviewReceipt, publicationStatusLabel } from "./publication-preview-receipt";
import "./publication-preview.css";

type Props = { listingId: string; listingVersionId: string; initialRequestId?: string; initialAccountId?: string; initialMarketplaceId?: string; readOnlyRequest?: boolean };
type Detail = { value: PublicationPreviewRequestView; events: MarketplacePublicationEventView[] | null };
const variantsSchema = z.array(z.object({ skuId: z.string().min(1).max(160), skuCode: z.string().max(200).optional() }).passthrough()).max(1000);
const reasons: Record<Workspace["sources"][number]["reason"], string> = { ready: "当前依据可准备", not_configured: "节点预览未配置", not_supported: "原平台不支持此节点预览",
  not_authorized: "当前授权不足", not_bound: "没有合格的绑定节点", draining: "原绑定正在等待租约排空", node_offline: "节点离线 保存后等待原节点 不转中央",
  credential_unavailable: "原凭据不可用", capability_unavailable: "原能力版本不可用", listing_not_approved: "所选原版本不符合当前审批门", source_changed: "原来源已变化" };
export function PublicationPreviewWorkspace(props: Props) {
  const access = useErpAccess(), session = useContext(ErpIdentityContext)?.session, stamp = JSON.stringify([access.authority, props.listingId, props.listingVersionId, props.initialRequestId, props.initialAccountId, props.initialMarketplaceId, props.readOnlyRequest]);
  const current = useRef(stamp); current.current = stamp;
  if (!session || !access.authority || !access.canAll([Permission.ListingRead, Permission.StoreRead])) return <section className="ppv" aria-label="Amazon 节点校验预览"><h3>Amazon 节点校验预览</h3><p role="status">当前没有原刊登或店铺读取权限 原预览资料已隐藏</p></section>;
  return <PreviewPanel key={stamp} {...props} actorId={session.userId} tenantId={session.tenantId} rawAuthority={access.authority} preferenceScope={access.preferenceScope!} isCurrent={() => current.current === stamp} />;
}
function PreviewPanel({ listingId, listingVersionId, initialRequestId, initialAccountId, initialMarketplaceId, readOnlyRequest = false, actorId, tenantId, rawAuthority, preferenceScope, isCurrent }: Props & {
  actorId: string; tenantId: string; rawAuthority: string; preferenceScope: string; isCurrent(): boolean;
}) {
  const access = useErpAccess(), current = useRef(isCurrent); current.current = isCurrent;
  const alive = useRef(true), ended = useRef(false), blocked = useRef(false), epoch = useRef(0), sequence = useRef(0), detailSequence = useRef(0), draftSequence = useRef(0), lock = useRef(false);
  const readAbort = useRef<AbortController | null>(null), detailAbort = useRef<AbortController | null>(null), postAbort = useRef<AbortController | null>(null);
  const owner = useRef<string | null>(null), wire = useRef<string | null>(null), verified = useRef(new Set<string>()), initialRead = useRef(false), closeTimer = useRef<number | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null), [detail, setDetail] = useState<Detail | null>(null), [variant, setVariant] = useState("");
  const [variants, setVariants] = useState<Array<{ skuId: string; skuCode?: string }>>([]), [sourceKey, setSourceKey] = useState("");
  const [draft, setDraft] = useState<Awaited<ReturnType<typeof preparePublicationIntent>> | null>(null), [confirmed, setConfirmed] = useState(false), [closing, setClosing] = useState(false);
  const [markers, setMarkers] = useState<PublicationPreviewIntent[]>([]), [storageReady, setStorageReady] = useState(false), [wireReady, setWireReady] = useState(false), [basisReady, setBasisReady] = useState(false);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [detailLoading, setDetailLoading] = useState(false), [denied, setDenied] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState(""), [originalId, setOriginalId] = useState(initialRequestId ?? ""), [cancelUnknown, setCancelUnknown] = useState<string | null>(null);
  const valid = useCallback((token = epoch.current) => alive.current && !ended.current && current.current() && token === epoch.current, []);
  const cancelClose = useCallback(() => { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); closeTimer.current = null; setClosing(false); }, []);
  const context = useCallback((signal?: AbortSignal): PublicationPreviewContext => {
    if (!wire.current) throw new PublicationPreviewError(409, "authority_changed"); return { listingId, listingVersionId, actorId, tenantId, authority: wire.current, signal };
  }, [listingId, listingVersionId, actorId, tenantId]);
  const reloadMarkers = useCallback(() => {
    if (!owner.current) return; try { setMarkers(readPublicationIntents(owner.current)); setStorageReady(true); }
    catch { setStorageReady(false); setError("本标签页原预览标识无法可靠读取 新准备已关闭 请核对准确原请求 ID"); }
  }, []);
  const clearPrivate = useCallback(() => {
    cancelClose(); epoch.current++; sequence.current++; detailSequence.current++; draftSequence.current++; readAbort.current?.abort(); detailAbort.current?.abort(); postAbort.current?.abort();
    lock.current = false; verified.current.clear(); setBasisReady(false); setWorkspace(null); setDetail(null); setDraft(null); setVariants([]); setVariant(""); setSourceKey(""); setConfirmed(false); setOriginalId(""); setMessage(""); setBusy(false); setDetailLoading(false); setReading(false); setCancelUnknown(null);
  }, [cancelClose]);
  const failure = useCallback((caught: unknown) => {
    const value = caught instanceof PublicationPreviewError ? caught : new PublicationPreviewError(0);
    if (previewDenied(value)) { blocked.current = true; clearPrivate(); setDenied(true); }
    setError(previewErrorText(value));
  }, [clearPrivate]);
  const load = useCallback(async () => {
    if (lock.current || ended.current || blocked.current) return; const token = epoch.current, request = ++sequence.current, abort = new AbortController(); readAbort.current?.abort(); readAbort.current = abort;
    cancelClose(); draftSequence.current++; setDraft(null); setConfirmed(false); setReading(true); setBasisReady(false);
    try {
      const [scope, authority] = await Promise.all([publicationPreviewOwnerScope(preferenceScope, listingId), previewHash(rawAuthority)]);
      if (!valid(token) || abort.signal.aborted || request !== sequence.current) return;
      owner.current = scope; wire.current = authority; setWireReady(true); reloadMarkers();
      if (readOnlyRequest) { setDenied(false); setError(""); return; }
      const value = await readPublicationWorkspace(context(abort.signal), variant || undefined);
      if (!valid(token) || abort.signal.aborted || request !== sequence.current) return;
      setWorkspace(value); setBasisReady(true); setDenied(false); setError(""); const parsed = variantsSchema.safeParse(value.listing.content.variants); setVariants(parsed.success ? parsed.data : []);
      setSourceKey(prior => value.sources.some(row => `${row.accountId}:${row.marketplaceId}` === prior) ? prior :
        initialAccountId && initialMarketplaceId ? value.sources.find(row => previewSameId(row.accountId, initialAccountId) && row.marketplaceId === initialMarketplaceId) ? `${initialAccountId.toLowerCase()}:${initialMarketplaceId}` : "" : "");
    } catch (caught) { if (valid(token) && !abort.signal.aborted && request === sequence.current) failure(caught); }
    finally { if (valid(token) && request === sequence.current) setReading(false); }
  }, [cancelClose, context, failure, initialAccountId, initialMarketplaceId, listingId, preferenceScope, rawAuthority, readOnlyRequest, reloadMarkers, valid, variant]);
  const openRequest = useCallback(async (rawId: string, pinned = false) => {
    if (lock.current || !valid() || !wire.current) return; const id = EntityIdSchema.safeParse(rawId.toLowerCase()); if (!id.success) { setError("请填写准确的原发布请求 ID"); return; }
    const token = epoch.current, request = ++detailSequence.current, abort = new AbortController(); detailAbort.current?.abort(); detailAbort.current = abort; setDetailLoading(true); setDetail(null);
    try { const value = await readPublicationPreview(context(abort.signal), id.data); if (!valid(token) || abort.signal.aborted || request !== detailSequence.current) return;
      if (pinned && !previewSameId(value.request.listingVersionId, listingVersionId)) throw new PublicationPreviewError(502);
      setDetail({ value, events: null }); setDenied(false); setOriginalId(value.request.id); setCancelUnknown(null); verified.current.add(value.request.id.toLowerCase()); setError("");
      const marker = owner.current ? readPublicationIntents(owner.current).find(row => value.intent && previewSameId(row.requestKey, value.intent.requestKey) && row.requestChecksum === value.intent.requestChecksum) : undefined;
      if (marker) { recordPublicationIntent(marker, value.request.id); reloadMarkers(); }
    } catch (caught) { if (valid(token) && !abort.signal.aborted && request === detailSequence.current) failure(caught); }
    finally { if (valid(token) && request === detailSequence.current) setDetailLoading(false); }
  }, [context, failure, listingVersionId, reloadMarkers, valid]);
  useEffect(() => {
    alive.current = true; void load(); const shown = () => { if (document.visibilityState !== "hidden") void load(); };
    const clear = () => { ended.current = true; clearPrivate(); owner.current = null; wire.current = null; setMarkers([]); setStorageReady(false); setWireReady(false); setDenied(true); setError("本人会话已清除 原预览资料已隐藏 请重新进入"); };
    window.addEventListener("focus", shown); window.addEventListener("pageshow", shown); window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); document.addEventListener("visibilitychange", shown);
    const timer = window.setInterval(shown, 30000);
    return () => { alive.current = false; epoch.current++; readAbort.current?.abort(); detailAbort.current?.abort(); postAbort.current?.abort(); if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      window.clearInterval(timer); window.removeEventListener("focus", shown); window.removeEventListener("pageshow", shown); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); document.removeEventListener("visibilitychange", shown); };
  }, [clearPrivate, load]);
  useEffect(() => { if (wireReady && initialRequestId && !initialRead.current && !denied) { initialRead.current = true; void openRequest(initialRequestId, true); } }, [wireReady, initialRequestId, denied, openRequest]);
  const source = workspace?.sources.find(row => `${row.accountId}:${row.marketplaceId}` === sourceKey);
  const canPrepare = !readOnlyRequest && basisReady && !denied && !reading && !busy && storageReady && markers.length === 0 && variant !== "" && access.can(Permission.ListingPublish) && workspace?.access.canPrepare && source?.canPrepare && source.target?.variantSkuId === variant;
  function resetReview() { cancelClose(); draftSequence.current++; setDraft(null); setConfirmed(false); setMessage(""); }
  function closeReview() { if (lock.current || closing) return; const token = epoch.current, request = ++draftSequence.current; setConfirmed(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { setDraft(null); return; } setClosing(true);
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; if (valid(token) && draftSequence.current === request) { setDraft(null); setClosing(false); } }, 160); }
  async function review() {
    if (!canPrepare || !source?.target || !owner.current || lock.current) return; const token = epoch.current, request = ++draftSequence.current; cancelClose(); setDraft(null); setConfirmed(false);
    try { const value = await preparePublicationIntent(source.target, owner.current); if (valid(token) && request === draftSequence.current) setDraft(value); }
    catch (caught) { if (valid(token)) failure(caught); }
  }
  async function submit() {
    if (!canPrepare || !draft || !confirmed || closing || lock.current) return; const token = epoch.current, original = draft, abort = new AbortController(); postAbort.current = abort; lock.current = true; setBusy(true); setError("");
    try { savePublicationIntent(original.intent); reloadMarkers(); if (!valid(token)) return;
      const value = await createPublicationPreview(context(abort.signal), original.input); if (!valid(token)) return;
      recordPublicationIntent(original.intent, value.request.id); reloadMarkers(); verified.current.add(value.request.id.toLowerCase()); setDetail({ value, events: null }); setOriginalId(value.request.id);
      setDraft(null); setConfirmed(false); setMessage("已读取本笔原预览回执 仅保存节点预览 不自动正式提交");
    } catch (caught) { if (valid(token)) failure(caught); }
    finally { if (valid(token)) { lock.current = false; setBusy(false); } }
  }
  async function receipt(marker: PublicationPreviewIntent) {
    if (lock.current || !valid()) return; const token = epoch.current, request = ++detailSequence.current, abort = new AbortController(); detailAbort.current?.abort(); detailAbort.current = abort; setDetailLoading(true); setDetail(null); setError("");
    try { const value = await readPublicationReceipt(context(abort.signal), { requestKey: marker.requestKey, requestChecksum: marker.requestChecksum }, marker.target); if (!valid(token) || abort.signal.aborted || request !== detailSequence.current) return;
      if (value.request) { recordPublicationIntent(marker, value.request.request.id); reloadMarkers(); verified.current.add(value.request.request.id.toLowerCase()); setDetail({ value: value.request, events: null }); setOriginalId(value.request.request.id); }
      else setMessage("尚未找到原回执 不证明未提交 原标识继续保留 不会换键或重新准备");
    } catch (caught) { if (valid(token) && !abort.signal.aborted && request === detailSequence.current) failure(caught); }
    finally { if (valid(token) && request === detailSequence.current) setDetailLoading(false); }
  }
  async function events() {
    if (!detail || lock.current) return; const original = detail.value, token = epoch.current, request = ++detailSequence.current, abort = new AbortController(); detailAbort.current?.abort(); detailAbort.current = abort; setDetailLoading(true);
    try { const value = await readPublicationPreviewEvents(context(abort.signal), original); if (valid(token) && !abort.signal.aborted && request === detailSequence.current) setDetail({ value: original, events: value }); }
    catch (caught) { if (valid(token) && !abort.signal.aborted && request === detailSequence.current) failure(caught); } finally { if (valid(token) && request === detailSequence.current) setDetailLoading(false); }
  }
  async function cancel(reason: string) {
    if (!detail?.value.access.canCancel || !access.can(Permission.ListingPublish) || lock.current || !valid() || cancelUnknown) return;
    const original = detail.value, token = epoch.current, abort = new AbortController(); postAbort.current = abort; lock.current = true; setBusy(true);
    try { const value = await cancelPublicationPreview(context(abort.signal), original, reason); if (valid(token)) { setDetail({ value, events: null }); setMessage("已读取取消后的原请求状态 不回滚已发生的外部操作"); } }
    catch (caught) { if (valid(token)) { setCancelUnknown(original.request.id); failure(caught); } } finally { if (valid(token)) { lock.current = false; setBusy(false); } }
  }
  return <section className="ppv" aria-label={readOnlyRequest ? "原发布请求核对" : "Amazon 节点校验预览"}><header className="ppv-heading"><h3><ShieldCheck size={17} />{readOnlyRequest ? "原发布请求核对" : "Amazon 节点校验预览"}</h3><button type="button" disabled={busy || reading} onClick={() => { blocked.current = false; if (readOnlyRequest && initialRequestId && wire.current) void openRequest(initialRequestId, true); else void load(); }}><RefreshCw size={14} />重新读取预览依据</button></header>
    <p>{readOnlyRequest ? "只读取链接指定的原发布请求 保留原平台动作 不通过新节点预览协议派发或继续" : "核对原批准版本与实际绑定节点 只保存 Amazon 校验预览 不发布 Listing 不自动继续正式提交 无可用节点时不转中央"}</p>
    {reading && <p role="status"><LoaderCircle size={14} className="ppv-spin" />正在核对原版本与当前本人权限</p>}{error && <p role="alert" className="ppv-error">{error}</p>}{message && !denied && <p role="status" className="ppv-notice">{message}</p>}
    {!denied && workspace && <><dl className="ppv-facts"><PreviewPair label="所选原版本">V{workspace.listing.version}<code>{workspace.listing.versionId}</code></PreviewPair><PreviewPair label="原版本标题">{workspace.listing.title}</PreviewPair>
      <PreviewPair label="今天的当前版本 ID"><code>{workspace.listing.currentVersionId ?? "当前版本不可用"}</code></PreviewPair><PreviewPair label="原版本状态">{workspace.listing.status}</PreviewPair></dl>
      {!workspace.listing.currentVersionId || !previewSameId(workspace.listing.currentVersionId, listingVersionId) ? <p className="ppv-notice">正在核对固定历史版本 不用今天版本替代 历史只读 新准备由原服务审批门裁决</p> : null}
      <details><summary>核对所选不可变 Listing 原文</summary><pre>{JSON.stringify(workspace.listing.content, null, 2)}</pre></details>
      <label><span>原批准 SKU</span><select aria-label="原批准 SKU" disabled={busy || reading} value={variant} onChange={event => { resetReview(); sequence.current++; detailSequence.current++; readAbort.current?.abort(); detailAbort.current?.abort(); setWorkspace(null); setDetail(null); setSourceKey(""); setVariant(event.target.value); }}><option value="">请选择原版本 SKU</option>{variants.map(row => <option key={row.skuId} value={row.skuId}>{row.skuCode ?? row.skuId}</option>)}</select></label>
      <form className="ppv-form" onSubmit={event => { event.preventDefault(); void review(); }}><fieldset disabled={busy || reading || !storageReady}><label><span>原店铺与站点</span><select aria-label="原店铺与站点" value={sourceKey} onChange={event => { resetReview(); setSourceKey(event.target.value); }}><option value="">请选择真实原目标</option>{workspace.sources.map(row => <option key={`${row.accountId}:${row.marketplaceId}`} value={`${row.accountId}:${row.marketplaceId}`}>{row.accountName} · {row.marketplaceId}</option>)}</select></label><button type="submit" disabled={!canPrepare}><FileSearch size={14} />核对这份原预览</button></fieldset></form>
      {source && <p className="ppv-notice">{reasons[source.reason]}</p>}{workspace.sources.length === 0 && <p>没有当前可读的店铺目标 不生成替代目标</p>}
      {initialAccountId && !workspace.sources.some(row => previewSameId(row.accountId, initialAccountId) && (!initialMarketplaceId || row.marketplaceId === initialMarketplaceId)) && <p className="ppv-notice">原来源指定的店铺或站点当前不可用 不自动代选其他目标</p>}
      {!workspace.access.canPrepare || !access.can(Permission.ListingPublish) ? <p className="ppv-caption">当前仅可读取原预览 新准备需要原发布权限和服务端当前依据允许</p> : null}
      {!storageReady && <p className="ppv-error">恢复存储未可靠核对 新准备保持关闭</p>}
      {draft && <section className={`ppv-review${closing ? " ppv-closing" : ""}`} aria-label="固定原发布预览" inert={closing} aria-hidden={closing || undefined}><header className="ppv-heading"><h4>固定原发布预览</h4><button type="button" aria-label="关闭预览核对" disabled={busy || closing} onClick={closeReview}><X size={15} /></button></header>
        <dl className="ppv-facts">{Object.entries(draft.intent.target).map(([name, value]) => <PreviewPair key={name} label={targetLabels[name] ?? name}><code>{String(value)}</code></PreviewPair>)}<PreviewPair label="原请求键"><code>{draft.intent.requestKey}</code></PreviewPair><PreviewPair label="原目标校验值"><code>{draft.intent.requestChecksum}</code></PreviewPair></dl>
        <label className="ppv-check"><input type="checkbox" checked={confirmed} disabled={busy || closing} onChange={event => setConfirmed(event.target.checked)} /><span>已核对原店铺 原批准版本与节点 只保存校验预览</span></label><button type="button" disabled={!canPrepare || !confirmed || closing} onClick={() => void submit()}><Check size={14} />保存原节点预览</button></section>}
    </>}
    {!readOnlyRequest && !denied && markers.length > 0 && <section className="ppv-recovery" aria-label="本人原发布预览恢复"><h4>本人原发布预览恢复</h4><p>只保存原 ID 固定目标与校验值 未保存原文 未核对的标识阻止新准备 刷新只读取回执</p>{markers.map(marker => <article key={marker.requestKey}><dl className="ppv-facts"><PreviewPair label="原请求键"><code>{marker.requestKey}</code></PreviewPair><PreviewPair label="原目标校验值"><code>{marker.requestChecksum}</code></PreviewPair><PreviewPair label="原发布请求 ID"><code>{marker.requestId ?? "尚待读取原回执"}</code></PreviewPair><PreviewPair label="固定原版本 ID"><code>{marker.target.listingVersionId}</code></PreviewPair></dl><div className="ppv-actions"><button type="button" disabled={busy || detailLoading || reading} onClick={() => void receipt(marker)}>只读取原预览回执</button>{marker.state === "known" && marker.requestId && <button type="button" disabled={busy || detailLoading || !verified.current.has(marker.requestId.toLowerCase())} onClick={() => { try { forgetKnownPublicationIntent(marker); reloadMarkers(); resetReview(); setMessage("已结束本次已读原请求核对 原历史仍保留"); } catch (caught) { failure(caught); } }}>结束本次原预览核对</button>}</div>{marker.state === "unknown" && <p>未知不等于未提交 不能遗忘或换键重新准备</p>}</article>)}</section>}
    {!readOnlyRequest && !denied && wireReady && <section className="ppv-history" aria-label="原发布预览读取"><header className="ppv-heading"><h4><History size={15} />原发布预览读取</h4><span>近期最多 20 条</span></header><form className="ppv-id-form" onSubmit={event => { event.preventDefault(); void openRequest(originalId); }}><label><span>原发布请求 ID</span><input value={originalId} required spellCheck={false} autoComplete="off" onChange={event => { detailSequence.current++; detailAbort.current?.abort(); setDetail(null); setOriginalId(event.target.value); }} /></label><button type="submit" disabled={busy || detailLoading}><FileSearch size={14} />读取准确原发布请求</button></form><p className="ppv-caption">近期清单不是完整历史 准确原 ID 可读取更早请求 不会读取其他 Listing 的请求</p>{workspace?.recent.length ? <ol className="ppv-list">{workspace.recent.map(row => <li key={row.request.id}><div><strong>{publicationStatusLabel(row.request.current.status)}</strong><code>{row.request.id}</code><code>{row.request.listingVersionId}</code></div><button type="button" disabled={busy || detailLoading} onClick={() => void openRequest(row.request.id)}>读取原发布预览</button></li>)}</ol> : <p>本次没有可见的近期请求 不代表没有更早历史</p>}</section>}
    {!denied && detailLoading && <p role="status">正在只读核对准确原预览</p>}
    {!denied && detail && <PublicationPreviewReceipt key={detail.value.request.id + ":" + detail.value.request.current.id} value={detail.value} events={detail.events} busy={busy || detailLoading || reading}
      canCancel={!readOnlyRequest && !cancelUnknown && access.can(Permission.ListingPublish) && detail.value.access.canCancel} onRefresh={() => void openRequest(detail.value.request.id)} onEvents={() => void events()} onCancel={reason => void cancel(reason)} />}
  </section>;
}
const targetLabels: Record<string, string> = { accountId: "原账户 ID", listingId: "原 Listing ID", listingVersionId: "固定版本 ID", marketplaceId: "原站点", variantSkuId: "固定 SKU",
  capabilitySnapshotId: "原能力版本 ID", payloadChecksum: "原载荷校验值", assetManifestChecksum: "原资产清单校验值", nodeId: "固定节点 ID", certificateGeneration: "原证书代次", authorizationGeneration: "原授权代次", bindingRevision: "原绑定修订" };
