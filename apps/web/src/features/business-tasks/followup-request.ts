import type { FollowupSource } from "@yummyai/contracts/operations/followup";
export class FollowupRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function followupRequest(
  source: FollowupSource,
  path: string,
  signal?: AbortSignal,
  input?: unknown,
) {
  const response = await fetch(`/api/business-followups/${source}/${path}`, {
    cache: "no-store",
    signal,
    ...(input
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }
      : {}),
  });
  const value = await response.json().catch(() => null);
  if (!response.ok)
    throw new FollowupRequestError(
      response.status,
      typeof value?.message === "string" ? value.message : "业务跟进暂时无法读取 请重试",
    );
  return value;
}
export const followupNames = {
  procurement_order: "采购跟进",
  after_sales_case: "售后跟进",
  order_exception: "订单异常",
} satisfies Record<FollowupSource, string>;
export function followupStatus(source: FollowupSource, status: string) {
  const labels: Record<FollowupSource, Record<string, string>> = {
    procurement_order: {
      draft: "待采购审核",
      approved: "采购已批准",
      rejected: "待修订采购",
      partially_received: "部分收货",
      received: "已收货",
      reconciliation_required: "差异待核对",
      cancelled: "已取消",
    },
    after_sales_case: {
      open: "待核对诉求",
      awaiting_customer: "待客户补充",
      awaiting_internal: "待内部处理",
      approved: "方案已批准",
      rejected: "方案已拒绝",
      resolved: "已结案",
      cancelled: "已取消",
    },
    order_exception: { open: "待解决", resolved: "已解决" },
  };
  return labels[source][status] ?? "待核对状态";
}
export function followupContext(source: FollowupSource, value: string) {
  if (source !== "order_exception") return value;
  return (
    (
      {
        address: "地址",
        customization_missing: "定制资料",
        design_overdue: "制图逾期",
        customer_timeout: "客户回复逾期",
        sourcing: "采购供货",
        production: "生产",
        quality: "质量",
        logistics: "物流",
        cancellation_requested: "取消申请",
        refund: "退款",
        remake: "补做",
        reshipment: "补发",
      } as Record<string, string>
    )[value] ?? "订单异常"
  );
}
