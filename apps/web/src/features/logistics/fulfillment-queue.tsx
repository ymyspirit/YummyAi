"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight, RefreshCw } from "lucide-react";
import {
  FULFILLMENT_FLOW_LABELS,
  FulfillmentFlowQueueSchema,
  type FulfillmentFlowQueue,
} from "@yummyai/contracts/order/fulfillment-flow";
import { flowRequest } from "../order-centers/order-flow-panel";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { documentRequest } from "./document-client";
import type {
  OrderDocumentsPreview,
  DocumentExportView,
} from "@yummyai/contracts/logistics/documents";

const views = {
  all: "全部",
  processing: "自动处理中",
  ready: "待提交工厂",
  attention: "需要处理",
  completed: "已完成",
} as const;
type View = keyof typeof views;
function category(stage: string): View {
  return ["exception", "paused"].includes(stage)
    ? "attention"
    : stage === "waiting_factory"
      ? "ready"
      : stage === "completed"
        ? "completed"
        : "processing";
}
export function FulfillmentQueue() {
  const [data, setData] = useState<FulfillmentFlowQueue | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [view, setView] = useState<View>("all"),
    [selected, setSelected] = useState<string[]>([]);
  const transition = useOwnedViewTransition();
  const exports = useRef(new Map<string, { body: string; key: string }>());
  const reload = useCallback(async (signal?: AbortSignal) => {
    const next = FulfillmentFlowQueueSchema.parse(await flowRequest("orders", undefined, signal));
    if (signal?.aborted) return;
    setData(next);
    setError("");
    setSelected((previous) =>
      previous.filter((id) =>
        next.items.some((item) => item.orderId === id && category(item.stage) === "attention"),
      ),
    );
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        await reload(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : "自动发货进度读取失败");
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          timer = setTimeout(() => void refresh(), 15_000);
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reload]);
  async function resume() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = (await flowRequest("orders/resume", { orderIds: selected })) as {
        results: Array<{ resumed: boolean; message: string }>;
      };
      const succeeded = result.results.filter((item) => item.resumed).length;
      setNotice(
        `${succeeded} 个订单已交回自动处理${result.results.length > succeeded ? ` 其余订单需继续核对：${[...new Set(result.results.filter((item) => !item.resumed).map((item) => item.message))].join("；")}` : ""}`,
      );
      setSelected([]);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "继续处理失败");
    } finally {
      setBusy(false);
    }
  }
  async function exportReady(profileId: string, orders: NonNullable<typeof data>["items"]) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const selection = {
        profileVersionId: profileId,
        adapter: "printeque_factory" as const,
        orderIds: orders.map((order) => order.orderId),
        deliveryPackageIds: [...new Set(orders.flatMap((order) => order.deliveryPackageIds))],
        overrides: [],
      };
      const preview = await documentRequest<OrderDocumentsPreview>("preview", selection);
      if (!preview.ready) throw new Error("这批工厂文件已有变化 请在订单中核对异常后再导出");
      const body = JSON.stringify({ ...selection, expectedFingerprint: preview.fingerprint });
      if (exports.current.get(profileId)?.body !== body)
        exports.current.set(profileId, { body, key: crypto.randomUUID() });
      const generated = await documentRequest<DocumentExportView>("generate", {
        ...selection,
        expectedFingerprint: preview.fingerprint,
        idempotencyKey: exports.current.get(profileId)!.key,
      });
      const download = document.createElement("a");
      download.href = `/api/logistics/documents/exports/${generated.id}/file`;
      download.download = "";
      download.click();
      setNotice(`${orders.length} 个订单已合并为工厂生产表 下载后批量导入工厂 ERP`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "工厂表导出失败");
    } finally {
      setBusy(false);
    }
  }
  const items = data?.items.filter((item) => view === "all" || category(item.stage) === view) ?? [];
  const attention = items.filter((item) => category(item.stage) === "attention");
  const active = data?.routes.filter((route) => route.profile.mode !== "disabled") ?? [];
  const readyGroups = new Map<string, NonNullable<typeof data>["items"]>();
  for (const item of data?.items ?? [])
    if (
      item.stage === "waiting_factory" &&
      item.productionExportId &&
      item.documentProfileVersionId
    )
      readyGroups.set(item.documentProfileVersionId, [
        ...(readyGroups.get(item.documentProfileVersionId) ?? []),
        item,
      ]);
  return (
    <section className="fulfillment-queue" aria-label="自动发货进度" aria-busy={loading || busy}>
      <div className="fulfillment-queue-heading">
        <h2>审核后自动处理</h2>
        <button
          className="oc-text-button"
          aria-label="刷新自动发货进度"
          disabled={busy || loading}
          onClick={() =>
            void reload().catch((cause) =>
              setError(cause instanceof Error ? cause.message : "读取失败"),
            )
          }
        >
          <RefreshCw size={15} />
          刷新进度
        </button>
      </div>
      <ol className="fulfillment-steps" aria-label="订单自动处理流程">
        {["审单通过", "自动派发设计", "审核生产图", "自动比价下单", "工厂文件就绪"].map(
          (step, index) => (
            <li key={step}>
              {index > 0 && <ArrowRight aria-hidden size={14} />}
              <span>{step}</span>
            </li>
          ),
        )}
      </ol>
      <p className="oc-muted">
        日常在订单工作台审单和审图 系统按商品、国家与工厂规则继续 关闭页面也会处理
      </p>
      {!loading && data && (
        <div className="fulfillment-setup" role="status">
          {!active.length ? (
            <>
              <strong>自动发货尚未启用</strong>
              <p>当前产品规则均为暂停 管理员启用一次后 所有运营共用</p>
            </>
          ) : (
            <>
              <strong>{active.length} 条产品规则已启用</strong>
              <p>
                {active.filter((route) => route.profile.mode === "quote").length} 条只询价 ·{" "}
                {active.filter((route) => route.profile.mode === "purchase").length}{" "}
                条审核后自动购单
              </p>
            </>
          )}
          {data.routes
            .filter((route) => route.profile.mode !== "disabled" && route.blockers.length)
            .map((route) => (
              <p key={route.id}>
                {route.profile.name}：{route.blockers.join("；")}
              </p>
            ))}
          <Link href="/fulfillment-routes">
            {data.canConfigure ? "管理共用发货规则" : "查看共用发货规则"}
          </Link>
        </div>
      )}
      {error && (
        <p className="logistics-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {data?.canResume && !!readyGroups.size && (
        <div className="fulfillment-batch">
          <p>工厂文件已就绪 可按工厂合并导出 无需重新逐单填写</p>
          {[...readyGroups].map(([profileId, orders]) => (
            <button
              className="oc-button"
              key={profileId}
              disabled={busy}
              onClick={() => void exportReady(profileId, orders.slice(0, 50))}
            >
              {orders[0]!.routeName ?? "工厂"} · 合并生产表（{Math.min(orders.length, 50)} 单）
            </button>
          ))}
        </div>
      )}
      <div className="fulfillment-queue-controls">
        <div className="fulfillment-views" aria-label="筛选自动发货状态">
          {(Object.entries(views) as Array<[View, string]>).map(([key, title]) => (
            <button
              className="oc-button"
              key={key}
              aria-pressed={view === key}
              disabled={busy}
              onClick={() =>
                transition.change(() => {
                  setView(key);
                  setSelected([]);
                })
              }
            >
              {title}
            </button>
          ))}
        </div>
        {data?.canResume && !!attention.length && (
          <div className="oc-actions">
            <label>
              <input
                type="checkbox"
                disabled={busy}
                checked={attention.slice(0, 50).every((item) => selected.includes(item.orderId))}
                onChange={(event) =>
                  setSelected(
                    event.target.checked ? attention.slice(0, 50).map((item) => item.orderId) : [],
                  )
                }
              />
              选择异常订单
            </label>
            <button
              className="oc-button"
              disabled={busy || !selected.length}
              onClick={() => void resume()}
            >
              继续已修复的异常{selected.length ? `（${selected.length}）` : ""}
            </button>
          </div>
        )}
      </div>
      {loading && !data ? (
        <p role="status">正在读取自动处理进度</p>
      ) : !error && !items.length ? (
        <p className="oc-empty">
          {view === "all"
            ? "暂无自动处理记录 新审核的订单会自动出现在这里 无需再次选单或创建物流任务"
            : "当前没有此状态的订单"}
        </p>
      ) : null}
      {!!items.length && (
        <table className="fulfillment-queue-table">
          <thead>
            <tr>
              <th>订单</th>
              <th>当前进度</th>
              <th>处理说明</th>
              <th>文件与记录</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td data-label="订单">
                  <div className="fulfillment-order">
                    {data?.canResume && category(item.stage) === "attention" && (
                      <input
                        type="checkbox"
                        aria-label={`选择异常订单 ${item.orderNumber}`}
                        disabled={
                          busy || (selected.length >= 50 && !selected.includes(item.orderId))
                        }
                        checked={selected.includes(item.orderId)}
                        onChange={(event) =>
                          setSelected((previous) =>
                            event.target.checked
                              ? [...previous, item.orderId]
                              : previous.filter((id) => id !== item.orderId),
                          )
                        }
                      />
                    )}
                    <Link href={`/orders?line=${item.lineId}`}>{item.orderNumber}</Link>
                  </div>
                  <small>{item.routeName ?? "按已审核商品匹配规则"}</small>
                </td>
                <td data-label="当前进度">{FULFILLMENT_FLOW_LABELS[item.stage]}</td>
                <td data-label="处理说明">
                  {item.reasons.join("；") || "系统正在按已审核资料继续处理"}
                </td>
                <td data-label="文件与记录">
                  <div className="fulfillment-files">
                    {item.productionExportId && (
                      <a href={`/api/logistics/documents/exports/${item.productionExportId}/file`}>
                        工厂 ERP 表
                      </a>
                    )}
                    {item.deliveryPackageIds.map((id, index) => (
                      <a key={id} href={`/api/order-centers/deliveries/${id}/file`}>
                        生产文件包{item.deliveryPackageIds.length > 1 ? index + 1 : ""}
                      </a>
                    ))}
                    {item.logisticsTaskId && (
                      <Link href={`/logistics?task=${item.logisticsTaskId}`}>面单与费用</Link>
                    )}
                    {!item.productionExportId &&
                      !item.deliveryPackageIds.length &&
                      !item.logisticsTaskId && <span className="oc-muted">尚未到文件交付环节</span>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {data?.truncated && (
        <p className="oc-muted">
          这里只显示最近更新的 100 个订单 更早订单可在订单工作台按订单号查询
        </p>
      )}
    </section>
  );
}
