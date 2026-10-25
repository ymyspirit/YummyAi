"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { flushSync } from "react-dom";
import { CheckCircle2, ChevronLeft, ChevronRight, Plus, RefreshCw } from "lucide-react";
import {
  OrderExceptionCategorySchema,
  OrderExceptionViewSchema,
} from "@yummyai/contracts/order/order";
import {
  OrderExceptionOperationsViewSchema,
  type OrderExceptionOperationsView,
  OpenReviewedOrderExceptionSchema,
  ResolveReviewedOrderExceptionSchema,
} from "@yummyai/contracts/order/exception-operations";
import { TaskDrawer } from "../navigation/task-drawer";
import { observeViewTransition } from "../navigation/view-transition";
import type { OrderReviewState } from "./order-work-detail";
import { dateTime } from "./order-center-model";
import { followupContext } from "../business-tasks/followup-request";
import "./order-exception-panel.css";
function animateView(update: () => void) {
  if (
    typeof document.startViewTransition === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    observeViewTransition(document.startViewTransition(() => flushSync(update)));
  else update();
}
class ExceptionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
async function request(
  orderId: string,
  query: string,
  signal?: AbortSignal,
  input?: unknown,
  target = "",
) {
  const response = await fetch(
    `/api/order-exceptions/${orderId}${target}${!input && query ? "?" + query : ""}`,
    {
      cache: "no-store",
      signal,
      ...(input
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          }
        : {}),
    },
  );
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new ExceptionRequestError(
      response.status,
      typeof value?.message === "string" ? value.message : "异常记录暂时无法读取",
    );
  return value;
}
type Draft = {
  mode: "create" | "resolve";
  id: string;
  category: string;
  message: string;
  resolution: string;
  source: string;
  sequence: number;
  requestId: string;
};
export function OrderExceptionPanel({
  orderId,
  focusId,
  refreshToken = 0,
  disabled = false,
  compact = false,
  onChanged,
  onStateChange,
}: {
  orderId: string;
  focusId?: string;
  refreshToken?: number;
  disabled?: boolean;
  compact?: boolean;
  onChanged?(): void;
  onStateChange?(value: OrderReviewState): void;
}) {
  const [view, setView] = useState<OrderExceptionOperationsView>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(false),
    [saving, setSaving] = useState(false),
    [draft, setDraft] = useState<Draft>(),
    [page, setPage] = useState(1),
    [status, setStatus] = useState<"all" | "open" | "resolved">("all"),
    [showAll, setShowAll] = useState(false),
    [reload, setReload] = useState(0);
  const baseline = useRef(""),
    abort = useRef<AbortController | undefined>(undefined),
    loadedScope = useRef(orderId + ":" + (focusId ?? ""));
  const dirty = Boolean(draft && JSON.stringify(draft) !== baseline.current),
    query = new URLSearchParams({
      status,
      page: String(page),
      ...(focusId && !showAll ? { exceptionId: focusId } : {}),
    }).toString();
  useEffect(() => {
    onStateChange?.({ dirty, busy: saving, loading });
    return () => onStateChange?.({ dirty: false, busy: false, loading: false });
  }, [dirty, saving, loading, onStateChange]);
  const load = useCallback(
    async (preserveError = false) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setLoading(true);
      if (!preserveError) setError("");
      try {
        const value = OrderExceptionOperationsViewSchema.parse(
          await request(orderId, query, controller.signal),
        );
        if (!controller.signal.aborted)
          animateView(() => {
            if (!controller.signal.aborted) setView(value);
          });
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "异常记录暂时无法读取");
        if (cause instanceof ExceptionRequestError && [401, 403, 404, 410].includes(cause.status)) {
          setView(undefined);
          setDraft(undefined);
          baseline.current = "";
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [orderId, query],
  );
  useEffect(() => {
    const scope = orderId + ":" + (focusId ?? "");
    if (loadedScope.current !== scope) {
      setDraft(undefined);
      setView(undefined);
      setPage(1);
      setShowAll(false);
      loadedScope.current = scope;
    }
    void load();
    return () => abort.current?.abort();
  }, [load, orderId, focusId, refreshToken, reload]);
  const refresh = useRef(() => {});
  refresh.current = () => {
    if (!saving && document.visibilityState === "visible") void load();
  };
  useEffect(() => {
    const check = () => refresh.current(),
      timer = setInterval(check, 30000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
    };
  }, [orderId]);
  function edit(id?: string) {
    if (!view || disabled || saving || loading) return;
    const item = id ? view.items.find((item) => item.exception.id === id) : undefined;
    const value: Draft = {
      mode: id ? "resolve" : "create",
      id: id ?? "",
      category: "address",
      message: "",
      resolution: "",
      source: item?.sourceChecksum ?? view.sourceChecksum,
      sequence: item?.sequence ?? view.orderSequence,
      requestId: crypto.randomUUID(),
    };
    baseline.current = JSON.stringify(value);
    setDraft(value);
    setError("");
    setNotice("");
  }
  const selected =
    draft?.mode === "resolve"
      ? view?.items.find((item) => item.exception.id === draft.id)
      : undefined;
  const stale = Boolean(
    draft &&
    view &&
    (draft.mode === "create"
      ? draft.source !== view.sourceChecksum || draft.sequence !== view.orderSequence
      : !selected ||
        draft.source !== selected.sourceChecksum ||
        draft.sequence !== selected.sequence),
  );
  const canSave = Boolean(
    draft && view && (draft.mode === "create" ? view.canCreate : selected?.canResolve),
  );
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !canSave || stale || disabled || saving || loading) return;
    setSaving(true);
    setError("");
    try {
      const input =
        draft.mode === "create"
          ? OpenReviewedOrderExceptionSchema.parse({
              category: draft.category,
              code: "MANUAL_REVIEW",
              message: draft.message,
              expectedOrderSequence: draft.sequence,
              expectedSourceChecksum: draft.source,
              idempotencyKey: draft.requestId,
            })
          : ResolveReviewedOrderExceptionSchema.parse({
              resolution: draft.resolution,
              expectedSequence: draft.sequence,
              expectedSourceChecksum: draft.source,
              idempotencyKey: draft.requestId,
            });
      OrderExceptionViewSchema.parse(
        await request(
          orderId,
          "",
          undefined,
          input,
          draft.mode === "resolve" ? `/${draft.id}/resolve` : "",
        ),
      );
      if (draft.mode === "create") {
        setShowAll(true);
        setPage(1);
      }
      setDraft(undefined);
      baseline.current = "";
      setNotice(draft.mode === "create" ? "异常已记录" : "已记录异常解决");
      await load();
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "操作未完成 请核对后重试");
      if (cause instanceof ExceptionRequestError) {
        if (cause.status === 409) void load(true);
        else if ([401, 403, 404, 410].includes(cause.status)) {
          setView(undefined);
          setDraft(undefined);
          baseline.current = "";
        }
      }
    } finally {
      setSaving(false);
    }
  }
  const locked = disabled || saving || loading;
  const content = (
    <section className="order-exceptions" aria-label="订单异常处理">
      <header>
        <div>
          <h2>本单异常</h2>
          <p>按实际处理依据登记 处理结果保留在原异常历史中</p>
        </div>
        <div className="oc-actions">
          <button
            type="button"
            className="oc-button"
            disabled={locked || Boolean(draft)}
            onClick={() => setReload((value) => value + 1)}
            aria-label="重新读取异常记录"
          >
            <RefreshCw size={14} />
          </button>
          <button
            type="button"
            className="oc-button"
            disabled={locked || Boolean(draft) || !view?.canCreate}
            onClick={() => edit()}
          >
            <Plus size={14} />
            登记异常
          </button>
        </div>
      </header>
      {loading && (
        <p role="status" className="oc-hint">
          正在读取异常记录
        </p>
      )}
      {error && !draft && (
        <p role="alert" className="oc-error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {view && (
        <>
          <div className="order-exception-filters">
            <label>
              异常状态
              <select
                aria-label="异常状态"
                value={status}
                disabled={locked || Boolean(draft)}
                onChange={(event) => {
                  setStatus(event.target.value as typeof status);
                  setPage(1);
                }}
              >
                <option value="all">全部状态</option>
                <option value="open">待解决</option>
                <option value="resolved">已解决</option>
              </select>
            </label>
            <span>
              筛选结果 {view.total} 条 · 待解决 {view.summary.open} · 已解决 {view.summary.resolved}
            </span>
            {focusId && !showAll && (
              <button
                className="oc-button"
                disabled={locked || Boolean(draft)}
                onClick={() => {
                  setShowAll(true);
                  setPage(1);
                }}
              >
                查看本单全部异常
              </button>
            )}
          </div>
          {!view.items.length && (
            <p className="oc-hint">
              {focusId && !showAll
                ? "没有匹配的异常记录 请核对当前状态或查看全部异常"
                : "当前筛选没有异常记录"}
            </p>
          )}
          {view.items.map((item) => (
            <article
              key={item.exception.id}
              id={"exception-" + item.exception.id}
              className="oc-record order-exception-record"
              data-exception-id={item.exception.id}
              data-focused={focusId === item.exception.id}
            >
              <div className="oc-record-header">
                <strong>{followupContext("order_exception", item.exception.category)}</strong>
                <span className="oc-badge">
                  {item.exception.status === "resolved" ? "已解决" : "待解决"}
                </span>
              </div>
              <p>{item.exception.message}</p>
              <small>{dateTime(item.exception.openedAt)}</small>
              {item.eventMissing && <p className="oc-error">原异常事件缺失 请核对历史来源</p>}
              {item.exception.resolution && (
                <div className="order-exception-resolution">
                  <CheckCircle2 size={14} />
                  <div>
                    <strong>实际处理记录</strong>
                    <p>{item.exception.resolution}</p>
                    <small>{dateTime(item.exception.resolvedAt)}</small>
                  </div>
                </div>
              )}
              {item.exception.status === "open" && (
                <button
                  className="oc-button"
                  disabled={locked || Boolean(draft) || !item.canResolve}
                  onClick={() => edit(item.exception.id)}
                >
                  记录已解决
                </button>
              )}
            </article>
          ))}
          <nav className="order-exception-pagination" aria-label="异常记录分页">
            <span>
              第 {view.page} 页 · 共 {view.total} 条
            </span>
            <div className="oc-actions">
              <button
                className="oc-button"
                disabled={locked || Boolean(draft) || page <= 1}
                onClick={() => setPage((value) => value - 1)}
              >
                <ChevronLeft size={14} />
                上一页
              </button>
              <button
                className="oc-button"
                disabled={locked || Boolean(draft) || page * view.pageSize >= view.total}
                onClick={() => setPage((value) => value + 1)}
              >
                下一页
                <ChevronRight size={14} />
              </button>
              {page > 1 && !view.items.length && (
                <button
                  className="oc-button"
                  disabled={locked || Boolean(draft)}
                  onClick={() => setPage(1)}
                >
                  返回第一页
                </button>
              )}
            </div>
          </nav>
        </>
      )}
      {draft && (
        <TaskDrawer
          title={draft.mode === "create" ? "登记本单异常" : "登记异常实际处理结果"}
          recordKey={orderId + ":" + draft.id}
          state={{ dirty, busy: saving, loading }}
          onClose={() => setDraft(undefined)}
          className="order-exception-editor"
        >
          <form onSubmit={(event) => void save(event)}>
            <p className="oc-hint">只记录业务问题和处理依据 请勿填写买家个人资料</p>
            {selected && (
              <div className="order-exception-basis">
                <strong>本次核对的问题</strong>
                <p>{selected.exception.message}</p>
              </div>
            )}
            {stale && (
              <div role="alert" className="oc-error">
                <p>订单或异常已变化 当前填写保留 请核对最新记录</p>
                <button
                  type="button"
                  className="oc-button"
                  disabled={saving || loading}
                  onClick={() => {
                    setDraft(undefined);
                    baseline.current = "";
                    setReload((value) => value + 1);
                  }}
                >
                  放弃填写并载入最新记录
                </button>
              </div>
            )}
            {!canSave && <p role="alert">当前没有处理权限或异常已经解决</p>}
            {error && (
              <p role="alert" className="oc-error">
                {error}
              </p>
            )}
            {draft.mode === "create" ? (
              <>
                <label>
                  异常类型
                  <select
                    aria-label="异常类型"
                    value={draft.category}
                    disabled={locked || stale || !canSave}
                    onChange={(event) =>
                      setDraft((value) =>
                        value ? { ...value, category: event.target.value } : value,
                      )
                    }
                  >
                    {OrderExceptionCategorySchema.options.map((value) => (
                      <option key={value} value={value}>
                        {followupContext("order_exception", value)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  问题说明
                  <textarea
                    aria-label="问题说明"
                    maxLength={2000}
                    required
                    value={draft.message}
                    disabled={locked || stale || !canSave}
                    onChange={(event) =>
                      setDraft((value) =>
                        value ? { ...value, message: event.target.value } : value,
                      )
                    }
                  />
                </label>
              </>
            ) : (
              <label>
                实际处理依据
                <textarea
                  aria-label="实际处理依据"
                  maxLength={2000}
                  required
                  value={draft.resolution}
                  disabled={locked || stale || !canSave}
                  onChange={(event) =>
                    setDraft((value) =>
                      value ? { ...value, resolution: event.target.value } : value,
                    )
                  }
                />
              </label>
            )}
            <button className="oc-button primary" disabled={locked || stale || !canSave}>
              {saving ? "正在保存" : draft.mode === "create" ? "保存异常记录" : "保存处理结果"}
            </button>
          </form>
        </TaskDrawer>
      )}
    </section>
  );
  const quiet = view && view.summary.open === 0 && !loading && !saving && !error && !notice && !draft
    && !focusId && status === "all" && page === 1;
  return compact && quiet
    ? <details className="order-exception-history"><summary><CheckCircle2 size={14} aria-hidden="true" />本单异常 · 当前无待解决项</summary>{content}</details>
    : content;
}
