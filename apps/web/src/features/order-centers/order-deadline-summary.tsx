"use client";
import { useEffect, useState } from "react";
import type { OrderWorkDetail, OrderWorkListItem } from "@yummyai/contracts/order/workspace";
import { dateTime } from "./order-center-model";
import { orderPlatformShippingView } from "./order-auto-basis-model";

export function OrderDeadlineSummary({ row, shippingTime, includeInternal = true }: {
  row: OrderWorkListItem;
  shippingTime?: OrderWorkDetail["shippingTime"];
  includeInternal?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const deadline = orderPlatformShippingView(row, shippingTime, now);
  useEffect(() => {
    if (!deadline.active || !deadline.at) return;
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, [deadline.active, deadline.at]);
  return <div className={`oc-task-deadline ${deadline.tone}`}>
    <strong>{deadline.text}</strong>
    {deadline.at && <time dateTime={deadline.at}>{dateTime(deadline.at)}</time>}
    <small>{deadline.sourceLabel}</small>
    {includeInternal && row.dueAt && <details className="oc-internal-time"><summary>人工计划 可选</summary>
      <time dateTime={row.dueAt}>{dateTime(row.dueAt)}</time>
      <small>不替代平台截止</small>
    </details>}
  </div>;
}
