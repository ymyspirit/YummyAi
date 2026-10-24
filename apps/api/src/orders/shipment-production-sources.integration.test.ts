import { randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { ForbiddenError, Permission, summarizeRoleGrants } from "@yummyai/authz";
import { CreateShipmentInputSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, orderLines, shipmentPackageLines, shipmentPackages, shipmentProductionAllocations, shipmentVersions, shipments, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { syntheticPassedProduction } from "./shipment-production-fixture.js";

describe("shipment production source identity and concurrent quantity reservations", () => {
  const database = connectDatabase(), tenantId = createEntityId(), userId = createEntityId(), otherUserId = createEntityId(), accountId = createEntityId();
  const otherTenantId = createEntityId();
  const context: TenantContext = { tenantId, userId, permissions: [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], dataScope: "tenant" };
  const other: TenantContext = { ...context, tenantId: otherTenantId, userId: otherUserId };
  const vault = new SecretVault(Buffer.alloc(32, 62)), audit = new AuditService(database), orders = new OrderService(database, vault, audit);
  const shipping = new OrderShipmentService(database, vault, orders, audit, { enqueue: async () => undefined });
  const production = new OrderProductionService(database, vault, orders, audit);
  beforeAll(async () => {
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic source A',$2),($3,'Synthetic source B',$4)", [tenantId, `source-a-${tenantId}`, otherTenantId, `source-b-${otherTenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic source operator'),($4,$5,$6,'Synthetic other operator')", [userId, `source-${userId}`, `${userId}@example.test`, otherUserId, `source-${otherUserId}`, `${otherUserId}@example.test`]);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'etsy','Synthetic source shop','GLOBAL','etsy_oauth',$3)", [accountId, tenantId, userId]);
  });
  afterAll(async () => { await database.client.end(); });
  async function databaseTime() {
    const [row] = await withTenant(database.db, context, tx => tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`)); return new Date(row!.now).toISOString();
  }

  async function fixture(quantities: number[], lots = quantities.map((quantity, index) => ({ index, quantity }))) {
    const suffix = randomUUID();
    const order = await orders.ingestNormalized(context, { accountId, platform: "etsy", externalEventId: suffix, externalOrderId: suffix,
      providerStatus: "paid", placedAt: "2026-07-22T00:00:00.000Z", orderTotal: null,
      lines: quantities.map((quantity, index) => ({ externalLineId: `synthetic-${index}`, externalListingId: null, skuCode: null, title: `Synthetic stock ${index}`, quantity, unitPrice: null, customizationCount: 0 })),
      redactedSource: { synthetic: true }, protectedDetails: null });
    // Isolated stock-history fixture; production files/factory acceptance are tested by the full artwork flow.
    await database.client.unsafe("update orders set workflow_state='awaiting_shipment',address_status='protected' where id=$1", [order.id]);
    const sources = await syntheticPassedProduction(database, context, order.id, lots.map(lot => ({ id: order.lines[lot.index]!.id, quantity: lot.quantity })));
    const input = (index = 0, quantity = sources[index]!.quantity) => {
      const source = sources[index]!;
      return CreateShipmentInputSchema.parse({ shipDate: "2026-07-24T00:00:00.000Z", shipFromCountryCode: "US", idempotencyKey: randomUUID(),
        packages: [{ packageReferenceId: randomUUID(), trackingNumber: randomUUID(), carrierCode: "SYNTHETIC", carrierName: "Synthetic carrier", carrierService: "Synthetic service",
          lines: [{ orderLineId: source.orderLineId, quantity, productionAllocations: [{ productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
            qualityInspectionId: source.qualityInspectionId, expectedProductionProjectionVersion: source.expectedProductionProjectionVersion, quantity }] }] }] });
    };
    return { orderId: order.id, lines: order.lines, sources, input };
  }
  const review = (key = randomUUID()) => ({ decision: "approved" as const, reasonCode: "SYNTHETIC_VERIFIED", reason: "Synthetic physical source attestation", expectedCurrentVersion: 1, idempotencyKey: key });
  const handover = () => ({ expectedVersion: 1, occurredAt: new Date(Date.now() - 2000).toISOString(), reason: "Synthetic actual isolated handover", idempotencyKey: randomUUID() });

  it("requires explicit complete sources and refuses the wrong line, version and tenant", async () => {
    const f = await fixture([2, 1]), valid = f.input(0, 1);
    const missing = structuredClone(valid); delete missing.packages[0]!.lines[0]!.productionAllocations;
    await expect(shipping.create(context, f.orderId, missing)).rejects.toBeInstanceOf(UnprocessableEntityException);
    const wrongLine = structuredClone(valid); wrongLine.packages[0]!.lines[0]!.orderLineId = f.lines[1]!.id;
    await expect(shipping.create(context, f.orderId, wrongLine)).rejects.toBeInstanceOf(UnprocessableEntityException);
    const wrongVersion = structuredClone(valid); wrongVersion.packages[0]!.lines[0]!.productionAllocations![0]!.productionVersionId = f.sources[1]!.productionVersionId;
    await expect(shipping.create(context, f.orderId, wrongVersion)).rejects.toBeInstanceOf(ConflictException);
    await expect(shipping.productionSources(other, f.orderId)).rejects.toBeInstanceOf(NotFoundException);
    const created = await shipping.create(context, f.orderId, valid);
    expect(created.versions[0]!.productionSourceVersion).toBe(2);
    expect(created.productionAllocations).toHaveLength(1);
    expect(created.productionAllocations[0]).toMatchObject({ quantity: 1, productionOrderId: f.sources[0]!.productionOrderId, productionVersionId: f.sources[0]!.productionVersionId, qualityInspectionId: f.sources[0]!.qualityInspectionId });
    const role = await withTenant(database.db, context, tx => tx.execute(sql`select current_user as role`));
    expect(role[0]?.role).toBe("yummyai_app");
    expect(await withTenant(database.db, other, tx => tx.select().from(shipmentProductionAllocations))).toEqual([]);
  });

  it("reserves the actual production lot atomically even when ordered quantity would permit both packages", async () => {
    const f = await fixture([2], [{ index: 0, quantity: 1 }, { index: 0, quantity: 1 }]);
    const [a, b] = await Promise.all([shipping.create(context, f.orderId, f.input(0)), shipping.create(context, f.orderId, f.input(0))]);
    expect((await shipping.productionSources(context, f.orderId))[0]!.allocatedQuantity).toBe(0);
    const results = await Promise.allSettled([shipping.reviewVersion(context, a.shipment.id, a.versions[0]!.id, review()), shipping.reviewVersion(context, b.shipment.id, b.versions[0]!.id, review())]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    const failure = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(failure.reason).toBeInstanceOf(ConflictException);
    const source = (await shipping.productionSources(context, f.orderId)).find(source => source.productionOrderId === f.sources[0]!.productionOrderId)!;
    expect(source).toMatchObject({ allocatedQuantity: 1, availableQuantity: 0 });
  });

  it("retains the prior approved reservation until the new version is reviewed and switches both lots together", async () => {
    const f = await fixture([2], [{ index: 0, quantity: 1 }, { index: 0, quantity: 1 }]);
    const a = await shipping.create(context, f.orderId, f.input(0));
    await shipping.reviewVersion(context, a.shipment.id, a.versions[0]!.id, review());
    const revision = await shipping.appendVersion(context, a.shipment.id, { ...f.input(1), expectedCurrentVersion: 1 });
    const b = await shipping.create(context, f.orderId, f.input(0));
    await expect(shipping.reviewVersion(context, b.shipment.id, b.versions[0]!.id, review())).rejects.toBeInstanceOf(ConflictException);
    await shipping.reviewVersion(context, a.shipment.id, revision.versions[1]!.id, { ...review(), expectedCurrentVersion: 2 });
    await shipping.reviewVersion(context, b.shipment.id, b.versions[0]!.id, review());
    expect((await shipping.get(context, a.shipment.id)).productionAllocations).toHaveLength(2);
    expect((await shipping.productionSources(context, f.orderId)).every(source => source.availableQuantity === 0)).toBe(true);
  });

  it("checks request content, version and original actor on create, revision and review recovery", async () => {
    const f = await fixture([1]), input = f.input();
    const created = await shipping.create(context, f.orderId, input);
    expect((await shipping.create(context, f.orderId, input)).shipment.id).toBe(created.shipment.id);
    await expect(shipping.create(context, f.orderId, { ...input, shipFromCountryCode: "CN" })).rejects.toBeInstanceOf(ConflictException);
    await expect(shipping.create({ ...context, userId: otherUserId }, f.orderId, input)).rejects.toBeInstanceOf(ConflictException);
    const revisionInput = { ...f.input(), expectedCurrentVersion: 1 };
    const revision = await shipping.appendVersion(context, created.shipment.id, revisionInput);
    expect((await shipping.appendVersion(context, created.shipment.id, revisionInput)).versions).toHaveLength(2);
    await expect(shipping.appendVersion(context, created.shipment.id, { ...revisionInput, shipFromCountryCode: "CN" })).rejects.toBeInstanceOf(ConflictException);
    const approvedInput = { ...review(), expectedCurrentVersion: 2 };
    await shipping.reviewVersion(context, created.shipment.id, revision.versions[1]!.id, approvedInput);
    expect((await shipping.reviewVersion(context, created.shipment.id, revision.versions[1]!.id, approvedInput)).reviews).toHaveLength(1);
    await expect(shipping.reviewVersion(context, created.shipment.id, revision.versions[1]!.id, { ...approvedInput, reason: "Changed retry" })).rejects.toBeInstanceOf(ConflictException);
    await expect(shipping.reviewVersion({ ...context, userId: otherUserId }, created.shipment.id, revision.versions[1]!.id, approvedInput)).rejects.toBeInstanceOf(ConflictException);
  });

  it("rechecks original quality and production pins at dispatch and preserves the approved draft on conflict", async () => {
    const f = await fixture([1]), input = f.input(), created = await shipping.create(context, f.orderId, input);
    await shipping.reviewVersion(context, created.shipment.id, created.versions[0]!.id, review());
    const source = f.sources[0]!;
    const changed = await production.inspect(context, source.productionOrderId, { qualityStandardVersionId: source.standardId, expectedProductionProjectionVersion: source.expectedProductionProjectionVersion,
      result: "passed", scoreBps: 10000, assessment: { formatVersion: 2, criterionResults: [{ code: "STOCK", scoreBps: 10000, passed: true, evidenceAssetIds: [] }] },
      evidenceAssetIds: [], defects: [], inspectedAt: await databaseTime(), idempotencyKey: randomUUID() });
    expect(changed.productionOrder.projectionVersion).toBe(source.expectedProductionProjectionVersion + 1);
    await expect(shipping.dispatch(context, created.shipment.id, handover())).rejects.toBeInstanceOf(ConflictException);
    const preserved = await shipping.get(context, created.shipment.id);
    expect(preserved.shipment.status).toBe("approved"); expect(preserved.tracking).toHaveLength(0);
    expect(preserved.productionAllocations[0]!.qualityInspectionId).toBe(source.qualityInspectionId);
  });

  it("keeps physically used quantity consumed after cancellation and allows QC only for a different unshipped batch", async () => {
    const f = await fixture([2], [{ index: 0, quantity: 1 }, { index: 0, quantity: 1 }]);
    const created = await shipping.create(context, f.orderId, f.input(0));
    await shipping.reviewVersion(context, created.shipment.id, created.versions[0]!.id, review());
    const dispatch = handover();
    await shipping.dispatch(context, created.shipment.id, dispatch);
    expect((await shipping.dispatch(context, created.shipment.id, dispatch)).tracking).toHaveLength(1);
    // Adversarial projection change must never erase existing physical evidence.
    await withTenant(database.db, context, tx => tx.update(shipments).set({ status: "cancelled" }).where(eq(shipments.id, created.shipment.id)));
    const sources = await shipping.productionSources(context, f.orderId);
    expect(sources.find(source => source.productionOrderId === f.sources[0]!.productionOrderId)?.availableQuantity).toBe(0);
    expect(sources.find(source => source.productionOrderId === f.sources[1]!.productionOrderId)?.availableQuantity).toBe(1);
    const next = await shipping.create(context, f.orderId, f.input(0));
    await expect(shipping.reviewVersion(context, next.shipment.id, next.versions[0]!.id, review())).rejects.toBeInstanceOf(ConflictException);
    const inspect = async (index: number) => production.inspect(context, f.sources[index]!.productionOrderId, { qualityStandardVersionId: f.sources[index]!.standardId, expectedProductionProjectionVersion: f.sources[index]!.expectedProductionProjectionVersion,
      result: "passed", scoreBps: 10000, assessment: { formatVersion: 2, criterionResults: [{ code: "STOCK", scoreBps: 10000, passed: true, evidenceAssetIds: [] }] },
      evidenceAssetIds: [], defects: [], inspectedAt: await databaseTime(), idempotencyKey: randomUUID() });
    await expect(inspect(0)).rejects.toThrow("该生产批次已有实际交运");
    expect((await inspect(1)).productionOrder.projectionVersion).toBe(f.sources[1]!.expectedProductionProjectionVersion + 1);
  });

  it("enforces immutable source history and rejects incomplete quantities inside the non-owner database boundary", async () => {
    const f = await fixture([1]), created = await shipping.create(context, f.orderId, f.input());
    await expect(database.client.unsafe("update shipment_production_allocations set quantity=2 where id=$1", [created.productionAllocations[0]!.id])).rejects.toMatchObject({ code: "23514" });
    await expect(database.client.unsafe("delete from shipment_package_lines where id=$1", [created.packageLines[0]!.id])).rejects.toMatchObject({ code: "23514" });
    await expect(withTenant(database.db, context, tx => tx.insert(shipmentVersions).values({ id: createEntityId(), tenantId, shipmentId: created.shipment.id,
      versionNumber: 2, shipDate: new Date(), shipFromCountryCode: "US", idempotencyKey: randomUUID(), createdBy: userId }))).rejects.toThrow();
    await expect(withTenant(database.db, context, tx => tx.insert(shipmentVersions).values({ id: createEntityId(), tenantId, shipmentId: created.shipment.id,
      versionNumber: 2, shipDate: new Date(), shipFromCountryCode: "US", idempotencyKey: randomUUID(), createdBy: userId, productionSourceVersion: 2, requestChecksum: "a".repeat(64) }))).rejects.toThrow();
    expect((await shipping.get(context, created.shipment.id)).versions).toHaveLength(1);
    expect(await withTenant(database.db, other, tx => tx.select().from(orderLines).where(eq(orderLines.orderId, f.orderId)))).toEqual([]);
  });

  it("checks live membership even when replaying a successful original command", async () => {
    const f = await fixture([1]), input = f.input(), memberId = createEntityId(), roleId = createEntityId();
    await database.client.unsafe("insert into memberships(id,tenant_id,user_id,status) values($1,$2,$3,'active')", [memberId, tenantId, userId]);
    await database.client.unsafe("insert into roles(id,tenant_id,name,permissions,data_scope) values($1,$2,$3,$4::jsonb,'tenant')", [roleId, tenantId, `Synthetic source role ${roleId}`, JSON.stringify(context.permissions)]);
    await database.client.unsafe("insert into membership_roles(tenant_id,membership_id,role_id) values($1,$2,$3)", [tenantId, memberId, roleId]);
    const personal = { ...context, ...summarizeRoleGrants([{ permissions: context.permissions, scope: "tenant" }]) };
    const created = await shipping.create(personal, f.orderId, input);
    await database.client.unsafe("update memberships set status='disabled' where id=$1", [memberId]);
    await expect(shipping.create(personal, f.orderId, input)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(shipping.get(personal, created.shipment.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(shipping.productionSources(personal, f.orderId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(shipping.versionEditor(personal, created.shipment.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("enforces package, production and quality identity together and rejects quantity gaps at commit", async () => {
    const f = await fixture([1, 1]), created = await shipping.create(context, f.orderId, f.input());
    const probe = (kind: "wrong-line" | "wrong-inspection" | "wrong-total") => withTenant(database.db, context, async tx => {
      const versionId = createEntityId(), packageId = createEntityId(), packageLineId = createEntityId();
      await tx.insert(shipmentVersions).values({ ...created.versions[0]!, id: versionId, versionNumber: 2, idempotencyKey: randomUUID() });
      await tx.insert(shipmentPackages).values({ ...created.packages[0]!, id: packageId, shipmentVersionId: versionId });
      await tx.insert(shipmentPackageLines).values({ ...created.packageLines[0]!, id: packageLineId, shipmentVersionId: versionId, packageId });
      const source = kind === "wrong-line" ? f.sources[1]! : f.sources[0]!;
      await tx.insert(shipmentProductionAllocations).values({ ...created.productionAllocations[0]!, id: createEntityId(), shipmentVersionId: versionId, packageId, packageLineId,
        productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
        qualityInspectionId: kind === "wrong-inspection" ? f.sources[1]!.qualityInspectionId : source.qualityInspectionId, quantity: kind === "wrong-total" ? 2 : 1 });
    });
    await expect(probe("wrong-line")).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(probe("wrong-inspection")).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(probe("wrong-total")).rejects.toMatchObject({ code: "23514" });
    expect((await shipping.get(context, created.shipment.id)).versions).toHaveLength(1);
  });

  it("preserves unexpected carrier facts after QC changes and keeps their consumed quantities", async () => {
    const f = await fixture([2], [{ index: 0, quantity: 1 }, { index: 0, quantity: 1 }]);
    const created = await shipping.create(context, f.orderId, f.input(0));
    await shipping.reviewVersion(context, created.shipment.id, created.versions[0]!.id, review());
    const source = f.sources[0]!;
    await production.inspect(context, source.productionOrderId, { qualityStandardVersionId: source.standardId, expectedProductionProjectionVersion: source.expectedProductionProjectionVersion,
      result: "failed", scoreBps: 5000, assessment: { formatVersion: 2, criterionResults: [{ code: "STOCK", scoreBps: 5000, passed: false, evidenceAssetIds: [] }] },
      evidenceAssetIds: [], defects: [{ code: "STOCK", severity: "major", responsibility: "supplier", disposition: "remake", note: "Synthetic actual defect", evidenceAssetIds: [] }],
      inspectedAt: await databaseTime(), idempotencyKey: randomUUID() });
    const tracking = { packageId: created.packages[0]!.id, status: "picked_up" as const, provider: "synthetic-carrier", externalEventId: randomUUID(), detailCode: "SYNTHETIC_PHYSICAL_HANDOVER", occurredAt: new Date(Date.now() - 1000).toISOString(), estimatedDeliveryAt: null };
    const observed = await shipping.recordTrackingEvent(context, created.shipment.id, tracking);
    expect(observed.tracking).toHaveLength(1); expect(observed.shipment.status).toBe("exception");
    expect((await orders.exceptions(context, f.orderId)).some(row => row.code === "PRODUCTION_SOURCE_CHANGED_AT_HANDOVER")).toBe(true);
    expect((await shipping.productionSources(context, f.orderId)).find(row => row.productionOrderId === source.productionOrderId)?.allocatedQuantity).toBe(1);
    expect((await shipping.recordTrackingEvent(context, created.shipment.id, tracking)).tracking).toHaveLength(1);
    await expect(shipping.recordTrackingEvent(context, created.shipment.id, { ...tracking, detailCode: "CHANGED_RETRY" })).rejects.toBeInstanceOf(ConflictException);
  });
});
