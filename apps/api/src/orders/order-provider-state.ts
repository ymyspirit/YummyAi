import type { NormalizeOrderInput } from "@yummyai/contracts";
import { z } from "zod";

const AmazonStateSchema = z.object({
  lastUpdatedTime: z.iso.datetime().nullable().default(null), fulfilledBy: z.string().nullable().default(null),
  cancellationRequestedLineIds: z.array(z.string()).default([]), cancelledLineIds: z.array(z.string()).default([]),
});

export const providerBlockMessages = {
  payment_pending: "平台尚未允许履约 等待订单付款确认",
  cancellation_requested: "平台存在取消申请 已暂停设计和履约 请核对取消结果",
  cancelled: "平台显示订单或商品已取消 已暂停本地履约",
  amazon_fulfilled: "此订单由 Amazon 发货 不进入本地工厂生产",
  fulfillment_unknown: "平台未明确由卖家发货 暂停本地履约",
  already_shipped: "平台已发货 不重复生产或购买物流面单",
  partially_shipped: "平台已部分发货 请核对剩余商品 不能按原整单重复生产",
  status_unknown: "平台履约状态尚未确认 已暂停本地履约",
} as const;

export type ProviderBlockReason = keyof typeof providerBlockMessages;
export function amazonProviderState(input: NormalizeOrderInput) {
  if (input.platform !== "amazon" || input.redactedSource.apiVersion !== "2026-01-01") return null;
  const source = AmazonStateSchema.parse(input.redactedSource), status = input.providerStatus.toUpperCase().replaceAll("_", "");
  const blockReason: ProviderBlockReason | null = status === "CANCELLED" || status === "CANCELED" || source.cancelledLineIds.length ? "cancelled"
    : source.cancellationRequestedLineIds.length ? "cancellation_requested"
    : source.fulfilledBy === "AMAZON" ? "amazon_fulfilled"
    : ["PENDING", "PENDINGAVAILABILITY"].includes(status) ? "payment_pending"
    : status === "SHIPPED" ? "already_shipped"
    : status === "PARTIALLYSHIPPED" ? "partially_shipped"
    : source.fulfilledBy !== "MERCHANT" ? "fulfillment_unknown"
    : status !== "UNSHIPPED" || !source.lastUpdatedTime ? "status_unknown" : null;
  return { updatedAt: source.lastUpdatedTime ? new Date(source.lastUpdatedTime) : null, blockReason, message: blockReason ? providerBlockMessages[blockReason] : null };
}
