"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FileUp, RefreshCw } from "lucide-react";
import {
  OrderCenterOptionsSchema,
  OrderWorkListViewSchema,
  type OrderWorkListItem,
  type OrderWorkspaceModule,
  type OrderCenterOptions,
} from "@yummyai/contracts/order/workspace";
import { centers, centerRead, dateTime } from "./order-center-model";
import { OrderReviewDrawer } from "./order-review-drawer";
import { OrderProductList } from "./order-product-list";
import { OrderFulfillmentList } from "./order-fulfillment-list";
import { orderReviewQueue } from "./order-whole-detail-model";
import { OrderLifecycleSummary, OrderWorkbenchFilters, legacyWorkflowFilters } from "./order-workbench-toolbar";
import { OrderLifecycleBadge } from "./order-lifecycle";
import type { OrderQueueCounts } from "@yummyai/contracts/order/workbench";
import { orderOperatorTask } from "@yummyai/contracts/order/workbench";
import "./order-centers.css";
import "./order-operator.css";
import { returnHref } from "../navigation/workflow-href";
import { orderMatchingSummary } from "./order-operations-summary";
import { OrderDeadlineSummary } from "./order-deadline-summary";

const empty: {
  items: OrderWorkListItem[];
  total: number;
  page: number;
  pageSize: number;
  groupTotal?: number;
  matchingQuantity?: number;
  counts?: OrderQueueCounts;
} = { items: [], total: 0, page: 1, pageSize: 25 };
const queryKeys = [
  "q",
  "accountId",
  "platform",
  "batchId",
  "preparation",
  "artwork",
  "proof",
  "production",
  "shipment",
  "afterSales",
  "caseScope",
  "attention",
  "from",
  "to",
  "page",
  "pageSize",
  "stage",
  "sku",
  "printSku",
  "spu",
  "specification",
  "productType",
  "designExecutor",
  "labelStatus",
  "dateField",
  "timeZone",
  "orderNumbers",
  "archived",
  "workView",
  "orderStatus",
];
type SavedView = { name: string; query: string };
export function OrderCenterWorkspace({ module }: { module: OrderWorkspaceModule }) {
  const params = useSearchParams(),
    router = useRouter(),
    pathname = usePathname(),
    current = params.toString(),
    lineId = params.get("line"),
    center = centers[module],
    returnTo = returnHref(params.get("returnTo"));
  const [data, setData] = useState(empty),
    [options, setOptions] = useState<OrderCenterOptions | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [fetchLoading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0),
    [busy, setBusy] = useState(false);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [optionsError, setOptionsError] = useState("");
  const [saved, setSaved] = useState<SavedView[]>([]),
    [viewName, setViewName] = useState("");
  const navigationGuard = useRef<() => boolean>(() => true);
  const [reviewQueue, setReviewQueue] = useState<string[] | null>(null);
  const [reviewOrderIds, setReviewOrderIds] = useState<Record<string, string>>({});
  const reviewModes = useRef(new Map<string, OrderWorkspaceModule>());
  const legacyFilters = legacyWorkflowFilters.filter(key => !!params.get(key) && params.get(key) !== "all");
  const listSearch = new URLSearchParams({
    module,
    ...(["orders", "production", "shipments", "after-sales"].includes(module) ? { grouping: "orders" } : {}),
  });
  for (const key of queryKeys) {
    const value = params.get(key);
    if (value) listSearch.set(key, value);
  }
  if (!listSearch.has("workView")) listSearch.set("workView", "all");
  const listQuery = listSearch.toString();
  const loading = fetchLoading || loadedQuery !== listQuery;
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void centerRead(`workspace?${listQuery}`, abort.signal)
      .then((rows) => {
        if (!abort.signal.aborted) {
          setData(OrderWorkListViewSchema.parse(rows));
        }
      })
      .catch((cause) => {
        if (!abort.signal.aborted) {
          setData(empty);
          setError(cause instanceof Error ? cause.message : "读取失败");
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) {
          setLoadedQuery(listQuery);
          setLoading(false);
        }
      });
    return () => abort.abort();
  }, [listQuery, refresh]);
  useEffect(() => {
    const abort = new AbortController();
    setOptionsError("");
    void centerRead("options", abort.signal)
      .then((value) => {
        if (!abort.signal.aborted) setOptions(OrderCenterOptionsSchema.parse(value));
      })
      .catch(() => {
        if (!abort.signal.aborted) {
          setOptions(null);
          setOptionsError("店铺与制作选项暂时无法读取，可刷新重试；其他筛选仍可使用。");
        }
      });
    return () => abort.abort();
  }, [module, refresh]);
  useEffect(() => {
    if (!lineId) { setReviewQueue(null); setReviewOrderIds({}); }
    else if (!loading && !reviewQueue) {
      reviewModes.current = new Map(data.items.map(row => [row.id, module === "orders" ? orderOperatorTask(row).module : module]));
      setReviewOrderIds(Object.fromEntries(data.items.map(row => [row.id, row.orderId])));
      setReviewQueue(
        data.items.some((row) => row.id === lineId) ? orderReviewQueue(data.items, lineId) : [lineId],
      );
    }
  }, [lineId, loading, data.items, reviewQueue, params, module]);
  useEffect(() => {
    if (!options) return;
    try {
      const value: unknown = JSON.parse(
        localStorage.getItem(`order-center-views:${options.preferenceScope}:${module}`) ?? "[]",
      );
      if (Array.isArray(value))
        setSaved(
          value
            .filter(
              (entry): entry is SavedView =>
                !!entry && typeof entry.name === "string" && typeof entry.query === "string",
            )
            .slice(0, 20),
        );
    } catch {
      setSaved([]);
    }
  }, [options?.preferenceScope, module]);
  function go(href: string, replace = false) {
    const next = new URL(href, window.location.href);
    if (next.href === window.location.href || !navigationGuard.current()) return;
    // Filters and the review drawer already read their data on the client. Native
    // history updates useSearchParams without rerunning the server page/layout.
    // A different page or the report-import view still needs a real navigation.
    if (next.pathname !== pathname || next.searchParams.get("view") !== params.get("view")) {
      if (replace) router.replace(href);
      else router.push(href);
    } else if (replace) window.history.replaceState(null, "", href);
    else window.history.pushState(null, "", href);
  }
  function navigate(changes: Record<string, string | null>, replace = false) {
    const next = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    if ("line" in changes && !changes.line) {
      next.delete("queue");
      next.delete("detailMode");
    }
    go(next.size ? `${pathname}?${next}` : pathname, replace);
  }
  function openLine(id: string, detailMode?: OrderWorkspaceModule) {
    const queue = orderReviewQueue(data.items, id);
    reviewModes.current = new Map(data.items.map(row => [row.id, module === "orders" ? orderOperatorTask(row).module : module]));
    setReviewOrderIds(Object.fromEntries(data.items.map(row => [row.id, row.orderId])));
    const target = detailMode ?? reviewModes.current.get(id) ?? module;
    setReviewQueue(queue);
    navigate({
      line: id,
      editor: null,
      queue: queue.join(","),
      detailMode: target === module ? null : target,
    });
  }
  function filter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget),
      next: Record<string, string | null> = { page: null, line: null, editor: null };
    for (const key of queryKeys.filter(
      (key) => key !== "page" && key !== "pageSize" && key !== "batchId",
    ))
      next[key] = String(form.get(key) ?? "") || null;
    navigate(next);
  }
  function saveView() {
    if (!options || !viewName.trim()) return;
    const query = new URLSearchParams(current);
    query.delete("line");
    query.delete("editor");
    query.delete("page");
    query.delete("queue");
    query.delete("returnTo");
    query.delete("detailMode");
    const next = [
      ...saved.filter((view) => view.name !== viewName.trim()),
      { name: viewName.trim(), query: query.toString() },
    ].slice(-20);
    setSaved(next);
    try {
      localStorage.setItem(
        `order-center-views:${options.preferenceScope}:${module}`,
        JSON.stringify(next),
      );
    } catch {
      setNotice("当前浏览器无法持久保存视图，本次打开期间仍可使用。");
    }
    setViewName("");
  }
  return (
    <main className="oc-page oc-workbench" aria-busy={loading}>
      <header className="oc-header">
        <div>
          <h1>{center.title}</h1>
          {returnTo && !lineId && <Link className="oc-text-button" href={returnTo} onClick={event => { event.preventDefault(); go(returnTo); }}>返回来源页面</Link>}
          <p>{module === "orders" ? "按整单跟进处理、审核、生产和出库。每个订单显示一个状态和下一步。" : center.description}</p>
        </div>
        <div className="oc-actions">
          {module === "production" && <Link className="oc-button" href="/production?view=native">已审核设计直接生产</Link>}
          {module === "shipments" && <Link className="oc-button" href="/shipments?view=logistics">物流订单同步</Link>}
          {["production", "shipments"].includes(module) && <Link className="oc-button" href="/logistics">物流下单</Link>}
            <details className="oc-view-menu">
              <summary className="oc-button">我的视图</summary>
              <div>
                <label>
                  保存的视图
                  <select
                    value=""
                    onChange={(event) => {
                      if (event.target.value) go(`${pathname}?${event.target.value}`);
                    }}
                  >
                    <option value="">选择视图</option>
                    {saved.map((view) => (
                      <option key={view.name} value={view.query}>
                        {view.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  视图名称
                  <input
                    value={viewName}
                    maxLength={60}
                    placeholder="例如：今天待审核"
                    onChange={(event) => setViewName(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="oc-button"
                  disabled={!viewName.trim()}
                  onClick={saveView}
                >
                  保存当前筛选
                </button>
                <small>保存在当前浏览器，按账号区分。</small>
              </div>
            </details>
          {module === "orders" && (
            <Link className="oc-button" href="/orders?view=reports">
              <FileUp size={16} />
              导入订单报告
            </Link>
          )}
          <button
            className="oc-button"
            onClick={() => setRefresh((value) => value + 1)}
            disabled={loading || busy}
          >
            <RefreshCw size={16} />
            刷新
          </button>
        </div>
      </header>
      {module === "after-sales" && <div className="oc-case-scope"><p className="oc-hint">优先处理未结案问题。已结案记录保留在订单内。</p><button className="oc-text-button" disabled={loading || busy} onClick={() => navigate({ caseScope: params.get("caseScope") === "all" ? null : "all", afterSales: null, page: null, line: null })}>{params.get("caseScope") === "all" ? "只看未结案" : "查看全部售后订单"}</button></div>}
      <OrderLifecycleSummary counts={loading || error ? undefined : data.counts} />
      <OrderWorkbenchFilters key={listQuery} query={current} options={options}
        disabled={busy || (!options && !optionsError)} onSubmit={filter} onClear={() => go(pathname)}
        onAttentionChange={attention => navigate({ attention, page: null, line: null, editor: null })} />
      {!!legacyFilters.length && <p className="oc-notice" role="status">
        当前链接保留了旧版环节筛选；查询或清除后即可按统一订单状态筛选。
        <button className="oc-text-button" onClick={() => navigate({
          ...Object.fromEntries(legacyWorkflowFilters.map(key => [key, null])), page: null, line: null,
        })}>清除旧版筛选</button>
      </p>}
      {optionsError && (
        <p className="oc-notice" role="status">
          {optionsError}
        </p>
      )}
      {error && (
        <div className="oc-error oc-read-error" role="alert">
          <span>订单列表读取失败：{error}</span>
          <button
            className="oc-button"
            disabled={loading || busy}
            onClick={() => setRefresh((value) => value + 1)}
          >
            重新加载订单
          </button>
        </div>
      )}
      {notice && (
        <p className="oc-notice" role="status">
          {notice}
        </p>
      )}
      <div className="oc-list-summary" aria-label="当前订单列表统计" aria-live="polite">
        <span>
          {orderMatchingSummary(data, { loading, failed: !!error })}
        </span>
        {
          <button
            className="oc-button primary"
            disabled={loading || busy || !data.items.length}
            onClick={() =>
              data.items[0] &&
              openLine(data.items[0].id)
            }
          >
            {module === "orders" ? "开始处理订单" : "连续处理"}
          </button>
        }
      </div>
      {module === "orders" ? (
        <OrderProductList
          items={data.items}
          query={listQuery}
          loading={loading}
          unavailable={!!error}
          refresh={refresh}
          options={options}
          navigationGuard={navigationGuard}
          onBusy={setBusy}
          onChanged={() => setRefresh((value) => value + 1)}
          onDetail={openLine}
        />
      ) : ["production", "shipments", "after-sales"].includes(module) ? <OrderFulfillmentList items={data.items} module={module as "production" | "shipments" | "after-sales"} loading={loading} unavailable={!!error} selectedId={lineId} onDetail={openLine} /> : (
        <div className="oc-table-wrap">
          <table className="oc-table">
            <thead>
              <tr>
                <th>订单 / 商品</th>
                <th>制作依据</th>
                <th>订单状态 / 当前任务</th>
                <th>数量 / 发货</th>
                <th>平台发货截止</th>
                <th>内部计划时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {!loading && !data.items.length && (
                <tr>
                  <td colSpan={7} className="oc-empty">
                    {error ? "订单暂时无法读取，请重试。" : "没有符合条件的订单商品。"}
                    {module === "artwork" && !error && (
                      <p>运营在订单中心推送后，任务会出现在这里。</p>
                    )}
                  </td>
                </tr>
              )}
              {data.items.map((row) => (
                <tr
                  key={row.id}
                  className={`${row.held || row.sourceChanged ? "attention" : ""}${row.id === lineId ? " oc-current-order" : ""}`}
                >
                  <td data-label="订单 / 商品">
                    <button className="oc-text-button" onClick={() => openLine(row.id)}>
                      {row.externalOrderId}
                    </button>
                    <span className="oc-product-title" title={row.title}>
                      {row.title}
                    </span>
                    <small>
                      {row.storeName} · {row.skuCode ?? "无商品 SKU"}
                    </small>
                  </td>
                  <td data-label="制作依据">
                    {row.printSku ?? "待选择印花"}
                    <small>需求 {row.revision ? `V${row.revision}` : "待整理"}</small>
                    {row.sourceChanged && <span className="oc-badge warning">导入资料有变化</span>}
                  </td>
                  <td data-label="订单状态 / 当前任务">
                    <OrderLifecycleBadge status={row.orderStatus} />
                    <small>{orderOperatorTask(row).title}</small>
                    {row.held && <span className="oc-badge warning">已暂停</span>}
                    {row.afterSalesCount > 0 && <span className="oc-badge warning">售后待处理</span>}
                  </td>
                  <td data-label="数量 / 发货">
                    {row.quantity} 件
                    <small>
                      已发 {row.shippedQuantity}/{row.quantity}
                    </small>
                  </td>
                  <td data-label="平台发货截止">
                    <OrderDeadlineSummary row={{ ...row, dueAt: null }} />
                  </td>
                  <td data-label="内部计划时间">
                    {row.dueAt ? dateTime(row.dueAt) : "未设置"}
                    <small>更新：{dateTime(row.updatedAt)}</small>
                  </td>
                  <td>
                    <button className="oc-button" onClick={() => openLine(row.id)}>
                      打开任务
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <footer className="oc-pagination" hidden={!!error}>
        <span>
          第 {data.page} / {Math.max(1, Math.ceil((data.groupTotal ?? data.total) / data.pageSize))}{" "}
          页
        </span>
        <button
          className="oc-button"
          disabled={loading || data.page <= 1}
          onClick={() => navigate({ page: String(data.page - 1) })}
        >
          <ChevronLeft size={15} />
          上一页
        </button>
        <button
          className="oc-button"
          disabled={loading || data.page * data.pageSize >= (data.groupTotal ?? data.total)}
          onClick={() => navigate({ page: String(data.page + 1) })}
        >
          下一页
          <ChevronRight size={15} />
        </button>
      </footer>
      {lineId && (
        <OrderReviewDrawer
          operatorFlow={module === "orders" && !legacyFilters.length}
          id={lineId}
          module={
            ["orders", "artwork", "production", "shipments", "after-sales"].includes(
              params.get("detailMode") ?? "",
            )
              ? (params.get("detailMode") as OrderWorkspaceModule)
              : module
          }
          editorOpen={params.get("editor") === "1"}
          onEditor={(open) => navigate({ editor: open ? "1" : null }, true)}
          queue={
            reviewQueue ??
            (data.items.some((row) => row.id === lineId)
              ? orderReviewQueue(data.items, lineId)
              : [lineId])
          }
          options={options}
          queueOrderIds={reviewOrderIds}
          onSelect={(id) => {
            const target = reviewModes.current.get(id) ?? module;
            navigate({ line: id, editor: null, detailMode: target === module ? null : target }, true);
          }}
          onModuleChange={(target) => navigate({ detailMode: target === module ? null : target, editor: null }, true)}
          onSelectItem={(id, target) => navigate({ line: id, detailMode: target === module ? null : target, editor: null }, true)}
          onClose={() => navigate({ line: null, editor: null }, true)}
          onChanged={() => setRefresh((value) => value + 1)}
        />
      )}
    </main>
  );
}
