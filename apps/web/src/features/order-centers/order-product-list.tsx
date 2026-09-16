"use client";
import { Fragment, useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import Image from "next/image";
import { ChevronDown, ChevronUp, ScanSearch, Sparkles, X } from "lucide-react";
import {
  OrderWorkListViewSchema,
  OrderWorkSummariesSchema,
  type OrderCenterOptions,
  type OrderWorkListItem,
  type OrderWorkSummary,
  type OrderWorkspaceModule,
} from "@yummyai/contracts/order/workspace";
import {
  orderQueueStage,
  ORDER_QUEUE_LABELS,
  ORDER_LABEL_LABELS,
} from "@yummyai/contracts/order/workbench";
import { OrderWorkDetailPanel, type OrderReviewState } from "./order-work-detail";
import { OrderBulkPanel, type BulkOperation } from "./order-bulk-panel";
import { centerRequest, dateTime, label } from "./order-center-model";

const initialState: OrderReviewState = { dirty: false, busy: false, loading: false };
export function OrderProductList({
  items,
  query,
  loading,
  unavailable = false,
  refresh,
  options,
  navigationGuard,
  onBusy,
  onChanged,
  onDetail,
}: {
  items: OrderWorkListItem[];
  query: string;
  loading: boolean;
  unavailable?: boolean;
  refresh: number;
  options: OrderCenterOptions | null;
  navigationGuard: MutableRefObject<() => boolean>;
  onBusy: (busy: boolean) => void;
  onChanged: () => void;
  onDetail: (id: string, module?: OrderWorkspaceModule) => void;
}) {
  const [selected, setSelected] = useState(new Map<string, OrderWorkListItem>());
  const [summaries, setSummaries] = useState(new Map<string, OrderWorkSummary>()),
    [summaryError, setSummaryError] = useState("");
  const [summaryRefresh, setSummaryRefresh] = useState(0),
    [error, setError] = useState("");
  const [inlineRow, setInlineRow] = useState<OrderWorkListItem | null>(null),
    [editState, setEditState] = useState(initialState);
  const [bulk, setBulk] = useState<BulkOperation | null>(null),
    [bulkBusy, setBulkBusy] = useState(false),
    [selectionBusy, setSelectionBusy] = useState(false);
  const [expanded, setExpanded] = useState(false),
    [preview, setPreview] = useState<OrderWorkSummary["images"][number] | null>(null);
  const imageDialog = useRef<HTMLDialogElement>(null);
  const scopeParams = new URLSearchParams(query);
  scopeParams.delete("page");
  scopeParams.delete("pageSize");
  const scope = scopeParams.toString();
  const idsKey = items
    .map((item) => `${item.id}:${item.revision}:${item.projectionVersion}`)
    .join(",");
  const busy = bulkBusy || selectionBusy || editState.busy;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useEffect(() => {
    setSelected(new Map());
    setBulk(null);
    setInlineRow(null);
    setEditState(initialState);
  }, [scope]);
  useEffect(() => {
    setSelected(
      (current) =>
        new Map([...current].map(([id, item]) => [id, items.find((row) => row.id === id) ?? item])),
    );
  }, [items]);
  useEffect(() => {
    const abort = new AbortController();
    setSummaryError("");
    setSummaries(new Map());
    const ids = idsKey
      .split(",")
      .filter(Boolean)
      .map((value) => value.split(":")[0]!);
    void (async () => {
      for (let index = 0; index < ids.length; index += 100) {
        const result = OrderWorkSummariesSchema.parse(
          await centerRequest("summaries", { ids: ids.slice(index, index + 100) }, abort.signal),
        );
        if (!abort.signal.aborted)
          setSummaries(
            (current) =>
              new Map([...current, ...result.items.map((item) => [item.id, item] as const)]),
          );
      }
    })().catch((cause) => {
      if (!abort.signal.aborted)
        setSummaryError(cause instanceof Error ? cause.message : "定制摘要读取失败");
    });
    return () => abort.abort();
  }, [idsKey, refresh, summaryRefresh]);
  const leaveEditor = useCallback(() => {
    if (busy || editState.loading) return false;
    if (editState.dirty && !window.confirm("本件商品有未保存的修改，确定放弃修改？")) return false;
    setInlineRow(null);
    setEditState(initialState);
    return true;
  }, [busy, editState]);
  useEffect(() => {
    navigationGuard.current = leaveEditor;
    return () => {
      navigationGuard.current = () => true;
    };
  }, [navigationGuard, leaveEditor]);
  useEffect(() => {
    if (preview) imageDialog.current?.showModal();
    else imageDialog.current?.close();
  }, [preview]);
  useEffect(() => {
    if (!bulkBusy) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const link = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest("a[href]")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", link, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", link, true);
    };
  }, [bulkBusy]);
  function toggle(rows: OrderWorkListItem[], checked: boolean) {
    const next = new Map(selected);
    for (const row of rows) {
      if (checked) next.set(row.id, row);
      else next.delete(row.id);
    }
    if (next.size > 100) {
      setError("单批最多选择 100 件商品，请缩小范围或分批处理。");
      return;
    }
    setError("");
    setSelected(next);
    setBulk(null);
  }
  async function selectAll() {
    setSelectionBusy(true);
    setError("");
    try {
      const result = OrderWorkListViewSchema.pick({ items: true }).parse(
        await centerRequest("selection", Object.fromEntries(new URLSearchParams(query))),
      );
      setSelected(new Map(result.items.map((row) => [row.id, row])));
      setBulk(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "全选失败");
    } finally {
      setSelectionBusy(false);
    }
  }
  function openInline(row: OrderWorkListItem) {
    if (leaveEditor()) {
      setInlineRow(inlineRow?.id === row.id ? null : row);
      setBulk(null);
    }
  }
  function openBulk(operation: BulkOperation) {
    if (leaveEditor()) setBulk(operation);
  }
  const displayRows =
    inlineRow && !items.some((row) => row.id === inlineRow.id) ? [...items, inlineRow] : items;
  const groups = new Map<string, OrderWorkListItem[]>();
  for (const row of displayRows) groups.set(row.orderId, [...(groups.get(row.orderId) ?? []), row]);
  const selectedRows = [...selected.values()];
  const outside = selectedRows.filter((row) => !items.some((item) => item.id === row.id)).length;
  return (
    <div className="oc-order-list">
      <div className="oc-selection-bar" hidden={unavailable}>
        <Check
          label="选择本页商品"
          rows={items}
          selected={selected}
          disabled={busy || loading}
          onChange={(checked) => toggle(items, checked)}
        />
        <span>
          本页 {items.length} 件 · 已选 {selected.size} 件
          {outside > 0 ? `（其他页 ${outside} 件）` : ""}
        </span>
        <button
          className="oc-text-button"
          disabled={busy || loading}
          onClick={() => void selectAll()}
        >
          选择全部筛选结果
        </button>
        {!!selected.size && (
          <button
            className="oc-text-button"
            disabled={busy}
            onClick={() => {
              setSelected(new Map());
              setBulk(null);
            }}
          >
            清空选择
          </button>
        )}
        <label className="oc-inline-check oc-content-toggle">
          <input
            type="checkbox"
            checked={expanded}
            onChange={(event) => setExpanded(event.target.checked)}
          />
          展开全部定制内容
        </label>
      </div>
      {!!selected.size && !unavailable && (
        <div className="oc-batch-toolbar" aria-label="所选商品批量操作">
          <strong>已选 {selected.size} 件</strong>
          <button className="oc-button" disabled={busy} onClick={() => openBulk("check")}>
            <ScanSearch size={15} />
            检查缺项
          </button>
          <button className="oc-button" disabled={busy} onClick={() => openBulk("ai")}>
            <Sparkles size={15} />
            AI 预审
          </button>
          <button className="oc-button" disabled={busy} onClick={() => openBulk("bind")}>
            绑定印花 / 产品
          </button>
          <button className="oc-button" disabled={busy} onClick={() => openBulk("assign")}>
            设计安排
          </button>
          <button
            className="oc-button"
            disabled={busy}
            onClick={() => openBulk("needs_information")}
          >
            待补资料
          </button>
          <button className="oc-button" disabled={busy} onClick={() => openBulk("ready_to_push")}>
            确认审单
          </button>
          <button className="oc-button primary" disabled={busy} onClick={() => openBulk("push")}>
            推送设计
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="oc-error">
          {error}
        </p>
      )}
      {summaryError && (
        <p role="alert" className="oc-error">
          定制摘要：{summaryError}{" "}
          <button
            className="oc-text-button"
            onClick={() => setSummaryRefresh((value) => value + 1)}
          >
            重试摘要
          </button>
        </p>
      )}
      {bulk && (
        <OrderBulkPanel
          key={bulk}
          operation={bulk}
          selected={selectedRows}
          onBusy={setBulkBusy}
          onClose={() => setBulk(null)}
          onCompleted={(ids) => {
            setSelected((current) => new Map([...current].filter(([id]) => !ids.includes(id))));
            onChanged();
          }}
          onOpen={(id) => {
            const row = selected.get(id) ?? displayRows.find((row) => row.id === id);
            if (row) openInline(row);
            else onDetail(id);
          }}
        />
      )}
      {!items.length && !loading && !unavailable && (
        <p className="oc-empty">没有符合条件的订单商品。</p>
      )}
      {[...groups].map(([orderId, rows]) => {
        const first = rows[0]!;
        return (
          <section
            className="oc-order-group"
            key={orderId}
            aria-label={`订单 ${first.externalOrderId}`}
          >
            <header className="oc-order-heading">
              <Check
                label={`选择订单 ${first.externalOrderId} 的商品`}
                rows={rows.filter((row) => items.includes(row))}
                selected={selected}
                disabled={busy || loading}
                onChange={(checked) =>
                  toggle(
                    rows.filter((row) => items.includes(row)),
                    checked,
                  )
                }
              />
              <button className="oc-text-button" disabled={busy} onClick={() => onDetail(first.id)}>
                {first.externalOrderId}
              </button>
              <span>
                {first.storeName} · {first.platform === "amazon" ? "Amazon" : "Etsy"}
              </span>
              <span>下单 {dateTime(first.placedAt)}</span>
              <span>当前筛选 {rows.length} 件商品</span>
            </header>
            <div className="oc-product-columns" aria-hidden="true">
              <span />
              <span>商品 / 制作依据</span>
              <span>买家定制内容</span>
              <span>状态 / 交期</span>
              <span>操作</span>
            </div>
            {rows.map((row) => {
              const summary = summaries.get(row.id),
                editing = row.id === inlineRow?.id;
              const fields = (summary?.fields.filter((field) => field.value.trim()) ?? []).sort(
                (a, b) => orderFieldPriority(a.label) - orderFieldPriority(b.label),
              );
              const artwork = summary?.images.find((image) => image.kind === "artwork"),
                product = summary?.images.find((image) => image.kind === "preview");
              const buyerImages = summary?.images.filter((image) => image.kind === "buyer") ?? [];
              const failed = !!summary?.error || (!summary && !!summaryError);
              const unavailable = failed ? "读取失败" : "正在读取…";
              const executor =
                row.designExecutor ?? (summary?.error ? null : summary?.designExecutor);
              const stage = orderQueueStage(row);
              const next = orderNextAction(row);
              return (
                <Fragment key={row.id}>
                  <article
                    className={`oc-product-row${selected.has(row.id) ? " selected" : ""}${editing ? " editing" : ""}`}
                    aria-label={`商品 ${row.externalLineId} ${row.skuCode ?? row.title}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`选择商品 ${row.externalOrderId} / ${row.externalLineId}`}
                      checked={selected.has(row.id)}
                      disabled={busy || loading}
                      onChange={(event) => toggle([row], event.target.checked)}
                    />
                    <div className="oc-product-basis">
                      <div className="oc-product-media">
                        {product ? (
                          <Thumb item={product} onOpen={setPreview} />
                        ) : (
                          <span className="oc-thumb-placeholder">
                            {summary && !failed ? "无平台预览" : unavailable}
                          </span>
                        )}
                        <div>
                          <strong className="oc-rich-title" title={row.title}>
                            {row.title}
                          </strong>
                          <p>商品 SKU：{row.skuCode ?? "未提供"}</p>
                          <p>
                            商品行 {row.externalLineId} · 数量 {row.quantity} 件
                          </p>
                        </div>
                      </div>
                      <div className="oc-print-binding">
                        {artwork && <Thumb item={artwork} onOpen={setPreview} />}
                        <div>
                          <p>
                            印花 SKU：
                            <strong>{summary?.printSku ?? row.printSku ?? "待匹配"}</strong>
                          </p>
                          <p>
                            产品 SPU：
                            {row.spuCode ??
                              summary?.spu ??
                              (summary && !failed ? "待匹配" : unavailable)}
                          </p>
                          <p>
                            规格：
                            {row.specificationName ??
                              summary?.specification ??
                              (summary && !failed ? "待选择尺寸 / 形状 / 颜色" : unavailable)}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="oc-custom-summary">
                      {!summary && !summaryError && <p className="oc-hint">正在读取定制内容…</p>}
                      {summary?.error && <p className="oc-error">{summary.error}</p>}
                      {!summary && summaryError && (
                        <p className="oc-row-blocker">定制内容读取失败，请重试摘要或打开详情。</p>
                      )}
                      {summary && !summary.error && (
                        <>
                          <dl>
                            {(expanded ? fields : fields.slice(0, 3)).map((field, index) => (
                              <div key={index}>
                                <dt title={field.label}>
                                  {orderFieldLabel(field.label, field.value)}
                                </dt>
                                <dd title={field.value}>{orderFieldValue(field.value)}</dd>
                              </div>
                            ))}
                          </dl>
                          {!fields.length && <p className="oc-hint">没有定制文字 / 选项</p>}
                          {!expanded && fields.length > 3 && (
                            <details>
                              <summary>其余 {fields.length - 3} 项定制内容</summary>
                              <dl>
                                {fields.slice(3).map((field, index) => (
                                  <div key={index}>
                                    <dt>{field.label}</dt>
                                    <dd>{field.value}</dd>
                                  </div>
                                ))}
                              </dl>
                            </details>
                          )}
                          {!!buyerImages.length && (
                            <div className="oc-buyer-thumbs">
                              {(expanded ? buyerImages : buyerImages.slice(0, 4)).map(
                                (item, index) => (
                                  <figure key={index}>
                                    <Thumb item={item} onOpen={setPreview} />
                                    <figcaption>
                                      {item.selected ? "已用于制作" : "待选用途"}
                                    </figcaption>
                                  </figure>
                                ),
                              )}
                              {!expanded && buyerImages.length > 4 && (
                                <details>
                                  <summary>另 {buyerImages.length - 4} 张</summary>
                                  <div className="oc-buyer-thumbs">
                                    {buyerImages.slice(4).map((item, index) => (
                                      <Thumb key={index} item={item} onOpen={setPreview} />
                                    ))}
                                  </div>
                                </details>
                              )}
                            </div>
                          )}
                          {summary.instructions && (
                            <details
                              className="oc-custom-instructions"
                              open={expanded || undefined}
                            >
                              <summary>制作备注</summary>
                              <p>{summary.instructions}</p>
                            </details>
                          )}
                        </>
                      )}
                    </div>
                    <div className="oc-product-status">
                      <div className="oc-statuses">
                        <span className="oc-badge oc-current-stage">
                          {ORDER_QUEUE_LABELS[stage]}
                        </span>
                        {row.proof !== "not_required" && (
                          <span className="oc-badge">客户：{label(row.proof)}</span>
                        )}
                        {row.afterSalesCount > 0 && (
                          <span className="oc-badge warning">售后 {row.afterSalesCount}</span>
                        )}
                      </div>
                      <p>
                        {executor === "human"
                          ? "美工设计"
                          : executor === "agent"
                            ? "无人设计 Agent"
                            : `执行方式${unavailable}`}{" "}
                        · 需求 {row.revision ? `V${row.revision}` : "待整理"}
                      </p>
                      <p>内部截止：{row.dueAt ? dateTime(row.dueAt) : "未设置"}</p>
                      <p>
                        已发 {row.shippedQuantity} / {row.quantity} 件
                      </p>
                      {row.held || row.sideState ? (
                        <p className="oc-error">{row.held ? "已暂停" : label(row.sideState!)}</p>
                      ) : null}
                      {row.sourceChanged && <p className="oc-error">导入资料有变化</p>}
                      {row.preparation !== "pushed" &&
                        summary?.blockers.map((message) => (
                          <p key={message} className="oc-row-blocker">
                            {message}
                          </p>
                        ))}
                      <small>更新 {dateTime(row.updatedAt)}</small>
                      {row.labelStatus && row.labelStatus !== "not_due" && (
                        <p
                          className={
                            ["missing", "partial"].includes(row.labelStatus)
                              ? "oc-row-blocker"
                              : "oc-hint"
                          }
                        >
                          {ORDER_LABEL_LABELS[row.labelStatus]}
                          {row.packageCount
                            ? ` · ${row.labeledPackageCount}/${row.packageCount} 包裹`
                            : ""}
                        </p>
                      )}
                      {row.archivedAt && <p className="oc-row-blocker">已归档 · 保留历史</p>}
                    </div>
                    <div className="oc-row-actions">
                      <button
                        className="oc-button primary"
                        disabled={busy || loading}
                        onClick={() => onDetail(row.id, next.module)}
                      >
                        {next.label}
                      </button>
                      <button
                        className="oc-button"
                        disabled={busy || (editState.loading && !editing)}
                        onClick={() => openInline(row)}
                        aria-expanded={editing}
                      >
                        {editing ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        {editing ? "收起编辑" : "展开编辑"}
                      </button>
                      <button
                        className="oc-text-button"
                        disabled={busy}
                        onClick={() => onDetail(row.id)}
                      >
                        审单 / 详情
                      </button>
                    </div>
                  </article>
                  {editing && (
                    <div
                      className="oc-inline-editor"
                      aria-label={`行内编辑 ${row.externalOrderId} / ${row.externalLineId}`}
                    >
                      {!items.some((item) => item.id === row.id) && (
                        <p className="oc-notice">此商品已不符合当前筛选，收起后隐藏。</p>
                      )}
                      <OrderWorkDetailPanel
                        key={row.id}
                        id={row.id}
                        module="orders"
                        inline
                        options={options}
                        editorOpen={false}
                        onEditor={() => onDetail(row.id)}
                        onBack={() => {
                          if (leaveEditor()) onChanged();
                        }}
                        onChanged={onChanged}
                        onStateChange={setEditState}
                      />
                    </div>
                  )}
                </Fragment>
              );
            })}
          </section>
        );
      })}
      <dialog
        ref={imageDialog}
        className="oc-image-dialog"
        onClose={() => setPreview(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setPreview(null);
        }}
      >
        {preview && (
          <>
            <header>
              <span>{preview.label}</span>
              <button
                className="oc-button"
                aria-label="关闭图片预览"
                onClick={() => setPreview(null)}
              >
                <X size={18} />
              </button>
            </header>
            <Image src={preview.path} width={1200} height={1200} alt={preview.label} unoptimized />
            <p>
              {preview.kind === "buyer"
                ? preview.selected
                  ? "已选择用于本件商品制作"
                  : "买家上传图片，尚未选择制作用途"
                : preview.kind === "artwork"
                  ? "绑定的印花素材预览"
                  : "平台定制效果预览"}
            </p>
          </>
        )}
      </dialog>
    </div>
  );
}

function orderFieldPriority(label: string) {
  if (/^size\b|尺寸/i.test(label)) return 0;
  if (/^printing style$/i.test(label)) return 1;
  if (/^style$/i.test(label)) return 2;
  if (/印刷面数/i.test(label)) return 3;
  if (/upload.*image|上传图片/i.test(label)) return 20;
  return 5;
}
function orderFieldLabel(label: string, value: string) {
  if (/^size\b/i.test(label)) return "尺寸";
  if (
    /^style$/i.test(label) &&
    /^(Single-sided Printing|Double-sided Printing|single_sided|double_sided)$/i.test(value)
  )
    return "印刷面数";
  if (/^printing style$/i.test(label) && /^(Only Face|Full Body|Whole Body)$/i.test(value))
    return "裁切范围";
  return label;
}
function orderFieldValue(value: string) {
  return (
    (
      {
        "Only Face": "仅头部",
        "Full Body": "全身",
        "Whole Body": "全身",
        "Single-sided Printing": "单面印刷",
        "Double-sided Printing": "双面印刷",
        single_sided: "单面印刷",
        double_sided: "双面印刷",
      } as Record<string, string>
    )[value] ?? value
  );
}
function orderNextAction(row: OrderWorkListItem): { label: string; module: OrderWorkspaceModule } {
  if (row.archivedAt || row.held || row.sideState) return { label: "查看详情", module: "orders" };
  switch (orderQueueStage(row)) {
    case "needs_information":
      return { label: "补齐资料", module: "orders" };
    case "pending_review":
      return { label: "开始审单", module: "orders" };
    case "ready_to_push":
      return { label: "推送设计", module: "orders" };
    case "in_review":
      return { label: "审核生产图", module: "artwork" };
    case "approved":
      return { label: "查看已审稿", module: "artwork" };
    case "queued":
    case "in_progress":
    case "changes_requested":
      return { label: "查看制图", module: "artwork" };
    case "production":
      return { label: "跟进生产", module: "production" };
    case "ready_to_ship":
      return { label: "安排发货", module: "shipments" };
    case "shipped":
      return { label: "查看物流", module: "shipments" };
    default:
      return { label: "查看详情", module: "orders" };
  }
}

function Check({
  label: title,
  rows,
  selected,
  disabled,
  onChange,
}: {
  label: string;
  rows: OrderWorkListItem[];
  selected: Map<string, OrderWorkListItem>;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null),
    count = rows.filter((row) => selected.has(row.id)).length;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = count > 0 && count < rows.length;
  }, [count, rows.length]);
  return (
    <input
      ref={ref}
      aria-label={title}
      type="checkbox"
      checked={!!rows.length && count === rows.length}
      disabled={disabled || !rows.length}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}
function Thumb({
  item,
  onOpen,
}: {
  item: OrderWorkSummary["images"][number];
  onOpen: (item: OrderWorkSummary["images"][number]) => void;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      className="oc-thumb"
      aria-label={`预览 ${item.label}`}
      onClick={() => (failed ? setFailed(false) : onOpen(item))}
      title={failed ? "图片暂不可用，点击重试" : item.label}
    >
      {failed ? (
        <span>
          图片暂不可用
          <br />
          重试
        </span>
      ) : (
        <Image
          src={
            item.path.startsWith("/api/orders/reports/lines/")
              ? `${item.path}${item.path.includes("?") ? "&" : "?"}thumbnail=1`
              : item.path
          }
          alt={item.label}
          width={64}
          height={64}
          unoptimized
          loading="lazy"
          onError={() => setFailed(true)}
        />
      )}
    </button>
  );
}
