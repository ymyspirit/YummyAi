"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, ArrowUpRight, Inbox, ListChecks, RefreshCw } from "lucide-react";
import { TaskWorkspaceNav } from "./task-workspace-nav";
import {
  PreparationListSchema,
  PreparationViewSchema,
  type PreparationView,
} from "@yummyai/contracts/catalog/sales-plan-agent";
import type { SalesPlanList } from "@yummyai/contracts/catalog/sales-plan";
import { salesPlanRequest } from "../sales-plans/sales-plan-client";
import { OrderTaskPanel } from "./order-task-panel";
import { BusinessTaskPanel } from "./business-task-panel";
import { salesTaskView } from "./sales-task-view";
import { WorkflowTaskInbox } from "./workflow-task-inbox";
import { OrderTaskInbox } from "./order-task-inbox";
import { FollowupTaskInbox } from "./followup-task-inbox";
import { FollowupTaskDetail } from "./followup-task-detail";
import { FollowupSourceSchema } from "@yummyai/contracts/operations/followup";
import { NotificationMenu } from "../notifications/notification-menu";
import { BusinessTaskSourcePicker, type BusinessTaskSource } from "./business-task-source-picker";
import "../ai-tasks/ai-task-workspace.css";
import "../order-centers/order-centers.css";

export function BusinessTaskWorkspace() {
  const params = useSearchParams(),
    router = useRouter();
  const selected = params.get("target") ?? "",
    valid = /^[a-f0-9]{8}-[a-f0-9]{4}-7[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(selected);
  const rawKind = params.get("object"),
    kind: BusinessTaskSource =
      FollowupSourceSchema.safeParse(rawKind).success
        ? FollowupSourceSchema.parse(rawKind)
        : rawKind === "sales_plan"
        ? "sales_plan"
        : rawKind === "order" || (!rawKind && selected)
          ? "order"
          : "workflow";
  const invalidSource = rawKind !== null && !["workflow", "order", "sales_plan", ...FollowupSourceSchema.options].includes(rawKind);
  const [query, setQuery] = useState(""),
    [page, setPage] = useState(1),
    [more, setMore] = useState(false);
  const [items, setItems] = useState<Array<{ id: string; label: string }>>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  const [preparation, setPreparation] = useState<PreparationView | null>(null),
    [taskError, setTaskError] = useState(""),
    [taskLoading, setTaskLoading] = useState(false);
  const [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    setItems([]);
    if (kind !== "sales_plan" || invalidSource) {
      setLoading(false);
      return () => abort.abort();
    }
    const timer = setTimeout(() => {
      void (async () => {
        const rows = await salesPlanRequest<SalesPlanList>(
          `?${new URLSearchParams({ q: query, page: String(page) })}`,
          undefined,
          abort.signal,
        );
        if (abort.signal.aborted) return;
        setItems(
          rows.items.map((row) => ({
            id: row.id,
            label: `${row.fields.name} / V${row.revision}`,
          })),
        );
        setMore(rows.total > rows.page * rows.pageSize);
      })()
        .catch(() => {
          if (!abort.signal.aborted) setError("业务对象暂时无法读取，请核对权限或重新读取");
        })
        .finally(() => {
          if (!abort.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [kind, invalidSource, query, page, reload]);
  useEffect(() => {
    const abort = new AbortController();
    setPreparation(null);
    setTaskError("");
    setTaskLoading(false);
    if (kind !== "sales_plan" || !valid) return () => abort.abort();
    setTaskLoading(true);
    void (async () => {
      const list = PreparationListSchema.parse(
        await salesPlanRequest(`${selected}/launch/agent`, undefined, abort.signal),
      );
      if (!list.runs[0]) return;
      const view = PreparationViewSchema.parse(
        await salesPlanRequest(
          `${selected}/launch/agent/${list.runs[0].id}`,
          undefined,
          abort.signal,
        ),
      );
      if (!abort.signal.aborted) setPreparation(view);
    })()
      .catch(() => {
        if (!abort.signal.aborted) setTaskError("上架任务暂时无法读取，请进入原方案核对权限与资料");
      })
      .finally(() => {
        if (!abort.signal.aborted) setTaskLoading(false);
      });
    return () => abort.abort();
  }, [kind, selected, valid, reload]);
  function navigate(object: string, target = "") {
    router.push(
      `/business-tasks?${new URLSearchParams({ object, ...(target ? { target } : {}) })}`,
    );
  }
  function changeSource(object: BusinessTaskSource) {
    if (busy) return;
    setPage(1);
    setQuery("");
    navigate(object);
  }
  const orderReturn = new URLSearchParams(params.toString());
  orderReturn.set("object", "order");
  orderReturn.delete("target");
  return (
    <main className="ai-task-workspace business-task-workspace">
      <header className="at-header">
        <div>
          <h1>业务任务</h1>
          <p>跟进工作流分工、订单履约和上架准备</p>
        </div>
        <div className="at-actions">
          <NotificationMenu initialNotifications={[]} />
          <button
            disabled={busy || (kind === "sales_plan" && loading)}
            onClick={() => setReload((value) => value + 1)}
          >
            <RefreshCw size={15} aria-hidden="true" />
            刷新
          </button>
        </div>
      </header>
      <TaskWorkspaceNav current="business" />
      {invalidSource ? (
        <section role="alert">
          <p>业务对象类型无效 请重新选择</p>
          <BusinessTaskSourcePicker value="workflow" onChange={changeSource} />
        </section>
      ) : kind === "workflow" ? (
        <WorkflowTaskInbox reload={reload} onChangeSource={changeSource} />
      ) : kind === "procurement_order" || kind === "after_sales_case" || kind === "order_exception" ? (
        selected ? valid ? <FollowupTaskDetail key={`${kind}:${selected}`} source={kind} id={selected} reload={reload} onChangeSource={changeSource} onBusyChange={setBusy} /> : <p role="alert">业务对象编号无效</p> : <FollowupTaskInbox key={kind} source={kind} reload={reload} onChangeSource={changeSource} />
      ) : kind === "order" ? (
        selected ? (
          <section className="order-task-detail" aria-label="当前订单履约任务">
            <div className="order-task-detail-heading">
              <Link
                className="wi-open"
                href={`/business-tasks?${orderReturn}`}
                aria-disabled={busy}
                onClick={(event) => {
                  if (busy) event.preventDefault();
                }}
              >
                <ArrowLeft size={14} />
                返回订单待办
              </Link>
              <BusinessTaskSourcePicker value="order" disabled={busy} onChange={changeSource} />
            </div>
            {valid ? (
              <OrderTaskPanel
                key={selected}
                lineId={selected}
                refreshToken={reload}
                expanded
                onBusyChange={setBusy}
              />
            ) : (
              <p role="alert">业务对象编号无效</p>
            )}
          </section>
        ) : (
          <OrderTaskInbox reload={reload} onChangeSource={changeSource} />
        )
      ) : (
        <>
          <div className="at-layout">
            <aside className="at-history" aria-label="业务对象选择">
              <header>
                <h2>
                  <ListChecks size={16} aria-hidden="true" />
                  业务对象
                </h2>
                <span>第 {page} 页</span>
              </header>
              <div className="at-filters">
                <BusinessTaskSourcePicker value={kind} disabled={busy} onChange={changeSource} />
                <label>
                  搜索业务对象
                  <input
                    value={query}
                    disabled={busy}
                    maxLength={200}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setPage(1);
                    }}
                    placeholder="订单号或销售方案名称"
                  />
                </label>
              </div>
              {loading && <p role="status">正在读取业务对象…</p>}
              {error && (
                <p role="alert">
                  {error}
                  <button disabled={busy} onClick={() => setReload((value) => value + 1)}>
                    重新读取业务对象
                  </button>
                </p>
              )}
              {!loading && !error && !items.length && (
                <p className="at-history-empty">当前范围没有匹配对象</p>
              )}
              <div className="business-task-targets">
                {items.map((item) => (
                  <button
                    key={item.id}
                    className="oc-button"
                    disabled={busy}
                    aria-pressed={selected === item.id}
                    onClick={() => navigate(kind, item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <div className="at-pagination">
                <button
                  disabled={busy || page === 1 || loading}
                  onClick={() => setPage((value) => value - 1)}
                >
                  上一页
                </button>
                <button
                  disabled={busy || !more || loading}
                  onClick={() => setPage((value) => value + 1)}
                >
                  下一页
                </button>
              </div>
            </aside>
            <section className="at-detail" aria-label="当前业务任务">
              {!selected ? (
                <div className="at-empty-state">
                  <span>
                    <Inbox size={28} strokeWidth={1.5} aria-hidden="true" />
                  </span>
                  <h2>从一个业务对象开始</h2>
                  <p>选择订单或销售方案，查看当前阶段、所需资料与下一步</p>
                  <small>打开页面只读取已有进度</small>
                </div>
              ) : !valid ? (
                <p role="alert" className="at-error">
                  业务对象编号无效
                </p>
              ) : (
                <>
                  <Link
                    className="at-context-link"
                    href={`/sales-plans?plan=${selected}&view=tasks`}
                  >
                    打开原方案继续上架准备
                    <ArrowUpRight size={15} aria-hidden="true" />
                  </Link>
                  {taskLoading && <p role="status">正在读取上架任务…</p>}
                  {taskError && (
                    <p role="alert">
                      {taskError}
                      <button onClick={() => setReload((value) => value + 1)}>
                        重新读取上架任务
                      </button>
                    </p>
                  )}
                  {preparation && <BusinessTaskPanel task={salesTaskView(preparation)} />}
                  {!taskLoading && !taskError && !preparation && (
                    <p>尚无本人建立的上架准备任务，请进入方案开始</p>
                  )}
                </>
              )}
            </section>
          </div>
        </>
      )}
    </main>
  );
}
