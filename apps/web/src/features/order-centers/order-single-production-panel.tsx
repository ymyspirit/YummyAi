"use client";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Factory, RefreshCw } from "lucide-react";
import { OrderLineProductionAvailabilitySchema, type OrderLineProductionAvailability, type OrderWorkDetail } from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import type { ProductionFactoryChoice } from "@yummyai/contracts/suppliers/factory-directory";
import { centerRequest, OrderCenterRequestError } from "./order-center-model";
import { currentProductionRender } from "./order-artwork-review-model";
import { ProductionFactorySelect } from "./order-production-factory-select";
import { ProductionManufacturingFields, readProductionManufacturingSelection } from "./production-manufacturing-fields";
import { ProductionCapacityPicker, readProductionCapacitySelection } from "./production-capacity-picker";
import "./order-single-production-panel.css";

export function OrderSingleProductionPanel({ detail, editor, refresh, disabled, onSubmit, onRefresh }: {
  detail: OrderWorkDetail; editor: ProductionEditorDetailView | null; refresh: string; disabled: boolean; onRefresh(): void;
  onSubmit(event: FormEvent<HTMLFormElement>, path: string, payload: Record<string, unknown>, success: string): Promise<void>;
}) {
  const render = editor ? currentProductionRender(editor) : null;
  const identity = `${detail.line.id}:${detail.line.revision}`;
  const [view, setView] = useState<OrderLineProductionAvailability | null>(null), [loadedIdentity, setLoadedIdentity] = useState("");
  const [reading, setReading] = useState(true), [failed, setFailed] = useState(false), [error, setError] = useState("");
  const [openedOnce, setOpenedOnce] = useState(false);
  const panel = useRef<HTMLDetailsElement | null>(null);
  const [quantity, setQuantity] = useState(""), [reload, setReload] = useState(0), [factoryReady, setFactoryReady] = useState(false), [manufacturingReady, setManufacturingReady] = useState(false);
  const [factoryChoice, setFactoryChoice] = useState<ProductionFactoryChoice | null>(null), [dueLocal, setDueLocal] = useState(""), [capacityReady, setCapacityReady] = useState(false);
  const previous = useRef(""), quantityRef = useRef(""); quantityRef.current = quantity;
  useLayoutEffect(() => { if (panel.current?.open) setOpenedOnce(true); }, []);
  useEffect(() => {
    const check = () => { if (document.visibilityState !== "hidden") { if (panel.current?.open) setOpenedOnce(true); setReload(value => value + 1); } };
    window.addEventListener("focus", check); window.addEventListener("pageshow", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); window.removeEventListener("pageshow", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  useEffect(() => {
    if (!openedOnce) return;
    const controller = new AbortController();
    if (previous.current !== identity) { setView(null); setLoadedIdentity(""); setQuantity(""); quantityRef.current = ""; setFactoryReady(false); setManufacturingReady(false); }
    previous.current = identity; setReading(true); setFailed(false); setError("");
    void centerRequest(`lines/${detail.line.id}/production-availability`, undefined, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      const next = OrderLineProductionAvailabilitySchema.parse(value);
      if (next.lineId !== detail.line.id) throw new Error("返回的生产数量不属于本商品 请重新核对");
      setView(next); setLoadedIdentity(identity);
      const entered = Number(quantityRef.current);
      if (!quantityRef.current) setQuantity(next.availableQuantity ? String(next.availableQuantity) : "");
      else if (entered > next.availableQuantity) { setQuantity(""); setError("可安排数量已变化 请重新填写本次数量"); }
    }).catch(cause => { if (!controller.signal.aborted) {
      setFailed(true);
      if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) { setView(null); setLoadedIdentity(""); setQuantity(""); setFactoryReady(false); setManufacturingReady(false); }
      setError(cause instanceof Error ? cause.message : "本商品生产数量暂时无法读取 请重新核对");
    } }).finally(() => { if (!controller.signal.aborted) setReading(false); });
    return () => controller.abort();
  }, [openedOnce, identity, detail.line.id, refresh, reload]);
  const current = loadedIdentity === identity ? view : null, amount = Number(quantity);
  const sourceChanged = !!current && (current.revision !== detail.line.revision || current.projectionVersion !== detail.line.projectionVersion);
  const unavailable = disabled || reading || failed || !current || !current.canRelease || sourceChanged;
  const validQuantity = Number.isSafeInteger(amount) && amount > 0 && amount <= (current?.availableQuantity ?? 0);
  const proofReady = detail.line.proof === "not_required" || detail.line.proof === "approved" && detail.line.proofVersionCurrent === true;
  const approved = !!render && render.status === "completed" && render.purpose === "production" && detail.line.artwork === "approved" && proofReady && !detail.line.held;
  const ready = approved && !unavailable && validQuantity && factoryReady && manufacturingReady && capacityReady;
  return <details ref={panel} className="oc-single-production" onToggle={event => { if (event.currentTarget.open) setOpenedOnce(true); }}><summary><Factory size={15} aria-hidden="true" />按商品或拆厂安排生产</summary>
    <p className="oc-hint">为本商品选择具体工厂与本次数量 同一商品可以分批安排 每批固定原审核稿与明确的制造版本</p>
    {reading && <p role="status" className="oc-hint">正在核对原生产分配与可安排数量</p>}
    {error && <p role="alert" className="oc-error">{error}</p>}
    {current && <p className="oc-single-production-quantity">订购 {current.orderedQuantity} · 原生产已占用 {current.allocatedQuantity} · 还可安排 {current.availableQuantity}</p>}
    {current && !current.canRelease && <p className="oc-hint">当前角色可核对生产数量 下达生产需要订单操作权限</p>}
    {sourceChanged && <p role="alert" className="oc-error">审单或生产状态已变化 请重新读取本商品后核对</p>}
    <button type="button" className="oc-text-button" disabled={disabled || reading} onClick={() => { setReload(value => value + 1); if (sourceChanged) onRefresh(); }}><RefreshCw size={13} aria-hidden="true" />重新核对可安排数量</button>
    {!approved && <p className="oc-hint">本商品须先完成审核并生成正式生产文件 暂停的商品须先核对暂停原因</p>}
    {approved && current && current.availableQuantity > 0 && <form aria-label="安排本商品生产" data-order-action="production-release-single" onSubmit={event => {
      event.preventDefault(); if (!ready || !render || !current) return;
      const form = new FormData(event.currentTarget);
      try {
        const text = (name: string) => String(form.get(name) ?? "").trim();
        if (!["supplierId", "factoryId", "factoryVersionId", "capabilityVersionId"].every(name => text(name))) throw new Error("请重新核对本次数量和工厂能力");
        void onSubmit(event, `lines/${detail.line.id}/release`, { expectedRevision: current.revision, expectedProjectionVersion: current.projectionVersion, renderId: render.id,
          supplierId: text("supplierId"), factoryId: text("factoryId"), factoryVersionId: text("factoryVersionId"), capabilityVersionId: text("capabilityVersionId"),
          quantity: amount, ...readProductionCapacitySelection(form, detail.line.id, { quantity: amount, factoryVersionId: text("factoryVersionId"), capabilityVersionId: text("capabilityVersionId") }), instructions: text("instructions"), manufacturing: readProductionManufacturingSelection(form) }, "本商品生产已安排 原审核稿 制造版本 工厂与产能已固定");
      } catch (cause) { setError(cause instanceof Error ? cause.message : "请核对本次生产填写"); }
    }}><fieldset className="oc-operation-form oc-single-production-fields" disabled={unavailable}>
      <label>本次商品数量<input name="quantity" required type="number" min={1} max={current.availableQuantity} step={1} value={quantity} onChange={event => setQuantity(event.target.value)} /></label>
      <label>工厂当地预计完成<input name="due" required type="datetime-local" value={dueLocal} onChange={event => setDueLocal(event.target.value)} /></label>
      <div className="oc-full-field"><ProductionManufacturingFields lineId={detail.line.id} disabled={unavailable} onReadinessChange={setManufacturingReady} /></div>
      {validQuantity && <div className="oc-full-field"><ProductionFactorySelect lineId={detail.line.id} renderId={render.id} quantity={amount} disabled={unavailable} onReady={setFactoryReady} onSelection={setFactoryChoice} /></div>}
      {validQuantity && factoryChoice && <div className="oc-full-field"><ProductionCapacityPicker factoryId={factoryChoice.pin.factoryId} items={[{ reference: detail.line.id, factoryVersionId: factoryChoice.pin.factoryVersionId, capabilityVersionId: factoryChoice.pin.capabilityVersionId, quantity: amount, dueLocal }]}
        basisKey={`${identity}:${current.projectionVersion}:${render.id}:${manufacturingReady}`} disabled={unavailable || !factoryReady} onReady={setCapacityReady} /></div>}
      <label className="oc-full-field">本次生产说明<textarea aria-label="本次生产说明" name="instructions" required maxLength={10000} defaultValue="按本商品已审核稿及本次制造版本生产" rows={2} /></label>
      <div className="oc-actions oc-full-field"><button className="oc-button primary" disabled={!ready}>安排本商品生产</button></div>
    </fieldset></form>}
    {current?.availableQuantity === 0 && <p className="oc-hint">本商品已全部安排 原生产与实际交运记录保留 需要重新制作时从对应生产记录创建关联返工</p>}
  </details>;
}
