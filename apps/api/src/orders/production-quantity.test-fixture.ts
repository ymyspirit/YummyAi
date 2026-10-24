import { randomUUID } from "node:crypto";
import type { RecordProductionMilestoneInput, TenantContext } from "@yummyai/contracts";
import type {
  ProductionPhysicalQuantities,
  ProductionQuantityBasis,
  ProductionQuantityReportInput,
  ProductionQuantityReviewInput,
} from "@yummyai/contracts/order/production-quantity";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { factoryCapacityFixture } from "../suppliers/factory-capacity.test-fixture.js";
import { ProductionQuantityService } from "./production-quantity.service.js";

/** This guard must run before connectDatabase, including inside a legacy child. */
export function requireProductionQuantityEnvironment(target: "current" | "pre-0160") {
  const url = new URL(requireDisposableIntegrationEnvironment());
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (process.env.E2E_PRODUCTION_QUANTITY_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== target ||
      !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Production quantity requires its exact isolated schema, nonce database and matching bucket");
  return { url, nonce };
}

/** All production, manufacturing, pool and milestone facts use their real owners. */
export function productionQuantityFixture(database: DatabaseConnection) {
  requireProductionQuantityEnvironment("current");
  const capacity = factoryCapacityFixture(database);
  const quantities = new ProductionQuantityService(database, capacity.audit);

  async function scenario(quantity = 10, rates = [2, 3], availableItems = 20) {
    const site = await capacity.factory();
    const pools = [];
    for (const rate of rates) pools.push(await capacity.pool(site, availableItems * rate, { rates: [rate] }));
    const first = pools[0];
    if (!first) throw new Error("Synthetic quantity scenario requires a real resource pool");
    const plan = { allocations: pools.map(pool => pool.capacityPlan.allocations[0]!) };
    const source = await capacity.source(site, quantity, first.pool, { localDate: first.localDate, extraPlan: plan });
    const actual = await capacity.production.create(capacity.context, source.order.id, source.input);
    const version = actual.versions.find(row => row.versionNumber === actual.productionOrder.currentVersionNumber);
    if (!version) throw new Error("Synthetic production must have its actual immutable version");
    return { site, pools, source, actual, id: actual.productionOrder.id, versionId: version.id };
  }

  async function milestone(id: string, type: RecordProductionMilestoneInput["type"], context: TenantContext = capacity.context) {
    const actual = await capacity.production.get(context, id);
    const input: RecordProductionMilestoneInput = {
      type, expectedProjectionVersion: actual.productionOrder.projectionVersion, externalEventId: randomUUID(),
      occurredAt: (await capacity.clock()).now,
      evidence: { code: "SYNTHETIC_QUANTITY_MILESTONE", note: null, assetIds: [] },
    };
    return capacity.production.recordMilestone(context, id, input);
  }

  async function reportInput(basis: ProductionQuantityBasis, physical: ProductionPhysicalQuantities): Promise<ProductionQuantityReportInput> {
    return {
      idempotencyKey: randomUUID(), productionVersionId: basis.productionVersionId,
      expectedProductionProjectionVersion: basis.projectionVersion, expectedReviewId: basis.reviewId,
      expectedBasisFingerprint: basis.fingerprint, observedAt: (await capacity.clock()).now,
      quantities: physical, evidenceCode: "SYNTHETIC_ACTUAL_QUANTITY", evidenceAssetIds: [],
    };
  }

  async function reviewInput(basis: ProductionQuantityBasis, reportId: string, stoppedDelta: number): Promise<ProductionQuantityReviewInput> {
    return {
      idempotencyKey: randomUUID(), reportId, expectedProductionProjectionVersion: basis.projectionVersion,
      expectedReviewId: basis.reviewId, expectedBasisFingerprint: basis.fingerprint, stoppedDelta,
      unstartedAcrossAllPoolsConfirmed: stoppedDelta > 0, evidenceCode: "SYNTHETIC_STOP_ALL_POOLS_UNSTARTED",
      occurredAt: (await capacity.clock()).now,
    };
  }

  async function state() {
    const result = await capacity.state();
    await withTenant(database.db, capacity.seed(), async tx => {
      for (const table of ["production_quantity_reports", "production_quantity_reviews", "factory_capacity_stop_effects",
        "quality_inspections", "quality_inspection_groups", "quality_group_defects", "production_recovery_groups",
        "shipment_production_allocations", "shipment_tracking_events", "inventory_movements", "inventory_reservation_events"]) {
        const [row] = await tx.execute<{ digest: string }>(sql`select md5(coalesce(jsonb_agg(to_jsonb(item) order by to_jsonb(item)::text)::text,'[]')) as digest from ${sql.identifier(table)} item`);
        result[table] = row!.digest;
      }
    });
    return result;
  }

  // Keep the original lazy authority getters; spreading the fixture would read them before initialize.
  return { capacity, quantities, scenario, milestone, reportInput, reviewInput, state };
}
