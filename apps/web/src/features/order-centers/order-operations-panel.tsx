"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  OrderOperationsViewSchema,
  type OrderOperationsView,
  type OrderWorkDetail,
  type OrderCenterOptions,
  type OrderWorkspaceModule,
} from "@yummyai/contracts/order/workspace";
import type { ProductionEditorDetailView } from "@yummyai/contracts/pod/production-editor-api";
import { centerRequest, dateTime, label } from "./order-center-model";
import { AfterSalesAssist } from "../ai-assist/business-assist";
import { formFingerprint, useFormEdits } from "../navigation/use-form-edits";
import type { OrderReviewState } from "./order-work-detail";
import { useWorkflowReturn } from "../navigation/use-workflow-return";

const nextMilestones: Record<string, Array<[string, string]>> = {
  planned: [["submitted", "记录已发送工厂"]],
  submitted: [["acknowledged", "记录工厂已接单"]],
  acknowledged: [["started", "记录开始生产"]],
  in_production: [["completed", "记录生产完工"]],
  cancel_requested: [["cancelled", "记录工厂已确认停单"]],
};
export function OrderOperationsPanel({
  module,
  detail,
  editor,
  loading = false,
  options,
  onChanged,
  onStateChange,
  onCompleted,
}: {
  module: OrderWorkspaceModule;
  detail: OrderWorkDetail;
  editor: ProductionEditorDetailView | null;
  loading?: boolean;
  options: OrderCenterOptions;
  onChanged: () => void;
  onStateChange?: (state: OrderReviewState) => void;
  onCompleted?: () => void;
}) {
  const workflow = useWorkflowReturn();
  const [records, setRecords] = useState<OrderOperationsView | null>(null),
    [refresh, setRefresh] = useState(0),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [working, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const busy = working || loading || reading;
  const forms = useFormEdits();
  useEffect(() => {
    onStateChange?.({ busy: working, loading: reading, dirty: forms.dirty });
  }, [working, reading, forms.dirty, onStateChange]);
  const retries = useRef(new Map<string, string>()),
    id = detail.line.id;
  useEffect(() => {
    if (!["production", "shipments", "after-sales"].includes(module)) return;
    const abort = new AbortController();
    setReading(true);
    void centerRequest(`lines/${id}/operations`, undefined, abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setRecords(OrderOperationsViewSchema.parse(value));
      })
      .catch((cause) => {
        if (!abort.signal.aborted)
          setError(cause instanceof Error ? cause.message : "业务记录读取失败");
      }).finally(() => { if (!abort.signal.aborted) setReading(false); });
    return () => abort.abort();
  }, [id, module, refresh]);
  if (!["production", "shipments", "after-sales"].includes(module)) return null;
  async function run(path: string, payload: Record<string, unknown>, success: string) {
    setBusy(true);
    setError("");
    setNotice("");
    const signature = JSON.stringify([path, payload]),
      key = retries.current.get(signature) ?? crypto.randomUUID();
    retries.current.set(signature, key);
    try {
      await centerRequest(
        path,
        path.endsWith("/milestones")
          ? { ...payload, externalEventId: key }
          : { ...payload, idempotencyKey: key },
      );
      setNotice(success);
      setRefresh((value) => value + 1);
      onChanged();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成");
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function submit(
    event: FormEvent<HTMLFormElement>,
    path: string,
    build: (form: FormData) => Record<string, unknown>,
    success: string,
  ) {
    event.preventDefault();
    if (busy || reading) return;
    const element = event.currentTarget;
    const submitted = formFingerprint(element);
    try {
      if (await run(path, build(new FormData(element)), success)) {
        if (!forms.commit(element, submitted)) onCompleted?.();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请检查填写内容");
    }
  }
  const productionFiles =
    editor?.renders.filter(
      (render) =>
        render.versionId === editor.version.id &&
        render.purpose === "production" &&
        render.status === "completed" &&
        render.preflight?.productionReady,
    ) ?? [];
  return (
    <section className="oc-section oc-operations" ref={forms.ref} onInputCapture={forms.check} onChangeCapture={forms.check}>
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
      {module === "production" && (
        <>
          <details open={!records?.production.length}>
            <summary>下达生产</summary>
            <p className="oc-hint">
              固定正式文件、数量和工厂，建立内部生产任务。工厂接单和实际进度需要后续记录。
            </p>
            {detail.line.artwork !== "approved" ||
            !["not_required", "approved"].includes(detail.line.proof) ? (
              <p>
                文件审核或客户确认尚未完成。
                <Link href={workflow.link(`/order-artwork?line=${id}`)}>去制图中心处理</Link>
              </p>
            ) : !productionFiles.length ? (
              <p>
                尚未生成可下达的正式生产文件。
                <Link href={workflow.link(`/order-artwork?line=${id}`)}>去生成生产文件</Link>
              </p>
            ) : (
              <form
                className="oc-operation-form"
                onSubmit={(event) =>
                  void submit(
                    event,
                    `lines/${id}/release`,
                    (form) => ({
                      expectedRevision: detail.line.revision,
                      expectedProjectionVersion: detail.line.projectionVersion,
                      renderId: text(form, "renderId"),
                      supplierId: text(form, "supplierId"),
                      quantity: number(form, "quantity"),
                      expectedCompletionAt: iso(form, "expectedCompletionAt"),
                      instructions: text(form, "instructions"),
                    }),
                    "生产任务已下达，等待发送工厂。",
                  )
                }
              >
                <label>
                  正式生产文件
                  <select required name="renderId">
                    {productionFiles.map((render) => (
                      <option key={render.id} value={render.id}>
                        {render.files[0]?.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  生产工厂
                  <select required name="supplierId" defaultValue="">
                    <option value="">选择工厂</option>
                    {options.suppliers
                      .filter((supplier) => supplier.status === "active")
                      .map((supplier) => (
                        <option key={supplier.id} value={supplier.id}>
                          {supplier.name}
                        </option>
                      ))}
                  </select>
                </label>
                <label>
                  下达数量
                  <input
                    required
                    type="number"
                    min={1}
                    max={detail.line.quantity}
                    name="quantity"
                    defaultValue={detail.line.quantity}
                  />
                </label>
                <label>
                  计划完工时间
                  <input required name="expectedCompletionAt" type="datetime-local" />
                </label>
                <label className="oc-full-field">
                  工厂制作说明
                  <textarea
                    required
                    name="instructions"
                    defaultValue={[detail.profile?.instructions, detail.draft.instructions]
                      .filter(Boolean)
                      .join("\n")}
                    placeholder="填写规格、工艺和工厂需要注意的事项"
                  />
                </label>
                <button className="oc-button primary" disabled={busy || detail.line.held}>
                  下达生产
                </button>
              </form>
            )}
          </details>
          {records?.production.map((record) => {
            const production = record.productionOrder,
              version = record.versions.find(
                (row) => row.versionNumber === production.currentVersionNumber,
              ),
              inspection = record.inspections[0];
            return (
              <article className="oc-record" key={production.id}>
                <div className="oc-record-header">
                  <strong>
                    {options.suppliers.find((supplier) => supplier.id === production.supplierId)
                      ?.name ?? "工厂"}{" "}
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
                  生产单：{production.id} · 计划完工：{dateTime(production.expectedCompletionAt)}
                </p>
                {version?.sourceEditorProjectId && version.sourceRenderId && (
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
                    </li>
                  ))}
                </ol>
                {(nextMilestones[production.status] ||
                  !["completed", "cancelled", "cancel_requested"].includes(production.status)) && (
                  <form
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
                        maxLength={160}
                        pattern="[A-Z0-9_:-]+"
                        placeholder="例如 FACTORY_ACK_001"
                      />
                    </label>
                    <label>
                      发生时间
                      <input required type="datetime-local" name="occurredAt" />
                    </label>
                    <label>
                      备注
                      <input name="note" maxLength={2000} />
                    </label>
                    <div className="oc-actions">
                      {(nextMilestones[production.status] ?? []).map(([action, name]) => (
                        <button
                          className="oc-button primary"
                          key={action}
                          value={action}
                          disabled={busy}
                        >
                          {name}
                        </button>
                      ))}
                      {!["completed", "cancelled", "cancel_requested"].includes(
                        production.status,
                      ) && (
                        <button className="oc-button" value="cancel_requested" disabled={busy}>
                          记录停单申请
                        </button>
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
                            const failed = text(form, "result") === "failed";
                            return {
                              qualityStandardVersionId: text(form, "standard"),
                              result: failed ? "failed" : "passed",
                              scoreBps: Math.round(number(form, "score") * 100),
                              inspectedAt: iso(form, "time"),
                              evidenceAssetIds: [],
                              defects: failed
                                ? [
                                    {
                                      code: "MANUAL_QC",
                                      severity: "major",
                                      responsibility: "unknown",
                                      disposition: "remake",
                                      note: text(form, "note"),
                                      evidenceAssetIds: [],
                                    },
                                  ]
                                : [],
                            };
                          },
                          "质检结果已保存。",
                        )
                      }
                    >
                      <label>
                        检验标准
                        <select required name="standard" defaultValue="">
                          <option value="">选择标准</option>
                          {options.standards.map((standard) => (
                            <option key={standard.id} value={standard.id}>
                              {standard.name} V{standard.versionNumber} · 合格线{" "}
                              {standard.minimumScoreBps / 100}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        结果
                        <select name="result">
                          <option value="passed">通过</option>
                          <option value="failed">不通过</option>
                        </select>
                      </label>
                      <label>
                        检验分数
                        <input required type="number" min={0} max={100} step="0.01" name="score" />
                      </label>
                      <label>
                        检验时间
                        <input required type="datetime-local" name="time" />
                      </label>
                      <label>
                        不合格说明（未通过时填写）
                        <input name="note" maxLength={2000} />
                      </label>
                      <button className="oc-button" disabled={busy}>
                        保存质检结果
                      </button>
                    </form>
                  </details>
                )}
                {production.status === "quality_hold" && (
                  <details>
                    <summary>安排补做</summary>
                    <form
                      className="oc-operation-form"
                      onSubmit={(event) =>
                        void submit(
                          event,
                          "recoveries",
                          (form) => ({
                            type: "remake",
                            originalProductionOrderId: production.id,
                            reason: text(form, "reason"),
                            expectedCompletionAt: iso(form, "time"),
                          }),
                          "已创建关联原生产单的补做任务。",
                        )
                      }
                    >
                      <label>
                        补做原因
                        <input required name="reason" />
                      </label>
                      <label>
                        预计完成
                        <input required name="time" type="datetime-local" />
                      </label>
                      <button className="oc-button" disabled={busy}>
                        创建补做任务
                      </button>
                    </form>
                  </details>
                )}
              </article>
            );
          })}
          <details className="oc-record">
            <summary>维护质检标准</summary>
            <form
              className="oc-operation-form"
              onSubmit={(event) => {
                event.preventDefault();
                const element = event.currentTarget;
                const submitted = formFingerprint(element);
                const form = new FormData(event.currentTarget);
                setBusy(true);
                setError("");
                void centerRequest("quality-standards", {
                  name: text(form, "name"),
                  minimumScoreBps: Math.round(number(form, "score") * 100),
                  criteria: [
                    {
                      code: "GENERAL",
                      label: text(form, "criterion"),
                      weightBps: 10000,
                      blocking: true,
                    },
                  ],
                })
                  .then(() => {
                    setNotice("质检标准已保存。");
                    forms.commit(element, submitted);
                    onChanged();
                  })
                  .catch((cause) => setError(cause instanceof Error ? cause.message : "保存失败"))
                  .finally(() => setBusy(false));
              }}
            >
              <label>
                标准名称
                <input required name="name" />
              </label>
              <label>
                检验内容
                <input required name="criterion" placeholder="例如尺寸、图案与外观检查" />
              </label>
              <label>
                合格分数
                <input required name="score" type="number" min={1} max={100} />
              </label>
              <button className="oc-button" disabled={busy}>
                保存新标准版本
              </button>
            </form>
          </details>
        </>
      )}
      {module === "shipments" && (
        <>
          <p>
            质检通过 {detail.line.readyQuantity} 件，已经发出 {detail.line.shippedQuantity} 件。
          </p>
          <details open={!records?.shipments.length}>
            <summary>新建包裹</summary>
            <form
              className="oc-operation-form"
              onSubmit={(event) =>
                void submit(
                  event,
                  `lines/${id}/shipments`,
                  (form) => ({
                    shipDate: iso(form, "shipDate"),
                    shipFromCountryCode: text(form, "country"),
                    packages: [
                      {
                        packageReferenceId: text(form, "reference"),
                        trackingNumber: text(form, "tracking"),
                        carrierCode: text(form, "carrierCode"),
                        carrierName: text(form, "carrierName"),
                        carrierService: text(form, "service"),
                        lines: [{ orderLineId: id, quantity: number(form, "quantity") }],
                      },
                    ],
                  }),
                  "包裹草稿已保存，请审核后记录交运。",
                )
              }
            >
              <label>
                包裹编号
                <input required name="reference" />
              </label>
              <label>
                物流单号
                <input required name="tracking" />
              </label>
              <label>
                本商品装入数量
                <input
                  required
                  name="quantity"
                  type="number"
                  min={1}
                  max={detail.line.quantity}
                  defaultValue={Math.max(
                    1,
                    detail.line.readyQuantity - detail.line.shippedQuantity,
                  )}
                />
              </label>
              <label>
                承运商代码
                <input
                  required
                  name="carrierCode"
                  placeholder="例如 USPS / UPS / SF"
                  pattern="[A-Z0-9_:-]+"
                />
              </label>
              <label>
                承运商名称
                <input required name="carrierName" />
              </label>
              <label>
                物流服务
                <input required name="service" />
              </label>
              <label>
                发货国家
                <select required name="country" defaultValue="">
                  <option value="">选择国家</option>
                  <option value="CN">中国</option>
                  <option value="US">美国</option>
                  <option value="GB">英国</option>
                  <option value="DE">德国</option>
                  <option value="CA">加拿大</option>
                  <option value="AU">澳大利亚</option>
                </select>
              </label>
              <label>
                计划发货时间
                <input required name="shipDate" type="datetime-local" />
              </label>
              <button
                className="oc-button primary"
                disabled={
                  busy ||
                  detail.line.held ||
                  detail.line.readyQuantity <= detail.line.shippedQuantity
                }
              >
                保存包裹草稿
              </button>
            </form>
          </details>
          {records?.shipments.map((record) => (
            <article className="oc-record" key={record.shipment.id}>
              <div className="oc-record-header">
                <strong>发货单 {record.shipment.id}</strong>
                <span className="oc-badge">{label(record.shipment.status)}</span>
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
                    {pkg.carrierName} · {pkg.trackingNumber} · 本商品{" "}
                    {record.packageLines
                      .filter((line) => line.packageId === pkg.id && line.orderLineId === id)
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
                    )
                  }
                >
                  <label>
                    核对说明
                    <input required name="reason" placeholder="核对数量、物流单号和发货信息" />
                  </label>
                  <button className="oc-button" disabled={busy}>
                    审核通过
                  </button>
                </form>
              )}
              {record.shipment.status === "approved" && (
                <form
                  className="oc-operation-form"
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
                    )
                  }
                >
                  <label>
                    交运凭证 / 说明
                    <input required name="reason" />
                  </label>
                  <label>
                    实际交运时间
                    <input required name="time" type="datetime-local" />
                  </label>
                  <button className="oc-button primary" disabled={busy}>
                    确认已交运
                  </button>
                </form>
              )}
              {["shipped", "in_transit", "delivered", "exception"].includes(
                record.shipment.status,
              ) && (
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
          {records?.cases.map((record) => (
            <article className="oc-record" key={record.case.id}>
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
