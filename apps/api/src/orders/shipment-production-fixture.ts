import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createEntityId, RecordQualityInspectionInputSchema, type TenantContext } from "@yummyai/contracts";
import { SecretVault } from "@yummyai/ai-core";
import { fulfillmentSuppliers, productionOrders, productionOrderVersions, qualityInspections, qualityStandardVersions, routingPolicyVersions, orderRoutingDecisions, purchaseOrders, purchaseOrderVersions, withTenant, type DatabaseConnection } from "@yummyai/database";
import { syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { syntheticNativeManufacturingForLine } from "./manufacturing-production.test-fixture.js";
import { sealProductionManufacturing } from "./production-manufacturing.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { reserveFactoryCapacityInTransaction } from "../suppliers/factory-capacity.service.js";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { syntheticQualityInspection } from "../../../../tools/testing/quality-fixtures.js";
import { Permission } from "@yummyai/authz";
import type { ProductionManufacturingSelection } from "@yummyai/contracts/order/production-manufacturing";
import { sql } from "drizzle-orm";

/** Stock-history fixture for shipment tests; no physical production or factory acceptance is asserted. */
export async function syntheticPassedProduction(database: DatabaseConnection, context: TenantContext, orderId: string, lines: Array<{ id: string; quantity: number }>, factories?: FactoryDirectoryService,
  work?: { vault: SecretVault; workSources: ReadonlyMap<string, { revisionId: string; manufacturing?: ProductionManufacturingSelection }> }) {
  if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname.slice(1)))
    throw new Error("Synthetic shipment production requires the disposable runner");
  const supplierId = createEntityId(), standardId = createEntityId();
  const seed = await withTenant(database.db, context, async tx => {
    await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: context.tenantId, name: `Synthetic stock ${supplierId}`, kind: "manual", status: "active",
      regionCode: "US", settlementCurrency: "USD", priority: 1, profile: syntheticSupplierProfile, createdBy: context.userId });
    await tx.insert(qualityStandardVersions).values({ id: standardId, tenantId: context.tenantId, name: `Synthetic stock quality ${standardId}`, versionNumber: 1,
      minimumScoreBps: 9000, criteria: [{ code: "STOCK", label: "Synthetic complete stock inspection", weightBps: 10000, blocking: true }], createdBy: context.userId });
    const policyId = createEntityId(), purchaseId = createEntityId(), purchaseVersionId = createEntityId(), decisions = new Map<string, string>();
    await tx.insert(routingPolicyVersions).values({ id: policyId, tenantId: context.tenantId, name: `Synthetic stock routing ${policyId}`, versionNumber: 1,
      weights: { capability: 2000, region: 1000, cost: 2000, leadTime: 2000, capacity: 1000, quality: 1500, priority: 500 },
      thresholds: { minimumQualityBps: 8000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 2000, manualApprovalCostMinor: 2000, manualApprovalRiskBps: 2000 },
      tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"], active: true, createdBy: context.userId });
    for (const lineId of new Set(lines.map(line => line.id))) {
      const decisionId = createEntityId(); decisions.set(lineId, decisionId);
      await tx.insert(orderRoutingDecisions).values({ id: decisionId, tenantId: context.tenantId, orderId, orderLineId: lineId, routingPolicyVersionId: policyId,
        versionNumber: 1, status: "approved", selectedSupplierId: supplierId, inputChecksum: "a".repeat(64), requiresApproval: false, approvalReasons: [], idempotencyKey: `synthetic-stock-routing-${decisionId}` });
    }
    await tx.insert(purchaseOrders).values({ id: purchaseId, tenantId: context.tenantId, supplierId, orderId, status: "approved", currentVersionNumber: 1, createdBy: context.userId });
    await tx.insert(purchaseOrderVersions).values({ id: purchaseVersionId, tenantId: context.tenantId, purchaseOrderId: purchaseId, versionNumber: 1, currency: "USD", totalMinor: lines.reduce((sum, line) => sum + line.quantity * 800, 0),
      lineSnapshot: [...decisions.keys()].map(orderLineId => ({ orderLineId, quantity: lines.filter(line => line.id === orderLineId).reduce((sum, line) => sum + line.quantity, 0), unitCostMinor: 800 })),
      routingDecisionIds: [...decisions.values()], checksum: "b".repeat(64), createdBy: context.userId });
    return { decisions, purchaseVersionId };
  });
  const { decisions, purchaseVersionId } = seed;
  const [capacitySchema] = await withTenant(database.db, context, tx => tx.execute(sql`select to_regclass('factory_capacity_reservations') is not null as modern`));
  const capacityModern = capacitySchema?.modern === true, audit = new AuditService(database), vault = work?.vault ?? new SecretVault(Buffer.alloc(32, 62));
  const directory = factories ?? (capacityModern ? new FactoryDirectoryService(database, audit) : undefined);
  const factory = directory ? await createSyntheticFactory(directory, context, supplierId, "rectangular_print") : null;
  // The real pre-migration runners deliberately have neither the new catalog
  // tables nor this binding. Keep their historical evidence genuinely absent.
  const [schema] = await withTenant(database.db, context, tx => tx.execute(sql`select to_regclass('production_manufacturing_bindings') is not null as modern`));
  const modern = schema?.modern === true;
  const manufacturing = new Map<string, Awaited<ReturnType<typeof syntheticNativeManufacturingForLine>>>();
  if (modern) for (const lineId of new Set(lines.map(line => line.id))) {
    if (!work?.workSources.has(lineId)) manufacturing.set(lineId, await syntheticNativeManufacturingForLine(database, context, lineId));
  }
  const seedContext: TenantContext = { tenantId: context.tenantId, userId: context.userId, dataScope: "tenant", permissions: Object.values(Permission) };
  if (capacityModern) {
    if (!factory || !directory) throw new Error("Modern stock setup requires its explicit synthetic factory");
    const capacity = await createSyntheticFactoryCapacity(database, seedContext, { factory: factory.factory,
      bindings: [{ capabilityVersionId: factory.capability.versionId, unitsPerItem: 1 }], capacityUnits: Math.max(10, lines.reduce((sum, line) => sum + line.quantity, 0) * 4) });
    const production = new OrderProductionService(database, vault, new OrderService(database, vault, audit), audit, undefined, directory), results = [];
    for (const line of lines) {
      const id = createEntityId(), versionId = createEntityId(), basis = manufacturing.get(line.id), workSource = work?.workSources.get(line.id);
      // Explicit stock fixture admission, not the external create/release route:
      // only planned source metadata is seeded; real owners seal manufacturing,
      // reserve, commit, complete and inspect. No completed state/QC row is fabricated.
      await withTenant(database.db, seedContext, async tx => {
        await tx.insert(productionOrders).values({ id, tenantId: context.tenantId, orderId, orderLineId: line.id, supplierId,
          ...(workSource ? { sourceWorkItemId: line.id } : {}), routingDecisionId: decisions.get(line.id)!, purchaseOrderVersionId: purchaseVersionId,
          factoryId: factory.factory.id, status: "planned", expectedCompletionAt: new Date(capacity.expectedCompletionAt),
          idempotencyKey: `synthetic-stock-${id}`, createdBy: context.userId });
        await tx.insert(productionOrderVersions).values({ id: versionId, tenantId: context.tenantId, productionOrderId: id, versionNumber: 1,
          quantity: line.quantity, designVersionId: basis?.designVersionId ?? null, productionAssetIds: basis?.productionAssetIds ?? [],
          ...(workSource ? { sourceWorkRevisionId: workSource.revisionId } : {}), ...factory.pins,
          encryptedInstructions: vault.encrypt("Explicit synthetic stock fixture admission; no supplier contact"), instructionsChecksum: "c".repeat(64),
          expectedCompletionAt: new Date(capacity.expectedCompletionAt), createdBy: context.userId });
        if (workSource) await sealProductionManufacturing(tx, seedContext, vault, versionId, workSource.manufacturing, { kind: "order_work_revision" });
        else await sealProductionManufacturing(tx, seedContext, vault, versionId, basis!.manufacturing, { kind: "approved_product_confirmation", confirmation: basis!.productConfirmation });
        await reserveFactoryCapacityInTransaction(tx, seedContext, audit, { productionOrderId: id, productionVersionId: versionId, capacityPlan: capacity.capacityPlan });
      });
      let record = await production.get(seedContext, id);
      for (const type of ["submitted", "acknowledged", "started", "completed"] as const) record = await production.recordMilestone(seedContext, id, {
        type, expectedProjectionVersion: record.productionOrder.projectionVersion, externalEventId: `synthetic-stock-${id}-${type}`, occurredAt: capacity.now,
        evidence: { code: "SYNTHETIC_STOCK_OWNER_EVENT", note: null, assetIds: [] } });
      const inspected = await production.inspect(seedContext, id, await syntheticQualityInspection(production, seedContext, id, RecordQualityInspectionInputSchema.parse({
        qualityStandardVersionId: standardId, result: "passed", scoreBps: 10_000, inspectedAt: capacity.now, evidenceAssetIds: [], defects: [], idempotencyKey: `synthetic-stock-quality-${id}` })));
      results.push({ productionOrderId: id, productionVersionId: versionId, qualityInspectionId: inspected.inspections[0]!.id,
        expectedProductionProjectionVersion: inspected.productionOrder.projectionVersion, quantity: line.quantity, orderLineId: line.id, standardId,
        manufacturing: workSource?.manufacturing ?? basis?.manufacturing, capacityPlan: capacity.capacityPlan, expectedCompletionAt: capacity.expectedCompletionAt });
    }
    return results;
  }
  // Genuine pre-capacity schema keeps its historical absent ledger. This branch
  // remains only for dedicated old-schema upgrade fixtures, never current writes.
  return withTenant(database.db, context, async tx => {
    const results = [];
    for (const line of lines) {
      const id = createEntityId(), versionId = createEntityId(), inspectionId = createEntityId();
      const basis = manufacturing.get(line.id), workSource = work?.workSources.get(line.id);
      await tx.insert(productionOrders).values({ id, tenantId: context.tenantId, orderId, orderLineId: line.id, supplierId,
        ...(workSource ? { sourceWorkItemId: line.id } : {}),
        routingDecisionId: decisions.get(line.id)!, purchaseOrderVersionId: purchaseVersionId, factoryId: factory?.pins.factoryId,
        status: "completed", projectionVersion: 5, expectedCompletionAt: new Date("2026-07-23T00:00:00Z"), idempotencyKey: `synthetic-stock-${id}`, createdBy: context.userId });
      await tx.insert(productionOrderVersions).values({ id: versionId, tenantId: context.tenantId, productionOrderId: id, versionNumber: 1, quantity: line.quantity,
        designVersionId: basis?.designVersionId ?? null, productionAssetIds: basis?.productionAssetIds ?? [],
        ...(workSource ? { sourceWorkRevisionId: workSource.revisionId } : {}),
        factoryId: factory?.pins.factoryId, factoryVersionId: factory?.pins.factoryVersionId, capabilityVersionId: factory?.pins.capabilityVersionId,
        encryptedInstructions: new SecretVault(Buffer.alloc(32, 62)).encrypt("Explicit synthetic stock instructions"), instructionsChecksum: "c".repeat(64), expectedCompletionAt: new Date("2026-07-23T00:00:00Z"), createdBy: context.userId });
      if (modern) {
        if (workSource) await sealProductionManufacturing(tx, seedContext, work!.vault, versionId, workSource.manufacturing, { kind: "order_work_revision" });
        else await sealProductionManufacturing(tx, seedContext, new SecretVault(Buffer.alloc(32, 62)), versionId, basis!.manufacturing, { kind: "approved_product_confirmation", confirmation: basis!.productConfirmation });
      }
      await tx.insert(qualityInspections).values({ id: inspectionId, tenantId: context.tenantId, productionOrderId: id, qualityStandardVersionId: standardId,
        result: "passed", scoreBps: 10000, evidenceAssetIds: [], idempotencyKey: `synthetic-stock-quality-${id}`, inspectedBy: context.userId, inspectedAt: new Date("2026-07-23T00:00:00Z"),
        assessmentVersion: 2, criterionResults: [{ code: "STOCK", passed: true, scoreBps: 10000, evidenceAssetIds: [] }], requestChecksum: "e".repeat(64), productionVersionId: versionId, productionProjectionVersion: 4 });
      results.push({ productionOrderId: id, productionVersionId: versionId, qualityInspectionId: inspectionId, expectedProductionProjectionVersion: 5, quantity: line.quantity, orderLineId: line.id, standardId, manufacturing: workSource?.manufacturing ?? basis?.manufacturing,
        capacityPlan: undefined, expectedCompletionAt: "2026-07-23T00:00:00.000Z" });
    }
    return results;
  });
}
