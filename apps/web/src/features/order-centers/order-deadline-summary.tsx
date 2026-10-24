import type { OrderWorkListItem } from "@yummyai/contracts/order/workspace";
import { orderDeadline } from "./order-operator-view";
import { dateTime } from "./order-center-model";

export function OrderDeadlineSummary({ row }: { row: OrderWorkListItem }) {
  const deadline = orderDeadline(row);
  return <div className={`oc-task-deadline ${deadline.tone}`}>
    <strong>{deadline.text}</strong>
    {row.platformShipByAt && <time dateTime={row.platformShipByAt}>{dateTime(row.platformShipByAt)}</time>}
    {row.platformShipByAt && <small>{row.platformDeadlineVerifiedAt ? "人工核对记录" : "核对依据待确认"}</small>}
    {row.dueAt && <small>内部计划：{dateTime(row.dueAt)}</small>}
  </div>;
}
