import { createHash } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Permission, ForbiddenError, authorize, intersectPermissionContexts } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { ClassifyInventoryStockItemInputSchema, InventoryStockClassificationViewSchema,
  InventoryStockClassificationResultSchema, InventoryStockClassificationHistorySchema, InventoryStockItemViewSchema,
  type ClassifyInventoryStockItemInput, type InventoryMaterialKind } from "@yummyai/contracts/inventory";
import { inventoryStockItems, inventoryStockItemClassifications as classifications, loadCurrentMembershipContext,
  withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import type { AuditService } from "../audit/audit.service.js";

type Stock = typeof inventoryStockItems.$inferSelect;
type Classification = typeof classifications.$inferSelect;
const classificationView = (row: Classification) => InventoryStockClassificationViewSchema.parse({
  id: row.id, versionNumber: row.versionNumber, kind: row.kind, recordedAt: row.createdAt.toISOString(),
});

export async function stockClassificationViews(tx: TenantTransaction, stockItemIds: string[]) {
  if (!stockItemIds.length) return new Map<string, ReturnType<typeof classificationView>>();
  const rows = await tx.selectDistinctOn([classifications.stockItemId]).from(classifications)
    .where(inArray(classifications.stockItemId, stockItemIds)).orderBy(classifications.stockItemId, desc(classifications.versionNumber));
  return new Map(rows.map(row => [row.stockItemId, classificationView(row)]));
}

async function stockView(tx: TenantTransaction, row: Stock) {
  return InventoryStockItemViewSchema.parse({ ...row, classification: (await stockClassificationViews(tx, [row.id])).get(row.id) ?? null });
}
async function authority(tx: TenantTransaction, context: TenantContext, permission: Permission, row?: Stock) {
  const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
  authorize(current, permission, row ? { ownerId: row.createdBy } : undefined);
  return current;
}
async function append(tx: TenantTransaction, context: TenantContext, audit: AuditService, stock: Stock, input: ClassifyInventoryStockItemInput) {
  const checksum = createHash("sha256").update(canonicalJson({ stockItemId: stock.id, ...input })).digest("hex");
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`inventory-stock-classification-key:${context.tenantId}:${input.idempotencyKey}`},0))`);
  const [replayed] = await tx.select().from(classifications).where(eq(classifications.idempotencyKey, input.idempotencyKey)).limit(1);
  if (replayed) {
    if (replayed.stockItemId !== stock.id || replayed.createdBy !== context.userId || replayed.requestChecksum !== checksum)
      throw new ConflictException("Classification request differs from its original input");
    return InventoryStockClassificationResultSchema.parse({ stockItem: await stockView(tx, stock), classification: classificationView(replayed), replayed: true });
  }
  // The stock lock also orders independent SQL inserts through the database guard.
  await tx.select({ id: inventoryStockItems.id }).from(inventoryStockItems).where(eq(inventoryStockItems.id, stock.id)).for("update");
  const [previous] = await tx.select().from(classifications).where(eq(classifications.stockItemId, stock.id)).orderBy(desc(classifications.versionNumber)).limit(1);
  if ((previous?.versionNumber ?? 0) !== input.expectedVersion) throw new ConflictException("Stock classification version changed");
  const [created] = await tx.insert(classifications).values({ id: createEntityId(), tenantId: context.tenantId,
    stockItemId: stock.id, versionNumber: input.expectedVersion + 1, kind: input.kind, reason: input.reason,
    requestChecksum: checksum, idempotencyKey: input.idempotencyKey, createdBy: context.userId }).returning();
  await audit.recordInTransaction(tx, context, { action: "inventory.stock_item.classify", resourceType: "inventory_stock_item",
    resourceId: stock.id, result: "success", metadata: { version: created!.versionNumber, kind: input.kind } });
  return InventoryStockClassificationResultSchema.parse({ stockItem: await stockView(tx, stock), classification: classificationView(created!), replayed: false });
}

export async function initialStockClassification(tx: TenantTransaction, context: TenantContext, audit: AuditService, stock: Stock, kind: InventoryMaterialKind) {
  const current = await authority(tx, context, Permission.InventoryWrite, stock);
  return append(tx, current, audit, stock, { expectedVersion: 0, kind, reason: "新建物料时明确选择的分类", idempotencyKey: `stock-classification:${stock.id}:initial` });
}

export function classifyStockItem(database: DatabaseConnection, audit: AuditService, context: TenantContext, stockItemId: string, rawInput: ClassifyInventoryStockItemInput) {
  const input = ClassifyInventoryStockItemInputSchema.parse(rawInput);
  return withTenant(database.db, context, async tx => {
    const current = await authority(tx, context, Permission.InventoryWrite);
    const [stock] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, stockItemId)).limit(1);
    if (!stock) throw new NotFoundException("Stock item not found");
    authorize(current, Permission.InventoryWrite, { ownerId: stock.createdBy });
    return append(tx, current, audit, stock, input);
  });
}

export function stockClassificationHistory(database: DatabaseConnection, context: TenantContext, stockItemId: string, beforeVersion?: number) {
  return withTenant(database.db, context, async tx => {
    const current = await authority(tx, context, Permission.InventoryRead);
    const [stock] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, stockItemId)).limit(1);
    if (!stock) throw new NotFoundException("Stock item not found");
    authorize(current, Permission.InventoryRead, { ownerId: stock.createdBy });
    let canClassify = true;
    try { authorize(current, Permission.InventoryWrite, { ownerId: stock.createdBy }); }
    catch (error) { if (error instanceof ForbiddenError) canClassify = false; else throw error; }
    const rows = await tx.select().from(classifications).where(and(eq(classifications.stockItemId, stock.id),
      beforeVersion === undefined ? undefined : lt(classifications.versionNumber, beforeVersion))).orderBy(desc(classifications.versionNumber)).limit(26);
    return InventoryStockClassificationHistorySchema.parse({ stockItem: await stockView(tx, stock), canClassify,
      items: rows.slice(0, 25).map(row => ({ ...classificationView(row), reason: row.reason })), nextVersion: rows.length > 25 ? rows[24]!.versionNumber : null });
  });
}
