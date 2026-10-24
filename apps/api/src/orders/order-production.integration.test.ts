import { syntheticQualityInspection } from "../../../../tools/testing/quality-fixtures.js";
import { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError } from "@yummyai/authz";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, RecordQualityInspectionInputSchema, type NormalizeOrderInput, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase, fulfillmentSuppliers, orderCustomizationRequirements, orderExceptions,
  orderRoutingDecisions, productionOrderVersions, productionOrders, purchaseOrderVersions, purchaseOrders,
  qualityDefects, qualityInspections, memberships, membershipRoles, roles, routingPolicyVersions, withTenant, loadCurrentMembershipContext,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";

import { AuditService } from "../audit/audit.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderService } from "./order.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { syntheticNativeManufacturingForLine } from "./manufacturing-production.test-fixture.js";

requireDisposableIntegrationEnvironment();
describe("production, quality, and recovery", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId(); const accountA = createEntityId();
  const supplierId = createEntityId(); const policyId = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write", "product:read", "design:read", "asset:read"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const vault = new SecretVault(Buffer.alloc(32, 47));
  let orders: OrderService;
  let audit: AuditService;
  let production: OrderProductionService;
  let factoryFixture: Awaited<ReturnType<typeof createSyntheticFactory>>;
  let capacityFixture: Awaited<ReturnType<typeof createSyntheticFactoryCapacity>>;

  beforeAll(async () => {
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "Production A", `production-a-${tenantA}`, tenantB, "Production B", `production-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `production-a-${userA}`, `a-${userA}@example.test`, "A", userB, `production-b-${userB}`, `b-${userB}@example.test`, "B"]);
    await database.client.unsafe("insert into marketplace_accounts (id,tenant_id,platform,display_name,region,authorization_mode,created_by) values ($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)", [accountA, tenantA, "Production Shop", userA]);
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: tenantA, name: "Manual production", kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", priority: 3, profile: syntheticSupplierProfile, createdBy: userA });
      await tx.insert(routingPolicyVersions).values({ id: policyId, tenantId: tenantA, name: "Production fixture", versionNumber: 1, weights: { capability: 2000, region: 1000, cost: 2000, leadTime: 2000, capacity: 1000, quality: 1500, priority: 500 }, thresholds: { minimumQualityBps: 8000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 2000, manualApprovalCostMinor: 2000, manualApprovalRiskBps: 2000 }, tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"], active: true, createdBy: userA });
    });
    audit = new AuditService(database);
    orders = new OrderService(database, vault, audit);
    const factories = new FactoryDirectoryService(database, audit);
    factoryFixture = await createSyntheticFactory(factories, contextA, supplierId, "rectangular_print");
    capacityFixture = await createSyntheticFactoryCapacity(database, contextA, { factory: factoryFixture.factory,
      bindings: [{ capabilityVersionId: factoryFixture.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10_000 });
    production = new OrderProductionService(database, vault, orders, audit, undefined, factories);
  });

  afterAll(async () => { await database.client.end(); });

  it("pins encrypted production instructions, ordered milestones, quality evidence, and fulfillment gates", async () => {
    const fixture = await productionReadyOrder("pass");
    const created = await production.create(contextA, fixture.order.id, {
      ...factoryFixture.pins,
      orderLineId: fixture.lineId, routingDecisionId: fixture.decisionId, purchaseOrderVersionId: fixture.purchaseVersionId,
      ...fixture.productionBasis, expectedCompletionAt: capacityFixture.expectedCompletionAt,
      instructions: "Customer name must never appear in a public projection", idempotencyKey: "production-pass-0001",
    });
    const batch = await production.createBatch(contextA, {
      supplierId, productionOrderIds: [created.productionOrder.id], expectedCompletionAt: capacityFixture.expectedCompletionAt,
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
    await production.inspect(contextA, created.productionOrder.id, await syntheticQualityInspection(production, contextA, created.productionOrder.id, { qualityStandardVersionId: standard.id, result: "passed", scoreBps: 9500, inspectedAt: "2026-07-22T13:00:00.000Z", evidenceAssetIds: [], defects: [], idempotencyKey: "inspection-pass-0001" }));
    const shipment = await orders.transition(contextA, fixture.order.id, { toState: "awaiting_shipment", expectedSequence: qc.latestEventSequence, idempotencyKey: "shipment-after-inspection", reason: "QC passed" });
    expect(shipment.workflowState).toBe("awaiting_shipment");
  });

  it("keeps failed QC and remake lineage immutable and tenant isolated", async () => {
    const fixture = await productionReadyOrder("fail");
    const created = await production.create(contextA, fixture.order.id, { ...factoryFixture.pins, orderLineId: fixture.lineId, routingDecisionId: fixture.decisionId, purchaseOrderVersionId: fixture.purchaseVersionId, ...fixture.productionBasis, expectedCompletionAt: capacityFixture.expectedCompletionAt, instructions: "Original production instructions", idempotencyKey: "production-fail-0001" });
    let version = 1;
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const) {
      version = (await production.recordMilestone(contextA, created.productionOrder.id, { type, expectedProjectionVersion: version, externalEventId: `${type}-fail`, occurredAt: "2026-07-22T12:00:00.000Z", evidence: { code: type.toUpperCase(), note: null, assetIds: [] } })).productionOrder.projectionVersion;
    }
    const standard = await production.createQualityStandard(contextA, { name: "POD output fail", skuId: null, supplierId, minimumScoreBps: 9000, criteria: [{ code: "OUTPUT", label: "Output quality", weightBps: 10_000, blocking: true }] });
    const failed = await production.inspect(contextA, created.productionOrder.id, await syntheticQualityInspection(production, contextA, created.productionOrder.id, { qualityStandardVersionId: standard.id, result: "failed", scoreBps: 6000, inspectedAt: "2026-07-22T13:00:00.000Z", evidenceAssetIds: [], defects: [{ code: "PRINT_SHIFT", severity: "major", responsibility: "supplier", disposition: "remake", note: "Personalization alignment failed", evidenceAssetIds: [] }], idempotencyKey: "inspection-fail-0001" }));
    expect(failed.productionOrder.status).toBe("quality_hold");
    const [defect] = await withTenant(database.db, contextA, (tx) => tx.select().from(qualityDefects).where(eq(qualityDefects.productionOrderId, created.productionOrder.id)));
    expect(defect?.encryptedDetail).not.toContain("alignment");
    expect(await withTenant(database.db, contextA, (tx) => tx.select().from(orderExceptions).where(eq(orderExceptions.orderId, fixture.order.id)))).toEqual([expect.objectContaining({ category: "quality", code: "QUALITY_INSPECTION_FAILED" })]);
    const recovery = await production.recover(contextA, { type: "remake", capacityPlan: capacityFixture.capacityPlan, manufacturing: fixture.productionBasis.manufacturing, originalProductionOrderId: created.productionOrder.id, defectId: defect!.id, reason: "Supplier-approved remake", compensationAmountMinor: null, compensationCurrency: null, expectedCompletionAt: capacityFixture.expectedCompletionAt, idempotencyKey: "recovery-remake-0001" });
    const [replacement] = await withTenant(database.db, contextA, (tx) => tx.select().from(productionOrders).where(eq(productionOrders.id, recovery.replacementProductionOrderId!)));
    expect(replacement).toMatchObject({ source: "remake", parentProductionOrderId: created.productionOrder.id, status: "planned" });
    await expect(production.inspect(contextA, created.productionOrder.id, await syntheticQualityInspection(production, contextA, created.productionOrder.id,
      RecordQualityInspectionInputSchema.parse({ qualityStandardVersionId: standard.id, result: "passed", scoreBps: 9500,
        inspectedAt: "2026-07-23T13:00:00.000Z", idempotencyKey: "original-cannot-pass-with-remake" })))).rejects.toThrow(/补做/);
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
    await production.inspect(contextA, replacement!.id, await syntheticQualityInspection(production, contextA, replacement!.id, {
      qualityStandardVersionId: standard.id, result: "passed", scoreBps: 9500,
      inspectedAt: "2026-07-23T13:00:00.000Z", evidenceAssetIds: [], defects: [],
      idempotencyKey: "inspection-remake-pass-0001",
    }));
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
      ...fixture.productionBasis, expectedCompletionAt: capacityFixture.expectedCompletionAt,
      instructions: "Compensation fixture", idempotencyKey: "production-compensation-0001",
      ...factoryFixture.pins,
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


  it("criterion evidence refuses incomplete checks, forged totals, blocking passes, foreign evidence and future times", async () => {
    const fixture = await completedQualityFixture("criteria");
    const standard = await weightedQualityStandard("criteria");
    const base = RecordQualityInspectionInputSchema.parse({
      qualityStandardVersionId: standard.id, result: "passed", scoreBps: 9450,
      inspectedAt: "2026-07-22T13:00:00.000Z", expectedProductionProjectionVersion: fixture.version,
      assessment: { formatVersion: 2, criterionResults: [
        { code: "GEOMETRY", scoreBps: 9000, passed: true },
        { code: "APPEARANCE", scoreBps: 9500, passed: true },
      ] }, idempotencyKey: "criteria-evidence-0001",
    });
    await expect(production.inspect(contextA, fixture.id, { ...base, assessment: undefined })).rejects.toThrow(/逐项/);
    await expect(production.inspect(contextA, fixture.id, { ...base, assessment: { formatVersion: 2, criterionResults: base.assessment!.criterionResults.slice(1) } })).rejects.toThrow(/尚未核验/);
    await expect(production.inspect(contextA, fixture.id, { ...base, scoreBps: 10_000 })).rejects.toThrow(/总分/);
    const blocked = { ...base, assessment: { formatVersion: 2 as const, criterionResults: base.assessment!.criterionResults.map(check => ({ ...check, passed: check.code !== "GEOMETRY" })) } };
    await expect(production.inspect(contextA, fixture.id, blocked)).rejects.toThrow(/阻断/);
    await expect(production.inspect(contextA, fixture.id, { ...base, inspectedAt: "2100-01-01T00:00:00.000Z" })).rejects.toThrow(/数据库当前时间/);
    await expect(production.inspect({ ...contextA, permissions: [...contextA.permissions, "asset:read"] }, fixture.id, { ...base, assessment: { formatVersion: 2, criterionResults: base.assessment!.criterionResults.map(check => ({ ...check, evidenceAssetIds: [createEntityId()] })) } })).rejects.toThrow(/authorized assets/);
    expect((await production.get(contextA, fixture.id)).inspections).toHaveLength(0);
    const failed = await production.inspect(contextA, fixture.id, { ...blocked, result: "failed", defects: [{
      code: "GEOMETRY", severity: "major", responsibility: "supplier", disposition: "remake", note: "Synthetic explicit blocking defect", evidenceAssetIds: [],
    }] });
    expect(failed.productionOrder.status).toBe("quality_hold");
    expect(failed.inspections[0]).toMatchObject({ assessmentVersion: 2, scoreBps: 9450, result: "failed",
      productionProjectionVersion: fixture.version, criterionResults: expect.arrayContaining([expect.objectContaining({ code: "GEOMETRY", passed: false })]) });
  });

  it("criterion evidence replays one exact request, rejects altered actors and content, and keeps stale projections from overwriting", async () => {
    const fixture = await completedQualityFixture("replay"), standard = await weightedQualityStandard("replay");
    const body = await syntheticQualityInspection(production, contextA, fixture.id, RecordQualityInspectionInputSchema.parse({
      qualityStandardVersionId: standard.id, result: "passed", scoreBps: 9500, inspectedAt: "2026-07-22T13:00:00.000Z", idempotencyKey: "criterion-replay-0001",
    }));
    const results = await Promise.all([production.inspect(contextA, fixture.id, body), production.inspect(contextA, fixture.id, body)]);
    expect(results[0]!.inspections).toHaveLength(1);
    expect(results[1]!.inspections[0]!.id).toBe(results[0]!.inspections[0]!.id);
    expect(results[0]!.productionOrder.projectionVersion).toBe(fixture.version + 1);
    await expect(production.inspect(contextA, fixture.id, { ...body, scoreBps: 9400 })).rejects.toBeInstanceOf(ConflictException);
    await expect(production.inspect({ ...contextA, userId: userB }, fixture.id, body)).rejects.toBeInstanceOf(ConflictException);
    await expect(production.inspect(contextA, fixture.id, { ...body, idempotencyKey: "criterion-stale-0001" })).rejects.toBeInstanceOf(ConflictException);
    await expect(production.inspect(contextA, fixture.id, { ...body, idempotencyKey: "criterion-backdate-0001",
      expectedProductionProjectionVersion: fixture.version + 1, inspectedAt: "2026-07-22T12:59:59.000Z" })).rejects.toThrow(/早于上一份/);
    expect((await production.get(contextA, fixture.id)).inspections).toHaveLength(1);
  });

  it("criterion evidence and cancellation serialize on the same original production lock", async () => {
    const fixture = await completedQualityFixture("cancel"), standard = await weightedQualityStandard("cancel");
    const failedBody = await syntheticQualityInspection(production, contextA, fixture.id, RecordQualityInspectionInputSchema.parse({
      qualityStandardVersionId: standard.id, result: "failed", scoreBps: 5000, inspectedAt: "2026-07-22T13:00:00.000Z",
      defects: [{ code: "GEOMETRY", severity: "major", responsibility: "supplier", disposition: "remake", note: "Synthetic hold", evidenceAssetIds: [] }],
      idempotencyKey: "criterion-cancel-hold-0001",
    }));
    const held = await production.inspect(contextA, fixture.id, failedBody);
    const passedBody = await syntheticQualityInspection(production, contextA, fixture.id, RecordQualityInspectionInputSchema.parse({
      qualityStandardVersionId: standard.id, result: "passed", scoreBps: 10_000, inspectedAt: "2026-07-22T13:01:00.000Z", idempotencyKey: "criterion-cancel-pass-0001",
    }));
    const outcomes = await Promise.allSettled([
      production.recordMilestone(contextA, fixture.id, { type: "cancel_requested", expectedProjectionVersion: held.productionOrder.projectionVersion,
        externalEventId: "criterion-cancel-command-0001", occurredAt: "2026-07-22T13:01:00.000Z", evidence: { code: "SYNTHETIC_CANCEL", note: null, assetIds: [] } }),
      production.inspect(contextA, fixture.id, passedBody),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const current = await production.get(contextA, fixture.id);
    expect(current.productionOrder.projectionVersion).toBe(held.productionOrder.projectionVersion + 1);
    expect(["cancel_requested", "completed"]).toContain(current.productionOrder.status);
    expect(current.inspections).toHaveLength(current.productionOrder.status === "completed" ? 2 : 1);
  });

  it("criterion evidence rechecks current personal permissions and tenant scope before writes and replays", async () => {
    const fixture = await completedQualityFixture("rights"), standard = await weightedQualityStandard("rights");
    const body = await syntheticQualityInspection(production, contextA, fixture.id, RecordQualityInspectionInputSchema.parse({
      qualityStandardVersionId: standard.id, result: "passed", scoreBps: 9500, inspectedAt: "2026-07-22T13:00:00.000Z", idempotencyKey: "criterion-rights-0001",
    }));
    await expect(production.inspect(contextB, fixture.id, body)).rejects.toBeInstanceOf(NotFoundException);
    await expect(production.inspect({ ...contextA, permissions: ["order:read"] }, fixture.id, body)).rejects.toBeInstanceOf(ForbiddenError);
    const currentOrder = await orders.get(contextA, fixture.order.id);
    const held = await orders.changeSideState(contextA, fixture.order.id, { action: "hold", expectedSequence: currentOrder.latestEventSequence,
      idempotencyKey: "criterion-order-hold", reason: "Synthetic order pause" });
    await expect(production.inspect(contextA, fixture.id, body)).rejects.toThrow(/暂停/);
    await orders.changeSideState(contextA, fixture.order.id, { action: "release", expectedSequence: held.latestEventSequence,
      idempotencyKey: "criterion-order-resume", reason: "Synthetic pause cleared" });
    const roleId = createEntityId(), memberId = createEntityId();
    await withTenant(database.db, contextA, async tx => {
      await tx.insert(roles).values({ id: roleId, tenantId: tenantA, name: "Synthetic quality operator", permissions: contextA.permissions, dataScope: "tenant" });
      await tx.insert(memberships).values({ id: memberId, tenantId: tenantA, userId: userA, status: "active" });
      await tx.insert(membershipRoles).values({ tenantId: tenantA, membershipId: memberId, roleId });
    });
    const personal = { ...contextA, permissionScopes: { "order:read": "tenant" as const, "order:write": "tenant" as const } };
    await production.inspect(personal, fixture.id, body);
    try {
      await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: ["order:read"] }).where(eq(roles.id, roleId)));
      await expect(production.inspect(personal, fixture.id, body)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(production.inspect(personal, fixture.id, { ...body, expectedProductionProjectionVersion: fixture.version + 1, idempotencyKey: "criterion-revoked-0001" })).rejects.toBeInstanceOf(ForbiddenError);
    } finally { await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: contextA.permissions }).where(eq(roles.id, roleId))); }
    expect((await production.get(contextA, fixture.id)).inspections).toHaveLength(1);
  });

  it("criterion evidence and pinned standards remain immutable even to the database owner", async () => {
    const fixture = await completedQualityFixture("immutable"), standard = await weightedQualityStandard("immutable");
    const body = await syntheticQualityInspection(production, contextA, fixture.id, RecordQualityInspectionInputSchema.parse({
      qualityStandardVersionId: standard.id, result: "passed", scoreBps: 9500, inspectedAt: "2026-07-22T13:00:00.000Z", idempotencyKey: "criterion-immutable-0001",
    }));
    const record = await production.inspect(contextA, fixture.id, body), inspectionId = record.inspections[0]!.id;
    await expect(database.client.unsafe("update quality_inspections set score_bps=10000 where id=$1", [inspectionId])).rejects.toMatchObject({ code: "23514" });
    await expect(database.client.unsafe("delete from quality_inspections where id=$1", [inspectionId])).rejects.toMatchObject({ code: "23514" });
    await expect(database.client.unsafe("update quality_standard_versions set minimum_score_bps=0 where id=$1", [standard.id])).rejects.toMatchObject({ code: "23514" });
    await expect(withTenant(database.db, contextA, tx => tx.insert(qualityInspections).values({
      id: createEntityId(), tenantId: tenantA, productionOrderId: fixture.id, qualityStandardVersionId: standard.id,
      result: "passed", scoreBps: 10_000, inspectedAt: new Date("2026-07-22T13:00:00.000Z"),
      inspectedBy: userA, idempotencyKey: "new-legacy-row-is-forbidden",
    }))).rejects.toMatchObject({ cause: expect.objectContaining({ code: "23514" }) });
    expect((await production.get(contextA, fixture.id)).inspections[0]!.scoreBps).toBe(9500);
  });

  it("rolls production, version and audit back together and recovers the original success without another audit", async () => {
    const fixture = await productionReadyOrder("atomic-audit"), input = productionCommand(fixture, "atomic-audit");
    const [{ count: before }] = await withTenant(database.db, contextA, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from production_order_versions`));
    const actualAudit = audit.recordInTransaction.bind(audit); let failed = false;
    const recorded = vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      if (event.action === "production_order.create" && !failed) { failed = true; throw new Error("Synthetic audit checkpoint failed"); }
      return actualAudit(tx, actor, event);
    });
    try {
      await expect(production.create(contextA, fixture.order.id, input)).rejects.toThrow("Synthetic audit checkpoint failed");
      expect(await withTenant(database.db, contextA, tx => tx.select().from(productionOrders).where(eq(productionOrders.orderLineId, fixture.lineId)))).toHaveLength(0);
      const [{ count: after }] = await withTenant(database.db, contextA, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from production_order_versions`));
      expect(after).toBe(before);
      const created = await production.create(contextA, fixture.order.id, input);
      const recovered = await production.create(contextA, fixture.order.id, input);
      expect(recovered.productionOrder.id).toBe(created.productionOrder.id);
      expect(recorded.mock.calls.filter(([, , event]) => event.action === "production_order.create")).toHaveLength(2);
      expect(await withTenant(database.db, contextA, tx => tx.select().from(productionOrderVersions).where(eq(productionOrderVersions.productionOrderId, created.productionOrder.id)))).toHaveLength(1);
    } finally { recorded.mockRestore(); }
  });
  it("serializes different production command keys against the same remaining ordered quantity", async () => {
    const fixture = await productionReadyOrder("competing-quantity"), input = productionCommand(fixture, "competing-quantity");
    const attempts = await Promise.allSettled([
      production.create(contextA, fixture.order.id, input),
      production.create(contextA, fixture.order.id, { ...input, idempotencyKey: input.idempotencyKey + "-second" }),
    ]);
    expect(attempts.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(row => row.status === "rejected")).toHaveLength(1);
    expect(await withTenant(database.db, contextA, tx => tx.select().from(productionOrders).where(eq(productionOrders.orderLineId, fixture.lineId)))).toHaveLength(1);
  });
  it("does not transfer a production command to another operator or recreate it after source pause", async () => {
    const fixture = await productionReadyOrder("actor-and-pause"), input = productionCommand(fixture, "actor-and-pause");
    const created = await production.create(contextA, fixture.order.id, input);
    await expect(production.create({ ...contextA, userId: userB }, fixture.order.id, input)).rejects.toThrow("操作员");
    await orders.changeSideState(contextA, fixture.order.id, { action: "hold", expectedSequence: fixture.order.latestEventSequence,
      idempotencyKey: "production-actor-and-pause-hold", reason: "Synthetic production pause" });
    expect((await production.create(contextA, fixture.order.id, input)).productionOrder.id).toBe(created.productionOrder.id);
    await expect(production.create(contextA, fixture.order.id, { ...input, idempotencyKey: input.idempotencyKey + "-new" })).rejects.toThrow("暂停");
  });
  it("rechecks current membership write rights before a production replay or a new command", async () => {
    const fixture = await productionReadyOrder("membership-authority"), input = productionCommand(fixture, "membership-authority");
    const actor = { ...contextA, userId: createEntityId() }, memberId = createEntityId(), roleId = createEntityId();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic production member')", [actor.userId, actor.userId, `${actor.userId}@example.invalid`]);
    await withTenant(database.db, contextA, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId: tenantA, userId: actor.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: tenantA, name: "Synthetic production membership " + roleId, dataScope: "tenant", permissions: actor.permissions });
      await tx.insert(membershipRoles).values({ tenantId: tenantA, membershipId: memberId, roleId });
    });
    const current = await withTenant(database.db, actor, tx => loadCurrentMembershipContext(tx, actor));
    const created = await production.create(current, fixture.order.id, input);
    await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: ["order:read"] }).where(eq(roles.id, roleId)));
    await expect(production.create(current, fixture.order.id, input)).rejects.toThrow();
    await expect(production.create(current, fixture.order.id, { ...input, idempotencyKey: input.idempotencyKey + "-new" })).rejects.toThrow();
    await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: actor.permissions }).where(eq(roles.id, roleId)));
    expect((await production.create(current, fixture.order.id, input)).productionOrder.id).toBe(created.productionOrder.id);
  });
  function productionCommand(fixture: Awaited<ReturnType<typeof productionReadyOrder>>, suffix: string) {
    return { ...factoryFixture.pins, orderLineId: fixture.lineId, routingDecisionId: fixture.decisionId, purchaseOrderVersionId: fixture.purchaseVersionId,
      ...fixture.productionBasis, expectedCompletionAt: capacityFixture.expectedCompletionAt, instructions: "Synthetic production command " + suffix,
      idempotencyKey: "production-command-" + suffix };
  }

  async function weightedQualityStandard(suffix: string) {
    return production.createQualityStandard(contextA, { name: "Synthetic weighted " + suffix, skuId: null, supplierId, minimumScoreBps: 8000,
      criteria: [{ code: "GEOMETRY", label: "尺寸与工艺", weightBps: 1000, blocking: true }, { code: "APPEARANCE", label: "外观", weightBps: 9000, blocking: false }] });
  }
  async function completedQualityFixture(suffix: string) {
    const fixture = await productionReadyOrder("quality-" + suffix);
    const created = await production.create(contextA, fixture.order.id, { ...factoryFixture.pins, orderLineId: fixture.lineId,
      routingDecisionId: fixture.decisionId, purchaseOrderVersionId: fixture.purchaseVersionId, ...fixture.productionBasis,
      expectedCompletionAt: capacityFixture.expectedCompletionAt, instructions: "Synthetic quality acceptance fixture", idempotencyKey: "production-quality-" + suffix });
    let version = created.productionOrder.projectionVersion;
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const)
      version = (await production.recordMilestone(contextA, created.productionOrder.id, { type, expectedProjectionVersion: version,
        externalEventId: "quality-" + suffix + "-" + type, occurredAt: "2026-07-22T12:00:00.000Z", evidence: { code: type.toUpperCase(), note: null, assetIds: [] } })).productionOrder.projectionVersion;
    return { ...fixture, id: created.productionOrder.id, version };
  }

  async function productionReadyOrder(suffix: string) {
    const order = await orders.ingestNormalized(contextA, orderFixture(accountA, suffix));
    const lineId = order.lines[0]!.id;
    const productionBasis = await syntheticNativeManufacturingForLine(database, contextA, lineId);
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
    return { order: current, lineId, decisionId, purchaseVersionId, productionBasis: { designVersionId: productionBasis.designVersionId,
      productionAssetIds: productionBasis.productionAssetIds, manufacturing: productionBasis.manufacturing, productConfirmation: productionBasis.productConfirmation,
      capacityPlan: capacityFixture.capacityPlan } };
  }
});

function orderFixture(accountId: string, suffix: string): NormalizeOrderInput {
  return { accountId, platform: "etsy", externalEventId: `production-event-${suffix}`, externalOrderId: `production-order-${suffix}`, providerStatus: "paid", placedAt: "2026-07-22T10:00:00.000Z", orderTotal: { amountMinor: 2500, currency: "USD" }, lines: [{ externalLineId: `production-line-${suffix}`, externalListingId: null, skuCode: null, title: "Production product", quantity: 1, unitPrice: { amountMinor: 2500, currency: "USD" }, customizationCount: 0 }], redactedSource: { receiptId: `production-order-${suffix}` }, protectedDetails: null };
}
