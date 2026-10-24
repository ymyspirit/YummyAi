import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { CreateQualityStandardInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { RecordQualityGroupsInputSchema, type QualityPhysicalGroupInput } from "@yummyai/contracts/order/quality-groups";
import type { ProductionPhysicalQuantities } from "@yummyai/contracts/order/production-quantity";
import { AllocateQualityScrapInputSchema, type QualityScrapBasis } from "@yummyai/contracts/order/quality-scrap";
import { loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { factoryCapacityFixture } from "../suppliers/factory-capacity.test-fixture.js";
import { ProductionQuantityService } from "./production-quantity.service.js";
import { QualityScrapService } from "./quality-scrap.service.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { HttpAmazonReportArchiveGateway } from "./amazon-report-archive.gateway.js";
import { ClamAvProductionEditorScanner, ProductionEditorService } from "../design/production-editor.service.js";

/** Must precede any connection, including inside an original160 source child. */
export function requireQualityScrapEnvironment(target: "current" | "pre-0161") {
  const url = new URL(requireDisposableIntegrationEnvironment());
  const nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  if (process.env.E2E_QUALITY_SCRAP_ISOLATED !== "1" || process.env.E2E_LEGACY_SCHEMA_TARGET !== target ||
      !nonce || process.env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}`)
    throw new Error("Quality scrap requires its exact isolated schema, nonce database and matching private bucket");
  return { url, nonce };
}

export const scrapPhysical = (unstartedQuantity: number | null, inProcessQuantity: number | null,
  completedQuantity: number | null, scrappedQuantity: number | null): ProductionPhysicalQuantities =>
  ({ unstartedQuantity, inProcessQuantity, completedQuantity, scrappedQuantity });

/** All lots, QC groups, remakes and shipments must be minted by their real public owners. */
export function qualityScrapFixture(database: DatabaseConnection) {
  requireQualityScrapEnvironment("current");
  const owner = factoryCapacityFixture(database), quantities = new ProductionQuantityService(database, owner.audit);
  const scraps = new QualityScrapService(database, owner.audit);
  async function production(quantity = 10) {
    const site = await owner.factory(), pools = [];
    for (const rate of [2, 3]) pools.push(await owner.pool(site, 40 * rate, { rates: [rate] }));
    const plan = { allocations: pools.map(pool => pool.capacityPlan.allocations[0]!) };
    const source = await owner.source(site, quantity, pools[0]!.pool, { localDate: pools[0]!.localDate, extraPlan: plan });
    const actual = await owner.production.create(owner.context, source.order.id, source.input);
    const id = actual.productionOrder.id;
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const) {
      const current = await owner.production.get(owner.context, id);
      await owner.production.recordMilestone(owner.context, id, { type, expectedProjectionVersion: current.productionOrder.projectionVersion,
        externalEventId: randomUUID(), occurredAt: (await owner.clock()).now,
        evidence: { code: "SYNTHETIC_SCRAP_ACTUAL_MILESTONE", note: null, assetIds: [] } });
    }
    const standard = await owner.production.createQualityStandard(owner.context, CreateQualityStandardInputSchema.parse({
      name: `Synthetic fixed scrap QC ${createEntityId()}`, minimumScoreBps: 9000,
      criteria: [{ code: "ACTUAL", label: "Actual segregated physical group", weightBps: 10000, blocking: true }],
    }));
    return { site, pools, source, actual, id, versionId: actual.versions[0]!.id, standardId: standard.id, quantity };
  }
  const group = (key: string, quantity: number, passed = false): QualityPhysicalGroupInput => ({ key,
    label: `Synthetic scrap physical bin ${key}`, quantity,
    criterionResults: [{ code: "ACTUAL", scoreBps: passed ? 10000 : 0, passed, evidenceAssetIds: [] }],
    defects: passed ? [] : ["COLOR", "STITCH"].map(code => ({ code, severity: "major", responsibility: "supplier", disposition: "remake",
      note: `Synthetic actual ${code} defect in this same physical set`, evidenceAssetIds: [] })),
  });
  async function inspect(value: Awaited<ReturnType<typeof production>>, groups: QualityPhysicalGroupInput[], parentGroupId: string | null = null) {
    const current = await owner.production.qualityGroups(owner.context, value.id);
    return owner.production.inspectGroups(owner.context, value.id, RecordQualityGroupsInputSchema.parse({ formatVersion: 3,
      productionVersionId: current.productionVersionId, expectedProductionProjectionVersion: current.projectionVersion,
      expectedRootInspectionId: current.rootInspectionId, parentGroupId, qualityStandardVersionId: value.standardId,
      inspectedAt: (await owner.clock()).now, evidenceAssetIds: [], segregationConfirmed: true, groups, idempotencyKey: randomUUID() }));
  }
  async function scenario(quantity = 10, passed = 4) {
    const value = await production(quantity);
    const root = await inspect(value, [...(passed ? [group("GOOD", passed, true)] : []), ...(quantity > passed ? [group("HELD", quantity - passed)] : [])]);
    return { ...value, root, held: root.workspace.groups.find(row => row.result === "failed"), good: root.workspace.groups.find(row => row.result === "passed") };
  }
  async function report(value: { id: string }, counts: ProductionPhysicalQuantities, observedAt?: string) {
    const basis = (await quantities.workspace(owner.context, value.id, {})).basis;
    const input = { idempotencyKey: randomUUID(), productionVersionId: basis.productionVersionId,
      expectedProductionProjectionVersion: basis.projectionVersion, expectedReviewId: basis.reviewId, expectedBasisFingerprint: basis.fingerprint,
      observedAt: observedAt ?? (await owner.clock()).now, quantities: counts, evidenceCode: "SYNTHETIC_SCRAP_PHYSICAL_REPORT", evidenceAssetIds: [] };
    const saved = await quantities.recordReport(owner.context, value.id, input);
    return { basis, input, saved };
  }
  async function physicalReview(value: { id: string }, counts: ProductionPhysicalQuantities, observedAt?: string) {
    const prepared = await report(value, counts, observedAt), basis = prepared.basis;
    const input = { idempotencyKey: randomUUID(), reportId: prepared.saved.report.id,
      expectedProductionProjectionVersion: basis.projectionVersion, expectedReviewId: basis.reviewId, expectedBasisFingerprint: basis.fingerprint,
      stoppedDelta: 0, unstartedAcrossAllPoolsConfirmed: false, occurredAt: (await owner.clock()).now, evidenceCode: "SYNTHETIC_SCRAP_PHYSICAL_REVIEW" };
    const saved = await quantities.review(owner.context, value.id, input);
    return { ...prepared, reviewInput: input, reviewed: saved };
  }
  async function allocationInput(basis: QualityScrapBasis, allocations: Array<{ qualityGroupId: string; sourceQuantityReviewId: string; quantity: number }>) {
    if (!basis.rootInspectionId || !basis.quantityReviewId) throw new Error("Synthetic allocation requires its actual root and physical review");
    return AllocateQualityScrapInputSchema.parse({ idempotencyKey: randomUUID(), productionVersionId: basis.productionVersionId,
      expectedProductionProjectionVersion: basis.projectionVersion, expectedRootInspectionId: basis.rootInspectionId,
      expectedQuantityReviewId: basis.quantityReviewId, expectedScrapReviewId: basis.scrapReviewId, expectedBasisFingerprint: basis.fingerprint,
      physicalSegregationConfirmed: true, occurredAt: (await owner.clock()).now,
      evidenceCode: "SYNTHETIC_FIXED_SCRAP_LOT", evidenceAssetIds: [], allocations });
  }
  async function ready(quantity = 10, passed = 4, scrap = 2) {
    const value = await scenario(quantity, passed);
    if (!value.held) throw new Error("Synthetic fixed scrap requires an actual failed group");
    const count = await physicalReview(value, scrapPhysical(0, 0, quantity - scrap, scrap));
    const basis = (await scraps.workspace(owner.context, value.id, {})).basis;
    const input = await allocationInput(basis, [{ qualityGroupId: value.held.id, sourceQuantityReviewId: count.reviewed.review.id, quantity: scrap }]);
    return { ...value, held: value.held, count, basis, input };
  }
  async function remake(value: Awaited<ReturnType<typeof production>>, groupId: string, defectId: string, quantity: number) {
    const current = await owner.production.get(owner.context, value.id);
    return owner.production.recover(owner.context, { type: "remake", originalProductionOrderId: value.id, qualityGroupId: groupId, defectId,
      remakeQuantity: quantity, expectedProductionProjectionVersion: current.productionOrder.projectionVersion, physicalSelectionConfirmed: true,
      manufacturing: value.source.input.manufacturing, capacityPlan: value.source.input.capacityPlan,
      reason: "Synthetic replacement for exactly the original fixed scrap", expectedCompletionAt: value.source.input.expectedCompletionAt,
      idempotencyKey: randomUUID() });
  }
  async function colleague(): Promise<TenantContext> {
    const userId = createEntityId(), memberId = createEntityId(), roleId = createEntityId();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)", [userId, userId, `${userId}@example.invalid`, `Synthetic scrap colleague ${userId}`]);
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [memberId, owner.context.tenantId, userId]);
    await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [roleId, owner.context.tenantId, roleId, JSON.stringify(Object.values(Permission))]);
    await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [owner.context.tenantId, memberId, roleId]);
    const seed = { ...owner.seed(), userId };
    return withTenant(database.db, seed, tx => loadCurrentMembershipContext(tx, seed));
  }
  async function privateWork(lineId: string) {
    const storage = createStorageFromEnvironment(), scanner = new ClamAvProductionEditorScanner();
    const unexpectedJob = async () => { throw new Error("Synthetic private draft must not enqueue processing or rendering"); };
    const reports = new AmazonOrderReportService(database, owner.vault, owner.orders, owner.audit,
      new HttpAmazonReportArchiveGateway(), { schedule: unexpectedJob }, { schedule: unexpectedJob });
    const editor = new ProductionEditorService(database, owner.vault, storage, reports, owner.audit,
      { enqueue: unexpectedJob }, scanner);
    const workspace = new OrderWorkspaceService(database, owner.vault, storage, reports, editor, scanner);
    // The actual save owner creates the private envelope and immutable draft.
    // This pending review is not manufacturing approval or a pushed work source.
    return workspace.save(owner.context, lineId, { expectedRevision: 0, expectedProjectionVersion: 0, expectedSourceVersionId: null,
      draft: { printProfileVersionId: null, salesRecipeVersionId: null, salesPackageId: null, artworkVersionId: null, specificationVersionId: null,
        designExecutor: "human", fields: [], images: [], instructions: "Synthetic private shipment coordination draft Only the native approved manufacturing source is production authority",
        customerApprovalRequired: false, dueAt: null }, status: "pending_review", reason: "Synthetic actual private work for partial physical shipment", idempotencyKey: randomUUID() });
  }
  async function state() {
    const result = await owner.state();
    await withTenant(database.db, owner.seed(), async tx => {
      for (const table of ["quality_scrap_reviews", "quality_scrap_allocations", "production_quantity_reports", "production_quantity_reviews", "factory_capacity_stop_effects",
        "quality_inspections", "quality_inspection_groups", "quality_group_reinspections", "quality_group_defects", "quality_defects", "production_recovery_groups",
        "shipment_production_allocations", "shipment_tracking_events", "inventory_movements", "inventory_reservation_events"])
        result[table] = (await tx.execute<{ digest: string }>(sql`select md5(coalesce(jsonb_agg(to_jsonb(item) order by to_jsonb(item)::text)::text,'[]')) as digest from ${sql.identifier(table)} item`))[0]!.digest;
    });
    return result;
  }
  return { owner, quantities, scraps, production, scenario, group, inspect, report, physicalReview, allocationInput, ready, remake, colleague, privateWork, state };
}
