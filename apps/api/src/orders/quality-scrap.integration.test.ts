import { createHash, randomUUID } from "node:crypto";
import { ConflictException, HttpException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission, erpPermissionContext } from "@yummyai/authz";
import { CreateProductionRecoveryInputSchema, CreateShipmentInputSchema, RecordQualityInspectionInputSchema, createEntityId, type RecordQualityInspectionInput } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { QualityScrapResultSchema, QualityScrapWorkspaceSchema, type AllocateQualityScrapInput } from "@yummyai/contracts/order/quality-scrap";
import { connectDatabase, memberships, productionOrders, productionRecoveryCases, qualityDefects, qualityScrapAllocations, qualityScrapReviews, withTenant, type TenantTransaction } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NativeProductionService } from "./native-production.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { QualityScrapService } from "./quality-scrap.service.js";
import { qualityScrapFixture, requireQualityScrapEnvironment, scrapPhysical } from "./quality-scrap.test-fixture.js";

requireQualityScrapEnvironment("current");
const publicError = (status: number, code: string) => (error: unknown) => error instanceof HttpException && error.getStatus() === status &&
  typeof error.getResponse() === "object" && (error.getResponse() as { code?: string }).code === code;
function pg(error: unknown): { code?: string; message?: string } {
  if (!error || typeof error !== "object") return {};
  if ("code" in error) return error as { code?: string; message?: string };
  return "cause" in error ? pg(error.cause) : {};
}
const sqlError = (message: string) => (error: unknown) => pg(error).code === "23514" && pg(error).message === message;

describe.sequential("fixed scrap lots and their original failed physical groups", () => {
  const database = connectDatabase(), f = qualityScrapFixture(database), owner = f.owner;
  const shipping = new OrderShipmentService(database, owner.vault, owner.orders, owner.audit, { enqueue: async () => undefined });
  const native = new NativeProductionService(database, owner.factories);
  beforeAll(() => owner.initialize());
  afterEach(async () => { vi.restoreAllMocks(); await owner.grant(); });
  afterAll(async () => { vi.restoreAllMocks(); await database.client.end(); });
  const basis = async (id: string) => (await f.scraps.workspace(owner.context, id, {})).basis;
  const allocate = async (value: { id: string }, groupId: string, sourceId: string, quantity: number) => f.scraps.allocate(owner.context, value.id,
    await f.allocationInput(await basis(value.id), [{ qualityGroupId: groupId, sourceQuantityReviewId: sourceId, quantity }]));

  it("fixes two scrapped pieces to the original six-piece failed group and reinspects only the four remaining physical pieces", async () => {
    const value = await f.ready(), original = await owner.production.get(owner.context, value.id), before = await f.state();
    const saved = QualityScrapResultSchema.parse(await f.scraps.allocate(owner.context, value.id, value.input));
    expect(saved).toMatchObject({ replayed: false, review: { productionOrderId: value.id, productionVersionId: value.versionId,
      rootInspectionId: value.root.inspectionId, quantityReviewId: value.count.reviewed.review.id, input: value.input } });
    const current = await basis(value.id);
    expect(current).toMatchObject({ actualScrappedQuantity: 2, mappedScrappedQuantity: 2, unassignedQuantity: 0, unassignedGroupQuantity: 0 });
    expect(current.groups.find(row => row.qualityGroupId === value.held.id)).toMatchObject({ quantity: 6, scrappedQuantity: 2, reinspectableQuantity: 4 });
    expect(current.lots).toContainEqual(expect.objectContaining({ sourceQuantityReviewId: value.count.reviewed.review.id, quantity: 2, allocatedQuantity: 2, remainingQuantity: 0 }));
    const after = await f.state();
    for (const table of ["factory_capacity_reservations", "factory_capacity_events", "factory_capacity_stop_effects", "production_order_versions", "production_manufacturing_bindings", "inventory_movements", "inventory_reservation_events"])
      expect(after[table], table).toBe(before[table]);
    const child = await f.inspect(value, [f.group("REPAIRED", 3, true), f.group("STILL_HELD", 1)], value.held.id);
    expect(child.workspace.groups.find(row => row.id === value.held.id)).toMatchObject({ quantity: 6, active: false, scrappedQuantity: 2, reinspectableQuantity: 0, remainingScrapRemakeQuantity: 2 });
    expect(child.workspace.groups.filter(row => row.parentGroupId === value.held.id && row.active).reduce((sum, row) => sum + row.quantity, 0)).toBe(4);
    expect(child.workspace.groups.find(row => row.id === value.good!.id)).toMatchObject({ quantity: 4, active: true });
    expect((await owner.production.get(owner.context, value.id)).versions).toEqual(original.versions);
    const sources = await shipping.productionSources(owner.context, value.source.order.id);
    expect(sources.filter(row => !row.blockers.length).reduce((sum, row) => sum + row.quantity, 0)).toBe(7);
    expect((await native.detail(owner.context, value.source.lineId, {})).line).toMatchObject({ quantity: 10, allocatedQuantity: 10 });
  });

  it("keeps the retired parent's two-piece scrap remake balance shared across its original defects", async () => {
    const value = await f.ready(); await f.scraps.allocate(owner.context, value.id, value.input);
    await f.inspect(value, [f.group("REPAIRED", 4, true)], value.held.id);
    const first = await f.remake(value, value.held.id, value.held.defects[0]!.id, 1);
    const attempts = await Promise.allSettled(value.held.defects.map(defect => f.remake(value, value.held.id, defect.id, 1)));
    expect(attempts.filter(row => row.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(row => row.status === "rejected")).toHaveLength(1);
    const group = (await owner.production.qualityGroups(owner.context, value.id)).groups.find(row => row.id === value.held.id)!;
    expect(group).toMatchObject({ quantity: 6, active: false, scrappedQuantity: 2, remakeQuantity: 2, remainingScrapRemakeQuantity: 0 });
    expect(group.replacements.some(row => row.productionOrderId === first.replacementProductionOrderId)).toBe(true);
    await expect(f.remake(value, value.held.id, value.held.defects[1]!.id, 1)).rejects.toBeInstanceOf(ConflictException);
    expect((await native.detail(owner.context, value.source.lineId, {})).line.allocatedQuantity).toBe(10);
  });

  it("never treats a zero-increment physical review as a new scrap lot or launders excluded before-root scrap", async () => {
    const value = await f.production();
    const first = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2));
    const root = await f.inspect(value, [f.group("GOOD", 4, true), f.group("HELD", 4)]), held = root.workspace.groups.find(row => row.result === "failed")!;
    let current = await basis(value.id);
    expect(current).toMatchObject({ actualScrappedQuantity: 2, outsideRootQuantity: 2, unassignedGroupQuantity: 0, ambiguousQuantity: 0 });
    expect(current.lots).toContainEqual(expect.objectContaining({ sourceQuantityReviewId: first.reviewed.review.id, quantity: 2, scope: "before_root" }));
    const same = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2)); current = await basis(value.id);
    expect(current.lots.map(row => row.sourceQuantityReviewId)).not.toContain(same.reviewed.review.id);
    const before = await f.state();
    for (const source of [first.reviewed.review.id, same.reviewed.review.id])
      await expect(f.scraps.allocate(owner.context, value.id, await f.allocationInput(current,
        [{ qualityGroupId: held.id, sourceQuantityReviewId: source, quantity: 1 }]))).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
    expect((await f.inspect(value, [f.group("REPAIRED", 4, true)], held.id)).workspace.groups.filter(row => row.active).reduce((sum, row) => sum + row.quantity, 0)).toBe(8);
  });

  it("blocks an observation made before QC but recorded afterwards instead of guessing which physical group lost those pieces", async () => {
    const value = await f.production(), observedAt = (await owner.clock()).now;
    const root = await f.inspect(value, [f.group("GOOD", 4, true), f.group("HELD", 6)]), held = root.workspace.groups.find(row => row.result === "failed")!;
    const count = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2), observedAt), current = await basis(value.id);
    expect(current).toMatchObject({ actualScrappedQuantity: 2, ambiguousQuantity: 2, mappedScrappedQuantity: 0 });
    expect(current.lots).toContainEqual(expect.objectContaining({ sourceQuantityReviewId: count.reviewed.review.id, scope: "ambiguous" }));
    const before = await f.state();
    await expect(allocate(value, held.id, count.reviewed.review.id, 2)).rejects.toBeInstanceOf(ConflictException);
    await expect(f.inspect(value, [f.group("REPAIRED", 6, true)], held.id)).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
  });

  it("spends only the newly added one when cumulative physical scrap increases from two to three", async () => {
    const value = await f.ready(); await f.scraps.allocate(owner.context, value.id, value.input);
    const next = await f.physicalReview(value, scrapPhysical(0, 0, 7, 3)), current = await basis(value.id);
    expect(current.lots.find(row => row.sourceQuantityReviewId === value.count.reviewed.review.id)).toMatchObject({ quantity: 2, allocatedQuantity: 2, remainingQuantity: 0 });
    expect(current.lots.find(row => row.sourceQuantityReviewId === next.reviewed.review.id)).toMatchObject({ quantity: 1, allocatedQuantity: 0, remainingQuantity: 1 });
    const before = await f.state();
    await expect(allocate(value, value.held.id, next.reviewed.review.id, 2)).rejects.toSatisfy(publicError(409, "quality_scrap_quantity_exceeded"));
    expect(await f.state()).toEqual(before);
    await allocate(value, value.held.id, next.reviewed.review.id, 1);
    expect(await basis(value.id)).toMatchObject({ actualScrappedQuantity: 3, mappedScrappedQuantity: 3, unassignedQuantity: 0 });
  });

  it("shares a single source lot across separate failed groups without minting one allowance per defect or group", async () => {
    const value = await f.production(), root = await f.inspect(value, [f.group("GOOD", 4, true), f.group("LEFT", 3), f.group("RIGHT", 3)]);
    const held = root.workspace.groups.filter(row => row.result === "failed"), count = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2));
    const input = await f.allocationInput(await basis(value.id), held.map(row => ({ qualityGroupId: row.id, sourceQuantityReviewId: count.reviewed.review.id, quantity: 1 })));
    await f.scraps.allocate(owner.context, value.id, input);
    expect((await basis(value.id)).lots.find(row => row.sourceQuantityReviewId === count.reviewed.review.id)).toMatchObject({ quantity: 2, allocatedQuantity: 2, remainingQuantity: 0 });
    const before = await f.state();
    await expect(allocate(value, held[0]!.id, count.reviewed.review.id, 1)).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
  });

  it("keeps wholly unknown physical counts as unknown and creates no allocation or capacity effects", async () => {
    const value = await f.scenario(); await f.report(value, scrapPhysical(null, null, null, null));
    const current = await basis(value.id); expect(current.actualScrappedQuantity).toBeNull(); expect(current.lots).toEqual([]);
    const before = await f.state();
    await expect(f.scraps.allocate(owner.context, value.id, { idempotencyKey: randomUUID(), productionVersionId: value.versionId,
      expectedProductionProjectionVersion: current.projectionVersion, expectedRootInspectionId: value.root.inspectionId,
      expectedQuantityReviewId: createEntityId(), expectedScrapReviewId: null, expectedBasisFingerprint: current.fingerprint,
      physicalSegregationConfirmed: true, occurredAt: (await owner.clock()).now, evidenceCode: "SYNTHETIC_UNKNOWN", evidenceAssetIds: [],
      allocations: [{ qualityGroupId: value.held!.id, sourceQuantityReviewId: createEntityId(), quantity: 1 }] })).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
  });

  it.each(["passed", "other production", "missing"] as const)("rejects a %s group without changing source-lot ownership", async selected => {
    const value = await f.ready(), other = selected === "other production" ? await f.scenario() : null;
    const groupId = selected === "passed" ? value.good!.id : other?.held?.id ?? createEntityId();
    const before = await f.state();
    await expect(f.scraps.allocate(owner.context, value.id, { ...value.input, allocations: [{ ...value.input.allocations[0]!, qualityGroupId: groupId }] })).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
  });

  it("fences the original version, root, physical review, previous allocation and complete basis instead of refreshing stale input", async () => {
    const value = await f.ready(), before = await f.state();
    for (const key of ["productionVersionId", "expectedRootInspectionId", "expectedQuantityReviewId", "expectedScrapReviewId"] as const)
      await expect(f.scraps.allocate(owner.context, value.id, { ...value.input, [key]: createEntityId() })).rejects.toSatisfy(publicError(409, "quality_scrap_basis_changed"));
    for (const change of [{ expectedProductionProjectionVersion: value.input.expectedProductionProjectionVersion + 1 }, { expectedBasisFingerprint: "f".repeat(64) }])
      await expect(f.scraps.allocate(owner.context, value.id, { ...value.input, ...change })).rejects.toSatisfy(publicError(409, "quality_scrap_basis_changed"));
    expect(await f.state()).toEqual(before);
  });

  it("recovers the exact immutable original under a fresh service and rejects changed actor, body or target", async () => {
    const value = await f.ready(), saved = await f.scraps.allocate(owner.context, value.id, value.input), colleague = await f.colleague(), other = await f.ready();
    await f.physicalReview(value, scrapPhysical(0, 0, 7, 3));
    const before = await f.state(), fresh = new QualityScrapService(database, owner.audit);
    expect(await fresh.allocate(owner.context, value.id, value.input)).toMatchObject({ replayed: true, review: saved.review });
    for (const change of [{ evidenceCode: "SYNTHETIC_CHANGED_BODY" }, { allocations: [{ ...value.input.allocations[0]!, quantity: 1 }] }])
      await expect(fresh.allocate(owner.context, value.id, { ...value.input, ...change })).rejects.toSatisfy(publicError(409, "quality_scrap_request_mismatch"));
    await expect(fresh.allocate(colleague, value.id, value.input)).rejects.toSatisfy(publicError(409, "quality_scrap_request_mismatch"));
    await expect(fresh.allocate(owner.context, other.id, value.input)).rejects.toSatisfy(publicError(409, "quality_scrap_request_mismatch"));
    expect(await f.state()).toEqual(before);
  });

  it("allows exactly one competing allocation to consume an original basis and records each lot only once", async () => {
    const value = await f.ready(), attempts = await Promise.allSettled([1, 2].map(() => f.scraps.allocate(owner.context, value.id,
      { ...value.input, idempotencyKey: randomUUID(), allocations: [{ ...value.input.allocations[0]!, quantity: 1 }] })));
    expect(attempts.filter(row => row.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(row => row.status === "rejected"); expect(rejected?.status === "rejected" && rejected.reason instanceof ConflictException).toBe(true);
    expect(await basis(value.id)).toMatchObject({ mappedScrappedQuantity: 1, unassignedQuantity: 1 });
    await allocate(value, value.held.id, value.count.reviewed.review.id, 1);
    expect(await basis(value.id)).toMatchObject({ mappedScrappedQuantity: 2, unassignedQuantity: 0 });
  });

  it("serializes allocation against reinspection without allowing unassigned scrap to become newly passed physical pieces", async () => {
    const value = await f.ready();
    const attempts = await Promise.allSettled([f.scraps.allocate(owner.context, value.id, value.input), f.inspect(value, [f.group("REPAIRED", 4, true)], value.held.id)]);
    expect(attempts[0]!.status).toBe("fulfilled"); expect(attempts[1]!.status).toBe("rejected");
    expect((await f.inspect(value, [f.group("REPAIRED", 4, true)], value.held.id)).workspace.groups.filter(row => row.parentGroupId === value.held.id && row.active).reduce((sum, row) => sum + row.quantity, 0)).toBe(4);
  });

  it("refuses to retire a parent with a still occupied original child even when that child is already completed", async () => {
    const value = await f.scenario(), held = value.held!;
    const replacement = await f.remake(value, held.id, held.defects[0]!.id, 2), id = replacement.replacementProductionOrderId!;
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const) {
      const actual = await owner.production.get(owner.context, id);
      await owner.production.recordMilestone(owner.context, id, { type, expectedProjectionVersion: actual.productionOrder.projectionVersion,
        externalEventId: randomUUID(), occurredAt: (await owner.clock()).now, evidence: { code: "SYNTHETIC_OLD_CHILD", note: null, assetIds: [] } });
    }
    const count = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2));
    await allocate(value, held.id, count.reviewed.review.id, 2);
    const before = await f.state();
    await expect(f.inspect(value, [f.group("REPAIRED", 4, true)], held.id)).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
    expect((await owner.production.qualityGroups(owner.context, value.id)).groups.find(row => row.id === held.id)).toMatchObject({ quantity: 6, active: true, remakeQuantity: 2 });
  });

  it("permits the smaller reinspection only after a real approved stop reduces the original pinned child net occupation to zero", async () => {
    const value = await f.scenario(), held = value.held!, replacement = await f.remake(value, held.id, held.defects[0]!.id, 2);
    const childId = replacement.replacementProductionOrderId!;
    const count = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2)); await allocate(value, held.id, count.reviewed.review.id, 2);
    await expect(f.inspect(value, [f.group("REPAIRED", 4, true)], held.id)).rejects.toBeInstanceOf(ConflictException);
    const report = await f.report({ id: childId }, scrapPhysical(2, 0, 0, 0));
    await f.quantities.review(owner.context, childId, { idempotencyKey: randomUUID(), reportId: report.saved.report.id,
      expectedProductionProjectionVersion: report.basis.projectionVersion, expectedReviewId: report.basis.reviewId,
      expectedBasisFingerprint: report.basis.fingerprint, stoppedDelta: 2, unstartedAcrossAllPoolsConfirmed: true,
      occurredAt: (await owner.clock()).now, evidenceCode: "SYNTHETIC_CHILD_UNSTARTED_STOP" });
    const current = await f.inspect(value, [f.group("REPAIRED", 4, true)], held.id);
    expect(current.workspace.groups.find(row => row.id === held.id)).toMatchObject({ active: false, quantity: 6, remakeQuantity: 0, remainingScrapRemakeQuantity: 2 });
    expect((await owner.production.get(owner.context, childId)).versions[0]!.quantity).toBe(2);
    expect((await native.detail(owner.context, value.source.lineId, {})).line.allocatedQuantity).toBe(10);
  });

  it("does not create a zero-piece reinspection when the whole failed group was fixed as scrap", async () => {
    const value = await f.ready(3, 1, 2); await f.scraps.allocate(owner.context, value.id, value.input);
    const before = await f.state();
    await expect(f.inspect(value, [f.group("IMPOSSIBLE", 1, true)], value.held.id)).rejects.toSatisfy(publicError(409, "quality_scrap_no_reinspectable_quantity"));
    expect(await f.state()).toEqual(before);
    expect((await basis(value.id)).groups.find(row => row.qualityGroupId === value.held.id)).toMatchObject({ quantity: 2, scrappedQuantity: 2, reinspectableQuantity: 0 });
  });

  it("allows an actual two-piece remake after all physical pieces were fixed as scrap while zero-piece QC remains forbidden", async () => {
    const value = await f.ready(2, 0, 2); await f.scraps.allocate(owner.context, value.id, value.input);
    const workspace = await owner.production.qualityGroups(owner.context, value.id);
    expect(workspace.quantity).toBe(0); expect(workspace.blockers).toEqual([]);
    const before = await f.state();
    await expect(f.inspect(value, [f.group("NO_PHYSICAL_PIECE", 1, true)], value.held.id))
      .rejects.toSatisfy(publicError(409, "quality_scrap_no_reinspectable_quantity"));
    expect(await f.state()).toEqual(before);
    const actual = await f.remake(value, value.held.id, value.held.defects[0]!.id, 2);
    expect((await owner.production.get(owner.context, actual.replacementProductionOrderId!)).versions[0]!.quantity).toBe(2);
    expect((await owner.production.qualityGroups(owner.context, value.id)).groups.find(row => row.id === value.held.id))
      .toMatchObject({ quantity: 2, scrappedQuantity: 2, remakeQuantity: 2, remainingScrapRemakeQuantity: 0 });
  });

  it("limits an original scrap-disposition defect to d minus every pinned child net quantity across overlapping defects", async () => {
    const value = await f.production(3), original = f.group("SCRAP_DISPOSITION", 3);
    const root = await f.inspect(value, [{ ...original, defects: original.defects.map(defect => ({ ...defect, disposition: "scrap" })) }]);
    const held = root.workspace.groups[0]!, count = await f.physicalReview(value, scrapPhysical(0, 0, 2, 1));
    await allocate(value, held.id, count.reviewed.review.id, 1);
    const before = await f.state();
    await expect(f.remake(value, held.id, held.defects[0]!.id, 2)).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
    const actual = await f.remake(value, held.id, held.defects[0]!.id, 1), after = await f.state();
    await expect(f.remake(value, held.id, held.defects[1]!.id, 1)).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(after);
    expect((await owner.production.get(owner.context, actual.replacementProductionOrderId!)).versions[0]!.quantity).toBe(1);
    expect((await owner.production.qualityGroups(owner.context, value.id)).groups.find(row => row.id === held.id))
      .toMatchObject({ quantity: 3, scrappedQuantity: 1, remakeQuantity: 1, remainingScrapRemakeQuantity: 0 });
  });

  it("rejects whole nongroup scrap disposition and app-role scrap defects without their real physical group link", async () => {
    const value = await f.production(3), current = await owner.production.get(owner.context, value.id);
    const input = { qualityStandardVersionId: value.standardId, expectedProductionProjectionVersion: current.productionOrder.projectionVersion,
      result: "failed", scoreBps: 0, assessment: { formatVersion: 2, criterionResults: [{ code: "ACTUAL", scoreBps: 0, passed: false, evidenceAssetIds: [] }] },
      inspectedAt: (await owner.clock()).now, evidenceAssetIds: [], idempotencyKey: randomUUID(),
      defects: [{ code: "COLOR", severity: "major", responsibility: "supplier", disposition: "rework", note: "Synthetic real whole QC rework control", evidenceAssetIds: [] }] } satisfies RecordQualityInspectionInput;
    const unsupported = { ...input, defects: [{ ...input.defects[0]!, disposition: "scrap" }] } satisfies RecordQualityInspectionInput, before = await f.state();
    expect(RecordQualityInspectionInputSchema.safeParse(unsupported).success).toBe(false);
    await expect(owner.production.inspect(owner.context, value.id, unsupported)).rejects.toMatchObject({ name: "ZodError" });
    expect(await f.state()).toEqual(before);
    const control = await owner.production.inspect(owner.context, value.id, RecordQualityInspectionInputSchema.parse(input));
    expect(control.inspections[0]!.assessmentVersion).toBe(2);
    const afterControl = await f.state(), note = "Synthetic unlinked whole scrap must not become group remake authority";
    await expect(withTenant(database.db, owner.context, async tx => {
      await tx.insert(qualityDefects).values({ id: createEntityId(), tenantId: owner.context.tenantId,
        productionOrderId: value.id, inspectionId: control.inspections[0]!.id, code: "UNLINKED_SCRAP", severity: "major",
        responsibility: "supplier", disposition: "scrap", encryptedDetail: owner.vault.encrypt(note),
        detailChecksum: createHash("sha256").update(note).digest("hex"), evidenceAssetIds: [] });
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toSatisfy(sqlError("quality_scrap_defect_group_required"));
    expect(await f.state()).toEqual(afterControl);
  });

  it("cannot launder an original scrap defect into an ungrouped remake by replacing its QC root or changing a recovery source", async () => {
    const value = await f.production(3), original = f.group("OLD_SCRAP_ROOT", 3);
    const root = await f.inspect(value, [{ ...original, defects: original.defects.map(defect => ({ ...defect, disposition: "scrap" })) }]);
    const held = root.workspace.groups[0]!, scrapDefectId = held.defects[0]!.id;
    // No quantity review or mapping exists: an unknown physical count is not a
    // saved scrap allowance, and replacing this root is still a legal operation.
    expect(await basis(value.id)).toMatchObject({ actualScrappedQuantity: null, mappedScrappedQuantity: 0, quantityReviewId: null, lots: [] });
    const current = await owner.production.get(owner.context, value.id);
    const control = await owner.production.inspect(owner.context, value.id, RecordQualityInspectionInputSchema.parse({
      qualityStandardVersionId: value.standardId, expectedProductionProjectionVersion: current.productionOrder.projectionVersion,
      result: "failed", scoreBps: 0, assessment: { formatVersion: 2, criterionResults: [{ code: "ACTUAL", scoreBps: 0, passed: false, evidenceAssetIds: [] }] },
      inspectedAt: (await owner.clock()).now, evidenceAssetIds: [], idempotencyKey: randomUUID(),
      defects: [{ code: "COLOR", severity: "major", responsibility: "supplier", disposition: "rework",
        note: "Synthetic real whole rework control without any scrap mapping", evidenceAssetIds: [] }],
    }));
    expect(control.inspections[0]).toMatchObject({ assessmentVersion: 2, result: "failed" });
    const reworkDefect = control.defects.find(defect => defect.inspectionId === control.inspections[0]!.id)!;
    expect(reworkDefect).toMatchObject({ disposition: "rework", qualityGroupId: null });
    expect(control.defects.find(defect => defect.id === scrapDefectId)).toMatchObject({ disposition: "scrap", qualityGroupId: held.id });
    expect((await owner.production.qualityGroups(owner.context, value.id)).rootInspectionId).toBe(control.inspections[0]!.id);
    const input = CreateProductionRecoveryInputSchema.parse({ type: "remake", originalProductionOrderId: value.id, defectId: scrapDefectId,
      remakeQuantity: 1, expectedProductionProjectionVersion: control.productionOrder.projectionVersion,
      manufacturing: value.source.input.manufacturing, capacityPlan: value.source.input.capacityPlan,
      reason: "Synthetic old scrap cannot become an ungrouped remake after a legal root replacement",
      expectedCompletionAt: value.source.input.expectedCompletionAt, idempotencyKey: randomUUID() });
    const recoveryIds = () => withTenant(database.db, owner.context, tx => tx.select({ id: productionRecoveryCases.id })
      .from(productionRecoveryCases).where(eq(productionRecoveryCases.originalProductionOrderId, value.id)));
    const before = await f.state(); expect(await recoveryIds()).toEqual([]);
    await expect(owner.production.recover(owner.context, input)).rejects.toSatisfy(publicError(409, "quality_scrap_recovery_group_required"));
    expect(await recoveryIds()).toEqual([]); expect(await f.state()).toEqual(before);

    for (const mutation of ["insert", "update"] as const) {
      await expect(withTenant(database.db, owner.context, async tx => {
        const id = createEntityId(), rawInput = CreateProductionRecoveryInputSchema.parse({ ...input,
          defectId: mutation === "insert" ? scrapDefectId : reworkDefect.id, idempotencyKey: randomUUID() });
        await tx.insert(productionRecoveryCases).values({ id, tenantId: owner.context.tenantId, orderId: value.source.order.id,
          originalProductionOrderId: value.id, defectId: rawInput.defectId, type: rawInput.type, status: "in_progress",
          encryptedReason: owner.vault.encrypt(rawInput.reason), reasonChecksum: createHash("sha256").update(rawInput.reason).digest("hex"),
          compensationAmountMinor: rawInput.compensationAmountMinor, compensationCurrency: rawInput.compensationCurrency,
          expectedCompletionAt: new Date(rawInput.expectedCompletionAt!), idempotencyKey: rawInput.idempotencyKey,
          openedBy: owner.context.userId, requestChecksum: createHash("sha256").update(JSON.stringify(rawInput)).digest("hex") });
        await owner.audit.recordInTransaction(tx, owner.context, { action: "production_order.recovery", resourceType: "production_recovery_case",
          resourceId: id, result: "success", metadata: { type: "remake", replacementId: null } });
        if (mutation === "update") {
          // The real whole rework defect is valid without a group. Even after
          // its constraints pass, its immutable source cannot change to scrap.
          await tx.execute(sql`set constraints all immediate`);
          await tx.execute(sql`set constraints all deferred`);
          await tx.update(productionRecoveryCases).set({ defectId: scrapDefectId,
            requestChecksum: createHash("sha256").update(JSON.stringify({ ...rawInput, defectId: scrapDefectId })).digest("hex") })
            .where(eq(productionRecoveryCases.id, id));
        }
        await tx.execute(sql`set constraints all immediate`);
      })).rejects.toSatisfy(sqlError(mutation === "insert" ? "quality_scrap_recovery_group_required" : "production_recovery_source_immutable"));
      expect(await recoveryIds()).toEqual([]); expect(await f.state()).toEqual(before);
    }

    const mixed = await f.production(2), mixedInput = f.group("MIXED_DEFECT_SOURCE", 2);
    const mixedRoot = await f.inspect(mixed, [{ ...mixedInput, defects: mixedInput.defects.map((defect, index) =>
      ({ ...defect, disposition: index === 0 ? "rework" : "scrap" })) }]);
    const mixedGroup = mixedRoot.workspace.groups[0]!, originalRework = mixedGroup.defects.find(defect => defect.disposition === "rework")!,
      originalScrap = mixedGroup.defects.find(defect => defect.disposition === "scrap")!;
    const replacement = await f.remake(mixed, mixedGroup.id, originalRework.id, 1);
    expect((await owner.production.get(owner.context, replacement.replacementProductionOrderId!)).versions[0]!.quantity).toBe(1);
    const recovery = () => withTenant(database.db, owner.context, tx => tx.select().from(productionRecoveryCases)
      .where(eq(productionRecoveryCases.id, replacement.recoveryId)));
    const actualRecovery = await recovery(), afterReplacement = await f.state();
    expect(actualRecovery).toEqual([expect.objectContaining({ defectId: originalRework.id, type: "remake" })]);
    await withTenant(database.db, owner.context, async tx => {
      const [link] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from production_recovery_groups
        where recovery_case_id=${replacement.recoveryId}::uuid and quality_group_id=${mixedGroup.id}::uuid`);
      expect(link?.count).toBe(1);
    });
    await expect(withTenant(database.db, owner.context, async tx => {
      await tx.update(productionRecoveryCases).set({ defectId: originalScrap.id }).where(eq(productionRecoveryCases.id, replacement.recoveryId));
      await tx.execute(sql`set constraints all immediate`);
    })).rejects.toSatisfy(sqlError("production_recovery_source_immutable"));
    expect(await recovery()).toEqual(actualRecovery); expect(await f.state()).toEqual(afterReplacement);
  });

  it("cannot rebuild a fresh whole root to erase scrap provenance and rejects the failed group of a superseded old root", async () => {
    const value = await f.scenario(), freshRoot = await f.inspect(value, [f.group("NEW_GOOD", 4, true), f.group("NEW_HELD", 6)]);
    const count = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2)), before = await f.state();
    await expect(allocate(value, value.held!.id, count.reviewed.review.id, 2)).rejects.toSatisfy(publicError(409, "quality_scrap_group_unavailable"));
    await expect(f.inspect(value, [f.group("LAUNDERED_GOOD", 8, true)])).rejects.toSatisfy(publicError(409, "quality_scrap_root_locked"));
    expect(await f.state()).toEqual(before);
    expect((await basis(value.id)).rootInspectionId).toBe(freshRoot.inspectionId);
  });

  it("rolls back the header, every allocation and projection if the real same-transaction audit fails", async () => {
    const value = await f.ready(), before = await f.state(), actualAudit = owner.audit.recordInTransaction.bind(owner.audit);
    let reached = false;
    vi.spyOn(owner.audit, "recordInTransaction").mockImplementation(async (tx, context, input) => {
      if (input.action === "production.quality.scrap_allocated") {
        reached = true; expect(input).toMatchObject({ resourceType: "quality_scrap_review" });
        const [count] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from quality_scrap_allocations where review_id=${input.resourceId}::uuid`);
        expect(count?.count).toBe(1); throw new Error("Synthetic scrap audit failure");
      }
      return actualAudit(tx, context, input);
    });
    await expect(f.scraps.allocate(owner.context, value.id, value.input)).rejects.toThrow("Synthetic scrap audit failure");
    expect(reached).toBe(true); expect(await f.state()).toEqual(before);
  });

  it("checks live individual permission scopes and the original request ceiling before exact old-key recovery", async () => {
    const value = await f.ready(); await f.scraps.allocate(owner.context, value.id, value.input);
    const before = await f.state();
    try {
    await owner.grant([Permission.OrderRead], "tenant", [Permission.OrderWrite]);
    const ceiling = { ...owner.context, permissions: [Permission.OrderRead], permissionScopes: { [Permission.OrderRead]: "tenant" as const } };
    expect((await f.scraps.workspace(ceiling, value.id, {})).access).toEqual({ canRead: true, canWrite: false });
    await expect(f.scraps.allocate(ceiling, value.id, value.input)).rejects.toBeInstanceOf(ForbiddenError);
    await owner.grant([Permission.OrderRead], "tenant");
    await expect(f.scraps.allocate(owner.context, value.id, value.input)).rejects.toBeInstanceOf(ForbiddenError);
    await owner.grant([Permission.OrderWrite], "self", [Permission.OrderRead]);
    expect((await f.scraps.workspace(owner.context, value.id, {})).access.canWrite).toBe(false);
    await expect(f.scraps.allocate(owner.context, value.id, value.input)).rejects.toBeInstanceOf(ForbiddenError);
    await owner.grant([Permission.OrderRead], "self", [Permission.OrderWrite]);
    await expect(f.scraps.workspace(owner.context, value.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.scraps.allocate(owner.context, value.id, value.input)).rejects.toBeInstanceOf(ForbiddenError);
    await withTenant(database.db, owner.seed(), tx => tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, owner.owner.membershipId)));
    await expect(f.scraps.workspace(owner.context, value.id, {})).rejects.toBeInstanceOf(ForbiddenError);
    } finally { await owner.grant(); }
    expect(await f.state()).toEqual(before);
  });

  it("reads with the current ERP presentation stamp and hides both immutable tables from another real tenant", async () => {
    const value = await f.ready(); await f.scraps.allocate(owner.context, value.id, value.input);
    const workspace = QualityScrapWorkspaceSchema.parse(await f.scraps.workspace(owner.context, value.id, {}));
    expect(workspace.contextAuthority).toBe(erpSessionAuthority(erpPermissionContext(owner.context)));
    await expect(f.scraps.workspace(owner.foreignContext, value.id, {})).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.scraps.allocate(owner.foreignContext, value.id, value.input)).rejects.toBeInstanceOf(NotFoundException);
    for (const table of [qualityScrapReviews, qualityScrapAllocations])
      expect(await withTenant(database.db, owner.foreignContext, tx => tx.select().from(table))).toEqual([]);
  });

  it("pages complete immutable allocation history and rejects a cursor from another production", async () => {
    const value = await f.ready(10, 4, 3), ids: string[] = [];
    for (let index = 0; index < 3; index++) ids.push((await allocate(value, value.held.id, value.count.reviewed.review.id, 1)).review.id);
    const first = await f.scraps.workspace(owner.context, value.id, { limit: 2 });
    expect(first.reviews.map(row => row.id)).toEqual([...ids].sort().reverse().slice(0, 2)); expect(first.nextCursor).toBe(first.reviews[1]!.id);
    const last = await f.scraps.workspace(owner.context, value.id, { limit: 2, before: first.nextCursor! });
    expect(last.reviews.map(row => row.id)).toEqual([...ids].sort().reverse().slice(2)); expect(last.nextCursor).toBeNull();
    const other = await f.ready();
    await expect(f.scraps.workspace(owner.context, other.id, { before: first.nextCursor! })).rejects.toSatisfy(publicError(400, "quality_scrap_cursor_invalid"));
  });

  it("rejects evidence time before its source review, in the future or beyond actual millisecond precision", async () => {
    const value = await f.ready(), before = await f.state();
    for (const occurredAt of [new Date(Date.parse(value.count.reviewed.review.createdAt) - 1000).toISOString(),
      new Date(Date.parse((await owner.clock()).now) + 86400000).toISOString(), value.input.occurredAt.replace(/\.\d{3}Z$/, ".0001Z")])
      await expect(f.scraps.allocate(owner.context, value.id, { ...value.input, occurredAt })).rejects.toSatisfy(publicError(422, "quality_scrap_time_invalid"));
    expect(await f.state()).toEqual(before);
  });

  it("keeps an already physically shipped good group fixed while mapping and reinspecting only the failed pieces", async () => {
    const value = await f.scenario(), good = value.good!;
    const order = await owner.orders.ingestNormalized(owner.context, { accountId: owner.owner.accountId, platform: "etsy", externalEventId: randomUUID(),
      externalOrderId: value.source.order.externalOrderId, providerStatus: "paid", placedAt: value.source.order.placedAt, orderTotal: null,
      lines: value.source.order.lines.map(line => ({ externalLineId: line.externalLineId, externalListingId: line.externalListingId,
        skuCode: line.skuCode, title: line.title, quantity: line.quantity, unitPrice: line.unitPrice, customizationCount: line.customizationCount })), redactedSource: { synthetic: true },
      protectedDetails: { buyer: { name: "Synthetic scrap buyer", email: null, phone: null }, shippingAddress: { recipient: "Synthetic scrap recipient",
        lines: ["1 Synthetic Test Way"], city: "Synthetic", region: "CA", postalCode: "90001", countryCode: "US" }, customizations: [] } });
    const privateWork = await f.privateWork(value.source.lineId);
    expect(privateWork.line.preparation).toBe("pending_review");
    expect(order.workflowState).toBe("in_production");
    const source = (await shipping.productionSources(owner.context, order.id)).find(row => row.qualityGroupId === good.id)!;
    const shipment = await shipping.create(owner.context, order.id, CreateShipmentInputSchema.parse({ shipDate: (await owner.clock()).now,
      shipFromCountryCode: "US", idempotencyKey: randomUUID(), packages: [{ packageReferenceId: randomUUID(), trackingNumber: randomUUID(),
        carrierCode: "SYNTHETIC", carrierName: "Synthetic scrap carrier", carrierService: "Synthetic actual handover", lines: [{ orderLineId: value.source.lineId, quantity: 4,
          productionAllocations: [{ productionOrderId: value.id, productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
            qualityGroupId: good.id, expectedProductionProjectionVersion: source.projectionVersion, quantity: 4 }] }] }] }));
    await shipping.reviewVersion(owner.context, shipment.shipment.id, shipment.versions[0]!.id, { decision: "approved", expectedCurrentVersion: 1,
      reasonCode: "SYNTHETIC_SCRAP_GOOD", reason: "Synthetic physical good group", idempotencyKey: randomUUID() });
    await shipping.dispatch(owner.context, shipment.shipment.id, { expectedVersion: 1, occurredAt: (await owner.clock()).now, reason: "Synthetic actual handover", idempotencyKey: randomUUID() });
    const count = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2));
    await allocate(value, value.held!.id, count.reviewed.review.id, 2);
    await f.inspect(value, [f.group("REPAIRED", 4, true)], value.held!.id);
    const current = (await owner.production.qualityGroups(owner.context, value.id)).groups.find(row => row.id === good.id)!;
    expect(current).toMatchObject({ quantity: 4, active: true, shippedQuantity: 4, inspectionId: value.root.inspectionId });
    expect((await shipping.productionSources(owner.context, order.id)).find(row => row.qualityGroupId === good.id)).toMatchObject({ allocatedQuantity: 4, availableQuantity: 0 });
  });

  // Raw SQL controls and hostile mutations below use the same app role, exact
  // canonical body and legitimate owner-produced source facts as the service.
  async function rawReview(tx: TenantTransaction, value: { id: string }, input: AllocateQualityScrapInput,
    options: { omitAllocations?: boolean; omitProjection?: boolean; omitAudit?: boolean; requestInput?: unknown; actorId?: string } = {}) {
    const id = createEntityId(), actualInput = options.requestInput ?? input;
    const canonical = canonicalJson({ version: 1, operation: "allocate", productionOrderId: value.id, input: actualInput });
    const [header] = await tx.insert(qualityScrapReviews).values({ id, tenantId: owner.context.tenantId, productionOrderId: value.id,
      productionVersionId: input.productionVersionId, rootInspectionId: input.expectedRootInspectionId,
      quantityReviewId: input.expectedQuantityReviewId, previousReviewId: input.expectedScrapReviewId,
      input: actualInput as AllocateQualityScrapInput, idempotencyKey: input.idempotencyKey, requestCanonical: canonical,
      requestChecksum: createHash("sha256").update(canonical).digest("hex"), creationTransactionId: "0", createdBy: options.actorId ?? owner.context.userId }).returning();
    if (!options.omitAllocations) await tx.insert(qualityScrapAllocations).values(input.allocations.map(row => ({ id: createEntityId(),
      tenantId: owner.context.tenantId, reviewId: id, productionOrderId: value.id, productionVersionId: input.productionVersionId,
      qualityGroupId: row.qualityGroupId, sourceQuantityReviewId: row.sourceQuantityReviewId, quantity: row.quantity })));
    if (!options.omitProjection) await tx.update(productionOrders).set({ projectionVersion: input.expectedProductionProjectionVersion + 1,
      updatedAt: sql`clock_timestamp()` }).where(eq(productionOrders.id, value.id));
    if (!options.omitAudit) await owner.audit.recordInTransaction(tx, owner.context, {
      action: "production.quality.scrap_allocated", resourceType: "quality_scrap_review", resourceId: id, result: "success",
      metadata: { productionOrderId: value.id, productionVersionId: input.productionVersionId,
        rootInspectionId: input.expectedRootInspectionId, quantityReviewId: input.expectedQuantityReviewId,
        allocationCount: input.allocations.length, quantity: input.allocations.reduce((sum, row) => sum + row.quantity, 0) },
    });
    return header!;
  }

  it("raw control: real original sources, full allocation, projection and atomic audit pass immediate constraints before rollback", async () => {
    const value = await f.ready(), before = await f.state(), rollback = new Error("Synthetic valid scrap transaction rollback");
    await expect(withTenant(database.db, owner.context, async tx => {
      const header = await rawReview(tx, value, value.input);
      const [actual] = await tx.execute<{ xid: string }>(sql`select pg_current_xact_id()::text as xid`);
      expect(header.creationTransactionId).toBe(actual!.xid); expect(header.creationTransactionId).not.toBe("0");
      await tx.execute(sql`set constraints all immediate`);
      throw rollback;
    })).rejects.toBe(rollback);
    expect(await f.state()).toEqual(before);
  });

  it.each(["omitAllocations", "omitProjection", "omitAudit"] as const)("raw SQL rejects an otherwise valid transaction with %s", async missing => {
    const value = await f.ready(), before = await f.state();
    await expect(withTenant(database.db, owner.context, tx => rawReview(tx, value, value.input, { [missing]: true })))
      .rejects.toSatisfy(sqlError("quality_scrap_owner_closure_required"));
    expect(await f.state()).toEqual(before);
  });

  it("raw SQL rejects a numeric request key even when its canonical checksum and text key agree", async () => {
    const value = await f.ready(), input = { ...value.input, idempotencyKey: "12345678" }, before = await f.state();
    await expect(withTenant(database.db, owner.context, tx => rawReview(tx, value, input, { requestInput: { ...input, idempotencyKey: 12345678 } })))
      .rejects.toSatisfy(sqlError("quality_scrap_input_invalid"));
    expect(await f.state()).toEqual(before);
  });

  it.each(["passed", "excess"] as const)("raw SQL rejects a %s physical allocation despite correct header, body and audit", async kind => {
    const value = await f.ready(), row = value.input.allocations[0]!;
    const input = { ...value.input, allocations: [{ ...row, ...(kind === "passed" ? { qualityGroupId: value.good!.id } : { quantity: 3 }) }] };
    const before = await f.state();
    await expect(withTenant(database.db, owner.context, tx => rawReview(tx, value, input)))
      .rejects.toSatisfy(sqlError("quality_scrap_source_or_balance_invalid"));
    expect(await f.state()).toEqual(before);
  });

  it("raw SQL cannot use an excluded before-root lot as another deduction from the already smaller QC group", async () => {
    const value = await f.production(), count = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2));
    const root = await f.inspect(value, [f.group("GOOD", 4, true), f.group("HELD", 4)]), held = root.workspace.groups.find(row => row.result === "failed")!;
    const input = await f.allocationInput(await basis(value.id), [{ qualityGroupId: held.id, sourceQuantityReviewId: count.reviewed.review.id, quantity: 1 }]);
    const before = await f.state();
    await expect(withTenant(database.db, owner.context, tx => rawReview(tx, value, input)))
      .rejects.toSatisfy(sqlError("quality_scrap_source_or_balance_invalid"));
    expect(await f.state()).toEqual(before);
  });

  it("raw multirow allocations cannot spend one incremental lot twice across two failed groups", async () => {
    const value = await f.production(), root = await f.inspect(value, [f.group("GOOD", 4, true), f.group("LEFT", 3), f.group("RIGHT", 3)]);
    const count = await f.physicalReview(value, scrapPhysical(0, 0, 8, 2));
    const input = await f.allocationInput(await basis(value.id), root.workspace.groups.filter(row => row.result === "failed")
      .map(row => ({ qualityGroupId: row.id, sourceQuantityReviewId: count.reviewed.review.id, quantity: 2 })));
    const before = await f.state();
    await expect(withTenant(database.db, owner.context, tx => rawReview(tx, value, input)))
      .rejects.toSatisfy(sqlError("quality_scrap_source_or_balance_invalid"));
    expect(await f.state()).toEqual(before);
  });

  it("raw SQL cannot attach a later allocation to an already committed review by supplying a caller transaction marker", async () => {
    const value = await f.ready(), saved = await f.scraps.allocate(owner.context, value.id, value.input), before = await f.state();
    await expect(withTenant(database.db, owner.context, async tx => {
      await tx.execute(sql`select set_config('app.quality_scrap_review',${saved.review.id},true)`);
      await tx.insert(qualityScrapAllocations).values({ id: createEntityId(), tenantId: owner.context.tenantId, reviewId: saved.review.id,
        productionOrderId: value.id, productionVersionId: value.versionId, ...value.input.allocations[0]! });
    })).rejects.toSatisfy(sqlError("quality_scrap_actual_review_required"));
    expect(await f.state()).toEqual(before);
  });

  it("raw SQL cannot append an undeclared allocation after a legal closure was flushed", async () => {
    const value = await f.ready(), before = await f.state();
    await expect(withTenant(database.db, owner.context, async tx => {
      const row = await rawReview(tx, value, value.input); await tx.execute(sql`set constraints all immediate`);
      await tx.insert(qualityScrapAllocations).values({ id: createEntityId(), tenantId: owner.context.tenantId, reviewId: row.id,
        productionOrderId: value.id, productionVersionId: value.versionId, qualityGroupId: value.good!.id,
        sourceQuantityReviewId: value.count.reviewed.review.id, quantity: 1 });
    })).rejects.toSatisfy(sqlError("quality_scrap_actual_review_required"));
    expect(await f.state()).toEqual(before);
  });

  it("preserves every committed review and allocation under app-role update and delete attempts", async () => {
    const value = await f.ready(); await f.scraps.allocate(owner.context, value.id, value.input); const before = await f.state();
    for (const table of ["quality_scrap_reviews", "quality_scrap_allocations"])
      for (const operation of [sql`update ${sql.identifier(table)} set id=id`, sql`delete from ${sql.identifier(table)}`])
        await expect(withTenant(database.db, owner.context, tx => tx.execute(operation))).rejects.toSatisfy((error: unknown) => pg(error).code === "42501");
    expect(await f.state()).toEqual(before);
  });
});
