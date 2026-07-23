import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type NormalizeOrderInput, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase, fulfillmentSuppliers, orderCustomizationRequirements, orderExceptions,
  orderRoutingDecisions, productionOrderVersions, productionOrders, purchaseOrderVersions, purchaseOrders,
  qualityDefects, routingPolicyVersions, withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderService } from "./order.service.js";

describe("production, quality, and recovery", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId(); const accountA = createEntityId();
  const supplierId = createEntityId(); const policyId = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const vault = new SecretVault(Buffer.alloc(32, 47));
  let orders: OrderService;
  let production: OrderProductionService;

  beforeAll(async () => {
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "Production A", `production-a-${tenantA}`, tenantB, "Production B", `production-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `production-a-${userA}`, `a-${userA}@example.test`, "A", userB, `production-b-${userB}`, `b-${userB}@example.test`, "B"]);
    await database.client.unsafe("insert into marketplace_accounts (id,tenant_id,platform,display_name,region,authorization_mode,created_by) values ($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)", [accountA, tenantA, "Production Shop", userA]);
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: tenantA, name: "Manual production", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", priority: 3, createdBy: userA });
      await tx.insert(routingPolicyVersions).values({ id: policyId, tenantId: tenantA, name: "Production fixture", versionNumber: 1, weights: { capability: 2000, region: 1000, cost: 2000, leadTime: 2000, capacity: 1000, quality: 1500, priority: 500 }, thresholds: { minimumQualityBps: 8000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 2000, manualApprovalCostMinor: 2000, manualApprovalRiskBps: 2000 }, tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"], active: true, createdBy: userA });
    });
    const audit = new AuditService(database);
    orders = new OrderService(database, vault, audit);
    production = new OrderProductionService(database, vault, orders, audit);
  });

  afterAll(async () => { await database.client.end(); });

  it("pins encrypted production instructions, ordered milestones, quality evidence, and fulfillment gates", async () => {
    const fixture = await productionReadyOrder("pass");
    const created = await production.create(contextA, fixture.order.id, {
      orderLineId: fixture.lineId, routingDecisionId: fixture.decisionId, purchaseOrderVersionId: fixture.purchaseVersionId,
      designVersionId: null, productionAssetIds: [], expectedCompletionAt: "2026-07-30T12:00:00.000Z",
      instructions: "Customer name must never appear in a public projection", idempotencyKey: "production-pass-0001",
    });
    const batch = await production.createBatch(contextA, {
      supplierId, productionOrderIds: [created.productionOrder.id], expectedCompletionAt: "2026-07-30T12:00:00.000Z",
      idempotencyKey: "production-batch-pass-0001",
    });
    await expect(production.getBatch(contextB, batch.batch.id)).rejects.toBeInstanceOf(NotFoundException);
    const released = await production.recordBatchEvent(contextA, batch.batch.id, {
      type: "released", expectedProjectionVersion: 1, occurredAt: "2026-07-22T11:00:00.000Z",
      externalEventId: "batch-released-pass", evidenceCode: "SUPPLIER_RELEASED", note: "Private release note",
    });
    const started = await production.recordBatchEvent(contextA, batch.batch.id, {
      type: "started", expectedProjectionVersion: released.batch.projectionVersion, occurredAt: "2026-07-22T11:30:00.000Z",
      externalEventId: "batch-started-pass", evidenceCode: "SUPPLIER_STARTED", note: null,
    });
    expect(JSON.stringify(released)).not.toContain("Private release note");
    await expect(production.recordBatchEvent(contextA, batch.batch.id, {
      type: "completed", expectedProjectionVersion: started.batch.projectionVersion, occurredAt: "2026-07-22T11:45:00.000Z",
      externalEventId: "batch-completed-too-early", evidenceCode: "SUPPLIER_COMPLETED", note: null,
    })).rejects.toBeInstanceOf(ConflictException);
    const [storedVersion] = await withTenant(database.db, contextA, (tx) => tx.select().from(productionOrderVersions).where(eq(productionOrderVersions.productionOrderId, created.productionOrder.id)));
    expect(storedVersion?.encryptedInstructions).not.toContain("Customer name");
    expect(JSON.stringify(created)).not.toContain("Customer name");
    let projectionVersion = 1;
    for (const [type, code] of [["submitted", "DRAFT_APPROVED"], ["acknowledged", "SUPPLIER_ACCEPTED"], ["started", "PRODUCTION_STARTED"], ["completed", "PRODUCTION_COMPLETED"]] as const) {
      const result = await production.recordMilestone(contextA, created.productionOrder.id, { type, expectedProjectionVersion: projectionVersion, externalEventId: `${type}-pass`, occurredAt: "2026-07-22T12:00:00.000Z", evidence: { code, note: null, assetIds: [] } });
      projectionVersion = result.productionOrder.projectionVersion;
    }
    const completedBatch = await production.recordBatchEvent(contextA, batch.batch.id, {
      type: "completed", expectedProjectionVersion: started.batch.projectionVersion, occurredAt: "2026-07-22T12:30:00.000Z",
      externalEventId: "batch-completed-pass", evidenceCode: "SUPPLIER_COMPLETED", note: null,
    });
    expect(completedBatch).toMatchObject({ batch: { status: "completed", projectionVersion: 4 } });
    expect(completedBatch.events).toHaveLength(3);
    const current = await orders.get(contextA, fixture.order.id);
    const qc = await orders.transition(contextA, fixture.order.id, { toState: "awaiting_quality_control", expectedSequence: current.latestEventSequence, idempotencyKey: "quality-transition-pass", reason: "Production completed" });
    await expect(orders.transition(contextA, fixture.order.id, { toState: "awaiting_shipment", expectedSequence: qc.latestEventSequence, idempotencyKey: "shipment-before-inspection", reason: "Too early" })).rejects.toBeInstanceOf(ConflictException);
    const standard = await production.createQualityStandard(contextA, { name: "POD output", skuId: null, supplierId, minimumScoreBps: 9000, criteria: [{ code: "OUTPUT", label: "Output quality", weightBps: 10_000, blocking: true }] });
    await production.inspect(contextA, created.productionOrder.id, { qualityStandardVersionId: standard.id, result: "passed", scoreBps: 9500, inspectedAt: "2026-07-22T13:00:00.000Z", evidenceAssetIds: [], defects: [], idempotencyKey: "inspection-pass-0001" });
    const shipment = await orders.transition(contextA, fixture.order.id, { toState: "awaiting_shipment", expectedSequence: qc.latestEventSequence, idempotencyKey: "shipment-after-inspection", reason: "QC passed" });
    expect(shipment.workflowState).toBe("awaiting_shipment");
  });

  it("keeps failed QC and remake lineage immutable and tenant isolated", async () => {
    const fixture = await productionReadyOrder("fail");
    const created = await production.create(contextA, fixture.order.id, { orderLineId: fixture.lineId, routingDecisionId: fixture.decisionId, purchaseOrderVersionId: fixture.purchaseVersionId, designVersionId: null, productionAssetIds: [], expectedCompletionAt: "2026-07-30T12:00:00.000Z", instructions: "Original production instructions", idempotencyKey: "production-fail-0001" });
    let version = 1;
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const) {
      version = (await production.recordMilestone(contextA, created.productionOrder.id, { type, expectedProjectionVersion: version, externalEventId: `${type}-fail`, occurredAt: "2026-07-22T12:00:00.000Z", evidence: { code: type.toUpperCase(), note: null, assetIds: [] } })).productionOrder.projectionVersion;
    }
    const standard = await production.createQualityStandard(contextA, { name: "POD output fail", skuId: null, supplierId, minimumScoreBps: 9000, criteria: [{ code: "OUTPUT", label: "Output quality", weightBps: 10_000, blocking: true }] });
    const failed = await production.inspect(contextA, created.productionOrder.id, { qualityStandardVersionId: standard.id, result: "failed", scoreBps: 6000, inspectedAt: "2026-07-22T13:00:00.000Z", evidenceAssetIds: [], defects: [{ code: "PRINT_SHIFT", severity: "major", responsibility: "supplier", disposition: "remake", note: "Personalization alignment failed", evidenceAssetIds: [] }], idempotencyKey: "inspection-fail-0001" });
    expect(failed.productionOrder.status).toBe("quality_hold");
    const [defect] = await withTenant(database.db, contextA, (tx) => tx.select().from(qualityDefects).where(eq(qualityDefects.productionOrderId, created.productionOrder.id)));
    expect(defect?.encryptedDetail).not.toContain("alignment");
    expect(await withTenant(database.db, contextA, (tx) => tx.select().from(orderExceptions).where(eq(orderExceptions.orderId, fixture.order.id)))).toEqual([expect.objectContaining({ category: "quality", code: "QUALITY_INSPECTION_FAILED" })]);
    const recovery = await production.recover(contextA, { type: "remake", originalProductionOrderId: created.productionOrder.id, defectId: defect!.id, reason: "Supplier-approved remake", compensationAmountMinor: null, compensationCurrency: null, expectedCompletionAt: "2026-08-02T12:00:00.000Z", idempotencyKey: "recovery-remake-0001" });
    const [replacement] = await withTenant(database.db, contextA, (tx) => tx.select().from(productionOrders).where(eq(productionOrders.id, recovery.replacementProductionOrderId!)));
    expect(replacement).toMatchObject({ source: "remake", parentProductionOrderId: created.productionOrder.id, status: "planned" });
    expect((await production.get(contextA, created.productionOrder.id)).productionOrder.status).toBe("quality_hold");
    await expect(production.recordRecoveryEvent(contextA, recovery.recoveryId, {
      action: "resolve", expectedProjectionVersion: 1, outcomeCode: "REMAKE_COMPLETE", note: null,
      externalReference: null, occurredAt: "2026-07-22T14:00:00.000Z",
    })).rejects.toBeInstanceOf(ConflictException);
    let replacementVersion = 1;
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const) {
      replacementVersion = (await production.recordMilestone(contextA, replacement!.id, {
        type, expectedProjectionVersion: replacementVersion, externalEventId: `${type}-remake`,
        occurredAt: "2026-07-23T12:00:00.000Z", evidence: { code: type.toUpperCase(), note: null, assetIds: [] },
      })).productionOrder.projectionVersion;
    }
    await production.inspect(contextA, replacement!.id, {
      qualityStandardVersionId: standard.id, result: "passed", scoreBps: 9500,
      inspectedAt: "2026-07-23T13:00:00.000Z", evidenceAssetIds: [], defects: [],
      idempotencyKey: "inspection-remake-pass-0001",
    });
    const resolved = await production.recordRecoveryEvent(contextA, recovery.recoveryId, {
      action: "resolve", expectedProjectionVersion: 1, outcomeCode: "REMAKE_COMPLETE", note: "Replacement accepted",
      externalReference: null, occurredAt: "2026-07-23T14:00:00.000Z",
    });
    expect(resolved).toMatchObject({ recovery: { status: "resolved", projectionVersion: 2 } });
    expect(JSON.stringify(resolved)).not.toContain("Replacement accepted");
    expect(resolved.events).toHaveLength(1);
    await expect(production.get(contextB, replacement!.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(production.getRecovery(contextB, recovery.recoveryId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("requires external evidence before compensation recovery can resolve", async () => {
    const fixture = await productionReadyOrder("compensation");
    const created = await production.create(contextA, fixture.order.id, {
      orderLineId: fixture.lineId, routingDecisionId: fixture.decisionId, purchaseOrderVersionId: fixture.purchaseVersionId,
      designVersionId: null, productionAssetIds: [], expectedCompletionAt: "2026-07-30T12:00:00.000Z",
      instructions: "Compensation fixture", idempotencyKey: "production-compensation-0001",
    });
    const recovery = await production.recover(contextA, {
      type: "cancellation_compensation", originalProductionOrderId: created.productionOrder.id, defectId: null,
      reason: "Supplier cancellation", compensationAmountMinor: 500, compensationCurrency: "USD",
      expectedCompletionAt: null, idempotencyKey: "recovery-compensation-0001",
    });
    await expect(production.recordRecoveryEvent(contextA, recovery.recoveryId, {
      action: "resolve", expectedProjectionVersion: 1, outcomeCode: "CREDIT_ISSUED", note: null,
      externalReference: null, occurredAt: "2026-07-22T15:00:00.000Z",
    })).rejects.toBeInstanceOf(ConflictException);
    const resolved = await production.recordRecoveryEvent(contextA, recovery.recoveryId, {
      action: "resolve", expectedProjectionVersion: 1, outcomeCode: "CREDIT_ISSUED", note: null,
      externalReference: "supplier-credit-0001", occurredAt: "2026-07-22T15:05:00.000Z",
    });
    expect(resolved.recovery.status).toBe("resolved");
    expect(resolved.events[0]).toMatchObject({ externalReference: "supplier-credit-0001", outcomeCode: "CREDIT_ISSUED" });
  });

  async function productionReadyOrder(suffix: string) {
    const order = await orders.ingestNormalized(contextA, orderFixture(accountA, suffix));
    const lineId = order.lines[0]!.id;
    const decisionId = createEntityId(); const purchaseId = createEntityId(); const purchaseVersionId = createEntityId();
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(orderCustomizationRequirements).values({ id: createEntityId(), tenantId: tenantA, orderId: order.id, orderLineId: lineId, schemaVersion: 1, schemaSnapshot: { version: 1, fields: [] }, fulfillmentPath: "template_ready", status: "approved", createdBy: userA });
      await tx.insert(orderRoutingDecisions).values({ id: decisionId, tenantId: tenantA, orderId: order.id, orderLineId: lineId, routingPolicyVersionId: policyId, versionNumber: 1, status: "approved", selectedSupplierId: supplierId, inputChecksum: "a".repeat(64), requiresApproval: false, approvalReasons: [], idempotencyKey: `routing-${suffix}` });
      await tx.insert(purchaseOrders).values({ id: purchaseId, tenantId: tenantA, supplierId, orderId: order.id, status: "approved", currentVersionNumber: 1, createdBy: userA });
      await tx.insert(purchaseOrderVersions).values({ id: purchaseVersionId, tenantId: tenantA, purchaseOrderId: purchaseId, versionNumber: 1, currency: "USD", totalMinor: 800, lineSnapshot: [{ orderLineId: lineId, quantity: 1, unitCostMinor: 800 }], routingDecisionIds: [decisionId], checksum: "b".repeat(64), createdBy: userA });
    });
    let current = order;
    for (const state of ["awaiting_customization", "awaiting_design", "awaiting_customer_approval", "awaiting_routing", "in_production"] as const) {
      current = await orders.transition(contextA, order.id, { toState: state, expectedSequence: current.latestEventSequence, idempotencyKey: `${suffix}-${state}`, reason: "Fixture preparation" });
    }
    return { order: current, lineId, decisionId, purchaseVersionId };
  }
});

function orderFixture(accountId: string, suffix: string): NormalizeOrderInput {
  return { accountId, platform: "etsy", externalEventId: `production-event-${suffix}`, externalOrderId: `production-order-${suffix}`, providerStatus: "paid", placedAt: "2026-07-22T10:00:00.000Z", orderTotal: { amountMinor: 2500, currency: "USD" }, lines: [{ externalLineId: `production-line-${suffix}`, externalListingId: null, skuCode: null, title: "Production product", quantity: 1, unitPrice: { amountMinor: 2500, currency: "USD" }, customizationCount: 0 }], redactedSource: { receiptId: `production-order-${suffix}` }, protectedDetails: null };
}
