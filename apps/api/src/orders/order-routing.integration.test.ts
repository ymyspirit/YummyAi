import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type CreateRoutingPolicyInput, type NormalizeOrderInput, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase, listingVersions, listings, orderCustomizationRequirements, orderExceptions,
  orderRoutingDecisionEvents, orderRoutingDecisions, orders as orderRows, productPlans, purchaseOrderVersions,
  purchaseOrders, routingPolicyVersions, skus, spus, withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { OrderRoutingService } from "./order-routing.service.js";
import { OrderService } from "./order.service.js";

describe("supplier sourcing and routing", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId(); const accountA = createEntityId();
  const planId = createEntityId(); const spuId = createEntityId(); const skuId = createEntityId();
  const listingId = createEntityId(); const listingVersionId = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  let orderService: OrderService;
  let routing: OrderRoutingService;
  let primarySupplierId: string;
  let secondarySupplierId: string;
  let policyId: string;

  beforeAll(async () => {
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "Routing A", `routing-a-${tenantA}`, tenantB, "Routing B", `routing-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `routing-a-${userA}`, `a-${userA}@example.test`, "A", userB, `routing-b-${userB}`, `b-${userB}@example.test`, "B"]);
    await database.client.unsafe("insert into marketplace_accounts (id,tenant_id,platform,display_name,region,authorization_mode,created_by) values ($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)", [accountA, tenantA, "Routing Shop", userA]);
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(productPlans).values({ id: planId, tenantId: tenantA, name: "Routed product", status: "approved", customization: { version: 1, fields: [] }, createdBy: userA });
      await tx.insert(spus).values({ id: spuId, tenantId: tenantA, productPlanId: planId, code: "ROUTED", name: "Routed product", status: "ready", customization: { version: 1, fields: [] } });
      await tx.insert(skus).values({ id: skuId, tenantId: tenantA, spuId, code: "ROUTED-SKU", status: "active" });
      await tx.insert(listings).values({ id: listingId, tenantId: tenantA, spuId, platform: "etsy", marketplaceId: "etsy", locale: "en-US", status: "approved", primaryVersionId: listingVersionId, createdBy: userA });
      await tx.insert(listingVersions).values({
        id: listingVersionId, tenantId: tenantA, listingId, versionNumber: 1, ruleVersion: "etsy-2026.07", status: "approved", source: "human", createdBy: userA, approvedBy: userA, approvedAt: new Date(),
        content: { platform: "etsy", locale: "en-US", title: "Routed product", description: "Routed", bullets: [], tags: ["routed"], mainImageId: "asset-main", mediaAssetIds: ["asset-main"], variants: [{ skuId, skuCode: "ROUTED-SKU", optionValues: {} }], attributes: {}, compliance: {} },
        validation: { completeness: 100, blockers: [], warnings: [] },
      });
    });
    const audit = new AuditService(database);
    orderService = new OrderService(database, new SecretVault(Buffer.alloc(32, 43)), audit);
    routing = new OrderRoutingService(database, orderService, audit);
    const primary = await routing.createSupplier(contextA, { name: "Primary", kind: "manual", regionCode: "US", settlementCurrency: "USD", externalConnectionRef: null });
    const secondary = await routing.createSupplier(contextA, { name: "Secondary", kind: "printful", regionCode: "US", settlementCurrency: "USD", externalConnectionRef: "printful-test" });
    primarySupplierId = primary.id; secondarySupplierId = secondary.id;
    await addSupplierEvidence(primarySupplierId, 850, 4, 9500);
    await addSupplierEvidence(secondarySupplierId, 900, 3, 9700);
    policyId = (await routing.createPolicy(contextA, policy(2_000))).id;
  });

  afterAll(async () => { await database.client.end(); });

  it("routes deterministically, replays idempotently, creates a pinned purchase order, and opens production", async () => {
    const order = await readyOrder("auto");
    const input = routeInput(order.lines[0]!.id, policyId, "route-auto-0001");
    const first = await routing.route(contextA, order.id, input);
    const replay = await routing.route(contextA, order.id, input);
    expect(replay.decision.id).toBe(first.decision.id);
    expect(first.decision).toMatchObject({ status: "approved", selectedSupplierId: secondarySupplierId, decisionVersion: 1 });
    expect(first.candidates.map((entry) => entry.rank)).toEqual([1, 2]);
    expect((await withTenant(database.db, contextA, (tx) => tx.select().from(orderRoutingDecisions).where(eq(orderRoutingDecisions.orderLineId, order.lines[0]!.id))))).toHaveLength(1);
    const purchase = await withTenant(database.db, contextA, (tx) => tx.select().from(purchaseOrders).where(eq(purchaseOrders.orderId, order.id)));
    expect(purchase).toHaveLength(1);
    expect(await withTenant(database.db, contextA, (tx) => tx.select().from(purchaseOrderVersions).where(eq(purchaseOrderVersions.purchaseOrderId, purchase[0]!.id)))).toHaveLength(1);
    const current = await orderService.get(contextA, order.id);
    const production = await orderService.transition(contextA, order.id, { toState: "in_production", expectedSequence: current.latestEventSequence, idempotencyKey: "production-route-auto", reason: "Routing and purchase approved" });
    expect(production.workflowState).toBe("in_production");
  });

  it("requires review for thresholds and records every manual override with actor and reason", async () => {
    const order = await readyOrder("review");
    const reviewPolicy = await routing.createPolicy(contextA, policy(1));
    const evaluated = await routing.route(contextA, order.id, routeInput(order.lines[0]!.id, reviewPolicy.id, "route-review-0001"));
    expect(evaluated.decision.status).toBe("pending_approval");
    await expect(orderService.transition(contextA, order.id, { toState: "in_production", expectedSequence: (await orderService.get(contextA, order.id)).latestEventSequence, idempotencyKey: "production-before-review", reason: "Too early" })).rejects.toBeInstanceOf(ConflictException);
    const overridden = await routing.override(contextA, evaluated.decision.id, { supplierId: primarySupplierId, expectedDecisionVersion: 1, reasonCode: "MANUAL_CAPACITY_BALANCE", reason: "Balance the approved supplier workload." });
    expect(overridden.decision).toMatchObject({ status: "pending_approval", selectedSupplierId: primarySupplierId, decisionVersion: 2 });
    expect(overridden.events.at(-1)).toMatchObject({ type: "overridden", supplierId: primarySupplierId, reasonCode: "MANUAL_CAPACITY_BALANCE", actorUserId: userA });
    const approved = await routing.review(contextA, evaluated.decision.id, { action: "approve", expectedDecisionVersion: 2, reason: "Cost and capacity reviewed." });
    expect(approved.decision).toMatchObject({ status: "approved", decisionVersion: 3 });
    expect((await withTenant(database.db, contextA, (tx) => tx.select().from(orderRoutingDecisionEvents).where(eq(orderRoutingDecisionEvents.routingDecisionId, evaluated.decision.id))))).toHaveLength(3);
  });

  it("keeps decisions tenant isolated and turns no eligible supplier into a sourcing exception", async () => {
    const order = await readyOrder("no-supplier");
    const impossible = await routing.createPolicy(contextA, { ...policy(2_000), name: "Impossible lead time", maximumLeadTimeDays: 1 });
    const result = await routing.route(contextA, order.id, routeInput(order.lines[0]!.id, impossible.id, "route-no-supplier"));
    expect(result.decision).toMatchObject({ status: "no_eligible_supplier", selectedSupplierId: null });
    expect(result.candidates.every((entry) => entry.exclusionCodes.includes("lead_time_exceeded"))).toBe(true);
    const exceptions = await withTenant(database.db, contextA, (tx) => tx.select().from(orderExceptions).where(eq(orderExceptions.orderId, order.id)));
    expect(exceptions).toEqual([expect.objectContaining({ category: "sourcing", code: "NO_ELIGIBLE_SUPPLIER" })]);
    await expect(routing.get(contextB, result.decision.id)).rejects.toBeInstanceOf(NotFoundException);
    expect(await withTenant(database.db, contextB, (tx) => tx.select().from(routingPolicyVersions))).toEqual([]);
  });

  async function addSupplierEvidence(supplierId: string, unitCostMinor: number, leadTimeDays: number, qualityScoreBps: number) {
    await routing.addCapability(contextA, { supplierId, supportedSkuIds: [skuId], processCodes: ["DTG"], serviceCountryCodes: ["US"], blockedRegionCodes: [], qualityScoreBps, effectiveAt: "2026-07-01T00:00:00.000Z", sourceVersion: "fixture-v1" });
    await routing.addQuote(contextA, { supplierId, skuId, unitCostMinor, currency: "USD", minimumOrderQuantity: 1, leadTimeDays, validFrom: "2026-07-01T00:00:00.000Z", validUntil: "2027-07-01T00:00:00.000Z", externalQuoteId: `quote-${supplierId}` });
    await routing.addCapacity(contextA, { supplierId, startsAt: "2026-07-01T00:00:00.000Z", endsAt: "2027-07-01T00:00:00.000Z", availableUnits: 100, reservedUnits: 0, sourceVersion: "fixture-v1" });
  }

  async function readyOrder(suffix: string) {
    const order = await orderService.ingestNormalized(contextA, orderFixture(accountA, suffix));
    await withTenant(database.db, contextA, async (tx) => {
      await tx.update(orderRows).set({ workflowState: "awaiting_routing" }).where(eq(orderRows.id, order.id));
      await tx.insert(orderCustomizationRequirements).values({ id: createEntityId(), tenantId: tenantA, orderId: order.id, orderLineId: order.lines[0]!.id, schemaVersion: 1, schemaSnapshot: { version: 1, fields: [] }, fulfillmentPath: "template_ready", status: "approved", createdBy: userA });
    });
    return orderService.get(contextA, order.id);
  }
});

function routeInput(orderLineId: string, routingPolicyId: string, idempotencyKey: string) {
  return { orderLineId, routingPolicyId, processCodes: ["DTG"], destinationCountryCode: "US", destinationRegionCode: "WA", idempotencyKey };
}

function policy(manualApprovalCostMinor: number): CreateRoutingPolicyInput {
  return { name: `Default routing ${manualApprovalCostMinor}`, weights: { capability: 2_000, region: 1_000, cost: 2_000, leadTime: 2_000, capacity: 1_000, quality: 1_500, priority: 500 }, minimumQualityBps: 8_000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 2_000, manualApprovalCostMinor, manualApprovalRiskBps: 2_000, tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"] };
}

function orderFixture(accountId: string, suffix: string): NormalizeOrderInput {
  return {
    accountId, platform: "etsy", externalEventId: `routing-event-${suffix}`, externalOrderId: `routing-order-${suffix}`, providerStatus: "paid",
    placedAt: "2026-07-22T10:00:00.000Z", orderTotal: { amountMinor: 2500, currency: "USD" },
    lines: [{ externalLineId: `routing-line-${suffix}`, externalListingId: null, skuCode: "ROUTED-SKU", title: "Routed product", quantity: 1, unitPrice: { amountMinor: 2500, currency: "USD" }, customizationCount: 0 }],
    redactedSource: { receiptId: `routing-order-${suffix}` }, protectedDetails: null,
  };
}
