import type { OrderSalesSiteResolution } from "@yummyai/contracts/order/workspace";
import { amazonOrderReportBatches, amazonOrderReportBatchItems, orderSourceSnapshots, type orders, type TenantTransaction } from "@yummyai/database";
import { and, eq, or, sql } from "drizzle-orm";

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

export async function readOrderSalesSite(
  tx: TenantTransaction,
  order: Pick<typeof orders.$inferSelect, "id" | "accountId" | "platform" | "externalOrderId">,
) {
  // Updates append immutable sources while orders.sourceSnapshotId retains the
  // initial source. Read the exact order identity, including later deliveries,
  // and project only the adapter-owned, non-private site fields.
  const siteSources = order.platform === "amazon" ? await tx
    .select({
      marketplaceId: sql<unknown>`${orderSourceSnapshots.redactedPayload}->'marketplaceId'`,
      apiVersion: sql<unknown>`${orderSourceSnapshots.redactedPayload}->'apiVersion'`,
      source: sql<unknown>`${orderSourceSnapshots.redactedPayload}->'source'`,
      orderId: sql<unknown>`${orderSourceSnapshots.redactedPayload}->'orderId'`,
    })
    .from(orderSourceSnapshots)
    .where(and(
      eq(orderSourceSnapshots.normalizedOrderId, order.id),
      eq(orderSourceSnapshots.accountId, order.accountId),
      eq(orderSourceSnapshots.platform, order.platform),
      eq(orderSourceSnapshots.externalOrderId, order.externalOrderId),
    )) : [];
  const reportSites = order.platform === "amazon" ? await tx
    .select({ site: amazonOrderReportBatches.marketplaceId })
    .from(amazonOrderReportBatchItems)
    .innerJoin(
      amazonOrderReportBatches,
      eq(amazonOrderReportBatches.id, amazonOrderReportBatchItems.batchId),
    )
    .where(and(
      eq(amazonOrderReportBatchItems.orderId, order.id),
      eq(amazonOrderReportBatchItems.externalOrderId, order.externalOrderId),
      eq(amazonOrderReportBatches.accountId, order.accountId),
      or(
        eq(amazonOrderReportBatchItems.status, "imported"),
        eq(amazonOrderReportBatchItems.status, "duplicate"),
      ),
    )) : [];
  return resolveOrderSalesSite(
    order.platform,
    order.externalOrderId,
    siteSources,
    reportSites.map((row) => row.site),
  );
}
