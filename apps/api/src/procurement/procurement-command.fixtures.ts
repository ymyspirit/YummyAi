/** Synthetic data only. Its database and every associated resource are owned by
 * the disposable acceptance runner, including teardown after a failed case. */
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { SupplyTermsSchema } from "@yummyai/contracts/catalog/product-supply";
import { memberships, membershipRoles, roles, productPlans, fulfillmentSuppliers,
  withTenant, type DatabaseConnection } from "@yummyai/database";
import { AuditService } from "../audit/audit.service.js";
import { ProductSupplyService } from "../catalog/product-supply.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";

export function requireProcurementCommandFixture() {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
  if (process.env.E2E_ISOLATED_DAILY !== "1" || !["postgres:", "postgresql:"].includes(url.protocol)
    || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(url.pathname))
    throw new Error("Procurement command integration requires the disposable acceptance runner");
}

export const procurementFixturePermissions = [Permission.ProcurementRead, Permission.ProcurementWrite, Permission.ProcurementApprove,
  Permission.InventoryRead, Permission.InventoryWrite, Permission.ProductRead, Permission.ProductWrite];
export const procurementFixtureKey = () => `synthetic-procurement-command-${randomUUID()}`;

export function procurementCommandFixture(database: DatabaseConnection) {
  requireProcurementCommandFixture();
  const tenantId = createEntityId(), foreignTenant = createEntityId(), userId = createEntityId(), coworkerId = createEntityId(), foreignUser = createEntityId();
  const context: TenantContext = { tenantId, userId, permissions: procurementFixturePermissions, dataScope: "tenant" };
  const coworker: TenantContext = { ...context, userId: coworkerId }, outsider: TenantContext = { ...context, tenantId: foreignTenant, userId: foreignUser };
  const audit = new AuditService(database), inventory = new InventoryService(database, audit), owner = new ProcurementService(database, inventory, audit);
  const supply = new ProductSupplyService(database, audit), roleIds = new Map<string, string>();
  let locationId: string, supplierId: string;

  async function initialize() {
    requireProcurementCommandFixture();
    for (const current of [context, coworker, outsider]) {
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic procurement command',$2) on conflict do nothing",
        [current.tenantId, `synthetic-command-${current.tenantId}`]);
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic procurement operator')",
        [current.userId, `procurement-command-${current.userId}`, `${current.userId}@example.test`]);
      await withTenant(database.db, current, async tx => {
        const membershipId = createEntityId(), roleId = createEntityId(); roleIds.set(current.userId, roleId);
        await tx.insert(memberships).values({ id: membershipId, tenantId: current.tenantId, userId: current.userId, status: "active" });
        await tx.insert(roles).values({ id: roleId, tenantId: current.tenantId, name: `Synthetic command ${roleId}`,
          permissions: [...procurementFixturePermissions], dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: current.tenantId, membershipId, roleId });
      });
    }
    const warehouse = await inventory.createWarehouse(context, { code: "COMMAND-WH", name: "Synthetic command warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
    locationId = (await inventory.createLocation(context, { warehouseId: warehouse.id, code: "COMMAND-HOLD", name: "Synthetic command location" })).id;
    supplierId = createEntityId();
    await withTenant(database.db, context, tx => tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId, name: "Synthetic command supplier",
      kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", createdBy: userId }));
  }

  async function clock() {
    const [row] = await withTenant(database.db, context, tx => tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`));
    return new Date(row!.now);
  }
  async function basis(current = context) {
    const suffix = randomUUID().slice(0, 8).toUpperCase(), now = await clock();
    const stock = await inventory.createStockItem(current, { code: `COMMAND-${suffix}`, name: `Synthetic command material ${suffix}`, skuId: null, baseUnit: "each" });
    const line = { lineKey: "LINE-1", stockItemId: stock.id, destinationLocationId: locationId, quantity: 20, unit: "each" as const };
    const future = new Date(now.getTime() + 86_400_000).toISOString();
    const requisitionInput = { code: `REQ-${suffix}`, reasonCode: "SYNTHETIC", lines: [line], idempotencyKey: procurementFixtureKey() };
    const purchaseInput = { code: `PO-${suffix}`, supplierId, requisitionId: null, quoteId: null, currency: "USD", expectedAt: future,
      lines: [{ ...line, unitCostMinor: 123 }], idempotencyKey: procurementFixtureKey() };
    return { stock, line, future, requisitionInput, purchaseInput };
  }
  async function quoted(current = context) {
    const original = await basis(current);
    const requisition = await owner.createRequisition(current, original.requisitionInput);
    const rfqInput = { expectedRequisitionVersion: 1, supplierIds: [supplierId], responseDueAt: original.future, idempotencyKey: procurementFixtureKey() };
    const rfq = await owner.createRfq(current, requisition.id, rfqInput);
    const quoteInput = { supplierId, currency: "USD", validUntil: original.future,
      lines: [{ lineKey: original.line.lineKey, unitCostMinor: 123, minimumOrderQuantity: 10, leadTimeDays: 2 }], idempotencyKey: procurementFixtureKey() };
    const quote = await owner.recordSupplierQuote(current, rfq.id, quoteInput);
    return { ...original, requisition, rfq, quote, rfqInput, quoteInput,
      quotedPurchaseInput: { ...original.purchaseInput, requisitionId: requisition.id, quoteId: quote.id } };
  }
  async function supplied() {
    const original = await basis(), now = await clock(), productId = createEntityId();
    await withTenant(database.db, context, tx => tx.insert(productPlans).values({ id: productId, tenantId, name: "Synthetic command supply product",
      status: "approved", customization: { version: 1, fields: [] }, createdBy: userId }));
    const terms = SupplyTermsSchema.parse({ fulfillmentModes: ["custom_order", "fba_replenishment"], stockItemId: original.stock.id,
      unitCostMinor: 123, currency: "USD", minimumOrderQuantity: 10, leadTimeDays: 2,
      validFrom: new Date(now.getTime() - 3_600_000).toISOString(), validUntil: original.future,
      status: "active", preference: "primary", sampleStatus: "passed" });
    const link = await supply.create(context, { productPlanId: productId, supplierId, skuId: null, terms, idempotencyKey: procurementFixtureKey() });
    const input = { purpose: "custom_order" as const, expectedVersion: 1, code: original.purchaseInput.code,
      destinationLocationId: locationId, quantity: original.line.quantity, expectedAt: original.future, idempotencyKey: procurementFixtureKey() };
    return { ...original, link, terms, input };
  }
  async function setPermissions(current: TenantContext, permissions: string[], dataScope: "self" | "team" | "tenant" = "tenant") {
    await withTenant(database.db, context, tx => tx.update(roles).set({ permissions, dataScope }).where(eq(roles.id, roleIds.get(current.userId)!)));
  }
  return { context, coworker, outsider, audit, inventory, owner, supply, roleIds,
    initialize, clock, basis, quoted, supplied, setPermissions, get locationId() { return locationId; }, get supplierId() { return supplierId; } };
}
