import { z } from "zod";

/** One customer order progresses as a whole; item-level execution stays in its records. */
export const OrderLifecycleStatusSchema = z.enum([
  "processing", "awaiting_review", "reviewed", "produced", "shipped", "voided",
]);
export type OrderLifecycleStatus = z.infer<typeof OrderLifecycleStatusSchema>;
export const ORDER_LIFECYCLE_LABELS: Record<OrderLifecycleStatus, string> = {
  processing: "处理中", awaiting_review: "待审核", reviewed: "已审核",
  produced: "已生产", shipped: "已出库", voided: "已作废",
};
export type OrderLifecycleLine = {
  sideState: string | null; artwork: string; proof: string;
  designCandidateReview?: boolean;
  proofVersionCurrent?: boolean; quantity: number; readyQuantity: number; shippedQuantity: number;
};
/** Computes from ALL items, before search, workflow filtering or pagination. */
export function orderLifecycleStatus(lines: readonly OrderLifecycleLine[]): OrderLifecycleStatus | null {
  if (!lines.length) return null;
  if (lines.every(line => line.sideState === "cancelled")) return "voided";
  if (lines.every(line => line.shippedQuantity >= line.quantity)) return "shipped";
  if (lines.every(line => line.readyQuantity >= line.quantity)) return "produced";
  if (lines.every(line => line.artwork === "approved" && (line.proof === "not_required"
    || line.proof === "approved" && line.proofVersionCurrent === true))) return "reviewed";
  if (lines.every(line => ["in_review", "approved"].includes(line.artwork) || line.designCandidateReview === true)) return "awaiting_review";
  return "processing";
}

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
export const OrderOperatorViewSchema = z.enum(["todo", "waiting", "exceptions", "all"]);
export type OrderOperatorView = z.infer<typeof OrderOperatorViewSchema>;
export const ORDER_OPERATOR_VIEW_LABELS: Record<OrderOperatorView, string> = {
  todo: "待我处理", waiting: "等待进展", exceptions: "异常", all: "全部订单",
};
export const OrderOperatorTaskKeySchema = z.enum([
  "review_order", "complete_information", "dispatch_design", "review_artwork",
  "customer_proof", "customer_changes", "verify_source", "held", "confirm_shipment",
  "after_sales", "design_attention", "production_attention", "waiting_design",
  "waiting_production", "waiting_shipping", "complete", "cancelled", "archived",
]);
export type OrderOperatorTaskKey = z.infer<typeof OrderOperatorTaskKeySchema>;
// These are operations-role tasks, not a claim that a named user has been assigned.
export const ORDER_OPERATOR_TODO_KEYS: readonly OrderOperatorTaskKey[] = [
  "review_order", "complete_information", "dispatch_design", "review_artwork",
  "customer_proof", "customer_changes", "verify_source", "held", "confirm_shipment", "after_sales",
];
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
  orderStatuses: z.record(OrderLifecycleStatusSchema, z.int().nonnegative()).optional(),
  operatorViews: z.object({
    todo: z.int().nonnegative(), waiting: z.int().nonnegative(),
    exceptions: z.int().nonnegative(), all: z.int().nonnegative(),
  }).optional(),
});
export type OrderQueueCounts = z.infer<typeof OrderQueueCountsSchema>;

/** Used by older transport fixtures; the database computes the same exclusive stage. */
export function orderQueueStage(row: {
  queueStage?: OrderQueueStage;
  designCandidateReview?: boolean;
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
  if (row.artwork === "in_review" || row.designCandidateReview === true) return "in_review";
  if (row.artwork === "changes_requested") return "changes_requested";
  if (["starting", "in_progress"].includes(row.artwork)) return "in_progress";
  if (row.artwork === "queued") return "queued";
  return row.preparation === "needs_information"
    ? "needs_information"
    : row.preparation === "ready_to_push" || row.preparation === "pushed"
      ? "ready_to_push"
      : "pending_review";
}

type OperatorRow = Parameters<typeof orderQueueStage>[0] & {
  held: boolean; sourceChanged: boolean; proof: string; afterSalesCount: number;
  platform: string; platformShipByAt?: string | null; dueAt: string | null;
  platformConfirmationPending?: boolean; proofVersionCurrent?: boolean;
  designExecutor?: string | null; designRunStatus?: string | null;
  archivedAt?: string | null; operatorTaskKey?: OrderOperatorTaskKey;
  operatorException?: boolean;
  orderStatus?: OrderLifecycleStatus;
};
export function orderOperatorTaskKey(row: OperatorRow): OrderOperatorTaskKey {
  if (row.operatorTaskKey) return row.operatorTaskKey;
  if (row.archivedAt) return "archived";
  if (row.sideState === "cancelled") return "cancelled";
  if (row.held || row.sideState === "on_hold") return "held";
  if (row.platformConfirmationPending) return "confirm_shipment";
  if (row.afterSalesCount > 0) return "after_sales";
  if (row.shippedQuantity >= row.quantity) return "complete";
  if (row.sourceChanged) return "verify_source";
  if (row.designRunStatus === "needs_attention") return "design_attention";
  if (["failed", "quality_hold", "cancel_requested"].includes(row.production)) return "production_attention";
  if (row.proof === "changes_requested") return "customer_changes";
  if (row.artwork === "approved" && (row.proof === "pending" || row.proof === "approved" && row.proofVersionCurrent === false)) return "customer_proof";
  switch (orderQueueStage(row)) {
    case "needs_information": return "complete_information";
    case "pending_review": return "review_order";
    case "ready_to_push": return "dispatch_design";
    case "in_review": return "review_artwork";
    case "changes_requested": return "design_attention";
    case "queued": case "in_progress": return "waiting_design";
    case "approved": case "production": return "waiting_production";
    case "ready_to_ship": return "waiting_shipping";
    case "cancelled": return "cancelled";
    case "shipped": return "complete";
  }
}
export function orderOperatorException(row: OperatorRow, now = Date.now()): boolean {
  if (row.operatorException !== undefined) return row.operatorException;
  const key = orderOperatorTaskKey(row);
  if (["archived", "cancelled"].includes(key)) return false;
  const outstanding = row.shippedQuantity < row.quantity;
  return ["held", "verify_source", "design_attention", "production_attention", "customer_changes", "complete_information", "confirm_shipment", "after_sales"].includes(key)
    || outstanding && (row.platform === "amazon" && !row.platformShipByAt
      || !!row.platformShipByAt && Date.parse(row.platformShipByAt) < now
      || !!row.dueAt && Date.parse(row.dueAt) < now);
}
export function orderOperatorTask(row: OperatorRow) {
  const key = orderOperatorTaskKey(row);
  const tasks = {
    review_order: ["核对买家定制要求", "运营", "核对规格、定制内容和买家原图，再确认审单。", "开始审单", "orders"],
    complete_information: ["补齐订单资料", "运营", "先核对缺项；需要买家补充的资料继续保留为待补资料。", "补齐资料", "orders"],
    dispatch_design: ["派发已确认的制作需求", "运营", "审单已确认，明确派发后才进入制图。", "推送设计", "orders"],
    review_artwork: ["审核图稿是否符合要求", "运营", "对照买家原图与定制要求，通过后系统自动准备正式文件。", "审核生产图", "artwork"],
    customer_proof: ["跟进客户校样确认", "运营", "只有本单需要客户校样时才等待确认，按实际回复记录依据。", "记录客户确认", "artwork"],
    customer_changes: ["处理客户修改要求", "运营", "核对客户反馈，协调修改并保留原稿与确认历史。", "处理修改要求", "artwork"],
    verify_source: ["核对更新的订单资料", "运营", "新导入资料与固定需求不同，核对差异后按现有变更流程处理。", "核对资料变化", "orders"],
    held: ["核对暂停原因", "运营", "先查看暂停依据，确认可以继续后再解除暂停。", "处理暂停", "orders"],
    confirm_shipment: ["核对平台发货确认", "运营", "已记录实际交运，平台确认仍需凭真实结果登记。", "核对平台确认", "shipments"],
    after_sales: ["跟进售后处理", "运营", "核对客户反馈和处理进度，按实际决定记录补做或补发。", "处理售后", "after-sales"],
    design_attention: ["制图需要处理", "制图", "等待制图人员核对失败或退回原因，沿有效结果恢复制作。", "查看制图异常", "artwork"],
    production_attention: ["生产需要处理", "生产", "等待生产人员核对失败、质检或停单原因。", "查看生产异常", "production"],
    waiting_design: ["等待制图", row.designExecutor === "agent" ? "设计 Agent" : row.designExecutor === "human" ? "美工" : "制图岗位", "制作完成后会进入待审图；实际进度可在制图详情查看。", "查看制图进度", "artwork"],
    waiting_production: ["等待生产推进", "生产", row.artwork === "approved" && row.production === "not_released" ? "审核已通过，由生产岗位跟进正式文件和工厂安排。" : "由生产岗位跟进工厂回执、生产与质检。", "查看生产进度", "production"],
    waiting_shipping: ["等待整单发货", "物流", "整单全部完工后打包发货；已有面单仍需记录实际发出。", "查看发货进度", "shipments"],
    complete: ["已发货", "物流", "跟进已有运单的实际物流进度。", "查看物流", "shipments"],
    cancelled: ["已取消", "运营", "保留取消记录及原始订单历史。", "查看详情", "orders"],
    archived: ["已归档", "运营", "保留历史；如需恢复，先核对归档与暂停原因。", "查看详情", "orders"],
  } as const;
  const [title, owner, description, action, module] = tasks[key];
  if (key === "waiting_production" && row.orderStatus && ["processing", "awaiting_review"].includes(row.orderStatus)) {
    return { key, title: "等待整单图稿审核", owner: "运营", description: "本件已审核，等待这一单其他制作图稿准备齐并通过审核。",
      action: "查看订单要求", module: "orders" as const, actionable: false };
  }
  if (key === "waiting_shipping" && row.orderStatus && !["produced", "shipped"].includes(row.orderStatus)) {
    return { key, title: "等待整单生产完成", owner: "生产", description: "这一单所有抱枕全部完工并检查通过后统一打包发货。",
      action: "查看生产进度", module: "production" as const, actionable: false };
  }
  if (key === "waiting_production") {
    const productionTasks: Record<string, [string, string, string]> = {
      not_released: ["选择承接整单的工厂", "审核稿已通过，核对正式文件后选择能承接全部商品的工厂。", "选择工厂"],
      cancelled: ["核对重新生产安排", "先核对原停单记录与当前正式文件，再安排整单制作。", "核对生产安排"],
      planned: ["下载整单生产文件", "准备本单全部正式文件，交给工厂后登记真实发送记录。", "准备整单文件"],
      submitted: ["跟进工厂排产与发货", "实际提交成功后默认已排产，用工厂 Excel 或 CSV 核对后续状态；完工、质检与实际交运仍按真实依据登记。", "核对工厂状态"],
      acknowledged: ["跟进工厂排产与发货", "用工厂 Excel 或 CSV 核对已排产与已发货，无需重复登记接单或开工；实际生产、质检和交运记录继续保留。", "核对工厂状态"],
      in_production: ["登记整单完工", "工厂完成本单全部商品后，凭实际依据登记完工。", "登记完工"],
      awaiting_quality: ["登记整单质检", "本单已完工，检查全部商品后记录真实质检结果。", "登记质检"],
    };
    const task = productionTasks[row.production];
    if (task) return { key, title: task[0], owner: "生产", description: task[1], action: task[2], module: "production" as const, actionable: row.production !== "submitted" };
  }
  if (key === "waiting_shipping") return { key, title: "核对整单包裹与已有运单", owner, description: "核对整单包裹和已有运单，审核后凭真实交运记录出库。", action: "处理整单发货", module, actionable: true };
  return { key, title, owner, description, action, module, actionable: ORDER_OPERATOR_TODO_KEYS.includes(key) };
}
