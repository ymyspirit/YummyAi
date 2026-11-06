import type {
  OrderIntakeCheck,
  OrderSalesSiteResolution,
} from "@yummyai/contracts/order/workspace";

export { resolveOrderSalesSite } from "@yummyai/order-core";

export function orderSalesSiteIssue(
  site: OrderSalesSiteResolution,
): OrderIntakeCheck["issues"][number] | null {
  if (site.status === "resolved") return null;
  return {
    code: site.status === "conflict" ? "order_site_conflict" : "order_site_missing",
    fieldKey: null,
    message:
      site.status === "conflict"
        ? "本单订单来源的站点存在冲突，需人工核对"
        : "本单缺少明确的订单站点，需人工核对",
    action: "核对本单所属店铺与原始平台站点，补齐一致来源后重新匹配；不能套用其他站点的资料包",
  };
}
