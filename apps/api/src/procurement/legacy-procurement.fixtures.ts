/** Historical fixture only. Never use future Drizzle columns on an old schema. */
import { createHash } from "node:crypto";
import { CreateInventoryPurchaseOrderInputSchema, createEntityId, type CreateInventoryPurchaseOrderInput, type TenantContext } from "@yummyai/contracts";
import { inventoryPurchaseOrderVersions, inventoryPurchaseOrderEvents, withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { procurementAmountMinor, sumProcurementMinor } from "@yummyai/contracts/procurement/measurement";

export async function seedLegacyApprovedPurchase(database: DatabaseConnection, context: TenantContext, raw: CreateInventoryPurchaseOrderInput) {
  requireDisposableIntegrationEnvironment();
  if (!["pre-0142", "pre-0143"].includes(process.env.E2E_LEGACY_SCHEMA_TARGET ?? "")) throw new Error("Historical procurement fixture required");
  const input = CreateInventoryPurchaseOrderInputSchema.parse(raw);
  if (input.quoteId || input.requisitionId) throw new Error("Historical fixture supports a plain synthetic purchase only");
  const [column] = await database.client.unsafe("select count(*)::int as count from information_schema.columns where table_schema='public' and table_name='inventory_purchase_orders' and column_name='receiving_policy'");
  if (column?.count !== 0) throw new Error("Do not seed legacy purchases into a current schema");
  const id = createEntityId(), versionId = createEntityId(), lines = [...input.lines].sort((a, b) => a.lineKey.localeCompare(b.lineKey));
  await withTenant(database.db, context, async tx => {
    await tx.execute(sql`insert into inventory_purchase_orders(id,tenant_id,code,supplier_id,status,current_version,expected_at,idempotency_key,created_by)
      values(${id},${context.tenantId},${input.code},${input.supplierId},'draft',1,${input.expectedAt}::timestamptz,${input.idempotencyKey},${context.userId})`);
    await tx.insert(inventoryPurchaseOrderVersions).values({ id: versionId, tenantId: context.tenantId, purchaseOrderId: id, versionNumber: 1,
      currency: input.currency, expectedAt: new Date(input.expectedAt), lineSnapshot: lines, totalMinor: sumProcurementMinor(lines.map(line => procurementAmountMinor(line.quantity, line.unitCostMinor, line.priceBasisQuantity ?? 1))),
      checksum: createHash("sha256").update(JSON.stringify({ currency: input.currency, expectedAt: input.expectedAt, lines })).digest("hex"), createdBy: context.userId });
    await tx.insert(inventoryPurchaseOrderEvents).values([
      { id: createEntityId(), tenantId: context.tenantId, purchaseOrderId: id, sequence: 1, action: "created", fromStatus: null, toStatus: "draft", reasonCode: null, idempotencyKey: input.idempotencyKey, actorUserId: context.userId },
      { id: createEntityId(), tenantId: context.tenantId, purchaseOrderId: id, sequence: 2, action: "approved", fromStatus: "draft", toStatus: "approved", reasonCode: "SYNTHETIC_APPROVED", idempotencyKey: `${input.idempotencyKey}-review`, actorUserId: context.userId },
    ]);
    await tx.execute(sql`update inventory_purchase_orders set status='approved' where id=${id}::uuid`);
  });
  return { id, versionId, code: input.code, currentVersion: 1 };
}
