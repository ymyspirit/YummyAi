"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { z } from "zod";
import { Check, ClipboardCheck, Plus, RefreshCw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { QualityScrapWorkspaceSchema, QualityScrapResultSchema, type AllocateQualityScrapInput,
  type QualityScrapBasis, type QualityScrapReviewView, type QualityScrapWorkspace as Workspace } from "@yummyai/contracts/order/quality-scrap";
import { useErpAccess } from "../identity/erp-access";
import { RecordDialog } from "../manual-operations/record-form";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { QualityScrapForm, qualityScrapLotScopeLabel } from "./quality-scrap-form";
import "./quality-scrap.css";

type Pending = { scope: string; basis: QualityScrapBasis; input: AllocateQualityScrapInput; form: HTMLFormElement; fingerprint: string };
type Receipt = { scope: string; result: z.infer<typeof QualityScrapResultSchema>; original: Pending };
class ScrapRequestError extends Error { constructor(readonly status: number, message: string, readonly code: string | null = null) { super(message); } }
const deniedRequest = (error: unknown) => error instanceof ScrapRequestError && ([401, 403, 404].includes(error.status) || error.code === "authority_changed");
const knownRejection = (error: unknown) => error instanceof ScrapRequestError && !deniedRequest(error) && [400, 409, 413, 415, 422].includes(error.status);
const message = (error: unknown) => error instanceof ScrapRequestError ? error.message : "报废归属依据暂时无法核对 请保留原填写后重新读取";
async function scrapRequest<S extends z.ZodType>(productionOrderId: string, schema: S, authority: string | null, localDevelopment: boolean,
  query = "", input?: AllocateQualityScrapInput, signal?: AbortSignal): Promise<z.output<S>> {
  let response: Response;
  try {
    response = await fetch("/api/quality-scrap/orders/" + productionOrderId + "/quality-scrap" + (input ? "/reviews" : "") + (query ? "?" + query : ""), {
      method: input ? "POST" : "GET", credentials: "same-origin", cache: "no-store", redirect: "error",
      headers: { accept: "application/json", ...(input ? { "content-type": "application/json" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}),
      signal: input ? AbortSignal.timeout(60_000) : AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(25_000)]),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new ScrapRequestError(0, input ? "本次报废归属响应尚未确认 已保留原正文与原编号 请按原请求重试核对" : "报废归属读取中断 请重新读取");
  }
  const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0, raw: unknown = null;
  try {
    if (reader) {
      while (true) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength;
        if (size > (response.ok ? 8_388_608 : 8_192)) { await reader.cancel(); throw new Error("size"); } chunks.push(chunk.value); }
      const bytes = new Uint8Array(size); let offset = 0; chunks.forEach(chunk => { bytes.set(chunk, offset); offset += chunk.byteLength; });
      raw = JSON.parse(new TextDecoder().decode(bytes));
    }
  } catch { if (response.ok) throw new ScrapRequestError(502, "完整报废归属回执无法核对 未截断或补写原记录"); }
  finally { reader?.releaseLock(); }
  if (!response.ok) {
    const code = raw && typeof raw === "object" && "code" in raw && raw.code === "authority_changed" ? "authority_changed" : null;
    const messages: Record<number, string> = { 400: "请核对完整归属明细与原凭证", 401: "当前身份已失效 私有报废归属资料已清除",
      403: "当前权限不足 私有报废归属资料已清除", 404: "原生产或报废归属凭证当前不可访问",
      409: "原生产 数量核准或归属依据已变化 请核对原提交 不自动换用新依据", 413: "完整归属凭证超过支持大小 未截断提交",
      422: "原失败组 新增报废批次或实际归属数量未通过核对" };
    throw new ScrapRequestError(response.status, code ? "当前身份或权限范围已变化 私有报废归属资料已清除"
      : messages[response.status] ?? "报废归属结果尚未确认 请保留原请求后重试", code);
  }
  const parsed = schema.safeParse(raw); if (!parsed.success) throw new ScrapRequestError(502, "报废归属回执格式无法核对 未用旧资料补填");
  const value = parsed.data;
  if (value && typeof value === "object" && "contextAuthority" in value && !localDevelopment && (!authority || value.contextAuthority !== authority))
    throw new ScrapRequestError(409, "当前身份或权限范围已变化 私有报废归属资料已清除", "authority_changed");
  return value;
}
export function QualityScrapBasisSummary({ basis }: { basis: QualityScrapBasis }) {
  return <section aria-label="本次读取的报废归属依据"><dl className="qs-pairs">
    <div><dt>已核准实际报废数量</dt><dd>{basis.actualScrappedQuantity === null ? "未知 尚未核准实际报废数量" : basis.actualScrappedQuantity}</dd></div>
    <div><dt>已明确归属原组</dt><dd>{basis.mappedScrappedQuantity}</dd></div>
    <div><dt>尚未归属总数量</dt><dd>{basis.actualScrappedQuantity === null ? "待核对" : basis.unassignedQuantity}</dd></div>
    <div><dt>本次待归属实物组</dt><dd>{basis.actualScrappedQuantity === null ? "待核对" : basis.unassignedGroupQuantity}</dd></div>
    <div><dt>原根检验前已排除</dt><dd>{basis.actualScrappedQuantity === null ? "待核对" : basis.outsideRootQuantity}</dd></div>
    <div><dt>来源有歧义 待核对</dt><dd>{basis.actualScrappedQuantity === null ? "待核对" : basis.ambiguousQuantity}</dd></div>
  </dl><p>以上按原生产计数单位读取 原核准报废数量不是本次新增报废 不从未通过质检数量推算</p>
    <p>原生产版本 <code>{basis.productionVersionId}</code> · 固定生产依据 V{basis.projectionVersion}<br />
      原根检验 <code>{basis.rootInspectionId ?? "尚未固定"}</code><br />原数量核准 <code>{basis.quantityReviewId ?? "尚未核准"}</code><br />
      最近归属凭证 <code>{basis.scrapReviewId ?? "尚无"}</code></p>
    {!!basis.unassignedGroupQuantity && <p className="qs-note">仍有应归属原失败组的实际报废数量 相应实物组继续受阻 不能把未归属数量当作已处理</p>}
    {!!basis.outsideRootQuantity && <p className="qs-note">检验前已排除的报废实物保留原凭证 不再扣减原质检组</p>}
    {!!basis.ambiguousQuantity && <p className="qs-error">来源时序有歧义的实物仍受阻 请核对原报告与原检验凭证 不自动选择来源</p>}
    {basis.blockers.map(value => <p key={value} className="qs-error" role="status">{value}</p>)}
    <details><summary>原新增报废批次与实物组</summary>
      {!basis.lots.length && <p>没有实际新增报废批次 数量核准中的零增量不会生成报废额度</p>}
      <ul className="qs-history">{basis.lots.map(lot => <li key={lot.sourceQuantityReviewId}>
        <strong>新增报废 {lot.quantity} · 已归属 {lot.allocatedQuantity} · 未归属 {lot.remainingQuantity}</strong><p>{qualityScrapLotScopeLabel(lot.scope)}<br />
          原数量核准 <code>{lot.sourceQuantityReviewId}</code> · 原报告 <code>{lot.reportId}</code><br />实际清点 {lot.observedAt} · 核准发生 {lot.reviewedAt}</p>
      </li>)}</ul>
      <ul className="qs-history">{basis.groups.map(group => <li key={group.qualityGroupId}><strong>{group.label} · {group.active ? "活动实物组" : "已退休原组"} · {group.result === "failed" ? "未通过检验" : "检验通过"}</strong>
        <p>原组 {group.quantity} · 已归属报废 {group.scrappedQuantity} · 可复检实物 {group.reinspectableQuantity}<br />
          本次读取可新增归属 {group.maxAllocatableQuantity} · 已安排补做 {group.remakeQuantity} · 报废份额剩余可补做 {group.remainingScrapRemakeQuantity}</p>
        <p>原组 <code>{group.qualityGroupId}</code> · 原检验 <code>{group.inspectionId}</code> · 原检验登记 {group.inspectionRecordedAt}</p>
        {group.allocationBlockers.map(value => <p key={value} className="qs-error">{value}</p>)}
      </li>)}</ul>
    </details>
  </section>;
}
export function QualityScrapReviewSummary({ review }: { review: QualityScrapReviewView }) {
  return <section aria-label="原报废归属凭证"><p>归属凭证 <code>{review.id}</code> · 发生 {review.input.occurredAt} · 登记 {review.createdAt}<br />
    原生产版本 <code>{review.productionVersionId}</code> · 原根检验 <code>{review.rootInspectionId}</code><br />
    原数量核准 <code>{review.quantityReviewId}</code> · 前次归属凭证 <code>{review.previousReviewId ?? "尚无"}</code></p>
    <ul className="qs-history">{review.input.allocations.map(row => <li key={row.qualityGroupId + ":" + row.sourceQuantityReviewId}>
      <strong>本次归属数量 {row.quantity} 原生产单位</strong><p>原失败组 <code>{row.qualityGroupId}</code><br />新增报废批次原核准 <code>{row.sourceQuantityReviewId}</code></p>
    </li>)}</ul><p>凭证编号 {review.input.evidenceCode} · 人工登记者 <code>{review.createdBy}</code><br />
      原请求编号 <code>{review.input.idempotencyKey}</code> · 原依据指纹 <code>{review.input.expectedBasisFingerprint}</code></p>
    {review.input.evidenceAssetIds.map(id => <p key={id}>原凭证附件 <code>{id}</code></p>)}
    <p>以上是该次保存的不可变归属 不是今天的剩余余额 报废归属 不等于库存处置</p>
  </section>;
}
function ScrapReceipt({ receipt, onClose }: { receipt: Receipt; onClose(): void }) {
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { const node = title.current, dialog = node?.closest("dialog"); if (dialog) dialog.scrollTop = 0; node?.focus({ preventScroll: true }); }, []);
  return <section aria-label="本次报废归属回执"><h3 ref={title} tabIndex={-1}>报废实物归属已登记</h3>
    <p>{receipt.result.replayed ? "已读取同一原请求的既有归属 没有另建记录" : "本次归属已保存"} · 以下为原执行凭证</p>
    <QualityScrapReviewSummary review={receipt.result.review} /><p>原核准报废总量 产能与物料事实保持原记录 复检与补做仍须分别登记</p>
    <button className="primary" type="button" onClick={onClose}><Check size={14} aria-hidden="true" />确认报废归属凭证并返回</button>
  </section>;
}
export function QualityScrapWorkspace({ productionOrderId, refresh, disabled = false, active = true, onSaved, onDenied }: {
  productionOrderId: string; refresh: string; disabled?: boolean; active?: boolean;
  onSaved(form: HTMLFormElement, fingerprint: string, message: string): void; onDenied?(): void;
}) {
  const access = useErpAccess(), canRead = access.canTenant(Permission.OrderRead), canWrite = access.canTenant(Permission.OrderWrite);
  const scope = JSON.stringify([access.preferenceScope, access.authority, productionOrderId, canRead, canWrite]);
  const [open, setOpen] = useState(false), [reload, setReload] = useState(0), [deniedScope, setDeniedScope] = useState("");
  const [read, setRead] = useState<{ scope: string; value: Workspace | null; reading: boolean; error: string } | null>(null);
  const [editor, setEditor] = useState<{ scope: string; basis: QualityScrapBasis } | null>(null), [pending, setPending] = useState<Pending | null>(null), [receipt, setReceipt] = useState<Receipt | null>(null);
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState(""), [rejected, setRejected] = useState(false), [closing, setClosing] = useState(false);
  const live = useRef({ scope, canRead, canWrite, active }), sequence = useRef(0), writeEpoch = useRef(0), alive = useRef(true);
  const controller = useRef<AbortController | null>(null), sending = useRef<{ scope: string; epoch: number } | null>(null), closeTimer = useRef<number | null>(null);
  const deniedCallback = useRef(onDenied); deniedCallback.current = onDenied; live.current = { scope, canRead, canWrite, active };
  useEffect(() => { alive.current = true; return () => { alive.current = false; sequence.current++; writeEpoch.current++; controller.current?.abort(); if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }; }, []);
  useLayoutEffect(() => {
    sequence.current++; writeEpoch.current++; controller.current?.abort(); if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    sending.current = null; setRead(null); setEditor(null); setPending(null); setReceipt(null); setBusy(false); setFailure(""); setRejected(false); setClosing(false); setDeniedScope("");
  }, [scope]);
  const deny = useCallback(() => {
    sequence.current++; writeEpoch.current++; controller.current?.abort(); if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    sending.current = null; setDeniedScope(scope); setRead(null); setEditor(null); setPending(null); setReceipt(null); setBusy(false); setFailure(""); setClosing(false);
    deniedCallback.current?.(); window.dispatchEvent(new Event("focus"));
  }, [scope]);
  useEffect(() => {
    if (!open || !active || !canRead || deniedScope === scope) return;
    const abort = new AbortController(); controller.current?.abort(); controller.current = abort; const token = ++sequence.current;
    const valid = () => !abort.signal.aborted && live.current.scope === scope && live.current.canRead && live.current.active && sequence.current === token;
    setRead(previous => ({ scope, value: previous?.scope === scope ? previous.value : null, reading: true, error: "" }));
    void scrapRequest(productionOrderId, QualityScrapWorkspaceSchema, access.authority, access.localDevelopment, "limit=20", undefined, abort.signal).then(value => {
      if (!valid()) return; if (value.basis.productionOrderId !== productionOrderId) throw new Error("parent"); setRead({ scope, value, reading: false, error: "" });
    }).catch(error => { if (valid()) { if (deniedRequest(error)) deny(); else setRead(previous => ({ scope, value: previous?.scope === scope ? previous.value : null, reading: false, error: message(error) })); } });
    return () => abort.abort();
  }, [scope, open, active, canRead, deniedScope, productionOrderId, refresh, reload, access.authority, access.localDevelopment, deny]);
  useEffect(() => { const check = () => { if (document.visibilityState !== "hidden" && !sending.current) setReload(value => value + 1); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  const permitted = canRead && deniedScope !== scope, current = permitted && read?.scope === scope ? read : null, view = current?.value;
  const writable = permitted && canWrite && view?.access.canWrite === true;
  const editing = permitted && canWrite && editor?.scope === scope ? editor : null, frozen = permitted && canWrite && pending?.scope === scope ? pending : null;
  const saved = permitted && receipt?.scope === scope ? receipt : null;
  useLeaveGuard(!!frozen, busy);
  async function send(value: Pending) {
    if (sending.current?.scope === value.scope || live.current.scope !== value.scope || !live.current.canRead || !live.current.canWrite || deniedScope === scope) return;
    const epoch = writeEpoch.current, ticket = { scope: value.scope, epoch }; sending.current = ticket; setPending(value); setBusy(true); setFailure(""); setRejected(false);
    sequence.current++; controller.current?.abort(); setRead(previous => previous ? { ...previous, reading: false } : previous);
    const valid = () => alive.current && live.current.scope === value.scope && live.current.canRead && live.current.canWrite && writeEpoch.current === epoch;
    try {
      const result = await scrapRequest(productionOrderId, QualityScrapResultSchema, access.authority, access.localDevelopment, "", value.input);
      if (!valid()) return;
      if (result.review.productionOrderId !== productionOrderId || result.review.input.idempotencyKey !== value.input.idempotencyKey) throw new Error("parent");
      setReceipt({ scope: value.scope, result, original: value }); setPending(null);
    } catch (error) { if (valid()) { if (deniedRequest(error)) deny(); else { setFailure(message(error)); setRejected(knownRejection(error)); } } }
    finally { if (sending.current === ticket) sending.current = null; if (valid()) setBusy(false); }
  }
  function close(discard = false) {
    if (busy) return;
    const finish = () => {
      if (live.current.scope !== scope || !alive.current) return;
      setClosing(false); setEditor(null); setReceipt(null);
      if (discard) { setPending(null); setFailure(""); setRejected(false); setReload(value => value + 1); }
      if (saved) { setReload(value => value + 1); onSaved(saved.original.form, saved.original.fingerprint, "报废实物归属已登记 原报废总量 产能与物料未由本次归属改写"); }
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else { if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); setClosing(true); closeTimer.current = window.setTimeout(finish, 150); }
  }
  async function more() {
    if (!view?.nextCursor || current?.reading || busy || !permitted) return;
    const before = view.nextCursor, abort = new AbortController(); controller.current?.abort(); controller.current = abort; const token = ++sequence.current;
    const valid = () => !abort.signal.aborted && live.current.scope === scope && live.current.canRead && live.current.active && token === sequence.current;
    setRead({ scope, value: view, reading: true, error: "" });
    try {
      const next = await scrapRequest(productionOrderId, QualityScrapWorkspaceSchema, access.authority, access.localDevelopment,
        new URLSearchParams({ before, limit: "20" }).toString(), undefined, abort.signal);
      if (!valid()) return; if (next.basis.productionOrderId !== productionOrderId) throw new Error("parent");
      const reviews = [...new Map([...view.reviews, ...next.reviews].map(row => [row.id, row])).values()];
      setRead({ scope, value: { ...next, reviews }, reading: false, error: "" });
    } catch (error) { if (valid()) { if (deniedRequest(error)) deny(); else setRead({ scope, value: view, reading: false, error: message(error) }); } }
  }
  return <section className="qs-workspace" aria-label="失败组报废归属" aria-busy={busy || current?.reading}>
    <header><h4><ClipboardCheck size={15} aria-hidden="true" /> 失败组报废归属</h4>
      <button type="button" disabled={!canRead || busy || current?.reading} onClick={() => { setDeniedScope(""); setOpen(true); setReload(value => value + 1); }}><RefreshCw size={14} aria-hidden="true" />{open ? "重新读取报废归属依据" : "读取报废归属依据"}</button></header>
    <p>将已核准的实际新增报废批次明确归属原失败实物组 可以部分登记 报废归属 不等于库存处置</p>
    {!permitted && <p className="qs-error" role="status">当前租户生产读取权限尚未核对 旧报废归属与填写已隐藏</p>}
    {current?.reading && <p role="status">正在核对原数量核准 新增报废批次与实物组</p>}
    {current?.error && <p className="qs-error" role="alert">{current.error}</p>}
    {frozen && <div className="qs-note" role="status"><p>本次归属提交仍待核对 已保留原正文与原请求编号 当前不能另建归属提交</p>
      <button type="button" disabled={busy} onClick={() => { setEditor({ scope, basis: frozen.basis }); setClosing(false); }}>恢复本次报废归属原请求</button></div>}
    {view && <>
      <QualityScrapBasisSummary basis={view.basis} />
      {writable && <button type="button" className="primary" disabled={disabled || busy || !!frozen || current?.reading || !!current?.error}
        onClick={() => { setEditor({ scope, basis: structuredClone(view.basis) }); setFailure(""); setRejected(false); setClosing(false); }}><Plus size={14} aria-hidden="true" />登记失败组报废归属</button>}
      <section aria-label="报废归属历史"><h4>报废归属历史</h4><p>已读 {view.reviews.length} 份 {view.nextCursor ? "仍有更早记录" : "本次读取范围已到末页"} 按记录编号倒序 不是固定快照</p>
        {!view.reviews.length && <p>尚无明确报废归属凭证 不将未通过质检自动改成报废</p>}
        <ul className="qs-history">{view.reviews.map(row => <li key={row.id}><details><summary>报废归属 {row.id.slice(-8)} · {row.input.occurredAt}</summary><QualityScrapReviewSummary review={row} /></details></li>)}</ul>
        {view.nextCursor && <button type="button" disabled={busy || current?.reading} onClick={() => void more()}>读取更早报废归属记录</button>}
      </section>
    </>}
    {editing && <RecordDialog title="登记失败组报废归属" protectEdits onClose={() => close()}>
      <div className={"qs-form" + (closing ? " qs-exiting" : "")} inert={closing}>
        {saved ? <ScrapReceipt receipt={saved} onClose={() => close()} /> : <QualityScrapForm key={scope + ":" + (frozen?.input.idempotencyKey ?? "new")} basis={editing.basis} current={view?.basis ?? null}
          busy={busy} disabled={disabled || !writable || !frozen && !!(current?.reading || current?.error)} frozen={frozen?.input ?? null}
          failure={failure} knownRejected={rejected} onSubmit={(input, form, fingerprint) => void send({ scope, basis: editing.basis, input: structuredClone(input), form, fingerprint })}
          onRetry={() => { if (frozen) void send(frozen); }} onClose={() => close()} onDiscard={() => close(true)} />}
      </div>
    </RecordDialog>}
  </section>;
}
