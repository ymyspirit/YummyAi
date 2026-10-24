import type { OrderWorkSummary, OrderWorkSummaryAvailability } from "@yummyai/contracts/order/workspace";

export type OrderSummaryState = OrderWorkSummaryAvailability | "loading" | "unknown";

/** Only the explicit source state grants access to summary content. Older wire
 * responses and mismatched revisions remain unverified, regardless of prose. */
export function orderSummaryState(summary: OrderWorkSummary | undefined, {
  revision, loading = false, failed = false,
}: { revision: number; loading?: boolean; failed?: boolean }): OrderSummaryState {
  if (summary) {
    if (summary.availability === undefined) return "unknown";
    if (summary.availability !== "available") return summary.availability;
    return summary.revision === revision ? "available" : "unknown";
  }
  return loading ? "loading" : failed ? "failed" : "unknown";
}

export const orderSummaryMessages: Record<OrderSummaryState, { title: string; reason: string; short: string }> = {
  available: { title: "定制资料可用", reason: "当前来源已读取 编辑与制作仍须核对原订单条件", short: "资料可用" },
  cleared: { title: "定制资料已清理", reason: "原私有内容已按保留规则清除 订单历史仍保留", short: "已清理" },
  expired: { title: "定制资料已到期", reason: "原私有资料已超过访问期限 不再按旧内容编辑或制作", short: "已到期" },
  archived: { title: "定制资料已归档", reason: "订单历史仍可查看 当前不开放原资料编辑与制作", short: "已归档" },
  failed: { title: "定制资料读取失败", reason: "暂未取得本件定制内容 请重新读取 原订单记录仍保留", short: "读取失败" },
  loading: { title: "正在读取定制资料", reason: "正在核对当前来源与版本 读取完成前暂停编辑和制作", short: "正在读取" },
  unknown: { title: "定制资料状态待核对", reason: "尚未取得明确的资料状态 不使用旧内容继续编辑或制作", short: "待核对" },
};
