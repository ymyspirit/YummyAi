import type {
  OrderIntakeCheck,
  OrderSalesSiteResolution,
} from "@yummyai/contracts/order/workspace";

type SiteSource = {
  marketplaceId: unknown;
  apiVersion: unknown;
  source: unknown;
  orderId: unknown;
};

/** Only the fields written by our order adapters can establish a channel site. */
export function resolveOrderSalesSite(
  platform: string,
  externalOrderId: string,
  snapshots: readonly SiteSource[],
  reportSites: readonly string[],
): OrderSalesSiteResolution {
  if (platform === "etsy")
    return { status: "resolved" as const, marketplaceId: "etsy" };
  if (platform !== "amazon")
    return { status: "missing" as const, marketplaceId: null };
  const sites = new Set<string>();
  const addSite = (value: unknown) => {
    if (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 100 &&
      value === value.trim()
    )
      sites.add(value);
  };
  for (const snapshot of snapshots) {
    if (
      (snapshot.apiVersion === "2026-01-01" && snapshot.orderId === externalOrderId) ||
      snapshot.source === "amazon_manual_report"
    )
      addSite(snapshot.marketplaceId);
  }
  for (const site of reportSites) addSite(site);
  // A later complete source may fill an initial gap. Conflicting evidence is
  // never resolved by arrival order or by guessing an account's default site.
  if (sites.size > 1) return { status: "conflict" as const, marketplaceId: null };
  const [marketplaceId] = sites;
  return marketplaceId
    ? { status: "resolved" as const, marketplaceId }
    : { status: "missing" as const, marketplaceId: null };
}

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
