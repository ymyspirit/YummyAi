"use client";
import { useEffect, useMemo, useState, useTransition, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Inbox, Search } from "lucide-react";
import {
  BusinessTaskInboxQuerySchema,
  type BusinessTaskInboxQuery,
} from "@yummyai/contracts/common/task-inbox";
import { observeViewTransition } from "../navigation/view-transition";
import { BusinessTaskSourcePicker, type BusinessTaskSource } from "./business-task-source-picker";
import "./workflow-task-inbox.css";

const keys = ["assignment", "status", "due", "q", "page", "pageSize", "sort", "timeZone"];
function animate(update: () => void) {
  if (
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    observeViewTransition(document.startViewTransition(() => flushSync(update)));
  else update();
}
export function formatTaskDate(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}
type InboxResult<Item> = {
  asOf: string;
  query: BusinessTaskInboxQuery;
  items: Item[];
  total: number;
  page: number;
  pageSize: number;
};
export function BusinessTaskInbox<Item extends { id: string }, View extends InboxResult<Item>>({
  reload,
  onChangeSource,
  source,
  title,
  description,
  regionLabel,
  searchPlaceholder,
  read,
  renderSummary,
  renderRow,
  columns,
  contextAction,
}: {
  reload: number;
  onChangeSource(value: BusinessTaskSource): void;
  source: BusinessTaskSource;
  title: string;
  description: string;
  regionLabel: string;
  searchPlaceholder: string;
  read(query: string, signal: AbortSignal): Promise<View>;
  renderSummary(view: View): ReactNode;
  renderRow(item: Item, query: BusinessTaskInboxQuery): ReactNode;
  columns: string[];
  contextAction?: ReactNode;
}) {
  const params = useSearchParams(),
    router = useRouter();
  const [navigating, startNavigation] = useTransition();
  const encoded = new URLSearchParams(
    keys.flatMap((key) => (params.has(key) ? [[key, params.get(key)!]] : [])),
  ).toString();
  const parsed = useMemo(
    () => BusinessTaskInboxQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(encoded))),
    [encoded],
  );
  const criteria = parsed.success ? parsed.data : null;
  const [value, setValue] = useState<View>(),
    [error, setError] = useState<string>(),
    [loading, setLoading] = useState(false),
    [tick, setTick] = useState(0);
  const [search, setSearch] = useState(params.get("q") ?? ""),
    [browserZone, setBrowserZone] = useState("UTC");
  useEffect(() => {
    setSearch(params.get("q") ?? "");
  }, [params.get("q")]);
  function change(patch: Record<string, string | number>) {
    const next = new URLSearchParams(params.toString());
    next.set("object", source);
    next.delete("target");
    for (const [key, value] of Object.entries(patch)) {
      if (key === "q" && value === "") next.delete(key);
      else next.set(key, String(value));
    }
    startNavigation(() => router.replace(`/business-tasks?${next}`, { scroll: false }));
  }
  useEffect(() => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    setBrowserZone(zone);
    if (!params.has("timeZone")) {
      const next = new URLSearchParams(params.toString());
      next.set("object", source);
      next.set("timeZone", zone);
      startNavigation(() => router.replace(`/business-tasks?${next}`, { scroll: false }));
    }
  }, []);
  useEffect(() => {
    if (!criteria) {
      setValue(undefined);
      setError("任务筛选参数无效 请重置筛选");
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    setValue(undefined);
    const query = new URLSearchParams(
      Object.entries(criteria).map(([key, value]) => [key, String(value)]),
    );
    void read(query.toString(), controller.signal)
      .then((next) => {
        if (!controller.signal.aborted)
          animate(() => {
            if (!controller.signal.aborted) setValue(next);
          });
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setValue(undefined);
        setError(cause instanceof Error ? cause.message : "任务暂时无法读取 请刷新重试");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [criteria, reload, tick, read]);
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") setTick((value) => value + 1);
    };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("popstate", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("popstate", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const zones = [...new Set([browserZone, "UTC", ...(criteria ? [criteria.timeZone] : [])])];
  const reset = () =>
    router.replace(
      `/business-tasks?${new URLSearchParams({ object: source, timeZone: browserZone })}`,
      { scroll: false },
    );
  return (
    <section
      className="workflow-task-inbox"
      aria-label={regionLabel}
      aria-busy={loading || navigating}
    >
      <div className="wi-heading">
        <div>
          <h2>
            <Inbox size={17} />
            {title}
          </h2>
          <p>{description}</p>
          {contextAction}
        </div>
        {value ? (
          <small>
            截至 {formatTaskDate(value.asOf, value.query.timeZone)} · {value.query.timeZone}
          </small>
        ) : null}
      </div>
      <div className="wi-filters">
        <BusinessTaskSourcePicker value={source} disabled={navigating} onChange={onChangeSource} />
        <label>
          责任范围
          <select
            aria-label="责任范围"
            disabled={navigating}
            value={criteria?.assignment ?? "mine"}
            onChange={(event) => change({ assignment: event.target.value, page: 1 })}
          >
            <option value="mine">我负责</option>
            <option value="unassigned">未分配</option>
            <option value="visible">全部可见</option>
          </select>
        </label>
        <label>
          任务状态
          <select
            aria-label="任务状态"
            disabled={navigating}
            value={criteria?.status ?? "open"}
            onChange={(event) => change({ status: event.target.value, due: "any", page: 1 })}
          >
            <option value="open">未完成</option>
            <option value="closed">已结束</option>
            <option value="all">全部状态</option>
          </select>
        </label>
        <label>
          内部截止
          <select
            aria-label="内部截止"
            value={criteria?.due ?? "any"}
            disabled={navigating || criteria?.status !== "open"}
            onChange={(event) => change({ due: event.target.value, page: 1 })}
          >
            <option value="any">全部截止时间</option>
            <option value="overdue">已逾期</option>
            <option value="today">今日到期</option>
            <option value="unset">未设置</option>
          </select>
        </label>
        <label>
          截止时区
          <select
            aria-label="截止时区"
            disabled={navigating}
            value={criteria?.timeZone ?? "UTC"}
            onChange={(event) => change({ timeZone: event.target.value, page: 1 })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone === browserZone ? `本地 ${zone}` : zone}
              </option>
            ))}
          </select>
        </label>
        <label>
          排序
          <select
            aria-label="任务排序"
            disabled={navigating}
            value={criteria?.sort ?? "deadline"}
            onChange={(event) => change({ sort: event.target.value, page: 1 })}
          >
            <option value="deadline">内部截止优先</option>
            <option value="updated">最近更新</option>
          </select>
        </label>
        <form
          className="wi-search"
          onSubmit={(event) => {
            event.preventDefault();
            change({ q: search, page: 1 });
          }}
        >
          <label>
            搜索任务
            <input
              aria-label="搜索任务"
              disabled={navigating}
              value={search}
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={searchPlaceholder}
            />
          </label>
          <button type="submit" disabled={navigating}>
            <Search size={15} />
            搜索
          </button>
        </form>
      </div>
      {error ? (
        <div className="wi-error" role="alert">
          <p>{error}</p>
          <button type="button" onClick={() => setTick((value) => value + 1)}>
            重新读取
          </button>
          <button type="button" onClick={reset}>
            重置筛选
          </button>
        </div>
      ) : null}
      {!value && !error ? (
        <p role="status" className="wi-loading">
          正在读取{title}
        </p>
      ) : null}
      {value ? (
        <>
          <div className="wi-summary" aria-label="当前筛选统计">
            {renderSummary(value)}
          </div>
          {value.items.length ? (
            <table className="wi-table">
              <caption className="wi-sr-only">
                {title} 当前筛选共 {value.total} 项
              </caption>
              <thead>
                <tr>
                  {columns.map((column, index) => (
                    <th key={index}>{column || <span className="wi-sr-only">操作</span>}</th>
                  ))}
                </tr>
              </thead>
              <tbody>{value.items.map((item) => renderRow(item, value.query))}</tbody>
            </table>
          ) : (
            <div className="wi-empty">
              <Inbox size={24} />
              <p>
                {value.total ? "这一页没有任务 可返回前面的页码" : "当前责任范围与筛选没有匹配任务"}
              </p>
              {value.total ? (
                <button type="button" onClick={() => change({ page: 1 })}>
                  返回第一页
                </button>
              ) : null}
            </div>
          )}
          <footer className="wi-pagination">
            <span>
              第 {value.page} 页 · 共 {Math.max(1, Math.ceil(value.total / value.pageSize))} 页
            </span>
            <label>
              每页
              <select
                aria-label="每页任务数"
                disabled={navigating}
                value={value.pageSize}
                onChange={(event) => change({ pageSize: event.target.value, page: 1 })}
              >
                {[...new Set([25, 50, 100, value.pageSize])]
                  .sort((a, b) => a - b)
                  .map((size) => (
                    <option key={size} value={size}>
                      {size}
                    </option>
                  ))}
              </select>
            </label>
            <div>
              <button
                type="button"
                disabled={loading || navigating || value.page <= 1}
                onClick={() => change({ page: value.page - 1 })}
              >
                <ChevronLeft size={14} />
                上一页
              </button>
              <button
                type="button"
                disabled={loading || navigating || value.page * value.pageSize >= value.total}
                onClick={() => change({ page: value.page + 1 })}
              >
                下一页
                <ChevronRight size={14} />
              </button>
            </div>
          </footer>
        </>
      ) : null}
    </section>
  );
}
