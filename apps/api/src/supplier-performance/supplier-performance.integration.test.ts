import { IncomingInspectionService } from "../procurement/incoming-inspection.service.js";
import { recordInspectedReceiptFixture } from "../procurement/incoming-inspection.fixtures.js";
import { syntheticQualityInspection } from "../../../../tools/testing/quality-fixtures.js";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type NormalizeOrderInput, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  fulfillmentSuppliers,
  inventoryPurchaseOrders,
  memberships,
  membershipRoles,
  roles,
  migrateDatabase,
  orderCustomizationRequirements,
  orderRoutingDecisions,
  purchaseOrders,
  purchaseOrderVersions,
  routingPolicyVersions,
  supplierCapacityWindows,
  supplierKpiDefinitionVersions,
  supplierScorecardMetrics,
  supplierScorecardRuns,
  withTenant,
} from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { OrderProductionService } from "../orders/order-production.service.js";
import { syntheticNativeManufacturingForLine } from "../orders/manufacturing-production.test-fixture.js";
import { OrderService } from "../orders/order.service.js";
import { ProcurementService } from "../procurement/procurement.service.js";
import { SupplierPerformanceService } from "./supplier-performance.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";

describe.sequential("supplier performance", () => {
  // Records are created now; the historical event fixtures must share a window with their actual recording time.
  const fixtureWindowEnd = new Date(Date.now() + 86_400_000).toISOString();
  const fixtureCutoff = new Date(Date.now() + 86_460_000).toISOString();
  const database = connectDatabase();
  const tenantA = createEntityId();
  const tenantB = createEntityId();
  const userA = createEntityId();
  const userB = createEntityId();
  const accountA = createEntityId();
  const supplierId = createEntityId();
  const routingPolicyId = createEntityId();
  const contextA = tenantContext(tenantA, userA);
  const contextB = tenantContext(tenantB, userB);
  const audit = new AuditService(database);
  const inventory = new InventoryService(database, audit);
  const procurement = new ProcurementService(database, inventory, audit);
  const orders = new OrderService(database, new SecretVault(Buffer.alloc(32, 71)), audit);
  const factories = new FactoryDirectoryService(database, audit);
  let factoryFixture: Awaited<ReturnType<typeof createSyntheticFactory>>;
  let capacityFixture: Awaited<ReturnType<typeof createSyntheticFactoryCapacity>>;
  const production = new OrderProductionService(
    database,
    new SecretVault(Buffer.alloc(32, 73)),
    orders,
    audit,
    undefined,
    factories,
  );
  const service = new SupplierPerformanceService(database, audit);

  let stockItemId: string;
  let locationId: string;
  let scorecardId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      "insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)",
      [
        tenantA, "Supplier Performance A", `supplier-performance-a-${tenantA}`,
        tenantB, "Supplier Performance B", `supplier-performance-b-${tenantB}`,
      ],
    );
    await database.client.unsafe(
      "insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)",
      [
        userA, `supplier-performance-a-${userA}`, `supplier-a-${userA}@example.test`, "Supplier A",
        userB, `supplier-performance-b-${userB}`, `supplier-b-${userB}@example.test`, "Supplier B",
      ],
    );
    for (const context of [contextA, contextB]) await withTenant(database.db, context, async tx => {
      const member = createEntityId(), role = createEntityId();
      await tx.insert(memberships).values({ id: member, tenantId: context.tenantId, userId: context.userId, status: "active" });
      await tx.insert(roles).values({ id: role, tenantId: context.tenantId, name: `Synthetic scorecard ${role}`, permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId: member, roleId: role });
    });
    await database.client.unsafe(
      `insert into marketplace_accounts
       (id,tenant_id,platform,display_name,region,authorization_mode,created_by)
       values ($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)`,
      [accountA, tenantA, "Supplier Performance Shop", userA],
    );
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(fulfillmentSuppliers).values({
        id: supplierId,
        tenantId: tenantA,
        name: "Evidence Supplier",
        profile: syntheticSupplierProfile,
        kind: "manual",
        status: "active",
        regionCode: "US",
        settlementCurrency: "USD",
        priority: 2,
        createdBy: userA,
      });
      await tx.insert(routingPolicyVersions).values({
        id: routingPolicyId,
        tenantId: tenantA,
        name: "Supplier performance fixture",
        versionNumber: 1,
        weights: {
          capability: 2_000,
          region: 1_000,
          cost: 2_000,
          leadTime: 2_000,
          capacity: 1_000,
          quality: 1_500,
          priority: 500,
        },
        thresholds: {
          minimumQualityBps: 8_000,
          maximumLeadTimeDays: 10,
          maximumUnitCostMinor: 2_000,
          manualApprovalCostMinor: 2_000,
          manualApprovalRiskBps: 2_000,
        },
        tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"],
        active: true,
        createdBy: userA,
      });
      await tx.insert(supplierCapacityWindows).values({
        id: createEntityId(),
        tenantId: tenantA,
        supplierId,
        windowKey: "2026-Q3",
        versionNumber: 1,
        startsAt: new Date("2026-07-01T00:00:00.000Z"),
        endsAt: new Date(fixtureWindowEnd),
        availableUnits: 100,
        reservedUnits: 1,
        sourceVersion: "fixture-capacity-v1",
      });
    });

    const warehouse = await inventory.createWarehouse(contextA, {
      code: "SUPPLIER-KPI",
      name: "Supplier KPI warehouse",
      type: "owned",
      countryCode: "US",
      timeZone: "America/Los_Angeles",
    });
    locationId = (await inventory.createLocation(contextA, {
      warehouseId: warehouse.id,
      code: "RECEIVE",
      name: "Supplier KPI receiving",
    })).id;
    factoryFixture = await createSyntheticFactory(factories, contextA, supplierId, "rectangular_print");
    capacityFixture = await createSyntheticFactoryCapacity(database, contextA, { factory: factoryFixture.factory,
      bindings: [{ capabilityVersionId: factoryFixture.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10 });
    stockItemId = (await inventory.createStockItem(contextA, {
      skuId: null,
      code: "SUPPLIER-KPI-BLANK",
      name: "Supplier KPI blank",
      baseUnit: "each",
    })).id;
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("reproduces all seven KPIs from pinned P2/P3 evidence", async () => {
    await seedProductionEvidence();
    await seedProcurementEvidence();

    const definition = await service.upsertDefinition(contextA, {
      definitionId: null,
      name: "Balanced supplier performance",
      missingDataPolicy: "incomplete",
      metrics: [
        metric("quality", 2_000),
        metric("on_time_delivery", 1_500),
        metric("price_variance", 1_500),
        metric("response_time", 1_000, 24),
        metric("acceptance", 1_500),
        metric("cancellation", 1_000),
        metric("capacity_adherence", 1_500),
      ],
      reasonCode: "P3_BASELINE",
      idempotencyKey: "supplier-kpi-definition-0001",
    });
    const input = {
      definitionId: definition.id,
      expectedDefinitionVersion: 1,
      supplierId,
      windowStart: "2026-07-01T00:00:00.000Z",
      windowEnd: fixtureWindowEnd,
      evidenceCutoffAt: fixtureCutoff,
      idempotencyKey: "supplier-scorecard-run-0001",
    };
    const scorecard = await service.calculateScorecard(contextA, input);
    scorecardId = scorecard.id;

    expect(scorecard).toMatchObject({
      status: "complete",
      overallScoreBps: 9_900,
      diagnostics: { missingMetrics: [], insufficientSampleMetrics: [] },
    });
    expect(Object.fromEntries(scorecard.metrics.map((entry) => [entry.metric, entry.scoreBps])))
      .toEqual({
        acceptance: 10_000,
        cancellation: 10_000,
        capacity_adherence: 10_000,
        on_time_delivery: 10_000,
        price_variance: 10_000,
        quality: 9_500,
        response_time: 10_000,
      });
    expect(scorecard.metrics.every((entry) => entry.evidenceReferences.length > 0)).toBe(true);
    expect((await service.calculateScorecard(contextA, input)).id).toBe(scorecard.id);
    await expect(service.calculateScorecard(contextA, {
      ...input,
      windowStart: "2026-07-02T00:00:00.000Z",
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it("isolates tenants and keeps scorecard evidence append-only", async () => {
    await expect(service.getScorecard(contextB, scorecardId)).rejects.toBeInstanceOf(NotFoundException);
    expect(await withTenant(database.db, contextB, (tx) => tx.select().from(supplierScorecardRuns)))
      .toHaveLength(0);
    await expect(service.calculateScorecard(contextB, {
      definitionId: (await service.workspace(contextA)).definitions[0]!.id,
      expectedDefinitionVersion: 1,
      supplierId,
      windowStart: "2026-07-01T00:00:00.000Z",
      windowEnd: fixtureWindowEnd,
      evidenceCutoffAt: fixtureCutoff,
      idempotencyKey: "supplier-scorecard-cross-tenant",
    })).rejects.toBeInstanceOf(NotFoundException);

    const privileges = await withTenant(database.db, contextA, async (tx) => {
      const result = await tx.execute(sql`
        select
          has_table_privilege(current_user, 'supplier_kpi_definitions', 'UPDATE') as definition_update,
          has_table_privilege(current_user, 'supplier_kpi_definition_versions', 'UPDATE') as version_update,
          has_table_privilege(current_user, 'supplier_scorecard_runs', 'DELETE') as run_delete,
          has_table_privilege(current_user, 'supplier_scorecard_metrics', 'UPDATE') as metric_update
      `);
      return result[0] as Record<string, boolean>;
    });
    expect(privileges).toEqual({
      definition_update: true,
      version_update: false,
      run_delete: false,
      metric_update: false,
    });
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(supplierScorecardMetrics).set({ scoreBps: 0 }),
    )).rejects.toThrow();
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(supplierKpiDefinitionVersions).set({ reasonCode: "MUTATED" }),
    )).rejects.toThrow();
  });

  async function seedProductionEvidence() {
    const order = await orders.ingestNormalized(contextA, orderFixture(accountA));
    const lineId = order.lines[0]!.id;
    const decisionId = createEntityId();
    const purchaseOrderId = createEntityId();
    const purchaseVersionId = createEntityId();
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(orderCustomizationRequirements).values({
        id: createEntityId(),
        tenantId: tenantA,
        orderId: order.id,
        orderLineId: lineId,
        schemaVersion: 1,
        schemaSnapshot: { version: 1, fields: [] },
        fulfillmentPath: "template_ready",
        status: "approved",
        createdBy: userA,
      });
      await tx.insert(orderRoutingDecisions).values({
        id: decisionId,
        tenantId: tenantA,
        orderId: order.id,
        orderLineId: lineId,
        routingPolicyVersionId: routingPolicyId,
        versionNumber: 1,
        status: "approved",
        selectedSupplierId: supplierId,
        inputChecksum: "a".repeat(64),
        requiresApproval: false,
        approvalReasons: [],
        idempotencyKey: "supplier-performance-routing",
      });
      await tx.insert(purchaseOrders).values({
        id: purchaseOrderId,
        tenantId: tenantA,
        supplierId,
        orderId: order.id,
        status: "approved",
        currentVersionNumber: 1,
        createdBy: userA,
      });
      await tx.insert(purchaseOrderVersions).values({
        id: purchaseVersionId,
        tenantId: tenantA,
        purchaseOrderId,
        versionNumber: 1,
        currency: "USD",
        totalMinor: 800,
        lineSnapshot: [{ orderLineId: lineId, quantity: 1, unitCostMinor: 800 }],
        routingDecisionIds: [decisionId],
        checksum: "b".repeat(64),
        createdBy: userA,
      });
    });
    let current = order;
    for (const state of [
      "awaiting_customization",
      "awaiting_design",
      "awaiting_customer_approval",
      "awaiting_routing",
      "in_production",
    ] as const) {
      current = await orders.transition(contextA, order.id, {
        toState: state,
        expectedSequence: current.latestEventSequence,
        idempotencyKey: `supplier-performance-${state}`,
        reason: "Supplier scorecard fixture",
      });
    }
    const basis = await syntheticNativeManufacturingForLine(database, contextA, lineId);
    const created = await production.create(contextA, current.id, {
      ...factoryFixture.pins,
      orderLineId: lineId,
      routingDecisionId: decisionId,
      purchaseOrderVersionId: purchaseVersionId,
      designVersionId: basis.designVersionId,
      productionAssetIds: basis.productionAssetIds,
      manufacturing: basis.manufacturing,
      productConfirmation: basis.productConfirmation,
      expectedCompletionAt: capacityFixture.expectedCompletionAt,
      capacityPlan: capacityFixture.capacityPlan,
      instructions: "Supplier performance fixture",
      idempotencyKey: "supplier-performance-production",
    });
    let projectionVersion = 1;
    for (const [type, occurredAt] of [
      ["submitted", "2026-07-23T10:00:00.000Z"],
      ["acknowledged", "2026-07-23T11:00:00.000Z"],
      ["started", "2026-07-23T12:00:00.000Z"],
      ["completed", "2026-07-23T14:00:00.000Z"],
    ] as const) {
      projectionVersion = (await production.recordMilestone(contextA, created.productionOrder.id, {
        type,
        expectedProjectionVersion: projectionVersion,
        externalEventId: `supplier-performance-${type}`,
        occurredAt,
        evidence: { code: type.toUpperCase(), note: null, assetIds: [] },
      })).productionOrder.projectionVersion;
    }
    const standard = await production.createQualityStandard(contextA, {
      name: "Supplier performance quality",
      skuId: null,
      supplierId,
      minimumScoreBps: 9_000,
      criteria: [{ code: "OUTPUT", label: "Output quality", weightBps: 10_000, blocking: true }],
    });
    await production.inspect(contextA, created.productionOrder.id, await syntheticQualityInspection(production, contextA, created.productionOrder.id, {
      qualityStandardVersionId: standard.id,
      result: "passed",
      scoreBps: 9_500,
      inspectedAt: "2026-07-23T15:00:00.000Z",
      evidenceAssetIds: [],
      defects: [],
      idempotencyKey: "supplier-performance-inspection",
    }));
  }

  async function seedProcurementEvidence() {
    const [clock] = await withTenant(database.db, contextA, tx => tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`));
    const now = new Date(clock!.now).getTime();
    const requisition = await procurement.createRequisition(contextA, {
      code: "SUPPLIER-KPI-REQ",
      reasonCode: "REORDER_POINT",
      lines: [requestLine(10)],
      idempotencyKey: "supplier-performance-requisition",
    });
    const rfq = await procurement.createRfq(contextA, requisition.id, {
      expectedRequisitionVersion: 1,
      supplierIds: [supplierId],
      responseDueAt: new Date(now + 86_400_000).toISOString(),
      idempotencyKey: "supplier-performance-rfq",
    });
    const quote = await procurement.recordSupplierQuote(contextA, rfq.id, {
      supplierId,
      currency: "USD",
      validUntil: new Date(now + 20 * 86_400_000).toISOString(),
      lines: [{ lineKey: "LINE-1", unitCostMinor: 425, minimumOrderQuantity: 5, leadTimeDays: 7 }],
      idempotencyKey: "supplier-performance-quote",
    });
    const order = await procurement.createPurchaseOrder(contextA, {
      code: "SUPPLIER-KPI-PO",
      supplierId,
      requisitionId: requisition.id,
      quoteId: quote.id,
      currency: "USD",
      expectedAt: "2026-08-10T00:00:00.000Z",
      lines: [{ ...requestLine(10), unitCostMinor: 425 }],
      idempotencyKey: "supplier-performance-order",
    });
    await procurement.reviewPurchaseOrder(contextA, order.id, {
      expectedVersion: 1,
      decision: "approved",
      reasonCode: "BUDGET_APPROVED",
      idempotencyKey: "supplier-performance-order-review",
    });
    await recordInspectedReceiptFixture(procurement, new IncomingInspectionService(database, procurement, audit), contextA, order.id, {
      expectedVersion: 1,
      receivedAt: "2026-08-09T12:00:00.000Z",
      externalReference: "SUPPLIER-KPI-ASN",
      lines: [{
        lineKey: "LINE-1",
        receivedQuantity: 10,
        rejectedQuantity: 0,
        rejectionReasonCode: null,
        lotCode: "SUPPLIER-KPI-LOT",
        expiresAt: null,
      }],
      idempotencyKey: "supplier-performance-receipt",
    });
    await procurement.recordInvoice(contextA, order.id, {
      invoiceNumber: "SUPPLIER-KPI-INVOICE",
      currency: "USD",
      issuedAt: "2026-08-09T14:00:00.000Z",
      lines: [{ lineKey: "LINE-1", invoicedQuantity: 10, unitCostMinor: 425 }],
      idempotencyKey: "supplier-performance-invoice",
    });
    expect(await withTenant(database.db, contextA, (tx) =>
      tx.select().from(inventoryPurchaseOrders).where(eq(inventoryPurchaseOrders.id, order.id)),
    )).toEqual([expect.objectContaining({ status: "received" })]);
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
});

function metric(
  metricName:
    | "quality"
    | "on_time_delivery"
    | "price_variance"
    | "response_time"
    | "acceptance"
    | "cancellation"
    | "capacity_adherence",
  weightBps: number,
  responseTargetHours: number | null = null,
) {
  return { metric: metricName, weightBps, minimumSampleCount: 1, responseTargetHours };
}

function orderFixture(accountId: string): NormalizeOrderInput {
  return {
    accountId,
    platform: "etsy",
    externalEventId: "supplier-performance-event",
    externalOrderId: "supplier-performance-order",
    providerStatus: "paid",
    placedAt: "2026-07-23T09:00:00.000Z",
    orderTotal: { amountMinor: 2_500, currency: "USD" },
    lines: [{
      externalLineId: "supplier-performance-line",
      externalListingId: null,
      skuCode: null,
      title: "Supplier performance product",
      quantity: 1,
      unitPrice: { amountMinor: 2_500, currency: "USD" },
      customizationCount: 0,
    }],
    redactedSource: { receiptId: "supplier-performance-order" },
    protectedDetails: null,
  };
}

function tenantContext(tenantId: string, userId: string): TenantContext {
  return {
    tenantId,
    userId,
    permissions: [
      "inventory:read",
      "inventory:write",
      "procurement:read",
      "procurement:write",
      "procurement:approve",
      "order:read",
      "order:write",
      Permission.ProductRead,
      Permission.DesignRead,
      Permission.AssetRead,
      "supplier_performance:read",
      "supplier_performance:review",
    ],
    dataScope: "tenant",
  };
}
