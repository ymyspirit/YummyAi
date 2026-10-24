import { OrderOperatorViewSchema, type OrderOperatorView } from "@yummyai/contracts/order/workbench";
import type { OrderWorkListItem } from "@yummyai/contracts/order/workspace";

export const operatorWorkflowFilters = ["stage", "attention", "labelStatus", "preparation", "artwork", "proof", "production", "shipment", "afterSales", "archived"] as const;
export function operatorView(params: URLSearchParams): OrderOperatorView {
  const explicit = OrderOperatorViewSchema.safeParse(params.get("workView"));
  if (explicit.success) return explicit.data;
  return operatorWorkflowFilters.some(key => !!params.get(key) && params.get(key) !== "active") ? "all" : "todo";
}
export function orderDeadline(row: OrderWorkListItem, now = Date.now()) {
  const outstanding = !row.archivedAt && row.sideState !== "cancelled" && row.shippedQuantity < row.quantity;
  if (!row.platformShipByAt) return {
    text: row.platform === "amazon" ? "平台交期待核对" : "平台交期未提供",
    tone: outstanding && row.platform === "amazon" ? "warning" : "normal", missing: true,
  } as const;
  const hours = (Date.parse(row.platformShipByAt) - now) / 3_600_000;
  if (!outstanding) return { text: "平台截止记录", tone: "normal", missing: false } as const;
  const duration = Math.abs(hours) >= 24 ? `${Math.ceil(Math.abs(hours) / 24)} 天` : `${Math.max(1, Math.ceil(Math.abs(hours)))} 小时`;
  return {
    text: hours < 0 ? `平台截止已过 ${duration}` : `距平台截止 ${duration}`,
    tone: hours < 0 ? "danger" : hours <= 24 ? "warning" : "normal", missing: false,
  } as const;
}
