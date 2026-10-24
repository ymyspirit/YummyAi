"use client";
import { useEffect, useRef, useState } from "react";
import { Check, RefreshCw, RotateCcw, X } from "lucide-react";
import { ProductionCommandListSchema, ProductionCommandViewSchema, type PrepareProductionCommand, type ProductionCommandView } from "@yummyai/contracts/order/production-command";
import { centerRequest, dateTime, OrderCenterRequestError } from "./order-center-model";
import { AgentOperationHandoff } from "../ai-tasks/agent-operation-handoff";
import "./production-command-recovery.css";

/** Prepare first. Execution accepts only the returned ID. A lost prepare
 * response cannot cause a business write; the persisted intent remains listed. */
export async function submitProductionCommand(command: PrepareProductionCommand) {
  const prepared = ProductionCommandViewSchema.parse(await centerRequest("production-commands", command));
  const lines = command.kind === "approved_design" ? [command.input.orderLineId] : command.kind === "reviewed_line" ? [command.targetId] : command.input.items.map(item => item.lineId);
  if (prepared.kind !== command.kind || (command.kind !== "reviewed_line" && prepared.orderId !== command.targetId) ||
    prepared.lineIds.length !== lines.length || !lines.every(id => prepared.lineIds.includes(id))) throw new Error("原生产提交来源不一致 请重新读取");
  const result = prepared.status === "succeeded" ? prepared : ProductionCommandViewSchema.parse(await centerRequest(`production-commands/${prepared.id}/execute`, {}));
  if (result.id !== prepared.id || result.orderId !== prepared.orderId || result.kind !== prepared.kind) throw new Error("生产回执来源不一致 请查看原提交");
  if (result.status !== "succeeded" || !result.receipt) throw new Error(result.status === "rejected" ? "本次生产未下达 请查看原提交结果并核对来源" : "本次生产结果待确认 请在原提交中恢复");
  return result;
}

const statusLabels: Record<ProductionCommandView["status"], string> = {
  prepared: "已保存 等待下达", executing: "正在核对执行结果", uncertain: "结果待确认", succeeded: "生产安排已建立",
  rejected: "本次未下达", expired: "原制作资料已失效", cancelled: "已取消本次提交",
};
export function ProductionCommandRecovery({ orderId, lineId, refresh, onBlocked, onSucceeded, onDenied }: {
  orderId: string; lineId?: string; refresh: string | number; onBlocked(blocked: boolean): void;
  onSucceeded?(view: ProductionCommandView): void; onDenied?(): void;
}) {
  const [items, setItems] = useState<ProductionCommandView[]>([]), [reading, setReading] = useState(true), [error, setError] = useState("");
  const [working, setWorking] = useState(""), [reload, setReload] = useState(0), [truncated, setTruncated] = useState(false);
  const active = useRef<AbortController | null>(null), epoch = useRef(0), alive = useRef(true), sending = useRef(false);
  const callbacks = useRef({ onBlocked, onSucceeded, onDenied }); callbacks.current = { onBlocked, onSucceeded, onDenied };
  function denyHandoff(reason: string) {
    epoch.current++; active.current?.abort(); sending.current = false; setItems([]); setTruncated(false); setReading(false); setWorking(""); setError(reason);
    callbacks.current.onBlocked(true); callbacks.current.onDenied?.();
  }
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; active.current?.abort(); }; }, []);
  useEffect(() => {
    const check = () => { if (document.visibilityState !== "hidden" && !sending.current) setReload(value => value + 1); };
    window.addEventListener("focus", check); document.addEventListener("visibilitychange", check);
    return () => { window.removeEventListener("focus", check); document.removeEventListener("visibilitychange", check); };
  }, []);
  useEffect(() => {
    const controller = new AbortController(); active.current?.abort(); active.current = controller;
    const version = ++epoch.current; setReading(true); setError(""); callbacks.current.onBlocked(true);
    const params = new URLSearchParams({ orderId }); if (lineId) params.set("lineId", lineId);
    void centerRequest(`production-commands?${params}`, undefined, controller.signal).then(raw => {
      if (controller.signal.aborted || version !== epoch.current) return;
      const view = ProductionCommandListSchema.parse(raw);
      if (view.items.some(item => item.orderId !== orderId || lineId && !item.lineIds.includes(lineId))) throw new Error("生产提交不属于当前订单 请重新读取");
      setItems(view.items); setTruncated(view.truncated);
      callbacks.current.onBlocked(view.truncated || view.items.some(item => !item.acknowledged));
    }).catch(cause => {
      if (controller.signal.aborted || version !== epoch.current) return;
      if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) { setItems([]); callbacks.current.onDenied?.(); }
      setError(message(cause)); callbacks.current.onBlocked(true);
    }).finally(() => { if (!controller.signal.aborted && version === epoch.current) setReading(false); });
    return () => controller.abort();
  }, [orderId, lineId, refresh, reload]);

  async function act(item: ProductionCommandView, action: "execute" | "acknowledge" | "cancel") {
    if (sending.current) return; sending.current = true;
    const version = epoch.current; setWorking(item.id); setError(""); callbacks.current.onBlocked(true);
    try {
      const result = ProductionCommandViewSchema.parse(await centerRequest(`production-commands/${item.id}/${action}`, {}));
      if (!alive.current || version !== epoch.current) return;
      if (result.id !== item.id || result.orderId !== orderId || result.kind !== item.kind) throw new Error("生产回执与原提交不一致 请重新读取");
      setItems(previous => previous.map(row => row.id === result.id ? result : row));
      if (action === "execute" && result.status === "succeeded") callbacks.current.onSucceeded?.(result);
    } catch (cause) {
      if (!alive.current || version !== epoch.current) return;
      if (cause instanceof OrderCenterRequestError && [401, 403, 404].includes(cause.status)) { setItems([]); callbacks.current.onDenied?.(); }
      setError(message(cause));
    } finally { sending.current = false; if (alive.current) { setWorking(""); if (version === epoch.current) setReload(value => value + 1); } }
  }
  return <section className="oc-production-recovery" aria-label="待确认生产提交" aria-busy={reading || !!working}>
    <div className="oc-production-recovery-heading"><h3>待确认生产提交</h3><button type="button" className="oc-text-button" disabled={reading || !!working} onClick={() => setReload(value => value + 1)}><RefreshCw size={13} aria-hidden="true" />核对提交结果</button></div>
    {reading && <p role="status" className="oc-hint">正在核对本人原生产提交</p>}
    {error && <p role="alert" className="oc-error">{error} 重新核对成功前暂停新生产提交</p>}
    {!reading && !error && !items.length && <p className="oc-hint">当前没有待确认的生产提交</p>}
    {items.map(item => <article className="oc-production-recovery-item" key={item.id} hidden={item.acknowledged}>
      <div className="oc-production-recovery-heading"><strong>{statusLabels[item.status]}</strong><time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time></div>
      {item.summary ? <><p>{item.summary.orderNumber} · {item.summary.lineCount} 个商品 · {item.summary.quantity} 份{item.summary.factoryName ? ` · ${item.summary.factoryName}` : ""} · 预计完成 {dateTime(item.summary.expectedCompletionAt)}</p><p className="oc-production-recovery-instructions">{item.summary.instructions || "未填写额外说明"}</p><p className="oc-hint">沿用本次原确认的制造版本与审核文件</p></> : <p className="oc-hint">原制作资料已清除 仅保留提交状态与生产回执</p>}
      {item.receipt && <p className="oc-notice">已建立 {item.receipt.productionOrderIds.length} 个生产安排 刷新后仍保留本次结果</p>}
      {item.status === "rejected" && <p className="oc-hint">请重新核对订单状态 审核文件 制造版本与工厂要求 确认此结果后再填写新提交</p>}
      {item.status === "prepared" && item.summary && <AgentOperationHandoff reference={{ domain: "production", commandId: item.id, accountId: null }} disabled={reading || Boolean(working)} onDenied={denyHandoff} />}
      <div className="oc-actions">
        {item.canExecute && <button type="button" className="oc-button" disabled={reading || !!working} onClick={() => void act(item, "execute")}><RotateCcw size={13} aria-hidden="true" />{item.status === "prepared" ? "按原确认下达生产" : "恢复原生产提交"}</button>}
        {item.canCancel && <button type="button" className="oc-button" disabled={reading || !!working} onClick={() => void act(item, "cancel")}><X size={13} aria-hidden="true" />取消未下达提交</button>}
        {!["prepared", "executing", "uncertain"].includes(item.status) && <button type="button" className="oc-button" disabled={reading || !!working} onClick={() => void act(item, "acknowledge")}><Check size={13} aria-hidden="true" />已核对本次结果</button>}
      </div>
    </article>)}
    {truncated && <p role="status">还有未显示的提交 请先核对当前结果再重新读取</p>}
  </section>;
}
const message = (cause: unknown) => cause instanceof Error ? cause.message : "原生产提交暂时无法核对";
