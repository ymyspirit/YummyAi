import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { sumStockQuantities } from "@yummyai/contracts/inventory/quantity";
import { SecretVault } from "@yummyai/ai-core";
import type { PrepareIncomingCommand } from "@yummyai/contracts/procurement/incoming-command";
import { IncomingCriterionSchema, IncomingReadingSchema, evaluateIncomingReadings } from "@yummyai/contracts/procurement/incoming";
import { connectDatabase, migrateDatabase, withTenant, memberships, roles, membershipRoles,
  inventoryBalances, inventoryProcurementReceipts, inventoryProcurementReceiptLines,
  procurementArrivals, procurementArrivalLines, incomingInspections, incomingInspectionReviews, incomingPostings,
  incomingCommands, expireIncomingCommandInputs } from "@yummyai/database";
import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { ProcurementService } from "./procurement.service.js";
import { IncomingInspectionService } from "./incoming-inspection.service.js";
import { IncomingCommandService } from "./incoming-command.service.js";

describe.sequential("incoming custody, actual inspection and atomic posting", () => {
  const database = connectDatabase(), tenantId = createEntityId(), otherTenant = createEntityId(),
    userId = createEntityId(), otherUser = createEntityId(), isolatedUser = createEntityId(), supplierId = createEntityId();
  const permissions = ["procurement:read", "procurement:write", "procurement:approve", "inventory:read", "inventory:write"];
  const context: TenantContext = { tenantId, userId, permissions, dataScope: "tenant" };
  const coworker: TenantContext = { ...context, userId: otherUser };
  const outsider: TenantContext = { ...context, tenantId: otherTenant, userId: isolatedUser };
  const audit = new AuditService(database), inventory = new InventoryService(database, audit),
    procurement = new ProcurementService(database, inventory, audit), service = new IncomingInspectionService(database, procurement, audit);
  const roleIds = new Map<string, string>();
  const commandKey = randomBytes(32), commandVault = new SecretVault(commandKey);
  const commands = new IncomingCommandService(database, commandVault, service, audit);
  let locationId: string;
  const occurred = "2026-10-19T01:00:00.000Z", measured = "2026-10-19T01:01:00.000Z",
    posted = "2026-10-19T01:02:00.000Z", returned = "2026-10-19T01:03:00.000Z";
  const key = () => `synthetic-incoming-${randomUUID()}`;

  beforeAll(async () => {
    await migrateDatabase(database);
    for (const [tenant, user] of [[tenantId, userId], [tenantId, otherUser], [otherTenant, isolatedUser]]) {
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic incoming fixture',$2) on conflict do nothing", [tenant!, `incoming-${tenant}`]);
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic incoming operator')", [user!, `incoming-${user}`, `incoming-${user}@example.test`]);
    }
    await database.client.unsafe("insert into fulfillment_suppliers(id,tenant_id,name,kind,status,region_code,settlement_currency,priority,created_by) values($1,$2,'Synthetic incoming supplier','manual','active','US','USD',1,$3)", [supplierId, tenantId, userId]);
    for (const c of [context, coworker, outsider]) await withTenant(database.db, c, async tx => {
      const membership = createEntityId(), role = createEntityId(); roleIds.set(c.userId, role);
      await tx.insert(memberships).values({ id: membership, tenantId: c.tenantId, userId: c.userId, status: "active" });
      await tx.insert(roles).values({ id: role, tenantId: c.tenantId, name: `Synthetic incoming ${role}`, permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: c.tenantId, membershipId: membership, roleId: role });
    });
    const warehouse = await inventory.createWarehouse(context, { code: "INCOMING", name: "Synthetic custody warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
    locationId = (await inventory.createLocation(context, { warehouseId: warehouse.id, code: "HOLD", name: "Synthetic hold location" })).id;
  });
  afterAll(async () => { await database.client.end(); });

  async function basis(quantity: number | string = "0.123456789", accepted: number | string = "0.1", rejected: number | string = "0.02", externalReference = "Synthetic delivery document") {
    const suffix = randomUUID().slice(0, 8).toUpperCase();
    const stock = await inventory.createStockItem(context, { skuId: null, code: `FABRIC-${suffix}`, name: "Synthetic measured fabric", baseUnit: "meter" });
    const order = await procurement.createPurchaseOrder(context, { code: `PO-${suffix}`, supplierId, requisitionId: null, quoteId: null,
      currency: "USD", expectedAt: "2026-10-21T00:00:00Z", lines: [{ lineKey: "LINE-1", stockItemId: stock.id,
        destinationLocationId: locationId, quantity: 1, unit: "meter", unitCostMinor: 100 }], idempotencyKey: key() });
    await procurement.reviewPurchaseOrder(context, order.id, { expectedVersion: 1, decision: "approved", reasonCode: "SYNTHETIC_APPROVAL", idempotencyKey: key() });
    const standard = await service.publishStandard(context, { code: "FABRIC", stockItemId: stock.id, expectedVersion: 0,
      title: "Synthetic measured width", sourceReference: "Isolated synthetic test standard, no real supplier acceptance",
      criteria: [{ code: "WIDTH", label: "宽度", kind: "numeric_range", unit: "mm", minimum: "9.999999999", maximum: "10.000000001" }], idempotencyKey: key() });
    const arrival = await service.recordArrival(context, order.id, { code: `ARR-${suffix}`, expectedPurchaseOrderVersion: 1,
      arrivedAt: occurred, externalReference, lines: [{ lineKey: "LINE-1", quantity, unit: "meter",
        holdingLocationId: locationId, lotCode: `SUPPLIER-${suffix}`, expiresAt: null }], idempotencyKey: key() });
    const line = arrival.lines[0]!;
    const input = { expectedInspectionVersion: 0, standardVersionId: standard.id, acceptedQuantity: accepted, rejectedQuantity: rejected,
      sampleQuantity: "0.001", rejectionReason: rejected === 0 ? null : "Synthetic damaged remainder", measuredAt: measured,
      readings: [{ criterionCode: "WIDTH", value: "10", unit: "mm" }], notes: null, idempotencyKey: key() };
    return { stock, order, standard, arrival, line, input };
  }
  async function approved(externalReference?: string) {
    const b = await basis(undefined, undefined, undefined, externalReference);
    const inspected = await service.recordInspection(context, b.line.id, b.input), inspection = inspected.inspections[0]!;
    const reviewed = await service.reviewInspection(context, b.line.id, { expectedInspectionVersion: 1, inspectionId: inspection.id,
      decision: "approved", reason: "Synthetic actual measurements reviewed", idempotencyKey: key() });
    return { ...b, review: reviewed.inspections[0]!.review! };
  }
  function posting(approvalId: string, acceptedQuantity: number | string = "0.05", rejectedQuantity: number | string = "0.01") {
    return { expectedInspectionVersion: 1, approvalId, acceptedQuantity, rejectedQuantity,
      rejectionLocationId: rejectedQuantity === 0 ? null : locationId,
      ownershipConfirmation: acceptedQuantity === 0 ? null : "merchant_received" as const, postedAt: posted, idempotencyKey: key() };
  }
  async function physical(stockId: string) {
    return withTenant(database.db, context, async tx => sumStockQuantities((await tx.select().from(inventoryBalances).where(eq(inventoryBalances.stockItemId, stockId))).map(row => row.physicalQuantity)));
  }

  it("keeps arrival and inspection outside available stock, then posts and returns exact portions", async () => {
    const reference = "凭".repeat(2000), b = await approved(reference);
    expect(await physical(b.stock.id)).toBe(0);
    const first = await service.postInspection(context, b.line.id, posting(b.review.id));
    expect(first.quantities).toMatchObject({ accepted: "0.05", rejected: "0.01", pending: "0.063456789", rejectedHeld: "0.01" });
    expect(await physical(b.stock.id)).toBe("0.05");
    const afterReturn = await service.returnRejected(context, b.line.id, first.postings[0]!.id, { quantity: "0.003", returnedAt: returned,
      externalReference: "Synthetic actual handover reference", reason: "Synthetic supplier return", idempotencyKey: key() });
    expect(afterReturn.quantities).toMatchObject({ pending: "0.063456789", returned: "0.003", rejectedHeld: "0.007" });
    expect(await physical(b.stock.id)).toBe("0.05");
    const second = await service.postInspection(context, b.line.id, posting(b.review.id));
    expect(second.quantities).toMatchObject({ accepted: "0.1", rejected: "0.02", pending: "0.003456789", rejectedHeld: "0.017" });
    expect(second.canPost).toBe(false);
    expect(second.canInspect).toBe(true);
    expect(await physical(b.stock.id)).toBe("0.1");
    const remaining = await service.recordInspection(context, b.line.id, { ...b.input, expectedInspectionVersion: 1,
      acceptedQuantity: "0.003456789", rejectedQuantity: 0, rejectionReason: null, notes: "Synthetic actual remaining portion", idempotencyKey: key() });
    const lastReview = await service.reviewInspection(context, b.line.id, { expectedInspectionVersion: 2, inspectionId: remaining.inspections[0]!.id,
      decision: "approved", reason: "Synthetic remaining measurements checked", idempotencyKey: key() });
    const final = await service.postInspection(context, b.line.id, { ...posting(lastReview.inspections[0]!.review!.id, "0.003456789", 0), expectedInspectionVersion: 2 });
    expect(final.quantities).toMatchObject({ accepted: "0.103456789", rejected: "0.02", pending: 0, rejectedHeld: "0.017" });
    expect(await physical(b.stock.id)).toBe("0.103456789");
    const receipts = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementReceiptLines).where(eq(inventoryProcurementReceiptLines.stockItemId, b.stock.id)));
    expect(sumStockQuantities(receipts.map(row => row.receivedQuantity))).toBe("0.103456789");
    const receiptHeaders = await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementReceipts).where(eq(inventoryProcurementReceipts.purchaseOrderId, b.order.id)));
    expect(receiptHeaders).toHaveLength(3);
    expect(receiptHeaders.map(row => row.externalReference)).toEqual([reference, reference, reference]);
    expect(JSON.stringify(final)).not.toMatch(/requestChecksum|idempotencyKey|createdBy|tenantId/);
  });
  it("cannot create a new declared receipt or commit an internal ID without an actual incoming posting", async () => {
    const b = await basis();
    const request = { expectedVersion: 1, receivedAt: posted, externalReference: "Synthetic", lines: [{ lineKey: "LINE-1",
      receivedQuantity: 0, rejectedQuantity: 1, rejectionReasonCode: "SYNTHETIC_REJECTED", lotCode: null, expiresAt: null }], idempotencyKey: key() };
    await expect(procurement.recordReceipt(context, b.order.id, request)).rejects.toMatchObject({ status: 409 });
    await expect(withTenant(database.db, context, tx => procurement.recordReceiptInTransaction(tx, context, b.order.id, request, createEntityId())))
      .rejects.toMatchObject({ code: "23514" });
    expect(await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementReceipts).where(eq(inventoryProcurementReceipts.purchaseOrderId, b.order.id)))).toHaveLength(0);
    expect(await physical(b.stock.id)).toBe(0);
  });
  it("preserves missing and failing measurements instead of approving them", async () => {
    const b = await basis();
    const missing = await service.recordInspection(context, b.line.id, { ...b.input, readings: [] });
    expect(missing.inspections[0]!.evaluation).toMatchObject({ complete: false, passed: false });
    await expect(service.reviewInspection(context, b.line.id, { expectedInspectionVersion: 1, inspectionId: missing.inspections[0]!.id,
      decision: "approved", reason: "Synthetic missing measurement attempt", idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });
    const failed = await service.recordInspection(context, b.line.id, { ...b.input, expectedInspectionVersion: 1,
      readings: [{ criterionCode: "WIDTH", value: "10.000000002", unit: "mm" }], notes: "Synthetic reinspection evidence", idempotencyKey: key() });
    expect(failed.inspections[0]!.evaluation).toMatchObject({ complete: true, passed: false });
    await expect(service.reviewInspection(context, b.line.id, { expectedInspectionVersion: 2, inspectionId: failed.inspections[0]!.id,
      decision: "approved", reason: "Synthetic failing measurement attempt", idempotencyKey: key() })).rejects.toMatchObject({ status: 409 });
    expect(await physical(b.stock.id)).toBe(0);
  });
  it("serializes competing dispositions and binds replay to the original actor and body", async () => {
    const b = await approved(), a = posting(b.review.id, "0.08", 0), z = posting(b.review.id, "0.08", 0);
    const results = await Promise.allSettled([service.postInspection(context, b.line.id, a), service.postInspection(context, b.line.id, z)]);
    expect(results.filter(item => item.status === "fulfilled")).toHaveLength(1);
    const winner = results[0]!.status === "fulfilled" ? a : z;
    expect(await physical(b.stock.id)).toBe("0.08");
    await service.postInspection(context, b.line.id, winner);
    expect(await physical(b.stock.id)).toBe("0.08");
    await expect(service.postInspection(context, b.line.id, { ...winner, acceptedQuantity: "0.07" })).rejects.toMatchObject({ status: 409 });
    await expect(service.postInspection(coworker, b.line.id, winner)).rejects.toMatchObject({ status: 409 });
    expect(await physical(b.stock.id)).toBe("0.08");
  });
  it("rolls the business receipt, stock, posting and audits back on a late audit failure", async () => {
    const b = await approved(), original = audit.recordInTransaction.bind(audit);
    const spy = vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, ctx, input) => {
      if (input.action === "procurement.incoming.post") throw new Error("Synthetic late audit failure");
      return original(tx, ctx, input);
    });
    try { await expect(service.postInspection(context, b.line.id, posting(b.review.id))).rejects.toThrow("Synthetic late audit failure"); }
    finally { spy.mockRestore(); }
    expect(await physical(b.stock.id)).toBe(0);
    const rows = await withTenant(database.db, context, tx => tx.select().from(incomingPostings).where(eq(incomingPostings.arrivalLineId, b.line.id)));
    expect(rows).toHaveLength(0);
    expect(await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementReceipts).where(eq(inventoryProcurementReceipts.purchaseOrderId, b.order.id)))).toHaveLength(0);
  });
  it("rechecks revoked grants, narrow write scopes and cross-tenant reads", async () => {
    const b = await approved();
    const narrow: TenantContext = { ...coworker, permissionScopes: Object.fromEntries(permissions.map(p => [p, p === "procurement:write" ? "self" : "tenant"])) };
    await expect(service.postInspection(narrow, b.line.id, posting(b.review.id))).rejects.toMatchObject({ status: 403 });
    await expect(service.line(outsider, b.line.id)).rejects.toMatchObject({ status: 404 });
    try {
      await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: permissions.filter(p => p !== "inventory:write") }).where(eq(roles.id, roleIds.get(userId)!)));
      await expect(service.postInspection(context, b.line.id, posting(b.review.id))).rejects.toMatchObject({ status: 403 });
    } finally { await withTenant(database.db, context, tx => tx.update(roles).set({ permissions }).where(eq(roles.id, roleIds.get(userId)!))); }
    expect(await physical(b.stock.id)).toBe(0);
  });
  it("enforces original arrival lines and computes measurement truth in SQL", async () => {
    const b = await basis();
    await expectSqlState(withTenant(database.db, context, tx => tx.insert(procurementArrivalLines).values({ id: createEntityId(), tenantId,
      createdBy: userId, arrivalId: b.arrival.id, lineKey: "LINE-1", stockItemId: b.stock.id, holdingLocationId: locationId,
      quantity: 1, unit: "meter", supplierLotCode: "SYNTHETIC-LATE" })), "23514");
    const saved = await withTenant(database.db, context, tx => tx.insert(incomingInspections).values({ id: createEntityId(), tenantId,
      createdBy: userId, arrivalLineId: b.line.id, versionNumber: 1, standardVersionId: b.standard.id,
      acceptedQuantity: "0.1", rejectedQuantity: 0, sampleQuantity: "0.001", unit: "meter", rejectionReason: null,
      measuredAt: new Date(measured), readings: [], evaluation: { items: [{ code: "WIDTH", result: "pass" }], complete: true, passed: true },
      requestChecksum: "a".repeat(64), idempotencyKey: key() }).returning());
    expect(saved[0]!.evaluation).toMatchObject({ complete: false, passed: false });
    await expectSqlState(withTenant(database.db, context, tx => tx.insert(incomingInspectionReviews).values({ id: createEntityId(), tenantId,
      createdBy: userId, inspectionId: saved[0]!.id, decision: "approved", reason: "Synthetic SQL forgery attempt",
      requestChecksum: "b".repeat(64), idempotencyKey: key() })), "23514");
    expect(await withTenant(database.db, context, tx => tx.select().from(incomingInspectionReviews).where(eq(incomingInspectionReviews.inspectionId, saved[0]!.id)))).toHaveLength(0);
  });
  it("keeps posted quantities and original inspections when a later reinspection is recorded", async () => {
    const b = await approved(), firstInput = posting(b.review.id, "0.05", 0);
    const first = await service.postInspection(context, b.line.id, firstInput);
    const second = await service.recordInspection(context, b.line.id, { ...b.input, expectedInspectionVersion: 1,
      acceptedQuantity: "0.073456789", rejectedQuantity: 0, rejectionReason: null, notes: "Synthetic remaining portion reinspection", idempotencyKey: key() });
    expect(second.inspections.map(row => row.version)).toEqual([2, 1]);
    expect(second.postings[0]!.id).toBe(first.postings[0]!.id);
    await expect(service.postInspection(context, b.line.id, posting(b.review.id, "0.01", 0))).rejects.toMatchObject({ status: 409 });
    const replayed = await service.postInspection(context, b.line.id, firstInput);
    expect(replayed.quantities.accepted).toBe("0.05");
    expect(await physical(b.stock.id)).toBe("0.05");
  });
  it("rejects unrepresentable raw SQL quantities before rounding and agrees with exact measurement evaluation", async () => {
    const b = await basis();
    for (const quantity of ["0.1000000001", "2147483647.000000001"]) {
      await expectSqlState(withTenant(database.db, context, async tx => {
        const header = createEntityId();
        await tx.insert(procurementArrivals).values({ id: header, tenantId, createdBy: userId, code: `RAW-${randomUUID().toUpperCase()}`,
          purchaseOrderId: b.order.id, purchaseOrderVersionId: b.arrival.purchaseOrderVersionId, arrivedAt: new Date(occurred),
          externalReference: "Synthetic SQL quantity boundary", requestChecksum: "c".repeat(64), idempotencyKey: key() });
        await tx.execute(sql`insert into inventory_procurement_arrival_lines
          (id,tenant_id,created_by,arrival_id,line_key,stock_item_id,holding_location_id,quantity,unit,supplier_lot_code)
          values(${createEntityId()},${tenantId},${userId},${header},'LINE-1',${b.stock.id},${locationId},${quantity}::numeric,'meter','SYNTHETIC-RAW')`);
      }), "23514", "procurement_arrival_lines_quantity_check");
    }
    const criteria = [IncomingCriterionSchema.parse({ code: "WIDTH", label: "宽度", kind: "numeric_range", unit: "mm", minimum: "-0.000000001", maximum: "0.000000001" })];
    for (const value of ["-0.000000002", "-0.000000001", "0", "0.000000001", "0.000000002", "1e2", "0.0000000001"]) {
      const readings = [IncomingReadingSchema.parse({ criterionCode: "WIDTH", value, unit: "mm" })];
      const actual = await withTenant(database.db, context, tx => tx.execute<{ evaluation: unknown }>(sql`select evaluate_incoming_readings(${JSON.stringify(criteria)}::jsonb,${JSON.stringify(readings)}::jsonb) as evaluation`));
      expect(actual[0]!.evaluation).toEqual(evaluateIncomingReadings(criteria, readings));
    }
  });
  it("recovers encrypted originals across service instances and executes all six actual owners once", async () => {
    const b = await basis();
    const restart = new IncomingCommandService(database, new SecretVault(commandKey), service, audit);
    async function execute(original: PrepareIncomingCommand) {
      const prepared = await commands.prepare(context, original);
      expect(prepared).toMatchObject({ status: "prepared", canExecute: true, original });
      expect((await restart.list(context, { kind: original.kind, targetId: original.targetId })).items.map(row => row.id)).toEqual([prepared.id]);
      expect((await restart.get(context, prepared.id)).original).toEqual(prepared.original);
      const stored = await withTenant(database.db, context, tx => tx.select().from(incomingCommands).where(eq(incomingCommands.id, prepared.id)));
      expect(stored[0]!.encryptedInput).not.toContain(original.input.idempotencyKey);
      expect(stored[0]!.expiresAt.getTime() - stored[0]!.createdAt.getTime()).toBe(7 * 86400000);
      const outcomes = await Promise.all([commands.execute(context, prepared.id), restart.execute(context, prepared.id)]);
      expect(outcomes[0]).toEqual(outcomes[1]);
      expect(outcomes[0]).toMatchObject({ status: "succeeded", canExecute: false, result: { kind: original.kind } });
      expect((await restart.get(context, prepared.id)).result).toEqual(outcomes[0]!.result);
      expect(JSON.parse(outcomes[0]!.contextAuthority)).toMatchObject({ tenantId, userId });
      const publicFields = { ...outcomes[0] }; Reflect.deleteProperty(publicFields, "contextAuthority");
      expect(JSON.stringify(publicFields)).not.toMatch(/tenantId|createdBy|authoritySnapshot|requestChecksum|encryptedInput/);
      return outcomes[0]!;
    }
    const standard = await execute({ kind: "publish_standard", targetId: b.stock.id, input: { code: "FABRIC", stockItemId: b.stock.id,
      expectedVersion: 1, title: "Synthetic revised width", sourceReference: "Synthetic private source, no supplier acceptance",
      criteria: b.standard.criteria, idempotencyKey: key() } });
    const arrival = await execute({ kind: "record_arrival", targetId: b.order.id, input: { code: `ARR-${randomUUID().slice(0, 8).toUpperCase()}`,
      expectedPurchaseOrderVersion: 1, arrivedAt: occurred, externalReference: "Synthetic actual handover", lines: [{ lineKey: "LINE-1", quantity: "0.12", unit: "meter",
        holdingLocationId: locationId, lotCode: "SYNTHETIC-COMMAND-LOT", expiresAt: null }], idempotencyKey: key() } });
    expect(await physical(b.stock.id)).toBe(0);
    const workspace = await service.workspace(context, b.order.id), line = workspace.arrivals.find(row => row.id === arrival.result!.id)!.lines[0]!;
    const inspection = await execute({ kind: "record_inspection", targetId: line.id, input: { ...b.input, standardVersionId: standard.result!.id, idempotencyKey: key() } });
    expect(await physical(b.stock.id)).toBe(0);
    const review = await execute({ kind: "review_inspection", targetId: line.id, input: { expectedInspectionVersion: 1, inspectionId: inspection.result!.id,
      decision: "approved", reason: "Synthetic actual measurement review", idempotencyKey: key() } });
    expect(await physical(b.stock.id)).toBe(0);
    const postedCommand = await execute({ kind: "post_inspection", targetId: line.id, input: posting(review.result!.id, "0.1", "0.02") });
    expect(await physical(b.stock.id)).toBe("0.1");
    const returnedCommand = await execute({ kind: "return_rejected", targetId: line.id, postingId: postedCommand.result!.id,
      input: { quantity: "0.003", returnedAt: returned, externalReference: "Synthetic actual return", reason: "Synthetic damaged portion", idempotencyKey: key() } });
    expect((await service.line(context, line.id)).quantities).toMatchObject({ accepted: "0.1", rejected: "0.02", returned: "0.003", rejectedHeld: "0.017", pending: 0 });
    expect(await physical(b.stock.id)).toBe("0.1");
    const acknowledged = await restart.acknowledge(context, returnedCommand.id);
    expect(acknowledged).toMatchObject({ acknowledged: true, original: null, result: returnedCommand.result });
    expect((await commands.list(context, { kind: "return_rejected", targetId: line.id })).items).toEqual([]);
    expect((await restart.execute(context, postedCommand.id)).result).toEqual(postedCommand.result);
  });

  it("rolls a command result and all stock effects back when its final audit fails", async () => {
    const b = await approved(), original: PrepareIncomingCommand = { kind: "post_inspection", targetId: b.line.id, input: posting(b.review.id) };
    const prepared = await commands.prepare(context, original);
    const record = audit.recordInTransaction.bind(audit);
    const failure = vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, c, event) => {
      if (event.action === "procurement.incoming.command.execute") throw new Error("Synthetic command outcome audit failure");
      return record(tx, c, event);
    });
    try { await expect(commands.execute(context, prepared.id)).rejects.toThrow("Synthetic command outcome audit failure"); }
    finally { failure.mockRestore(); }
    expect(await physical(b.stock.id)).toBe(0);
    expect(await withTenant(database.db, context, tx => tx.select().from(inventoryProcurementReceipts).where(eq(inventoryProcurementReceipts.purchaseOrderId, b.order.id)))).toHaveLength(0);
    expect(await commands.get(context, prepared.id)).toMatchObject({ status: "prepared", original, result: null, canExecute: true });
    const actual = await commands.execute(context, prepared.id);
    expect(actual.status).toBe("succeeded");
    expect(await physical(b.stock.id)).toBe("0.05");
  });

  it("binds a prepared key to the original actor, body, target and return disposition", async () => {
    const b = await approved(), input = posting(b.review.id), original: PrepareIncomingCommand = { kind: "post_inspection", targetId: b.line.id, input };
    const prepared = await commands.prepare(context, original);
    expect((await commands.prepare(context, original)).id).toBe(prepared.id);
    await expect(commands.prepare(context, { ...original, input: { ...input, acceptedQuantity: "0.04" } })).rejects.toMatchObject({ status: 409 });
    await expect(commands.prepare(context, { ...original, targetId: createEntityId() })).rejects.toMatchObject({ status: 409 });
    await expect(commands.prepare(coworker, original)).rejects.toMatchObject({ status: 409 });
    await expect(commands.get(coworker, prepared.id)).rejects.toMatchObject({ status: 404 });
    await expect(commands.get(outsider, prepared.id)).rejects.toMatchObject({ status: 404 });
    await expect(commands.prepare(context, { ...original, input: { ...input, idempotencyKey: key() } })).rejects.toMatchObject({ status: 409 });
    const postedCommand = await commands.execute(context, prepared.id);
    const returnInput = { quantity: "0.001", returnedAt: returned, externalReference: "Synthetic handover", reason: "Synthetic defect", idempotencyKey: key() };
    const returnOriginal: PrepareIncomingCommand = { kind: "return_rejected", targetId: b.line.id, postingId: postedCommand.result!.id, input: returnInput };
    const preparedReturn = await commands.prepare(context, returnOriginal);
    await expect(commands.prepare(context, { ...returnOriginal, postingId: createEntityId() })).rejects.toMatchObject({ status: 409 });
    expect((await commands.get(context, preparedReturn.id)).original).toEqual(returnOriginal);
    expect(await physical(b.stock.id)).toBe("0.05");
  });

  it("keeps the original on basis revision and permits cancellation without rewriting it", async () => {
    const b = await basis(), original: PrepareIncomingCommand = { kind: "record_inspection", targetId: b.line.id, input: b.input };
    const prepared = await commands.prepare(context, original);
    await service.publishStandard(context, { code: "FABRIC", stockItemId: b.stock.id, expectedVersion: 1, title: "Synthetic changed standard",
      sourceReference: "Synthetic revised source", criteria: b.standard.criteria, idempotencyKey: key() });
    expect(await commands.get(context, prepared.id)).toMatchObject({ status: "prepared", original, canExecute: false, canCancel: true, blockReason: "basis_changed" });
    await expect(commands.execute(context, prepared.id)).rejects.toMatchObject({ status: 409 });
    expect((await commands.get(context, prepared.id)).original).toEqual(original);
    await expect(commands.acknowledge(context, prepared.id)).rejects.toMatchObject({ status: 409 });
    expect(await commands.cancel(context, prepared.id)).toMatchObject({ status: "cancelled", original: null, result: null });
    expect(await commands.acknowledge(context, prepared.id)).toMatchObject({ acknowledged: true, original: null });
    expect((await commands.list(context, { kind: original.kind, targetId: original.targetId })).items).toEqual([]);
    expect(await physical(b.stock.id)).toBe(0);
  });

  it("waits for actual database time after a short rollback without changing original chronology", async () => {
    const b = await basis(), original: PrepareIncomingCommand = { kind: "record_inspection", targetId: b.line.id, input: b.input };
    const prepared = await commands.prepare(context, original);
    await moveSyntheticCommandCreationAhead(prepared.id, "350 milliseconds");
    const cancelled = await commands.cancel(context, prepared.id);
    expect(cancelled).toMatchObject({ status: "cancelled", original: null, result: null });
    const [timing] = await withTenant(database.db, context, tx => tx.execute<{ ordered: boolean }>(sql`select completed_at>=created_at and completed_at<=clock_timestamp() as ordered
      from inventory_incoming_commands where id=${prepared.id}::uuid`));
    expect(timing!.ordered).toBe(true);
    expect(await physical(b.stock.id)).toBe(0);
  });

  it("keeps preparation and actual stock unchanged when database time cannot catch up within the retry budget", async () => {
    const b = await basis(), original: PrepareIncomingCommand = { kind: "record_inspection", targetId: b.line.id, input: b.input };
    const prepared = await commands.prepare(context, original);
    await moveSyntheticCommandCreationAhead(prepared.id, "10 seconds");
    const before = await withTenant(database.db, context, tx => tx.select().from(incomingCommands).where(eq(incomingCommands.id, prepared.id)));
    await expect(commands.cancel(context, prepared.id)).rejects.toMatchObject({ status: 409, response: { code: "database_clock_not_ready" } });
    expect(await withTenant(database.db, context, tx => tx.select().from(incomingCommands).where(eq(incomingCommands.id, prepared.id)))).toEqual(before);
    expect(await commands.get(context, prepared.id)).toMatchObject({ status: "prepared", original, result: null });
    expect(await physical(b.stock.id)).toBe(0);
  });

  async function moveSyntheticCommandCreationAhead(commandId: string, interval: "350 milliseconds" | "10 seconds") {
    if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)) throw new Error("Exact disposable clock fixture required");
    // This connection-local fixture models a record created before wall-clock
    // rollback. All constraints and the ordinary app trigger apply to the action.
    await database.client.begin(async fixture => {
      await fixture.unsafe("set local session_replication_role=replica");
      await fixture.unsafe("update inventory_incoming_commands set created_at=clock_timestamp()+$3::interval where tenant_id=$1 and id=$2", [tenantId, commandId, interval]);
    });
  }

  it("rechecks current narrow authority but still reads an actual result after write loss", async () => {
    const b = await approved(), original: PrepareIncomingCommand = { kind: "post_inspection", targetId: b.line.id, input: posting(b.review.id) };
    const prepared = await commands.prepare(coworker, original);
    const narrow: TenantContext = { ...coworker, permissionScopes: { "inventory:write": "self", "inventory:read": "tenant",
      "procurement:read": "tenant", "procurement:write": "tenant", "procurement:approve": "tenant" } };
    expect(await commands.get(narrow, prepared.id)).toMatchObject({ status: "prepared", original, canExecute: false, blockReason: "permission_denied" });
    await expect(commands.execute(narrow, prepared.id)).rejects.toMatchObject({ permission: "inventory:write" });
    expect(await physical(b.stock.id)).toBe(0);
    const actual = await commands.execute(coworker, prepared.id);
    try {
      await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: ["procurement:read", "inventory:read"] }).where(eq(roles.id, roleIds.get(otherUser)!)));
      expect(await commands.get(coworker, prepared.id)).toMatchObject({ status: "succeeded", result: actual.result, canExecute: false });
      expect((await commands.execute(coworker, prepared.id)).result).toEqual(actual.result);
      expect(await commands.cancel(coworker, prepared.id)).toMatchObject({ status: "succeeded", result: actual.result });
      await withTenant(database.db, context, tx => tx.update(roles).set({ permissions: ["procurement:read"] }).where(eq(roles.id, roleIds.get(otherUser)!)));
      await expect(commands.get(coworker, prepared.id)).rejects.toMatchObject({ permission: "inventory:read" });
    } finally { await withTenant(database.db, context, tx => tx.update(roles).set({ permissions }).where(eq(roles.id, roleIds.get(otherUser)!))); }
    expect(await physical(b.stock.id)).toBe("0.05");
  });

  it("refuses command bypass, forged success and a fact without its atomic outcome", async () => {
    const b = await approved(), input = posting(b.review.id);
    const prepared = await commands.prepare(context, { kind: "post_inspection", targetId: b.line.id, input });
    await expectSqlState(service.postInspection(context, b.line.id, input), "23514");
    await expectSqlState(withTenant(database.db, context, tx => tx.update(incomingCommands).set({ status: "succeeded", resultId: createEntityId(),
      completedAt: sql`clock_timestamp()` }).where(eq(incomingCommands.id, prepared.id))), "23514");
    await expectSqlState(withTenant(database.db, context, async tx => {
      await tx.execute(sql`select set_config('app.incoming_command_id',${prepared.id},true)`);
      await service.postInspection(context, b.line.id, input, tx);
    }), "23514");
    expect(await physical(b.stock.id)).toBe(0);
    expect(await commands.get(context, prepared.id)).toMatchObject({ status: "prepared", canExecute: true, result: null });
    expect((await commands.execute(context, prepared.id)).status).toBe("succeeded");
    expect(await physical(b.stock.id)).toBe("0.05");
  });

  it("blocks unavailable encrypted input and never rebuilds it from caller or current data", async () => {
    const b = await approved(), prepared = await commands.prepare(context, { kind: "post_inspection", targetId: b.line.id, input: posting(b.review.id) });
    const unavailableKey = new IncomingCommandService(database, new SecretVault(randomBytes(32)), service, audit);
    expect(await unavailableKey.get(context, prepared.id)).toMatchObject({ original: null, canExecute: false, blockReason: "input_unavailable" });
    await expect(unavailableKey.execute(context, prepared.id)).rejects.toMatchObject({ status: 409, response: expect.objectContaining({ code: "incoming_original_unavailable" }) });
    const recovered = await commands.get(context, prepared.id);
    expect(recovered).toMatchObject({ status: "prepared", original: prepared.original, result: null, canExecute: true });
    expect(await physical(b.stock.id)).toBe(0);
    expect((await commands.execute(context, prepared.id)).status).toBe("succeeded");
    expect(await physical(b.stock.id)).toBe("0.05");
  });

  it("physically expires only due tenant inputs with empty business permissions and preserves actual success", async () => {
    const b = await approved(), prepared = await commands.prepare(context, { kind: "post_inspection", targetId: b.line.id, input: posting(b.review.id) });
    const actual = await commands.execute(context, prepared.id);
    const c = await approved(), pending = await commands.prepare(context, { kind: "post_inspection", targetId: c.line.id, input: posting(c.review.id) });
    // Age only two exact synthetic rows in this disposable DB. App execution and
    // retention below still run as yummyai_app with all business guards enabled.
    await database.client.begin(async fixture => {
      await fixture.unsafe("set local session_replication_role=replica");
      await fixture.unsafe("update inventory_incoming_commands set created_at=clock_timestamp()-interval '8 days',expires_at=clock_timestamp()-interval '1 day' where tenant_id=$1 and id in ($2,$3)", [tenantId, prepared.id, pending.id]);
    });
    const maintenance: TenantContext = { tenantId, userId: "00000000-0000-7000-8000-000000000005", permissions: [], dataScope: "tenant" };
    expect(await withTenant(database.db, { ...maintenance, tenantId: otherTenant }, tx => expireIncomingCommandInputs(tx))).toBe(0);
    expect(await withTenant(database.db, maintenance, tx => expireIncomingCommandInputs(tx, { limit: 1 }))).toBe(1);
    expect(await withTenant(database.db, maintenance, tx => expireIncomingCommandInputs(tx, { limit: 1 }))).toBe(1);
    expect(await withTenant(database.db, maintenance, tx => expireIncomingCommandInputs(tx))).toBe(0);
    expect(await commands.get(context, prepared.id)).toMatchObject({ status: "succeeded", original: null, result: actual.result });
    expect(await commands.execute(context, pending.id)).toMatchObject({ status: "expired", original: null, result: null, canExecute: false });
    expect(await physical(b.stock.id)).toBe("0.05");
    expect(await physical(c.stock.id)).toBe(0);
  });
  it("rechecks the exact original arrival stock and holding location before revealing its private input", async () => {
    const b = await basis();
    const warehouse = await inventory.createWarehouse(coworker, { code: `OTHER-${randomUUID().slice(0, 8).toUpperCase()}`, name: "Synthetic other-owned hold", type: "owned", countryCode: "US", timeZone: "UTC" });
    const otherHold = await inventory.createLocation(coworker, { warehouseId: warehouse.id, code: "OTHER-HOLD", name: "Synthetic scoped holding location" });
    const original: PrepareIncomingCommand = { kind: "record_arrival", targetId: b.order.id, input: { code: `ARR-${randomUUID().slice(0, 8).toUpperCase()}`,
      expectedPurchaseOrderVersion: 1, arrivedAt: occurred, externalReference: "Synthetic private scoped handover", lines: [{ lineKey: "LINE-1", quantity: "0.1", unit: "meter",
        holdingLocationId: otherHold.id, lotCode: "供应商原批 Ab/2026", expiresAt: null }], idempotencyKey: key() } };
    const prepared = await commands.prepare(context, original);
    const narrow: TenantContext = { ...context, permissionScopes: { "inventory:read": "self", "inventory:write": "tenant", "procurement:read": "tenant", "procurement:write": "tenant", "procurement:approve": "tenant" } };
    await expect(commands.get(narrow, prepared.id)).rejects.toMatchObject({ permission: "inventory:read" });
    await expect(commands.listForPurchaseOrder(narrow, b.order.id)).rejects.toMatchObject({ permission: "inventory:read" });
    const actual = await commands.execute(context, prepared.id);
    expect(actual.status).toBe("succeeded");
    const arrived = (await service.workspace(context, b.order.id)).arrivals.find(row => row.id === actual.result!.id)!;
    expect(arrived.lines[0]!.supplierLotCode).toBe("供应商原批 Ab/2026");
    expect(arrived.lines[0]!.holdingLocationId).toBe(otherHold.id);
    await commands.acknowledge(context, prepared.id);
    await expect(commands.get(narrow, prepared.id)).rejects.toMatchObject({ permission: "inventory:read" });
    expect(await physical(b.stock.id)).toBe(0);
  });
  it("finds and paginates original commands beyond the latest arrival page without another actor's input", async () => {
    const b = await basis();
    const originals: { id: string; lineId: string }[] = [];
    for (let index = 0; index < 51; index++) {
      const arrival = await service.recordArrival(context, b.order.id, { code: `PAGE-${index}-${randomUUID().slice(0, 8).toUpperCase()}`, expectedPurchaseOrderVersion: 1,
        arrivedAt: occurred, externalReference: "Synthetic paginated handover", lines: [{ lineKey: "LINE-1", quantity: "0.123456789", unit: "meter",
          holdingLocationId: locationId, lotCode: `SYNTHETIC-PAGE-${index}`, expiresAt: null }], idempotencyKey: key() });
      const lineId = arrival.lines[0]!.id;
      const original = await commands.prepare(context, { kind: "record_inspection", targetId: lineId, input: { ...b.input, idempotencyKey: key() } });
      originals.push({ id: original.id, lineId });
    }
    const workspace = await service.workspace(context, b.order.id);
    expect(workspace.arrivals).toHaveLength(50); expect(workspace.truncated).toBe(true);
    expect(workspace.arrivals.flatMap(row => row.lines).some(row => row.id === originals[0]!.lineId)).toBe(false);
    const first = await commands.listForPurchaseOrder(context, b.order.id);
    expect(first.items).toHaveLength(50); expect(first.nextCursor).not.toBeNull();
    const last = await commands.listForPurchaseOrder(context, b.order.id, first.nextCursor!);
    expect(last.items).toHaveLength(1); expect(last.nextCursor).toBeNull();
    expect(last.items[0]!.id).toBe(originals[0]!.id);
    expect(new Set([...first.items, ...last.items].map(row => row.id)).size).toBe(51);
    expect((await commands.listForPurchaseOrder(coworker, b.order.id)).items).toEqual([]);
    await expect(commands.listForPurchaseOrder(outsider, b.order.id)).rejects.toMatchObject({ status: 404 });
    expect((await commands.get(context, originals[0]!.id)).original?.input.idempotencyKey).toBeTruthy();
    expect((await service.lineWorkspace(context, originals[0]!.lineId)).line.id).toBe(originals[0]!.lineId);
    expect(await physical(b.stock.id)).toBe(0);
  }, 60_000);
});

async function expectSqlState(promise: Promise<unknown>, expected: string, constraint?: string) {
  let code: unknown, actualConstraint: unknown;
  try { await promise; } catch (error) {
    const outer = error as { code?: string; constraint_name?: string; cause?: { code?: string; constraint_name?: string } };
    code = outer.code ?? outer.cause?.code; actualConstraint = outer.constraint_name ?? outer.cause?.constraint_name;
  }
  expect(code).toBe(expected);
  if (constraint) expect(actualConstraint).toBe(constraint);
}
