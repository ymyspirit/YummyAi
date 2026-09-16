import { z } from "zod";

export const OrderQueueStageSchema = z.enum([
  "needs_information",
  "pending_review",
  "ready_to_push",
  "queued",
  "in_progress",
  "changes_requested",
  "in_review",
  "approved",
  "production",
  "ready_to_ship",
  "shipped",
  "cancelled",
]);
export type OrderQueueStage = z.infer<typeof OrderQueueStageSchema>;
export const ORDER_QUEUE_LABELS: Record<OrderQueueStage, string> = {
  needs_information: "待补资料",
  pending_review: "待审单",
  ready_to_push: "待派发制图",
  queued: "待开始制图",
  in_progress: "制图中",
  changes_requested: "需改图",
  in_review: "待审图",
  approved: "已审图",
  production: "生产中",
  ready_to_ship: "待发货",
  shipped: "已交运",
  cancelled: "已取消",
};
export const OrderLabelStatusSchema = z.enum([
  "not_due",
  "unplanned",
  "missing",
  "partial",
  "ready",
]);
export const ORDER_LABEL_LABELS = {
  not_due: "尚未到发货环节",
  unplanned: "待建包裹",
  missing: "缺少面单",
  partial: "部分包裹缺面单",
  ready: "已有面单",
} as const;
export const OrderQueueCountsSchema = z.object({
  total: z.int().nonnegative(),
  orders: z.int().nonnegative(),
  quantity: z.int().nonnegative(),
  stages: z.record(OrderQueueStageSchema, z.int().nonnegative()),
  held: z.int().nonnegative(),
  overdue: z.int().nonnegative(),
  sourceChanged: z.int().nonnegative(),
  missingLabels: z.int().nonnegative(),
});
export type OrderQueueCounts = z.infer<typeof OrderQueueCountsSchema>;

/** Used by older transport fixtures; the database computes the same exclusive stage. */
export function orderQueueStage(row: {
  queueStage?: OrderQueueStage;
  sideState: string | null;
  preparation: string;
  artwork: string;
  production: string;
  readyQuantity: number;
  shippedQuantity: number;
  quantity: number;
}): OrderQueueStage {
  if (row.queueStage) return row.queueStage;
  if (row.sideState === "cancelled") return "cancelled";
  if (row.shippedQuantity >= row.quantity) return "shipped";
  if (row.readyQuantity > row.shippedQuantity) return "ready_to_ship";
  if (!["not_released", "cancelled"].includes(row.production)) return "production";
  if (row.artwork === "approved") return "approved";
  if (row.artwork === "in_review") return "in_review";
  if (row.artwork === "changes_requested") return "changes_requested";
  if (["starting", "in_progress"].includes(row.artwork)) return "in_progress";
  if (row.artwork === "queued") return "queued";
  return row.preparation === "needs_information"
    ? "needs_information"
    : row.preparation === "ready_to_push" || row.preparation === "pushed"
      ? "ready_to_push"
      : "pending_review";
}
