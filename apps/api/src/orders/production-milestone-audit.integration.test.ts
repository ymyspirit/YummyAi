import { randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type NormalizeOrderInput, type RecordProductionMilestoneInput, type TenantContext } from "@yummyai/contracts";
import { auditEvents, connectDatabase, fulfillmentSuppliers, loadCurrentMembershipContext, orderCustomizationRequirements,
  orderRoutingDecisions, productionMilestoneEvents, productionOrders, productionOrderVersions, purchaseOrders,
  purchaseOrderVersions, routingPolicyVersions, withTenant } from "@yummyai/database";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { initialProductionAllocatedQuantity } from "./initial-production-quantity.js";
import { syntheticNativeManufacturingForLine } from "./manufacturing-production.test-fixture.js";
import { OrderProductionService } from "./order-production.service.js";
import { OrderService } from "./order.service.js";

const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
const permittedRunner = process.env.E2E_FACTORY_CAPACITY_ISOLATED === "1"
  ? process.env.E2E_LEGACY_SCHEMA_TARGET === "current"
  : process.env.E2E_FACTORY_AUTHORITY_ISOLATED === "1";
if (process.env.E2E_ISOLATED_DAILY !== "1" || !permittedRunner || !nonce ||
  !["postgres:", "postgresql:"].includes(url.protocol) || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
  throw new Error("Production milestone audit requires a matching factory-authority or current-capacity disposable runner before connecting");
requireDisposableIntegrationEnvironment();

describe.sequential("production cancellation milestone atomic audit", () => {
  const database = connectDatabase(), audit = new AuditService(database), vault = new SecretVault(Buffer.alloc(32, 119));
  const tenantId = createEntityId(), userId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId();
  const accountId = createEntityId(), supplierId = createEntityId(), policyId = createEntityId();
  const seed: TenantContext = { tenantId, userId, permissions: Object.values(Permission), dataScope: "tenant" };
  const orders = new OrderService(database, vault, audit), factories = new FactoryDirectoryService(database, audit);
  const production = new OrderProductionService(database, vault, orders, audit, undefined, factories);
  let context: TenantContext, factory: Awaited<ReturnType<typeof createSyntheticFactory>>;
  let capacity: Awaited<ReturnType<typeof createSyntheticFactoryCapacity>>;
  beforeAll(async () => {
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3)", [tenantId, `Synthetic milestone audit ${tenantId}`, `milestone-audit-${tenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic milestone operator')", [userId, `milestone-audit-${userId}`, `${userId}@example.invalid`]);
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [membershipId, tenantId, userId]);
    await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [roleId, tenantId, `Synthetic milestone role ${roleId}`, JSON.stringify(seed.permissions)]);
    await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [tenantId, membershipId, roleId]);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)", [accountId, tenantId, `Synthetic milestone account ${accountId}`, userId]);
    await withTenant(database.db, seed, async tx => {
      await tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId, name: `Synthetic milestone supplier ${supplierId}`, kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", profile: syntheticSupplierProfile, createdBy: userId });
      await tx.insert(routingPolicyVersions).values({ id: policyId, tenantId, name: `Synthetic milestone policy ${policyId}`, versionNumber: 1,
        weights: { capability: 2000, region: 1000, cost: 2000, leadTime: 2000, capacity: 1000, quality: 1500, priority: 500 },
        thresholds: { minimumQualityBps: 8000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 2000, manualApprovalCostMinor: 2000, manualApprovalRiskBps: 2000 },
        tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"], active: true, createdBy: userId });
    });
    context = await withTenant(database.db, seed, tx => loadCurrentMembershipContext(tx, seed));
    factory = await createSyntheticFactory(factories, context, supplierId, "rectangular_print", `Synthetic milestone site ${createEntityId()}`);
    capacity = await createSyntheticFactoryCapacity(database, context, { factory: factory.factory,
      bindings: [{ capabilityVersionId: factory.capability.versionId, unitsPerItem: 1 }], capacityUnits: 10 });
  });
  afterAll(async () => { vi.restoreAllMocks(); await database.client.end(); }); // The runner removes only this nonce's immutable synthetic records.

  async function readyProduction() {
    const suffix = createEntityId();
    const input: NormalizeOrderInput = { accountId, platform: "etsy", externalEventId: `milestone-event-${suffix}`,
      externalOrderId: `milestone-order-${suffix}`, providerStatus: "paid", placedAt: "2026-07-22T10:00:00.000Z",
      orderTotal: { amountMinor: 2500, currency: "USD" }, lines: [{ externalLineId: `milestone-line-${suffix}`, externalListingId: null,
        skuCode: null, title: "Synthetic rectangular milestone product", quantity: 1, unitPrice: { amountMinor: 2500, currency: "USD" }, customizationCount: 0 }],
      redactedSource: { receiptId: `milestone-order-${suffix}` }, protectedDetails: null };
    const order = await orders.ingestNormalized(context, input), lineId = order.lines[0]!.id;
    // Reuse the existing explicit rectangular metadata fixture. No image generation, upload, renderer or factory acceptance is claimed.
    const basis = await syntheticNativeManufacturingForLine(database, context, lineId, { productType: "rectangular_print" });
    const decisionId = createEntityId(), purchaseId = createEntityId(), purchaseVersionId = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(orderCustomizationRequirements).values({ id: createEntityId(), tenantId, orderId: order.id, orderLineId: lineId,
        schemaVersion: 1, schemaSnapshot: { version: 1, fields: [] }, fulfillmentPath: "template_ready", status: "approved", createdBy: userId });
      await tx.insert(orderRoutingDecisions).values({ id: decisionId, tenantId, orderId: order.id, orderLineId: lineId, routingPolicyVersionId: policyId,
        versionNumber: 1, status: "approved", selectedSupplierId: supplierId, inputChecksum: "a".repeat(64), requiresApproval: false,
        approvalReasons: [], idempotencyKey: `milestone-routing-${suffix}` });
      await tx.insert(purchaseOrders).values({ id: purchaseId, tenantId, supplierId, orderId: order.id, status: "approved", currentVersionNumber: 1, createdBy: userId });
      await tx.insert(purchaseOrderVersions).values({ id: purchaseVersionId, tenantId, purchaseOrderId: purchaseId, versionNumber: 1, currency: "USD", totalMinor: 800,
        lineSnapshot: [{ orderLineId: lineId, quantity: 1, unitCostMinor: 800 }], routingDecisionIds: [decisionId], checksum: "b".repeat(64), createdBy: userId });
    });
    let current = order;
    for (const toState of ["awaiting_customization", "awaiting_design", "awaiting_customer_approval", "awaiting_routing", "in_production"] as const)
      current = await orders.transition(context, order.id, { toState, expectedSequence: current.latestEventSequence, idempotencyKey: `${suffix}-${toState}`, reason: "Synthetic milestone fixture preparation" });
    const saved = await production.create(context, order.id, { ...factory.pins, orderLineId: lineId, routingDecisionId: decisionId, purchaseOrderVersionId: purchaseVersionId,
      designVersionId: basis.designVersionId, productionAssetIds: basis.productionAssetIds, manufacturing: basis.manufacturing,
      productConfirmation: basis.productConfirmation, expectedCompletionAt: capacity.expectedCompletionAt, capacityPlan: capacity.capacityPlan,
      instructions: "Synthetic milestone atomicity only", idempotencyKey: `milestone-production-${suffix}` });
    return { id: saved.productionOrder.id, lineId };
  }
  async function state(id: string, lineId: string) {
    return withTenant(database.db, context, async tx => {
      const records = await tx.select().from(productionOrders).where(eq(productionOrders.id, id));
      const versions = await tx.select().from(productionOrderVersions).where(eq(productionOrderVersions.productionOrderId, id)).orderBy(asc(productionOrderVersions.versionNumber));
      const events = await tx.select().from(productionMilestoneEvents).where(eq(productionMilestoneEvents.productionOrderId, id)).orderBy(asc(productionMilestoneEvents.sequence));
      const audits = await tx.select({ id: auditEvents.id, action: auditEvents.action, entityType: auditEvents.entityType, entityId: auditEvents.entityId, result: auditEvents.result })
        .from(auditEvents).where(and(eq(auditEvents.entityId, id), eq(auditEvents.action, "production_order.milestone"))).orderBy(asc(auditEvents.id));
      return { records, versions, events, audits, allocatedQuantity: await initialProductionAllocatedQuantity(tx, lineId) };
    });
  }
  it.each(["cancel_requested", "cancelled"] as const)("rolls the real %s state, event and released quantity back when its audit fails", async type => {
    const fixture = await readyProduction();
    if (type === "cancelled") await production.recordMilestone(context, fixture.id, { type: "cancel_requested", expectedProjectionVersion: 1,
      externalEventId: randomUUID(), occurredAt: new Date().toISOString(), evidence: { code: "SYNTHETIC_STOP_REQUEST", note: null, assetIds: [] } });
    const before = await state(fixture.id, fixture.lineId), input: RecordProductionMilestoneInput = { type,
      expectedProjectionVersion: before.records[0]!.projectionVersion, externalEventId: randomUUID(), occurredAt: new Date().toISOString(),
      evidence: { code: "SYNTHETIC_CONFIRMED_MILESTONE", note: null, assetIds: [] } };
    expect(before.records[0]!.status).toBe(type === "cancelled" ? "cancel_requested" : "planned");
    expect(before.allocatedQuantity).toBe(1);
    const record = audit.recordInTransaction.bind(audit), spy = vi.spyOn(audit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      if (event.action === "production_order.milestone") throw new Error("Synthetic milestone audit unavailable");
      return record(tx, actor, event);
    });
    try {
      await expect(production.recordMilestone(context, fixture.id, input)).rejects.toThrow("Synthetic milestone audit unavailable");
      expect(await state(fixture.id, fixture.lineId)).toEqual(before);
    } finally { spy.mockRestore(); }
    const saved = await production.recordMilestone(context, fixture.id, input), after = await state(fixture.id, fixture.lineId);
    expect(saved.productionOrder).toMatchObject({ id: fixture.id, status: type, projectionVersion: input.expectedProjectionVersion + 1 });
    expect(after.allocatedQuantity).toBe(type === "cancelled" ? 0 : 1);
    expect(after.events.filter(event => event.externalEventId === input.externalEventId)).toHaveLength(1);
    expect(after.audits).toHaveLength(before.audits.length + 1);
    await production.recordMilestone(context, fixture.id, input);
    const replayed = await state(fixture.id, fixture.lineId);
    expect(replayed.records).toEqual(after.records); expect(replayed.versions).toEqual(after.versions);
    expect(replayed.events).toEqual(after.events); expect(replayed.allocatedQuantity).toBe(after.allocatedQuantity);
    // Existing milestone replay may add a read/recovery audit; it must never add another business event or release quantity twice.
  });
});
