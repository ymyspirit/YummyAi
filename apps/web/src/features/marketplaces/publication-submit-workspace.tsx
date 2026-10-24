"use client";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, FileSearch, LoaderCircle, RefreshCw, Send, X } from "lucide-react";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import { publicationSubmitRequestText, type PublicationSubmitWorkspace as Workspace, type PublicationSubmitRequestView, type PublicationStatusReadView, type PublicationSubmitReason } from "@yummyai/contracts/marketplace/publication-submit";
import { ErpIdentityContext, useErpAccess } from "../identity/erp-access";
import { publicationSubmitHash, PublicationSubmitError, publicationSubmitDenied, publicationSubmitErrorText, readPublicationSubmitWorkspace,
  readPublicationSubmission, readPublicationSubmitReceipt, readPublicationStatusReceipt, createPublicationSubmission, createPublicationStatus, cancelPublicationSubmission,
  type PublicationSubmitContext } from "./publication-submit-client";
import { publicationSubmitOwnerScope, preparePublicationSubmit, preparePublicationStatus, savePublicationSubmitIntent, recordPublicationSubmitIntent,
  readPublicationSubmitIntents, forgetPublicationSubmitIntent, type PublicationSubmitIntent } from "./publication-submit-intent";
import { PublicationSubmitReceipt, PublicationStatusReceipt, SubmissionPair, submissionStateLabel } from "./publication-submit-receipt";
import "./publication-submit.css";

type Props = { previewRequestId: string; listingId: string; listingVersionId: string; sourceBusy?: boolean };
type SubmitDraft = Awaited<ReturnType<typeof preparePublicationSubmit>>;
type StatusDraft = Awaited<ReturnType<typeof preparePublicationStatus>>;
const reasons: Record<PublicationSubmitReason, string> = { ready: "当前依据可核对", not_authorized: "当前没有此操作权限", not_configured: "节点操作未配置", legacy_preview: "旧预览没有此节点提交依据",
  preview_not_passed: "原节点预览尚未通过", source_changed: "原版本或来源已变化", not_bound: "没有合格的绑定节点", node_offline: "原绑定节点离线 任务不会回退中央", draining: "原节点租约正在排空",
  credential_unavailable: "原授权凭据不可用", capability_unavailable: "原能力版本不可用", already_submitted: "此原预览已有正式提交 请读取原请求", operation_pending: "原操作尚待核对", terminal: "原操作已结案" };
export function PublicationSubmitWorkspace(props: Props) {
  const access = useErpAccess(), session = useContext(ErpIdentityContext)?.session;
  const stamp = JSON.stringify([access.authority, props.previewRequestId, props.listingId, props.listingVersionId]), current = useRef(stamp); current.current = stamp;
  const isCurrent = useCallback(() => current.current === stamp, [stamp]);
  if (!session || !access.authority || !access.preferenceScope || !access.canAll([Permission.ListingRead, Permission.StoreRead])) return <section className="psu" aria-label="Amazon 正式提交"><p role="status">当前没有原刊登或店铺读取权限 原正式提交资料已隐藏</p></section>;
  if (![props.previewRequestId, props.listingId, props.listingVersionId].every(id => EntityIdSchema.safeParse(id).success)) return <section className="psu" aria-label="Amazon 正式提交"><p>原预览引用暂时无法核对</p></section>;
  return <SubmitPanel key={stamp} {...props} actorId={session.userId} tenantId={session.tenantId} rawAuthority={access.authority} preferenceScope={access.preferenceScope} isCurrent={isCurrent} />;
}
function SubmitPanel({ previewRequestId, listingId, listingVersionId, sourceBusy = false, actorId, tenantId, rawAuthority, preferenceScope, isCurrent }: Props & {
  actorId: string; tenantId: string; rawAuthority: string; preferenceScope: string; isCurrent(): boolean;
}) {
  const access = useErpAccess(), alive = useRef(true), ended = useRef(false), epoch = useRef(0), sequence = useRef(0), detailSequence = useRef(0), lock = useRef(false), detailLock = useRef(false);
  const reads = useRef<AbortController | null>(null), details = useRef<AbortController | null>(null), writes = useRef<AbortController | null>(null), owner = useRef<string | null>(null);
  const workspaceRef = useRef<Workspace | null>(null), detailRef = useRef<PublicationSubmitRequestView | null>(null), verified = useRef(new Set<string>()), closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null), reviewSequence = useRef(0);
  const [opened, setOpened] = useState(false), [workspace, setWorkspace] = useState<Workspace | null>(null), [detail, setDetail] = useState<PublicationSubmitRequestView | null>(null);
  const [status, setStatus] = useState<PublicationStatusReadView | null>(null), [markers, setMarkers] = useState<PublicationSubmitIntent[]>([]), [storageReady, setStorageReady] = useState(false);
  const [reading, setReading] = useState(false), [detailLoading, setDetailLoading] = useState(false), [busy, setBusy] = useState(false), [denied, setDenied] = useState(false), [message, setMessage] = useState("");
  const [draft, setDraft] = useState<SubmitDraft | null>(null), [statusDraft, setStatusDraft] = useState<StatusDraft | null>(null), [confirmed, setConfirmed] = useState(false), [statusConfirmed, setStatusConfirmed] = useState(false), [closing, setClosing] = useState(false);
  const [originalId, setOriginalId] = useState(""), [cancelUnknown, setCancelUnknown] = useState<string | null>(null);
  const valid = useCallback((token = epoch.current) => alive.current && !ended.current && isCurrent() && token === epoch.current, [isCurrent]);
  const stopClosing = useCallback(() => { if (closeTimer.current !== null) clearTimeout(closeTimer.current); closeTimer.current = null; setClosing(false); }, []);
  const resetDraft = useCallback(() => { reviewSequence.current++; stopClosing(); setDraft(null); setStatusDraft(null); setConfirmed(false); setStatusConfirmed(false); }, [stopClosing]);
  const clearPrivate = useCallback(() => {
    epoch.current++; sequence.current++; detailSequence.current++; for (const controller of [reads, details, writes]) controller.current?.abort();
    lock.current = false; detailLock.current = false; workspaceRef.current = null; detailRef.current = null; verified.current.clear();
    setWorkspace(null); setDetail(null); setStatus(null); setOriginalId(""); resetDraft(); setReading(false); setDetailLoading(false); setBusy(false); setCancelUnknown(null);
  }, [resetDraft]);
  useEffect(() => {
    alive.current = true; const clear = () => { ended.current = true; clearPrivate(); owner.current = null; setMarkers([]); setStorageReady(false); setDenied(true); setMessage("本人会话已清除 原正式提交资料已隐藏"); };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); alive.current = false; epoch.current++; for (const controller of [reads, details, writes]) controller.current?.abort(); if (closeTimer.current !== null) clearTimeout(closeTimer.current); };
  }, [clearPrivate]);
  useEffect(() => { if (sourceBusy) resetDraft(); }, [sourceBusy, resetDraft]);
  const context = useCallback(async (signal: AbortSignal, token: number): Promise<PublicationSubmitContext> => {
    const authority = await publicationSubmitHash(rawAuthority); if (!valid(token) || signal.aborted) throw new PublicationSubmitError(0);
    return { authority, actorId, tenantId, previewRequestId, listingId, listingVersionId, signal };
  }, [actorId, tenantId, previewRequestId, listingId, listingVersionId, rawAuthority, valid]);
  const reloadMarkers = useCallback(() => {
    if (!owner.current) throw new PublicationSubmitError(0); const values = readPublicationSubmitIntents(owner.current);
    if (values.some(value => value.previewRequestId.toLowerCase() !== previewRequestId.toLowerCase())) throw new PublicationSubmitError(502);
    setMarkers(values); setStorageReady(true); return values;
  }, [previewRequestId]);
  const failure = useCallback((caught: unknown) => {
    const error = caught instanceof PublicationSubmitError ? caught : new PublicationSubmitError(502);
    if (publicationSubmitDenied(error)) { clearPrivate(); setDenied(true); }
    setMessage(publicationSubmitErrorText(error));
  }, [clearPrivate]);
  const accept = useCallback((value: PublicationSubmitRequestView) => { if (detailRef.current && (detailRef.current.request.id !== value.request.id || detailRef.current.request.current.id !== value.request.current.id ||
    JSON.stringify(detailRef.current.statusTarget) !== JSON.stringify(value.statusTarget))) resetDraft();
    detailRef.current = value; setDetail(value); setOriginalId(value.request.id); verified.current.add(value.request.id.toLowerCase());
    if (!value.access.canCancel) setCancelUnknown(null); }, [resetDraft]);
  const load = useCallback(async () => {
    if (!valid() || lock.current) return; const token = epoch.current, number = ++sequence.current, abort = new AbortController(); reads.current?.abort(); reads.current = abort; resetDraft(); setReading(true);
    try {
      const ownerScope = await publicationSubmitOwnerScope(preferenceScope, listingId, listingVersionId, previewRequestId); if (!valid(token) || abort.signal.aborted) return;
      owner.current = ownerScope; try { reloadMarkers(); } catch { setStorageReady(false); }
      const value = await readPublicationSubmitWorkspace(await context(abort.signal, token)); if (!valid(token) || abort.signal.aborted || sequence.current !== number) return;
      workspaceRef.current = value; setWorkspace(value); setDenied(false); setMessage("");
    } catch (error) { if (valid(token) && !abort.signal.aborted && sequence.current === number) failure(error); }
    finally { if (valid(token) && sequence.current === number) setReading(false); }
  }, [context, failure, listingId, listingVersionId, preferenceScope, previewRequestId, reloadMarkers, resetDraft, valid]);
  useEffect(() => {
    if (!opened) { reads.current?.abort(); details.current?.abort(); return; } void load();
    const shown = () => { if (document.visibilityState !== "hidden") void load(); }; window.addEventListener("focus", shown); window.addEventListener("pageshow", shown);
    return () => { window.removeEventListener("focus", shown); window.removeEventListener("pageshow", shown); };
  }, [load, opened]);
  const openRequest = useCallback(async (id: string, poll = false) => {
    if (!valid() || lock.current || detailLock.current || denied) return; const token = epoch.current, number = ++detailSequence.current, abort = new AbortController(); details.current?.abort(); details.current = abort;
    detailLock.current = true; setDetailLoading(true); if (!poll) { resetDraft(); detailRef.current = null; setDetail(null); setStatus(null); }
    try { const value = await readPublicationSubmission(await context(abort.signal, token), id); if (valid(token) && !abort.signal.aborted && number === detailSequence.current) accept(value); }
    catch (error) { if (valid(token) && !abort.signal.aborted && number === detailSequence.current) failure(error); }
    finally { if (valid(token) && number === detailSequence.current) { detailLock.current = false; setDetailLoading(false); } }
  }, [accept, context, denied, failure, resetDraft, valid]);
  useEffect(() => {
    if (!opened || !detail || denied || ![detail.execution, ...detail.statusReads.map(row => row.execution)].some(value => ["waiting_node", "claimed", "running"].includes(value.state))) return;
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void openRequest(detail.request.id, true); }, 3000); return () => clearInterval(timer);
  }, [denied, detail, openRequest, opened]);
  const hasUnknown = markers.some(row => row.state === "unknown"), canWrite = access.can(Permission.ListingPublish) && storageReady && !sourceBusy && !reading && !busy && !detailLoading && !denied;
  const canSubmit = canWrite && workspace?.access.canSubmit && workspace.target && !markers.some(row => row.operation === "submit") && !hasUnknown;
  const canStatus = canWrite && detail?.access.canReadStatus && detail.statusTarget && !markers.some(row => row.operation === "status") && !hasUnknown;
  async function review(kind: "submit" | "status") {
    if (!valid() || lock.current || (kind === "submit" ? !canSubmit : !canStatus) || !owner.current) return;
    const token = epoch.current, basis = workspaceRef.current, parent = detailRef.current; lock.current = true; resetDraft(); const reviewNumber = reviewSequence.current;
    try { reloadMarkers();
      if (kind === "submit" && basis?.target) { const value = await preparePublicationSubmit(basis.target, owner.current); if (valid(token) && reviewSequence.current === reviewNumber && workspaceRef.current === basis) setDraft(value); }
      if (kind === "status" && parent?.statusTarget) { const value = await preparePublicationStatus(parent.statusTarget, previewRequestId, owner.current); if (valid(token) && reviewSequence.current === reviewNumber && detailRef.current === parent) setStatusDraft(value); }
    } catch (error) { if (valid(token)) failure(error); } finally { if (valid(token)) lock.current = false; }
  }
  function closeReview() {
    if (lock.current || closing) return; setConfirmed(false); setStatusConfirmed(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { resetDraft(); return; }
    const token = epoch.current; setClosing(true); closeTimer.current = setTimeout(() => { closeTimer.current = null; if (valid(token)) { setDraft(null); setStatusDraft(null); setClosing(false); } }, 150);
  }
  async function submit(kind: "submit" | "status") {
    const original = kind === "submit" ? draft : statusDraft, parent = detailRef.current;
    if (!original || !valid() || lock.current || closing || (kind === "submit" ? !canSubmit || !confirmed : !canStatus || !statusConfirmed || !parent)) return;
    const token = epoch.current, abort = new AbortController(); writes.current = abort; lock.current = true; setBusy(true); setMessage("");
    try {
      if (kind === "submit") {
        const { requestKey: _key, requestChecksum: _sum, acknowledgeReplacement: _ack, ...target } = draft!.input; void _key; void _sum; void _ack;
        if (!workspaceRef.current?.target || publicationSubmitRequestText(workspaceRef.current.target) !== publicationSubmitRequestText(target)) throw new PublicationSubmitError(409);
      }
      savePublicationSubmitIntent(original.intent); reloadMarkers(); if (!valid(token)) return;
      const wire = await context(abort.signal, token);
      if (kind === "submit") { const value = await createPublicationSubmission(wire, draft!.input); if (!valid(token) || abort.signal.aborted) return; recordPublicationSubmitIntent(original.intent, value.request.id); reloadMarkers(); accept(value); }
      else { const value = await createPublicationStatus(wire, parent!, statusDraft!.input); if (!valid(token) || abort.signal.aborted) return; recordPublicationSubmitIntent(original.intent, value.id); reloadMarkers(); verified.current.add(value.id.toLowerCase()); setStatus(value); }
      resetDraft(); setMessage(kind === "submit" ? "已读取原正式提交回执 任务已保存不等于平台可售" : "已保存独立原状态查询 不会重新发送正式 PUT");
    } catch (error) { if (valid(token)) { try { reloadMarkers(); } catch { setStorageReady(false); } failure(error); } }
    finally { if (valid(token)) { lock.current = false; setBusy(false); } }
  }
  async function recover(marker: PublicationSubmitIntent) {
    if (!valid() || lock.current || detailLock.current || denied) return; const token = epoch.current, number = ++detailSequence.current, abort = new AbortController(); details.current?.abort(); details.current = abort;
    detailLock.current = true; setDetailLoading(true); resetDraft();
    try { const wire = await context(abort.signal, token), lookup = { requestKey: marker.requestKey, requestChecksum: marker.requestChecksum };
      if (marker.operation === "submit") { const value = await readPublicationSubmitReceipt(wire, lookup); if (!valid(token) || abort.signal.aborted || number !== detailSequence.current) return;
        if (!value.request) { setMessage("尚未找到原回执 不证明没有提交 原请求保留 不换键重发"); return; }
        if (marker.resultId && marker.resultId.toLowerCase() !== value.request.request.id.toLowerCase()) throw new PublicationSubmitError(502);
        recordPublicationSubmitIntent(marker, value.request.request.id); accept(value.request);
      } else { const value = await readPublicationStatusReceipt(wire, lookup, marker.sourceId); if (!valid(token) || abort.signal.aborted || number !== detailSequence.current) return;
        if (!value.operation) { setMessage("尚未找到原状态查询回执 不证明没有保存 原键保持不变"); return; }
        if (marker.resultId && marker.resultId.toLowerCase() !== value.operation.id.toLowerCase()) throw new PublicationSubmitError(502);
        recordPublicationSubmitIntent(marker, value.operation.id); verified.current.add(value.operation.id.toLowerCase()); setStatus(value.operation);
      }
      reloadMarkers(); setMessage("已只读核对同一原请求 没有重新提交或调用平台");
    } catch (error) { if (valid(token) && !abort.signal.aborted && number === detailSequence.current) failure(error); }
    finally { if (valid(token) && number === detailSequence.current) { detailLock.current = false; setDetailLoading(false); } }
  }
  async function cancel(reason: string) {
    const parent = detailRef.current; if (!canWrite || !parent?.access.canCancel || cancelUnknown === parent.request.id || lock.current || !valid()) return;
    const token = epoch.current, abort = new AbortController(); writes.current = abort; lock.current = true; setBusy(true);
    try { const value = await cancelPublicationSubmission(await context(abort.signal, token), parent, reason); if (valid(token) && !abort.signal.aborted) { accept(value); setMessage("已读取原取消回执 不撤回已发生的平台动作"); } }
    catch (error) { if (valid(token)) { setCancelUnknown(parent.request.id); failure(error); } } finally { if (valid(token)) { lock.current = false; setBusy(false); } }
  }
  return <section className="psu" aria-label="Amazon 正式提交"><details className="psu-workspace" open={opened}><summary onClick={event => { event.preventDefault(); if (!lock.current) { resetDraft(); setOpened(value => !value); } }}><Send size={16} />正式提交本次原预览<ChevronDown size={14} /></summary>
    <p>此处明确执行正式刊登 完整替换所选站点的原 SKU 内容 与校验预览分开 不自动执行 不回退中央连接</p>
    <div className="psu-actions"><button type="button" disabled={busy || reading} onClick={() => void load()}><RefreshCw size={14} />重新读取正式提交依据</button></div>
    {(reading || detailLoading) && <p role="status"><LoaderCircle size={14} className="psu-spin" />正在只读核对原请求和当前权限</p>}{message && <p className="psu-notice" role="status">{message}</p>}
    {!denied && workspace && <><p>{reasons[workspace.reason]}</p><dl className="psu-facts"><SubmissionPair label="原预览请求 ID"><code>{workspace.preview.request.id}</code></SubmissionPair><SubmissionPair label="原预览事件序号">{workspace.preview.request.current.sequence}</SubmissionPair></dl>
      {workspace.target && <dl className="psu-facts"><SubmissionPair label="本次原 SKU"><code>{workspace.target.sku}</code></SubmissionPair><SubmissionPair label="原站点">{workspace.target.marketplaceId}</SubmissionPair><SubmissionPair label="固定批准版本 ID"><code>{workspace.target.listingVersionId}</code></SubmissionPair><SubmissionPair label="固定节点 ID"><code>{workspace.target.nodeId}</code></SubmissionPair></dl>}
      <div className="psu-actions"><button type="button" disabled={!canSubmit} onClick={() => void review("submit")}><FileSearch size={14} />核对正式提交完整替换</button></div>
      {!access.can(Permission.ListingPublish) && <p>当前仅可读取原任务 正式提交与平台状态查询需原发布权限</p>}
      <details><summary>此原预览的近期正式请求 · {workspace.recent.length} 条</summary><p>近期最多 20 条 不代表完整历史</p>{workspace.recent.map(row => <div className="psu-history-row" key={row.request.id}><span>{submissionStateLabel(row.request.current.status)}</span><code>{row.request.id}</code><button disabled={busy || detailLoading} type="button" onClick={() => void openRequest(row.request.id)}>读取原正式请求</button></div>)}</details>
    </>}
    {!denied && (draft || statusDraft) && <section className={`psu-review${closing ? " psu-closing" : ""}`} aria-label={draft ? "固定原正式提交核对" : "固定原平台状态查询核对"} inert={closing} aria-hidden={closing || undefined}><header className="psu-heading"><h4>{draft ? "固定原正式提交核对" : "固定原平台状态查询核对"}</h4><button aria-label="关闭本次操作核对" type="button" disabled={busy || closing} onClick={closeReview}><X size={14} /></button></header>
      <dl className="psu-facts">{Object.entries((draft ?? statusDraft)!.input).map(([key, value]) => <SubmissionPair key={key} label={fieldLabel(key)}><code>{value === null ? "未知 未取得" : String(value)}</code></SubmissionPair>)}</dl>
      {draft ? <><p className="psu-warning">本次为正式 PUT 会以固定批准版本完整替换该 SKU 的站点内容 预览通过不能保证提交接受或最终可售</p><label className="psu-check"><input type="checkbox" checked={confirmed} disabled={busy || closing} onChange={event => setConfirmed(event.target.checked)} /><span>已核对原店铺 SKU 与版本 明确同意完整替换并正式提交</span></label><button type="button" disabled={!canSubmit || !confirmed || closing} onClick={() => void submit("submit")}><Send size={14} />确认正式提交至 Amazon</button></> : <><p>{statusDraft!.input.sourceSubmissionId === null ? "原平台提交 ID 未取得 本次仅查询 SKU 不能证明未知正式 PUT 成功" : "本次按原请求的 SKU 查询平台当前状态 不重新发送 PUT"}</p><label className="psu-check"><input type="checkbox" checked={statusConfirmed} disabled={busy || closing} onChange={event => setStatusConfirmed(event.target.checked)} /><span>已核对原请求 明确读取平台当前状态 不重新提交</span></label><button type="button" disabled={!canStatus || !statusConfirmed || closing} onClick={() => void submit("status")}><RefreshCw size={14} />确认保存原平台状态查询</button></>}
    </section>}
    {!denied && storageReady && markers.length > 0 && <section className="psu-recovery" aria-label="本人原正式操作恢复"><h4>本人原正式操作恢复</h4><p>仅保存原 ID 校验值与状态 没有原文或凭据 未知请求只读取原回执 不换键重新发送</p>{markers.map(marker => <article key={marker.requestKey}><dl className="psu-facts"><SubmissionPair label="原操作">{marker.operation === "submit" ? "正式提交" : "平台状态查询"}</SubmissionPair><SubmissionPair label="原请求键"><code>{marker.requestKey}</code></SubmissionPair><SubmissionPair label="原请求校验值"><code>{marker.requestChecksum}</code></SubmissionPair><SubmissionPair label="原结果 ID"><code>{marker.resultId ?? "尚未取得 请只读恢复"}</code></SubmissionPair></dl><div className="psu-actions"><button disabled={busy || detailLoading || reading} type="button" onClick={() => void recover(marker)}>只读取原操作回执</button>{marker.state === "known" && marker.resultId && <button type="button" disabled={busy || !verified.current.has(marker.resultId.toLowerCase())} onClick={() => { try { forgetPublicationSubmitIntent(marker); reloadMarkers(); resetDraft(); setMessage("已结束本次已读原操作核对 原历史保留"); } catch (error) { failure(error); } }}><Check size={14} />结束本次已读操作核对</button>}</div></article>)}</section>}
    {!storageReady && <p>原请求标识尚未可靠核对 新操作保持关闭</p>}
    {!denied && opened && <form className="psu-id-form" onSubmit={event => { event.preventDefault(); void openRequest(originalId); }}><label><span>准确原正式请求 ID</span><input required value={originalId} onChange={event => { detailSequence.current++; details.current?.abort(); detailLock.current = false; setDetailLoading(false); detailRef.current = null; setDetail(null); setStatus(null); resetDraft(); setOriginalId(event.target.value); }} /></label><button disabled={busy || detailLoading || reading} type="submit">读取准确原正式请求</button></form>}
    {!denied && detail && <><PublicationSubmitReceipt key={detail.request.id + ":" + detail.request.current.id} value={detail} busy={busy || detailLoading || reading} cancelBlocked={cancelUnknown === detail.request.id || !access.can(Permission.ListingPublish)} onRefresh={() => void openRequest(detail.request.id)} onCancel={reason => void cancel(reason)} /><p>{reasons[detail.statusReason]}</p><div className="psu-actions"><button type="button" disabled={!canStatus} onClick={() => void review("status")}>核对独立平台状态查询</button></div></>}
    {!denied && status && <PublicationStatusReceipt value={status} />}
  </details></section>;
}
function fieldLabel(key: string) { return ({ accountId: "原账户 ID", listingId: "原 Listing ID", listingVersionId: "固定批准版本 ID", marketplaceId: "原站点", variantSkuId: "原规格 ID", sku: "原 SKU", capabilitySnapshotId: "原能力版本 ID", payloadChecksum: "原载荷校验值", assetManifestChecksum: "原资产清单校验值", nodeId: "固定节点 ID", certificateGeneration: "原证书代次", authorizationGeneration: "原授权代次", bindingRevision: "原绑定修订", previewRequestId: "原预览请求 ID", previewEventId: "原预览事件 ID", previewEventSequence: "原预览事件序号", previewExecutionId: "原预览节点任务 ID", requestKey: "本次原请求键", requestChecksum: "本次原目标校验值", acknowledgeReplacement: "明确完整替换", publicationRequestId: "原正式请求 ID", submissionExecutionId: "原正式节点任务 ID", submissionTargetChecksum: "原正式目标校验值", sourceEventId: "所引原事件 ID", sourceEventSequence: "所引原事件序号", sourceSubmissionId: "所引平台提交 ID" } as Record<string, string>)[key] ?? key; }
