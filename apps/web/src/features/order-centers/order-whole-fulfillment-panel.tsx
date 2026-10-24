"use client";
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { InspectWholeOrderInputSchema, WholeOrderFulfillmentViewSchema, type WholeOrderFulfillmentView } from "@yummyai/contracts/order/whole-fulfillment";
import type { OrderCenterOptions } from "@yummyai/contracts/order/workspace";
import { centerRequest, label, OrderCenterRequestError } from "./order-center-model";
import { OrderLifecycleBadge } from "./order-lifecycle";
import { type ShiposOrderShipmentEvidence } from "@yummyai/contracts/suppliers/shipos";
import { OrderShiposShipmentPicker } from "./order-shipos-shipment-picker";
import { QualityAssessmentFields, readQualityAssessmentForm } from "./quality-assessment-fields";
import { ShipmentProductionFields, readShipmentProductionAllocations } from "./shipment-production-fields";
import { ProductionManufacturingFields, readProductionManufacturingSelection } from "./production-manufacturing-fields";
import { ProductionCapacityPicker, readProductionCapacitySelection } from "./production-capacity-picker";
import { FulfillmentCommandPrepareButton } from "./fulfillment-command-recovery";
import { useAgentFulfillmentProposalHandoff, useAgentFulfillmentProposalInput, agentFulfillmentProposalLocalTime } from "../ai-tasks/agent-fulfillment-proposal-handoff";

const progress: Record<string, [string, string]> = {
  planned: ["submitted", "记录整单已发送工厂"], submitted: ["acknowledged", "记录工厂已接整单"],
  acknowledged: ["started", "记录整单开始生产"], in_production: ["completed", "记录整单生产完工"],
};
type Submit = (event: FormEvent<HTMLFormElement>, path: string, payload: Record<string, unknown>, success: string) => Promise<void>;
export function OrderWholeFulfillmentPanel({ orderId, module, refresh, busy, options, onReading, onSubmit, onSelectItem, onEditsChanged }: {
  orderId: string; module: "production" | "shipments"; refresh: string; busy: boolean;
  options: OrderCenterOptions; onReading: (reading: boolean) => void; onSubmit: Submit;
  onSelectItem?: (lineId: string, module: "artwork" | "shipments") => void;
  onEditsChanged?: () => void;
}) {
  const proposalHandoff = useAgentFulfillmentProposalHandoff(), progressSuggestion = useAgentFulfillmentProposalInput("whole_production_milestone", orderId),
    qualitySuggestion = useAgentFulfillmentProposalInput("whole_quality_inspection", orderId), shipmentSuggestion = useAgentFulfillmentProposalInput("whole_shipment_create", orderId);
  const [plan, setPlan] = useState<WholeOrderFulfillmentView | null>(null), [error, setError] = useState(""),
    [reading, setReading] = useState(true), [readFailed, setReadFailed] = useState(false), [reload, setReload] = useState(0), [factoryId, setFactoryId] = useState("");
  const [source, setSource] = useState<ShiposOrderShipmentEvidence | null>(null);
  const [manufacturingReady, setManufacturingReady] = useState<Record<string, boolean>>({});
  const [dueLocal, setDueLocal] = useState(""), [capacityReady, setCapacityReady] = useState(false);
  const [shipment, setShipment] = useState({ tracking: "", carrierCode: "", carrierName: "", service: "", country: "", shipDate: "" });
  useEffect(() => {
    if (!proposalHandoff?.formKey) return;
    setShipment({ tracking: shipmentSuggestion?.trackingNumber ?? "", carrierCode: shipmentSuggestion?.carrierCode ?? "", carrierName: shipmentSuggestion?.carrierName ?? "",
      service: shipmentSuggestion?.carrierService ?? "", country: shipmentSuggestion?.shipFromCountryCode ?? "", shipDate: agentFulfillmentProposalLocalTime(shipmentSuggestion?.shipDate) });
    setSource(null);
  }, [proposalHandoff?.formKey, shipmentSuggestion]);
  useLayoutEffect(() => { onEditsChanged?.(); }, [shipment, source, onEditsChanged]);
  function changeShipment(key: keyof typeof shipment, next: string) { setShipment(current => ({ ...current, [key]: next })); }
  function bringWaybill(item: ShiposOrderShipmentEvidence) {
    const mapping = item.carrierMapping;
    setSource(item); setShipment(current => ({ ...current, tracking: item.record.trackingNumber ?? "", carrierCode: mapping?.carrierCode ?? "",
      carrierName: mapping?.carrierName ?? "", service: mapping?.carrierService ?? "", country: mapping?.shipFromCountryCode ?? "" }));
  }
  useEffect(() => {
    const abort = new AbortController();
    setReading(true); setReadFailed(false); onReading(true); setError("");
    void centerRequest(`orders/${orderId}/fulfillment`, undefined, abort.signal).then(value => {
      if (!abort.signal.aborted) setPlan(WholeOrderFulfillmentViewSchema.parse(value));
    }).catch(cause => { if (!abort.signal.aborted) {
      setReadFailed(true); setError(cause instanceof Error ? cause.message : "整单资料读取失败");
      if (cause instanceof OrderCenterRequestError && [401, 403].includes(cause.status)) {
        setPlan(null); setSource(null); setFactoryId("");
        setShipment({ tracking: "", carrierCode: "", carrierName: "", service: "", country: "", shipDate: "" });
      }
    } })
      .finally(() => { if (!abort.signal.aborted) { setReading(false); onReading(false); } });
    return () => { abort.abort(); onReading(false); };
  }, [orderId, module, refresh, reload, onReading]);
  const disabled = busy || reading || readFailed;
  const factory = plan?.factories.find(factory => factory.factoryId === factoryId);
  const items = plan?.items.map(({ lineId, quantity, expectedRevision, expectedProjectionVersion }) => ({ lineId, quantity, expectedRevision, expectedProjectionVersion })) ?? [];
  const productionItems = plan?.items.map((item, index) => ({ ...items[index]!, productionOrderId: item.production?.id,
    expectedProductionProjectionVersion: item.production?.projectionVersion })) ?? [];
  const sameProduction = !!plan && plan.items.every(item => item.production?.wholeOrder && item.production.status === plan.items[0]!.production?.status);
  const next = sameProduction ? progress[plan!.items[0]!.production!.status] : undefined;
  const qualityDue = sameProduction && plan!.items.every(item => ["completed", "quality_hold"].includes(item.production!.status)) && plan!.items.some(item => item.readyQuantity < item.quantity);
  const productionBlocked = !plan || plan.items.some(item => item.productionBlockers.length || !manufacturingReady[item.lineId]) || !factory;
  const progressBlocked = !plan || plan.items.some(item => item.operationBlockers.length);
  const shipmentBlocked = !plan || plan.items.some(item => item.shipmentBlockers.length);
  const allShipped = !!plan && plan.items.every(item => item.shippedQuantity >= item.quantity);
  const submit: Submit = async (event, path, payload, success) => {
    event.preventDefault(); if (disabled) return;
    setError("");
    try { await onSubmit(event, path, payload, success); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "请核对整单填写内容"); }
  };
  return <section className="oc-whole-fulfillment" aria-label={module === "production" ? "整单生产" : "整单发货"} aria-busy={reading}>
    <div className="oc-whole-heading"><h3>{module === "production" ? "整单生产" : "整单发货"}</h3>
      <button type="button" className="oc-text-button" disabled={busy || reading} title="重新读取进度，保留当前填写内容" onClick={() => setReload(value => value + 1)}>重新核对整单</button></div>
    {error && <p className="oc-error" role="alert">{error}</p>}
    {reading && <p className="oc-hint" role="status">正在核对订单全部商品…</p>}
    {plan && <>
      <p className="oc-whole-summary"><strong>{plan.orderNumber}</strong><span>{plan.items.length} 项商品 · 共 {plan.quantity} 件 · 一起制作，一个包裹发出</span><OrderLifecycleBadge status={plan.orderStatus ?? undefined} /></p>
      <table className="oc-whole-table"><thead><tr><th>本单全部商品</th><th>数量</th><th>{module === "production" ? "审核文件与生产进度" : "发货条件"}</th></tr></thead><tbody>
        {plan.items.map(item => <tr key={item.lineId}><td><strong>{item.title}</strong><small>{[item.sku, item.specification, item.externalLineId].filter(Boolean).join(" · ")}</small></td>
          <td>{item.quantity} 件</td><td>{module === "production" ? <>
            <span>{item.fileName ? `审核稿 V${item.editorVersionNumber} · ${item.fileName}` : "正式生产文件尚未齐备"}</span>
            {item.production && <small>{label(item.production.status)}{item.production.qualityResult ? ` · 质检${item.production.qualityResult === "passed" ? "通过" : "异常"}` : ""}</small>}
            {(item.production ? item.operationBlockers : item.productionBlockers).map(reason => <small className="oc-error" key={reason}>{reason}</small>)}
            {factory && <small>工厂能力：{factory.items.find(pin => pin.lineId === item.lineId)?.capabilityName}</small>}
          </> : <><span>质检通过 {item.readyQuantity}/{item.quantity} 件 · 已出库 {item.shippedQuantity} 件</span>
            {!allShipped && item.shipmentBlockers.map(reason => <small className="oc-error" key={reason}>{reason}</small>)}</>}</td></tr>)}
      </tbody></table>
      {module === "production" ? <>
        {plan.items.every(item => !item.production) ? <>
          <p className="oc-hint">一次安排本单全部商品。每件商品固定自己的审核稿和工艺版本；保存后按实际情况登记工厂进度。</p>
          {plan.items.some(item => item.productionBlockers.length) && <p>请先补齐上面的制作条件。{onSelectItem ? <button type="button" className="oc-text-button" disabled={disabled} onClick={() => onSelectItem(plan.items.find(item => item.productionBlockers.length)!.lineId, "artwork")}>处理未完成商品</button> : <Link href={`/order-artwork?line=${plan.items.find(item => item.productionBlockers.length)!.lineId}`}>处理未完成商品</Link>}</p>}
          {!plan.factories.length && plan.items.every(item => !item.productionBlockers.length) && <div aria-label="工厂承接条件" className="oc-factory-diagnostics"><p className="oc-error">当前没有能承接本单全部商品的同一工厂。</p>
            {!plan.factoryDiagnostics.length && <p>尚未配置可核对的工厂。<Link href="/suppliers">新增工厂与产品能力</Link></p>}
            {plan.factoryDiagnostics.map(factory => <div key={factory.factoryId}><strong>{factory.supplierName} · {factory.factoryName}</strong><ul>{factory.blockers.map(reason => <li key={reason}>{reason}</li>)}</ul>
              <div className="oc-action-row"><Link href={`/suppliers/${factory.supplierId}/factories/${factory.factoryId}#factory-capabilities`}>配置此工厂承接能力</Link><Link href={`/suppliers/${factory.supplierId}/factories/${factory.factoryId}#factory-profile`}>查看此工厂资料与启用状态</Link><Link href={`/suppliers/${factory.supplierId}`}>核对供应商状态</Link></div></div>)}
          </div>}
          <form aria-label="安排整单生产" data-order-action="production-release" onSubmit={event => { event.preventDefault(); const form = new FormData(event.currentTarget);
            try {
            if (!factory || !capacityReady) throw new Error("请先核对本单全部商品的共享产能和工厂当地完工时间");
            const prepared = plan.items.map(item => {
              const capabilityVersionId = factory.items.find(pin => pin.lineId === item.lineId)?.capabilityVersionId;
              if (!capabilityVersionId) throw new Error("本单固定工厂能力不完整 请重新读取");
              return readProductionCapacitySelection(form, item.lineId, { factoryVersionId: factory.factoryVersionId, capabilityVersionId, quantity: item.quantity });
            });
            if (new Set(prepared.map(item => item.expectedCompletionAt)).size !== 1) throw new Error("整单工厂当地完工时间不一致 请重新预览");
            void submit(event, `orders/${orderId}/release`, { supplierId: factory?.supplierId, factoryId: factory?.factoryId, factoryVersionId: factory?.factoryVersionId,
              items: plan.items.map((item, index) => ({ ...items[index]!, renderId: item.renderId, capabilityVersionId: factory?.items.find(pin => pin.lineId === item.lineId)?.capabilityVersionId,
                capacityPlan: prepared[index]!.capacityPlan, manufacturing: readProductionManufacturingSelection(form, `manufacturing-${item.lineId}`) })),
              expectedCompletionAt: prepared[0]!.expectedCompletionAt, instructions: value(form, "instructions") }, "整单生产已安排 全部商品的文件 工厂与共享产能已固定");
            } catch (cause) { setError(cause instanceof Error ? cause.message : "请核对每件商品的制造依据"); } }}>
            <fieldset className="oc-operation-form oc-whole-fields" disabled={disabled}>
              {plan.items.map(item => <div className="oc-full-field" key={item.lineId}><strong>{item.title}</strong><ProductionManufacturingFields lineId={item.lineId} prefix={`manufacturing-${item.lineId}`} disabled={disabled} refresh={`${reload}:${item.expectedRevision}:${item.expectedProjectionVersion}`}
                onReadinessChange={ready => setManufacturingReady(current => current[item.lineId] === ready ? current : { ...current, [item.lineId]: ready })} /></div>)}
              <label>承接工厂<select name="factory" required value={factoryId} onChange={event => setFactoryId(event.target.value)}>
                <option value="">选择能承接整单的工厂</option>{plan.factories.map(factory => <option key={factory.factoryId} value={factory.factoryId}>{factory.supplierName} · {factory.factoryName}</option>)}</select></label>
              <label>整单工厂当地计划完工<input name="due" type="datetime-local" required value={dueLocal} onChange={event => setDueLocal(event.target.value)} /></label>
              {factory && <div className="oc-full-field"><ProductionCapacityPicker factoryId={factory.factoryId} items={plan.items.map(item => ({ reference: item.lineId, factoryVersionId: factory.factoryVersionId,
                capabilityVersionId: factory.items.find(pin => pin.lineId === item.lineId)?.capabilityVersionId ?? "", quantity: item.quantity, dueLocal }))}
                basisKey={JSON.stringify([orderId, plan.items.map(item => [item.lineId, item.expectedRevision, item.expectedProjectionVersion, item.renderId]), manufacturingReady])} disabled={disabled || productionBlocked} onReady={setCapacityReady} /></div>}
              <label className="oc-full-field">整单补充说明（选填）<textarea name="instructions" maxLength={2000} placeholder="例如整单一起打包、特殊交付要求；具体工艺自动固定到各件审核文件" /></label>
              <button className="oc-button primary" disabled={productionBlocked || !capacityReady}>安排整单生产（{plan.quantity} 件）</button>
            </fieldset></form>
        </> : <>
          {next && <form key={proposalHandoff?.formKey} aria-label="登记整单生产进度" data-order-action="production-progress" onSubmit={event => { const form = new FormData(event.currentTarget);
            void submit(event, `orders/${orderId}/production-progress`, { type: next[0], items: productionItems, occurredAt: iso(form, "time"),
              evidence: { code: value(form, "reference"), note: value(form, "note"), assetIds: [] } }, "整单生产进度已记录。"); }}>
            <fieldset className="oc-operation-form oc-whole-fields" disabled={disabled || progressBlocked}>
              <label>整单工厂凭证<input required name="reference" maxLength={160} pattern="[A-Z0-9_:-]+" placeholder="例如 FACTORY_001" defaultValue={progressSuggestion?.evidence?.code} /></label>
              <label>整单进度发生时间<input required name="time" type="datetime-local" defaultValue={agentFulfillmentProposalLocalTime(progressSuggestion?.occurredAt)} /></label>
              <label>进度备注（选填）<input name="note" maxLength={2000} defaultValue={progressSuggestion?.evidence?.note ?? ""} /></label>
              <button className="oc-button primary" disabled={!!proposalHandoff}>{next[1]}</button>
              <FulfillmentCommandPrepareButton disabled={disabled || progressBlocked} />
            </fieldset></form>}
          {qualityDue && <form aria-label="登记整单质检" data-order-action="production-quality" onSubmit={event => {
            event.preventDefault();
            try {
              const form = new FormData(event.currentTarget), quality = readQualityAssessmentForm(form);
              const pinnedItems = InspectWholeOrderInputSchema.shape.items.parse(JSON.parse(value(form, "qualityPins")));
              void submit(event, "orders/" + orderId + "/quality-pass", { items: pinnedItems, qualityStandardVersionId: value(form, "standard"),
                assessment: quality.assessment, scoreBps: quality.scoreBps, inspectedAt: iso(form, "time"), evidenceAssetIds: [] }, "整单质检已通过，可以把全部商品装入一个包裹。");
            } catch (cause) { setError(cause instanceof Error ? cause.message : "请核对整单质检内容"); }
          }}>
            <p className="oc-hint">逐项核对本单每件商品 若有不合格商品 请到商品记录中登记缺陷并处理返工</p>
            <QualityAssessmentFields key={proposalHandoff?.formKey} standards={options.standards} pins={productionItems} passOnly disabled={disabled || progressBlocked} submitLabel="登记整单质检通过" allowAgentPrepare suggestion={qualitySuggestion} />
          </form>}
          {!sameProduction && <p className="oc-hint">本单商品的生产安排或进度不同，请在下方商品记录中核对。</p>}
          {!progressBlocked && plan.items.every(item => item.readyQuantity >= item.quantity) && <p className="oc-notice">全部商品已生产并通过质检。{onSelectItem ? <button type="button" className="oc-text-button" disabled={disabled} onClick={() => onSelectItem(plan.items[0]!.lineId, "shipments")}>去整单发货</button> : <Link href={`/shipments?line=${plan.items[0]!.lineId}`}>去整单发货</Link>}</p>}
        </>}
      </> : <>
        {!plan.shipmentIds.length && <p className="oc-hint">填写工厂已有的运单号，把本单全部商品装入一个包裹。保存包裹、核对包裹、记录实际出库依次完成。</p>}
        {!plan.shipmentIds.length && <form aria-label="整单包裹" data-order-action="shipment-package" onSubmit={event => { const form = new FormData(event.currentTarget);
          event.preventDefault();
          let shipmentItems;
          try { shipmentItems = items.map(item => ({ ...item, productionAllocations: readShipmentProductionAllocations(form, item.lineId, item.quantity) })); }
          catch { setError("请完整核对装箱生产来源与数量"); return; }
          void submit(event, `orders/${orderId}/shipments`, { items: shipmentItems, trackingNumber: value(form, "tracking"), carrierCode: value(form, "carrierCode"),
            carrierName: value(form, "carrierName"), carrierService: value(form, "service"), shipFromCountryCode: value(form, "country"), shipDate: iso(form, "shipDate"),
            ...(source ? { shiposSource: { supplierId: source.supplierId, recordId: source.record.id, expectedConnectionVersion: source.connectionVersion } } : {}) }, "整单包裹已保存，请核对后记录实际出库。"); }}>
          <fieldset className="oc-operation-form oc-whole-fields" disabled={disabled || shipmentBlocked}>
            <OrderShiposShipmentPicker orderId={orderId} refresh={refresh} disabled={disabled || shipmentBlocked} selectedId={source?.record.id} onSelect={bringWaybill} onClear={() => setSource(null)} />
            <input type="hidden" name="shiposSource" value={source?.record.id ?? ""} readOnly />
            <label>物流单号<input required name="tracking" maxLength={200} value={shipment.tracking} readOnly={!!source} onChange={event => changeShipment("tracking", event.target.value)} /></label>
            <label>承运商代码<input required name="carrierCode" maxLength={80} pattern="[A-Z0-9_:-]+" placeholder="例如 USPS / UPS / SF" value={shipment.carrierCode} readOnly={!!source?.carrierMapping} onChange={event => changeShipment("carrierCode", event.target.value)} /></label>
            <label>承运商名称<input required name="carrierName" maxLength={160} value={shipment.carrierName} readOnly={!!source?.carrierMapping} onChange={event => changeShipment("carrierName", event.target.value)} /></label>
            <label>物流服务<input required name="service" maxLength={160} value={shipment.service} readOnly={!!source?.carrierMapping} onChange={event => changeShipment("service", event.target.value)} /></label>
            <label>发货国家<select required name="country" value={shipment.country} onChange={event => { if (!source?.carrierMapping) changeShipment("country", event.target.value); }}><option value="">选择国家</option>
              {shipment.country && !["CN", "US", "GB", "DE", "CA", "AU"].includes(shipment.country) && <option value={shipment.country}>{shipment.country}</option>}
              {[["CN", "中国"], ["US", "美国"], ["GB", "英国"], ["DE", "德国"], ["CA", "加拿大"], ["AU", "澳大利亚"]].map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
            <label>计划发货时间<input required name="shipDate" type="datetime-local" value={shipment.shipDate} onChange={event => changeShipment("shipDate", event.target.value)} /></label>
            <ShipmentProductionFields sources={plan.shipmentSources} lines={plan.items} disabled={disabled || shipmentBlocked} onEditsChanged={onEditsChanged}
              resetKey={proposalHandoff?.formKey} initialAllocations={proposalHandoff ? shipmentSuggestion?.items ?? null : undefined} />
            {source && <label key={source.record.id} className="oc-check oc-full-field"><input type="checkbox" name="verifiedShipos" required />已核对该已有运单、承运信息和本单全部商品</label>}
            <button className="oc-button primary" disabled={!!proposalHandoff}>保存整单包裹（{plan.quantity} 件）</button>
            <FulfillmentCommandPrepareButton disabled={disabled || shipmentBlocked} />
          </fieldset></form>}
        {!!plan.shipmentIds.length && <p className={allShipped ? "oc-notice" : "oc-hint"}>{allShipped
          ? plan.platformConfirmationPending ? "整单已出库。下一步核对平台发货确认，并在下方登记依据。" : "整单已出库，平台发货确认已记录。可在下方查看物流。"
          : "本单已建立包裹。请在下方核对，并凭实际交运记录完成整单出库。"}</p>}
      </>}
    </>}
  </section>;
}
function value(form: FormData, key: string) { return String(form.get(key) ?? "").trim(); }
function iso(form: FormData, key: string) {
  const date = new Date(value(form, key)); if (!Number.isFinite(date.getTime())) throw new Error("请填写完整的发生时间"); return date.toISOString();
}
