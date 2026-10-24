"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Check, ClipboardCheck, Plus, RefreshCw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { ProductionQuantityWorkspaceSchema, ProductionQuantityReportResultSchema, ProductionQuantityReviewResultSchema,
  type ProductionQuantityWorkspace as Workspace, type ProductionQuantityBasis, type ProductionQuantityReportView,
  type ProductionQuantityReviewView } from "@yummyai/contracts/order/production-quantity";
import { useErpAccess } from "../identity/erp-access";
import { RecordDialog } from "../manual-operations/record-form";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { ProductionStopForm, PhysicalQuantities, productionQuantityUnit, type ProductionStopEditor, type ProductionStopIntent } from "./production-stop-form";
import { label } from "./order-center-model";
import "./production-stop.css";

type Receipt = z.infer<typeof ProductionQuantityReportResultSchema> | z.infer<typeof ProductionQuantityReviewResultSchema>;
type Editor = { scope: string; value: ProductionStopEditor };
type Pending = { scope: string; editor: ProductionStopEditor; intent: ProductionStopIntent };
class QuantityRequestError extends Error { constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); } }
const deniedRequest = (error: unknown) => error instanceof QuantityRequestError && ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
const knownRejection = (error: unknown) => error instanceof QuantityRequestError && !deniedRequest(error) && [400, 409, 413, 415, 422].includes(error.status);
const message = (error: unknown) => error instanceof QuantityRequestError ? error.message : "数量依据暂时无法核对 请重新读取实际记录";
async function quantityRequest<S extends z.ZodType>(productionOrderId: string, schema: S, authority: string | null, localDevelopment: boolean,
  query = "", intent?: ProductionStopIntent, signal?: AbortSignal): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch(`/api/production-quantity/orders/${productionOrderId}/quantity${intent ? `/${intent.kind === "report" ? "reports" : "reviews"}` : ""}${query ? `?${query}` : ""}`, {
      method: intent ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error", headers: { accept: "application/json", ...(intent ? { "content-type": "application/json" } : {}) },
      ...(intent ? { body: JSON.stringify(intent.input) } : {}), signal: intent ? AbortSignal.timeout(60_000) : AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25_000)]),
    });
  } catch (error) { if (signal?.aborted) throw error; throw new QuantityRequestError(0, intent ? "本次写入响应尚未确认 已保留原请求 请按原编号重试核对" : "数量依据读取中断 请重新读取"); }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0, raw: unknown = null;
  try {
    if (reader) { while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
      if (size > (response.ok ? 8_388_608 : 8_192)) { await reader.cancel(); throw new Error("size"); } chunks.push(chunk.value); }
      const bytes = new Uint8Array(size); let offset = 0; chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; }); raw = JSON.parse(new TextDecoder().decode(bytes)); }
  } catch { if (response.ok) throw new QuantityRequestError(502, "完整数量回执无法核对 未截断或补写原记录"); }
  finally { reader?.releaseLock(); }
  if (!response.ok) {
    const code = raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    const messages: Record<number, string> = { 400: "请核对完整实际数量与原凭证", 401: "当前身份已失效 私有数量资料已清除", 403: "当前权限不足 私有数量资料已清除", 404: "原生产或数量凭据当前不可访问", 409: "原生产 核准或实物依据已变化 请读取后核对 不自动替换原请求", 413: "完整数量凭据超过支持大小 未截断提交", 422: "实际数量或全部工序未投入依据未通过核对" };
    throw new QuantityRequestError(response.status, code ? "当前身份或权限范围已变化 私有数量资料已清除" : messages[response.status] ?? "数量服务结果尚未确认 请保留原请求后重试", code);
  }
  const parsed = schema.safeParse(raw); if (!parsed.success) throw new QuantityRequestError(502, "数量回执格式无法核对 未用旧资料补填");
  const value = parsed.data;
  if (value && typeof value === "object" && "contextAuthority" in value && !localDevelopment && (!authority || value.contextAuthority !== authority))
    throw new QuantityRequestError(409, "当前身份或权限范围已变化 私有数量资料已清除", "authority_changed");
  return value;
}
export function ProductionQuantityBasisSummary({ basis }: { basis: ProductionQuantityBasis }) {
  const unit = productionQuantityUnit(basis.unit);
  return <section aria-label="原生产数量依据"><dl className="ps-pairs">
    <div><dt>原生产数量与单位</dt><dd>{basis.quantity} {unit} · {label(basis.status)}</dd></div>
    <div><dt>此前已核准停做</dt><dd>{basis.cumulativeStoppedQuantity} {unit}</dd></div>
    <div><dt>实际质检分组数量</dt><dd>{basis.groupedQuantity} {unit}</dd></div>
    <div><dt>分组检验合格数量</dt><dd>{basis.groupedPassedQuantity} {unit}</dd></div>
    <div><dt>实际装箱分配数量</dt><dd>{basis.allocatedQuantity} {unit}</dd></div>
    <div><dt>已交运数量 已含在完工中</dt><dd>{basis.shippedQuantity} {unit}</dd></div>
    <div><dt>有事实支持的完工下界</dt><dd>{basis.completedLowerBound} {unit}</dd></div>
  </dl><p>生产版本 <code>{basis.productionVersionId}</code> · 原生产依据 V{basis.projectionVersion}<br />制造绑定 <code>{basis.manufacturingBindingId ?? "原记录未保留"}</code> · 原制造版本 <code>{basis.manufacturingVersionId ?? "原记录未保留"}</code></p>
    {basis.unknownShipmentSource && <p className="ps-error">存在无法精确归属的旧交运来源 数量下界待核对 不能按 0 处理</p>}
    <h4>最近核准保存的实物数量</h4><PhysicalQuantities quantities={basis.currentQuantities} unit={basis.unit} />
    <p>完工包含已交运 不另加交运数量 不合格不等于实际报废 状态与产能承诺均不代表实物清点</p></section>;
}
export function ProductionQuantityReportSummary({ report, unit }: { report: ProductionQuantityReportView; unit: ProductionQuantityBasis["unit"] }) {
  return <><p>数量报告 <code>{report.id}</code> · 实际清点 {report.input.observedAt}</p><PhysicalQuantities quantities={report.input.quantities} unit={unit} />
    <p>凭证 {report.input.evidenceCode} · 人工登记者 <code>{report.createdBy}</code> · 登记 {report.createdAt}</p>
    <p>原生产版本 <code>{report.productionVersionId}</code> · 原核准 <code>{report.previousReviewId ?? "尚无"}</code></p>
    {report.input.evidenceAssetIds.map(id => <p key={id}>原附件 <code>{id}</code></p>)}</>;
}
export function ProductionQuantityReviewSummary({ review, unit }: { review: ProductionQuantityReviewView; unit: ProductionQuantityBasis["unit"] }) {
  return <><p>运营核准 <code>{review.id}</code> · 第 {review.sequence} 次 · 核准发生 {review.input.occurredAt}</p>
    <p>本次新增停做 {review.input.stoppedDelta} {productionQuantityUnit(unit)} · 此次核准后累计停做 {review.cumulativeStoppedQuantity} {productionQuantityUnit(unit)}</p>
    <PhysicalQuantities quantities={review.quantities} unit={unit} /><p>以上为本次核准保存的数量 后续变化另记 不代表今天重新清点</p>
    <p>原报告 <code>{review.reportId}</code> · 原核准 <code>{review.previousReviewId ?? "尚无"}</code><br />凭证 {review.input.evidenceCode} · 运营核准者 <code>{review.createdBy}</code> · 登记 {review.createdAt}</p>
    <p>{review.input.unstartedAcrossAllPoolsConfirmed ? "已明确确认新增停做实物在全部绑定工序均未投入" : "本次未声明全部工序均未投入"}</p></>;
}
function QuantityReceipt({ receipt, basis, onClose }: { receipt: Receipt; basis: ProductionQuantityBasis; onClose(): void }) {
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { const node = title.current; const dialog = node?.closest("dialog"); if (dialog) dialog.scrollTop = 0; node?.focus({ preventScroll: true }); }, []);
  return <section aria-label="本次数量操作回执"><h3 ref={title} tabIndex={-1}>{"report" in receipt ? "数量报告已保存" : "新增停做核准已登记"}</h3>
    <p>{receipt.replayed ? "已读取同一原请求的既有结果 没有另建记录" : "本次操作已登记"} · 以下是保存时的不可变凭据</p>
    {"report" in receipt ? <ProductionQuantityReportSummary report={receipt.report} unit={basis.unit} /> : <ProductionQuantityReviewSummary review={receipt.review} unit={basis.unit} />}
    <p>本次不自动转换生产状态 不退款 不返库 不创建补做 产能影响以实际台账为准</p><button className="primary" type="button" onClick={onClose}><Check size={14} aria-hidden="true" />确认数量凭据并返回</button></section>;
}
export function ProductionStopWorkspace({ productionOrderId, refresh, disabled = false, onChanged }: { productionOrderId: string; refresh: string; disabled?: boolean; onChanged(): void }) {
  const access = useErpAccess(), canRead = access.canTenant(Permission.OrderRead), canWrite = access.canTenant(Permission.OrderWrite);
  const scope = JSON.stringify([access.authority, access.preferenceScope, productionOrderId, canRead, canWrite]);
  const [open, setOpen] = useState(false), [reload, setReload] = useState(0), [deniedScope, setDeniedScope] = useState("");
  const [read, setRead] = useState<{ scope: string; value: Workspace | null; reading: boolean; error: string } | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null), [pending, setPending] = useState<Pending | null>(null), [receipt, setReceipt] = useState<{ scope: string; value: Receipt; basis: ProductionQuantityBasis } | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(""), [rejected, setRejected] = useState(false), [closing, setClosing] = useState(false);
  const live = useRef({ scope, canRead, canWrite }), sequence = useRef(0), writeEpoch = useRef(0), alive = useRef(true), sending = useRef<{ scope: string; epoch: number } | null>(null), controller = useRef<AbortController | null>(null), closeTimer = useRef<number | null>(null);
  live.current = { scope, canRead, canWrite };
  useLeaveGuard(!!pending, busy, true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; writeEpoch.current++; controller.current?.abort(); if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }; }, []);
  useLayoutEffect(() => { sequence.current++; writeEpoch.current++; controller.current?.abort(); if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    sending.current = null; setRead(null); setEditor(null); setPending(null); setReceipt(null); setFailure(""); setRejected(false); setBusy(false); setClosing(false); setDeniedScope(""); }, [scope]);
  const deny = useCallback(() => { sequence.current++; writeEpoch.current++; controller.current?.abort(); sending.current = null; setDeniedScope(scope); setRead(null); setEditor(null); setPending(null); setReceipt(null); setFailure(""); setBusy(false); window.dispatchEvent(new Event("focus")); }, [scope]);
  useEffect(() => {
    if (!open || !canRead || deniedScope === scope) return;
    const abort = new AbortController(), token = ++sequence.current; controller.current?.abort(); controller.current = abort;
    const valid = () => !abort.signal.aborted && live.current.scope === scope && live.current.canRead && sequence.current === token;
    setRead(previous => ({ scope, value: previous?.scope === scope ? previous.value : null, reading: true, error: "" }));
    void quantityRequest(productionOrderId, ProductionQuantityWorkspaceSchema, access.authority, access.localDevelopment, "limit=20", undefined, abort.signal).then(value => {
      if (!valid()) return; if (value.basis.productionOrderId !== productionOrderId) throw new Error("parent"); setRead({ scope, value, reading: false, error: "" });
    }).catch(error => { if (valid()) { if (deniedRequest(error)) deny(); else setRead(previous => ({ scope, value: previous?.scope === scope ? previous.value : null, reading: false, error: message(error) })); } });
    return () => abort.abort();
  // The identity scope owns private state; ordinary refresh never replaces a frozen request.
  }, [scope, open, canRead, deniedScope, productionOrderId, refresh, reload, access.authority, access.localDevelopment, deny]);
  useEffect(() => { const check = () => { if (document.visibilityState !== "hidden") setReload(value => value + 1); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check); return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); }; }, []);
  const permitted = canRead && deniedScope !== scope, current = permitted && read?.scope === scope ? read : null, view = current?.value;
  const writable = permitted && canWrite && view?.access.canWrite === true;
  const editing = permitted && canWrite && editor?.scope === scope ? editor : null, frozen = permitted && pending?.scope === scope ? pending : null;
  const saved = permitted && receipt?.scope === scope ? receipt : null;
  async function send(value: Pending) {
    if (sending.current?.scope === value.scope || live.current.scope !== value.scope || !live.current.canRead || !live.current.canWrite || deniedScope === scope) return;
    const epoch = writeEpoch.current, ticket = { scope: value.scope, epoch }; sending.current = ticket; setPending(value); setBusy(true); setFailure(""); setRejected(false);
    sequence.current++; controller.current?.abort(); setRead(previous => previous ? { ...previous, reading: false } : previous);
    const valid = () => alive.current && live.current.scope === value.scope && live.current.canRead && live.current.canWrite && epoch === writeEpoch.current;
    try {
      const result = value.intent.kind === "report" ? await quantityRequest(productionOrderId, ProductionQuantityReportResultSchema, access.authority, access.localDevelopment, "", value.intent)
        : await quantityRequest(productionOrderId, ProductionQuantityReviewResultSchema, access.authority, access.localDevelopment, "", value.intent);
      if (!valid()) return;
      const record = "report" in result ? result.report : result.review;
      if (record.productionOrderId !== productionOrderId || record.input.idempotencyKey !== value.intent.input.idempotencyKey) throw new Error("parent");
      setReceipt({ scope: value.scope, value: result, basis: value.editor.basis }); setPending(null);
    } catch (error) { if (valid()) { if (deniedRequest(error)) deny(); else { setFailure(message(error)); setRejected(knownRejection(error)); } } }
    finally { if (sending.current === ticket) sending.current = null; if (valid()) setBusy(false); }
  }
  function close(discard = false) {
    if (busy) return;
    const finish = () => { if (live.current.scope !== scope) return; setClosing(false); setEditor(null); setReceipt(null); if (discard) { setPending(null); setFailure(""); setRejected(false); }
      if (saved || discard) { setReload(value => value + 1); onChanged(); } };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); setClosing(true); closeTimer.current = window.setTimeout(finish, 150); }
  }
  async function more(kind: "reports" | "reviews") {
    if (!view || current?.reading || busy) return;
    const before = kind === "reports" ? view.reportsNextCursor : view.reviewsNextCursor; if (!before) return;
    const abort = new AbortController(), token = ++sequence.current; controller.current?.abort(); controller.current = abort;
    const valid = () => !abort.signal.aborted && live.current.scope === scope && live.current.canRead && sequence.current === token;
    setRead({ scope, value: view, reading: true, error: "" });
    try {
      const next = await quantityRequest(productionOrderId, ProductionQuantityWorkspaceSchema, access.authority, access.localDevelopment,
        new URLSearchParams({ limit: "20", [kind === "reports" ? "reportsBefore" : "reviewsBefore"]: before }).toString(), undefined, abort.signal);
      if (!valid()) return; if (next.basis.productionOrderId !== productionOrderId) throw new Error("parent");
      const merge = <T extends { id: string }>(left: T[], right: T[]) => [...new Map([...left, ...right].map(row => [row.id, row])).values()];
      setRead({ scope, reading: false, error: "", value: kind === "reports" ? { ...view, basis: next.basis, reports: merge(view.reports, next.reports), reportsNextCursor: next.reportsNextCursor }
        : { ...view, basis: next.basis, reviews: merge(view.reviews, next.reviews), reviewsNextCursor: next.reviewsNextCursor } });
    } catch (error) { if (valid()) { if (deniedRequest(error)) deny(); else setRead({ scope, value: view, reading: false, error: message(error) }); } }
  }
  return <section className="ps-workspace" aria-label="实际停单数量凭证" aria-busy={current?.reading ?? false}><header><h4><ClipboardCheck size={15} aria-hidden="true" /> 实际停单数量凭证</h4>
    <button className="oc-text-button" type="button" disabled={!canRead || current?.reading || busy} onClick={() => { setDeniedScope(""); setOpen(true); setReload(value => value + 1); }}><RefreshCw size={14} aria-hidden="true" />{open ? "重新读取实物数量与停做凭据" : "读取实物数量与停做凭据"}</button></header>
    <p>先登记实际清点报告 再由运营核准新增停做 当前仅人工登记 不代表工厂本人回执 不自动退款 返库或补做</p>
    {!permitted && <p role="status">当前身份或读取范围尚未核对 私有数量凭据与填写已隐藏</p>}
    {current?.reading && <p role="status">正在核对原生产 实物数量与停做历史</p>}{current?.error && <p className="ps-error" role="alert">{current.error} 下方为上次读取的受权依据</p>}
    {frozen && <div className="ps-note" role="status"><p>本次数量提交仍待核对 已保留原正文和原请求编号 当前不能另建数量提交</p><button type="button" disabled={busy} onClick={() => { setEditor({ scope, value: frozen.editor }); setClosing(false); }}>恢复本次数量原请求</button></div>}
    {view && <><ProductionQuantityBasisSummary basis={view.basis} />{view.basis.blockers.map(reason => <p className="ps-error" key={reason}>{reason}</p>)}
      <div className="ps-actions">{writable && <button className="primary" type="button" disabled={disabled || busy || !!frozen || current?.reading} onClick={() => { setEditor({ scope, value: { kind: "report", basis: structuredClone(view.basis) } }); setFailure(""); setRejected(false); setClosing(false); }}><Plus size={14} aria-hidden="true" />登记实际生产数量</button>}</div>
      <details><summary>原产能台账依据</summary><p>{view.basis.capacityStatus === "reserved" ? "以下为真实原预留及停做台账 产能单位与实物单位分开" : view.basis.capacityStatus === "legacy_released" ? "旧预留已经释放 不按今天的资源池补写原记录" : "历史生产没有固定产能预留 不能推断可释放额度"}</p>
        {view.basis.reservations.map(row => <div className="ps-capacity-row" key={row.reservationId}><p>{row.localDate} · 每份 {row.unitsPerItem} {row.unit === "minute" ? "分钟" : "件产能单位"}</p><p>原总预留 {row.totalUnits} · 原承诺累计 {row.grossCommittedUnits} · 原释放累计 {row.grossReleasedUnits}<br />停做释放 {row.stopReleasedUnits} · 停做冲减承诺 {row.stopCommitReductionUnits}</p>
          <p>原预留 <code>{row.reservationId}</code> · 固定资源池版本 <code>{row.poolVersionId}</code></p></div>)}</details>
      <section aria-label="人工数量报告历史"><h4>人工数量报告历史</h4><p>已读 {view.reports.length} 份 {view.reportsNextCursor ? "仍有更早报告" : "本次读取范围已到末页"} 按记录编号倒序 不是固定快照</p>
        {!view.reports.length && <p>尚无人工数量报告 不用生产状态补写历史数量</p>}<ul className="ps-history">{view.reports.map(row => <li key={row.id}><details><summary>数量报告 {row.id.slice(-8)} · {row.input.observedAt}</summary><ProductionQuantityReportSummary report={row} unit={row.productionVersionId === view.basis.productionVersionId ? view.basis.unit : null} /></details>
          {writable && <button type="button" disabled={disabled || busy || !!frozen || current?.reading} onClick={() => { setEditor({ scope, value: { kind: "review", basis: structuredClone(view.basis), report: structuredClone(row) } }); setFailure(""); setRejected(false); setClosing(false); }}>核对这份报告并核准停做</button>}</li>)}</ul>
        {view.reportsNextCursor && <button type="button" disabled={busy || current?.reading} onClick={() => void more("reports")}>读取更早数量报告</button>}</section>
      <section aria-label="运营核准停做历史"><h4>运营核准停做历史</h4><p>已读 {view.reviews.length} 份 {view.reviewsNextCursor ? "仍有更早核准记录" : "本次读取范围已到末页"}</p>
        {!view.reviews.length && <p>尚无运营核准停做记录 停单申请不代表已停做数量</p>}<ul className="ps-history">{view.reviews.map(row => <li key={row.id}><details><summary>核准第 {row.sequence} 次 · 新增停做 {row.input.stoppedDelta} · {row.createdAt}</summary><ProductionQuantityReviewSummary review={row} unit={row.productionVersionId === view.basis.productionVersionId ? view.basis.unit : null} /></details></li>)}</ul>
        {view.reviewsNextCursor && <button type="button" disabled={busy || current?.reading} onClick={() => void more("reviews")}>读取更早核准记录</button>}</section>
    </>}
    {editing && <RecordDialog title={editing.value.kind === "report" ? "登记实际生产数量" : "核准本次新增停做"} protectEdits onClose={() => close()}><div className={`ps-form${closing ? " ps-exiting" : ""}`} inert={closing}>
      {saved ? <QuantityReceipt receipt={saved.value} basis={saved.basis} onClose={() => close()} /> : <ProductionStopForm key={`${scope}:${editing.value.kind}:${editing.value.kind === "review" ? editing.value.report.id : "new"}`} editor={editing.value} current={view?.basis ?? null}
        busy={busy} disabled={disabled || !writable || !!current?.reading || !!current?.error} frozen={frozen?.intent ?? null} failure={failure} knownRejected={rejected}
        onSubmit={intent => void send({ scope, editor: editing.value, intent: structuredClone(intent) })} onRetry={() => { if (frozen) void send(frozen); }} onClose={() => close()} onDiscard={() => close(true)} />}
    </div></RecordDialog>}
  </section>;
}
