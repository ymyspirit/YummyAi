"use client";
import { ORDER_LIFECYCLE_LABELS, type OrderLifecycleStatus } from "@yummyai/contracts/order/workbench";

export function OrderLifecycleBadge({ status }: { status?: OrderLifecycleStatus }) {
  return <span className={`oc-lifecycle-badge${status === "voided" ? " voided" : ""}`} data-order-status={status ?? "unknown"}>
    {status ? ORDER_LIFECYCLE_LABELS[status] : "订单状态暂不可用"}
  </span>;
}

export function OrderLifecycleProgress({ status }: { status?: OrderLifecycleStatus }) {
  return <div className="oc-order-progress" aria-label="整单生命周期">
    <span>订单状态</span><OrderLifecycleBadge status={status} />
    <ol>{Object.entries(ORDER_LIFECYCLE_LABELS).filter(([key]) => key !== "voided").map(([key, title]) =>
      <li key={key} aria-current={key === status ? "step" : undefined}>{title}</li>)}</ol>
    <small>整单所有商品共同决定进度；面单打印情况在发货记录中查看。</small>
  </div>;
}
