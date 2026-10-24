import { createHash, randomUUID } from "node:crypto";
import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission, erpPermissionContext } from "@yummyai/authz";
import { CreateQualityStandardInputSchema, CreateShipmentInputSchema, RecordQualityInspectionInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { RecordQualityGroupsInputSchema } from "@yummyai/contracts/order/quality-groups";
import { ProductionQuantityWorkspaceSchema, type ProductionPhysicalQuantities, type ProductionQuantityBasis,
  type ProductionQuantityReportInput, type ProductionQuantityReviewInput } from "@yummyai/contracts/order/production-quantity";
import { connectDatabase, factoryCapacityStopEffects, loadCurrentMembershipContext, memberships, productionOrders,
  productionQuantityReports, productionQuantityReviews, qualityInspections, withTenant, type TenantTransaction } from "@yummyai/database";
import { productionInspectedQuantity } from "@yummyai/order-core";
import { asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { OrderShipmentService } from "./order-shipment.service.js";
import { NativeProductionService } from "./native-production.service.js";
import { ProductionQuantityService } from "./production-quantity.service.js";
import { productionQuantityFixture, requireProductionQuantityEnvironment } from "./production-quantity.test-fixture.js";

requireProductionQuantityEnvironment("current");
const physical = (unstartedQuantity: number | null, inProcessQuantity: number | null, completedQuantity: number | null, scrappedQuantity: number | null): ProductionPhysicalQuantities =>
  ({ unstartedQuantity, inProcessQuantity, completedQuantity, scrappedQuantity });
const publicError = (status: number, code: string) => (error: unknown) => !!error && typeof error === "object" && "getStatus" in error && "getResponse" in error &&
  (error as { getStatus(): number }).getStatus() === status && (error as { getResponse(): { code?: string } }).getResponse().code === code;
function pg(error: unknown): { code?: string; message?: string } {
  if (!error || typeof error !== "object") return {};
  if ("code" in error) return error as { code?: string; message?: string };
  return "cause" in error ? pg(error.cause) : {};
}
const sqlError = (message: string) => (error: unknown) => pg(error).code === "23514" && pg(error).message === message;

describe.sequential("explicit production physical quantities and reviewed partial stops", () => {
  const database = connectDatabase(), f = productionQuantityFixture(database), owner = f.capacity;
  const shipping = new OrderShipmentService(database, owner.vault, owner.orders, owner.audit, { enqueue: async () => undefined });
  const native = new NativeProductionService(database, owner.factories);
  beforeAll(() => owner.initialize());
  afterEach(async () => { vi.restoreAllMocks(); await owner.grant(); });
  afterAll(async () => { vi.restoreAllMocks(); await database.client.end(); });
  const basis = async (id: string, context = owner.context) => (await f.quantities.workspace(context, id, {})).basis;
  async function reported(id: string, counts: ProductionPhysicalQuantities) {
    const original = await basis(id), input = await f.reportInput(original, counts);
    const saved = await f.quantities.recordReport(owner.context, id, input);
    return { basis: original, input, saved, review: await f.reviewInput(original, saved.report.id, 0) };
  }
  async function approved(id: string, counts: ProductionPhysicalQuantities, delta: number) {
    const value = await reported(id, counts), input = { ...value.review, stoppedDelta: delta, unstartedAcrossAllPoolsConfirmed: delta > 0 };
    const saved = await f.quantities.review(owner.context, id, input);
    return { ...value, review: input, actual: saved };
  }
  async function effects(id: string) {
    return withTenant(database.db, owner.context, tx => tx.select().from(factoryCapacityStopEffects)
      .where(sql`${factoryCapacityStopEffects.reviewId} in (select id from production_quantity_reviews where production_order_id=${id}::uuid)`)
      .orderBy(asc(factoryCapacityStopEffects.reservationId)));
  }
  async function freshActor(): Promise<TenantContext> {
    const userId = createEntityId(), member = createEntityId(), role = createEntityId();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)", [userId, userId, `${userId}@example.invalid`, `Synthetic quantity colleague ${userId}`]);
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [member, owner.context.tenantId, userId]);
    await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [role, owner.context.tenantId, role, JSON.stringify(Object.values(Permission))]);
    await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [owner.context.tenantId, member, role]);
    const seed = { ...owner.seed(), userId };
    return withTenant(database.db, seed, tx => loadCurrentMembershipContext(tx, seed));
  }
  async function grouped(value: Awaited<ReturnType<typeof f.scenario>>, passed: number) {
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const) await f.milestone(value.id, type);
    const standard = await owner.production.createQualityStandard(owner.context, CreateQualityStandardInputSchema.parse({
      name: `Synthetic quantity physical standard ${createEntityId()}`, minimumScoreBps: 9000,
      criteria: [{ code: "QUANTITY", label: "Synthetic segregated physical pieces", weightBps: 10000, blocking: true }],
    }));
    const current = await owner.production.qualityGroups(owner.context, value.id), held = current.quantity - passed;
    const group = (key: string, quantity: number, good: boolean) => ({ key, label: `Synthetic quantity bin ${key}`, quantity,
      criterionResults: [{ code: "QUANTITY", scoreBps: good ? 10000 : 0, passed: good, evidenceAssetIds: [] }],
      defects: good ? [] : ["COLOR", "STITCH"].map(code => ({ code, severity: "major", responsibility: "supplier", disposition: "remake", note: "Synthetic actual segregated defect", evidenceAssetIds: [] })) });
    return owner.production.inspectGroups(owner.context, value.id, RecordQualityGroupsInputSchema.parse({ formatVersion: 3,
      productionVersionId: current.productionVersionId, expectedProductionProjectionVersion: current.projectionVersion,
      expectedRootInspectionId: current.rootInspectionId, parentGroupId: null, qualityStandardVersionId: standard.id,
      inspectedAt: (await owner.clock()).now, evidenceAssetIds: [], segregationConfirmed: true,
      groups: [...(passed ? [group("PASSED", passed, true)] : []), ...(held ? [group("HELD", held, false)] : [])], idempotencyKey: randomUUID() }));
  }

  it("does not infer made quantities from started or its full scheduling commitment", async () => {
    const value = await f.scenario();
    for (const type of ["submitted", "acknowledged", "started"] as const) await f.milestone(value.id, type);
    const view = ProductionQuantityWorkspaceSchema.parse(await f.quantities.workspace(owner.context, value.id, {}));
    expect(view.contextAuthority).toBe(erpSessionAuthority(erpPermissionContext(owner.context)));
    expect(view.basis).toMatchObject({ quantity: 10, currentQuantities: null, cumulativeStoppedQuantity: 0, reviewId: null,
      groupedQuantity: 0, allocatedQuantity: 0, shippedQuantity: 0, completedLowerBound: 0 });
    expect(view.basis.reservations.map(row => row.grossCommittedUnits).sort((a, b) => a - b)).toEqual([20, 30]);
    expect(view.reports).toEqual([]); expect(view.reviews).toEqual([]);
  });

  it("keeps an unknown report as evidence without changing projection, physical facts or any pool balance", async () => {
    const value = await f.scenario(), before = await owner.production.get(owner.context, value.id), poolBefore = await owner.capacity.production(owner.context, value.id);
    const report = await reported(value.id, physical(null, null, null, null)), afterReport = await f.state();
    expect(report.saved.report.input.quantities).toEqual(physical(null, null, null, null));
    expect((await owner.production.get(owner.context, value.id)).productionOrder).toEqual(before.productionOrder);
    await expect(f.quantities.review(owner.context, value.id, { ...report.review, stoppedDelta: 1, unstartedAcrossAllPoolsConfirmed: true }))
      .rejects.toSatisfy(publicError(409, "production_quantity_counts_unknown"));
    expect(await f.state()).toEqual(afterReport); expect(await effects(value.id)).toEqual([]);
    expect(await owner.capacity.production(owner.context, value.id)).toEqual(poolBefore);
    expect((await basis(value.id)).currentQuantities).toBeNull();
  });

  it.each([
    { label: "incomplete known coverage", counts: physical(7, 2, 0, 0), delta: 1 },
    { label: "a stop larger than genuinely unstarted pieces", counts: physical(2, 8, 0, 0), delta: 3 },
  ])("rejects $label and rolls back all reviewed effects", async ({ counts, delta }) => {
    const value = await f.scenario(), report = await reported(value.id, counts), before = await f.state();
    await expect(f.quantities.review(owner.context, value.id, { ...report.review, stoppedDelta: delta, unstartedAcrossAllPoolsConfirmed: true }))
      .rejects.toSatisfy(publicError(409, "production_quantity_balance_invalid"));
    expect(await f.state()).toEqual(before);
  });

  it("requires explicit unused confirmation across every bound pool before any positive stop", async () => {
    const value = await f.scenario(), report = await reported(value.id, physical(10, 0, 0, 0)), before = await f.state();
    await expect(f.quantities.review(owner.context, value.id, { ...report.review, stoppedDelta: 4, unstartedAcrossAllPoolsConfirmed: false })).rejects.toMatchObject({ name: "ZodError" });
    expect(await f.state()).toEqual(before);
  });

  it("pairs an actual started partial stop at both original rates and permits only the approved initial delta to be arranged again", async () => {
    const value = await f.scenario();
    for (const type of ["submitted", "acknowledged", "started"] as const) await f.milestone(value.id, type);
    const original = await owner.production.get(owner.context, value.id);
    const result = await approved(value.id, physical(4, 3, 2, 1), 4), actual = await basis(value.id);
    expect(result.actual.review).toMatchObject({ cumulativeStoppedQuantity: 4, quantities: physical(0, 3, 2, 1), sequence: 1 });
    expect(actual).toMatchObject({ quantity: 10, cumulativeStoppedQuantity: 4, currentQuantities: physical(0, 3, 2, 1), status: original.productionOrder.status,
      projectionVersion: original.productionOrder.projectionVersion + 1 });
    const rows = await effects(value.id);
    expect(rows).toHaveLength(2); expect(rows.map(row => row.releasedUnits).sort((a, b) => a - b)).toEqual([8, 12]);
    expect(rows.map(row => row.commitReductionUnits).sort((a, b) => a - b)).toEqual([8, 12]);
    for (const reservation of actual.reservations) {
      expect(reservation.totalUnits).toBe(10 * reservation.unitsPerItem);
      expect(reservation.grossCommittedUnits).toBe(reservation.totalUnits);
      expect(reservation.stopReleasedUnits).toBe(4 * reservation.unitsPerItem);
      expect(reservation.stopCommitReductionUnits).toBe(reservation.stopReleasedUnits);
    }
    expect((await owner.production.get(owner.context, value.id)).versions).toEqual(original.versions);
    expect((await native.detail(owner.context, value.source.lineId, {})).line).toMatchObject({ quantity: 10, allocatedQuantity: 6 });
    const previous = await f.state();
    // An old body without quantity still asks for its original ten pieces.
    // It cannot silently become a new four-piece request under another key.
    await expect(owner.production.create(owner.context, value.source.order.id, { ...value.source.input, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    expect((await owner.production.create(owner.context, value.source.order.id, value.source.input)).productionOrder.id).toBe(value.id);
    expect(await f.state()).toEqual(previous);
    const requests = await Promise.allSettled([1, 2].map(() => owner.production.create(owner.context, value.source.order.id,
      { ...value.source.input, quantity: 4, idempotencyKey: randomUUID() })));
    const rejectionDiagnostics = requests.flatMap<{ status?: number; code?: string; pgCode?: string; message?: string }>(row => {
      if (row.status !== "rejected") return [];
      const error: unknown = row.reason;
      const message = (value: unknown) => typeof value === "string" ? value.replace(/\p{Cc}/gu, " ").slice(0, 240) : undefined;
      if (error instanceof HttpException) {
        const response = error.getResponse();
        const fields = typeof response === "object" && response !== null ? response as { code?: unknown; message?: unknown } : {};
        return [{ status: error.getStatus(), code: typeof fields.code === "string" && /^[a-z_]{1,100}$/.test(fields.code) ? fields.code : undefined,
          message: message(typeof response === "string" ? response : fields.message) }];
      }
      // Read only the inner PG code/message, never a Drizzle wrapper's SQL or parameters.
      const cause = pg(error);
      return [{ pgCode: typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code) ? cause.code : undefined, message: message(cause.message) }];
    });
    expect(requests.filter(row => row.status === "fulfilled"), `Synthetic delta allocation rejections: ${JSON.stringify(rejectionDiagnostics)}`).toHaveLength(1);
    const failed = requests.find(row => row.status === "rejected"); expect(failed?.status === "rejected" && failed.reason instanceof ConflictException).toBe(true);
    const success = requests.find(row => row.status === "fulfilled");
    if (success?.status !== "fulfilled") throw new Error("Synthetic released delta must be arranged exactly once");
    expect(success.value.versions[0]!.quantity).toBe(4);
    expect((await native.detail(owner.context, value.source.lineId, {})).line).toMatchObject({ quantity: 10, allocatedQuantity: 10 });
    expect((await owner.production.get(owner.context, value.id)).versions[0]!.quantity).toBe(10);
  });

  it("does not commit the stopped part again when real started follows a pre-start stop", async () => {
    const value = await f.scenario();
    await approved(value.id, physical(10, 0, 0, 0), 4);
    const before = await basis(value.id);
    expect(before.reservations.every(row => row.grossCommittedUnits === 0 && row.stopCommitReductionUnits === 0)).toBe(true);
    for (const type of ["submitted", "acknowledged", "started"] as const) await f.milestone(value.id, type);
    const current = await basis(value.id);
    for (const row of current.reservations) {
      expect(row.grossCommittedUnits).toBe(6 * row.unitsPerItem);
      expect(row.stopReleasedUnits).toBe(4 * row.unitsPerItem); expect(row.stopCommitReductionUnits).toBe(0);
      expect(row.grossCommittedUnits + row.stopReleasedUnits).toBe(row.totalUnits);
    }
    expect(current.currentQuantities).toEqual(physical(6, 0, 0, 0));
  });

  it("does not resume a cancellation request without an actual approved partial-stop receipt", async () => {
    const value = await f.scenario(3);
    for (const type of ["submitted", "acknowledged", "started", "cancel_requested"] as const) await f.milestone(value.id, type);
    const before = await f.state();
    await expect(f.milestone(value.id, "started")).rejects.toSatisfy(publicError(409, "production_quantity_resume_required"));
    expect(await f.state()).toEqual(before);
  });

  it("explicitly resumes and finishes only the remaining real pieces without cancelling them or inspecting the original total", async () => {
    const value = await f.scenario(3);
    for (const type of ["submitted", "acknowledged", "started", "cancel_requested"] as const) await f.milestone(value.id, type);
    await approved(value.id, physical(1, 1, 1, 0), 1);
    expect((await owner.production.get(owner.context, value.id)).productionOrder.status).toBe("cancel_requested");
    const stopped = await f.state();
    await expect(f.milestone(value.id, "cancelled")).rejects.toSatisfy(publicError(409, "production_quantity_partial_cancel_blocked"));
    expect(await f.state()).toEqual(stopped);
    await f.milestone(value.id, "started");
    const resumed = await f.state();
    await expect(f.milestone(value.id, "completed")).rejects.toSatisfy(publicError(409, "production_quantity_remaining_not_complete"));
    expect(await f.state()).toEqual(resumed);
    await approved(value.id, physical(0, 0, 2, 0), 0);
    expect((await owner.production.get(owner.context, value.id)).productionOrder.status).toBe("in_production");
    await f.milestone(value.id, "completed");
    const standard = await owner.production.createQualityStandard(owner.context, CreateQualityStandardInputSchema.parse({
      name: `Synthetic actual remaining QC ${createEntityId()}`, minimumScoreBps: 9000,
      criteria: [{ code: "REMAINING", label: "Synthetic remaining physical pieces", weightBps: 10000, blocking: true }],
    }));
    const current = await owner.production.qualityGroups(owner.context, value.id);
    expect(current.quantity).toBe(2);
    const result = await owner.production.inspectGroups(owner.context, value.id, RecordQualityGroupsInputSchema.parse({ formatVersion: 3,
      productionVersionId: current.productionVersionId, expectedProductionProjectionVersion: current.projectionVersion,
      expectedRootInspectionId: current.rootInspectionId, parentGroupId: null, qualityStandardVersionId: standard.id,
      inspectedAt: (await owner.clock()).now, segregationConfirmed: true, idempotencyKey: randomUUID(),
      groups: [{ key: "REMAINING", label: "Synthetic actual two finished pieces", quantity: 2,
        criterionResults: [{ code: "REMAINING", scoreBps: 10000, passed: true, evidenceAssetIds: [] }], defects: [] }] }));
    expect(result.workspace.groups).toHaveLength(1); expect(result.workspace.groups[0]).toMatchObject({ quantity: 2, result: "passed" });
    expect((await shipping.productionSources(owner.context, value.source.order.id)).find(row => row.productionOrderId === value.id))
      .toMatchObject({ quantity: 2, availableQuantity: 2 });
    expect((await owner.production.get(owner.context, value.id)).versions[0]!.quantity).toBe(3);
  });

  it("keeps a prior whole QC quantity at its actual execution time while a later approved count and new QC cover fewer pieces", async () => {
    const value = await f.scenario(5);
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const) await f.milestone(value.id, type);
    const standard = await owner.production.createQualityStandard(owner.context, CreateQualityStandardInputSchema.parse({
      name: `Synthetic as-of whole QC ${createEntityId()}`, minimumScoreBps: 9000,
      criteria: [{ code: "ACTUAL", label: "Synthetic actual physical inspection", weightBps: 10000, blocking: true }],
    }));
    async function inspect(passed: boolean) {
      const current = await owner.production.get(owner.context, value.id);
      return owner.production.inspect(owner.context, value.id, RecordQualityInspectionInputSchema.parse({ qualityStandardVersionId: standard.id,
        expectedProductionProjectionVersion: current.productionOrder.projectionVersion, result: passed ? "passed" : "failed", scoreBps: passed ? 10000 : 0,
        assessment: { formatVersion: 2, criterionResults: [{ code: "ACTUAL", scoreBps: passed ? 10000 : 0, passed, evidenceAssetIds: [] }] },
        inspectedAt: (await owner.clock()).now, evidenceAssetIds: [], idempotencyKey: randomUUID(),
        defects: passed ? [] : [{ code: "ACTUAL", severity: "major", responsibility: "supplier", disposition: "rework", note: "Synthetic whole batch held for real recount", evidenceAssetIds: [] }] }));
    }
    const original = await inspect(false), oldId = original.inspections[0]!.id;
    await approved(value.id, physical(0, 0, 2, 3), 0);
    const current = await inspect(true), newId = current.inspections[0]!.id;
    const coverage = await withTenant(database.db, owner.context, tx => tx.select({ id: qualityInspections.id,
      covered: sql<number>`${productionInspectedQuantity(sql`${value.id}::uuid`, sql`${qualityInspections.createdAt}`)}` })
      .from(qualityInspections).where(eq(qualityInspections.productionOrderId, value.id)));
    expect(coverage.find(row => row.id === oldId)?.covered).toBe(5); expect(coverage.find(row => row.id === newId)?.covered).toBe(2);
    const [unknown] = await withTenant(database.db, owner.context, tx => tx.execute<{ covered: number }>(sql`select ${productionInspectedQuantity(sql`${value.id}::uuid`, sql`null::timestamptz`)} as covered`));
    expect(unknown?.covered).toBe(0);
    expect((await shipping.productionSources(owner.context, value.source.order.id)).find(row => row.productionOrderId === value.id))
      .toMatchObject({ quantity: 2, availableQuantity: 2 });
    expect((await owner.production.get(owner.context, value.id)).inspections.find(row => row.id === oldId)).toEqual(original.inspections[0]);
  });

  it("chains prior stops without resurrecting original quantities or changing the first receipt", async () => {
    const value = await f.scenario(), first = await approved(value.id, physical(10, 0, 0, 0), 3);
    const second = await approved(value.id, physical(4, 2, 1, 0), 2);
    expect(second.actual.review).toMatchObject({ sequence: 2, previousReviewId: first.actual.review.id,
      cumulativeStoppedQuantity: 5, quantities: physical(2, 2, 1, 0) });
    const before = await f.state(), replay = await new ProductionQuantityService(database, owner.audit).review(owner.context, value.id, first.review);
    expect(replay).toMatchObject({ replayed: true, review: first.actual.review }); expect(await f.state()).toEqual(before);
    const bad = await reported(value.id, physical(2, 2, 0, 0)), reportState = await f.state();
    await expect(f.quantities.review(owner.context, value.id, bad.review)).rejects.toSatisfy(publicError(409, "production_quantity_balance_invalid"));
    expect(await f.state()).toEqual(reportState);
  });

  it.each([
    { label: "scrap", prior: physical(4, 2, 2, 2), later: physical(4, 2, 3, 1) },
    { label: "completed plus scrap", prior: physical(4, 2, 3, 1), later: physical(4, 3, 2, 1) },
    { label: "all pieces already started", prior: physical(4, 3, 2, 1), later: physical(5, 2, 2, 1) },
  ])("does not move the $label lower bound back into unstarted stock", async ({ prior, later }) => {
    const value = await f.scenario(); await approved(value.id, prior, 0);
    const input = await reported(value.id, later), before = await f.state();
    await expect(f.quantities.review(owner.context, value.id, input.review)).rejects.toSatisfy(publicError(409, "production_quantity_lower_bound_conflict"));
    expect(await f.state()).toEqual(before);
  });

  it("fences the original production version, projection, prior review and fingerprint instead of silently refreshing them", async () => {
    const value = await f.scenario(), report = await reported(value.id, physical(10, 0, 0, 0));
    for (const changed of [
      { expectedProductionProjectionVersion: report.basis.projectionVersion + 1 },
      { expectedReviewId: createEntityId() }, { expectedBasisFingerprint: "0".repeat(64) },
    ]) {
      const before = await f.state();
      await expect(f.quantities.review(owner.context, value.id, { ...report.review, ...changed })).rejects.toSatisfy(publicError(409, "production_quantity_basis_changed"));
      expect(await f.state()).toEqual(before);
    }
    await expect(f.quantities.recordReport(owner.context, value.id, { ...report.input, idempotencyKey: randomUUID(), productionVersionId: createEntityId() }))
      .rejects.toSatisfy(publicError(409, "production_quantity_basis_changed"));
    await f.milestone(value.id, "submitted"); const current = await f.state();
    await expect(f.quantities.review(owner.context, value.id, report.review)).rejects.toSatisfy(publicError(409, "production_quantity_basis_changed"));
    expect(await f.state()).toEqual(current);
  });

  it("binds exact report and review recovery to their actor, target and complete original body", async () => {
    const value = await f.scenario(), other = await f.scenario(), colleague = await freshActor();
    const result = await approved(value.id, physical(10, 0, 0, 0), 2), before = await f.state();
    const fresh = new ProductionQuantityService(database, owner.audit);
    expect(await fresh.recordReport(owner.context, value.id, result.input)).toMatchObject({ replayed: true, report: result.saved.report });
    expect(await fresh.review(owner.context, value.id, result.review)).toMatchObject({ replayed: true, review: result.actual.review });
    for (const [context, target, body] of [[colleague, value.id, result.review], [owner.context, other.id, result.review],
      [owner.context, value.id, { ...result.review, stoppedDelta: 1 }]] as const)
      await expect(fresh.review(context, target, body)).rejects.toSatisfy(publicError(409, "production_quantity_request_mismatch"));
    await expect(fresh.recordReport(colleague, value.id, result.input)).rejects.toSatisfy(publicError(409, "production_quantity_request_mismatch"));
    await expect(fresh.recordReport(owner.context, value.id, { ...result.input, evidenceCode: "SYNTHETIC_CHANGED" }))
      .rejects.toSatisfy(publicError(409, "production_quantity_request_mismatch"));
    expect(await f.state()).toEqual(before);
  });

  it("lets only one competing review consume the same prior basis and records one paired effect per pool", async () => {
    const value = await f.scenario(), a = await reported(value.id, physical(10, 0, 0, 0)), b = await reported(value.id, physical(10, 0, 0, 0));
    const attempts = await Promise.allSettled([a, b].map(item => f.quantities.review(owner.context, value.id,
      { ...item.review, stoppedDelta: 6, unstartedAcrossAllPoolsConfirmed: true })));
    expect(attempts.filter(row => row.status === "fulfilled")).toHaveLength(1);
    const failed = attempts.find(row => row.status === "rejected");
    expect(failed?.status === "rejected" && publicError(409, "production_quantity_basis_changed")(failed.reason)).toBe(true);
    expect((await basis(value.id)).cumulativeStoppedQuantity).toBe(6); expect(await effects(value.id)).toHaveLength(2);
    const [count] = await withTenant(database.db, owner.context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count from audit_events
      where action='production.quantity.reviewed' and metadata->>'productionOrderId'=${value.id}`));
    expect(count?.count).toBe(1);
  });

  it("preserves actual passed QC and physical handover lower bounds even after a return carrier event", async () => {
    const value = await f.scenario(5), qc = await grouped(value, 5);
    let order = await owner.orders.ingestNormalized(owner.context, { accountId: owner.owner.accountId, platform: "etsy", externalEventId: randomUUID(),
      externalOrderId: value.source.order.externalOrderId, providerStatus: "paid", placedAt: value.source.order.placedAt,
      orderTotal: null, lines: value.source.order.lines.map(line => ({ externalLineId: line.externalLineId, externalListingId: line.externalListingId,
        skuCode: line.skuCode, title: line.title, quantity: line.quantity, unitPrice: line.unitPrice, customizationCount: line.customizationCount })), redactedSource: { synthetic: true },
      protectedDetails: { buyer: { name: "Synthetic quantity buyer", email: null, phone: null }, shippingAddress: {
        recipient: "Synthetic quantity recipient", lines: ["1 Synthetic Test Way"], city: "Synthetic", region: "CA", postalCode: "90001", countryCode: "US" }, customizations: [] } });
    for (const toState of ["awaiting_quality_control", "awaiting_shipment"] as const)
      order = await owner.orders.transition(owner.context, order.id, { toState, expectedSequence: order.latestEventSequence, idempotencyKey: randomUUID(), reason: "Synthetic passed physical batch" });
    const source = (await shipping.productionSources(owner.context, order.id)).find(row => row.qualityGroupId === qc.workspace.groups[0]!.id);
    if (!source) throw new Error("Synthetic physical shipment must use its real passed group");
    const shipment = await shipping.create(owner.context, order.id, CreateShipmentInputSchema.parse({ shipDate: (await owner.clock()).now, shipFromCountryCode: "US", idempotencyKey: randomUUID(),
      packages: [{ packageReferenceId: randomUUID(), trackingNumber: randomUUID(), carrierCode: "SYNTHETIC", carrierName: "Synthetic carrier", carrierService: "Synthetic pickup",
        lines: [{ orderLineId: value.source.lineId, quantity: 5, productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
          qualityInspectionId: source.qualityInspectionId, qualityGroupId: source.qualityGroupId, expectedProductionProjectionVersion: source.projectionVersion, quantity: 5 }] }] }] }));
    await shipping.reviewVersion(owner.context, shipment.shipment.id, shipment.versions[0]!.id, { decision: "approved", expectedCurrentVersion: 1,
      reasonCode: "SYNTHETIC_QUANTITY_SHIPMENT", reason: "Synthetic original group rechecked", idempotencyKey: randomUUID() });
    await shipping.dispatch(owner.context, shipment.shipment.id, { expectedVersion: 1, reason: "Synthetic actual physical pickup", occurredAt: (await owner.clock()).now, idempotencyKey: randomUUID() });
    await shipping.recordTrackingEvent(owner.context, shipment.shipment.id, { packageId: shipment.packages[0]!.id, status: "returned", provider: "synthetic",
      externalEventId: randomUUID(), detailCode: "SYNTHETIC_RETURNED", occurredAt: (await owner.clock()).now, estimatedDeliveryAt: null });
    expect(await basis(value.id)).toMatchObject({ groupedQuantity: 5, groupedPassedQuantity: 5, allocatedQuantity: 5, shippedQuantity: 5, completedLowerBound: 5 });
    const bad = await reported(value.id, physical(1, 0, 4, 0)), before = await f.state();
    await expect(f.quantities.review(owner.context, value.id, { ...bad.review, stoppedDelta: 1, unstartedAcrossAllPoolsConfirmed: true }))
      .rejects.toSatisfy(publicError(409, "production_quantity_lower_bound_conflict"));
    expect(await f.state()).toEqual(before); expect((await basis(value.id)).shippedQuantity).toBe(5);
  });

  it("keeps the original held group occupied by a real remake after the child records a partial stop", async () => {
    const value = await f.scenario(5), inspection = await grouped(value, 2), held = inspection.workspace.groups.find(row => row.result === "failed");
    if (!held) throw new Error("Synthetic remake requires an actual segregated held group");
    const understated = await reported(value.id, physical(0, 1, 2, 2)), before = await f.state();
    await expect(f.quantities.review(owner.context, value.id, understated.review)).rejects.toSatisfy(publicError(409, "production_quantity_lower_bound_conflict"));
    expect(await f.state()).toEqual(before);
    const input = { type: "remake", originalProductionOrderId: value.id, qualityGroupId: held.id, defectId: held.defects[0]!.id,
      remakeQuantity: 2, expectedProductionProjectionVersion: inspection.workspace.projectionVersion, physicalSelectionConfirmed: true,
      manufacturing: value.source.input.manufacturing, capacityPlan: value.source.input.capacityPlan,
      reason: "Synthetic original held pieces", expectedCompletionAt: value.source.input.expectedCompletionAt, idempotencyKey: randomUUID() };
    const recovery = await owner.production.recover(owner.context, input), child = recovery.replacementProductionOrderId;
    if (!child) throw new Error("Synthetic remake must create its actual replacement production");
    await approved(child, physical(2, 0, 0, 0), 1);
    expect((await owner.production.qualityGroups(owner.context, value.id)).groups.find(row => row.id === held.id))
      .toMatchObject({ quantity: 3, remakeQuantity: 1, remainingRemakeQuantity: 2 });
    expect((await native.detail(owner.context, value.source.lineId, {})).line).toMatchObject({ quantity: 5, allocatedQuantity: 5 });
    await expect(owner.production.recover(owner.context, { ...input, defectId: held.defects[1]!.id, remakeQuantity: 3, idempotencyKey: randomUUID() }))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it.each(["report", "review"] as const)("rolls back the %s and every paired capacity effect when its same-transaction audit fails", async operation => {
    const value = await f.scenario(), report = operation === "review" ? await reported(value.id, physical(10, 0, 0, 0)) : undefined;
    const before = await f.state(), action = operation === "report" ? "production.quantity.report_recorded" : "production.quantity.reviewed";
    const actual = owner.audit.recordInTransaction.bind(owner.audit); let reached = false;
    vi.spyOn(owner.audit, "recordInTransaction").mockImplementation(async (tx, context, event) => {
      if (event.action === action) {
        reached = true;
        if (operation === "review") {
          const [count] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from factory_capacity_stop_effects where review_id=${event.resourceId}::uuid`);
          expect(count?.count).toBe(2);
        }
        throw new Error("Synthetic quantity audit unavailable");
      }
      return actual(tx, context, event);
    });
    const input = report ? { ...report.review, stoppedDelta: 2, unstartedAcrossAllPoolsConfirmed: true } : await f.reportInput(await basis(value.id), physical(10, 0, 0, 0));
    await expect(operation === "report" ? f.quantities.recordReport(owner.context, value.id, input) : f.quantities.review(owner.context, value.id, input))
      .rejects.toThrow("Synthetic quantity audit unavailable");
    expect(reached).toBe(true); expect(await f.state()).toEqual(before);
  });

  it("enforces the current per-permission scope and request ceiling before old-key recovery", async () => {
    const value = await f.scenario(), saved = await approved(value.id, physical(10, 0, 0, 0), 1), ceiling = owner.context;
    await owner.grant([Permission.OrderWrite], "self", [Permission.OrderRead]);
    const mixed = await owner.current();
    expect((await f.quantities.workspace(mixed, value.id, {})).access).toEqual({ canRead: true, canWrite: false });
    await expect(f.quantities.review(mixed, value.id, saved.review)).rejects.toBeInstanceOf(ForbiddenError);
    await owner.grant();
    const readOnly: TenantContext = { ...ceiling, permissions: [Permission.OrderRead], permissionScopes: { [Permission.OrderRead]: "tenant" } };
    await expect(f.quantities.recordReport(readOnly, value.id, saved.input)).rejects.toBeInstanceOf(ForbiddenError);
    await owner.grant([Permission.OrderRead]);
    await expect(f.quantities.review(ceiling, value.id, saved.review)).rejects.toBeInstanceOf(ForbiddenError);
    await owner.grant([Permission.OrderWrite]);
    await expect(f.quantities.workspace(ceiling, value.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    await withTenant(database.db, owner.seed(), tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, owner.owner.membershipId)));
    await expect(f.quantities.workspace(ceiling, value.id, {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("hides reports, reviews and effects from another real tenant and rejects a foreign report parent", async () => {
    const value = await f.scenario(), another = await f.scenario(), saved = await approved(value.id, physical(10, 0, 0, 0), 2);
    await expect(f.quantities.workspace(owner.foreignContext, value.id, {})).rejects.toBeInstanceOf(NotFoundException);
    for (const table of [productionQuantityReports, productionQuantityReviews, factoryCapacityStopEffects])
      expect(await withTenant(database.db, owner.foreignContext, tx => tx.select().from(table))).toEqual([]);
    const current = await basis(another.id), input = await f.reviewInput(current, saved.saved.report.id, 0);
    await expect(f.quantities.review(owner.context, another.id, input)).rejects.toSatisfy(publicError(404, "production_quantity_report_not_found"));
  });

  it("pages complete original report and review receipts without accepting a different production anchor", async () => {
    const value = await f.scenario(), original = [];
    for (let i = 0; i < 3; i++) original.push(await approved(value.id, physical(10 - i, 0, 0, 0), 1));
    const a = await f.quantities.workspace(owner.context, value.id, { limit: 2 });
    expect(a.reports.map(row => row.id)).toEqual(original.slice().reverse().slice(0, 2).map(row => row.saved.report.id));
    expect(a.reviews.map(row => row.id)).toEqual(original.slice().reverse().slice(0, 2).map(row => row.actual.review.id));
    const b = await f.quantities.workspace(owner.context, value.id, { limit: 2, reportsBefore: a.reportsNextCursor, reviewsBefore: a.reviewsNextCursor });
    expect(b.reports.map(row => row.id)).toEqual([original[0]!.saved.report.id]); expect(b.reviews.map(row => row.id)).toEqual([original[0]!.actual.review.id]);
    expect(b.reportsNextCursor).toBeNull(); expect(b.reviewsNextCursor).toBeNull();
    const another = await f.scenario(), before = await f.state();
    await expect(f.quantities.workspace(owner.context, another.id, { reportsBefore: a.reports[0]!.id })).rejects.toSatisfy(publicError(400, "production_quantity_cursor_invalid"));
    expect(await f.state()).toEqual(before);
  });

  it("rejects future or nonrepresentable evidence times and never moves review time before its original report", async () => {
    const value = await f.scenario(), original = await basis(value.id), input = await f.reportInput(original, physical(10, 0, 0, 0)), before = await f.state();
    await expect(f.quantities.recordReport(owner.context, value.id, { ...input, observedAt: "9999-12-31T00:00:00.000Z" }))
      .rejects.toSatisfy(publicError(422, "production_quantity_time_invalid"));
    await expect(f.quantities.recordReport(owner.context, value.id, { ...input, observedAt: input.observedAt.replace(/\.\d{3}Z$/, ".0001Z") }))
      .rejects.toSatisfy(publicError(422, "production_quantity_time_invalid"));
    expect(await f.state()).toEqual(before);
    const saved = await f.quantities.recordReport(owner.context, value.id, input), review = await f.reviewInput(original, saved.report.id, 0), state = await f.state();
    await expect(f.quantities.review(owner.context, value.id, { ...review, occurredAt: new Date(Date.parse(input.observedAt) - 1).toISOString() }))
      .rejects.toSatisfy(publicError(422, "production_quantity_time_invalid"));
    expect(await f.state()).toEqual(state);
  });

  // Raw controls below supply the legitimate birth, report, original body hash,
  // projection and audit so an earlier unrelated guard cannot mask each target.
  function identity(operation: "report" | "review", id: string, input: ProductionQuantityReportInput | ProductionQuantityReviewInput) {
    const requestCanonical = canonicalJson({ version: 1, operation, productionOrderId: id, input });
    return { requestCanonical, requestChecksum: createHash("sha256").update(requestCanonical).digest("hex") };
  }
  async function rawReport(tx: TenantTransaction, id: string, original: ProductionQuantityBasis, input: ProductionQuantityReportInput, audit = true) {
    const [row] = await tx.insert(productionQuantityReports).values({ id: createEntityId(), tenantId: owner.context.tenantId, productionOrderId: id,
      productionVersionId: original.productionVersionId, previousReviewId: original.reviewId, basisFingerprint: original.fingerprint,
      input, idempotencyKey: input.idempotencyKey, ...identity("report", id, input), createdBy: owner.context.userId }).returning();
    if (!row) throw new Error("Synthetic raw report missing");
    if (audit) await owner.audit.recordInTransaction(tx, owner.context, { action: "production.quantity.report_recorded", resourceType: "production_quantity_report", resourceId: row.id,
      result: "success", metadata: { productionOrderId: id, productionVersionId: original.productionVersionId } });
    return row;
  }
  async function rawReview(tx: TenantTransaction, id: string, original: ProductionQuantityBasis, report: { id: string; input: ProductionQuantityReportInput }, input: ProductionQuantityReviewInput,
    options: { effects?: number; audit?: boolean; projection?: boolean; counts?: ProductionPhysicalQuantities } = {}) {
    const current = report.input.quantities;
    const quantities = options.counts ?? physical((current.unstartedQuantity ?? 0) - input.stoppedDelta, current.inProcessQuantity ?? 0, current.completedQuantity ?? 0, current.scrappedQuantity ?? 0);
    const prior = original.reviewId ? await tx.select().from(productionQuantityReviews).where(eq(productionQuantityReviews.id, original.reviewId)) : [];
    const [row] = await tx.insert(productionQuantityReviews).values({ id: createEntityId(), tenantId: owner.context.tenantId, productionOrderId: id,
      productionVersionId: original.productionVersionId, reportId: report.id, sequence: (prior[0]?.sequence ?? 0) + 1, previousReviewId: original.reviewId,
      input, quantities, stoppedDelta: input.stoppedDelta, cumulativeStoppedQuantity: original.cumulativeStoppedQuantity + input.stoppedDelta,
      creationTransactionId: sql`pg_current_xact_id()::text`, idempotencyKey: input.idempotencyKey, ...identity("review", id, input), createdBy: owner.context.userId }).returning();
    if (!row) throw new Error("Synthetic raw review missing");
    for (const reservation of original.reservations.slice(0, options.effects ?? original.reservations.length)) {
      if (!input.stoppedDelta) continue;
      const releasedUnits = input.stoppedDelta * reservation.unitsPerItem;
      await tx.insert(factoryCapacityStopEffects).values({ id: createEntityId(), tenantId: owner.context.tenantId, reviewId: row.id, reservationId: reservation.reservationId,
        stoppedQuantity: input.stoppedDelta, releasedUnits, commitReductionUnits: Math.min(releasedUnits, reservation.grossCommittedUnits - reservation.stopCommitReductionUnits), createdBy: owner.context.userId });
    }
    if (options.projection !== false) await tx.update(productionOrders).set({ projectionVersion: original.projectionVersion + 1 }).where(eq(productionOrders.id, id));
    if (options.audit !== false) await owner.audit.recordInTransaction(tx, owner.context, { action: "production.quantity.reviewed", resourceType: "production_quantity_review", resourceId: row.id,
      result: "success", metadata: { productionOrderId: id, productionVersionId: original.productionVersionId, reportId: report.id, sequence: row.sequence, stoppedDelta: input.stoppedDelta } });
    return row;
  }

  it("raw control: a real app-role report, review, both pool effects and audit pass immediate closure before an explicit rollback", async () => {
    const value = await f.scenario(), original = await basis(value.id), input = await f.reportInput(original, physical(10, 0, 0, 0)), before = await f.state();
    let closed = false;
    await expect(withTenant(database.db, owner.context, async tx => {
      const [role] = await tx.execute<{ role: string; forced: boolean }>(sql`select current_user as role,(select relforcerowsecurity from pg_class where oid='production_quantity_reviews'::regclass) as forced`);
      expect(role).toMatchObject({ role: "yummyai_app", forced: true });
      const report = await rawReport(tx, value.id, original, input), review = await f.reviewInput(original, report.id, 2);
      await rawReview(tx, value.id, original, report, review);
      await tx.execute(sql`set constraints all immediate`); closed = true;
      throw new Error("Synthetic raw quantity control rollback");
    })).rejects.toThrow("Synthetic raw quantity control rollback");
    expect(closed).toBe(true); expect(await f.state()).toEqual(before);
  });

  it("raw SQL cannot review unknown counts or mint capacity from a caller supplied marker", async () => {
    const value = await f.scenario(), report = await reported(value.id, physical(null, null, null, null)), before = await f.state();
    await expect(withTenant(database.db, owner.context, async tx => {
      await tx.execute(sql`select set_config('app.production_quantity_reviewed','true',true)`);
      await rawReview(tx, value.id, report.basis, report.saved.report, { ...report.review, stoppedDelta: 1, unstartedAcrossAllPoolsConfirmed: true }, { counts: physical(0, 0, 0, 0) });
    })).rejects.toSatisfy(sqlError("production_quantity_unknown_not_reviewable"));
    expect(await f.state()).toEqual(before);
  });

  it("raw SQL cannot commit a stop for only one of the two original resource reservations", async () => {
    const value = await f.scenario(), report = await reported(value.id, physical(10, 0, 0, 0)), before = await f.state();
    await expect(withTenant(database.db, owner.context, tx => rawReview(tx, value.id, report.basis, report.saved.report,
      { ...report.review, stoppedDelta: 2, unstartedAcrossAllPoolsConfirmed: true }, { effects: 1 })))
      .rejects.toSatisfy(sqlError("production_quantity_all_stop_effects_required"));
    expect(await f.state()).toEqual(before);
  });

  it.each(["audit", "projection"] as const)("raw SQL cannot commit an otherwise complete review without its actual %s", async missing => {
    const value = await f.scenario(), report = await reported(value.id, physical(10, 0, 0, 0)), before = await f.state();
    await expect(withTenant(database.db, owner.context, tx => rawReview(tx, value.id, report.basis, report.saved.report,
      { ...report.review, stoppedDelta: 2, unstartedAcrossAllPoolsConfirmed: true }, { [missing]: false })))
      .rejects.toSatisfy(sqlError("production_quantity_review_owner_closure_required"));
    expect(await f.state()).toEqual(before);
  });

  it("raw SQL cannot commit an unaudited report even when its original input and hash are exact", async () => {
    const value = await f.scenario(), original = await basis(value.id), input = await f.reportInput(original, physical(10, 0, 0, 0)), before = await f.state();
    await expect(withTenant(database.db, owner.context, tx => rawReport(tx, value.id, original, input, false)))
      .rejects.toSatisfy(sqlError("production_quantity_report_audit_required"));
    expect(await f.state()).toEqual(before);
  });

  it.each([
    { label: "completion while some pieces are still unstarted or in process", status: "completed", code: "production_quantity_remaining_not_complete" },
    { label: "resuming a stop request without approved partial quantity", status: "in_production", code: "production_quantity_resume_required" },
  ])("raw status: rejects $label despite a correctly scoped same-transaction milestone audit", async ({ status, code }) => {
    const value = await f.scenario(3);
    for (const type of ["submitted", "acknowledged", "started"] as const) await f.milestone(value.id, type);
    if (status === "completed") await approved(value.id, physical(1, 1, 1, 0), 0);
    else await f.milestone(value.id, "cancel_requested");
    const before = await f.state();
    await expect(withTenant(database.db, owner.context, async tx => {
      await owner.audit.recordInTransaction(tx, owner.context, { action: "production_order.milestone", resourceType: "production_order", resourceId: value.id,
        result: "success", metadata: { type: status === "completed" ? "completed" : "started" } });
      await tx.update(productionOrders).set({ status, projectionVersion: sql`${productionOrders.projectionVersion}+1` }).where(eq(productionOrders.id, value.id));
    })).rejects.toSatisfy(sqlError(code));
    expect(await f.state()).toEqual(before);
  });

  it("raw SQL cannot reuse a committed review in a later transaction to release an unrelated reservation", async () => {
    const value = await f.scenario(), other = await f.scenario(), saved = await approved(value.id, physical(10, 0, 0, 0), 1);
    const reservation = (await basis(other.id)).reservations[0]!, before = await f.state();
    await expect(withTenant(database.db, owner.context, tx => tx.insert(factoryCapacityStopEffects).values({ id: createEntityId(), tenantId: owner.context.tenantId,
      reviewId: saved.actual.review.id, reservationId: reservation.reservationId, stoppedQuantity: 1, releasedUnits: reservation.unitsPerItem, commitReductionUnits: 0, createdBy: owner.context.userId })))
      .rejects.toSatisfy(sqlError("factory_capacity_actual_stop_required"));
    expect(await f.state()).toEqual(before);
  });

  it("raw SQL cannot alter an original rate or append a foreign effect after constraints were flushed", async () => {
    const value = await f.scenario(), other = await f.scenario(), report = await reported(value.id, physical(10, 0, 0, 0));
    const foreign = (await basis(other.id)).reservations[0]!, before = await f.state(); let flushed = false;
    const original = report.basis.reservations[0]!;
    await expect(withTenant(database.db, owner.context, async tx => {
      const review = await rawReview(tx, value.id, report.basis, report.saved.report,
        { ...report.review, stoppedDelta: 1, unstartedAcrossAllPoolsConfirmed: true }, { effects: 0 });
      await tx.insert(factoryCapacityStopEffects).values({ id: createEntityId(), tenantId: owner.context.tenantId, reviewId: review.id,
        reservationId: original.reservationId, stoppedQuantity: 1, releasedUnits: original.unitsPerItem + 1, commitReductionUnits: 0, createdBy: owner.context.userId });
    })).rejects.toSatisfy(sqlError("factory_capacity_actual_stop_required"));
    expect(await f.state()).toEqual(before);
    await expect(withTenant(database.db, owner.context, async tx => {
      const review = await rawReview(tx, value.id, report.basis, report.saved.report, { ...report.review, stoppedDelta: 1, unstartedAcrossAllPoolsConfirmed: true });
      await tx.execute(sql`set constraints all immediate`); flushed = true;
      await tx.insert(factoryCapacityStopEffects).values({ id: createEntityId(), tenantId: owner.context.tenantId, reviewId: review.id,
        reservationId: foreign.reservationId, stoppedQuantity: 1, releasedUnits: foreign.unitsPerItem, commitReductionUnits: 0, createdBy: owner.context.userId });
    })).rejects.toSatisfy(sqlError("factory_capacity_actual_stop_required"));
    expect(flushed).toBe(true); expect(await f.state()).toEqual(before);
  });

  it("preserves immutable reports, reviews and paired effects under the non-owner role", async () => {
    const value = await f.scenario(), saved = await approved(value.id, physical(10, 0, 0, 0), 1), rows = await effects(value.id), before = await f.state();
    for (const [table, id] of [["production_quantity_reports", saved.saved.report.id], ["production_quantity_reviews", saved.actual.review.id], ["factory_capacity_stop_effects", rows[0]!.id]]) {
      for (const statement of [sql`update ${sql.identifier(table!)} set created_at=created_at where id=${id}::uuid`, sql`delete from ${sql.identifier(table!)} where id=${id}::uuid`])
        await expect(withTenant(database.db, owner.context, tx => tx.execute(statement))).rejects.toSatisfy((error: unknown) => pg(error).code === "42501");
    }
    expect(await f.state()).toEqual(before);
  });
});
