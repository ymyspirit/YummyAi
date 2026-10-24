import type { OrderWorkSummary, OrderWorkSummaryAvailability } from "@yummyai/contracts/order/workspace";

/** Availability is derived from the retained original source, never from a missing
 * work item or a translated exception message. An absent source has no deadline. */
export function orderSummaryAvailability(facts: {
  anonymized: boolean;
  deadlines: readonly Date[];
  cleared?: boolean;
  archived?: boolean;
  failed?: boolean;
}, now: Date): OrderWorkSummaryAvailability {
  if (facts.anonymized) return "cleared";
  if (!Number.isFinite(now.getTime()) || facts.deadlines.some(date => !Number.isFinite(date.getTime()))) return "failed";
  if (facts.deadlines.some(date => date <= now)) return "expired";
  if (facts.cleared) return "cleared";
  if (facts.archived) return "archived";
  return facts.failed ? "failed" : "available";
}

export const orderSummaryUnavailableReason = (availability: Exclude<OrderWorkSummaryAvailability, "available">) => ({
  cleared: "订单资料已按保留规则清理",
  expired: "订单资料已到保存期限",
  archived: "订单制作记录已归档",
  failed: "定制摘要暂时无法读取",
})[availability];

export function hideOrderSummary(summary: OrderWorkSummary, availability: Exclude<OrderWorkSummaryAvailability, "available">,
  error = orderSummaryUnavailableReason(availability)): void {
  summary.availability = availability;
  summary.error = error;
  summary.sourceVersionId = null;
  summary.designExecutor = null;
  summary.spu = null;
  summary.specification = null;
  summary.fields = [];
  summary.instructions = "";
  summary.images = [];
  summary.blockers = [];
}
