"use client";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from "react";
import Image from "next/image";
import { AlertCircle, Archive, ChevronDown, ChevronUp, CircleHelp, FileClock, FileX2, LoaderCircle, RefreshCw, ScanSearch, Sparkles, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { ASSIST_INTENT_CLEAR_EVENT } from "@yummyai/contracts/ai/assist-recovery";
import {
  OrderWorkListViewSchema,
  OrderWorkSummariesSchema,
  type OrderCenterOptions,
  type OrderWorkListItem,
  type OrderWorkSummary,
  type OrderWorkspaceModule,
} from "@yummyai/contracts/order/workspace";
import {
  orderOperatorTask,
  orderOperatorException,
} from "@yummyai/contracts/order/workbench";
import { OrderWorkDetailPanel, type OrderReviewState } from "./order-work-detail";
import { OrderBulkPanel, type BulkOperation } from "./order-bulk-panel";
import { centerRequest, dateTime, OrderCenterRequestError } from "./order-center-model";
import { OrderDeadlineSummary } from "./order-deadline-summary";
import { OrderLifecycleBadge } from "./order-lifecycle";
import { useErpAccess } from "../identity/erp-access";
import { orderSummaryMessages, orderSummaryState, type OrderSummaryState } from "./order-summary-state";
import { orderCustomizationHighlights, orderFieldLabel, orderFieldPriority, orderFieldValue, orderLineUnits, orderProductLabel } from "./order-operations-summary";
import { reconcileOrderProductSelection } from "./order-product-selection-model";

const initialState: OrderReviewState = { dirty: false, busy: false, loading: false };
type ProductListProps = {
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
};
type SummaryRead = { key: string; values: Map<string, OrderWorkSummary>; pending: Set<string>; failed: Set<string>; complete: boolean; denied: boolean };
type ImageReference = { rowId: string; key: string; path: string; kind: OrderWorkSummary["images"][number]["kind"] };
const emptySummaries = new Map<string, OrderWorkSummary>();
const emptyIds = new Set<string>();

export function OrderProductList(props: ProductListProps) {
  const access = useErpAccess(), identityKey = JSON.stringify([access.preferenceScope, access.authority]);
  const identity = useRef(identityKey); identity.current = identityKey;
  return <OrderProductListContent key={identityKey} {...props} identityKey={identityKey} identity={identity}
    canRead={access.can(Permission.OrderRead) && access.can(Permission.OrderPiiRead)} />;
}

function OrderProductListContent({
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
  identityKey, identity, canRead,
}: ProductListProps & { identityKey: string; identity: MutableRefObject<string>; canRead: boolean }) {
  const [selected, setSelected] = useState(new Map<string, OrderWorkListItem>());
  const [summaryRead, setSummaryRead] = useState<SummaryRead>({ key: "", values: new Map(), pending: new Set(), failed: new Set(), complete: false, denied: false });
  const [summaryError, setSummaryError] = useState("");
  const [summaryRefresh, setSummaryRefresh] = useState(0),
    [error, setError] = useState("");
  const [inlineChoice, setInlineRow] = useState<{ row: OrderWorkListItem; key: string; epoch: number } | null>(null),
    [editState, setEditState] = useState(initialState);
  const [bulk, setBulk] = useState<BulkOperation | null>(null),
    [bulkBusy, setBulkBusy] = useState(false),
    [selectionBusy, setSelectionBusy] = useState(false);
  const [expanded, setExpanded] = useState(false),
    [preview, setPreview] = useState<ImageReference | null>(null);
  const [selectionNotice, setSelectionNotice] = useState(""), [cleared, setCleared] = useState(false);
  const imageDialog = useRef<HTMLDialogElement>(null);
  const scopeParams = new URLSearchParams(query);
  scopeParams.delete("page");
  scopeParams.delete("pageSize");
  const scope = scopeParams.toString();
  const readRows = new Map(selected);
  for (const item of items) readRows.set(item.id, item);
  if (inlineChoice && !readRows.has(inlineChoice.row.id)) readRows.set(inlineChoice.row.id, inlineChoice.row);
  const idsKey = [...readRows.values()].map(item => `${item.id}:${item.revision}:${item.projectionVersion}:${item.archivedAt ?? ""}`).sort().join(",");
  const summaryKey = JSON.stringify([identityKey, query, idsKey, refresh, summaryRefresh, loading, unavailable, cleared, canRead]);
  const accepted = summaryRead.key === summaryKey && !loading && !unavailable && canRead && !cleared;
  const summaries = accepted ? summaryRead.values : emptySummaries;
  const pendingIds = accepted ? summaryRead.pending : emptyIds, failedIds = accepted ? summaryRead.failed : emptyIds;
  const stateFor = useCallback((row: OrderWorkListItem): OrderSummaryState => {
    const state = orderSummaryState(summaries.get(row.id), {
      revision: row.revision, loading: !unavailable && canRead && !cleared && (loading || !accepted || pendingIds.has(row.id)), failed: failedIds.has(row.id),
    });
    return state === "available" && row.archivedAt ? "unknown" : state;
  }, [summaries, unavailable, canRead, cleared, loading, accepted, pendingIds, failedIds]);
  const usable = useCallback((row: OrderWorkListItem) => !row.archivedAt && stateFor(row) === "available", [stateFor]);
  const inlineRow = inlineChoice?.key === summaryKey && usable(inlineChoice.row) ? inlineChoice.row : null;
  const previewSummary = preview?.key === summaryKey ? summaries.get(preview.rowId) : undefined;
  const previewRow = preview ? readRows.get(preview.rowId) : undefined;
  const currentPreview = preview && previewSummary && previewRow && usable(previewRow)
    ? previewSummary.images.find(image => image.path === preview.path && image.kind === preview.kind) : undefined;
  const alive = useRef(true), purged = useRef(false), readSequence = useRef(0), selectionSequence = useRef(0), inlineEpoch = useRef(0);
  const activeRead = useRef<AbortController | null>(null), activeSelection = useRef<AbortController | null>(null);
  const live = useRef({ summaryKey, scope, canRead }); live.current = { summaryKey, scope, canRead };
  const busy = bulkBusy || selectionBusy || editState.busy;
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  useLayoutEffect(() => {
    alive.current = true;
    const clear = () => {
      purged.current = true; readSequence.current++; selectionSequence.current++; inlineEpoch.current++;
      activeRead.current?.abort(); activeSelection.current?.abort(); imageDialog.current?.close();
      setPreview(null); setInlineRow(null); setEditState(initialState); setBulk(null); setSelected(new Map());
      setSummaryRead({ key: "", values: new Map(), pending: new Set(), failed: new Set(), complete: false, denied: false });
      setSummaryError(""); setSelectionNotice(""); setSelectionBusy(false); setCleared(true);
    };
    window.addEventListener(ASSIST_INTENT_CLEAR_EVENT, clear);
    return () => { alive.current = false; readSequence.current++; selectionSequence.current++; activeRead.current?.abort(); activeSelection.current?.abort(); window.removeEventListener(ASSIST_INTENT_CLEAR_EVENT, clear); };
  }, []);
  useLayoutEffect(() => {
    inlineEpoch.current++;
    setSelected(new Map());
    setBulk(null);
    setInlineRow(null);
    setEditState(initialState);
    setSelectionNotice("");
  }, [scope]);
  useEffect(() => {
    setSelected(current => reconcileOrderProductSelection(current, items));
  }, [items]);
  useEffect(() => {
    const abort = new AbortController(), sequence = ++readSequence.current;
    activeRead.current?.abort(); activeRead.current = abort;
    const valid = () => alive.current && !purged.current && !abort.signal.aborted && sequence === readSequence.current
      && identity.current === identityKey && live.current.summaryKey === summaryKey && live.current.canRead;
    setSummaryError("");
    const ids = idsKey
      .split(",")
      .filter(Boolean)
      .map((value) => value.split(":")[0]!);
    setSummaryRead({ key: summaryKey, values: new Map(), pending: new Set(ids), failed: new Set(), complete: false, denied: false });
    if (loading || unavailable || !canRead || purged.current) return () => abort.abort();
    void (async () => {
      for (let index = 0; index < ids.length; index += 100) {
        const batch = ids.slice(index, index + 100);
        try {
          if (!valid()) return;
          const result = OrderWorkSummariesSchema.parse(await centerRequest("summaries", { ids: batch }, AbortSignal.any([abort.signal, AbortSignal.timeout(30_000)])));
          if (!valid()) return;
          if (new Set(result.items.map(item => item.id)).size !== result.items.length || result.items.some(item => !batch.includes(item.id)))
            throw new Error("summary_target_mismatch");
          setSummaryRead(current => {
            if (current.key !== summaryKey) return current;
            const pending = new Set(current.pending); for (const id of batch) pending.delete(id);
            return { ...current, values: new Map([...current.values, ...result.items.map(item => [item.id, item] as const)]), pending };
          });
        } catch (cause) {
          if (!valid()) return;
          if (cause instanceof OrderCenterRequestError && ([401, 403, 404].includes(cause.status) || cause.code === "authority_changed")) {
            setSummaryRead({ key: summaryKey, values: new Map(), pending: new Set(), failed: new Set(), complete: true, denied: true });
            setSummaryError("当前无法读取定制资料 旧内容已隐藏 请核对当前本人权限"); return;
          }
          setSummaryRead(current => {
            if (current.key !== summaryKey) return current;
            const pending = new Set(current.pending), failed = new Set(current.failed);
            for (const id of batch) { pending.delete(id); failed.add(id); }
            return { ...current, pending, failed };
          });
          setSummaryError("部分定制内容暂时读取失败 其他已读取商品行不受影响");
        }
      }
      if (valid()) setSummaryRead(current => current.key === summaryKey ? { ...current, complete: true } : current);
    })();
    return () => abort.abort();
  }, [idsKey, summaryKey, identity, identityKey, loading, unavailable, canRead]);
  useLayoutEffect(() => {
    selectionSequence.current++; inlineEpoch.current++; activeSelection.current?.abort(); setSelectionBusy(false);
    setInlineRow(current => current?.key === summaryKey ? current : null); setEditState(initialState);
  }, [summaryKey]);
  useLayoutEffect(() => {
    if (!accepted || !summaryRead.complete) return;
    const unavailableIds = [...selected.values()].filter(row => !usable(row)).map(row => row.id);
    if (unavailableIds.length) {
      setSelected(current => new Map([...current].filter(([id]) => !unavailableIds.includes(id))));
      setBulk(null); setSelectionNotice(`${unavailableIds.length} 个商品行的定制内容尚不可读取 已取消选择 订单历史仍可查看`);
    } else if (selectionNotice.startsWith("正在核对所选商品")) {
      // Do not dispatch a no-op layout update when the selection is already settled.
      setSelectionNotice(`已读取 ${selected.size} 商品行的当前定制内容`);
    }
    if (inlineChoice && !usable(inlineChoice.row)) { inlineEpoch.current++; setInlineRow(null); setEditState(initialState); }
  }, [summaryRead, accepted, selected, inlineChoice, usable, selectionNotice]);
  const leaveEditor = useCallback(() => {
    if (busy || editState.loading) return false;
    if (editState.dirty && !window.confirm("本件商品有未保存的修改，确定放弃修改？")) return false;
    inlineEpoch.current++;
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
  useLayoutEffect(() => {
    if (currentPreview) { if (!imageDialog.current?.open) imageDialog.current?.showModal(); }
    else { imageDialog.current?.close(); if (preview) setPreview(null); }
  }, [currentPreview, preview]);
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
    if (busy || loading || purged.current || identity.current !== identityKey) return;
    const next = new Map(selected);
    for (const row of rows) {
      if (checked && usable(row)) next.set(row.id, row);
      else next.delete(row.id);
    }
    if (next.size > 100) {
      setError("单批最多选择 100 个商品行，请缩小范围或分批处理。");
      return;
    }
    setError("");
    setSelectionNotice("");
    setSelected(next);
    setBulk(null);
  }
  async function selectAll() {
    if (busy || loading || unavailable || !canRead || purged.current) return;
    const sequence = ++selectionSequence.current, key = summaryKey, controller = new AbortController();
    activeSelection.current?.abort(); activeSelection.current = controller;
    const valid = () => alive.current && !purged.current && !controller.signal.aborted && selectionSequence.current === sequence
      && live.current.summaryKey === key && identity.current === identityKey && live.current.canRead;
    setSelectionBusy(true);
    setError(""); setSelectionNotice("");
    try {
      const result = OrderWorkListViewSchema.pick({ items: true }).parse(
        await centerRequest("selection", Object.fromEntries(new URLSearchParams(query)), AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])),
      );
      if (!valid()) return;
      if (result.items.length > 100 || new Set(result.items.map(row => row.id)).size !== result.items.length)
        throw new Error("selection_target_mismatch");
      setSelected(new Map(result.items.map((row) => [row.id, row])));
      setBulk(null);
      setSelectionNotice("正在核对所选商品的定制内容 只有当前可读取的商品行可进入批量操作");
    } catch {
      if (valid()) setError("筛选结果暂时无法核对 未建立新的批量操作 请重新读取");
    } finally {
      if (valid()) setSelectionBusy(false);
    }
  }
  function openInline(row: OrderWorkListItem) {
    if (purged.current || identity.current !== identityKey || !usable(row)) return;
    if (leaveEditor()) {
      setInlineRow(inlineRow?.id === row.id ? null : { row, key: summaryKey, epoch: ++inlineEpoch.current });
      setBulk(null);
    }
  }
  function openBulk(operation: BulkOperation) {
    if (purged.current || identity.current !== identityKey || !selected.size || [...selected.values()].some(row => !usable(row))) {
      setError("请先核对所选商品的当前定制资料 未确认可用前不开放批量操作"); return;
    }
    if (leaveEditor()) setBulk(operation);
  }
  function openPreview(row: OrderWorkListItem, image: OrderWorkSummary["images"][number]) {
    if (purged.current || identity.current !== identityKey || live.current.summaryKey !== summaryKey || !usable(row)) return;
    setPreview({ rowId: row.id, key: summaryKey, path: image.path, kind: image.kind });
  }
  const displayRows =
    inlineRow && !items.some((row) => row.id === inlineRow.id) ? [...items, inlineRow] : items;
  const groups = new Map<string, OrderWorkListItem[]>();
  for (const row of displayRows) groups.set(row.orderId, [...(groups.get(row.orderId) ?? []), row]);
  const selectedRows = [...selected.values()];
  const selectionReady = selectedRows.length > 0 && selectedRows.every(usable);
  const pageRows = items.filter(usable);
  const outside = selectedRows.filter((row) => !items.some((item) => item.id === row.id)).length;
  return (
    <div className="oc-order-list">
      <div className="oc-selection-bar" hidden={unavailable}>
        <Check
          label="选择本页商品"
          rows={pageRows}
          selected={selected}
          disabled={busy || loading || !canRead || cleared}
          onChange={(checked) => toggle(pageRows, checked)}
        />
        <span>
          {loading ? "正在读取本页商品行与件数…" : <>
            本页 {items.length} 商品行 · {orderLineUnits(items)} 件 · 内容可读取 {pageRows.length} 行 · 已选 {selected.size} 行 · {orderLineUnits(selectedRows)} 件
            {outside > 0 ? `（其中其他页 ${outside} 行）` : ""}
          </>}
        </span>
        <button
          className="oc-text-button"
          disabled={busy || loading || !canRead || cleared}
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
            disabled={!canRead || cleared || unavailable}
            onChange={(event) => setExpanded(event.target.checked)}
          />
          展开全部定制内容
        </label>
      </div>
      {!!selected.size && !unavailable && (
        <div className="oc-batch-toolbar" aria-label="所选商品批量操作">
          <strong>已选 {selected.size} 商品行 · {orderLineUnits(selectedRows)} 件</strong>
          <button className="oc-button" disabled={busy || !selectionReady} onClick={() => openBulk("check")}>
            <ScanSearch size={15} />
            检查缺项
          </button>
          <button className="oc-button" disabled={busy || !selectionReady} onClick={() => openBulk("ai")}>
            <Sparkles size={15} />
            AI 预审
          </button>
          <button className="oc-button" disabled={busy || !selectionReady} onClick={() => openBulk("bind")}>
            绑定印花 / 产品
          </button>
          <button className="oc-button" disabled={busy || !selectionReady} onClick={() => openBulk("assign")}>
            设计安排
          </button>
          <button
            className="oc-button"
            disabled={busy || !selectionReady}
            onClick={() => openBulk("needs_information")}
          >
            待补资料
          </button>
          <button className="oc-button" disabled={busy || !selectionReady} onClick={() => openBulk("ready_to_push")}>
            确认审单
          </button>
          <button className="oc-button primary" disabled={busy || !selectionReady} onClick={() => openBulk("push")}>
            推送设计
          </button>
        </div>
      )}
      {selectionNotice && <p role="status" className="oc-summary-selection-notice">{selectionNotice}</p>}
      {!canRead && <p role="status" className="oc-summary-selection-notice">当前账号无法读取定制资料 不显示旧内容或开放编辑与制作 请核对本人权限</p>}
      {cleared && <p role="status" className="oc-summary-selection-notice">本人会话已清除 旧定制内容 图片与未保存编辑已关闭</p>}
      {error && (
        <p role="alert" className="oc-error">
          {error}
        </p>
      )}
      {summaryError && (
        <p role="alert" className="oc-error">
          {summaryError}{" "}
          <button
            className="oc-text-button"
            disabled={busy || loading || !canRead || cleared}
            onClick={() => setSummaryRefresh((value) => value + 1)}
          >
            重新读取定制资料
          </button>
        </p>
      )}
      {bulk && selectionReady && !unavailable && !cleared && (
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
        <p className="oc-empty">没有符合条件的订单。</p>
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
                rows={rows.filter((row) => items.includes(row) && usable(row))}
                selected={selected}
                disabled={busy || loading}
                onChange={(checked) =>
                  toggle(
                    rows.filter((row) => items.includes(row) && usable(row)),
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
              <span>当前筛选 {rows.length} 商品行 · {orderLineUnits(rows)} 件</span>
              <span>整单 {first.orderLineCount === undefined ? "行数待核对" : `${first.orderLineCount} 商品行`} · {first.orderQuantity === undefined ? "件数待核对" : `${first.orderQuantity} 件`}</span>
              <OrderLifecycleBadge status={first.orderStatus} />
            </header>
            <div className="oc-product-columns" aria-hidden="true">
              <span />
              <span>商品 / 数量</span>
              <span>下一步 / 负责岗位</span>
              <span>平台发货截止</span>
              <span>操作</span>
            </div>
            {rows.map((row) => {
              const sourceState = stateFor(row), summary = usable(row) ? summaries.get(row.id) : undefined,
                editing = row.id === inlineRow?.id;
              const fields = (summary?.fields.filter((field) => field.value.trim()) ?? []).sort(
                (a, b) => orderFieldPriority(a.label) - orderFieldPriority(b.label),
              );
              const artwork = summary?.images.find((image) => image.kind === "artwork"),
                product = summary?.images.find((image) => image.kind === "preview");
              const buyerImages = summary?.images.filter((image) => image.kind === "buyer") ?? [];
              const contentAvailable = sourceState === "available", status = orderSummaryMessages[sourceState];
              const next = orderOperatorTask(row);
              return (
                <Fragment key={row.id}>
                  <article
                    className={`oc-product-row${selected.has(row.id) ? " selected" : ""}${editing ? " editing" : ""}`}
                    data-task={next.key}
                    data-summary-availability={sourceState}
                    aria-label={`商品 ${row.externalLineId} ${row.skuCode ?? row.title}`}
                  >
                    <input
                      type="checkbox"
                      aria-label={`选择商品 ${row.externalOrderId} / ${row.externalLineId}`}
                      checked={selected.has(row.id)}
                      disabled={busy || loading || !contentAvailable}
                      onChange={(event) => toggle([row], event.target.checked)}
                    />
                    <div className="oc-product-basis">
                      <div className="oc-product-media">
                        {product ? (
                          <Thumb key={`${summaryKey}:${product.path}`} item={product} onOpen={image => openPreview(row, image)} />
                        ) : (
                          <span className="oc-thumb-placeholder">
                            {contentAvailable ? "无平台预览" : status.short}
                          </span>
                        )}
                        <div>
                          <strong className="oc-rich-title">
                            {orderProductLabel(row)} · {row.quantity} 件
                          </strong>
                          <details className="oc-original-title"><summary>平台原商品标题</summary><p>{row.title}</p></details>
                          <p>商品 SKU：{row.skuCode ?? "未提供"}</p>
                          <p>
                            商品行 {row.externalLineId} · 数量 {row.quantity} 件
                          </p>
                          {contentAvailable && (row.specificationName ?? summary?.specification) && <p>{row.specificationName ?? summary?.specification}</p>}
                          {contentAvailable && <dl className="oc-primary-customization" aria-label="本件定制要求">
                            {orderCustomizationHighlights(fields).map((field, index) => <div key={`${field.label}:${index}`}>
                              <dt title={field.label}>{orderFieldLabel(field.label, field.value)}</dt><dd title={field.value}>{orderFieldValue(field.value)}</dd>
                            </div>)}
                          </dl>}
                        </div>
                      </div>
                      <div className={`oc-summary-state${contentAvailable ? " available" : ""}`} aria-label="定制资料状态" data-summary-availability={sourceState}>
                        {contentAvailable ? <span className="oc-summary-available">定制内容可读取</span> : <SummaryState key={sourceState} state={sourceState}
                          denied={accepted && summaryRead.denied} onRetry={busy || !canRead || cleared || unavailable ? undefined : () => setSummaryRefresh(value => value + 1)} />}
                      </div>
                      {summary && <details className="oc-row-context" open={expanded || undefined}>
                        <summary>定制内容与制作依据</summary>
                      <div className="oc-print-binding">
                        {artwork && <Thumb key={`${summaryKey}:${artwork.path}`} item={artwork} onOpen={image => openPreview(row, image)} />}
                        <div>
                          <p>
                            印花 SKU：
                            <strong>{summary.printSku ?? row.printSku ?? "待匹配"}</strong>
                          </p>
                          <p>
                            产品 SPU：
                            {row.spuCode ?? summary.spu ?? "待匹配"}
                          </p>
                          <p>
                            规格：
                            {row.specificationName ?? summary.specification ?? "待选择尺寸 / 形状 / 颜色"}
                          </p>
                        </div>
                      </div>
                    <div className="oc-custom-summary">
                      {summary && (
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
                                    <Thumb key={`${summaryKey}:${item.path}`} item={item} onOpen={image => openPreview(row, image)} />
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
                                      <Thumb key={`${summaryKey}:${item.path}:${index}`} item={item} onOpen={image => openPreview(row, image)} />
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
                      </details>}
                    </div>
                    <div className="oc-product-status">
                      <strong className="oc-next-task">{contentAvailable ? next.title : `原订单进度 · ${next.title}`}</strong>
                      {contentAvailable ? <><p className="oc-task-owner">{next.actionable ? "负责岗位" : "等待"}：{next.owner}</p>
                        <p className="oc-task-description">{next.description}</p></> : <p className="oc-task-description">可查看订单历史与允许读取的业务进度 当前不按旧定制内容编辑或制作</p>}
                      <div className="oc-statuses">
                        {orderOperatorException(row) && <span className="oc-badge warning">需关注</span>}
                      </div>
                      <small>最近更新 {dateTime(row.updatedAt)}</small>
                    </div>
                    <OrderDeadlineSummary row={row} />
                    <div className="oc-row-actions">
                      <button
                        className={`oc-button${contentAvailable && next.actionable ? " primary" : ""}`}
                        disabled={busy || loading}
                        onClick={() => onDetail(row.id, contentAvailable ? next.module : undefined)}
                      >
                        {contentAvailable ? next.action : "查看订单历史"}
                      </button>
                      <details className="oc-row-more"><summary>更多</summary>
                      {contentAvailable && <button
                        className="oc-button"
                        disabled={busy || (editState.loading && !editing)}
                        onClick={() => openInline(row)}
                        aria-expanded={editing}
                      >
                        {editing ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        {editing ? "收起编辑" : "展开编辑"}
                      </button>}
                      <button
                        className="oc-text-button"
                        disabled={busy}
                        onClick={() => onDetail(row.id)}
                      >
                        {contentAvailable ? "审单 / 详情" : "查看允许的订单记录"}
                      </button>
                      </details>
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
                        key={`${row.id}:${summaryKey}:${inlineChoice?.epoch}`}
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
                        onStateChange={state => { if (alive.current && !purged.current && identity.current === identityKey && live.current.summaryKey === summaryKey && inlineChoice?.epoch === inlineEpoch.current) setEditState(state); }}
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
        aria-label="商品图片预览"
        onClose={() => setPreview(null)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setPreview(null);
        }}
      >
        {currentPreview && (
          <>
            <header>
              <span>{currentPreview.label}</span>
              <button
                className="oc-button"
                aria-label="关闭图片预览"
                onClick={() => setPreview(null)}
              >
                <X size={18} />
              </button>
            </header>
            <Image src={currentPreview.path} width={1200} height={1200} alt={currentPreview.label} unoptimized />
            <p>
              {currentPreview.kind === "buyer"
                ? currentPreview.selected
                  ? "已选择用于本件商品制作"
                  : "买家上传图片，尚未选择制作用途"
                : currentPreview.kind === "artwork"
                  ? "绑定的印花素材预览"
                  : "平台定制效果预览"}
            </p>
          </>
        )}
      </dialog>
    </div>
  );
}

function SummaryState({ state, denied, onRetry }: { state: OrderSummaryState; denied: boolean; onRetry?: () => void }) {
  const message = orderSummaryMessages[state];
  const Icon = state === "cleared" ? FileX2 : state === "expired" ? FileClock : state === "archived" ? Archive
    : state === "failed" ? AlertCircle : state === "loading" ? LoaderCircle : CircleHelp;
  return <div className={`oc-summary-status ${state}`} role={state === "failed" ? "alert" : "status"} aria-busy={state === "loading"}>
    <Icon size={15} aria-hidden="true" className={state === "loading" ? "oc-summary-spinner" : undefined} />
    <div><strong>{message.title}</strong><p>{denied ? "当前无法读取本件定制资料 请核对本人权限 旧内容不会继续用于编辑或制作" : message.reason}</p>
      {onRetry && (state === "failed" || state === "unknown") && <button type="button" className="oc-text-button" onClick={onRetry}>
        <RefreshCw size={12} aria-hidden="true" />{state === "failed" ? "重试读取定制资料" : "重新核对资料状态"}
      </button>}
    </div>
  </div>;
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
