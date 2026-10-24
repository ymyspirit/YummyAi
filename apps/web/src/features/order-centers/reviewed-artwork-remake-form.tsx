"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { RefreshCw } from "lucide-react";
import type { ProductionDeliveryPackageView } from "@yummyai/contracts/order/production-delivery";
import { OrderLineProductionAvailabilitySchema, OrderWorkDetailViewSchema } from "@yummyai/contracts/order/workspace";
import { ProductionEditorDetailViewSchema } from "@yummyai/contracts/pod/production-editor-api";
import { centerRequest, OrderCenterRequestError } from "./order-center-model";
import { currentProductionRender } from "./order-artwork-review-model";
import { ProductionManufacturingFields, readProductionManufacturingSelection } from "./production-manufacturing-fields";
import { ProductionCapacityPicker, readProductionCapacitySelection } from "./production-capacity-picker";
import { FulfillmentCommandPrepareButton } from "./fulfillment-command-recovery";
import { useAgentFulfillmentProposalHandoff, useAgentFulfillmentProposalInput, agentFulfillmentProposalLocalTime } from "../ai-tasks/agent-fulfillment-proposal-handoff";

type Pin = NonNullable<ProductionDeliveryPackageView["items"][number]["snapshot"]>;
type Basis = { renderId: string; expectedRevision: number; expectedProjectionVersion: number; version: number; instructions: string };
export function ReviewedArtworkRemakeForm({ pin, busy, create, commit, prepareAgent }: {
  pin: Pin; busy: boolean; create(input: Record<string, unknown>): Promise<boolean>; commit(form: HTMLFormElement): void;
  prepareAgent?(input: Record<string, unknown>): Promise<boolean>;
}) {
  const proposalHandoff = useAgentFulfillmentProposalHandoff(), suggestion = useAgentFulfillmentProposalInput("production_recovery", pin.productionOrderId);
  const [basis, setBasis] = useState<Basis | null>(null), [verified, setVerified] = useState(false), [reading, setReading] = useState(false);
  const [error, setError] = useState(""), [note, setNote] = useState(""), [confirmed, setConfirmed] = useState(false), [manufacturingReady, setManufacturingReady] = useState(false);
  const [quantity, setQuantity] = useState(String(pin.quantity)), [dueLocal, setDueLocal] = useState(""), [capacityReady, setCapacityReady] = useState(false);
  useEffect(() => {
    if (!proposalHandoff?.formKey) return;
    active.current?.abort(); setReading(false);
    setQuantity(suggestion?.remakeQuantity == null ? "" : String(suggestion.remakeQuantity)); setDueLocal(pin.factory?.factoryProfile.timeZone ? agentFulfillmentProposalLocalTime(suggestion?.expectedCompletionAt, pin.factory.factoryProfile.timeZone) : "");
    setNote(suggestion?.reviewedArtwork?.instructions ?? ""); setConfirmed(false); setVerified(false); setBasis(null); setManufacturingReady(false); setCapacityReady(false);
  }, [proposalHandoff?.formKey, suggestion, pin.factory?.factoryProfile.timeZone]);
  const active = useRef<AbortController | null>(null), identity = basis ? `${basis.renderId}:${basis.expectedRevision}:${basis.expectedProjectionVersion}` : "none";
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    const check = () => { if (document.visibilityState !== "hidden" && identity !== "none") {
      active.current?.abort(); setReading(false); setVerified(false); setConfirmed(false);
    } };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, [identity]);
  async function prepare() {
    if (busy || reading) return;
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    setReading(true); setVerified(false); setConfirmed(false); setError("");
    try {
      const availability = OrderLineProductionAvailabilitySchema.parse(await centerRequest(`lines/${pin.orderLineId}/production-availability`, undefined, controller.signal));
      if (availability.lineId !== pin.orderLineId) throw new Error("返工生产数量来源不属于本商品 请重新核对");
      if (!availability.canRelease) throw new OrderCenterRequestError(403, "当前角色无法下达返工生产 请联系订单负责人");
      const detail = OrderWorkDetailViewSchema.parse(await centerRequest(`lines/${pin.orderLineId}`, undefined, controller.signal));
      if (detail.line.id !== pin.orderLineId) throw new Error("当前审核稿来源不属于本商品 请重新核对");
      if (!detail.line.editorProjectId || detail.line.artwork !== "approved" ||
        !(detail.line.proof === "not_required" || detail.line.proof === "approved" && detail.line.proofVersionCurrent === true))
        throw new Error("请先完成当前稿件审核及所需客户确认 改图前须记录原生产单已停单 再回制图中心修改");
      const response = await fetch(`/api/production-editor/projects/${detail.line.editorProjectId}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new OrderCenterRequestError(response.status, "当前审核稿读取失败 请重新核对");
      const editor = ProductionEditorDetailViewSchema.parse(await response.json()), render = currentProductionRender(editor), document = editor.version.document;
      if (!editor.version.reviewed || !render || render.status !== "completed" || !render.preflight?.productionReady || document.productType !== "shaped_pillow")
        throw new Error("当前审核版本的正式 JPG 尚未完成 请在制图中心处理");
      if (controller.signal.aborted) return;
      setBasis({ renderId: render.id, expectedRevision: detail.line.revision, expectedProjectionVersion: detail.line.projectionVersion, version: editor.version.versionNumber,
        instructions: `${document.spec.factoryStandardId}；主体最长边 ${document.spec.declaredLongestMm} mm；${document.spec.sideMode === "single" ? "单面" : "双面"}；JPG ${document.spec.dpi} DPI；裁线最窄处 ≥ ${document.spec.minimumNeckMm} mm。` });
      setVerified(true);
    } catch (cause) { if (!controller.signal.aborted) {
      if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) { setBasis(null); setNote(""); setManufacturingReady(false); }
      setError(cause instanceof Error ? cause.message : "当前审核稿暂时无法核对 请重试");
    } } finally { if (!controller.signal.aborted) setReading(false); }
  }
  const unavailable = busy || reading || !verified;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (unavailable || !basis || !manufacturingReady || !capacityReady || !confirmed || !pin.factory) return;
    const form = event.currentTarget, data = new FormData(form), supplement = String(data.get("instructions") ?? "").trim();
    const prepareOnly = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-agent-fulfillment-prepare") === "true";
    if (proposalHandoff && !prepareOnly) { setError("当前为模型建议补项 请只准备交接 不直接创建返工单"); return; }
    if (prepareOnly && !prepareAgent) return;
    const instructions = [basis.instructions, supplement].filter(Boolean).join("\n");
    try {
      if (instructions.length > 20000) throw new Error("请缩短返工补充说明 保留完整的本次审核稿生产要求");
      const save = prepareOnly && prepareAgent ? prepareAgent : create;
      const saved = await save({ type: "remake", originalProductionOrderId: pin.productionOrderId, remakeQuantity: Number(data.get("quantity")), reason: String(data.get("reason")),
        ...readProductionCapacitySelection(data, pin.productionOrderId, { factoryVersionId: pin.factory.factoryVersionId, capabilityVersionId: pin.factory.capabilityVersionId, quantity: Number(data.get("quantity")) }), manufacturing: readProductionManufacturingSelection(data),
        reviewedArtwork: { renderId: basis.renderId, expectedRevision: basis.expectedRevision, expectedProjectionVersion: basis.expectedProjectionVersion, instructions } });
      if (saved) { form.reset(); commit(form); setBasis(null); setNote(""); setConfirmed(false); setVerified(false); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "返工记录未完成 请核对填写内容"); }
  }
  return <details className="oc-delivery-history"><summary>创建关联返工生产单</summary>
    <p className="oc-muted">核对当前审核稿 制造版本 补做数量与交期 创建后仍须交付新生产单并登记工厂回复</p>
    <button className="oc-button" type="button" disabled={busy || reading} onClick={() => void prepare()}><RefreshCw size={13} aria-hidden="true" />核对当前审核稿</button>
    {reading && <p role="status">正在核对审核稿…</p>}{error && <p role="alert" className="oc-delivery-error">{error}</p>}
    {basis && !verified && <p className="oc-muted">已保留本次填写 重新核对当前审核稿成功前不能创建返工单</p>}
    {basis && <form key={proposalHandoff?.formKey} className="oc-delivery-form" aria-label={`创建返工生产单 ${pin.orderNumber}`} onSubmit={event => void submit(event)}>
      <p>当前核对稿 V{basis.version} · 原交付稿 V{pin.editorVersionNumber}</p><fieldset disabled={unavailable}>
        <ProductionManufacturingFields key={`${basis.renderId}:${basis.expectedRevision}`} lineId={pin.orderLineId} disabled={unavailable} onReadinessChange={setManufacturingReady} />
        <label>返工数量<input name="quantity" type="number" min={1} max={pin.quantity} required value={quantity} onChange={event => setQuantity(event.target.value)} /></label><label>返工工厂当地预计完成<input name="due" type="datetime-local" required value={dueLocal} onChange={event => setDueLocal(event.target.value)} /></label>
        {pin.factory ? <ProductionCapacityPicker factoryId={pin.factory.factoryId} items={[{ reference: pin.productionOrderId, factoryVersionId: pin.factory.factoryVersionId, capabilityVersionId: pin.factory.capabilityVersionId, quantity: Number(quantity), dueLocal }]}
          basisKey={`${identity}:${manufacturingReady}`} disabled={unavailable} onReady={setCapacityReady} onDenied={() => { setBasis(null); setNote(""); setQuantity(""); setDueLocal(""); setVerified(false); }} />
          : <p className="oc-delivery-error" role="status">原生产未保留可读取的固定工厂与能力 新返工受阻 不用当前工厂资料猜补历史</p>}
        <label className="oc-delivery-wide">返工原因与依据<input name="reason" required minLength={5} maxLength={2000} defaultValue={suggestion?.reason} /></label>
        <p className="oc-delivery-wide" aria-label="本次审核稿生产要求">{basis.instructions}</p>
        <label className="oc-delivery-wide">返工补充说明<textarea aria-label="返工补充说明" name="instructions" maxLength={Math.max(0, 20000 - basis.instructions.length - 1)} value={note} onChange={event => setNote(event.target.value)} rows={2} /></label>
        <label className="oc-delivery-verify"><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对当前审核稿、补做数量及工厂安排</label>
        <button className="oc-button" disabled={!!proposalHandoff || !verified || !manufacturingReady || !capacityReady || !confirmed || !pin.factory}>创建返工生产单</button>
        {prepareAgent && <FulfillmentCommandPrepareButton disabled={!verified || !manufacturingReady || !capacityReady || !confirmed || !pin.factory} />}
      </fieldset></form>}
  </details>;
}
