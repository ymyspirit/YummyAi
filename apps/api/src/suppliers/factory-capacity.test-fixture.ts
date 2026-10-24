import { randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { CreateProductionOrderInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import type { FactoryCapacityPoolProfile, FactoryCapacityPoolView, ProductionCapacityPlan } from "@yummyai/contracts/suppliers/factory-capacity";
import type { FactoryCapabilityView, FactoryView } from "@yummyai/contracts/suppliers/factory-directory";
import { fulfillmentSuppliers, loadCurrentMembershipContext, memberships, orderCustomizationRequirements, orderRoutingDecisions,
  purchaseOrders, purchaseOrderVersions, roles, routingPolicyVersions, withTenant, type DatabaseConnection } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { syntheticFactoryCapacityProfile } from "../../../../tools/testing/factory-capacity-fixtures.js";
import { syntheticFactoryCapability, syntheticFactoryProfile, syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { AuditService } from "../audit/audit.service.js";
import { syntheticNativeManufacturingForLine } from "../orders/manufacturing-production.test-fixture.js";
import { OrderProductionService } from "../orders/order-production.service.js";
import { OrderService } from "../orders/order.service.js";
import { addFactoryCapacityLocalDays, factoryCapacityLocalDate, resolveFactoryCapacityLocalTime } from "./factory-capacity-calendar.js";
import { FactoryCapacityService } from "./factory-capacity.service.js";
import { FactoryDirectoryService } from "./factory-directory.service.js";

function requireCapacityFixture() {
  requireDisposableIntegrationEnvironment();
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid"), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (!nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`) throw new Error("Synthetic capacity requires matching disposable DB and bucket");
}
export interface SyntheticCapacityFactory { factory: FactoryView; capabilities: FactoryCapabilityView[]; supplierId: string }

/** Public owner setup, reusable by unrelated isolated production suites. It never reserves capacity or changes a business result on its own. */
export async function createSyntheticFactoryCapacity(database: DatabaseConnection, context: TenantContext, input: {
  factory: FactoryView; bindings: Array<{ capabilityVersionId: string; unitsPerItem: number }>; capacityUnits: number;
  unit?: "each" | "minute"; profile?: Partial<FactoryCapacityPoolProfile>; localDate?: string;
}) {
  requireCapacityFixture();
  const audit = new AuditService(database), service = new FactoryCapacityService(database, audit), zone = input.factory.profile.timeZone;
  if (!zone) throw new Error("Synthetic confirmed capacity requires the actual factory timezone");
  const [clock] = await withTenant(database.db, context, tx => tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`));
  const now = new Date(clock!.now).toISOString(), today = factoryCapacityLocalDate(zone, now), localDate = input.localDate ?? today;
  const pool = await service.createPool(context, input.factory.id, { factoryVersionId: input.factory.versionId, code: `SYNTHETIC-${randomUUID()}`,
    timeZone: zone, unit: input.unit ?? "each", profile: syntheticFactoryCapacityProfile(input.bindings, input.capacityUnits, input.profile), idempotencyKey: randomUUID() });
  const capacityPlan: ProductionCapacityPlan = { allocations: [{ poolId: pool.id, poolVersionId: pool.versionId, localDate }] };
  return { service, pool, capacityPlan, now, today, localDate,
    expectedCompletionAt: resolveFactoryCapacityLocalTime(zone, `${addFactoryCapacityLocalDays(localDate, 1)}T00:00`) };
}

/** Real members, finite confirmed pools and genuine production owners; no private service/database field access. */
export function factoryCapacityFixture(database: DatabaseConnection, options: { vault?: SecretVault } = {}) {
  requireCapacityFixture();
  const audit = new AuditService(database), vault = options.vault ?? new SecretVault(Buffer.alloc(32, 121));
  const factories = new FactoryDirectoryService(database, audit), capacity = new FactoryCapacityService(database, audit);
  const orders = new OrderService(database, vault, audit), production = new OrderProductionService(database, vault, orders, audit, undefined, factories);
  const actor = () => ({ tenantId: createEntityId(), userId: createEntityId(), membershipId: createEntityId(), roleId: createEntityId(), wideRoleId: createEntityId(), accountId: createEntityId() });
  const owner = actor(), foreign = actor(), all = Object.values(Permission);
  const seed = (value = owner): TenantContext => ({ tenantId: value.tenantId, userId: value.userId, permissions: all, dataScope: "tenant" });
  let context: TenantContext, foreignContext: TenantContext;
  const current = (value = owner) => withTenant(database.db, seed(value), tx => loadCurrentMembershipContext(tx, seed(value)));
  async function grant(permissions: readonly string[] = all, scope: "self" | "team" | "tenant" = "tenant", wider: readonly string[] = []) {
    await withTenant(database.db, seed(), async tx => {
      await tx.update(roles).set({ permissions: [...permissions], dataScope: scope }).where(eq(roles.id, owner.roleId));
      await tx.update(roles).set({ permissions: [...wider], dataScope: "tenant" }).where(eq(roles.id, owner.wideRoleId));
      await tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, owner.membershipId));
    });
  }
  async function initialize() {
    for (const value of [owner, foreign]) {
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,$2,$3)", [value.tenantId, `Synthetic capacity tenant ${value.tenantId}`, `capacity-${value.tenantId}`]);
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)", [value.userId, `capacity-${value.userId}`, `${value.userId}@example.invalid`, `Synthetic capacity member ${value.userId}`]);
      await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [value.membershipId, value.tenantId, value.userId]);
      for (const id of [value.roleId, value.wideRoleId]) {
        await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [id, value.tenantId, `Synthetic capacity role ${id}`, JSON.stringify(id === value.roleId ? all : [])]);
        await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [value.tenantId, value.membershipId, id]);
      }
      await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)", [value.accountId, value.tenantId, `Synthetic capacity store ${value.accountId}`, value.userId]);
    }
    context = await current(); foreignContext = await current(foreign);
  }
  async function factory(options: { count?: number; timeZone?: string; productType?: "other" | "rectangular_print"; name?: string } = {}): Promise<SyntheticCapacityFactory> {
    const supplierId = createEntityId();
    await withTenant(database.db, seed(), tx => tx.insert(fulfillmentSuppliers).values({ id: supplierId, tenantId: owner.tenantId,
      name: `Synthetic capacity supplier ${supplierId}`, kind: "manual", status: "active", regionCode: "US", settlementCurrency: "USD", profile: syntheticSupplierProfile, createdBy: owner.userId }));
    const record = await factories.create(context, { supplierId, code: `SYNTHETIC-${randomUUID()}`, profile: { ...syntheticFactoryProfile(options.name ?? `Synthetic capacity site ${createEntityId()}`), timeZone: options.timeZone ?? "UTC" }, idempotencyKey: randomUUID() });
    const capabilities: FactoryCapabilityView[] = [];
    for (let i = 0; i < (options.count ?? 1); i++) capabilities.push(await factories.createCapability(context, record.id, {
      profile: { ...syntheticFactoryCapability(options.productType ?? "rectangular_print"), name: `Synthetic capacity capability ${i} ${createEntityId()}` }, idempotencyKey: randomUUID() }));
    return { factory: record, capabilities, supplierId };
  }
  async function pool(site: SyntheticCapacityFactory, units = 10, options: { unit?: "each" | "minute"; rates?: number[]; profile?: Partial<FactoryCapacityPoolProfile>; localDate?: string } = {}) {
    return createSyntheticFactoryCapacity(database, context, { factory: site.factory, capacityUnits: units, unit: options.unit, profile: options.profile, localDate: options.localDate,
      bindings: site.capabilities.map((item, index) => ({ capabilityVersionId: item.versionId, unitsPerItem: options.rates?.[index] ?? 1 })) });
  }
  async function clock(zone = "UTC", days = 0) {
    const [row] = await withTenant(database.db, seed(), tx => tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`));
    const now = new Date(row!.now).toISOString(), today = factoryCapacityLocalDate(zone, now), localDate = addFactoryCapacityLocalDays(today, days);
    return { now, today, localDate, expectedCompletionAt: resolveFactoryCapacityLocalTime(zone, `${addFactoryCapacityLocalDays(localDate, 1)}T00:00`) };
  }
  async function state() {
    return withTenant(database.db, seed(), async tx => {
      const result: Record<string, string> = {};
      for (const table of ["factory_capacity_pools", "factory_capacity_versions", "factory_capacity_reservations", "factory_capacity_events", "factory_capacity_owner_proofs", "production_orders", "production_order_versions", "production_manufacturing_bindings", "production_milestone_events", "audit_events"]) {
        const [row] = await tx.execute<{ digest: string }>(sql`select md5(coalesce(jsonb_agg(to_jsonb(item) order by to_jsonb(item)::text)::text,'[]')) as digest from ${sql.identifier(table)} item`);
        result[table] = row!.digest;
      }
      return result;
    });
  }
  function plan(pool: FactoryCapacityPoolView, localDate: string): ProductionCapacityPlan {
    return { allocations: [{ poolId: pool.id, poolVersionId: pool.versionId, localDate }] };
  }
  async function source(site: SyntheticCapacityFactory, quantity: number, pool: FactoryCapacityPoolView, options: { capabilityIndex?: number; localDate?: string; extraPlan?: ProductionCapacityPlan } = {}) {
    const suffix = createEntityId(), order = await orders.ingestNormalized(context, { accountId: owner.accountId, platform: "etsy", externalEventId: `capacity-${suffix}`,
      externalOrderId: `capacity-${suffix}`, providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: null,
      lines: [{ externalLineId: `capacity-line-${suffix}`, externalListingId: null, skuCode: null, title: "Synthetic rectangular capacity output", quantity,
        unitPrice: null, customizationCount: 0 }], redactedSource: { synthetic: true }, protectedDetails: null });
    const lineId = order.lines[0]!.id, basis = await syntheticNativeManufacturingForLine(database, context, lineId, { productType: "rectangular_print" });
    const policyId = createEntityId(), decisionId = createEntityId(), purchaseId = createEntityId(), purchaseVersionId = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(routingPolicyVersions).values({ id: policyId, tenantId: owner.tenantId, name: `Synthetic capacity routing ${policyId}`, versionNumber: 1,
        weights: { capability: 2000, region: 1000, cost: 2000, leadTime: 2000, capacity: 1000, quality: 1500, priority: 500 },
        thresholds: { minimumQualityBps: 8000, maximumLeadTimeDays: 10, maximumUnitCostMinor: 2000, manualApprovalCostMinor: 2000, manualApprovalRiskBps: 2000 },
        tieBreaker: ["total_score", "unit_cost", "lead_time", "supplier_id"], active: true, createdBy: owner.userId });
      await tx.insert(orderCustomizationRequirements).values({ id: createEntityId(), tenantId: owner.tenantId, orderId: order.id, orderLineId: lineId,
        schemaVersion: 1, schemaSnapshot: { version: 1, fields: [] }, fulfillmentPath: "template_ready", status: "approved", createdBy: owner.userId });
      await tx.insert(orderRoutingDecisions).values({ id: decisionId, tenantId: owner.tenantId, orderId: order.id, orderLineId: lineId, routingPolicyVersionId: policyId,
        versionNumber: 1, status: "approved", selectedSupplierId: site.supplierId, inputChecksum: "a".repeat(64), requiresApproval: false, approvalReasons: [], idempotencyKey: randomUUID() });
      await tx.insert(purchaseOrders).values({ id: purchaseId, tenantId: owner.tenantId, supplierId: site.supplierId, orderId: order.id, status: "approved", currentVersionNumber: 1, createdBy: owner.userId });
      await tx.insert(purchaseOrderVersions).values({ id: purchaseVersionId, tenantId: owner.tenantId, purchaseOrderId: purchaseId, versionNumber: 1, currency: "USD",
        totalMinor: quantity, lineSnapshot: [{ orderLineId: lineId, quantity, unitCostMinor: 1 }], routingDecisionIds: [decisionId], checksum: "b".repeat(64), createdBy: owner.userId });
    });
    let currentOrder = order;
    for (const toState of ["awaiting_customization", "awaiting_design", "awaiting_customer_approval", "awaiting_routing", "in_production"] as const)
      currentOrder = await orders.transition(context, order.id, { toState, expectedSequence: currentOrder.latestEventSequence, idempotencyKey: `capacity-${suffix}-${toState}`, reason: "Synthetic capacity source preparation" });
    const time = await clock(site.factory.profile.timeZone!, 0), localDate = options.localDate ?? time.localDate;
    const input = CreateProductionOrderInputSchema.parse({ orderLineId: lineId, ...{ factoryId: site.factory.id, factoryVersionId: site.factory.versionId, capabilityVersionId: site.capabilities[options.capabilityIndex ?? 0]!.versionId },
      routingDecisionId: decisionId, purchaseOrderVersionId: purchaseVersionId, designVersionId: basis.designVersionId, productionAssetIds: basis.productionAssetIds,
      manufacturing: basis.manufacturing, productConfirmation: basis.productConfirmation,
      expectedCompletionAt: resolveFactoryCapacityLocalTime(site.factory.profile.timeZone!, `${addFactoryCapacityLocalDays(localDate, 1)}T00:00`),
      instructions: "Synthetic explicit capacity-backed production only", capacityPlan: options.extraPlan ?? plan(pool, localDate), idempotencyKey: randomUUID() });
    return { order: currentOrder, lineId, basis, input };
  }
  return { database, audit, vault, factories, capacity, orders, production, owner, foreign, initialize, grant, current, factory, pool, clock, state, plan, source,
    get context() { return context; }, get foreignContext() { return foreignContext; }, seed };
}
