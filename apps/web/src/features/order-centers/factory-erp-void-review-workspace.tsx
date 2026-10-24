"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import { Check, ClipboardCheck, RefreshCw, Search, X } from "lucide-react";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { FactoryErpBindingViewSchema, type FactoryErpBindingView } from "@yummyai/contracts/order/factory-erp-binding";
import { ReviewFactoryErpVoidSchema, FactoryErpVoidReviewResultSchema, FactoryErpVoidObservationPageSchema,
  FactoryErpVoidObservationDetailSchema, FactoryErpVoidReviewPageSchema, type FactoryErpVoidReviewResult,
} from "@yummyai/contracts/order/factory-erp-void-review";
import type { OrderReviewState } from "./order-work-detail";
import { FactoryErpBindingSummary, type FactoryErpBindingRead } from "./factory-erp-binding-correction";
import { factoryErpSha256 } from "./factory-erp-import-form";
import { FactoryErpVoidCounts, FactoryErpVoidObservationPins, FactoryErpVoidRequestSummary, FactoryErpVoidReviewReceipt,
  FactoryErpVoidReviewForm, factoryErpVoidOutcomeLabel, type FactoryErpVoidIntent, type FactoryErpVoidSource,
} from "./factory-erp-void-review-form";

export const factoryErpVoidRecoveryPrefix = "yummyai.factory-erp.void-review.v1:";
const Recovery = z.object({ version: z.literal(1), authority: z.string().min(1).max(65_536), bindingId: EntityIdSchema, input: ReviewFactoryErpVoidSchema }).strict();
const recoveryKey = (authority: string, factoryId: string) => factoryErpVoidRecoveryPrefix + authority + ":" + factoryId;
export function readFactoryErpVoidRecovery(authority: string, factoryId: string) {
  try {
    const key = recoveryKey(authority, factoryId), text = sessionStorage.getItem(key);
    if (!text) return null;
    const result = text.length <= 128 * 1024 ? Recovery.safeParse(JSON.parse(text)) : null;
    if (!result?.success || result.data.authority !== authority) { sessionStorage.removeItem(key); return null; }
    return result.data;
  } catch { return null; }
}
export function removeFactoryErpVoidRecovery(authority: string | null, factoryId: string, expected?: FactoryErpVoidIntent) {
  if (!authority) return;
  try {
    const saved = expected ? readFactoryErpVoidRecovery(authority, factoryId) : null;
    if (saved && (saved.bindingId !== expected!.bindingId || canonicalJson(saved.input) !== canonicalJson(expected!.input))) return;
    sessionStorage.removeItem(recoveryKey(authority, factoryId));
  } catch { /* Never persist original source cells as a fallback. */ }
}
type ObservationPage = z.infer<typeof FactoryErpVoidObservationPageSchema>;
type ObservationDetail = z.infer<typeof FactoryErpVoidObservationDetailSchema>;
type ReviewPage = z.infer<typeof FactoryErpVoidReviewPageSchema>;
type Lane = "list" | "detail" | "history" | "receipt";
const errorStatus = (error: unknown) => error && typeof error === "object" && "status" in error ? error.status : null;

export function FactoryErpVoidReviewWorkspace({ scope, factoryId, authority, canWrite, disabled, source, focus, request, submit,
  sourceReadable, sourceExpired, onReadSource, onStateChange, onChanged, onDenied, onBindingCorrection }: {
  scope: string; factoryId: string; authority: string; canWrite: boolean; disabled: boolean; source: FactoryErpVoidSource | null;
  focus: { bindingId: string; nonce: number } | null; request: FactoryErpBindingRead;
  submit(value: FactoryErpVoidIntent): Promise<FactoryErpVoidReviewResult>;
  sourceReadable(id: string): boolean; sourceExpired(id: string): boolean; onReadSource(id: string, privateContent: boolean): void;
  onStateChange(value: OrderReviewState): void; onChanged(bindingId: string): void; onDenied(error: unknown): void; onBindingCorrection(bindingId: string): void;
}) {
  const [bindingDraft, setBindingDraft] = useState(""), [bindingId, setBindingId] = useState("");
  const [binding, setBinding] = useState<FactoryErpBindingView | null>(null), [page, setPage] = useState<ObservationPage | null>(null), [trail, setTrail] = useState<Array<number | undefined>>([undefined]);
  const [detail, setDetail] = useState<ObservationDetail | null>(null), [observationDraft, setObservationDraft] = useState("");
  const [history, setHistory] = useState<ReviewPage | null>(null), [historyTrail, setHistoryTrail] = useState<Array<string | undefined>>([undefined]), [historyFilter, setHistoryFilter] = useState("");
  const [reviewDraft, setReviewDraft] = useState(""), [historicalReceipt, setHistoricalReceipt] = useState<FactoryErpVoidReviewResult | null>(null);
  const [intent, setIntent] = useState<FactoryErpVoidIntent | null>(null), [receipt, setReceipt] = useState<FactoryErpVoidReviewResult | null>(null), [receiptInput, setReceiptInput] = useState<FactoryErpVoidIntent | null>(null);
  const [saving, setSaving] = useState(false), [rejected, setRejected] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false), [closing, setClosing] = useState(false), [reading, setReading] = useState<Record<Lane, boolean>>({ list: false, detail: false, history: false, receipt: false });
  const root = useRef<HTMLElement>(null), alive = useRef(true), posting = useRef(false), closeTimer = useRef<number | null>(null);
  const target = useRef(""); target.current = bindingId;
  const live = useRef({ scope, canWrite, disabled, source }); live.current = { scope, canWrite, disabled, source };
  const reads = useRef({ list: 0, detail: 0, history: 0, receipt: 0, aborts: new Map<Lane, AbortController>(), known: new Set<string>() });
  const cancel = useCallback((lanes: Lane[] = ["list", "detail", "history", "receipt"]) => {
    lanes.forEach(lane => { reads.current[lane]++; reads.current.aborts.get(lane)?.abort(); reads.current.aborts.delete(lane); });
  }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; cancel(); if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }; }, [cancel]);
  useLayoutEffect(() => {
    const saved = canWrite ? readFactoryErpVoidRecovery(authority, factoryId) : null;
    if (saved) { setIntent({ bindingId: saved.bindingId, input: saved.input, sent: true }); setBindingDraft(saved.bindingId); setNotice("已恢复本人固定原作废核对请求 请明确恢复结果 不自动再次登记"); }
  }, [scope, authority, factoryId, canWrite]);
  useEffect(() => { onStateChange({ dirty: editing || !!intent || !!receipt, busy: saving || intent?.sent === true,
    loading: Object.values(reading).some(Boolean) }); }, [editing, intent, receipt, saving, reading, onStateChange]);
  useEffect(() => () => onStateChange({ dirty: false, busy: false, loading: false }), [onStateChange]);
  const sourceValid = source !== null && sourceReadable(source.source.importId);
  useEffect(() => { if (!sourceValid) { setEditing(false); setClosing(false); if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); } }, [sourceValid]);
  function begin(lane: Lane, id: string) {
    cancel([lane]); const abort = new AbortController(), token = reads.current[lane]; reads.current.aborts.set(lane, abort);
    setReading(value => ({ ...value, [lane]: true }));
    return { abort, valid: () => alive.current && !abort.signal.aborted && live.current.scope === scope && reads.current[lane] === token && target.current === id,
      done: () => { if (reads.current[lane] === token && alive.current) setReading(value => ({ ...value, [lane]: false })); } };
  }
  function failed(failure: unknown, known: boolean) {
    if (errorStatus(failure) !== 404 || known) onDenied(failure);
    setError("原作废观察或核对依据读取未完成 请按原 ID 重新读取 未以成功发货来源替代");
  }
  async function readBinding(rawId: string, cursor?: number, nextTrail: Array<number | undefined> = [undefined]) {
    const parsed = EntityIdSchema.safeParse(rawId.trim()); if (!parsed.success) { setError("请填写完整有效的工厂绑定 ID"); return; }
    const id = parsed.data.toLowerCase();
    if ((intent || receipt) && id !== (intent?.bindingId ?? receipt?.bindingId)) { setError("仍有该原绑定的固定请求或未确认回执 请先核对结果"); return; }
    target.current = id; setBindingId(id); setBindingDraft(id); cancel(["detail", "history", "receipt"]);
    setDetail(null); setEditing(false); setHistory(null); setHistoricalReceipt(null); setReading({ list: false, detail: false, history: false, receipt: false });
    const ticket = begin("list", id); setError("");
    try {
      const [original, value] = await Promise.all([
        request("bindings/" + id, FactoryErpBindingViewSchema, ticket.abort.signal),
        request("bindings/" + id + "/void-observations?" + new URLSearchParams({ limit: "20", ...(cursor !== undefined ? { cursor: String(cursor) } : {}) }), FactoryErpVoidObservationPageSchema, ticket.abort.signal),
      ]);
      if (!ticket.valid()) return;
      if (original.id !== id || original.factoryId !== factoryId || value.basis.bindingId !== id || value.basis.factoryId !== factoryId ||
        original.revision !== value.basis.bindingRevision || original.itemsChecksum !== value.basis.itemsChecksum || original.state !== value.basis.state)
        throw new Error("scope");
      reads.current.known.add(id); setBinding(original); setPage(value); setTrail(nextTrail);
    } catch (failure) { if (ticket.valid()) { setBinding(null); setPage(null); failed(failure, reads.current.known.has(id) || focus?.bindingId === id); } }
    finally { ticket.done(); }
  }
  async function readObservation(rawId: string) {
    const parsed = EntityIdSchema.safeParse(rawId.trim()); if (!parsed.success || !bindingId) { setError("请先读取原绑定 再填写有效的作废观察 ID"); return; }
    const id = parsed.data.toLowerCase(), parent = bindingId, ticket = begin("detail", parent);
    cancel(["history", "receipt"]); setHistory(null); setHistoricalReceipt(null); setReading(value => ({ ...value, history: false, receipt: false }));
    setDetail(null); setEditing(false); setError("");
    try {
      const value = await request("bindings/" + parent + "/void-observations/" + id, FactoryErpVoidObservationDetailSchema, ticket.abort.signal);
      if (!ticket.valid()) return;
      if (value.basis.bindingId !== parent || value.basis.factoryId !== factoryId || value.observation.id !== id) throw new Error("scope");
      reads.current.known.add(id); setDetail(value); setObservationDraft(id);
    } catch (failure) { if (ticket.valid()) failed(failure, reads.current.known.has(id) || page?.items.some(value => value.id === id) === true); }
    finally { ticket.done(); }
  }
  async function readHistory(filter = "", cursor?: string, nextTrail: Array<string | undefined> = [undefined]) {
    if (!bindingId) return;
    const parent = bindingId, ticket = begin("history", parent); setError("");
    try {
      const value = await request("bindings/" + parent + "/void-reviews?" + new URLSearchParams({ limit: "20", ...(filter ? { observationId: filter } : {}), ...(cursor ? { cursor } : {}) }),
        FactoryErpVoidReviewPageSchema, ticket.abort.signal);
      if (!ticket.valid()) return;
      if (value.items.some(item => item.bindingId !== parent || item.factoryId !== factoryId || filter && item.observation.id !== filter)) throw new Error("scope");
      value.items.forEach(item => reads.current.known.add(item.id)); setHistory(value); setHistoryFilter(filter); setHistoryTrail(nextTrail);
    } catch (failure) { if (ticket.valid()) failed(failure, true); }
    finally { ticket.done(); }
  }
  async function readReceipt(rawId: string) {
    const parsed = EntityIdSchema.safeParse(rawId.trim()); if (!parsed.success || !bindingId) { setError("请先读取原绑定 再填写有效核对 ID"); return; }
    const id = parsed.data.toLowerCase(), parent = bindingId, ticket = begin("receipt", parent); setHistoricalReceipt(null); setError("");
    try {
      const value = await request("bindings/" + parent + "/void-reviews/" + id, FactoryErpVoidReviewResultSchema, ticket.abort.signal);
      if (!ticket.valid()) return;
      if (value.id !== id || value.bindingId !== parent || value.factoryId !== factoryId) throw new Error("scope");
      reads.current.known.add(id); setHistoricalReceipt(value); setReviewDraft(id);
    } catch (failure) { if (ticket.valid()) failed(failure, reads.current.known.has(id)); }
    finally { ticket.done(); }
  }
  const focusToken = focus ? focus.bindingId + ":" + focus.nonce : "";
  const focusRead = useRef("");
  useEffect(() => {
    if (focusToken && focusRead.current !== focusToken && !intent && !receipt) { focusRead.current = focusToken; void readBinding(focus!.bindingId); }
  });
  const restored = useRef("");
  useEffect(() => {
    if (!intent) return;
    const token = intent.bindingId + ":" + intent.input.idempotencyKey;
    if (restored.current === token) return;
    restored.current = token; onReadSource(intent.input.source.importId, false);
    if (!target.current) void readBinding(intent.bindingId);
  });
  function closeEditor() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    const finish = () => { if (alive.current && live.current.scope === scope) { setEditing(false); setClosing(false); } };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else { setClosing(true); closeTimer.current = window.setTimeout(finish, 150); }
  }
  async function execute(original: FactoryErpVoidIntent) {
    if (posting.current || !canWrite || disabled || !alive.current || live.current.scope !== scope) return;
    if (!sourceReadable(original.input.source.importId) && !(original.sent && sourceExpired(original.input.source.importId))) {
      setError("来源已到期或尚未核对 未创建新核对 先重新读取来源状态 已发出原请求仅恢复既存回执"); return;
    }
    try {
      const existing = readFactoryErpVoidRecovery(authority, factoryId);
      if (existing && (existing.bindingId !== original.bindingId || canonicalJson(existing.input) !== canonicalJson(original.input))) throw new Error("slot");
      const saved = Recovery.parse({ version: 1, authority, bindingId: original.bindingId, input: original.input });
      sessionStorage.setItem(recoveryKey(authority, factoryId), JSON.stringify(saved));
    } catch { setError("无法保留完整原请求或已有另一笔未确认核对 本次未发送 请恢复原请求"); return; }
    posting.current = true; setSaving(true); setRejected(false); setError(""); setIntent({ ...original, sent: true });
    const valid = () => alive.current && live.current.scope === scope && live.current.canWrite;
    try {
      const result = await submit(original);
      if (!valid()) return;
      const checksum = await factoryErpSha256(new TextEncoder().encode(canonicalJson({ version: 1, operation: "factory-erp-void-review", bindingId: original.bindingId, input: original.input })));
      if (!valid()) return;
      if (result.bindingId !== original.bindingId || result.factoryId !== factoryId || result.requestChecksum !== checksum ||
        result.originalBindingRevision !== original.input.expectedBindingRevision || result.originalItemsChecksum !== original.input.expectedItemsChecksum ||
        result.originalObservationSequence !== original.input.expectedObservationSequence || result.previousReviewId !== original.input.expectedPreviousReviewId ||
        result.outcome !== original.input.outcome || result.reasonCode !== original.input.reasonCode || result.provenance !== "operator_attested" ||
        canonicalJson(result.observation) !== canonicalJson(original.input.observation) || canonicalJson(result.source) !== canonicalJson(original.input.source)) throw new Error("receipt");
      setReceipt(result); setReceiptInput(original); setIntent(null); setEditing(false);
      requestAnimationFrame(() => { if (valid()) { const heading = root.current?.querySelector<HTMLElement>('[aria-label="工厂作废核对原回执"] h4'); heading?.scrollIntoView({ block: "nearest", behavior: "instant" }); heading?.focus({ preventScroll: true }); } });
    } catch (failure) {
      if (valid()) { onDenied(failure); setRejected([400, 409, 413, 415, 422].includes(Number(errorStatus(failure)))); setError("本次核对结果尚未确认 请保留原正文和编号核对 原依据不会自动刷新重做"); }
    } finally { posting.current = false; if (valid()) setSaving(false); }
  }
  const locked = disabled || saving || !!intent || !!receipt || editing;
  return <section ref={root} className="fei-void-workspace" aria-label="工厂作废观察核对">
    <h4><ClipboardCheck size={16} aria-hidden="true" />工厂作废观察核对</h4><p>按准确原观察逐条登记人工核对 不用成功发货来源替代作废来源 旧观察与实际生产事实继续保留</p>
    <form className="fei-search" aria-label="按绑定读取完整作废观察" onSubmit={event => { event.preventDefault(); void readBinding(bindingDraft); }}>
      <label>作废核对绑定 ID<input value={bindingDraft} disabled={locked} autoComplete="off" onChange={event => setBindingDraft(event.target.value)} /></label>
      <button className="oc-button" type="submit" disabled={locked || reading.list || !bindingDraft}><Search size={14} aria-hidden="true" />读取绑定全部作废观察</button></form>
    {error && <p role="alert" className="oc-delivery-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    {Object.values(reading).some(Boolean) && <p role="status">正在读取原作废观察或核对历史</p>}
    {binding && <><FactoryErpBindingSummary value={binding} />
      <button className="oc-button" type="button" disabled={locked || editing || binding.state !== "active" || !canWrite} onClick={() => onBindingCorrection(binding.id)}>核对原组解除或更正</button></>}
    {page && <><FactoryErpVoidCounts value={page.basis.summary} />
      <div className="fei-actions"><button className="oc-button" type="button" disabled={locked || reading.list} onClick={() => void readBinding(bindingId)}><RefreshCw size={14} aria-hidden="true" />重新读取完整作废依据</button>
        <button className="oc-button" type="button" disabled={locked || reading.list || trail.length < 2} onClick={() => { const next = trail.slice(0, -1); void readBinding(bindingId, next.at(-1), next); }}>上一页原作废观察</button>
        <button className="oc-button" type="button" disabled={locked || reading.list || !page.nextCursor} onClick={() => void readBinding(bindingId, page.nextCursor!, [...trail, page.nextCursor!])}>下一页原作废观察</button>
        {page.basis.summary.nextPending && <button className="oc-button" type="button" disabled={locked || reading.detail} onClick={() => void readObservation(page.basis.summary.nextPending!.id)}>读取下一条待核对作废</button>}</div>
      <p>本页 {page.items.length} 条原作废观察{page.nextCursor ? " 还有下一页" : " 本次查询已到末页"} 不只核对最新一条</p>
      <ul className="fei-history">{page.items.map(item => <li key={item.id}><p>原观察序号 {item.sequence} · {item.pending ? "待核对" : item.requiresOrderHandling ? "已核对 仍需订单后续" : "已核对"}</p>
        <p>原作废观察 <code>{item.id}</code> · 原来源 <code>{item.importId}</code> · 第 {item.rowNumber} 行</p>
        <button className="oc-button" type="button" disabled={locked || reading.detail} onClick={() => void readObservation(item.id)}>读取这条原作废观察 {item.id.slice(-8)}</button></li>)}</ul>
      {!page.items.length && <p>本查询页无作废观察 请按完整计数与分页核对</p>}
    </>}
    {bindingId && <><form className="fei-search" aria-label="按原观察 ID 读取作废详情" onSubmit={event => { event.preventDefault(); void readObservation(observationDraft); }}>
      <label>原作废观察 ID<input value={observationDraft} disabled={locked} autoComplete="off" onChange={event => setObservationDraft(event.target.value)} /></label>
      <button className="oc-button" type="submit" disabled={locked || reading.detail || !observationDraft}>按观察 ID 读取作废详情</button></form>
      <div className="fei-actions"><button className="oc-button" type="button" disabled={reading.history || saving} onClick={() => void readHistory()}>读取本绑定全部核对历史</button>
        {detail && <button className="oc-button" type="button" disabled={reading.history || saving} onClick={() => void readHistory(detail.observation.id)}>只读本条观察核对历史</button>}</div>
    </>}
    {detail && <section className="fei-void-detail" aria-label="准确原作废观察与核对状态"><h4>准确原作废观察与核对状态</h4>
      <FactoryErpVoidObservationPins value={detail.observation} /><p>{detail.observation.pending ? "待核对" : detail.observation.requiresOrderHandling ? "已核对工厂作废 仍需订单后续" : "本条已核对"} · 原私人来源{detail.observation.sourceReadable ? "读取时仍在保留期" : "读取时已不可读"}</p>
      {detail.observation.latestReview && <p>该观察最新核对 <code>{detail.observation.latestReview.id}</code> · 修订 {detail.observation.latestReview.reviewRevision} · {factoryErpVoidOutcomeLabel[detail.observation.latestReview.outcome]}</p>}
      <button className="oc-button" type="button" disabled={locked} onClick={() => onReadSource(detail.observation.importId, true)}>另行读取作废原导入来源</button>
      <p className="fei-hint">新核对先在保留期内原表行点击“选作本次作废核对来源” 可以明确选择新有效同编号行 工厂 编号与数量由服务器复核</p>
      {sourceValid && source ? <p>已选择有效证据来源 <code>{source.source.importId}</code> · 第 {source.source.rowNumber} 行 · 原状态 {source.rawStatus}</p> : <p>尚无明确有效证据来源 原文到期不恢复旧私文 请先上传或读取新有效原导出行</p>}
      {detail.basis.state === "released" && <p>本绑定已解除 只读历史 不登记新核对 请另读当前活动关联</p>}
      {!canWrite && <p>当前只读 可以读取全部观察和核对历史 不能登记新核对</p>}
      {canWrite && <button className="oc-button" type="button" disabled={locked || !sourceValid || detail.basis.state !== "active"} onClick={() => { setEditing(true); setClosing(false); }}>核对这条原作废观察</button>}
      {editing && sourceValid && source && <div className="fei-editor" data-closing={closing} inert={closing} aria-disabled={closing}>
        <FactoryErpVoidReviewForm key={detail.observation.id + ":" + source.source.importId + ":" + source.source.rowNumber} basis={detail.basis} observation={detail.observation} source={source}
          disabled={disabled || closing} onCancel={closeEditor} onPrepare={value => { if (!sourceReadable(value.input.source.importId) || live.current.scope !== scope) return;
            setIntent({ ...value, input: structuredClone(value.input) }); setEditing(false); setClosing(false); setRejected(false); setError(""); }} />
      </div>}
    </section>}
    {(page || detail || reading.list || reading.detail) && <button className="oc-button" type="button" disabled={editing || saving} onClick={() => { cancel(); target.current = ""; setBindingId(""); setBinding(null); setPage(null); setDetail(null); setEditing(false); setHistory(null); setHistoricalReceipt(null); setReading({ list: false, detail: false, history: false, receipt: false }); }}>关闭作废观察与历史读取</button>}
    {history && <section className="fei-void-history" aria-label="工厂作废核对完整历史"><h4>工厂作废核对完整历史</h4><p>{historyFilter ? "仅本条准确观察" : "本绑定全部原作废观察"} · 本页 {history.items.length} 笔{history.nextCursor ? " 还有下一页" : " 本次查询已到末页"}</p>
      <div className="fei-actions"><button className="oc-button" type="button" disabled={reading.history || historyTrail.length < 2} onClick={() => { const next = historyTrail.slice(0, -1); void readHistory(historyFilter, next.at(-1), next); }}>上一页作废核对历史</button>
        <button className="oc-button" type="button" disabled={reading.history || !history.nextCursor} onClick={() => void readHistory(historyFilter, history.nextCursor!, [...historyTrail, history.nextCursor!])}>下一页作废核对历史</button></div>
      <ul className="fei-history">{history.items.map(item => <li key={item.id}><p>{factoryErpVoidOutcomeLabel[item.outcome]} · 该观察核对修订 {item.reviewRevision}</p><p>核对 <code>{item.id}</code> · 作废观察 <code>{item.observation.id}</code></p>
        <button className="oc-button" type="button" disabled={reading.receipt} onClick={() => void readReceipt(item.id)}>读取原作废核对回执 {item.id.slice(-8)}</button></li>)}</ul></section>}
    {bindingId && <form className="fei-search" aria-label="按原核对 ID 读取回执" onSubmit={event => { event.preventDefault(); void readReceipt(reviewDraft); }}>
      <label>原作废核对 ID<input value={reviewDraft} disabled={reading.receipt || saving} autoComplete="off" onChange={event => setReviewDraft(event.target.value)} /></label>
      <button className="oc-button" type="submit" disabled={reading.receipt || saving || !reviewDraft}>读取原作废核对回执</button></form>}
    {historicalReceipt && <><FactoryErpVoidReviewReceipt value={historicalReceipt} historical /><button className="oc-button" type="button" onClick={() => { cancel(["receipt"]); setHistoricalReceipt(null); setReading(value => ({ ...value, receipt: false })); }}>关闭原作废核对回执读取</button></>}
    {intent && <><FactoryErpVoidRequestSummary value={intent} />
      {!sourceReadable(intent.input.source.importId) && <p>新编辑已隐藏 仅已发出原请求可在服务器确认到期后恢复既存结果 不创建新核对</p>}
      <div className="fei-actions"><button className="oc-button primary" type="button" disabled={disabled || saving || !canWrite ||
        !sourceReadable(intent.input.source.importId) && !(intent.sent && sourceExpired(intent.input.source.importId))} onClick={() => void execute(intent)}>
        <Check size={14} aria-hidden="true" />{saving ? "正在核对原作废登记结果" : intent.sent ? "按原请求恢复作废核对结果" : "确认登记这条原作废核对"}</button>
        {(!intent.sent || rejected) && <button className="oc-button" type="button" disabled={saving} onClick={() => { if (intent.sent) removeFactoryErpVoidRecovery(authority, factoryId, intent); setIntent(null); setRejected(false); setError(""); }}><X size={14} aria-hidden="true" />{rejected ? "原核对被明确拒绝 返回重新核对" : "放弃未提交的原核对"}</button>}</div>
    </>}
    {receipt && <><FactoryErpVoidReviewReceipt value={receipt} /><button className="oc-button primary" type="button" onClick={() => {
      if (receiptInput) removeFactoryErpVoidRecovery(authority, factoryId, receiptInput);
      const id = receipt.bindingId; setReceipt(null); setReceiptInput(null); setNotice("原核对回执已确认 正在另行读取当前观察与跟进状态"); onChanged(id); void readBinding(id);
    }}>确认原作废核对回执并读取当前状态</button></>}
  </section>;
}
