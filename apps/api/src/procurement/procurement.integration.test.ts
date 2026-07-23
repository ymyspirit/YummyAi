import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  inventoryBalances,
  inventoryLots,
  inventoryMovements,
  inventoryProcurementReceipts,
  inventoryPurchaseOrderVersions,
  inventoryReplenishmentSuggestions,
  inventorySupplierInvoices,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";

describe.sequential("inventory procurement", () => {
  const database = connectDatabase();
  const tenantA = createEntityId();
  const tenantB = createEntityId();
  const userA = createEntityId();
  const userB = createEntityId();
  const supplierId = createEntityId();
  const contextA = tenantContext(tenantA, userA);
  const contextB = tenantContext(tenantB, userB);
  const audit = new AuditService(database);
  const inventory = new InventoryService(database, audit);
  const service = new ProcurementService(database, inventory, audit);

  let stockItemId: string;
  let locationId: string;
  let requisitionId: string;
  let rfqId: string;
  let quoteId: string;
  let purchaseOrderId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)`,
      [
        tenantA,
        "Procurement Tenant A",
        `procurement-a-${tenantA}`,
        tenantB,
        "Procurement Tenant B",
        `procurement-b-${tenantB}`,
      ],
    );
    await database.client.unsafe(
      `insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)`,
      [
        userA,
        `procurement-user-a-${userA}`,
        `procurement-a-${userA}@example.test`,
        "Procurement A",
        userB,
        `procurement-user-b-${userB}`,
        `procurement-b-${userB}@example.test`,
        "Procurement B",
      ],
    );
    await database.client.unsafe(
      `insert into fulfillment_suppliers
       (id,tenant_id,name,kind,status,region_code,settlement_currency,priority,created_by)
       values ($1,$2,$3,'manual','active','US','USD',1,$4)`,
      [supplierId, tenantA, "Blank Goods Supplier", userA],
    );
    const warehouse = await inventory.createWarehouse(contextA, {
      code: "PROC-MAIN",
      name: "Procurement warehouse",
      type: "owned",
      countryCode: "US",
      timeZone: "America/Los_Angeles",
    });
    locationId = (await inventory.createLocation(contextA, {
      warehouseId: warehouse.id,
      code: "RECEIVE",
      name: "Receiving dock",
    })).id;
    stockItemId = (await inventory.createStockItem(contextA, {
      skuId: null,
      code: "PROC-PILLOW",
      name: "Procurement pillow blank",
      baseUnit: "each",
    })).id;
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("versions a requisition, RFQ, quote, purchase order, approval, receipt, and matched invoice", async () => {
    const requisitionInput = {
      code: "REQ-2026-001",
      reasonCode: "REORDER_POINT",
      lines: [requestLine(10)],
      idempotencyKey: "procurement-requisition-0001",
    };
    const requisition = await service.createRequisition(contextA, requisitionInput);
    const replay = await service.createRequisition(contextA, requisitionInput);
    expect(replay.id).toBe(requisition.id);
    requisitionId = requisition.id;

    const rfq = await service.createRfq(contextA, requisitionId, {
      expectedRequisitionVersion: 1,
      supplierIds: [supplierId],
      responseDueAt: "2026-08-01T00:00:00.000Z",
      idempotencyKey: "procurement-rfq-0001",
    });
    rfqId = rfq.id;
    const quote = await service.recordSupplierQuote(contextA, rfqId, {
      supplierId,
      currency: "USD",
      validUntil: "2026-08-20T00:00:00.000Z",
      lines: [{
        lineKey: "LINE-1",
        unitCostMinor: 425,
        minimumOrderQuantity: 5,
        leadTimeDays: 7,
      }],
      idempotencyKey: "procurement-quote-0001",
    });
    quoteId = quote.id;
    expect(quote).toMatchObject({ version: 1, totalMinor: 4250 });

    const order = await service.createPurchaseOrder(contextA, {
      code: "IPO-2026-001",
      supplierId,
      requisitionId,
      quoteId,
      currency: "USD",
      expectedAt: "2026-08-10T00:00:00.000Z",
      lines: [purchaseLine(10, 425)],
      idempotencyKey: "procurement-order-0001",
    });
    purchaseOrderId = order.id;
    expect(order).toMatchObject({ status: "draft", currentVersion: 1, totalMinor: 4250 });
    const approved = await service.reviewPurchaseOrder(contextA, purchaseOrderId, {
      expectedVersion: 1,
      decision: "approved",
      reasonCode: "BUDGET_APPROVED",
      idempotencyKey: "procurement-order-review-0001",
    });
    expect(approved.status).toBe("approved");

    const receiptInput = {
      expectedVersion: 1,
      receivedAt: "2026-08-09T12:00:00.000Z",
      externalReference: "ASN-001",
      lines: [{
        lineKey: "LINE-1",
        receivedQuantity: 10,
        rejectedQuantity: 0,
        rejectionReasonCode: null,
        lotCode: "PROC-LOT-001",
        expiresAt: null,
      }],
      idempotencyKey: "procurement-receipt-0001",
    };
    const receipt = await service.recordReceipt(contextA, purchaseOrderId, receiptInput);
    const receiptReplay = await service.recordReceipt(contextA, purchaseOrderId, receiptInput);
    expect(receiptReplay.receipt.id).toBe(receipt.receipt.id);
    expect(receipt).toMatchObject({
      receipt: { hasVariance: false },
      purchaseOrder: { status: "received" },
    });
    const [balance] = await withTenant(database.db, contextA, (tx) =>
      tx.select().from(inventoryBalances)
        .where(and(
          eq(inventoryBalances.stockItemId, stockItemId),
          eq(inventoryBalances.locationId, locationId),
        )),
    );
    expect(balance).toMatchObject({ physicalQuantity: 10, reservedQuantity: 0 });
    expect(await withTenant(database.db, contextA, (tx) =>
      tx.select().from(inventoryLots).where(eq(inventoryLots.sourceId, receipt.receipt.id)),
    )).toHaveLength(1);
    expect(await withTenant(database.db, contextA, (tx) =>
      tx.select().from(inventoryMovements).where(eq(inventoryMovements.sourceId, receipt.receipt.id)),
    )).toHaveLength(1);

    const invoice = await service.recordInvoice(contextA, purchaseOrderId, {
      invoiceNumber: "INV-001",
      currency: "USD",
      issuedAt: "2026-08-09T14:00:00.000Z",
      lines: [{ lineKey: "LINE-1", invoicedQuantity: 10, unitCostMinor: 425 }],
      idempotencyKey: "procurement-invoice-0001",
    });
    expect(invoice).toMatchObject({ status: "matched", varianceMinor: 0, totalMinor: 4250 });
  });

  it("keeps purchase versions immutable and uses optimistic revision numbers", async () => {
    const order = await service.createPurchaseOrder(contextA, {
      code: "IPO-2026-REVISION",
      supplierId,
      requisitionId: null,
      quoteId: null,
      currency: "USD",
      expectedAt: "2026-08-15T00:00:00.000Z",
      lines: [purchaseLine(8, 400)],
      idempotencyKey: "procurement-order-revision-create-0001",
    });
    const revised = await service.revisePurchaseOrder(contextA, order.id, {
      expectedVersion: 1,
      currency: "USD",
      expectedAt: "2026-08-16T00:00:00.000Z",
      lines: [purchaseLine(9, 410)],
      idempotencyKey: "procurement-order-revision-0001",
    });
    expect(revised).toMatchObject({ currentVersion: 2, totalMinor: 3690, status: "draft" });
    await expect(service.revisePurchaseOrder(contextA, order.id, {
      expectedVersion: 1,
      currency: "USD",
      expectedAt: "2026-08-17T00:00:00.000Z",
      lines: [purchaseLine(10, 410)],
      idempotencyKey: "procurement-order-revision-stale-0001",
    })).rejects.toBeInstanceOf(ConflictException);
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(inventoryPurchaseOrderVersions).set({ totalMinor: 1 })
        .where(eq(inventoryPurchaseOrderVersions.purchaseOrderId, order.id)),
    )).rejects.toThrow();
  });

  it("preserves stock but sends over-receipt, rejection, and invoice price variance to reconciliation", async () => {
    const order = await service.createPurchaseOrder(contextA, {
      code: "IPO-2026-VARIANCE",
      supplierId,
      requisitionId: null,
      quoteId: null,
      currency: "USD",
      expectedAt: "2026-08-20T00:00:00.000Z",
      lines: [purchaseLine(5, 500)],
      idempotencyKey: "procurement-order-variance-create-0001",
    });
    await service.reviewPurchaseOrder(contextA, order.id, {
      expectedVersion: 1,
      decision: "approved",
      reasonCode: "BUDGET_APPROVED",
      idempotencyKey: "procurement-order-variance-review-0001",
    });
    const receipt = await service.recordReceipt(contextA, order.id, {
      expectedVersion: 1,
      receivedAt: "2026-08-19T12:00:00.000Z",
      externalReference: null,
      lines: [{
        lineKey: "LINE-1",
        receivedQuantity: 5,
        rejectedQuantity: 1,
        rejectionReasonCode: "DAMAGED",
        lotCode: "PROC-LOT-VARIANCE",
        expiresAt: null,
      }],
      idempotencyKey: "procurement-receipt-variance-0001",
    });
    expect(receipt).toMatchObject({
      receipt: { hasVariance: true },
      purchaseOrder: { status: "reconciliation_required" },
    });
    const invoice = await service.recordInvoice(contextA, order.id, {
      invoiceNumber: "INV-VARIANCE",
      currency: "USD",
      issuedAt: "2026-08-19T14:00:00.000Z",
      lines: [{ lineKey: "LINE-1", invoicedQuantity: 5, unitCostMinor: 550 }],
      idempotencyKey: "procurement-invoice-variance-0001",
    });
    expect(invoice).toMatchObject({ status: "reconciliation_required", varianceMinor: 250 });
  });

  it("versions replenishment policy and emits a suggestion without creating an order", async () => {
    const before = (await service.workspace(contextA)).purchaseOrders.length;
    const policy = await service.upsertReplenishmentPolicy(contextA, {
      stockItemId,
      locationId,
      reorderPoint: 20,
      safetyStock: 5,
      minimumOrderQuantity: 8,
      leadTimeDays: 7,
      serviceLevelBps: 9500,
      reviewIntervalDays: 7,
      idempotencyKey: "replenishment-policy-0001",
    });
    const revised = await service.upsertReplenishmentPolicy(contextA, {
      stockItemId,
      locationId,
      reorderPoint: 24,
      safetyStock: 6,
      minimumOrderQuantity: 8,
      leadTimeDays: 8,
      serviceLevelBps: 9700,
      reviewIntervalDays: 7,
      idempotencyKey: "replenishment-policy-0002",
    });
    expect(revised.currentVersion).toBe(policy.currentVersion + 1);
    const suggestionInput = { idempotencyKey: "replenishment-suggestion-0001" };
    const suggestion = await service.createReplenishmentSuggestion(contextA, policy.id, suggestionInput);
    const replay = await service.createReplenishmentSuggestion(contextA, policy.id, suggestionInput);
    expect(replay.id).toBe(suggestion.id);
    expect(suggestion).toMatchObject({ policyVersion: 2, status: "open" });
    expect(suggestion.suggestedQuantity).toBeGreaterThan(0);
    expect((await service.workspace(contextA)).purchaseOrders).toHaveLength(before);
  });

  it("isolates procurement identities and keeps receipt, invoice, and suggestion evidence append-only", async () => {
    await expect(service.workspace(contextB)).resolves.toMatchObject({
      purchaseOrders: [],
      receipts: [],
      invoices: [],
    });
    await expect(service.createPurchaseOrder(contextB, {
      code: "FOREIGN-ORDER",
      supplierId,
      requisitionId: null,
      quoteId: null,
      currency: "USD",
      expectedAt: "2026-08-20T00:00:00.000Z",
      lines: [purchaseLine(1, 100)],
      idempotencyKey: "procurement-cross-tenant-0001",
    })).rejects.toBeInstanceOf(NotFoundException);
    const [privileges] = await withTenant(database.db, contextA, (tx) => tx.execute<{
      receipt_update: boolean;
      invoice_delete: boolean;
      suggestion_update: boolean;
      order_update: boolean;
    }>(sql`
      select
        has_table_privilege(current_user, 'inventory_procurement_receipts', 'UPDATE') as receipt_update,
        has_table_privilege(current_user, 'inventory_supplier_invoices', 'DELETE') as invoice_delete,
        has_table_privilege(current_user, 'inventory_replenishment_suggestions', 'UPDATE') as suggestion_update,
        has_table_privilege(current_user, 'inventory_purchase_orders', 'UPDATE') as order_update
    `));
    expect(privileges).toMatchObject({
      receipt_update: false,
      invoice_delete: false,
      suggestion_update: false,
      order_update: true,
    });
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(inventoryProcurementReceipts).set({ hasVariance: false }),
    )).rejects.toThrow();
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(inventorySupplierInvoices).set({ status: "matched" }),
    )).rejects.toThrow();
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(inventoryReplenishmentSuggestions).set({ status: "dismissed" }),
    )).rejects.toThrow();
  });

  function requestLine(quantity: number) {
    return {
      lineKey: "LINE-1",
      stockItemId,
      destinationLocationId: locationId,
      quantity,
      unit: "each" as const,
    };
  }

  function purchaseLine(quantity: number, unitCostMinor: number) {
    return { ...requestLine(quantity), unitCostMinor };
  }
});

function tenantContext(tenantId: string, userId: string): TenantContext {
  return {
    tenantId,
    userId,
    permissions: ["inventory:read", "inventory:write", "procurement:read", "procurement:write", "procurement:approve"],
    dataScope: "tenant",
  };
}
