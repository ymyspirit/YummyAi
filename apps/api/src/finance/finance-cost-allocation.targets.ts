import { createHash } from "node:crypto";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import {
  FinanceCostAllocationTargetSchema,
  financeCostTargetBasisIdentity,
  type FinanceCostAllocationDimension, type FinanceCostAllocationTarget,
} from "@yummyai/contracts/finance/cost-allocation";
import { listings, orderLineCatalogLinks, orderLines, orders, skus, type TenantTransaction } from "@yummyai/database";
import { and, asc, desc, eq, inArray, lt, lte } from "drizzle-orm";

export function costAllocationHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function allocationConflict(code: string, message: string): never {
  throw new ConflictException({ code, message });
}

export function allocationMissing(): never {
  throw new NotFoundException({ code: "finance_cost_allocation_not_found", message: "费用分摊依据或记录不存在" });
}

export function allocationInputInvalid(): never {
  throw new BadRequestException({ code: "finance_cost_allocation_input_invalid", message: "费用分摊填写或查询格式不正确" });
}

export function normalizeTargetKey(dimension: FinanceCostAllocationDimension, key: string): string {
  if (dimension === "period") return periodTarget(key).key;
  const parsed = EntityIdSchema.safeParse(key);
  if (!parsed.success) allocationInputInvalid();
  return parsed.data.toLowerCase();
}

export async function costAllocationTargetKeys(
  tx: TenantTransaction, tenantId: string, dimension: FinanceCostAllocationDimension,
  page: { limit: number; before?: string; upper?: string; key?: string },
): Promise<string[]> {
  if (dimension === "period") {
    if (!page.key) allocationInputInvalid();
    const key = periodTarget(page.key).key;
    return (!page.before || key < page.before) && (!page.upper || key <= page.upper) ? [key] : [];
  }
  const table = dimension === "order" ? orders : dimension === "order_line" ? orderLines : dimension === "sku" ? skus : listings;
  const rows = await tx.select({ id: table.id }).from(table).where(and(
    eq(table.tenantId, tenantId), page.key ? eq(table.id, page.key) : undefined,
    page.before ? lt(table.id, page.before) : undefined, page.upper ? lte(table.id, page.upper) : undefined,
  )).orderBy(desc(table.id)).limit(page.limit);
  return rows.map(row => row.id);
}

/** Resolve actual tenant lineage, never a caller's supplied order/SKU tuple. */
export async function resolveCostAllocationTargets(
  tx: TenantTransaction, tenantId: string, dimension: FinanceCostAllocationDimension, rawKeys: string[],
): Promise<Map<string, FinanceCostAllocationTarget>> {
  const keys = [...new Set(rawKeys.map(key => normalizeTargetKey(dimension, key)))].sort();
  const result = new Map<string, FinanceCostAllocationTarget>();
  if (!keys.length) return result;
  if (dimension === "period") {
    for (const key of keys) result.set(key, periodTarget(key));
    return result;
  }
  if (dimension === "order") {
    const rows = await tx.select({ id: orders.id, accountId: orders.accountId, platform: orders.platform }).from(orders)
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, keys)));
    for (const row of rows) result.set(row.id, target(dimension, row.id, `订单 ${row.id}`, { orderId: row.id, accountId: row.accountId }));
  } else if (dimension === "sku") {
    const rows = await tx.select({ id: skus.id, spuId: skus.spuId }).from(skus)
      .where(and(eq(skus.tenantId, tenantId), inArray(skus.id, keys)));
    for (const row of rows) result.set(row.id, target(dimension, row.id, `SKU ${row.id}`, { skuId: row.id, spuId: row.spuId }));
  } else if (dimension === "listing") {
    const rows = await tx.select({ id: listings.id, spuId: listings.spuId, platform: listings.platform }).from(listings)
      .where(and(eq(listings.tenantId, tenantId), inArray(listings.id, keys)));
    for (const row of rows) result.set(row.id, target(dimension, row.id, `Listing ${row.id}`, { listingId: row.id, spuId: row.spuId }));
  } else {
    const rows = await tx.select({ line: orderLines, order: { id: orders.id, accountId: orders.accountId, platform: orders.platform },
      link: orderLineCatalogLinks, sku: { id: skus.id, spuId: skus.spuId }, listing: { id: listings.id, spuId: listings.spuId, platform: listings.platform } })
      .from(orderLines).innerJoin(orders, and(eq(orders.tenantId, orderLines.tenantId), eq(orders.id, orderLines.orderId)))
      .leftJoin(orderLineCatalogLinks, and(eq(orderLineCatalogLinks.tenantId, orderLines.tenantId), eq(orderLineCatalogLinks.orderLineId, orderLines.id)))
      .leftJoin(skus, and(eq(skus.tenantId, orderLines.tenantId), eq(skus.id, orderLineCatalogLinks.skuId)))
      .leftJoin(listings, and(eq(listings.tenantId, orderLines.tenantId), eq(listings.id, orderLineCatalogLinks.listingId)))
      .where(and(eq(orderLines.tenantId, tenantId), inArray(orderLines.id, keys)));
    for (const row of rows) {
      if (row.link?.skuId && !row.sku || row.link?.listingId && !row.listing
        || row.sku && row.listing && row.sku.spuId !== row.listing.spuId
        || row.listing && row.listing.platform !== row.order.platform)
        allocationConflict("finance_cost_allocation_target_changed", "订单行的实际商品或渠道关系不一致 请先核对来源");
      result.set(row.line.id, target(dimension, row.line.id, `订单行 ${row.line.id}`,
        { orderId: row.order.id, orderLineId: row.line.id, skuId: row.sku?.id ?? null, listingId: row.listing?.id ?? null,
          accountId: row.order.accountId, catalogLinkId: row.link?.id ?? null, spuId: row.sku?.spuId ?? row.listing?.spuId ?? null }));
    }
  }
  return result;
}

/** Approval/calculation hold the actual, existing lineage rows. Preview and
 * historical reads use only the resolver above and take no business locks. */
export async function lockCostAllocationTargets(
  tx: TenantTransaction, tenantId: string, dimension: FinanceCostAllocationDimension, keys: string[],
) {
  if (dimension === "period" || !keys.length) return;
  const resolved = [...(await resolveCostAllocationTargets(tx, tenantId, dimension, keys)).values()];
  // Catalog links are append-only and have no UPDATE grant. Locking their
  // parent line FOR UPDATE also blocks a new link's FK KEY SHARE acquisition.
  const groups = [
    { table: orders, ids: resolved.flatMap(target => target.orderId ? [target.orderId] : []), strength: "share" as const },
    { table: orderLines, ids: resolved.flatMap(target => target.orderLineId ? [target.orderLineId] : []), strength: "update" as const },
    { table: skus, ids: resolved.flatMap(target => target.skuId ? [target.skuId] : []), strength: "share" as const },
    { table: listings, ids: resolved.flatMap(target => target.listingId ? [target.listingId] : []), strength: "share" as const },
  ];
  for (const { table, ids, strength } of groups) if (ids.length) await tx.select({ id: table.id }).from(table)
    .where(and(eq(table.tenantId, tenantId), inArray(table.id, [...new Set(ids)].sort()))).orderBy(asc(table.id)).for(strength);
}

function target(dimension: FinanceCostAllocationDimension, key: string, name: string,
  actual: Partial<Pick<FinanceCostAllocationTarget, "orderId" | "orderLineId" | "skuId" | "listingId" | "accountId" | "spuId" | "catalogLinkId">>) {
  const basis = { dimension, key, orderId: null, orderLineId: null, skuId: null, listingId: null, period: null,
    accountId: null, spuId: null, catalogLinkId: null, periodStart: null, periodEnd: null, ...actual };
  const value = { ...basis, label: name, basisChecksum: "0".repeat(64) };
  return FinanceCostAllocationTargetSchema.parse({ ...value, basisChecksum: costAllocationHash(financeCostTargetBasisIdentity(value)) });
}

function periodTarget(key: string): FinanceCostAllocationTarget {
  if (!/^(?!0000)[0-9]{4}-(?:0[1-9]|1[0-2])$/.test(key) || key === "9999-12") allocationInputInvalid();
  const start = new Date(`${key}-01T00:00:00.000Z`), end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const basis = { dimension: "period" as const, key, orderId: null, orderLineId: null, skuId: null, listingId: null,
    accountId: null, spuId: null, catalogLinkId: null, period: key, periodStart: start.toISOString(), periodEnd: end.toISOString() };
  const value = { ...basis, label: `${key} UTC 分析期间`, basisChecksum: "0".repeat(64) };
  return FinanceCostAllocationTargetSchema.parse({ ...value, basisChecksum: costAllocationHash(financeCostTargetBasisIdentity(value)) });
}
