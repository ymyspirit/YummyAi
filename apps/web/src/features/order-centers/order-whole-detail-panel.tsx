"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowRight, FileSearch, RefreshCw } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { WholeOrderDetailViewSchema, type WholeOrderDetailView } from "@yummyai/contracts/order/whole-detail";
import { pillowFactoryDeliveryProgress } from "@yummyai/contracts/order/production-delivery";
import type { OrderCenterOptions, OrderWorkspaceModule } from "@yummyai/contracts/order/workspace";
import { OrderLifecycleProgress } from "./order-lifecycle";
import { OrderWorkDetailPanel, type OrderReviewState } from "./order-work-detail";
import { OrderProductionDeliveryPanel } from "./order-production-delivery-panel";
import { OrderReviewPanel } from "./order-review-panel";
import { OrderTaskPanel } from "../business-tasks/order-task-panel";
import { centerRequest, dateTime } from "./order-center-model";
import { wholeOrderNextStep, type WholeOrderNextStep } from "./order-whole-detail-model";
import "./order-whole-detail.css";
import { returnHref } from "../navigation/workflow-href";
import { OrderExceptionPanel } from "./order-exception-panel";
import { useErpAccess } from "../identity/erp-access";
import { AgentFulfillmentEntry } from "../ai-tasks/agent-fulfillment-entry";
import { FulfillmentCommandScope, FulfillmentCommandRecovery } from "./fulfillment-command-recovery";
import { AgentFulfillmentProposalHandoff } from "../ai-tasks/agent-fulfillment-proposal-handoff";
import { orderFieldLabel, orderFieldPriority, orderFieldValue, orderProductLabel } from "./order-operations-summary";

const idle: OrderReviewState = { dirty: false, busy: false, loading: false };
const originalFieldText = (value: string) => value.trim() ? value : "未填写";
const stages: Array<[OrderWorkspaceModule, string]> = [["orders", "订单要求"], ["artwork", "审核与制图"], ["production", "生产"], ["shipments", "发货"], ["after-sales", "售后"]];
type OrderWholeDetailPanelProps = {
  id: string; module: OrderWorkspaceModule; options: OrderCenterOptions | null; editorOpen: boolean;
  onEditor(open: boolean): void; onClose(): void; onChanged(): void;
  onSelectItem(id: string, module: OrderWorkspaceModule): void;
  onStateChange(state: OrderReviewState): void; onOrderLoaded(orderId: string): void;
  review: { hasNext: boolean; onNext(): void };
};
export function OrderWholeDetailPanel(props: OrderWholeDetailPanelProps) {
  const access = useErpAccess();
  const canRead = access.canTenant(Permission.OrderRead) && access.canTenant(Permission.OrderPiiRead);
  const { onStateChange } = props;
  useEffect(() => { if (!canRead) onStateChange(idle); }, [canRead, onStateChange]);
  if (!canRead) return <section className="oc-whole-detail" aria-label="整单详情"><p role="status" className="oc-muted">当前账号缺少读取整单资料权限</p></section>;
  return <ReadableOrderWholeDetailPanel key={access.authority} {...props} />;
}
function ReadableOrderWholeDetailPanel({ id, module, options, editorOpen, onEditor, onClose, onChanged, onSelectItem, onStateChange, onOrderLoaded, review }: OrderWholeDetailPanelProps) {
  const params = useSearchParams(), requestedOrder = params.get("order"), deliveryParam = params.get("delivery"), back = returnHref(params.get("returnTo"));
  const requestedPackage = deliveryParam && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(deliveryParam) ? deliveryParam : undefined;
  const [view, setView] = useState<WholeOrderDetailView | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0), [detailRefresh, setDetailRefresh] = useState(0), [itemState, setItemState] = useState(idle), [deliveryState, setDeliveryState] = useState(idle);
  const [deliveryOpen, setDeliveryOpen] = useState(false), [deliveryLoaded, setDeliveryLoaded] = useState(false);
  const [pendingAction, setPendingAction] = useState<WholeOrderNextStep | null>(null);
  const [reviewLoaded, setReviewLoaded] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false), [exceptionState, setExceptionState] = useState(idle);
  const [fulfillmentState, setFulfillmentState] = useState({ busy: false, loading: false });
  const operation = useRef<HTMLDivElement>(null), delivery = useRef<HTMLDetailsElement>(null);
  const current = useRef(view); current.current = view;
  const previousOrder = useRef<string | null>(null);
  const dirty = itemState.dirty || deliveryState.dirty || exceptionState.dirty, busy = itemState.busy || deliveryState.busy || taskBusy || exceptionState.busy || fulfillmentState.busy;
  useEffect(() => {
    if (!pendingAction || pendingAction.lineId !== id || pendingAction.module !== module || loading || itemState.loading) return;
    if (module !== "production" && deliveryOpen && !deliveryState.dirty) { setDeliveryOpen(false); return; }
    const element = pendingAction.target
      ? operation.current?.querySelector<HTMLElement>(`[data-order-action="${pendingAction.target}"]`)
      : operation.current;
    if (!element) return;
    let details = element.closest("details");
    while (details) { details.open = true; details = details.parentElement?.closest("details") ?? null; }
    element.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    (element.querySelector<HTMLElement>("input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled])")
      ?? element.querySelector<HTMLElement>("button:not([disabled])"))?.focus({ preventScroll: true });
    setPendingAction(null);
  }, [pendingAction, id, module, loading, itemState.loading, deliveryOpen, deliveryState.dirty]);
  useEffect(() => { onStateChange({ dirty, busy, loading: loading || itemState.loading || deliveryState.loading || exceptionState.loading || fulfillmentState.loading }); }, [dirty, busy, loading, itemState.loading, deliveryState.loading, exceptionState.loading, fulfillmentState.loading, onStateChange]);
  useEffect(() => {
    const abort = new AbortController();
    if (!current.current?.items.some(item => item.line.id === id)) setView(null);
    setLoading(true); setError("");
    void centerRequest(`lines/${id}/order-detail`, undefined, abort.signal).then(value => {
      if (abort.signal.aborted) return;
      const next = WholeOrderDetailViewSchema.parse(value);
      if (previousOrder.current !== next.orderId) { const open = !!requestedPackage && requestedOrder === next.orderId; setDeliveryOpen(open); setDeliveryLoaded(open); setDeliveryState(idle); setReviewLoaded(false); }
      previousOrder.current = next.orderId;
      setView(next); onOrderLoaded(next.orderId);
    }).catch(() => { if (!abort.signal.aborted) setError("整单详情暂时无法读取，请重试。"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [id, refresh, onOrderLoaded, requestedPackage, requestedOrder]);
  function changed() { setRefresh(value => value + 1); onChanged(); }
  if (!view) return <section className="oc-whole-detail" aria-busy={loading}>
    {error ? <><p role="alert" className="oc-error">{error}</p><button className="oc-button" onClick={() => setRefresh(value => value + 1)}>重试读取整单</button></>
      : <div className="oc-whole-loading" role="status">正在读取整单商品、审核稿和履约记录…</div>}
  </section>;
  const first = view.items[0]!.line, quantity = view.items.reduce((sum, item) => sum + item.line.quantity, 0);
  const task = wholeOrderNextStep(view), disabled = busy || loading || itemState.loading;
  function nextAction() {
    if (task.section === "refresh") { setRefresh(value => value + 1); return; }
    if (task.section === "delivery") { setDeliveryLoaded(true); setDeliveryOpen(true); window.setTimeout(() => delivery.current?.scrollIntoView({ behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }), 0); return; }
    setPendingAction(task);
    onSelectItem(task.lineId, task.module);
  }
  function selectOperation(lineId: string, target: OrderWorkspaceModule) {
    setPendingAction({ ...task, lineId, module: target, target: target === task.module && lineId === task.lineId ? task.target : undefined, section: "operation" });
    onSelectItem(lineId, target);
  }
  function registerAfterSales() {
    setPendingAction({ ...task, lineId: id, module: "after-sales", target: "after-sales-create", section: "operation" });
    onSelectItem(id, "after-sales");
  }
  return <AgentFulfillmentProposalHandoff orderId={view.orderId} orderSequence={view.orderSequence}><FulfillmentCommandScope orderId={view.orderId} onChanged={() => { setDetailRefresh(value => value + 1); changed(); }} onStateChange={setFulfillmentState} returnQuery={params.toString()}>
  <section className={`oc-whole-detail${editorOpen ? " oc-whole-editor" : ""}`} aria-label="整单详情" aria-busy={loading}>
    {!editorOpen && <>
      <header className="oc-header oc-whole-header"><div><h1>{first.externalOrderId}</h1><p>{first.storeName} · {view.items.length} 商品行 · 共 {quantity} 件 · 整单制作、统一打包</p><Link href={`/logistics?orderId=${view.orderId}`}>按发货工厂准备物流面单</Link>{back && <Link className="oc-button" href={back} aria-disabled={disabled} onClick={event => { if (disabled) event.preventDefault(); }}>{back.startsWith("/business-tasks?") ? "返回业务任务" : "返回来源页面"}</Link>}</div>
        <button className="oc-button" disabled={disabled || dirty} onClick={() => { setDetailRefresh(value => value + 1); setRefresh(value => value + 1); }}><RefreshCw size={14} />刷新整单</button></header>
      <OrderLifecycleProgress status={first.orderStatus} />
      {error && <p role="alert" className="oc-error">{error} 下方为上次读取的记录。</p>}
      <div className="oc-whole-next" aria-label="整单下一步"><div><small>当前该做</small><strong>{task.title}</strong><p>{task.description}</p></div>
        <button className="oc-button primary" disabled={disabled || dirty || !!error} onClick={nextAction}>{task.action}<ArrowRight size={14} /></button></div>
      <FulfillmentCommandRecovery compact />
      <OrderExceptionPanel compact key={`exceptions:${view.orderId}`} orderId={view.orderId} focusId={params.get("exception")??undefined} refreshToken={refresh} disabled={loading||itemState.busy||itemState.dirty||deliveryState.busy||deliveryState.dirty||taskBusy} onChanged={changed} onStateChange={setExceptionState} />
      <section className="oc-whole-items" aria-label="本单全部商品与审核稿"><h2>本单全部商品与审核稿</h2>
        <p className="oc-hint">每个抱枕保留自己的定制要求和审核版本。点击商品可在下方处理。</p>
        {view.items.map((item, index) => {
          const file = item.artwork.data, summary = item.summary.data;
          const fields = summary?.fields ?? [];
          const keyFields = fields.filter(field => orderFieldPriority(field.label) <= 2)
            .toSorted((a, b) => orderFieldPriority(a.label) - orderFieldPriority(b.label));
          const otherFields = fields.filter(field => orderFieldPriority(field.label) > 2);
          return <article className={`oc-whole-item${item.line.id === id ? " selected" : ""}`} key={item.line.id}>
            <div className="oc-whole-image">{file?.preview ? <a href={file.preview.path} target="_blank" rel="noreferrer"><Image src={file.preview.path} alt={`商品 ${index + 1} 当前审核稿`} width={168} height={112} unoptimized /></a> : <span>{item.artwork.error ? "审核稿无法读取" : "暂无审核稿"}</span>}</div>
            <div className="oc-whole-requirements"><button className="oc-text-button" aria-pressed={item.line.id === id} disabled={disabled}
              onClick={() => selectOperation(item.line.id, module)}>商品行 {index + 1} · {orderProductLabel(item.line)} · {item.line.quantity} 件</button>
              <small>{item.line.skuCode ?? "未提供 SKU"} · {summary?.specification ?? item.line.specificationName ?? "规格待确认"} · {item.line.externalLineId}</small>
              {item.summary.error || summary?.error ? <p className="oc-error">{item.summary.error ?? summary?.error}</p> : <>
                {keyFields.map((field, fieldIndex) => <p key={`${field.label}:${fieldIndex}`}><b title={field.label}>{orderFieldLabel(field.label, field.value)}：</b><span title={field.value}>{originalFieldText(orderFieldValue(field.value))}</span></p>)}
                {(otherFields.length > 0 || summary?.instructions) && <details className="oc-original-title oc-review-reference">
                  <summary>其他定制信息与原始说明{otherFields.length > 0 ? ` · ${otherFields.length} 项` : ""}</summary>
                  {otherFields.map((field, fieldIndex) => <p className="oc-hint" key={`${field.label}:${fieldIndex}`}><b>{field.label || "未命名定制项"}：</b>{originalFieldText(field.value)}</p>)}
                  {summary?.instructions && <p className="oc-hint"><b>制作说明：</b>{originalFieldText(summary.instructions)}</p>}
                </details>}
              </>}
              <details className="oc-original-title"><summary>平台原商品标题</summary><p>{item.line.title}</p></details>
              {item.line.held && <p className="oc-error">已暂停，请先核对原因</p>}
              {item.line.archivedAt && <p className="oc-notice">已归档，保留历史</p>}
            </div>
            <div className="oc-whole-artwork">{item.artwork.error ? <p className="oc-error">{item.artwork.error}</p> : file ? <>
              <strong>当前稿 V{file.versionNumber} · {file.approved ? "已审核" : "待审核"}</strong>
              {!file.approved && file.approvedVersionNumber && <small>原审核稿 V{file.approvedVersionNumber}，当前稿需重新核对</small>}
              {file.productionFile ? <a download className="oc-file-link" href={file.productionFile.path}>下载已审核正式文件</a> : <small>{file.productionPending ? "正式文件生成中" : "正式文件尚未准备好"}</small>}
            </> : <small>尚未建立制作稿</small>}
              <button className="oc-button" disabled={disabled} onClick={() => selectOperation(item.line.id, "artwork")}>查看本件审核与制图</button>
            </div>
          </article>;
        })}
      </section>
      <details ref={delivery} className="oc-whole-records" open={deliveryOpen} onToggle={event => { setDeliveryOpen(event.currentTarget.open); if (event.currentTarget.open) setDeliveryLoaded(true); }}>
        <summary>工厂交付与回执{view.production.data?.length ? ` · ${view.production.data.length} 个生产记录` : ""}</summary>
        {view.production.error && <p role="alert" className="oc-error">{view.production.error}</p>}
        <p className="oc-hint">工厂主跟进为已排产与已发货 真实文件提交后默认显示已排产 在下方导入 Excel／CSV 核对原交付整组 收到 接受与异常回执按需补充</p>
        {view.production.data?.map(record => <p className="oc-hint" key={record.productionOrder.id}><strong>{record.factoryPin?.factoryProfile.name ?? "具体工厂待确认"} · 工厂跟进 {record.deliveryReceipt?.factoryErp?.bindingReleased ? receiptLabel(record.deliveryReceipt.status) + "（旧表格关联已解除 历史保留）" : record.deliveryReceipt?.factoryErp ? (record.deliveryReceipt.factoryErp.status === "shipped" ? "工厂已发货" : record.deliveryReceipt.factoryErp.status === "scheduled" ? "已排产" : "状态待核对") + "（工厂表格）" + (record.deliveryReceipt.factoryErp.exception ? " · 作废异常待核对" : "") : record.deliveryReceipt ? receiptLabel(record.deliveryReceipt.status) : "待提交"}</strong> · 计划完工 {dateTime(record.productionOrder.expectedCompletionAt)}</p>)}
        {deliveryLoaded && options && <div inert={itemState.dirty || itemState.busy || taskBusy || exceptionState.dirty || exceptionState.busy}><OrderProductionDeliveryPanel key={view.orderId} line={null} orderId={view.orderId} focusPackageId={requestedOrder === view.orderId ? requestedPackage : undefined} orderItems={view.items.map(item => ({ id: item.line.id, quantity: item.line.quantity, title: item.line.title }))} refreshToken={refresh} factories={options.factories} onChanged={() => { setDetailRefresh(value => value + 1); changed(); }} onStateChange={setDeliveryState} onSelectItem={lineId => selectOperation(lineId, "production")} /></div>}
        {deliveryLoaded && itemState.dirty && <p className="oc-hint">请先保存下方本件商品的修改，再登记工厂回执。</p>}
        {!options && <p className="oc-error">工厂选项暂不可用，请重新读取。</p>}
      </details>
      <section className="oc-whole-records" aria-label="本单运单"><h2>本单运单</h2>
        {view.shipments.error && <p role="alert" className="oc-error">{view.shipments.error}</p>}
        {view.shipments.data?.map(record => {
          const version = record.versions.find(version => version.versionNumber === record.shipment.currentVersionNumber);
          const packages = record.packages.filter(packet => packet.shipmentVersionId === version?.id);
          return <div className="oc-whole-waybill" key={record.shipment.id}>
            <strong>{record.physicalHandover?.allDispatched ? "已实际交运" : record.shipment.approvedVersionNumber === record.shipment.currentVersionNumber ? "包裹已审核，待实际交运" : "包裹待审核"}</strong>
            {packages.map(packet => <p key={packet.id}>{packet.carrierName} · <b>{packet.trackingNumber}</b> · {record.packageLines.filter(line => line.packageId === packet.id).reduce((sum, line) => sum + line.quantity, 0)} 件</p>)}
            <small>计划发货 {dateTime(version?.shipDate ?? null)} · {record.manualConfirmations?.some(item => item.shipmentVersionId === version?.id) ? "已登记平台确认" : "平台确认尚未登记"}</small>
            {version?.shiposSource && <p className="oc-hint">来源：ShipOS 已有运单 · 查询于 {dateTime(version.shiposSource.fetchedAt)}{version.shiposSource.labelAvailable && <a download className="oc-file-link" href={`/api/shipos/${version.shiposSource.supplierId}/records/${version.shiposSource.recordId}/label`}>下载对应现有面单</a>}</p>}
          </div>;
        })}
        {!view.shipments.error && !view.shipments.data?.length && <p className="oc-hint">尚未保存整单包裹。</p>}
        {view.shipos.error && <p role="alert" className="oc-error">{view.shipos.error}</p>}
        {view.shipos.data?.map(item => <div className="oc-whole-waybill" key={item.record.id}><strong>ShipOS 已同步记录 · {item.supplierName}</strong><p>{item.record.trackingNumber ?? "未返回运单号"} · {item.record.channel ?? "未返回物流渠道"}</p><small>查询时间 {dateTime(item.record.fetchedAt)} · {item.carrierMapping ? `${item.carrierMapping.carrierName} · ${item.carrierMapping.carrierService}` : "承运信息待核对填写"}</small>{item.blockers.map(reason => <p key={reason} className="oc-error">{reason}</p>)}{item.record.labelAvailable && item.record.match === "matched" && <a download className="oc-file-link" href={`/api/shipos/${item.supplierId}/records/${item.record.id}/label`}>下载现有面单</a>}</div>)}
        <button className="oc-button" disabled={disabled} onClick={() => selectOperation(id, "shipments")}>在本面板处理发货</button>
      </section>
      <section className="oc-whole-records" aria-label="本单售后问题"><div className="oc-whole-heading"><h2>本单售后</h2><button className="oc-button" disabled={disabled || dirty} onClick={registerAfterSales}>登记本单售后问题</button></div>
        {view.cases.error && <p role="alert" className="oc-error">{view.cases.error}</p>}
        {view.cases.data && <p className="oc-hint">{view.cases.data.filter(record => !["resolved", "cancelled"].includes(record.case.status)).length} 个未结案问题 · 已结案记录继续保留</p>}
      </section>
      <nav className="oc-whole-stages" aria-label="本单操作">{stages.map(([target, name]) => <button className="oc-button" key={target} aria-current={target === module ? "step" : undefined} disabled={disabled} onClick={() => selectOperation(id, target)}>{name}</button>)}</nav>
    </>}
    {deliveryState.dirty && <p className="oc-hint">请先登记或清空工厂回执，再操作下方商品与发货表单。</p>}
    <div ref={operation} className="oc-whole-operation" inert={deliveryState.dirty || deliveryState.busy || taskBusy || exceptionState.dirty || exceptionState.busy}>
      <OrderWorkDetailPanel key={`${id}:${module}`} id={id} module={module} options={options} editorOpen={editorOpen} onEditor={onEditor} onBack={onClose} onChanged={changed} refreshToken={detailRefresh} unified onSelectItem={selectOperation}
        onModuleChange={target => selectOperation(id, target)} review={{ hasNext: review.hasNext, autoAdvance: false, onStateChange: setItemState, onNext: review.onNext, onSavedNext: () => undefined }} />
    </div>
    {!editorOpen && <section className="oc-whole-follow-up" aria-label="任务与高级核查">
      <OrderTaskPanel key={view.orderId} lineId={id} refreshToken={refresh} disabled={dirty || itemState.busy || deliveryState.busy || loading || !!error} onBusyChange={setTaskBusy} onChanged={() => { setDetailRefresh(value => value + 1); changed(); }} />
      <details className="oc-whole-records oc-whole-advanced" key={`advanced:${view.orderId}`}>
        <summary><FileSearch size={15} aria-hidden="true" />高级履约核查</summary>
        <p className="oc-hint">需要核对原来源、读取权限与执行依据时展开</p>
        {!loading && !error && <AgentFulfillmentEntry key={`fulfillment:${view.orderId}:${view.orderSequence}`} orderId={view.orderId} expectedSequence={view.orderSequence} />}
      </details>
      <details className="oc-whole-records" key={`review:${view.orderId}`} onToggle={event => { if (event.currentTarget.open) setReviewLoaded(true); }}>
        <summary>履约与利润复盘</summary>
        {reviewLoaded && <OrderReviewPanel key={view.orderId} lineId={id} refreshToken={refresh} />}
      </details>
    </section>}
  </section></FulfillmentCommandScope></AgentFulfillmentProposalHandoff>;
}
function receiptLabel(status: Parameters<typeof pillowFactoryDeliveryProgress>[0]) {
  const progress = pillowFactoryDeliveryProgress(status);
  const original = { pending: "待运营提交", submitted: "已提交工厂 ERP", received: "工厂已收到文件", accepted: "工厂接受文件", rejected: "工厂拒收文件", rework: "返工跟进" }[status];
  return progress.label + (progress.basis === "submission_default" ? "（按提交默认）" : "") + " · 原回执 " + original;
}
