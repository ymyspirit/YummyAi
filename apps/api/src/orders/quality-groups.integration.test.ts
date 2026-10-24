import { randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ForbiddenError, Permission, summarizeRoleGrants } from "@yummyai/authz";
import { CreateShipmentInputSchema, RecordQualityInspectionInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { RecordQualityGroupsInputSchema, type QualityPhysicalGroupInput } from "@yummyai/contracts/order/quality-groups";
import { connectDatabase, memberships, membershipRoles, roles, orderWorkItems, qualityInspectionGroups, qualityGroupDefects, qualityDefects, qualityInspections, shipmentProductionAllocations, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { syntheticPassedProduction } from "./shipment-production-fixture.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { syntheticQualityInspection } from "../../../../tools/testing/quality-fixtures.js";
import { ProductionQuantityService } from "./production-quantity.service.js";

describe("physical quality groups and independent defect quantities", () => {
  const database = connectDatabase(), tenantId = createEntityId(), userId = createEntityId(), otherUserId = createEntityId(), accountId = createEntityId(), otherTenantId = createEntityId();
  const permissions = [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead, Permission.AssetRead];
  const context: TenantContext = { tenantId, userId, permissions, dataScope: "tenant" };
  const productionContext: TenantContext = { ...context, permissions: [...permissions, Permission.ProductRead, Permission.DesignRead] };
  const other: TenantContext = { ...context, tenantId: otherTenantId, userId: otherUserId };
  const vault = new SecretVault(Buffer.alloc(32, 62)), audit = new AuditService(database), orders = new OrderService(database, vault, audit);
  const shipping = new OrderShipmentService(database, vault, orders, audit, { enqueue: async () => undefined });
  const factories = new FactoryDirectoryService(database, audit);
  const production = new OrderProductionService(database, vault, orders, audit, undefined, factories);
  const quantities = new ProductionQuantityService(database, audit);
  beforeAll(async () => {
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic groups A',$2),($3,'Synthetic groups B',$4)", [tenantId, `groups-a-${tenantId}`, otherTenantId, `groups-b-${otherTenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic group operator'),($4,$5,$6,'Synthetic other group operator')", [userId, `groups-${userId}`, `${userId}@example.test`, otherUserId, `groups-${otherUserId}`, `${otherUserId}@example.test`]);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy','Synthetic group shop','GLOBAL','etsy_oauth',$3)", [accountId, tenantId, userId]);
    await withTenant(database.db, productionContext, async tx => {
      const membershipId = createEntityId(), roleId = createEntityId();
      await tx.insert(memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId, name: "Synthetic current group quantity authority",
        permissions: productionContext.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId });
    });
  });
  afterAll(async () => { await database.client.end(); });
  const databaseTime = async () => {
    const [clock] = await withTenant(database.db, context, tx => tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`));
    return new Date(clock!.now).toISOString();
  };
  const group = (key: string, quantity: number, codes: string[] = []): QualityPhysicalGroupInput => ({ key, label: "Synthetic bin " + key, quantity,
    criterionResults: [{ code: "STOCK", scoreBps: codes.length ? 9000 : 10000, passed: !codes.length, evidenceAssetIds: [] }],
    defects: codes.map(code => ({ code, severity: "major", responsibility: "supplier", disposition: "remake", note: "Synthetic actual group defect", evidenceAssetIds: [] })) });
  async function fixture(quantity = 5) {
    const suffix = randomUUID();
    const order = await orders.ingestNormalized(context, { accountId, platform: "etsy", externalEventId: suffix, externalOrderId: suffix,
      providerStatus: "paid", placedAt: "2026-07-22T00:00:00.000Z", orderTotal: null,
      lines: [{ externalLineId: "synthetic-group-line", externalListingId: null, skuCode: null, title: "Synthetic grouped goods", quantity, unitPrice: null, customizationCount: 0 }],
      redactedSource: { synthetic: true }, protectedDetails: null });
    await database.client.unsafe("update orders set workflow_state='awaiting_shipment',address_status='protected' where id=$1", [order.id]);
    const [source] = await syntheticPassedProduction(database, context, order.id, [{ id: order.lines[0]!.id, quantity }], factories);
    if (!source?.manufacturing) throw new Error("Modern group fixture requires its original manufacturing selection");
    const input = async (groups: QualityPhysicalGroupInput[], parentGroupId: string | null = null) => {
      const basis = await production.qualityGroups(context, source!.productionOrderId);
      return RecordQualityGroupsInputSchema.parse({ formatVersion: 3, productionVersionId: basis.productionVersionId,
        expectedProductionProjectionVersion: basis.projectionVersion, expectedRootInspectionId: basis.rootInspectionId,
        parentGroupId, qualityStandardVersionId: source!.standardId, inspectedAt: await databaseTime(),
        segregationConfirmed: true, groups, idempotencyKey: randomUUID() });
    };
    return { orderId: order.id, lineId: order.lines[0]!.id, source: source!, input };
  }
  const review = () => ({ decision: "approved" as const, reasonCode: "SYNTHETIC_GROUP_CHECKED", reason: "Synthetic group and quantity attestation", expectedCurrentVersion: 1, idempotencyKey: randomUUID() });
  const shipmentInput = (f: Awaited<ReturnType<typeof fixture>>, source: Awaited<ReturnType<OrderShipmentService["productionSources"]>>[number], quantity: number) => CreateShipmentInputSchema.parse({
    shipDate: new Date().toISOString(), shipFromCountryCode: "US", idempotencyKey: randomUUID(), packages: [{ packageReferenceId: randomUUID(), trackingNumber: randomUUID(),
      carrierCode: "SYNTHETIC", carrierName: "Synthetic group carrier", carrierService: "Synthetic group service", lines: [{ orderLineId: f.lineId, quantity,
        productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId,
          qualityGroupId: source.qualityGroupId, expectedProductionProjectionVersion: source.projectionVersion, quantity }] }] }],
  });

  async function duringWorkChange(lineId: string, change: Partial<Pick<typeof orderWorkItems.$inferInsert, "held" | "archivedAt" | "encryptedDataKey">>, submit: () => Promise<unknown>, advisory = true) {
    let signalReady!: () => void, signalFailure!: (error: unknown) => void, release!: () => void;
    const ready = new Promise<void>((resolve, reject) => { signalReady = resolve; signalFailure = reject; }), released = new Promise<void>(resolve => { release = resolve; });
    const owner = withTenant(database.db, context, async tx => {
      if (advisory) await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"order-work:" + lineId},0))`);
      await tx.update(orderWorkItems).set(change).where(eq(orderWorkItems.id, lineId));
      signalReady(); await released;
    }).then(() => null, error => { signalFailure(error); return error; });
    let attempted: Promise<unknown> | undefined;
    let result!: Awaited<ReturnType<typeof boundedAttempt>>, ownerError: unknown;
    try { await ready; attempted = submit(); result = await boundedAttempt(attempted); }
    finally { release(); ownerError = await owner; await attempted?.catch(() => undefined); }
    if (ownerError) throw ownerError;
    return result;
  }

  it.each(["whole", "group"] as const)("fences a %s inspection against the real work archive lock and preserves the original receipt", async kind => {
    const f = await fixture(2), before = await production.get(context, f.source.productionOrderId);
    await withTenant(database.db, context, tx => tx.insert(orderWorkItems).values({ id: f.lineId, tenantId,
      encryptedDataKey: vault.encrypt(Buffer.alloc(32, 73).toString("base64")), expiresAt: new Date(Date.now() + 86_400_000) }));
    const whole = await syntheticQualityInspection(production, context, f.source.productionOrderId, {
      qualityStandardVersionId: f.source.standardId, result: "passed", scoreBps: 10000, inspectedAt: await databaseTime(), evidenceAssetIds: [], defects: [], idempotencyKey: randomUUID(),
    });
    const grouped = await f.input([group("A", 2)]);
    const submit = () => kind === "whole" ? production.inspect(context, f.source.productionOrderId, whole) : production.inspectGroups(context, f.source.productionOrderId, grouped);
    // The fixture owns exactly the lock used by OrderWorkspaceService.archive;
    // its uncommitted row must not let a competing inspection read past it.
    const result = await duringWorkChange(f.lineId, { held: true, archivedAt: new Date() }, submit);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.error).toBeInstanceOf(ConflictException);
    expect((await production.get(context, f.source.productionOrderId)).inspections).toHaveLength(before.inspections.length);
    await expect(submit()).rejects.toBeInstanceOf(ConflictException);
    expect((await production.qualityGroups(context, f.source.productionOrderId)).blockers.join(" ")).toContain("暂停");
    await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ held: false, archivedAt: null }).where(eq(orderWorkItems.id, f.lineId)));
    await submit();
    const saved = await production.get(context, f.source.productionOrderId), inspectionId = saved.inspections[0]!.id;
    await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ held: true, archivedAt: new Date() }).where(eq(orderWorkItems.id, f.lineId)));
    await submit();
    expect((await production.get(context, f.source.productionOrderId)).inspections).toHaveLength(before.inspections.length + 1);
    expect((await database.client.unsafe("select count(*)::int as count from audit_events where entity_id=$1 and action=$2", [inspectionId, kind === "whole" ? "production_order.inspect" : "production_order.inspect_groups"]))[0]!.count).toBe(1);
  });

  it.each(["whole", "group"] as const)("fences a %s inspection against concurrent key erasure without an advisory lock", async kind => {
    const f = await fixture(2), before = await production.get(context, f.source.productionOrderId);
    await withTenant(database.db, context, tx => tx.insert(orderWorkItems).values({ id: f.lineId, tenantId,
      encryptedDataKey: vault.encrypt(Buffer.alloc(32, 74).toString("base64")), expiresAt: new Date(Date.now() + 86_400_000) }));
    const whole = await syntheticQualityInspection(production, context, f.source.productionOrderId, { qualityStandardVersionId: f.source.standardId,
      result: "passed", scoreBps: 10000, inspectedAt: await databaseTime(), evidenceAssetIds: [], defects: [], idempotencyKey: randomUUID() });
    const grouped = await f.input([group("A", 2)]);
    const submit = () => kind === "whole" ? production.inspect(context, f.source.productionOrderId, whole) : production.inspectGroups(context, f.source.productionOrderId, grouped);
    const result = await duringWorkChange(f.lineId, { encryptedDataKey: null }, submit, false);
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.error).toBeInstanceOf(ConflictException);
    expect((await production.get(context, f.source.productionOrderId)).inspections).toHaveLength(before.inspections.length);
    await expect(submit()).rejects.toBeInstanceOf(ConflictException);
    expect((await production.qualityGroups(context, f.source.productionOrderId)).blockers.join(" ")).toContain("资料到期");
  });

  it("commits a whole inspection, exception and audit atomically and replays one original record", async () => {
    const f = await fixture(2), before = await production.get(context, f.source.productionOrderId), isolatedAudit = new AuditService(database);
    let failing = true, failedInspectionId: string | undefined;
    const reject = (action: string, resourceId?: string) => {
      if (failing && action === "production_order.inspect") { failedInspectionId = resourceId; throw new Error("Synthetic whole inspection audit failure"); }
    };
    const outer = vi.spyOn(isolatedAudit, "record").mockImplementation(async (actor, event) => { const id = await audit.record(actor, event); reject(event.action, event.resourceId); return id; });
    const inner = vi.spyOn(isolatedAudit, "recordInTransaction").mockImplementation(async (tx, actor, event) => { const id = await audit.recordInTransaction(tx, actor, event); reject(event.action, event.resourceId); return id; });
    const service = new OrderProductionService(database, vault, new OrderService(database, vault, isolatedAudit), isolatedAudit, undefined, factories);
    const input = RecordQualityInspectionInputSchema.parse({ qualityStandardVersionId: f.source.standardId, expectedProductionProjectionVersion: before.productionOrder.projectionVersion,
      assessment: { formatVersion: 2, criterionResults: [{ code: "STOCK", scoreBps: 9000, passed: false, evidenceAssetIds: [] }] }, result: "failed", scoreBps: 9000,
      defects: [{ code: "STOCK", severity: "major", responsibility: "supplier", disposition: "rework", note: "Synthetic operator checked a repairable whole-lot fault" }],
      inspectedAt: await databaseTime(), idempotencyKey: randomUUID() });
    try {
      await expect(service.inspect(context, f.source.productionOrderId, input)).rejects.toThrow("Synthetic whole inspection audit failure");
      expect(failedInspectionId).toBeDefined();
      expect({ addedInspections: (await production.get(context, f.source.productionOrderId)).inspections.length - before.inspections.length,
        exceptions: (await orders.exceptions(context, f.orderId)).length,
        audits: (await database.client.unsafe("select count(*)::int as count from audit_events where entity_id=$1 and action='production_order.inspect'", [failedInspectionId!]))[0]!.count,
      }).toEqual({ addedInspections: 0, exceptions: 0, audits: 0 });
      failing = false;
      const saved = await service.inspect(context, f.source.productionOrderId, input);
      await service.inspect(context, f.source.productionOrderId, input);
      expect((await production.get(context, f.source.productionOrderId)).inspections).toHaveLength(before.inspections.length + 1);
      expect(await orders.exceptions(context, f.orderId)).toHaveLength(1);
      expect((await database.client.unsafe("select count(*)::int as count from audit_events where entity_id=$1 and action='production_order.inspect'", [saved.inspections[0]!.id]))[0]!.count).toBe(1);
    } finally { outer.mockRestore(); inner.mockRestore(); }
  });

  it("keeps three defective pieces distinct from four independent defect effects and ships only the passed group", async () => {
    const f = await fixture();
    const result = await production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A", 2), group("B", 2, ["COLOR"]), group("C", 1, ["COLOR", "STITCH"])]));
    expect(result.workspace.groups.filter(item => item.active)).toHaveLength(3);
    const state = await production.get(context, f.source.productionOrderId);
    expect(state.productionOrder.status).toBe("quality_hold");
    expect(state.inspections[0]).toMatchObject({ assessmentVersion: 3, result: "failed", scoreBps: 9400, criterionResults: null });
    expect(state.defects.filter(defect => defect.code === "COLOR").reduce((sum, defect) => sum + (defect.affectedQuantity ?? 0), 0)).toBe(3);
    expect(state.defects.filter(defect => defect.code === "STITCH")).toMatchObject([{ affectedQuantity: 1 }]);
    expect((await production.wholeOrderFulfillment(context, f.orderId)).items[0]!.readyQuantity).toBe(2);
    const candidates = await shipping.productionSources(context, f.orderId);
    const passed = candidates.find(source => source.groupLabel === "Synthetic bin A")!;
    expect(passed).toMatchObject({ availableQuantity: 2, blockers: [] });
    expect(candidates.filter(source => source.groupLabel !== passed.groupLabel).every(source => source.availableQuantity === 0)).toBe(true);
    const shipment = await shipping.create(context, f.orderId, shipmentInput(f, passed, 2));
    expect(shipment.versions[0]!.productionSourceVersion).toBe(2);
    expect(shipment.productionAllocations[0]).toMatchObject({ qualityGroupId: passed.qualityGroupId, qualityResult: null, groupQualityResult: "passed" });
    await shipping.reviewVersion(context, shipment.shipment.id, shipment.versions[0]!.id, review());
    await expect(shipping.create(context, f.orderId, shipmentInput(f, candidates.find(source => source.groupLabel === "Synthetic bin B")!, 1))).rejects.toBeInstanceOf(ConflictException);
    expect((await shipping.productionSources(context, f.orderId)).find(source => source.qualityGroupId === passed.qualityGroupId)!.availableQuantity).toBe(0);
  });

  it("preserves a shipped good group while independently reinspecting and splitting the held group", async () => {
    const f = await fixture();
    const root = await production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A", 2), group("B", 3, ["COLOR"])]));
    const originalGood = root.workspace.groups.find(item => item.key === "A")!, originalHeld = root.workspace.groups.find(item => item.key === "B")!;
    const goodSource = (await shipping.productionSources(context, f.orderId)).find(source => source.qualityGroupId === originalGood.id)!;
    const shipment = await shipping.create(context, f.orderId, shipmentInput(f, goodSource, 2));
    await shipping.reviewVersion(context, shipment.shipment.id, shipment.versions[0]!.id, review());
    await shipping.dispatch(context, shipment.shipment.id, { expectedVersion: 1, occurredAt: new Date().toISOString(), reason: "Synthetic actual group handover", idempotencyKey: randomUUID() });
    const childInput = await f.input([group("B1", 2), group("B2", 1, ["COLOR", "STITCH"])], originalHeld.id);
    const child = await production.inspectGroups(context, f.source.productionOrderId, childInput);
    expect(child.workspace.groups.find(item => item.id === originalGood.id)).toMatchObject({ active: true, shippedQuantity: 2, inspectionId: root.inspectionId });
    expect(child.workspace.groups.find(item => item.id === originalHeld.id)!.active).toBe(false);
    expect(child.workspace.groups.filter(item => item.parentGroupId === originalHeld.id && item.active)).toHaveLength(2);
    const fresh = await shipping.productionSources(context, f.orderId);
    expect(fresh.find(source => source.qualityGroupId === originalGood.id)).toMatchObject({ qualityInspectionId: root.inspectionId, allocatedQuantity: 2, availableQuantity: 0 });
    expect(fresh.find(source => source.groupLabel === "Synthetic bin B1")).toMatchObject({ availableQuantity: 2, blockers: [] });
    expect((await production.wholeOrderFulfillment(context, f.orderId)).items[0]!.readyQuantity).toBe(4);
    await expect(production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A2", 2)], originalGood.id))).rejects.toBeInstanceOf(ConflictException);
    await expect(production.inspectGroups(context, f.source.productionOrderId, { ...childInput, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    const replay = await production.inspectGroups(context, f.source.productionOrderId, childInput);
    expect(replay).toMatchObject({ inspectionId: child.inspectionId, replayed: true });
    expect(replay.workspace.groups).toHaveLength(4);
  });

  it("rejects incomplete coverage, stale basis, altered replay actors and tenant leakage without changing the original groups", async () => {
    const f = await fixture(2);
    await expect(production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A", 1)]))).rejects.toBeInstanceOf(UnprocessableEntityException);
    const input = await f.input([group("A", 1), group("B", 1, ["COLOR"])]);
    const saved = await production.inspectGroups(context, f.source.productionOrderId, input);
    await expect(production.inspectGroups(context, f.source.productionOrderId, { ...input, idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
    await expect(production.inspectGroups(context, f.source.productionOrderId, { ...input, groups: [group("C", 2)] })).rejects.toBeInstanceOf(ConflictException);
    await expect(production.inspectGroups({ ...context, userId: otherUserId }, f.source.productionOrderId, input)).rejects.toBeInstanceOf(ConflictException);
    await expect(production.qualityGroups(other, f.source.productionOrderId)).rejects.toBeInstanceOf(NotFoundException);
    expect(await withTenant(database.db, other, tx => tx.select().from(qualityInspectionGroups))).toEqual([]);
    const replay = await production.inspectGroups(context, f.source.productionOrderId, input);
    expect(replay).toMatchObject({ inspectionId: saved.inspectionId, replayed: true });
    expect(replay.workspace.groups).toHaveLength(2);
  });

  it("enforces exact group quantity links, immutable history and non-owner RLS in the database", async () => {
    const f = await fixture(2), created = await production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A", 1), group("B", 1, ["COLOR"])]));
    const held = created.workspace.groups.find(item => item.result === "failed")!;
    await databaseCode(database.client.unsafe("update quality_inspection_groups set label='Changed synthetic bin' where id=$1", [held.id]), "23514");
    await databaseCode(withTenant(database.db, context, async tx => {
      const id = createEntityId();
      await tx.insert(qualityDefects).values({ id, tenantId, productionOrderId: f.source.productionOrderId, inspectionId: created.inspectionId,
        code: "EXTRA", severity: "major", responsibility: "supplier", disposition: "remake", encryptedDetail: vault.encrypt("Synthetic extra defect"), detailChecksum: "a".repeat(64), evidenceAssetIds: [] });
      await tx.insert(qualityGroupDefects).values({ defectId: id, tenantId, qualityGroupId: held.id, productionOrderId: f.source.productionOrderId, inspectionId: created.inspectionId, affectedQuantity: 2 });
    }), "23503");
    await databaseCode(withTenant(database.db, context, tx => tx.insert(qualityInspections).values({ id: createEntityId(), tenantId, productionOrderId: f.source.productionOrderId,
      productionVersionId: f.source.productionVersionId, productionProjectionVersion: created.workspace.projectionVersion, assessmentVersion: 3, criterionResults: null,
      qualityStandardVersionId: f.source.standardId, result: "passed", scoreBps: 10000, inspectedAt: new Date(), inspectedBy: userId, idempotencyKey: randomUUID(), requestChecksum: "b".repeat(64) })), "23514");
    const [role] = await withTenant(database.db, context, tx => tx.execute(sql`select current_user as name`));
    expect(role!.name).toBe("yummyai_app");
    const sources = await shipping.productionSources(context, f.orderId), passed = sources.find(source => !source.blockers.length)!;
    const shipment = await shipping.create(context, f.orderId, shipmentInput(f, passed, 1)), allocation = shipment.productionAllocations[0]!;
    await databaseCode(withTenant(database.db, context, tx => tx.insert(shipmentProductionAllocations).values({ ...allocation, id: createEntityId(), qualityGroupId: held.id, qualityResult: null, groupQualityResult: "passed" })), "23503");
    expect((await production.qualityGroups(context, f.source.productionOrderId)).groups).toHaveLength(2);
  });

  it("requires the physical group even when every group in its inspection passed", async () => {
    const f = await fixture(1);
    await production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A", 1)]));
    const source = (await shipping.productionSources(context, f.orderId))[0]!;
    const shipment = await shipping.create(context, f.orderId, shipmentInput(f, source, 1));
    const allocation = shipment.productionAllocations[0]!;
    await databaseCode(withTenant(database.db, context, tx => tx.insert(shipmentProductionAllocations).values({ ...allocation,
      id: createEntityId(), qualityGroupId: null, qualityResult: "passed", groupQualityResult: null })), "23514", "grouped quality requires its own physical source");
    expect((await shipping.get(context, shipment.shipment.id)).productionAllocations).toHaveLength(1);
  });

  it("shares one held group's remake balance across different defects and competing requests", async () => {
    const f = await fixture(3), inspected = await production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A", 1), group("B", 2, ["COLOR", "STITCH"])]));
    const held = inspected.workspace.groups.find(item => item.key === "B")!;
    const request = (defectId: string, quantity: number) => ({ type: "remake", capacityPlan: f.source.capacityPlan, manufacturing: f.source.manufacturing, originalProductionOrderId: f.source.productionOrderId,
      qualityGroupId: held.id, defectId, remakeQuantity: quantity, expectedProductionProjectionVersion: inspected.workspace.projectionVersion,
      physicalSelectionConfirmed: true, reason: "Synthetic segregated group remake", expectedCompletionAt: new Date(Date.now() + 86400_000).toISOString(), idempotencyKey: randomUUID() });
    const firstInput = request(held.defects[0]!.id, 1);
    await expect(production.recover(context, firstInput)).rejects.toBeInstanceOf(ForbiddenError);
    const first = await production.recover(productionContext, firstInput);
    expect((await production.qualityGroups(context, f.source.productionOrderId)).groups.find(item => item.id === held.id)).toMatchObject({ remakeQuantity: 1, remainingRemakeQuantity: 1 });
    const competing = await Promise.allSettled([production.recover(productionContext, request(held.defects[0]!.id, 1)), production.recover(productionContext, request(held.defects[1]!.id, 1))]);
    expect(competing.filter(item => item.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter(item => item.status === "rejected")).toHaveLength(1);
    await expect(production.recover(productionContext, request(held.defects[1]!.id, 1))).rejects.toBeInstanceOf(ConflictException);
    await expect(production.inspectGroups(context, f.source.productionOrderId, await f.input([group("B2", 2)], held.id))).rejects.toBeInstanceOf(ConflictException);
    expect(await production.recover(productionContext, firstInput)).toEqual(first);
    await expect(production.recover(productionContext, { ...firstInput, remakeQuantity: 2 })).rejects.toBeInstanceOf(ConflictException);
    await expect(production.recover({ ...productionContext, userId: otherUserId }, firstInput)).rejects.toBeInstanceOf(ConflictException);
    expect((await shipping.productionSources(context, f.orderId)).find(source => source.groupLabel === "Synthetic bin A")).toMatchObject({ availableQuantity: 1, blockers: [] });
    expect((await production.wholeOrderFulfillment(context, f.orderId)).items[0]!.readyQuantity).toBe(1);
    await production.recordRecoveryEvent(context, first.recoveryId, { action: "cancel", expectedProjectionVersion: 1, outcomeCode: "SYNTHETIC_CASE_CANCEL", occurredAt: new Date().toISOString(), note: null, externalReference: null });
    expect((await production.qualityGroups(context, f.source.productionOrderId)).groups.find(item => item.id === held.id)!.remainingRemakeQuantity).toBe(0);
    let child = await production.get(context, first.replacementProductionOrderId!);
    child = await production.recordMilestone(context, child.productionOrder.id, {
      type: "cancel_requested", expectedProjectionVersion: child.productionOrder.projectionVersion, occurredAt: new Date().toISOString(),
      externalEventId: randomUUID(), evidence: { code: "SYNTHETIC_FACTORY_STOP_REQUEST", note: null, assetIds: [] },
    });
    // Factory status alone does not free remake quantity. Attest the unstarted
    // unit and approve its physical stop through the quantity owner first.
    expect((await production.qualityGroups(context, f.source.productionOrderId)).groups.find(item => item.id === held.id)!.remainingRemakeQuantity).toBe(0);
    const basis = (await quantities.workspace(productionContext, child.productionOrder.id)).basis;
    const reported = await quantities.recordReport(productionContext, child.productionOrder.id, {
      idempotencyKey: randomUUID(), productionVersionId: basis.productionVersionId,
      expectedProductionProjectionVersion: basis.projectionVersion, expectedReviewId: basis.reviewId,
      expectedBasisFingerprint: basis.fingerprint, observedAt: await databaseTime(),
      quantities: { unstartedQuantity: 1, inProcessQuantity: 0, completedQuantity: 0, scrappedQuantity: 0 },
      evidenceCode: "SYNTHETIC_FACTORY_UNSTARTED", evidenceAssetIds: [],
    });
    await quantities.review(productionContext, child.productionOrder.id, {
      idempotencyKey: randomUUID(), reportId: reported.report.id, expectedProductionProjectionVersion: basis.projectionVersion,
      expectedReviewId: basis.reviewId, expectedBasisFingerprint: basis.fingerprint, stoppedDelta: 1,
      unstartedAcrossAllPoolsConfirmed: true, evidenceCode: "SYNTHETIC_STOP_ALL_POOLS_UNSTARTED", occurredAt: await databaseTime(),
    });
    child = await production.get(context, child.productionOrder.id);
    child = await production.recordMilestone(context, child.productionOrder.id, {
      type: "cancelled", expectedProjectionVersion: child.productionOrder.projectionVersion, occurredAt: new Date().toISOString(), externalEventId: randomUUID(), evidence: { code: "SYNTHETIC_FACTORY_STOP", note: null, assetIds: [] },
    });
    expect((await production.qualityGroups(context, f.source.productionOrderId)).groups.find(item => item.id === held.id)!.remainingRemakeQuantity).toBe(1);
    const another = await production.recover(productionContext, request(held.defects[1]!.id, 1));
    expect(another.recoveryId).not.toBe(first.recoveryId);
  });

  it("resolves only the matching case's replacement after that replacement's own quantity passes", async () => {
    const f = await fixture(2), inspected = await production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A", 2, ["COLOR"])]));
    const held = inspected.workspace.groups[0]!;
    const request = () => ({ type: "remake", capacityPlan: f.source.capacityPlan, manufacturing: f.source.manufacturing, originalProductionOrderId: f.source.productionOrderId, qualityGroupId: held.id, defectId: held.defects[0]!.id,
      remakeQuantity: 1, expectedProductionProjectionVersion: inspected.workspace.projectionVersion, physicalSelectionConfirmed: true,
      reason: "Synthetic own-case remake", expectedCompletionAt: new Date(Date.now() + 86400_000).toISOString(), idempotencyKey: randomUUID() });
    const first = await production.recover(productionContext, request()), second = await production.recover(productionContext, request());
    let child = await production.get(context, second.replacementProductionOrderId!);
    for (const type of ["submitted", "acknowledged", "started", "completed"] as const) child = await production.recordMilestone(context, child.productionOrder.id, {
      type, expectedProjectionVersion: child.productionOrder.projectionVersion, occurredAt: new Date().toISOString(), externalEventId: randomUUID(), evidence: { code: "SYNTHETIC_FACTORY_PROGRESS", note: null, assetIds: [] },
    });
    await production.inspect(context, child.productionOrder.id, await syntheticQualityInspection(production, context, child.productionOrder.id, {
      qualityStandardVersionId: f.source.standardId, result: "passed", scoreBps: 10000, inspectedAt: await databaseTime(), evidenceAssetIds: [], defects: [], idempotencyKey: randomUUID(),
    }));
    const resolution = () => ({ action: "resolve" as const, expectedProjectionVersion: 1, outcomeCode: "SYNTHETIC_OWN_REPLACEMENT", occurredAt: new Date().toISOString(), note: null, externalReference: null });
    await expect(production.recordRecoveryEvent(context, first.recoveryId, resolution())).rejects.toBeInstanceOf(ConflictException);
    const resolved = await production.recordRecoveryEvent(context, second.recoveryId, resolution());
    expect(resolved.recovery.status).toBe("resolved");
    expect((await production.getRecovery(context, first.recoveryId)).recovery.status).toBe("in_progress");
  });

  it("rolls back quality, exception, replacement and recovery events when their audit cannot commit", async () => {
    const f = await fixture(2), isolatedAudit = new AuditService(database);
    let failAction = "production_order.inspect_groups";
    const writeAudit = isolatedAudit.recordInTransaction.bind(isolatedAudit);
    const failure = vi.spyOn(isolatedAudit, "recordInTransaction").mockImplementation(async (tx, actor, event) => {
      const id = await writeAudit(tx, actor, event);
      if (event.action === failAction) throw new Error("Synthetic audit commit failure");
      return id;
    });
    const service = new OrderProductionService(database, vault, new OrderService(database, vault, isolatedAudit), isolatedAudit, undefined, factories);
    try {
      const input = await f.input([group("A", 1), group("B", 1, ["COLOR"])]);
      await expect(service.inspectGroups(context, f.source.productionOrderId, input)).rejects.toThrow("Synthetic audit commit failure");
      expect((await production.qualityGroups(context, f.source.productionOrderId)).groups).toEqual([]);
      expect((await orders.exceptions(context, f.orderId))).toEqual([]);
      expect((await production.qualityGroups(context, f.source.productionOrderId)).projectionVersion).toBe(input.expectedProductionProjectionVersion);
      failAction = "";
      const saved = await service.inspectGroups(context, f.source.productionOrderId, input);
      expect((await service.inspectGroups(context, f.source.productionOrderId, input)).inspectionId).toBe(saved.inspectionId);
      expect((await orders.exceptions(context, f.orderId))).toHaveLength(1);
      expect((await database.client.unsafe("select count(*)::int as count from audit_events where entity_id=$1 and action='production_order.inspect_groups'", [saved.inspectionId]))[0]!.count).toBe(1);
      const held = saved.workspace.groups.find(item => item.result === "failed")!;
      const remake = { type: "remake", capacityPlan: f.source.capacityPlan, manufacturing: f.source.manufacturing, originalProductionOrderId: f.source.productionOrderId, qualityGroupId: held.id, defectId: held.defects[0]!.id,
        remakeQuantity: 1, expectedProductionProjectionVersion: saved.workspace.projectionVersion, physicalSelectionConfirmed: true,
        reason: "Synthetic atomic remake", expectedCompletionAt: new Date(Date.now() + 86400_000).toISOString(), idempotencyKey: randomUUID() };
      failAction = "production_order.recovery";
      await expect(service.recover(productionContext, remake)).rejects.toThrow("Synthetic audit commit failure");
      expect((await database.client.unsafe("select count(*)::int as count from production_orders where parent_production_order_id=$1", [f.source.productionOrderId]))[0]!.count).toBe(0);
      expect((await database.client.unsafe("select count(*)::int as count from production_recovery_cases where original_production_order_id=$1", [f.source.productionOrderId]))[0]!.count).toBe(0);
      expect((await production.qualityGroups(context, f.source.productionOrderId)).groups.find(item => item.id === held.id)!.remainingRemakeQuantity).toBe(1);
      failAction = "";
      const recovery = await service.recover(productionContext, remake);
      expect(await service.recover(productionContext, remake)).toEqual(recovery);
      const event = { action: "cancel" as const, expectedProjectionVersion: 1, outcomeCode: "SYNTHETIC_ATOMIC_CANCEL", occurredAt: new Date().toISOString(), note: null, externalReference: null };
      const before = await production.getRecovery(context, recovery.recoveryId);
      failAction = "production_recovery.event";
      await expect(service.recordRecoveryEvent(context, recovery.recoveryId, event)).rejects.toThrow("Synthetic audit commit failure");
      expect(await production.getRecovery(context, recovery.recoveryId)).toEqual(before);
      failAction = "";
      expect((await service.recordRecoveryEvent(context, recovery.recoveryId, event)).recovery.status).toBe("cancelled");
    } finally { failure.mockRestore(); }
  });

  it("requires the current held group and a defect belonging to that exact group", async () => {
    const f = await fixture(2), inspected = await production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A", 1, ["COLOR"]), group("B", 1, ["STITCH"])]));
    const [a, b] = inspected.workspace.groups;
    const request = { type: "remake", capacityPlan: f.source.capacityPlan, manufacturing: f.source.manufacturing, originalProductionOrderId: f.source.productionOrderId, qualityGroupId: a!.id, defectId: b!.defects[0]!.id,
      remakeQuantity: 1, expectedProductionProjectionVersion: inspected.workspace.projectionVersion, physicalSelectionConfirmed: true,
      reason: "Synthetic invalid group defect", expectedCompletionAt: new Date(Date.now() + 86400_000).toISOString(), idempotencyKey: randomUUID() };
    await expect(production.recover(productionContext, request)).rejects.toBeInstanceOf(ConflictException);
    const legacy = Object.fromEntries(Object.entries(request).filter(([key]) => !["qualityGroupId", "physicalSelectionConfirmed", "expectedProductionProjectionVersion"].includes(key)));
    await expect(production.recover(productionContext, legacy)).rejects.toBeInstanceOf(UnprocessableEntityException);
    await production.inspectGroups(context, f.source.productionOrderId, await f.input([group("A2", 1)], a!.id));
    const current = await production.qualityGroups(context, f.source.productionOrderId);
    await expect(production.recover(productionContext, { ...request, defectId: a!.defects[0]!.id, expectedProductionProjectionVersion: current.projectionVersion })).rejects.toBeInstanceOf(ConflictException);
  });

  it("rechecks actual personal membership before grouped reads, writes and original receipt recovery", async () => {
    const f = await fixture(1);
    const currentMembers = await withTenant(database.db, context, tx => tx.select().from(memberships).where(eq(memberships.userId, userId)));
    expect(currentMembers).toHaveLength(1);
    expect(currentMembers[0]!.status).toBe("active");
    const memberId = currentMembers[0]!.id;
    const personal = { ...context, ...summarizeRoleGrants([{ permissions, scope: "tenant" }]) };
    const whole = await syntheticQualityInspection(production, personal, f.source.productionOrderId, { qualityStandardVersionId: f.source.standardId,
      result: "passed", scoreBps: 10000, inspectedAt: await databaseTime(), evidenceAssetIds: [], defects: [], idempotencyKey: randomUUID() });
    const original = await production.inspect(personal, f.source.productionOrderId, whole);
    const input = await f.input([group("A", 1)]);
    await production.inspectGroups(personal, f.source.productionOrderId, input);
    const recoveryInput = { type: "cancellation_compensation", originalProductionOrderId: f.source.productionOrderId, reason: "Synthetic internal compensation case",
      compensationAmountMinor: 0, compensationCurrency: "USD", idempotencyKey: randomUUID() };
    const recovery = await production.recover(personal, recoveryInput);
    await database.client.unsafe("update memberships set status='disabled' where id=$1", [memberId]);
    try {
      await expect(production.qualityGroups(personal, f.source.productionOrderId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(production.inspectGroups(personal, f.source.productionOrderId, input)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(production.inspect(personal, f.source.productionOrderId, whole)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(production.recover(personal, recoveryInput)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(production.getRecovery(personal, recovery.recoveryId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(production.reviewRecoveries(personal, f.orderId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(production.recordRecoveryEvent(personal, recovery.recoveryId, { action: "resolve", expectedProjectionVersion: 1, outcomeCode: "SYNTHETIC_REVOKED", occurredAt: new Date().toISOString(), note: null, externalReference: "synthetic-only" })).rejects.toBeInstanceOf(ForbiddenError);
    } finally { await database.client.unsafe("update memberships set status='active' where id=$1", [memberId]); }
    const replay = await production.inspect(personal, f.source.productionOrderId, whole);
    expect(replay.inspections.some(item => item.id === original.inspections[0]!.id)).toBe(true);
    expect((await database.client.unsafe("select count(*)::int as count from audit_events where entity_id=$1 and action='production_order.inspect'", [original.inspections[0]!.id]))[0]!.count).toBe(1);
  });
});

async function databaseCode(promise: PromiseLike<unknown>, code: string, message?: string) {
  let actual: string | undefined, actualMessage: string | undefined;
  try { await promise; } catch (error) {
    const value = error as { code?: string; message?: string; cause?: { code?: string; message?: string } };
    actual = value.cause?.code ?? value.code; actualMessage = value.cause?.message ?? value.message;
  }
  expect(actual).toBe(code);
  if (message) expect(actualMessage).toContain(message);
}

async function boundedAttempt(operation: Promise<unknown>, milliseconds = 5000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(() => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error })),
      new Promise<{ status: "timeout" }>(resolve => { timer = setTimeout(() => resolve({ status: "timeout" }), milliseconds); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
