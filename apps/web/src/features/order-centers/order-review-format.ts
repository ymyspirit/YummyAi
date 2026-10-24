import type { FinanceFactType } from "@yummyai/contracts/finance";
export const reviewFactLabels: Record<FinanceFactType, string> = {
  sale_revenue: "商品收入", shipping_revenue: "运费收入", marketplace_commission: "平台佣金", advertising_spend: "广告费",
  fulfillment_fee: "履约费", storage_fee: "仓储费", refund: "退款", chargeback: "拒付", procurement_cost: "采购成本",
  production_cost: "生产成本", freight_cost: "货运费", carrier_cost: "承运费", tax: "税费", other_fee: "其他费用 / 模型费",
};
export const reviewDeadlineLabels = { on_time: "按时交运", late: "逾期交运", overdue: "已超期未全量交运", pending: "待交运", unknown: "待核对平台截止时间或交运证据" };
export const reviewProfitLabels = { verified: "所选口径已核验", incomplete: "利润待核对", unavailable: "财务证据不可用" };
export function reviewMoney(amount: number | null, currency: string | null): string {
  if (amount === null || !currency) return "待核对";
  const format = new Intl.NumberFormat("zh-CN", { style: "currency", currency });
  return `${currency} ${format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2))}`;
}
export function reviewMinutes(minutes: number | null): string {
  if (minutes === null) return "缺少事件时间";
  if (minutes < 60) return `${Math.round(minutes)} 分钟`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} 小时`;
  return `${(minutes / 1440).toFixed(1)} 天`;
}
