"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  OrderOperationsViewSchema,
  type OrderOperationsView,
  type OrderWorkDetail,
  type OrderCenterOptions,
  type OrderWorkspaceModule,
} from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import { centerRequest, dateTime, label, OrderCenterRequestError, orderCommandUncertain } from "./order-center-model";
import { AfterSalesAssist } from "../ai-assist/business-assist";
import { formFingerprint, useFormEdits } from "../navigation/use-form-edits";
import type { OrderReviewState } from "./order-work-detail";
import { currentProductionRender } from "./order-artwork-review-model";
import { OrderWholeFulfillmentPanel } from "./order-whole-fulfillment-panel";
import { QualityAssessmentFields, readQualityAssessmentForm } from "./quality-assessment-fields";
import { ShipmentSourceEditor } from "./shipment-source-editor";
import { ShipmentCreateForm } from "./shipment-create-form";
import { QualityGroupsPanel } from "./quality-groups-panel";
import { ProductionManufacturingFields, readProductionManufacturingSelection } from "./production-manufacturing-fields";
import { OrderSingleProductionPanel } from "./order-single-production-panel";
import { PrepareProductionCommandSchema } from "@yummyai/contracts/order/production-command";
import { ProductionCommandRecovery, submitProductionCommand } from "./production-command-recovery";
import { ProductionMaterialPanel } from "./production-material-panel";
import { ProductionCapacityPicker, ProductionCapacityReceipt, readProductionCapacitySelection } from "./production-capacity-picker";
import { capacityLocalInstant } from "./production-capacity-api";
import { ProductionStopWorkspace } from "./production-stop-workspace";
import { FulfillmentCommandPrepareButton, useFulfillmentCommandScope } from "./fulfillment-command-recovery";
import { fulfillmentCommandForOperation } from "./fulfillment-command-intent";
import { useAgentFulfillmentProposalHandoff, agentFulfillmentProposalInputFor, agentFulfillmentProposalLocalTime } from "../ai-tasks/agent-fulfillment-proposal-handoff";

const nextMilestones: Record<string, Array<[string, string]>> = {
  planned: [["submitted", "记录已发送工厂"]],
  submitted: [["acknowledged", "记录工厂已接单"]],
  acknowledged: [["started", "记录开始生产"]],
  in_production: [["completed", "记录生产完工"]],
  cancel_requested: [["cancelled", "记录工厂已确认停单"], ["started", "记录剩余生产继续"], ["completed", "记录剩余实物完工"]],
};
type OperationIntent = { path: string; input: Record<string, unknown>; success: string; form?: HTMLFormElement; fingerprint?: string; prepareOnly?: boolean };
export function OrderOperationsPanel({
  module,
  detail,
  editor,
  loading = false,
  options,
  onChanged,
  onStateChange,
  onCompleted,
  onPrepareProduction,
  onSelectItem,
  refreshToken = 0,
}: {
  module: OrderWorkspaceModule;
  detail: OrderWorkDetail;
  editor: ProductionEditorDetailView | null;
  loading?: boolean;
  options: OrderCenterOptions;
  onChanged: () => void;
  onStateChange?: (state: OrderReviewState) => void;
  onCompleted?: () => void;
  onPrepareProduction?: () => void;
  onSelectItem?: (lineId: string, module: "artwork" | "shipments") => void;
  refreshToken?: number;
}) {
  const fulfillment = useFulfillmentCommandScope();
  const proposalHandoff = useAgentFulfillmentProposalHandoff();
  const [records, setRecords] = useState<OrderOperationsView | null>(null),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [working, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [wholeReading, setWholeReading] = useState(false);
  const [shipmentCreateReading, setShipmentCreateReading] = useState(false);
  const [materialReading, setMaterialReading] = useState<Record<string, boolean>>({});
  const materialBusy = Object.values(materialReading).some(Boolean);
  const onMaterialBusy = useCallback((productionId: string, value: boolean) => setMaterialReading(previous => previous[productionId] === value ? previous : { ...previous, [productionId]: value }), []);
  const [pendingIntent, setPendingIntent] = useState<OperationIntent | null>(null);
  const [recoveryBlocked, setRecoveryBlocked] = useState(true), [recoveryRefresh, setRecoveryRefresh] = useState(0);
  const [remakeReady, setRemakeReady] = useState<Record<string, boolean>>({});
  const [capacityReady, setCapacityReady] = useState<Record<string, boolean>>({}), [remakeDue, setRemakeDue] = useState<Record<string, string>>({});
  const sending = useRef(false);
  const [showClosedCases, setShowClosedCases] = useState(false);
  const forms = useFormEdits();
  const requestedCase = useSearchParams().get("case"), focusedCase = useRef("");
  useEffect(() => {
    if (module !== "after-sales" || !records || !requestedCase || forms.dirty) return;
    const match = records.cases.find(record => record.case.id === requestedCase);
    if (!match) return;
    if (["resolved", "cancelled"].includes(match.case.status) && !showClosedCases) { setShowClosedCases(true); return; }
    const key = detail.line.id + ":" + requestedCase;
    if (focusedCase.current === key) return;
    const target = document.getElementById("case-" + requestedCase);
    if (target) { focusedCase.current = key; target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }
  }, [module, records, requestedCase, showClosedCases, detail.line.id, forms.dirty]);
  const coordinatedModule = module === "production" || module === "shipments";
  const fulfillmentBlocked = coordinatedModule && (!fulfillment || fulfillment.orderId !== detail.line.orderId || fulfillment.blocked || fulfillment.busy);
  const operationBusy = working || loading || reading || wholeReading || shipmentCreateReading || pendingIntent !== null || module === "production" && recoveryBlocked || fulfillmentBlocked;
  const busy = operationBusy || materialBusy;
  useEffect(() => {
    onStateChange?.({ busy: working || pendingIntent !== null, loading: reading || wholeReading || shipmentCreateReading || materialBusy, dirty: forms.dirty });
  }, [working, reading, wholeReading, shipmentCreateReading, materialBusy, forms.dirty, onStateChange, pendingIntent]);
  const retries = useRef(new Map<string, string>()),
    id = detail.line.id;
  const suggestedRecovery = proposalHandoff?.suggestion?.original.kind === "production_recovery" ? proposalHandoff.suggestion.original : null;
  const suggestedTimeZone = records?.production.find(row => row.productionOrder.id === suggestedRecovery?.targetId)?.factoryPin?.factoryProfile.timeZone;
  useEffect(() => {
    if (!proposalHandoff?.formKey) return;
    setRemakeDue(suggestedRecovery && suggestedTimeZone ? { [suggestedRecovery.targetId]: agentFulfillmentProposalLocalTime(suggestedRecovery.input.expectedCompletionAt, suggestedTimeZone) } : {});
    setRemakeReady({}); setCapacityReady({});
  }, [proposalHandoff?.formKey, suggestedRecovery, suggestedTimeZone]);
  useEffect(() => {
    if (!["production", "shipments", "after-sales"].includes(module)) return;
    const abort = new AbortController();
    setReading(true); setError("");
    void centerRequest(`lines/${id}/operations`, undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setRecords(OrderOperationsViewSchema.parse(value));
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          setRecords(null);
          if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) { setPendingIntent(null); retries.current.clear(); }
          setError(cause instanceof Error ? cause.message : "业务记录读取失败");
        }
      }).finally(() => { if (!abort.signal.aborted) setReading(false); });
    return () => abort.abort();
  }, [id, module, refresh, refreshToken]);
  if (!["production", "shipments", "after-sales"].includes(module)) return null;
  async function send(intent: OperationIntent) {
    if (sending.current) return false;
    sending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const durable = module === "production" && /^(lines|orders)\/[^/]+\/release$/.test(intent.path);
    const coordinated = coordinatedModule && !durable;
    if (durable) setRecoveryBlocked(true);
    try {
      if (durable) await submitProductionCommand(PrepareProductionCommandSchema.parse({
        kind: intent.path.startsWith("lines/") ? "reviewed_line" : "reviewed_order", targetId: intent.path.split("/")[1], input: intent.input,
      }));
      else if (coordinated) {
        if (!fulfillment || fulfillment.orderId !== detail.line.orderId) throw new Error("请从原整单重新读取本次履约恢复依据");
        const shipmentId = intent.path.startsWith("shipments/") ? intent.path.split("/")[1] : null;
        const record = records?.shipments.find(item => item.shipment.id === shipmentId);
        const versionId = record?.versions.find(version => version.versionNumber === record.shipment.currentVersionNumber)?.id;
        const command = fulfillmentCommandForOperation(intent.path, intent.input, { orderId: detail.line.orderId, lineId: detail.line.id, versionId });
        if (!command) throw new Error("这项原操作尚未注册持久履约恢复 未发送业务写入");
        if (intent.prepareOnly) {
          await fulfillment.prepareAgent(command);
          setPendingIntent(null);
          if (intent.form?.isConnected && intent.fingerprint) forms.commit(intent.form, intent.fingerprint);
          setNotice("本次只交接原填写 未请求执行业务 请到 AI 工作台核对后逐笔明确执行");
          return false;
        }
        await fulfillment.submit(command);
      } else await centerRequest(intent.path, intent.input);
      setPendingIntent(null);
      if (intent.form?.isConnected && intent.fingerprint) forms.commit(intent.form, intent.fingerprint);
      setNotice(intent.success);
      setRefresh((value) => value + 1);
      onChanged();
      return true;
    } catch (cause) {
      setPendingIntent(!durable && !coordinated && orderCommandUncertain(cause) ? intent : null);
      if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) { setRecords(null); retries.current.clear(); }
      setError((cause instanceof Error ? cause.message : "操作未完成") + (coordinated ? " 请在本单原履约提交恢复区读取原结果 不重复发送" : ""));
      return false;
    } finally {
      sending.current = false;
      setBusy(false);
      if (durable) setRecoveryRefresh(value => value + 1);
    }
  }
  async function run(path: string, payload: Record<string, unknown>, success: string, form?: HTMLFormElement, fingerprint?: string, prepareOnly = false) {
    if (proposalHandoff && !prepareOnly) throw new Error("当前为原提案补项 请明确点击只准备交由 Agent 核对 不直接执行业务");
    if (pendingIntent) { setError("请先恢复本次提交结果 再进行其他操作"); return false; }
    const section = module === "production" ? "production" : module === "shipments" ? "shipments" : "cases";
    if (!records || records.readErrors[section]) { setError(records?.readErrors[section] ?? "业务记录尚未读取，请先重试读取。"); return false; }
    const signature = JSON.stringify([path, payload]), key = proposalHandoff?.slotId || retries.current.get(signature) || crypto.randomUUID();
    retries.current.set(signature, key);
    return send({ path, input: structuredClone(path.endsWith("/milestones") ? { ...payload, externalEventId: key } : { ...payload, idempotencyKey: key }), success, form, fingerprint, prepareOnly });
  }
  async function submit(
    event: FormEvent<HTMLFormElement>,
    path: string,
    build: (form: FormData) => Record<string, unknown>,
    success: string,
    advance = true,
  ) {
    event.preventDefault();
    if (busy || reading) return;
    const element = event.currentTarget;
    const prepareOnly = (event.nativeEvent as SubmitEvent).submitter?.getAttribute("data-agent-fulfillment-prepare") === "true";
    if (prepareOnly && (!coordinatedModule || /^(lines|orders)\/[^/]+\/release$/.test(path) || !fulfillment?.canPrepareAgent)) return;
    const submitted = formFingerprint(element);
    try {
      if (await run(path, build(new FormData(element)), success, element, submitted, prepareOnly)) {
        if (!forms.commit(element, submitted) && advance) onCompleted?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请检查填写内容");
    }
  }
  const productionRender = editor ? currentProductionRender(editor) : null;
  const productionPending = productionRender?.status === "queued" || productionRender?.status === "processing";
  const closedCases = records?.cases.filter(record => ["resolved", "cancelled"].includes(record.case.status)) ?? [];
  const openCases = records?.cases.filter(record => !["resolved", "cancelled"].includes(record.case.status)) ?? [];
  return (
    <section className="oc-section oc-operations" ref={forms.ref} onInput={forms.check} onChange={forms.check}>
      <div role="status" className="oc-notice oc-command-recovery" hidden={!pendingIntent}><p>本次提交结果待核对 已保留原内容与请求编号 核对前暂停新操作</p>
        <button className="oc-button" type="button" disabled={working || !pendingIntent} onClick={() => { if (pendingIntent) void send(pendingIntent); }}>恢复本次提交结果</button></div>
      <button className="oc-text-button" type="button" disabled={busy} title="重新读取当前商品进度 保留当前填写" onClick={() => setRefresh(value => value + 1)}>重新核对业务记录</button>
      <h2>
        {module === "production"
          ? "生产任务与质检"
          : module === "shipments"
            ? "包裹与物流"
            : "售后处理"}
      </h2>
      {error && (
        <p className="oc-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="oc-notice" role="status">
          {notice}
        </p>
      )}
      {(error || Object.values(records?.readErrors ?? {}).some(Boolean)) && <div className="oc-read-errors">
        {Object.entries(records?.readErrors ?? {}).filter(([, message]) => !!message).map(([section, message]) => <p key={section} className="oc-error" role="alert">{message}</p>)}
        <button className="oc-button" type="button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>重新读取业务记录</button>
      </div>}
      {module === "production" && (
        <>
          <ProductionCommandRecovery key={detail.line.orderId} orderId={detail.line.orderId} refresh={`${refresh}:${refreshToken}:${recoveryRefresh}`} onBlocked={setRecoveryBlocked}
            onDenied={() => { setRecords(null); setPendingIntent(null); }} onSucceeded={() => { setNotice("原生产安排已核对 并保留提交回执"); setRefresh(value => value + 1); onChanged(); }} />
          <OrderWholeFulfillmentPanel orderId={detail.line.orderId} module="production" refresh={`${refresh}:${refreshToken}:${detail.line.revision}:${detail.line.projectionVersion}`} busy={working || loading || reading || pendingIntent !== null || recoveryBlocked || fulfillmentBlocked} options={options} onReading={setWholeReading} onEditsChanged={forms.check} onSelectItem={onSelectItem} onSubmit={(event, path, payload, success) => submit(event, path, () => payload, success, false)} />
          {detail.line.artwork === "approved" && !productionRender?.files.length && !productionPending && onPrepareProduction && <button type="button" className="oc-button" disabled={busy || detail.line.held || !editor} onClick={onPrepareProduction}>{productionRender?.status === "failed" ? "重试生成本商品生产文件" : "补齐本商品生产文件"}</button>}
          <OrderSingleProductionPanel key={id} detail={detail} editor={editor} refresh={`${refresh}:${refreshToken}:${detail.line.projectionVersion}`} disabled={busy || !records || !!records.readErrors.production}
            onRefresh={onChanged} onSubmit={(event, path, payload, success) => submit(event, path, () => payload, success, false)} />
          <details className="oc-production-history"><summary>查看本商品生产记录与异常处理</summary>
          {records?.production.map((record) => {
            const production = record.productionOrder,
              version = record.versions.find(
                (row) => row.versionNumber === production.currentVersionNumber,
              ),
              inspection = record.inspections[0];
            return (
              <article className="oc-record" key={production.id} id={`production-${production.id}`}>
                <div className="oc-record-header">
                  <strong>
                    {record.factoryPin?.factoryProfile.name ?? "具体工厂待确认"}{" "}
                    · {version?.quantity ?? "—"} 件
                  </strong>
                  <span className="oc-badge">
                    {label(production.status)}
                    {production.status === "completed"
                      ? ` · ${inspection?.result === "passed" ? "质检通过" : "待质检"}`
                      : ""}
                  </span>
                </div>
                <p className="oc-hint">
                  {record.factoryPin?.supplierName ?? options.suppliers.find(supplier => supplier.id === production.supplierId)?.name ?? "供应商"} · 生产单：{production.id} · 计划完工：{record.factoryPin?.factoryProfile.timeZone ? `${capacityLocalInstant(production.expectedCompletionAt, record.factoryPin.factoryProfile.timeZone)} ${record.factoryPin.factoryProfile.timeZone}` : `${production.expectedCompletionAt}（原工厂时区未知）`}
                </p>
                {!record.factoryPin && <p className="oc-error">历史生产单未确认具体工厂，无法生成新交付包。请核对实际生产地点后重新安排生产，原记录会保留。</p>}
                <p className="oc-hint">{version?.manufacturing ? `制造 ${version.manufacturing.code} V${version.manufacturing.versionNumber} · 原规格已固定 · ${version.manufacturing.quantity} ${({ each: "件", pair: "双", set: "套" })[version.manufacturing.unit]}` : "历史生产未固定制造版本 原记录保留 不按今天的 BOM 补写"}</p>
                <ProductionMaterialPanel productionOrderId={production.id} currentBindingId={version?.manufacturing?.id ?? null}
                  bindings={record.versions.flatMap(row => row.manufacturing ? [{ id: row.manufacturing.id, versionNumber: row.versionNumber, label: `${row.manufacturing.code} V${row.manufacturing.versionNumber}` }] : [])}
                  refresh={`${refresh}:${refreshToken}:${production.projectionVersion}`} disabled={operationBusy} onEditsChanged={forms.check} onBusyChange={onMaterialBusy}
                  onSaved={message => { setNotice(message); setRefresh(value => value + 1); onChanged(); }} />
                {version?.sourceEditorProjectId && version.sourceRenderId && !record.deliveryReceipt && (
                  <a
                    className="oc-file-link"
                    href={`/api/production-editor/projects/${version.sourceEditorProjectId}/renders/${version.sourceRenderId}/files/result`}
                  >
                    下载本次下达的生产文件
                  </a>
                )}
                <ol className="oc-record-history">
                  {record.milestones.map((milestone) => (
                    <li key={milestone.id}>
                      {label(milestone.type)} · {dateTime(milestone.occurredAt)} ·{" "}
                      {milestone.evidenceCode}
                    </li>
                  ))}
                  {record.inspections.map((item) => (
                    <li key={item.id}>
                      质检{item.result === "passed" ? "通过" : "不通过"} · {item.scoreBps / 100} 分
                      · {dateTime(item.inspectedAt)}
                      <small>{item.assessmentVersion === 3 ? "实物分组核验已记录 · 原生产依据 V" + item.productionProjectionVersion : item.assessmentVersion === 2 ? "逐项核验已记录 · 原生产依据 V" + item.productionProjectionVersion : "历史总分记录 未记录逐项核验"}</small>
                      {item.criterionResults && <ul>{item.criterionResults.map(check => <li key={check.code}>{options.standards.find(standard => standard.id === item.qualityStandardVersionId)?.criteria.find(criterion => criterion.code === check.code)?.label ?? check.code} · {check.scoreBps / 100} 分 · {check.passed ? "通过" : "未通过"}</li>)}</ul>}
                      {record.defects.filter(defect => defect.inspectionId === item.id).map(defect => <small key={defect.id}>
                        {defect.code} · {label(defect.severity)} · 责任{defect.responsibility ? label(defect.responsibility) : "尚未读取"} · {label(defect.disposition)} · {defect.affectedQuantity === null ? "影响数量未记录" : "影响 " + defect.affectedQuantity + " 件"}
                      </small>)}
                    </li>
                  ))}
                </ol>
                {(nextMilestones[production.status] ||
                  !["completed", "cancelled", "cancel_requested"].includes(production.status)) && (
                  <form
                    key={proposalHandoff?.formKey}
                    className="oc-operation-form"
                    onSubmit={(event) => {
                      const action =
                        (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ?? "";
                      void submit(
                        event,
                        `production/${production.id}/milestones`,
                        (form) => ({
                          type: action,
                          expectedProjectionVersion: production.projectionVersion,
                          externalEventId: null,
                          evidence: {
                            code: text(form, "reference"),
                            note: text(form, "note"),
                            assetIds: [],
                          },
                          occurredAt: iso(form, "occurredAt"),
                        }),
                        "生产进度已记录。",
                      );
                    }}
                  >
                    <label>
                      凭证 / 工厂记录编号
                      <input
                        required
                        name="reference"
                        defaultValue={agentFulfillmentProposalInputFor(proposalHandoff, "production_milestone", production.id)?.evidence?.code}
                        maxLength={160}
                        pattern="[A-Z0-9_:-]+"
                        placeholder="例如 FACTORY_ACK_001"
                      />
                    </label>
                    <label>
                      发生时间
                      <input required type="datetime-local" step="0.001" name="occurredAt" defaultValue={agentFulfillmentProposalLocalTime(agentFulfillmentProposalInputFor(proposalHandoff, "production_milestone", production.id)?.occurredAt)} />
                    </label>
                    <label>
                      备注
                      <input name="note" maxLength={2000} defaultValue={agentFulfillmentProposalInputFor(proposalHandoff, "production_milestone", production.id)?.evidence?.note ?? ""} />
                    </label>
                    {production.status === "cancel_requested" && <p className="oc-hint oc-full-field">部分停做后 依据实际数量核准继续记录剩余实物</p>}
                    <div className="oc-actions">
                      {(nextMilestones[production.status] ?? []).filter(([action]) => !record.deliveryReceipt || !["submitted", "acknowledged"].includes(action)).map(([action, name]) => (
                        <span key={action} className="oc-actions">
                        <button
                          className="oc-button primary"
                          key={action}
                          value={action}
                          disabled={busy || !!proposalHandoff || action === "started" && !!record.deliveryReceipt && record.deliveryReceipt.status !== "accepted"}
                        >
                          {name}
                        </button>
                        <FulfillmentCommandPrepareButton value={action} disabled={busy || action === "started" && !!record.deliveryReceipt && record.deliveryReceipt.status !== "accepted"} />
                        </span>
                      ))}
                      {record.deliveryReceipt && ["planned", "submitted"].includes(production.status) && <a className="oc-button" href="#pillow-delivery">在交付包中登记工厂回执</a>}
                      {!["completed", "cancelled", "cancel_requested"].includes(
                        production.status,
                      ) && (
                        <span className="oc-actions"><button className="oc-button" value="cancel_requested" disabled={busy || !!proposalHandoff}>
                          记录停单申请
                        </button><FulfillmentCommandPrepareButton value="cancel_requested" disabled={busy} /></span>
                      )}
                    </div>
                  </form>
                )}
                {["completed", "quality_hold"].includes(production.status) && (
                  <details>
                    <summary>登记质检结果</summary>
                    <form
                      className="oc-operation-form"
                      onSubmit={(event) =>
                        void submit(
                          event,
                          `production/${production.id}/inspections`,
                          (form) => {
                            const quality = readQualityAssessmentForm(form);
                            return {
                              qualityStandardVersionId: text(form, "standard"),
                              ...quality,
                              expectedProductionProjectionVersion: Number(form.get("qualityProjection")),
                              inspectedAt: iso(form, "time"),
                              evidenceAssetIds: [],
                            };
                          },
                          "质检结果已保存。",
                        )
                      }
                    >
                      <QualityAssessmentFields key={proposalHandoff?.formKey} standards={options.standards} projectionVersion={production.projectionVersion} disabled={busy} submitLabel="保存质检结果" allowAgentPrepare
                        suggestion={agentFulfillmentProposalInputFor(proposalHandoff, "quality_inspection", production.id)} />
                    </form>
                  </details>
                )}
                <ProductionCapacityReceipt productionOrderId={production.id} refresh={`${refresh}:${refreshToken}:${production.projectionVersion}`} />
                <ProductionStopWorkspace productionOrderId={production.id} refresh={`${refresh}:${refreshToken}:${production.projectionVersion}`} disabled={operationBusy}
                  onChanged={() => { setRefresh(value => value + 1); onChanged(); }} />
                {["completed", "quality_hold"].includes(production.status) && <QualityGroupsPanel key={proposalHandoff ? `${production.id}:${proposalHandoff.formKey}` : production.id} productionOrderId={production.id} lineId={id} factoryPin={record.factoryPin}
                  standards={options.standards} refresh={`${refresh}:${refreshToken}:${production.projectionVersion}`} disabled={busy} onEditsChanged={forms.check}
                  onSaved={(form, fingerprint, message) => { forms.commit(form, fingerprint); setNotice(message); setRefresh(value => value + 1); onChanged(); }} />}
                {production.status === "quality_hold" && record.inspections[0]?.assessmentVersion !== 3 && (
                  <details>
                    <summary>安排补做</summary>
                    <form
                      key={proposalHandoff?.formKey}
                      className="oc-operation-form"
                      onSubmit={(event) =>
                        void submit(
                          event,
                          "recoveries",
                          (form) => {
                            if (!remakeReady[production.id] || !capacityReady[production.id] || !record.factoryPin || !version) throw new Error("请先核对本次补做的原工厂 固定生产版本 制造版本 数量单位与共享产能");
                            return {
                            type: "remake",
                            originalProductionOrderId: production.id,
                            remakeQuantity: version.quantity,
                            reason: text(form, "reason"),
                            ...readProductionCapacitySelection(form, production.id, { factoryVersionId: record.factoryPin.factoryVersionId, capabilityVersionId: record.factoryPin.capabilityVersionId, quantity: version.quantity }),
                            manufacturing: readProductionManufacturingSelection(form),
                            };
                          },
                          "已创建关联原生产单的补做任务。",
                        )
                      }
                    >
                      <ProductionManufacturingFields lineId={id} originalProductionOrderId={production.id} disabled={busy}
                        onReadinessChange={ready => setRemakeReady(current => current[production.id] === ready ? current : { ...current, [production.id]: ready })} />
                      <label>
                        补做原因
                        <input required name="reason" defaultValue={agentFulfillmentProposalInputFor(proposalHandoff, "production_recovery", production.id)?.reason} />
                      </label>
                      <label>
                        补做工厂当地预计完成
                        <input required name="time" type="datetime-local" value={remakeDue[production.id] ?? ""} onChange={event => setRemakeDue(current => ({ ...current, [production.id]: event.target.value }))} />
                      </label>
                      {record.factoryPin && version ? <ProductionCapacityPicker factoryId={record.factoryPin.factoryId} items={[{ reference: production.id, factoryVersionId: record.factoryPin.factoryVersionId, capabilityVersionId: record.factoryPin.capabilityVersionId, quantity: version.quantity, dueLocal: remakeDue[production.id] ?? "" }]}
                        basisKey={`${production.id}:${version.id}:${production.projectionVersion}:${remakeReady[production.id]}`} disabled={busy}
                        onReady={ready => setCapacityReady(current => current[production.id] === ready ? current : { ...current, [production.id]: ready })} />
                        : <p className="oc-error">原生产没有可读取的固定工厂与能力 当前不能安排新补做</p>}
                      <button className="oc-button" disabled={busy || !!proposalHandoff || !remakeReady[production.id] || !capacityReady[production.id] || !record.factoryPin || !version}>
                        创建补做任务
                      </button>
                      <FulfillmentCommandPrepareButton disabled={busy || !remakeReady[production.id] || !capacityReady[production.id] || !record.factoryPin || !version} />
                    </form>
                  </details>
                )}
              </article>
            );
          })}
          </details>
          <p className="oc-hint">质检标准在 <Link href="/settings/fulfillment">履约配置</Link> 维护；已有检验继续使用固定版本。</p>
        </>
      )}
      {module === "shipments" && (
        <>
          <ShipmentCreateForm orderId={detail.line.orderId} lineId={detail.line.id} refresh={`${refresh}:${refreshToken}:${detail.line.revision}:${detail.line.projectionVersion}`}
            disabled={working || loading || reading || wholeReading || pendingIntent !== null || fulfillmentBlocked} onReading={setShipmentCreateReading} onEditsChanged={forms.check}
            onSubmit={(event, path, payload, success) => submit(event, path, () => payload, success, false)} />
          <OrderWholeFulfillmentPanel orderId={detail.line.orderId} module="shipments" refresh={`${refresh}:${refreshToken}:${detail.line.revision}:${detail.line.projectionVersion}`} busy={working || loading || reading || pendingIntent !== null || fulfillmentBlocked} options={options} onReading={setWholeReading} onEditsChanged={forms.check} onSubmit={(event, path, payload, success) => submit(event, path, () => payload, success, false)} />
          {records?.shipments.map((record) => (
            <article className="oc-record" key={record.shipment.id}>
              <div className="oc-record-header">
                <strong>发货单 {record.shipment.id}</strong>
                <span className="oc-badge">{record.physicalHandover ? `实际交运 ${record.physicalHandover.dispatchedPackageCount}/${record.physicalHandover.packageCount} 包裹` : "实际交运证据未加载"}</span>
              </div>
              {record.packages
                .filter((pkg) =>
                  record.versions.some(
                    (version) =>
                      version.id === pkg.shipmentVersionId &&
                      version.versionNumber === record.shipment.currentVersionNumber,
                  ),
                )
                .map((pkg) => (
                  <p key={pkg.id}>
                    {pkg.carrierName} · {pkg.trackingNumber} · 包裹共{" "}
                    {record.packageLines
                      .filter((line) => line.packageId === pkg.id)
                      .reduce((sum, line) => sum + line.quantity, 0)}{" "}
                    件
                  </p>
                ))}
              <p className="oc-hint">
                平台回传：
                {record.writebacks.length
                  ? record.writebacks.map((record) => label(record.status)).join("、")
                  : "尚未回传"}
              </p>
              {record.versions.filter(version => version.versionNumber === record.shipment.currentVersionNumber).map(version =>
                [1, 2].includes(version.productionSourceVersion ?? 0) ? <div className="oc-shipment-source-history" key={version.id} aria-label="已固定的生产来源">
                  {record.productionAllocations.filter(source => source.shipmentVersionId === version.id).map((source, index) => <p key={`${source.packageId}:${source.productionOrderId}:${index}`}>
                    生产批次 {source.productionOrderId.slice(-8)} · 原生产版本 {source.productionVersionId.slice(-8)} · 通过质检 {source.qualityInspectionId.slice(-8)}{source.qualityGroupId ? " · 实物组 " + source.qualityGroupId.slice(-8) : ""} · {source.quantity} 件
                  </p>)}
                </div> : <p className="oc-notice" key={version.id}>旧包裹生产来源未记录 请核对原包裹与实物后建立新版本</p>,
              )}
              {["draft", "approved", "shipped"].includes(record.shipment.status) && !record.physicalHandover?.dispatchedPackageCount && <ShipmentSourceEditor
                shipmentId={record.shipment.id} refresh={`${refresh}:${refreshToken}:${record.shipment.currentVersionNumber}`} disabled={busy} onEditsChanged={forms.check}
                onPrepare={async (event, payload) => {
                  const form = event.currentTarget, fingerprint = formFingerprint(form); event.preventDefault();
                  if (busy || reading || !fulfillment?.canPrepareAgent) return false;
                  const signature = JSON.stringify([record.shipment.id, payload]), key = proposalHandoff?.slotId || retries.current.get(signature) || crypto.randomUUID(); retries.current.set(signature, key);
                  const command = fulfillmentCommandForOperation(`shipments/${record.shipment.id}/versions`, { ...payload, idempotencyKey: key }, { orderId: detail.line.orderId });
                  if (!command) throw new Error("原包裹版本准备尚未登记 未发送业务写入");
                  await fulfillment.prepareAgent(command); forms.commit(form, fingerprint);
                  setNotice("原包裹版本填写已交接 本次未请求建立新版本 请到 AI 工作台核对后明确执行"); return true;
                }}
                onSave={async (event, payload) => { const form = event.currentTarget, fingerprint = formFingerprint(form); event.preventDefault();
                  if (busy || reading) return false;
                  const saved = await run(`shipments/${record.shipment.id}/versions`, payload, "新的发货版本已保存 请重新核对并审核");
                  if (saved) forms.commit(form, fingerprint);
                  return saved;
                }} />}
              {(record.manualConfirmations ?? []).filter((confirmation) => record.versions.some((version) =>
                version.id === confirmation.shipmentVersionId && version.versionNumber === record.shipment.currentVersionNumber,
              )).map((confirmation) => <p key={confirmation.id} className="oc-notice">
                已人工核对平台发货确认 · {dateTime(confirmation.confirmedAt)}。核对依据保存在订单操作记录中。
              </p>)}
              {record.physicalHandover?.allDispatched && (
                <details data-order-action="platform-confirmation">
                  <summary>登记平台发货确认</summary>
                  <p className="oc-hint">请先在对应平台核对本发货单全部包裹的商品、数量、承运商和单号已确认发货，再登记凭证。此操作保存人工核对记录。</p>
                  <form key={proposalHandoff?.formKey} className="oc-operation-form" onSubmit={(event) => void submit(event,
                    `shipments/${record.shipment.id}/platform-confirmation`, (form) => ({
                      expectedVersion: record.shipment.currentVersionNumber,
                      evidenceReference: text(form, "reference"), confirmedAt: iso(form, "confirmedAt"),
                    }), "平台发货确认依据已记录。") }>
                    <fieldset disabled={busy} className="oc-form-grid">
                      <label>平台确认时间<input name="confirmedAt" type="datetime-local" required defaultValue={agentFulfillmentProposalLocalTime(agentFulfillmentProposalInputFor(proposalHandoff, "shipment_platform_confirmation", record.shipment.id)?.confirmedAt)} /></label>
                      <label>平台发货确认凭证<input name="reference" required maxLength={1000} placeholder="确认记录编号或核对说明" defaultValue={agentFulfillmentProposalInputFor(proposalHandoff, "shipment_platform_confirmation", record.shipment.id)?.evidenceReference} /></label>
                      <button type="submit" disabled={!!proposalHandoff}>记录已在平台确认发货</button>
                      <FulfillmentCommandPrepareButton disabled={busy} />
                    </fieldset>
                  </form>
                </details>
              )}
              <ol className="oc-record-history">
                {record.tracking.map((event) => (
                  <li key={event.id}>
                    {label(event.status)} · {dateTime(event.occurredAt)}
                  </li>
                ))}
              </ol>
              {record.shipment.status === "draft" && (
                <form
                  className="oc-operation-form"
                  data-order-action="shipment-review"
                  key={`shipment-review:${record.shipment.currentVersionNumber}:${proposalHandoff?.formKey ?? ""}`}
                  onSubmit={(event) =>
                    void submit(
                      event,
                      `shipments/${record.shipment.id}/review`,
                      (form) => ({
                        decision: "approved",
                        reasonCode: "MANUAL_PACKAGE_CHECK",
                        reason: text(form, "reason"),
                        expectedCurrentVersion: record.shipment.currentVersionNumber,
                      }),
                      "包裹已审核，可以记录实际交运。",
                      !record.shipment.wholeOrder,
                    )
                  }
                >
                  <label>
                    核对说明
                    <input required name="reason" placeholder="核对数量、物流单号和发货信息" defaultValue={agentFulfillmentProposalInputFor(proposalHandoff, "shipment_review", record.shipment.id, { versionId: record.versions.find(value => value.versionNumber === record.shipment.currentVersionNumber)?.id })?.reason} />
                  </label>
                  <button className="oc-button" disabled={busy || !!proposalHandoff}>
                    审核通过
                  </button>
                  <FulfillmentCommandPrepareButton disabled={busy} />
                </form>
              )}
              {record.shipment.currentVersionNumber === record.shipment.approvedVersionNumber &&
                record.physicalHandover?.dispatchedPackageCount === 0 && (
                <form
                  className="oc-operation-form"
                  data-order-action="shipment-dispatch"
                  key={proposalHandoff?.formKey}
                  onSubmit={(event) =>
                    void submit(
                      event,
                      `shipments/${record.shipment.id}/dispatch`,
                      (form) => ({
                        expectedVersion: record.shipment.currentVersionNumber,
                        reason: text(form, "reason"),
                        occurredAt: iso(form, "time"),
                      }),
                      "实际交运已记录。平台回传状态单独保留。",
                      !record.shipment.wholeOrder,
                    )
                  }
                >
                  <label>
                    交运凭证 / 说明
                    <input required name="reason" defaultValue={agentFulfillmentProposalInputFor(proposalHandoff, "shipment_dispatch", record.shipment.id)?.reason} />
                  </label>
                  <label>
                    实际交运时间
                    <input required name="time" type="datetime-local" defaultValue={agentFulfillmentProposalLocalTime(agentFulfillmentProposalInputFor(proposalHandoff, "shipment_dispatch", record.shipment.id)?.occurredAt)} />
                  </label>
                  <button className="oc-button primary" disabled={busy || !!proposalHandoff}>
                    {record.shipment.wholeOrder ? "确认整单已出库" : "确认已交运"}
                  </button>
                  <FulfillmentCommandPrepareButton disabled={busy} />
                </form>
              )}
              {record.shipment.approvedVersionNumber === record.shipment.currentVersionNumber &&
                !["draft", "cancelled"].includes(record.shipment.status) && (
                <form
                  className="oc-operation-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (busy || reading) return;
                    const element = event.currentTarget;
                    const submitted = formFingerprint(element);
                    const form = new FormData(element);
                    setBusy(true);
                    setError("");
                    const payload = {
                      packageId: text(form, "packageId"),
                      status: text(form, "status"),
                      provider: "manual",
                      externalEventId: text(form, "reference"),
                      detailCode: "MANUAL_TRACKING",
                      estimatedDeliveryAt: null,
                      occurredAt: iso(form, "time"),
                    };
                    void centerRequest(`shipments/${record.shipment.id}/tracking`, payload)
                      .then(() => {
                        setNotice("物流进度已记录。");
                        setRefresh((value) => value + 1);
                        onChanged();
                        if (!forms.commit(element, submitted)) onCompleted?.();
                      })
                      .catch((cause) =>
                        setError(cause instanceof Error ? cause.message : "保存失败"),
                      )
                      .finally(() => setBusy(false));
                  }}
                >
                  <label>
                    包裹
                    <select name="packageId">
                      {record.packages
                        .filter((pkg) =>
                          record.versions.some(
                            (version) =>
                              version.id === pkg.shipmentVersionId &&
                              version.versionNumber === record.shipment.approvedVersionNumber,
                          ),
                        )
                        .map((pkg) => (
                          <option key={pkg.id} value={pkg.id}>
                            {pkg.trackingNumber}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    实际物流状态
                    <select name="status">
                      {[
                        "in_transit",
                        "out_for_delivery",
                        "delivered",
                        "delivery_exception",
                        "returned",
                      ].map((state) => (
                        <option key={state} value={state}>
                          {label(state)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    物流事件编号
                    <input required name="reference" />
                  </label>
                  <label>
                    发生时间
                    <input required name="time" type="datetime-local" />
                  </label>
                  <button className="oc-button" disabled={busy}>
                    记录物流进度
                  </button>
                </form>
              )}
            </article>
          ))}
        </>
      )}
      {module === "after-sales" && (
        <>
          <details open={!records?.cases.length}>
            <summary>登记售后问题</summary>
            <form
              data-order-action="after-sales-create"
              className="oc-operation-form"
              onSubmit={(event) =>
                void submit(
                  event,
                  `lines/${id}/cases`,
                  (form) => ({
                    type: text(form, "type"),
                    reasonCode: text(form, "reason"),
                    summary: text(form, "summary"),
                  }),
                  "售后问题已登记。",
                )
              }
            >
              <label>
                问题类型
                <select name="type">
                  {[
                    "customer_contact",
                    "refund_request",
                    "return_request",
                    "replacement_request",
                    "delivery_issue",
                    "quality_issue",
                  ].map((type) => (
                    <option key={type} value={type}>
                      {label(type)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                原因分类
                <input required name="reason" placeholder="例如图片错误、运输破损" />
              </label>
              <label className="oc-full-field">
                问题说明
                <textarea required name="summary" maxLength={2000} />
              </label>
              <button className="oc-button primary" disabled={busy}>
                登记售后
              </button>
            </form>
          </details>
          {records && !openCases.length && !records.readErrors.cases && <p className="oc-hint">本单暂无未结案问题。</p>}
          {requestedCase && records && !records.readErrors.cases && !records.cases.some(record => record.case.id === requestedCase) && <p role="alert" className="oc-error">此订单没有匹配的售后问题 请核对原任务入口</p>}
          {!!closedCases.length && <button type="button" className="oc-text-button" disabled={busy} onClick={() => setShowClosedCases(value => !value)}>{showClosedCases ? "收起已结案记录" : `查看已结案记录（${closedCases.length}）`}</button>}
          {[...openCases, ...(showClosedCases ? closedCases : [])].map((record) => (
            <article className="oc-record" id={"case-" + record.case.id} tabIndex={-1} data-focused={record.case.id === requestedCase} key={record.case.id}>
              <div className="oc-record-header">
                <strong>
                  {label(record.case.type)} · {record.case.reasonCode}
                </strong>
                <span className="oc-badge">{label(record.case.status)}</span>
              </div>
              <p className="oc-hint">
                {record.case.id} · {dateTime(record.case.createdAt)}
              </p>
              <p>{record.case.summary}</p>
              <AfterSalesAssist caseId={record.case.id} revision={JSON.stringify([record.case.status, record.case.currentDecisionVersion, record.contacts.map((c) => c.id)])} disabled={busy} />
              <ol className="oc-record-history">
                {record.contacts.map((contact) => (
                  <li key={contact.id}>
                    {contact.direction === "inbound"
                      ? "收到客户回复"
                      : contact.direction === "outbound"
                        ? "已回复客户"
                        : "内部记录"}{" "}
                    · {dateTime(contact.occurredAt)}
                    <p>{contact.body}</p>
                  </li>
                ))}
                {record.decisions.map((decision) => (
                  <li key={decision.id}>
                    {label(decision.resolution)}
                    {decision.refundAmountMinor !== null
                      ? ` · ${decision.refundCurrency} ${(decision.refundAmountMinor / 100).toFixed(2)}`
                      : ""}{" "}
                    · {dateTime(decision.decidedAt)}
                    <p>{decision.reason}</p>
                  </li>
                ))}
              </ol>
              {!["resolved", "cancelled"].includes(record.case.status) && (
                <>
                  <details>
                    <summary>登记已发生的沟通</summary>
                    <form
                      className="oc-operation-form"
                      onSubmit={(event) =>
                        void submit(
                          event,
                          `cases/${record.case.id}/contacts`,
                          (form) => ({
                            channel: text(form, "channel"),
                            direction: text(form, "direction"),
                            body: text(form, "body"),
                            externalMessageId: text(form, "reference") || null,
                            occurredAt: iso(form, "time"),
                          }),
                          "沟通记录已保存。",
                        )
                      }
                    >
                      <label>
                        渠道
                        <select name="channel">
                          <option value="marketplace">平台消息</option>
                          <option value="email">邮件</option>
                          <option value="internal">内部记录</option>
                        </select>
                      </label>
                      <label>
                        方向
                        <select name="direction">
                          <option value="inbound">客户来信</option>
                          <option value="outbound">已回复客户</option>
                          <option value="internal">内部备注</option>
                        </select>
                      </label>
                      <label>
                        消息编号
                        <input name="reference" />
                      </label>
                      <label>
                        沟通时间
                        <input required type="datetime-local" name="time" />
                      </label>
                      <label className="oc-full-field">
                        沟通内容
                        <textarea required name="body" />
                      </label>
                      <button className="oc-button" disabled={busy}>
                        保存沟通记录
                      </button>
                    </form>
                  </details>
                  <details>
                    <summary>记录处理方案</summary>
                    <form
                      className="oc-operation-form"
                      onSubmit={(event) =>
                        void submit(
                          event,
                          `cases/${record.case.id}/decisions`,
                          (form) => {
                            const resolution = text(form, "resolution"),
                              refund = [
                                "full_refund",
                                "partial_refund",
                                "return_and_refund",
                              ].includes(resolution);
                            return {
                              resolution,
                              refundAmountMinor: refund
                                ? Math.round(number(form, "amount") * 100)
                                : null,
                              refundCurrency: refund ? text(form, "currency") : null,
                              returnRequired: resolution === "return_and_refund",
                              responsibilityParty: text(form, "party"),
                              reasonCode: record.case.reasonCode,
                              reason: text(form, "reason"),
                              expectedDecisionVersion: record.case.currentDecisionVersion,
                            };
                          },
                          "处理方案已记录；实际退款和补发执行结果需单独核实。",
                        )
                      }
                    >
                      <label>
                        处理方案
                        <select name="resolution">
                          {[
                            "replacement",
                            "partial_refund",
                            "full_refund",
                            "return_and_refund",
                            "no_action",
                          ].map((resolution) => (
                            <option key={resolution} value={resolution}>
                              {label(resolution)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        责任方
                        <select name="party">
                          {[
                            ["undetermined", "待确认"],
                            ["supplier", "工厂"],
                            ["internal", "内部"],
                            ["carrier", "承运商"],
                            ["customer", "客户"],
                            ["marketplace", "平台"],
                          ].map(([value, name]) => (
                            <option key={value} value={value}>
                              {name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        退款金额（退款方案填写）
                        <input type="number" min={0} step="0.01" name="amount" />
                      </label>
                      <label>
                        币种
                        <input name="currency" pattern="[A-Z]{3}" placeholder="USD / CNY" />
                      </label>
                      <label className="oc-full-field">
                        处理依据
                        <textarea required name="reason" />
                      </label>
                      <button className="oc-button" disabled={busy}>
                        保存处理方案
                      </button>
                    </form>
                  </details>
                </>
              )}
              {["approved", "rejected"].includes(record.case.status) && (
                <details>
                  <summary>登记实际处理完成</summary>
                  <form
                    className="oc-operation-form"
                    onSubmit={(event) =>
                      void submit(
                        event,
                        `cases/${record.case.id}/complete`,
                        (form) => ({
                          expectedDecisionVersion: record.case.currentDecisionVersion,
                          reason: text(form, "reason"),
                          evidenceReference: text(form, "reference"),
                          occurredAt: iso(form, "time"),
                        }),
                        "执行依据已保存，售后已结案。",
                      )
                    }
                  >
                    <p className="oc-hint oc-full-field">
                      确认退款、补发或其他处理已实际完成后，再填写凭证结案。
                    </p>
                    <label>
                      执行凭证编号
                      <input
                        required
                        name="reference"
                        placeholder="退款流水 / 补发运单 / 处理记录编号"
                      />
                    </label>
                    <label>
                      完成时间
                      <input required name="time" type="datetime-local" />
                    </label>
                    <label className="oc-full-field">
                      处理结果
                      <textarea required name="reason" />
                    </label>
                    <button className="oc-button primary" disabled={busy}>
                      记录完成并结案
                    </button>
                  </form>
                </details>
              )}
            </article>
          ))}
          <p className="oc-hint">
            需要重新制作时，可到 <Link href={`/production?line=${id}`}>生产中心</Link>{" "}
            查看原生产任务并安排补做。
          </p>
        </>
      )}
    </section>
  );
}
function text(form: FormData, key: string) {
  return String(form.get(key) ?? "").trim();
}
function number(form: FormData, key: string) {
  const value = Number(text(form, key));
  if (!Number.isFinite(value)) throw new Error("请填写有效数字");
  return value;
}
function iso(form: FormData, key: string) {
  const value = new Date(text(form, key));
  if (Number.isNaN(value.getTime())) throw new Error("请填写完整的发生时间");
  return value.toISOString();
}
