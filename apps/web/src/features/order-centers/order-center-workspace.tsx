"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChevronLeft, ChevronRight, FileUp, RefreshCw, Search } from "lucide-react";
import {
  OrderCenterOptionsSchema,
  OrderWorkListViewSchema,
  type OrderWorkListItem,
  type OrderWorkspaceModule,
  type OrderCenterOptions,
} from "@yummyai/contracts/order/workspace";
import { centers, centerRead, dateTime, label } from "./order-center-model";
import { readQueue } from "../navigation/workflow-href";
import { OrderReviewDrawer } from "./order-review-drawer";
import { OrderProductList } from "./order-product-list";
import { OrderQueueBar, OrderWorkbenchFilters } from "./order-workbench-toolbar";
import type { OrderQueueCounts } from "@yummyai/contracts/order/workbench";
import "./order-centers.css";

const empty: {
  items: OrderWorkListItem[];
  total: number;
  page: number;
  pageSize: number;
  groupTotal?: number;
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
  "designExecutor",
  "labelStatus",
  "dateField",
  "timeZone",
  "orderNumbers",
  "archived",
];
type SavedView = { name: string; query: string };
const statusFilters = [
  {
    name: "preparation",
    title: "审单状态",
    choices: ["pending_review", "needs_information", "ready_to_push", "pushed"],
  },
  {
    name: "artwork",
    title: "制图状态",
    choices: [
      "not_pushed",
      "queued",
      "starting",
      "in_progress",
      "in_review",
      "changes_requested",
      "approved",
    ],
  },
  {
    name: "production",
    title: "生产状态",
    choices: [
      "not_released",
      "planned",
      "submitted",
      "acknowledged",
      "in_production",
      "awaiting_quality",
      "partially_completed",
      "quality_hold",
      "completed",
      "cancel_requested",
      "cancelled",
    ],
  },
  { name: "shipment", title: "发货状态", choices: ["unshipped", "partial", "shipped"] },
  {
    name: "afterSales",
    title: "售后状态",
    choices: [
      "open",
      "awaiting_customer",
      "awaiting_internal",
      "approved",
      "rejected",
      "resolved",
      "cancelled",
    ],
  },
];
export function OrderCenterWorkspace({ module }: { module: OrderWorkspaceModule }) {
  const primaryStatus = statusFilters.find(
    (filter) =>
      filter.name ===
      {
        orders: "preparation",
        artwork: "artwork",
        production: "production",
        shipments: "shipment",
        "after-sales": "afterSales",
      }[module],
  )!;
  const params = useSearchParams(),
    router = useRouter(),
    pathname = usePathname(),
    current = params.toString(),
    lineId = params.get("line"),
    center = centers[module];
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
  const listSearch = new URLSearchParams({
    module,
    ...(module === "orders" ? { grouping: "orders" } : {}),
  });
  for (const key of queryKeys) {
    const value = params.get(key);
    if (value) listSearch.set(key, value);
  }
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
    if (!lineId) setReviewQueue(null);
    else if (!loading && !reviewQueue) {
      setReviewQueue(
        readQueue(params.get("queue"), lineId) ??
          (data.items.some((row) => row.id === lineId)
            ? data.items.map((row) => row.id)
            : [lineId]),
      );
    }
  }, [lineId, loading, data.items, reviewQueue, params]);
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
  function openLine(id: string, detailMode: OrderWorkspaceModule = module) {
    const queue = data.items.map((row) => row.id).slice(0, 100);
    setReviewQueue(queue);
    navigate({
      line: id,
      editor: null,
      queue: queue.join(","),
      detailMode: detailMode === module ? null : detailMode,
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
    <main className={`oc-page${module === "orders" ? " oc-workbench" : ""}`} aria-busy={loading}>
      <header className="oc-header">
        <div>
          <h1>{center.title}</h1>
          <p>{center.description}</p>
        </div>
        <div className="oc-actions">
          {module === "orders" && (
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
                    placeholder="例如：今天待审图"
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
          )}
          {module === "orders" && (
            <Link className="oc-button primary" href="/orders?view=reports">
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
      {module === "orders" ? (
        <>
          <OrderQueueBar
            counts={data.counts}
            stage={params.get("stage")}
            attention={params.get("attention")}
            missingLabels={params.get("labelStatus") === "missing"}
            disabled={busy}
            onSelect={(stage) => {
              if (stage !== new URLSearchParams(window.location.search).get("stage"))
                navigate({ stage, page: null, line: null, editor: null });
            }}
            onAttention={(attention) =>
              navigate({ attention, page: null, line: null, editor: null })
            }
            onMissingLabels={(missing) =>
              navigate({
                labelStatus: missing ? "missing" : null,
                page: null,
                line: null,
                editor: null,
              })
            }
          />
          <OrderWorkbenchFilters
            key={listQuery}
            query={current}
            options={options}
            disabled={busy || (!options && !optionsError)}
            onSubmit={filter}
            onClear={() => go(pathname)}
          />
        </>
      ) : (
        <>
          <nav className="oc-views" aria-label="常用订单视图">
            <button
              className={
                !params.get(primaryStatus.name) && !params.get("attention") ? "active" : ""
              }
              onClick={() => {
                go(pathname);
              }}
            >
              全部
            </button>
            {primaryStatus.choices
              .filter(
                (state) =>
                  ![
                    "not_pushed",
                    "starting",
                    "not_released",
                    "cancelled",
                    "cancel_requested",
                  ].includes(state),
              )
              .map((state) => {
                const key = primaryStatus.name;
                return (
                  <button
                    key={state}
                    className={params.get(key) === state ? "active" : ""}
                    onClick={() => navigate({ [key]: state, page: null })}
                  >
                    {label(state)}
                  </button>
                );
              })}
            <button
              className={params.get("attention") === "overdue" ? "active" : ""}
              onClick={() => navigate({ attention: "overdue", page: null })}
            >
              已超期
            </button>
            <button
              className={params.get("attention") === "held" ? "active" : ""}
              onClick={() => navigate({ attention: "held", page: null })}
            >
              已暂停
            </button>
          </nav>
          <form className="oc-filters" key={current} onSubmit={filter}>
            <label className="oc-search">
              <span>搜索订单</span>
              <div>
                <Search size={16} />
                <input
                  name="q"
                  defaultValue={params.get("q") ?? ""}
                  placeholder="订单号 / 商品 SKU / 印花 SKU / 物流单号"
                />
              </div>
            </label>
            <Select
              name="accountId"
              title="店铺"
              value={params.get("accountId")}
              loading={!options}
              choices={options?.stores.map((store) => [store.id, store.displayName]) ?? []}
            />
            <Select
              name="platform"
              title="平台"
              value={params.get("platform")}
              choices={[
                ["amazon", "Amazon"],
                ["etsy", "Etsy"],
              ]}
            />
            <Select
              name={primaryStatus.name}
              title={primaryStatus.title}
              value={params.get(primaryStatus.name)}
              choices={primaryStatus.choices.map((state) => [state, label(state)])}
            />
            <details
              className="oc-more-filters"
              open={
                !!["proof", "production", "shipment", "from", "to", "attention"].find((key) =>
                  params.has(key),
                )
              }
            >
              <summary>更多筛选</summary>
              <div>
                <Select
                  name="proof"
                  title="客户确认"
                  value={params.get("proof")}
                  choices={["not_required", "pending", "approved", "changes_requested"].map(
                    (key) => [key, label(key)],
                  )}
                />
                {statusFilters
                  .filter((filter) => filter.name !== primaryStatus.name)
                  .map((filter) => (
                    <Select
                      key={filter.name}
                      name={filter.name}
                      title={filter.title}
                      value={params.get(filter.name)}
                      choices={filter.choices.map((state) => [state, label(state)])}
                    />
                  ))}
                <Select
                  name="attention"
                  title="需要关注"
                  value={params.get("attention")}
                  choices={[
                    ["held", "已暂停"],
                    ["overdue", "内部计划已超期"],
                    ["source_changed", "导入资料有变化"],
                  ]}
                />
                <label>
                  下单开始日期
                  <input type="date" name="from" defaultValue={params.get("from") ?? ""} />
                </label>
                <label>
                  下单结束日期
                  <input type="date" name="to" defaultValue={params.get("to") ?? ""} />
                </label>
              </div>
            </details>
            <button className="oc-button primary" type="submit" disabled={loading || busy}>
              查询
            </button>
            <button className="oc-button" type="button" onClick={() => go(pathname)}>
              清空
            </button>
          </form>
          <div className="oc-saved-views">
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
            <input
              aria-label="视图名称"
              value={viewName}
              maxLength={60}
              onChange={(event) => setViewName(event.target.value)}
              placeholder="例如：我的待推送订单"
            />
            <button className="oc-button" disabled={!viewName.trim()} onClick={saveView}>
              保存当前筛选
            </button>
          </div>
        </>
      )}
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
      <div className="oc-list-summary">
        <span>
          {loading
            ? "正在读取…"
            : error
              ? "订单数量暂不可用"
              : `共 ${data.total} 条订单商品${data.groupTotal !== undefined ? ` · ${data.groupTotal} 个订单` : ""}`}
        </span>
        {
          <button
            className="oc-button primary"
            disabled={loading || busy || !data.items.length}
            onClick={() =>
              data.items[0] &&
              openLine(
                data.items[0].id,
                module === "orders" &&
                  ["in_review", "in_progress", "changes_requested", "queued", "approved"].includes(
                    params.get("stage") ?? "",
                  )
                  ? "artwork"
                  : module === "orders" && params.get("stage") === "production"
                    ? "production"
                    : module === "orders" &&
                        ["ready_to_ship", "shipped"].includes(params.get("stage") ?? "")
                      ? "shipments"
                      : module,
              )
            }
          >
            {module === "orders"
              ? params.get("stage") === "in_review"
                ? "连续审图"
                : [
                      "queued",
                      "in_progress",
                      "changes_requested",
                      "approved",
                      "production",
                      "ready_to_ship",
                      "shipped",
                      "cancelled",
                    ].includes(params.get("stage") ?? "")
                  ? "连续处理"
                  : "连续审单"
              : "连续处理"}
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
      ) : (
        <div className="oc-table-wrap">
          <table className="oc-table">
            <thead>
              <tr>
                <th>订单 / 商品</th>
                <th>制作依据</th>
                <th>各环节状态</th>
                <th>数量 / 发货</th>
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
                  <td data-label="各环节状态">
                    <div className="oc-statuses">
                      <span className="oc-badge">{label(row.preparation)}</span>
                      <span className="oc-badge">{label(row.artwork)}</span>
                      {row.production !== "not_released" && (
                        <span className="oc-badge">{label(row.production)}</span>
                      )}
                      {row.proof !== "not_required" && (
                        <span className="oc-badge">客户：{label(row.proof)}</span>
                      )}
                      {(row.held || row.sideState) && (
                        <span className="oc-badge warning">
                          {row.held ? "已暂停" : label(row.sideState!)}
                        </span>
                      )}
                      {row.afterSalesCount > 0 && (
                        <span className="oc-badge warning">售后 {row.afterSalesCount}</span>
                      )}
                    </div>
                  </td>
                  <td data-label="数量 / 发货">
                    {row.quantity} 件
                    <small>
                      已发 {row.shippedQuantity}/{row.quantity}
                    </small>
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
              ? data.items.map((row) => row.id)
              : [lineId])
          }
          options={options}
          onSelect={(id) => navigate({ line: id, editor: null }, true)}
          onModuleChange={(target) => navigate({ detailMode: target === module ? null : target, editor: null }, true)}
          onClose={() => navigate({ line: null, editor: null }, true)}
          onChanged={() => setRefresh((value) => value + 1)}
        />
      )}
    </main>
  );
}
function Select({
  name,
  title,
  value,
  choices,
  loading = false,
}: {
  name: string;
  title: string;
  value: string | null;
  choices: string[][];
  loading?: boolean;
}) {
  const [selection, setSelection] = useState(value ?? "");
  return (
    <label>
      {title}
      <select
        name={name}
        aria-label={title}
        value={selection}
        disabled={loading}
        onChange={(event) => setSelection(event.target.value)}
      >
        <option value="">全部</option>
        {selection && !choices.some(([key]) => key === selection) && (
          <option value={selection}>{loading ? "正在读取…" : `所选${title}不可用`}</option>
        )}
        {choices.map(([key, text]) => (
          <option key={key} value={key}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
