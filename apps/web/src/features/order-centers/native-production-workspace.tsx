"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ChevronRight, FileCheck2, RefreshCw } from "lucide-react";
import { NativeProductionDetailSchema, NativeProductionWorkspaceSchema,
  type NativeProductionDetail, type NativeProductionWorkspace } from "@yummyai/contracts/order/native-production";
import { CreateProductionOrderInputSchema, type CreateProductionOrderInput } from "@yummyai/contracts/order/production";
import type { ProductionFactoryChoice } from "@yummyai/contracts/suppliers/factory-directory";
import { centerRequest, dateTime, labels, OrderCenterRequestError } from "./order-center-model";
import { ProductionCommandRecovery, submitProductionCommand } from "./production-command-recovery";
import { ProductionFactorySelect } from "./order-production-factory-select";
import { ProductionManufacturingFields, readProductionManufacturingSelection } from "./production-manufacturing-fields";
import { formFingerprint, useFormEdits } from "../navigation/use-form-edits";
import { useLeaveGuard } from "../navigation/use-leave-guard";
import { ProductionMaterialPanel } from "./production-material-panel";
import { ProductionCapacityPicker, ProductionCapacityReceipt, readProductionCapacitySelection } from "./production-capacity-picker";
import "./order-centers.css";
import "./native-production-workspace.css";

const empty: NativeProductionWorkspace = { items: [], nextCursor: null, canCreate: false, contextAuthority: "unread" };
type Intent = { path: string; orderId: string; input: CreateProductionOrderInput };
export function NativeProductionWorkspace() {
  const params = useSearchParams(), router = useRouter(), lineId = params.get("line"), query = params.get("q") ?? "", after = params.get("after");
  const [view, setView] = useState(empty), [reading, setReading] = useState(true), [error, setError] = useState(""), [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState(query);
  const navigation = useRef<() => boolean>(() => true);
  useEffect(() => { setSearch(query); }, [query]);
  useEffect(() => {
    const abort = new AbortController(), search = new URLSearchParams({ q: query }); if (after) search.set("after", after);
    setReading(true); setError("");
    void centerRequest(`native?${search}`, undefined, abort.signal).then(value => { if (!abort.signal.aborted) setView(NativeProductionWorkspaceSchema.parse(value)); })
      .catch(cause => { if (!abort.signal.aborted) { if (privateDenied(cause)) setView(empty); setError(message(cause)); } })
      .finally(() => { if (!abort.signal.aborted) setReading(false); });
    return () => abort.abort();
  }, [query, after, refresh]);
  function go(next: URLSearchParams) {
    if (!navigation.current()) return;
    router.push(`/production?${next}`);
  }
  return <main className="oc-page np-page" aria-busy={reading}>
    <header className="oc-header"><div><h1>已审核设计直接生产</h1><p>为已关联产品 SKU 的订单确认规格 设计 采购与工厂 建立内部生产安排</p></div>
      <Link className="oc-button" href="/production"><ArrowLeft size={15} aria-hidden="true" />审核稿生产</Link></header>
    <form className="np-search" aria-label="查询直接生产订单" onSubmit={event => { event.preventDefault(); go(new URLSearchParams({ view: "native", q: search.trim() })); }}>
      <label>订单 商品或 SKU<input aria-label="查询直接生产订单" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} /></label>
      <button className="oc-button">查询订单</button><button className="oc-button" type="button" disabled={reading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />重新读取</button>
    </form>
    {error && <p role="alert" className="oc-error">{error}</p>}{reading && <p role="status">正在读取原订单</p>}
    {!reading && !view.items.length && !error && <p className="oc-hint">未找到可读取的直接生产订单 已进入审单的商品请在审核稿生产中处理</p>}
    <div className="np-layout"><section className="np-orders" aria-label="直接生产商品列表">
      {view.items.map(item => <button className="np-order" type="button" key={item.id} aria-current={lineId === item.id ? "true" : undefined}
        onClick={() => { const next = new URLSearchParams(params); next.set("line", item.id); go(next); }}>
        <strong>{item.orderNumber}</strong><span>{item.title}</span><small>{item.skuCode ?? "平台 SKU 未提供"} · 原订购 {item.quantity} 份 · 实际占用 {item.allocatedQuantity} 份</small>
        {item.blockers.map(text => <small key={text} className="np-warning">{text}</small>)}<ChevronRight size={15} aria-hidden="true" />
      </button>)}
      {view.nextCursor && <button className="oc-button" disabled={reading} onClick={() => { const next = new URLSearchParams(params); next.set("after", view.nextCursor!); next.delete("line"); go(next); }}>下一页商品</button>}
    </section>{lineId ? <NativeProductionForm key={lineId} lineId={lineId} onChanged={() => setRefresh(value => value + 1)}
      onNavigationState={check => { navigation.current = check; }} /> : <section className="np-detail"><p className="oc-hint">选择商品 再明确核对当前完整规格与已审核设计</p></section>}</div>
  </main>;
}

function NativeProductionForm({ lineId, onChanged, onNavigationState }: { lineId: string; onChanged(): void; onNavigationState(check: () => boolean): void }) {
  const [view, setView] = useState<NativeProductionDetail | null>(null), [specificationId, setSpecificationId] = useState("");
  const [designId, setDesignId] = useState(""), [routeId, setRouteId] = useState("");
  const [requestedQuantity, setRequestedQuantity] = useState("");
  const [reading, setReading] = useState(true), [readFailed, setReadFailed] = useState(false), [working, setWorking] = useState(false);
  const [manufacturingReady, setManufacturingReady] = useState(false), [factoryReady, setFactoryReady] = useState(false);
  const [factoryChoice, setFactoryChoice] = useState<ProductionFactoryChoice | null>(null), [dueLocal, setDueLocal] = useState(""), [capacityReady, setCapacityReady] = useState(false);
  const [confirmed, setConfirmed] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState(""), [reload, setReload] = useState(0);
  const [recoveryBlocked, setRecoveryBlocked] = useState(true), [recoveryRefresh, setRecoveryRefresh] = useState(0);
  const [draftRevision, setDraftRevision] = useState(0);
  const pendingCommit = useRef<HTMLFormElement | null>(null);
  const active = useRef<AbortController | null>(null), epoch = useRef(0), alive = useRef(true), sending = useRef(false), formRef = useRef<HTMLFormElement>(null);
  const [materialReading, setMaterialReading] = useState<Record<string, boolean>>({});
  const materialBusy = Object.values(materialReading).some(Boolean);
  const onMaterialBusy = useCallback((id: string, value: boolean) => setMaterialReading(previous => previous[id] === value ? previous : { ...previous, [id]: value }), []);
  const forms = useFormEdits(), busy = working || recoveryBlocked || materialBusy;
  const mayLeave = useLeaveGuard(forms.dirty, working || materialBusy);
  useEffect(() => { onNavigationState(mayLeave); return () => onNavigationState(() => true); }, [mayLeave, onNavigationState]);
  useLayoutEffect(() => { if (pendingCommit.current) { const form = pendingCommit.current; pendingCommit.current = null; forms.commit(form, formFingerprint(form)); } });
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; active.current?.abort(); }; }, []);
  const clearPrivate = useCallback(() => { epoch.current++; setReading(false); setView(null); setDesignId(""); setRouteId(""); setRequestedQuantity(""); setConfirmed(false); setNotice(""); setFactoryChoice(null); setDueLocal(""); setCapacityReady(false); }, []);
  const read = useCallback(async () => {
    const abort = new AbortController(); active.current?.abort(); active.current = abort;
    const sourceEpoch = epoch.current; setReading(true); setReadFailed(false); setConfirmed(false);
    const query = specificationId ? `?specificationVersionId=${encodeURIComponent(specificationId)}` : "";
    try {
      const next = NativeProductionDetailSchema.parse(await centerRequest(`native/lines/${lineId}${query}`, undefined, abort.signal));
      if (abort.signal.aborted || sourceEpoch !== epoch.current) return;
      if (next.line.id !== lineId || (next.source?.specificationVersionId ?? "") !== specificationId) throw new Error("生产来源与本次商品或规格不一致 请重新核对");
      setView(next); setDesignId(id => next.designs.some(row => row.versionId === id) ? id : "");
      setRouteId(id => next.routes.some(row => routeIdentity(row) === id) ? id : "");
    } catch (cause) { if (!abort.signal.aborted && sourceEpoch === epoch.current) { setReadFailed(true); if (privateDenied(cause)) clearPrivate(); setError(message(cause)); } }
    finally { if (!abort.signal.aborted && sourceEpoch === epoch.current) setReading(false); }
  }, [lineId, specificationId, clearPrivate]);
  useEffect(() => { setError(""); void read(); return () => active.current?.abort(); }, [read, reload]);
  useEffect(() => {
    const check = () => { if (document.visibilityState !== "hidden" && !sending.current) setReload(value => value + 1); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  const sourceCurrent = !!view && (view.source?.specificationVersionId ?? "") === specificationId;
  const route = view?.routes.find(item => routeIdentity(item) === routeId), design = view?.designs.find(item => item.versionId === designId);
  const remainingQuantity = view ? view.line.quantity - view.line.allocatedQuantity : null;
  const parsedQuantity = /^[1-9]\d*$/.test(requestedQuantity) ? Number(requestedQuantity) : null;
  const quantity = parsedQuantity !== null && Number.isSafeInteger(parsedQuantity) && parsedQuantity <= 100_000
    && remainingQuantity !== null && parsedQuantity <= remainingQuantity ? parsedQuantity : null;
  const blocked = busy || reading || readFailed || !view?.canCreate || !sourceCurrent;
  const sourceReady = !!view?.source && view.source.productType === "rectangular_print" && !view.diagnostics.length;
  async function perform(intent: Intent) {
    if (sending.current) return;
    sending.current = true; const currentEpoch = epoch.current; let committed = false;
    setWorking(true); setError(""); setNotice("");
    try {
      const receipt = await submitProductionCommand({ kind: "approved_design", targetId: intent.orderId, input: intent.input });
      if (!alive.current || currentEpoch !== epoch.current) return;
      if (receipt.orderId !== intent.orderId || !receipt.lineIds.includes(intent.input.orderLineId)) throw new Error("生产回执来源不一致 请恢复原提交结果");
      committed = true; setNotice(`生产安排 ${receipt.receipt!.productionOrderIds[0]!.slice(-8)} 已建立 工厂提交 接单 实际生产与质检仍须分别登记`);
      const form = formRef.current; if (form) { form.reset(); pendingCommit.current = form; }
      setConfirmed(false); setDesignId(""); setRouteId(""); setRequestedQuantity(""); setManufacturingReady(false); setFactoryReady(false); setFactoryChoice(null); setCapacityReady(false); setDraftRevision(value => value + 1); onChanged(); await read();
    } catch (cause) { if (alive.current && currentEpoch === epoch.current) {
      if (committed) setError("生产安排已保存 当前来源暂时无法刷新 请重新读取");
      else { if (privateDenied(cause)) clearPrivate(); setError(message(cause)); }
    } } finally { sending.current = false; if (alive.current) { setWorking(false); setRecoveryRefresh(value => value + 1); } }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (blocked || !sourceReady || !view || !route || !design || quantity === null || !manufacturingReady || !factoryReady || !capacityReady || !confirmed) return;
    try {
      const data = new FormData(event.currentTarget);
      const input = CreateProductionOrderInputSchema.parse({ orderLineId: lineId, quantity, factoryId: data.get("factoryId"), factoryVersionId: data.get("factoryVersionId"), capabilityVersionId: data.get("capabilityVersionId"),
        routingDecisionId: route.routingDecisionId, purchaseOrderVersionId: route.purchaseOrderVersionId, designVersionId: design.versionId, productionAssetIds: design.files.map(file => file.id),
        ...readProductionCapacitySelection(data, lineId, { factoryVersionId: String(data.get("factoryVersionId")), capabilityVersionId: String(data.get("capabilityVersionId")), quantity }), instructions: String(data.get("instructions")), idempotencyKey: crypto.randomUUID(),
        manufacturing: readProductionManufacturingSelection(data), productConfirmation: { specificationVersionId: specificationId, note: String(data.get("confirmationNote")) } });
      await perform({ path: `native/orders/${view.line.orderId}/production`, orderId: view.line.orderId, input: structuredClone(input) });
    } catch (cause) { setError(message(cause)); }
  }
  return <section className="np-detail" aria-label="直接生产安排" aria-busy={reading || working} ref={forms.ref} onInput={forms.check} onChange={forms.check}>
    {reading && <p role="status">正在核对本商品当前来源</p>}{error && <p role="alert" className="oc-error">{error}</p>}{notice && <p role="status" className="oc-notice">{notice}</p>}
    {view && <ProductionCommandRecovery key={`${view.line.orderId}:${view.contextAuthority}`} orderId={view.line.orderId} lineId={lineId}
      refresh={`${reload}:${recoveryRefresh}`} onBlocked={setRecoveryBlocked} onDenied={clearPrivate} onSucceeded={result => {
        setNotice(`生产安排 ${result.receipt!.productionOrderIds[0]!.slice(-8)} 已建立`); onChanged(); void read();
      }} />}
    {readFailed && view && <p className="oc-hint">已保留本次填写 重新核对成功前不能创建生产安排</p>}
    <button className="oc-text-button" type="button" disabled={working || reading} onClick={() => setReload(value => value + 1)}><RefreshCw size={13} aria-hidden="true" />核对当前生产来源</button>
    {view && <><h2>{view.line.orderNumber}</h2><p>{view.line.title}</p><p className="oc-hint">{view.sku ? `${view.sku.spuName} · ${view.sku.code}` : "尚未关联实际产品 SKU"} · 原订购 {view.line.quantity} 份 · 实际占用 {view.line.allocatedQuantity} 份 · 本次下达 {quantity === null ? "待明确核对" : `${quantity} 份`}</p>
      {!view.canCreate && <p role="status">当前角色仅可读取生产来源 无法建立生产安排</p>}
      {view.diagnostics.map(text => <p className="np-warning" key={text}>{text}</p>)}
      <form ref={formRef} aria-label="建立直接生产安排" onSubmit={event => void submit(event)}>
        <fieldset disabled={blocked}>
        <label>本次下达数量<input aria-label="本次下达数量" name="quantity" type="number" inputMode="numeric" min={1} max={remainingQuantity ?? undefined} step={1} required
          value={requestedQuantity} aria-invalid={!!requestedQuantity && quantity === null} aria-describedby="native-production-quantity-help" onChange={event => {
            setRequestedQuantity(event.target.value); setConfirmed(false); setFactoryReady(false); setFactoryChoice(null); setCapacityReady(false);
          }} /></label>
        <p id="native-production-quantity-help" className={requestedQuantity && quantity === null || remainingQuantity !== null && remainingQuantity <= 0 ? "np-warning" : "oc-hint"}>
          {remainingQuantity !== null && remainingQuantity <= 0 ? "当前原订购数量已占满 不能新增生产安排 请先核对实际停做凭据与当前占用" : `本次最多可下达 ${remainingQuantity} 份 请明确填写正整数 单次不超过 100000 份 数量变化后须重新核对工厂与产能`}
          {!!requestedQuantity && quantity === null && remainingQuantity !== null && remainingQuantity > 0 && " 当前填写不符合本次数量范围"}
        </p>
        <label>完整产品规格<select aria-label="完整产品规格" value={specificationId} required onChange={event => {
          setSpecificationId(event.target.value); setDesignId(""); setRouteId(""); setConfirmed(false); setManufacturingReady(false); setFactoryReady(false); setFactoryChoice(null); setCapacityReady(false);
        }}><option value="">明确选择本商品当前规格</option>{view.specifications.map(spec => <option key={spec.versionId} value={spec.versionId}>{spec.name} · V{spec.versionNumber}</option>)}</select></label>
        {sourceCurrent && view.source?.productType === "rectangular_print" && <>
          <label>已审核设计<select aria-label="已审核设计" value={designId} required onChange={event => { setDesignId(event.target.value); setConfirmed(false); setCapacityReady(false); }}><option value="">明确选择设计及其生产文件</option>{view.designs.map(design => <option key={design.versionId} value={design.versionId}>{design.title} · V{design.versionNumber} · {design.files.length} 个生产文件</option>)}</select></label>
          {view.designsTruncated && <p className="oc-hint">当前展示最近 25 个可读取审核版本 请在设计模块核对目标设计</p>}
          {design && <ul className="np-files">{design.files.map(file => <li key={file.id}><FileCheck2 size={14} aria-hidden="true" /><span>{file.name}<small>SHA-256 {file.sha256}</small></span></li>)}</ul>}
          <label>已批准采购来源<select aria-label="已批准采购来源" required value={routeId} onChange={event => { setRouteId(event.target.value); setConfirmed(false); setFactoryReady(false); setFactoryChoice(null); setCapacityReady(false); }}><option value="">明确选择路由与当前采购版本</option>{view.routes.map(route => <option key={routeIdentity(route)} value={routeIdentity(route)}>{route.supplierName} · 采购 V{route.purchaseVersionNumber} · {route.routingDecisionId.slice(-8)}</option>)}</select></label>
          {view.routesTruncated && <p className="oc-hint">当前展示最近 25 个采购来源 请在采购模块核对目标路由</p>}
          <ProductionManufacturingFields key={`${view.contextAuthority}:${specificationId}:${draftRevision}`} lineId={lineId} nativeSpecificationVersionId={specificationId} disabled={blocked} onReadinessChange={setManufacturingReady} />
          {route && quantity !== null && <ProductionFactorySelect lineId={lineId} quantity={quantity} nativeSource={{ specificationVersionId: specificationId, routingDecisionId: route.routingDecisionId, purchaseOrderVersionId: route.purchaseOrderVersionId }} disabled={blocked} onReady={setFactoryReady} onSelection={setFactoryChoice} />}
          <label>工厂当地预计完成时间<input name="due" type="datetime-local" required value={dueLocal} onChange={event => { setDueLocal(event.target.value); setCapacityReady(false); }} /></label>
          {factoryChoice && quantity !== null && <ProductionCapacityPicker factoryId={factoryChoice.pin.factoryId} items={[{ reference: lineId, factoryVersionId: factoryChoice.pin.factoryVersionId, capabilityVersionId: factoryChoice.pin.capabilityVersionId, quantity, dueLocal }]}
            basisKey={`${view.contextAuthority}:${specificationId}:${routeId}:${designId}:${quantity}:${view.line.allocatedQuantity}:${draftRevision}:${manufacturingReady}`} disabled={blocked || !factoryReady} onReady={setCapacityReady} onDenied={clearPrivate} />}
          <label>本次产品及设计确认依据<textarea aria-label="本次产品及设计确认依据" name="confirmationNote" required maxLength={2000} rows={2} /></label>
          <label>本次生产说明<textarea aria-label="本次生产说明" name="instructions" required maxLength={20000} rows={3} /></label>
          <label className="np-confirm"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对完整产品规格 原订购数量 本次下达数量 当前审核设计及所列生产文件</label>
          <button className="oc-button primary" disabled={blocked || !sourceReady || quantity === null || !manufacturingReady || !factoryReady || !capacityReady || !confirmed || !design || !route}>建立内部生产安排</button>
        </>}</fieldset>
      </form>
      {!!view.productions.length && <section className="np-history" aria-label="本商品已有生产安排"><h3>本商品已有生产安排</h3>{view.productions.map(record => <article key={record.id}>
        <p>{record.id.slice(-8)} · {labels[record.status] ?? record.status} · {record.quantity} 份 · {dateTime(record.createdAt)}</p>
        <ProductionCapacityReceipt productionOrderId={record.id} refresh={String(reload)} onDenied={clearPrivate} />
        <ProductionMaterialPanel productionOrderId={record.id} currentBindingId={null} bindings={[]} refresh={String(reload)} disabled={working || reading || recoveryBlocked}
          onEditsChanged={forms.check} onBusyChange={onMaterialBusy} onSaved={message => { setNotice(message); onChanged(); }} />
      </article>)}</section>}
    </>}
    <Link className="oc-text-button" href="/production">返回审核稿生产</Link>
  </section>;
}
function privateDenied(cause: unknown) { return cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status); }
function routeIdentity(route: NativeProductionDetail["routes"][number]) { return `${route.routingDecisionId}:${route.purchaseOrderVersionId}`; }
function message(cause: unknown) { return cause instanceof Error ? cause.message : "生产来源读取或提交未完成 请重新核对"; }
