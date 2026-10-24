import { ConflictException, NotFoundException } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { addStockQuantity } from "@yummyai/contracts/inventory/quantity";
import {
  connectDatabase,
  auditEvents,
  inventoryBalances,
  inventoryLots,
  inventoryMovements,
  inventoryProcurementReceipts,
  inventoryPurchaseOrderVersions,
  inventoryReplenishmentSuggestions,
  inventorySupplierInvoices,
  memberships, membershipRoles, roles,
  inventoryProcurementReceiptRequests,
  inventoryProcurementWriteRequests, inventoryProcurementRequisitions, inventoryProcurementRequisitionVersions, inventoryPurchaseOrders,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";
import { IncomingInspectionService } from "./incoming-inspection.service.js";
import { recordInspectedReceiptFixture, prepareInspectedReceiptFixture } from "./incoming-inspection.fixtures.js";

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
  const incoming = new IncomingInspectionService(database, service, audit);
  const recordReceipt = (context: TenantContext, orderId: string, input: Parameters<typeof service.recordReceipt>[2]) => recordInspectedReceiptFixture(service, incoming, context, orderId, input);

  let stockItemId: string;
  let locationId: string;
  let requisitionId: string;
  let rfqId: string;
  let quoteId: string;
  let purchaseOrderId: string;
  const roleIds = new Map<string, string>();

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
    for (const context of [contextA, contextB]) await withTenant(database.db, context, async tx => {
      const member = createEntityId(), role = createEntityId();
      roleIds.set(context.userId, role);
      await tx.insert(memberships).values({ id: member, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: role, tenantId: context.tenantId, name: `Synthetic procurement ${role}`, permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member, roleId: role });
    });
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
    const [clock] = await withTenant(database.db, contextA, tx => tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`));
    const now = new Date(clock!.now).getTime();
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
      responseDueAt: new Date(now + 86_400_000).toISOString(),
      idempotencyKey: "procurement-rfq-0001",
    });
    rfqId = rfq.id;
    const quote = await service.recordSupplierQuote(contextA, rfqId, {
      supplierId,
      currency: "USD",
      validUntil: new Date(now + 20 * 86_400_000).toISOString(),
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
    const receipt = await recordReceipt(contextA, purchaseOrderId, receiptInput);
    const receiptReplay = await recordReceipt(contextA, purchaseOrderId, receiptInput);
    expect(receiptReplay.receipt.id).toBe(receipt.receipt.id);
    expect((await recordReceipt(contextA, purchaseOrderId.toUpperCase(), { ...receiptInput, receivedAt: receiptInput.receivedAt.replace(".000Z", "Z") })).receipt.id).toBe(receipt.receipt.id);
    await expect(recordReceipt(contextA, purchaseOrderId, { ...receiptInput, externalReference: "CHANGED-ORIGINAL-REFERENCE" })).rejects.toBeInstanceOf(ConflictException);
    await expect(recordReceipt(contextA, createEntityId(), receiptInput)).rejects.toBeInstanceOf(NotFoundException);
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
    const receipt = await recordReceipt(contextA, order.id, {
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

  it("rechecks receipt membership, actor and permission-specific scope before new work or replay", async () => {
    const order = await approvedOrder();
    const input = receiptRequest(2);
    const result = await recordReceipt(contextA, order.id, input);
    const other = { ...contextA, userId: createEntityId() };
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic receipt operator')",
      [other.userId, randomUUID(), `${other.userId}@example.test`]);
    await withTenant(database.db, other, async tx => {
      const member = createEntityId(), role = createEntityId();
      await tx.insert(memberships).values({ id: member, tenantId: other.tenantId, userId: other.userId, status: "active" });
      await tx.insert(roles).values({ id: role, tenantId: other.tenantId, name: randomUUID(), permissions: other.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: other.tenantId, membershipId: member, roleId: role });
    });
    await expect(recordReceipt(other, order.id, input)).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "incoming_request_mismatch" }) });
    await expect(recordReceipt({ ...other, dataScope: "self" }, order.id, input)).rejects.toMatchObject({ status: 403 });
    await expect(recordReceipt({ ...other, dataScope: "team" }, order.id, receiptRequest(1))).rejects.toMatchObject({ status: 403 });
    await expect(recordReceipt({ ...other, permissionScopes: Object.fromEntries(other.permissions.map(permission => [permission, permission === "procurement:write" ? "self" : "tenant"])) }, order.id, input)).rejects.toMatchObject({ status: 403 });
    await expect(recordReceipt(contextB, order.id, input)).rejects.toBeInstanceOf(NotFoundException);
    const original = await receiptState();
    try {
      await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: ["procurement:read"] }).where(eq(roles.id, roleIds.get(userA)!)));
      await expect(recordReceipt(contextA, order.id, input)).rejects.toMatchObject({ status: 403 });
      await expect(recordReceipt(contextA, order.id, receiptRequest(1))).rejects.toMatchObject({ status: 403 });
    } finally {
      await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: contextA.permissions }).where(eq(roles.id, roleIds.get(userA)!)));
    }
    expect(await receiptState()).toEqual(original);
    expect((await recordReceipt(contextA, order.id, input)).receipt.id).toBe(result.receipt.id);
  });

  it("rolls back receipt, request evidence, stock and order state when the final audit fails", async () => {
    const order = await approvedOrder(), input = receiptRequest(3);
    const prepared = await prepareInspectedReceiptFixture(service, incoming, contextA, order.id, input);
    const original = await receiptState();
    const failure = vi.spyOn(audit, "recordInTransaction").mockRejectedValueOnce(new Error("Synthetic receipt audit failure"));
    try { await expect(prepared.execute()).rejects.toThrow("Synthetic receipt audit failure"); }
    finally { failure.mockRestore(); }
    expect(await receiptState()).toEqual(original);
    const result = await recordReceipt(contextA, order.id, input);
    expect(result.receipt.lines[0]!.receivedQuantity).toBe(3);
    expect(await withTenant(database.db, contextA, tx => tx.select().from(inventoryMovements).where(eq(inventoryMovements.sourceId, result.receipt.id)))).toHaveLength(1);
  });

  it("serializes two different receipt bodies under one key without posting duplicate stock", async () => {
    const order = await approvedOrder(), first = receiptRequest(4), second = { ...first, externalReference: "SYNTHETIC-DIFFERENT", lines: [{ ...first.lines[0]!, receivedQuantity: 5 }] };
    const before = await totalPhysical();
    const results = await Promise.allSettled([recordReceipt(contextA, order.id, first), recordReceipt(contextA, order.id, second)]);
    const completed = results.filter(row => row.status === "fulfilled"); expect(completed).toHaveLength(1);
    const result = completed[0]!.value;
    expect((results.find(row => row.status === "rejected") as PromiseRejectedResult).reason).toMatchObject({ status: 409 });
    const quantity = result.receipt.lines[0]!.receivedQuantity;
    expect(await totalPhysical()).toBe(addStockQuantity(before, quantity));
    const winningInput = quantity === 4 ? first : second;
    expect((await recordReceipt(contextA, order.id, winningInput)).receipt.id).toBe(result.receipt.id);
    expect(await withTenant(database.db, contextA, tx => tx.select().from(inventoryProcurementReceiptRequests).where(eq(inventoryProcurementReceiptRequests.receiptId, result.receipt.id)))).toHaveLength(1);
    const audits = await withTenant(database.db, contextA, tx => tx.select({ id: auditEvents.id }).from(auditEvents).where(and(eq(auditEvents.action, "procurement.receipt.record"), eq(auditEvents.entityId, result.receipt.id))));
    expect(audits).toHaveLength(1);
    expect(await totalPhysical()).toBe(addStockQuantity(before, quantity));
  });

  it("requires atomic immutable receipt evidence and applies tenant RLS to its private checksum", async () => {
    const order = await approvedOrder(), input = receiptRequest(1), result = await recordReceipt(contextA, order.id, input);
    const proofs = await withTenant(database.db, contextA, tx => tx.select().from(inventoryProcurementReceiptRequests).where(eq(inventoryProcurementReceiptRequests.receiptId, result.receipt.id)));
    expect(proofs).toHaveLength(1); expect(proofs[0]!.requestChecksum).toMatch(/^[a-f0-9]{64}$/);
    expect(await withTenant(database.db, contextB, tx => tx.select().from(inventoryProcurementReceiptRequests))).toEqual([]);
    await expect(withTenant(database.db, contextA, tx => tx.update(inventoryProcurementReceiptRequests).set({ requestChecksum: "b".repeat(64) }))).rejects.toThrow();
    await expect(withTenant(database.db, contextA, tx => tx.delete(inventoryProcurementReceiptRequests))).rejects.toThrow();
    const headerId = createEntityId(), key = randomUUID();
    await expect(withTenant(database.db, contextA, async tx => {
      await tx.insert(inventoryProcurementReceipts).values({ id: headerId, tenantId: tenantA, purchaseOrderId: order.id, purchaseOrderVersionId: proofs[0]!.purchaseOrderVersionId,
        receivedAt: new Date(input.receivedAt), externalReference: null, hasVariance: false, idempotencyKey: key, createdBy: userA });
    })).rejects.toThrow();
    expect(await withTenant(database.db, contextA, tx => tx.select().from(inventoryProcurementReceipts).where(eq(inventoryProcurementReceipts.id, headerId)))).toEqual([]);
  });

  it("refuses an expired quotation as the source of a new purchase order", async () => {
    const source = await sourcingScenario(-60_000);
    const before = await procurementCycleState();
    await expect(service.createPurchaseOrder(contextA, source.orderInput)).rejects.toBeInstanceOf(ConflictException);
    expect(await procurementCycleState()).toEqual(before);
  });

  it("binds a quoted purchase to its actual RFQ requisition", async () => {
    const source = await sourcingScenario();
    const other = await sourcingScenario();
    const before = await procurementCycleState();
    await expect(service.createPurchaseOrder(contextA, { ...source.orderInput, requisitionId: other.requisition.id }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(await procurementCycleState()).toEqual(before);
  });

  it("requires quoted prices, MOQ and request dimensions instead of treating a quote ID as approval", async () => {
    for (const mutation of ["price", "moq", "dimension"] as const) {
      const source = await sourcingScenario();
      const lines = source.orderInput.lines.map(line => ({ ...line }));
      if (mutation === "price") lines[0]!.unitCostMinor += 1;
      if (mutation === "moq") lines[0]!.quantity = 4;
      if (mutation === "dimension") lines[0]!.lineKey = "ANOTHER-LINE";
      const before = await procurementCycleState();
      await expect(service.createPurchaseOrder(contextA, { ...source.orderInput, lines })).rejects.toBeInstanceOf(ConflictException);
      expect(await procurementCycleState()).toEqual(before);
    }
  });

  it("serializes independent quote submissions for the same RFQ and supplier", async () => {
    const source = await sourcingScenario();
    const results = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => service.recordSupplierQuote(contextA, source.rfq.id, {
      ...source.quoteInput, lines: [{ ...source.quoteInput.lines[0]!, unitCostMinor: 430 + index }], idempotencyKey: randomUUID(),
    })));
    expect(results.every(result => result.status === "fulfilled")).toBe(true);
    const versions = results.flatMap(result => result.status === "fulfilled" ? [result.value.version] : []).sort((a, b) => a - b);
    expect(versions).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it("rejects a requisition key reused with changed original quantities", async () => {
    const source = await sourcingScenario();
    const before = await procurementCycleState();
    await expect(service.createRequisition(contextA, { ...source.requisitionInput, lines: [requestLine(11)] }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(await procurementCycleState()).toEqual(before);
  });

  it("rejects an RFQ key reused against another requisition", async () => {
    const source = await sourcingScenario();
    const other = await sourcingScenario();
    const before = await procurementCycleState();
    await expect(service.createRfq(contextA, other.requisition.id, source.rfqInput)).rejects.toBeInstanceOf(ConflictException);
    expect(await procurementCycleState()).toEqual(before);
  });

  it("rejects a quote key reused with different prices", async () => {
    const source = await sourcingScenario();
    const before = await procurementCycleState();
    await expect(service.recordSupplierQuote(contextA, source.rfq.id, {
      ...source.quoteInput, lines: [{ ...source.quoteInput.lines[0]!, unitCostMinor: 999 }],
    })).rejects.toBeInstanceOf(ConflictException);
    expect(await procurementCycleState()).toEqual(before);
  });

  it("rejects a purchase key reused with changed original source or contents", async () => {
    const source = await sourcingScenario();
    await service.createPurchaseOrder(contextA, source.orderInput);
    const before = await procurementCycleState();
    await expect(service.createPurchaseOrder(contextA, { ...source.orderInput, code: `PO-${randomUUID()}`.toUpperCase() }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(await procurementCycleState()).toEqual(before);
  });

  it("rolls back a requisition when its success audit fails", async () => {
    const key = randomUUID();
    const before = await procurementCycleState();
    const outside = vi.spyOn(audit, "record").mockRejectedValueOnce(new Error("synthetic procurement audit failure"));
    const inside = vi.spyOn(audit, "recordInTransaction").mockRejectedValueOnce(new Error("synthetic procurement audit failure"));
    try {
      await expect(service.createRequisition(contextA, { code: `REQ-${key}`.toUpperCase(), reasonCode: "SYNTHETIC", lines: [requestLine(10)], idempotencyKey: key }))
        .rejects.toThrow("synthetic procurement audit failure");
    } finally { outside.mockRestore(); inside.mockRestore(); }
    expect(await procurementCycleState()).toEqual(before);
  });

  it("rechecks actual membership before a quote write or replay", async () => {
    const source = await sourcingScenario();
    const before = await procurementCycleState();
    await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: ["procurement:read", "inventory:read"] }).where(eq(roles.id, roleIds.get(userA)!)));
    try {
      await expect(service.recordSupplierQuote(contextA, source.rfq.id, source.quoteInput)).rejects.toMatchObject({ status: 403 });
      await expect(service.recordSupplierQuote(contextA, source.rfq.id, { ...source.quoteInput, idempotencyKey: randomUUID() }))
        .rejects.toMatchObject({ status: 403 });
    } finally {
      await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: contextA.permissions }).where(eq(roles.id, roleIds.get(userA)!)));
    }
    expect(await procurementCycleState()).toEqual(before);
  });

  it("keeps revision and review originals distinct across bodies and purchase objects", async () => {
    const order = await manualDraft();
    const revision = { expectedVersion: 1, currency: "USD", expectedAt: order.expectedAt, lines: [purchaseLine(11, 425)], idempotencyKey: randomUUID() };
    await service.revisePurchaseOrder(contextA, order.id, revision);
    const original = await procurementCycleState();
    expect((await service.revisePurchaseOrder(contextA, order.id, revision)).currentVersion).toBe(2);
    await expect(service.revisePurchaseOrder(contextA, order.id, { ...revision, lines: [purchaseLine(12, 425)] })).rejects.toMatchObject({ status: 409 });
    expect(await procurementCycleState()).toEqual(original);
    const other = await manualDraft();
    const withOther = await procurementCycleState();
    await expect(service.revisePurchaseOrder(contextA, other.id, revision)).rejects.toMatchObject({ status: 409 });
    expect(await procurementCycleState()).toEqual(withOther);
    const review = { expectedVersion: 2, decision: "rejected" as const, reasonCode: "SYNTHETIC_REVIEW", idempotencyKey: randomUUID() };
    await service.reviewPurchaseOrder(contextA, order.id, review);
    const afterReview = await procurementCycleState();
    expect((await service.reviewPurchaseOrder(contextA, order.id, review)).id).toBe(order.id);
    await expect(service.reviewPurchaseOrder(contextA, order.id, { ...review, decision: "approved" })).rejects.toMatchObject({ status: 409 });
    await expect(service.reviewPurchaseOrder(contextA, other.id, { ...review, expectedVersion: 1 })).rejects.toMatchObject({ status: 409 });
    expect(await procurementCycleState()).toEqual(afterReview);
  });

  it("normalizes UUID and ISO representation when replaying the same semantic RFQ and quote", async () => {
    const source = await sourcingScenario();
    const before = await procurementCycleState();
    expect((await service.createRfq(contextA, source.requisition.id.toUpperCase(), { ...source.rfqInput,
      supplierIds: source.rfqInput.supplierIds.map(id => id.toUpperCase()), responseDueAt: source.rfqInput.responseDueAt.replace("Z", "0Z") })).id).toBe(source.rfq.id);
    expect((await service.recordSupplierQuote(contextA, source.rfq.id.toUpperCase(), { ...source.quoteInput,
      supplierId: supplierId.toUpperCase(), validUntil: source.quoteInput.validUntil.replace("Z", "0Z") })).id).toBe(source.quote.id);
    expect(await procurementCycleState()).toEqual(before);
  });

  it("uses database time for quote validity even when the API clock is skewed", async () => {
    const valid = await sourcingScenario();
    const expired = await sourcingScenario(-60_000);
    const [clock] = await withTenant(database.db, contextA, tx => tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`));
    const skew = vi.spyOn(Date, "now");
    try {
      skew.mockReturnValue(new Date(clock!.now).getTime() + 600_000);
      expect((await service.createPurchaseOrder(contextA, valid.orderInput)).quoteId).toBe(valid.quote.id);
      skew.mockReturnValue(new Date(clock!.now).getTime() - 600_000);
      await expect(service.createPurchaseOrder(contextA, expired.orderInput)).rejects.toMatchObject({ status: 409 });
    } finally { skew.mockRestore(); }
  });

  it("rechecks the selected quote at approval without rewriting its fixed historical source", async () => {
    const source = await sourcingScenario();
    const order = await service.createPurchaseOrder(contextA, source.orderInput);
    await service.recordSupplierQuote(contextA, source.rfq.id, { ...source.quoteInput, idempotencyKey: randomUUID(),
      lines: [{ ...source.quoteInput.lines[0]!, unitCostMinor: 450 }] });
    const before = await procurementCycleState();
    await expect(service.reviewPurchaseOrder(contextA, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() }))
      .rejects.toMatchObject({ status: 409 });
    expect(await procurementCycleState()).toEqual(before);
    expect((await service.createPurchaseOrder(contextA, source.orderInput)).id).toBe(order.id);
    const rejected = await service.reviewPurchaseOrder(contextA, order.id, { expectedVersion: 1, decision: "rejected", reasonCode: "SOURCE_CHANGED", idempotencyKey: randomUUID() });
    expect(rejected.quoteId).toBe(source.quote.id);
  });

  it("rolls back every front-cycle fact and proof when its final audit fails", async () => {
    const source = await sourcingScenario();
    const draft = await manualDraft();
    const cases = [
      () => service.createRequisition(contextA, { ...source.requisitionInput, code: `REQ-${randomUUID()}`.toUpperCase(), idempotencyKey: randomUUID() }),
      () => service.createRfq(contextA, source.requisition.id, { ...source.rfqInput, idempotencyKey: randomUUID() }),
      () => service.recordSupplierQuote(contextA, source.rfq.id, { ...source.quoteInput, idempotencyKey: randomUUID() }),
      () => service.createPurchaseOrder(contextA, source.orderInput),
      () => service.revisePurchaseOrder(contextA, draft.id, { expectedVersion: 1, currency: "USD", expectedAt: draft.expectedAt, lines: [purchaseLine(12, 425)], idempotencyKey: randomUUID() }),
      () => service.reviewPurchaseOrder(contextA, draft.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() }),
    ];
    for (const execute of cases) {
      const before = await procurementCycleState();
      const outside = vi.spyOn(audit, "record").mockRejectedValueOnce(new Error("synthetic cycle audit failure"));
      const inside = vi.spyOn(audit, "recordInTransaction").mockRejectedValueOnce(new Error("synthetic cycle audit failure"));
      try { await expect(execute()).rejects.toThrow("synthetic cycle audit failure"); }
      finally { outside.mockRestore(); inside.mockRestore(); }
      expect(await procurementCycleState()).toEqual(before);
    }
  });

  it("makes request evidence immutable, tenant private and inseparable from actual business facts", async () => {
    const source = await sourcingScenario();
    const order = await service.createPurchaseOrder(contextA, source.orderInput);
    const before = await procurementCycleState();
    expect(await withTenant(database.db, contextB, tx => tx.select().from(inventoryProcurementWriteRequests)
      .where(eq(inventoryProcurementWriteRequests.purchaseOrderId, order.id)))).toEqual([]);
    await expect(withTenant(database.db, contextA, tx => tx.update(inventoryProcurementWriteRequests).set({ requestChecksum: "0".repeat(64) }))).rejects.toThrow();
    await expect(withTenant(database.db, contextA, tx => tx.delete(inventoryProcurementWriteRequests))).rejects.toThrow();
    await expect(withTenant(database.db, contextA, tx => tx.update(inventoryPurchaseOrders).set({ status: "approved" }).where(eq(inventoryPurchaseOrders.id, order.id))))
      .rejects.toThrow();
    await expect(withTenant(database.db, contextA, async tx => {
      const id = createEntityId();
      await tx.insert(inventoryProcurementRequisitions).values({ id, tenantId: tenantA, code: `REQ-${randomUUID()}`.toUpperCase(), idempotencyKey: randomUUID(), createdBy: userA });
      await tx.insert(inventoryProcurementRequisitionVersions).values({ id: createEntityId(), tenantId: tenantA, requisitionId: id,
        versionNumber: 1, reasonCode: "SYNTHETIC_ORPHAN", lineSnapshot: [requestLine(10)], checksum: "0".repeat(64), createdBy: userA });
    })).rejects.toThrow();
    await expect(withTenant(database.db, contextA, tx => tx.insert(inventoryProcurementWriteRequests).values({ id: createEntityId(), tenantId: tenantA,
      operation: "requisition_create", targetId: null, createdBy: userA, idempotencyKey: source.requisitionInput.idempotencyKey,
      requestChecksum: "0".repeat(64), requisitionId: source.requisition.id }))).rejects.toThrow();
    expect(await procurementCycleState()).toEqual(before);
    const workspace = JSON.stringify(await service.workspace(contextA));
    expect(workspace).not.toContain(source.requisitionInput.idempotencyKey);
    expect(workspace).not.toContain("requestChecksum");
  });

  it("rechecks the actual write and approval grants for all six new operations and replays", async () => {
    const source = await sourcingScenario();
    const order = await service.createPurchaseOrder(contextA, source.orderInput);
    const revision = { expectedVersion: 1, currency: "USD", expectedAt: order.expectedAt, lines: [purchaseLine(11, 425)], idempotencyKey: randomUUID() };
    await service.revisePurchaseOrder(contextA, order.id, revision);
    const review = { expectedVersion: 2, decision: "rejected" as const, reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() };
    await service.reviewPurchaseOrder(contextA, order.id, review);
    const replays = [
      () => service.createRequisition(contextA, source.requisitionInput),
      () => service.createRfq(contextA, source.requisition.id, source.rfqInput),
      () => service.recordSupplierQuote(contextA, source.rfq.id, source.quoteInput),
      () => service.createPurchaseOrder(contextA, source.orderInput),
      () => service.revisePurchaseOrder(contextA, order.id, revision),
      () => service.reviewPurchaseOrder(contextA, order.id, review),
    ];
    const fresh = [
      () => service.createRequisition(contextA, { ...source.requisitionInput, code: `REQ-${randomUUID()}`.toUpperCase(), idempotencyKey: randomUUID() }),
      () => service.createRfq(contextA, source.requisition.id, { ...source.rfqInput, idempotencyKey: randomUUID() }),
      () => service.recordSupplierQuote(contextA, source.rfq.id, { ...source.quoteInput, idempotencyKey: randomUUID() }),
      () => service.createPurchaseOrder(contextA, { ...source.orderInput, code: `PO-${randomUUID()}`.toUpperCase(), idempotencyKey: randomUUID() }),
      () => service.revisePurchaseOrder(contextA, order.id, { ...revision, expectedVersion: 2, idempotencyKey: randomUUID() }),
      () => service.reviewPurchaseOrder(contextA, order.id, { ...review, decision: "approved", idempotencyKey: randomUUID() }),
    ];
    const before = await procurementCycleState();
    await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: ["procurement:read", "inventory:read"] }).where(eq(roles.id, roleIds.get(userA)!)));
    try { for (const execute of [...replays, ...fresh]) await expect(execute()).rejects.toMatchObject({ status: 403 }); }
    finally { await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: contextA.permissions }).where(eq(roles.id, roleIds.get(userA)!))); }
    expect(await procurementCycleState()).toEqual(before);
  });

  it("does not let broader read or approval permissions widen a self-scoped procurement write", async () => {
    const other = await secondOperator();
    const source = await sourcingScenario(86_400_000, other);
    const order = await service.createPurchaseOrder(other, source.orderInput);
    const ownSource = await sourcingScenario();
    const selfWrite: TenantContext = { ...contextA, permissionScopes: Object.fromEntries(contextA.permissions.map(permission => [permission, permission === "procurement:write" ? "self" as const : "tenant" as const])) };
    const selfApprove: TenantContext = { ...contextA, permissionScopes: Object.fromEntries(contextA.permissions.map(permission => [permission, permission === "procurement:approve" ? "self" as const : "tenant" as const])) };
    const before = await procurementCycleState();
    await expect(service.createRfq(selfWrite, source.requisition.id, { ...source.rfqInput, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(service.recordSupplierQuote(selfWrite, source.rfq.id, { ...source.quoteInput, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(service.createPurchaseOrder(selfWrite, { ...source.orderInput, code: `PO-${randomUUID()}`.toUpperCase(), idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(service.revisePurchaseOrder(selfWrite, order.id, { expectedVersion: 1, currency: "USD", expectedAt: order.expectedAt, lines: [purchaseLine(11, 425)], idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(service.reviewPurchaseOrder(selfApprove, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 403 });
    await expect(service.createRequisition(other, ownSource.requisitionInput)).rejects.toMatchObject({ status: 409 });
    await expect(service.createPurchaseOrder(contextA, source.orderInput)).rejects.toMatchObject({ status: 409 });
    expect(await procurementCycleState()).toEqual(before);
  });

  it("refuses a newly approved purchase after the quote expires in real database time", async () => {
    const source = await sourcingScenario(5_000);
    const order = await service.createPurchaseOrder(contextA, source.orderInput);
    await withTenant(database.db, contextA, tx => tx.execute(sql`select pg_sleep(5.01)`));
    const before = await procurementCycleState();
    await expect(service.reviewPurchaseOrder(contextA, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect(await procurementCycleState()).toEqual(before);
    expect((await service.createPurchaseOrder(contextA, source.orderInput)).id).toBe(order.id);
  });

  it("normalizes source IDs before a new RFQ, quote and purchase rather than only during replay", async () => {
    const source = await sourcingScenario();
    const rfq = await service.createRfq(contextA, source.requisition.id.toUpperCase(), { ...source.rfqInput,
      supplierIds: [supplierId.toUpperCase()], idempotencyKey: randomUUID() });
    const quote = await service.recordSupplierQuote(contextA, rfq.id.toUpperCase(), { ...source.quoteInput, supplierId: supplierId.toUpperCase(), idempotencyKey: randomUUID() });
    const order = await service.createPurchaseOrder(contextA, { ...source.orderInput, quoteId: quote.id.toUpperCase(), supplierId: supplierId.toUpperCase(),
      requisitionId: source.requisition.id.toUpperCase(), lines: source.orderInput.lines.map(line => ({ ...line, stockItemId: line.stockItemId.toUpperCase(), destinationLocationId: line.destinationLocationId.toUpperCase() })), idempotencyKey: randomUUID() });
    expect(order.quoteId).toBe(quote.id);
    expect(order.lines[0]!.stockItemId).toBe(stockItemId);
  });

  it("filters each workspace domain by its own current read permission and denies a revoked membership", async () => {
    const other = await secondOperator();
    const source = await sourcingScenario(86_400_000, other);
    const order = await service.createPurchaseOrder(other, source.orderInput);
    await service.reviewPurchaseOrder(other, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC", idempotencyKey: randomUUID() });
    const invoice = await service.recordInvoice(other, order.id, { invoiceNumber: `SYNTHETIC-${randomUUID()}`, currency: "USD", issuedAt: new Date().toISOString(),
      lines: [{ lineKey: "LINE-1", invoicedQuantity: 1, unitCostMinor: 425 }], idempotencyKey: randomUUID() });
    const foreignStock = await inventory.createStockItem(other, { skuId: null, code: `OTHER-${randomUUID()}`.toUpperCase(), name: "Synthetic colleague stock", baseUnit: "each" });
    const readSelf: TenantContext = { ...contextA, permissionScopes: Object.fromEntries(contextA.permissions.map(p => [p, p === "procurement:read" ? "self" as const : "tenant" as const])) };
    const workspace = await service.workspace(readSelf);
    expect(workspace.requisitions.map(row => row.id)).not.toContain(source.requisition.id);
    expect(workspace.rfqs.map(row => row.id)).not.toContain(source.rfq.id);
    expect(workspace.quotes.map(row => row.id)).not.toContain(source.quote.id);
    expect(workspace.purchaseOrders.map(row => row.id)).not.toContain(order.id);
    expect(workspace.invoices.map(row => row.id)).not.toContain(invoice.id);
    const inventorySelf: TenantContext = { ...contextA, permissionScopes: Object.fromEntries(contextA.permissions.map(p => [p, p === "inventory:read" ? "self" as const : "tenant" as const])) };
    const visible = await service.workspace(inventorySelf);
    expect(visible.purchaseOrders.map(row => row.id)).toContain(order.id);
    expect(visible.stockItems.map(row => row.id)).not.toContain(foreignStock.id);
    const before = await procurementCycleState();
    await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: ["procurement:write", "inventory:read"] }).where(eq(roles.id, roleIds.get(userA)!)));
    try { await expect(service.workspace(contextA)).rejects.toMatchObject({ status: 403 }); }
    finally { await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: contextA.permissions }).where(eq(roles.id, roleIds.get(userA)!))); }
    expect(await procurementCycleState()).toEqual(before);
  });

  it("rechecks current analysis membership and independently enforces inventory read ownership", async () => {
    const other = await secondOperator();
    const stock = await inventory.createStockItem(other, { skuId: null, code: `ANALYSIS-${randomUUID()}`.toUpperCase(), name: "Synthetic analysis colleague stock", baseUnit: "each" });
    const inventorySelf: TenantContext = { ...contextA, permissionScopes: Object.fromEntries(contextA.permissions.map(p => [p, p === "inventory:read" ? "self" as const : "tenant" as const])) };
    await expect(service.analysisBasis(inventorySelf, stock.id, locationId)).rejects.toMatchObject({ status: 403 });
    const before = await procurementCycleState();
    await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: ["inventory:read"] }).where(eq(roles.id, roleIds.get(userA)!)));
    try { await expect(service.analysisBasis(contextA, stockItemId, locationId)).rejects.toMatchObject({ status: 403 }); }
    finally { await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: contextA.permissions }).where(eq(roles.id, roleIds.get(userA)!))); }
    expect(await procurementCycleState()).toEqual(before);
  });

  it("filters analysis policy, purchase and quote evidence by current procurement read scope and normalizes IDs", async () => {
    const other = await secondOperator();
    const stock = await inventory.createStockItem(contextA, { skuId: null, code: `BASIS-${randomUUID()}`.toUpperCase(), name: "Synthetic analysis own stock", baseUnit: "each" });
    const line = { ...requestLine(10), stockItemId: stock.id };
    const [clock] = await withTenant(database.db, contextA, tx => tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`));
    const now = new Date(clock!.now).getTime();
    const requisition = await service.createRequisition(other, { code: `REQ-${randomUUID()}`.toUpperCase(), reasonCode: "SYNTHETIC", lines: [line], idempotencyKey: randomUUID() });
    const rfq = await service.createRfq(other, requisition.id, { expectedRequisitionVersion: 1, supplierIds: [supplierId], responseDueAt: new Date(now + 86_400_000).toISOString(), idempotencyKey: randomUUID() });
    const quote = await service.recordSupplierQuote(other, rfq.id, { supplierId, currency: "USD", validUntil: new Date(now + 2 * 86_400_000).toISOString(), lines: [{ lineKey: "LINE-1", unitCostMinor: 425, minimumOrderQuantity: 5, leadTimeDays: 7 }], idempotencyKey: randomUUID() });
    const order = await service.createPurchaseOrder(other, { code: `PO-${randomUUID()}`.toUpperCase(), supplierId, requisitionId: requisition.id, quoteId: quote.id, currency: "USD", expectedAt: new Date(now + 86_400_000).toISOString(), lines: [{ ...line, unitCostMinor: 425 }], idempotencyKey: randomUUID() });
    await service.upsertReplenishmentPolicy(other, { stockItemId: stock.id, locationId, reorderPoint: 5, safetyStock: 2, minimumOrderQuantity: 10, leadTimeDays: 7, serviceLevelBps: 9500, reviewIntervalDays: 7, idempotencyKey: randomUUID() });
    const readSelf: TenantContext = { ...contextA, permissionScopes: Object.fromEntries(contextA.permissions.map(p => [p, p === "procurement:read" ? "self" as const : "tenant" as const])) };
    const own = await service.analysisBasis(readSelf, stock.id, locationId);
    expect(own.policy).toBeNull();
    expect(own.purchases.map(row => row.id)).not.toContain(order.id);
    expect(own.quotes.map(row => row.id)).not.toContain(quote.id);
    const full = await service.analysisBasis(contextA, stock.id.toUpperCase(), locationId.toUpperCase());
    expect(full.purchases.map(row => row.id)).toContain(order.id);
    expect(full.quotes.map(row => row.id)).toContain(quote.id);
  });

  it("does not promote an older readable quote when the actual latest quote is outside the analysis read scope", async () => {
    const source = await sourcingScenario(86_400_000), other = await secondOperator();
    const newest = await service.recordSupplierQuote(other, source.rfq.id, { ...source.quoteInput, idempotencyKey: randomUUID() });
    const readSelf: TenantContext = { ...contextA, permissionScopes: Object.fromEntries(contextA.permissions.map(p => [p, p === "procurement:read" ? "self" as const : "tenant" as const])) };
    const own = await service.analysisBasis(readSelf, stockItemId, locationId);
    expect(own.quotes.map(row => row.id)).not.toContain(source.quote.id);
    expect(own.quotes.map(row => row.id)).not.toContain(newest.id);
    expect((await service.analysisBasis(contextA, stockItemId, locationId)).quotes.map(row => row.id)).toContain(newest.id);
  });

  it("applies analysis ownership before the 100 purchase limit", async () => {
    const other = await secondOperator();
    const stock = await inventory.createStockItem(contextA, { skuId: null, code: `LIMIT-${randomUUID()}`.toUpperCase(), name: "Synthetic analysis limit stock", baseUnit: "each" });
    const input = { supplierId, requisitionId: null, quoteId: null, currency: "USD", expectedAt: new Date().toISOString(), lines: [{ ...purchaseLine(1, 100), stockItemId: stock.id }] };
    for (let i = 0; i < 101; i++) await service.createPurchaseOrder(other, { ...input, code: `LIMIT-${i}-${randomUUID()}`.toUpperCase(), idempotencyKey: randomUUID() });
    const own = await service.createPurchaseOrder(contextA, { ...input, code: `OWN-${randomUUID()}`.toUpperCase(), idempotencyKey: randomUUID() });
    const readSelf: TenantContext = { ...contextA, permissionScopes: Object.fromEntries(contextA.permissions.map(p => [p, p === "procurement:read" ? "self" as const : "tenant" as const])) };
    expect((await service.analysisBasis(readSelf, stock.id, locationId)).purchases.map(row => row.id)).toEqual([own.id]);
  });

  async function secondOperator() {
    const userId = createEntityId();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic procurement colleague')", [userId, randomUUID(), `${userId}@example.test`]);
    const context = tenantContext(tenantA, userId);
    await withTenant(database.db, context, async tx => {
      const member = createEntityId(), role = createEntityId();
      await tx.insert(memberships).values({ id: member, tenantId: tenantA, userId, status: "active" });
      await tx.insert(roles).values({ id: role, tenantId: tenantA, name: randomUUID(), permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: tenantA, membershipId: member, roleId: role });
    });
    return context;
  }

  async function manualDraft() {
    const source = await sourcingScenario();
    return service.createPurchaseOrder(contextA, { ...source.orderInput, requisitionId: null, quoteId: null });
  }

  async function sourcingScenario(validForMs = 86_400_000, operator = contextA) {
    const key = randomUUID();
    const [clock] = await withTenant(database.db, operator, tx => tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`));
    const now = new Date(clock!.now).getTime();
    const requisitionInput = { code: `REQ-${key}`.toUpperCase(), reasonCode: "SYNTHETIC", lines: [requestLine(10)], idempotencyKey: `req-${key}` };
    const requisition = await service.createRequisition(operator, requisitionInput);
    const rfqInput = { expectedRequisitionVersion: 1, supplierIds: [supplierId], responseDueAt: new Date(now + 86_400_000).toISOString(), idempotencyKey: `rfq-${key}` };
    const rfq = await service.createRfq(operator, requisition.id, rfqInput);
    const quoteInput = { supplierId, currency: "USD", validUntil: new Date(now + validForMs).toISOString(),
      lines: [{ lineKey: "LINE-1", unitCostMinor: 425, minimumOrderQuantity: 5, leadTimeDays: 7 }], idempotencyKey: `quote-${key}` };
    const quote = await service.recordSupplierQuote(operator, rfq.id, quoteInput);
    const orderInput = { code: `PO-${key}`.toUpperCase(), supplierId, requisitionId: requisition.id, quoteId: quote.id, currency: "USD",
      expectedAt: new Date(now + 8 * 86_400_000).toISOString(), lines: [purchaseLine(10, 425)], idempotencyKey: `po-${key}` };
    return { requisition, rfq, quote, requisitionInput, rfqInput, quoteInput, orderInput };
  }

  async function procurementCycleState() {
    return withTenant(database.db, contextA, async tx => {
      await tx.execute(sql`set local time zone 'UTC'`);
      const result: Record<string, unknown> = {};
      for (const table of ["inventory_procurement_requisitions", "inventory_procurement_requisition_versions", "inventory_procurement_rfqs", "inventory_supplier_quote_versions", "inventory_purchase_orders", "inventory_purchase_order_versions", "inventory_purchase_order_events", "inventory_procurement_write_requests", "audit_events"])
        result[table] = [...await tx.execute(sql`select md5(to_jsonb(t)::text) as hash from ${sql.identifier(table)} t order by hash`)];
      return result;
    });
  }

  async function approvedOrder() {
    const key = randomUUID();
    const order = await service.createPurchaseOrder(contextA, { code: `IPO-${key}`.toUpperCase(), supplierId, requisitionId: null, quoteId: null, currency: "USD",
      expectedAt: "2026-08-21T00:00:00Z", lines: [purchaseLine(12, 100)], idempotencyKey: `create-${key}` });
    await service.reviewPurchaseOrder(contextA, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC_APPROVED", idempotencyKey: `review-${key}` });
    return order;
  }

  function receiptRequest(quantity: number) {
    return { expectedVersion: 1, receivedAt: "2026-08-21T12:00:00.000Z", externalReference: null as string | null,
      lines: [{ lineKey: "LINE-1", receivedQuantity: quantity, rejectedQuantity: 0, rejectionReasonCode: null, lotCode: `LOT-${randomUUID()}`.toUpperCase(), expiresAt: null }], idempotencyKey: randomUUID() };
  }

  async function receiptState() {
    return withTenant(database.db, contextA, async tx => {
      await tx.execute(sql`set local time zone 'UTC'`);
      const result: Record<string, unknown> = {};
      for (const table of ["inventory_procurement_receipts", "inventory_procurement_receipt_lines", "inventory_procurement_receipt_requests", "inventory_lots", "inventory_movements", "inventory_balances", "inventory_purchase_orders", "inventory_purchase_order_events", "audit_events"])
        result[table] = [...await tx.execute(sql`select id::text,md5(to_jsonb(t)::text) as hash from ${sql.identifier(table)} t order by id`)];
      return result;
    });
  }

  async function totalPhysical() {
    const [row] = await withTenant(database.db, contextA, tx => tx.execute<{ quantity: string }>(sql`select coalesce(sum(physical_quantity),0)::text as quantity from inventory_balances where stock_item_id=${stockItemId}::uuid and location_id=${locationId}::uuid`));
    return Number(row!.quantity);
  }

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
