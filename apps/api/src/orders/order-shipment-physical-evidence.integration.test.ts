import { createHash, randomUUID } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { connectDatabase, migrateDatabase, orderEvents, orderLines, orderSourceSnapshots, orderWorkItems, orderWorkRevisions, orders, withTenant } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderService } from "./order.service.js";
import { workProjection } from "./order-workspace-query.js";
import { syntheticPassedProduction } from "./shipment-production-fixture.js";
import { syntheticManufacturingProduct } from "./manufacturing-production.test-fixture.js";
import { sealWork } from "./order-workspace.service.js";
import { OrderProductionService } from "./order-production.service.js";
import { syntheticShipmentAllocations } from "../../../../tools/testing/shipment-fixtures.js";

// Run through the isolated order-daily integration runner. It destroys the
// fixture database after the suite, including immutable operational history.
describe("physical package handover is independent of marketplace acknowledgement", () => {
  const database = connectDatabase();
  const tenantId = createEntityId(), otherTenantId = createEntityId(), userId = createEntityId(), accountId = createEntityId();
  const context: TenantContext = { tenantId, userId, permissions: ["order:read", "order:write", "order:pii:read"], dataScope: "tenant" };
  const vault = new SecretVault(Buffer.alloc(32, 73));
  const audit = new AuditService(database);
  const orderService = new OrderService(database, vault, audit);
  const service = new OrderShipmentService(database, vault, orderService, audit, { enqueue: async () => undefined });

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Physical shipment test',$2),($3,'Other physical tenant',$4)", [tenantId, `physical-${tenantId}`, otherTenantId, `physical-${otherTenantId}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Physical operator')", [userId, `physical-${userId}`, `physical-${userId}@example.test`]);
    await database.client.unsafe("insert into marketplace_accounts(id,tenant_id,platform,display_name,region,authorization_mode,created_by) values($1,$2,'amazon','Physical fixture','NA','amazon_private',$3)", [accountId, tenantId, userId]);
  }, 60_000);
  afterAll(async () => { await database.client.end(); });
  async function databaseTime() {
    const [row] = await withTenant(database.db, context, tx => tx.execute<{ now: Date | string }>(sql`select clock_timestamp() as now`)); return new Date(row!.now).toISOString();
  }

  it("keeps a cancelled production allocation occupied after later physical handover and scopes its current availability", async () => {
    const fixture = await shipmentFixture(1), production = new OrderProductionService(database, vault, orderService, audit);
    expect(await production.productionAvailability(context, fixture.lineId)).toMatchObject({ orderedQuantity: 1, allocatedQuantity: 1, availableQuantity: 0, canRelease: true });
    expect(await production.productionAvailability({ ...context, permissions: ["order:read", "order:pii:read"] }, fixture.lineId)).toMatchObject({ allocatedQuantity: 1, canRelease: false });
    // Persisted synthetic cancellation followed by a late carrier event; no real production action is asserted.
    await withTenant(database.db, context, tx => tx.execute(sql`update production_orders set status='cancelled' where id=${fixture.stock.productionOrderId}`));
    expect(await production.productionAvailability(context, fixture.lineId)).toMatchObject({ allocatedQuantity: 0, availableQuantity: 1 });
    await tracking(fixture, 0, "picked_up");
    await tracking(fixture, 0, "delivery_exception");
    expect(await production.productionAvailability(context, fixture.lineId)).toMatchObject({ allocatedQuantity: 1, availableQuantity: 0 });
    await expect(production.productionAvailability({ ...context, permissions: ["order:read"] }, fixture.lineId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(production.productionAvailability({ ...context, tenantId: otherTenantId }, fixture.lineId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not count an API acknowledgement as handover, and still permits recording the later physical dispatch", async () => {
    const fixture = await shipmentFixture(1);
    const request = await startWriteback(fixture);
    await service.recordWritebackEvent(context, request.id, { action: "accepted", expectedProjectionVersion: 2, providerCode: "HTTP_200", externalReference: "synthetic", occurredAt: new Date().toISOString() });
    expect(await projection(fixture.lineId)).toMatchObject({ shippedQuantity: 0, platformConfirmationPending: false });
    await expect(confirm(fixture)).rejects.toBeInstanceOf(ConflictException);
    await service.dispatch(context, fixture.shipmentId, { expectedVersion: 1, reason: "Carrier collected the fixture", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    expect(await projection(fixture.lineId)).toMatchObject({ shippedQuantity: 1, platformConfirmationPending: false });
  });

  it("requires physical evidence for each approved package and retains that evidence through a later exception", async () => {
    const fixture = await shipmentFixture(2);
    const request = await startWriteback(fixture);
    await service.recordWritebackEvent(context, request.id, { action: "uncertain", expectedProjectionVersion: 2, providerCode: "TIMEOUT", externalReference: null, occurredAt: new Date().toISOString() });
    await tracking(fixture, 0, "information_received");
    await tracking(fixture, 0, "delivery_exception");
    expect(await projection(fixture.lineId)).toMatchObject({ shippedQuantity: 0, platformConfirmationPending: false });
    await expect(confirm(fixture)).rejects.toBeInstanceOf(ConflictException);
    await tracking(fixture, 0, "picked_up");
    await tracking(fixture, 0, "delivery_exception");
    expect(await projection(fixture.lineId)).toMatchObject({ shippedQuantity: 1, platformConfirmationPending: true });
    await expect(confirm(fixture)).rejects.toBeInstanceOf(ConflictException);
    await tracking(fixture, 1, "in_transit");
    expect((await service.get(context, fixture.shipmentId)).physicalHandover).toMatchObject({ packageCount: 2, dispatchedPackageCount: 2, allDispatched: true });
    const key = randomUUID(), confirmedAt = new Date().toISOString();
    await confirm(fixture, key, confirmedAt);
    await confirm(fixture, key, confirmedAt);
    expect((await service.get(context, fixture.shipmentId)).manualConfirmations).toHaveLength(1);
    expect(await projection(fixture.lineId)).toMatchObject({ shippedQuantity: 2, platformConfirmationPending: false });
  });

  it("permits reinspection before actual handover after platform acceptance and revises only the internal production source", async () => {
    const fixture = await shipmentFixture(1), request = await startWriteback(fixture);
    await service.recordWritebackEvent(context, request.id, { action: "accepted", expectedProjectionVersion: 2, providerCode: "HTTP_200", externalReference: "synthetic-source-update", occurredAt: new Date().toISOString() });
    const inspector = new OrderProductionService(database, new SecretVault(Buffer.alloc(32, 62)), orderService, audit);
    const source = fixture.stock;
    await inspector.inspect(context, source.productionOrderId, { qualityStandardVersionId: source.standardId, expectedProductionProjectionVersion: source.expectedProductionProjectionVersion,
      result: "passed", scoreBps: 10000, assessment: { formatVersion: 2, criterionResults: [{ code: "STOCK", scoreBps: 10000, passed: true, evidenceAssetIds: [] }] },
      evidenceAssetIds: [], defects: [], inspectedAt: await databaseTime(), idempotencyKey: randomUUID() });
    const editor = await service.versionEditor(context, fixture.shipmentId);
    expect(editor.canRevise).toBe(true);
    expect(editor.sourceOnly).toBe(true);
    const input = { ...editor.content, expectedCurrentVersion: 1, idempotencyKey: randomUUID(), packages: editor.content.packages.map(pkg => ({ ...pkg,
      lines: pkg.lines.map(line => ({ ...line, productionAllocations: syntheticShipmentAllocations(editor.sources, line.orderLineId, line.quantity) })),
    })) };
    await expect(service.appendVersion(context, fixture.shipmentId, { ...input, shipFromCountryCode: "CN" })).rejects.toBeInstanceOf(ConflictException);
    const revised = await service.appendVersion(context, fixture.shipmentId, input);
    await expect(service.appendVersion(context, fixture.shipmentId, { ...input, expectedCurrentVersion: 2, idempotencyKey: randomUUID(), shipFromCountryCode: "CN" })).rejects.toBeInstanceOf(ConflictException);
    await service.reviewVersion(context, fixture.shipmentId, revised.versions[1]!.id, { decision: "approved", reasonCode: "SYNTHETIC_SOURCE_RECHECK", reason: "Synthetic unchanged waybill, actual batch rechecked", expectedCurrentVersion: 2, idempotencyKey: randomUUID() });
    await service.dispatch(context, fixture.shipmentId, { expectedVersion: 2, reason: "Synthetic actual pickup after reinspection", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    expect(await projection(fixture.lineId)).toMatchObject({ shippedQuantity: 1, platformConfirmationPending: true });
    const result = await service.get(context, fixture.shipmentId);
    expect(result.writebacks).toHaveLength(1); expect(result.writebacks[0]!.shipmentVersionId).toBe(fixture.versionId);
    expect(result.versions[0]!.productionSourceVersion).toBe(2); expect(result.productionAllocations).toHaveLength(2);
  });

  it("does not undo physical dispatch when an in-flight platform request is rejected", async () => {
    const fixture = await shipmentFixture(1);
    const request = await startWriteback(fixture);
    await service.dispatch(context, fixture.shipmentId, { expectedVersion: 1, reason: "Physical handover during API request", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    await service.recordWritebackEvent(context, request.id, { action: "rejected", expectedProjectionVersion: 2, providerCode: "INVALID_TRACKING", externalReference: null, occurredAt: new Date().toISOString() });
    expect((await service.get(context, fixture.shipmentId)).shipment.status).toBe("shipped");
    expect(await projection(fixture.lineId)).toMatchObject({ shippedQuantity: 1, platformConfirmationPending: true });
    await expect(service.dispatch(context, fixture.shipmentId, { expectedVersion: 1, reason: "Duplicate", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(ConflictException);
  });

  it("retains actual tracking on other versions without borrowing current approval and enforces tenant isolation", async () => {
    const fixture = await shipmentFixture(1);
    const editor = await service.versionEditor(context, fixture.shipmentId);
    const revised = await service.appendVersion(context, fixture.shipmentId, { ...editor.content, expectedCurrentVersion: 1, idempotencyKey: randomUUID(),
      packages: editor.content.packages.map(pkg => ({ ...pkg, packageReferenceId: "OTHER-VERSION", trackingNumber: "OTHER-TRACK" })) });
    const otherPackage = revised.packages.find(pkg => pkg.shipmentVersionId === revised.versions[1]!.id)!;
    await service.recordTrackingEvent(context, fixture.shipmentId, { packageId: otherPackage.id, status: "picked_up", provider: "synthetic", externalEventId: randomUUID(), detailCode: "PICKED_UP", occurredAt: new Date().toISOString(), estimatedDeliveryAt: null });
    expect(await projection(fixture.lineId)).toMatchObject({ shippedQuantity: 1, platformConfirmationPending: true });
    expect((await service.get(context, fixture.shipmentId)).physicalHandover.allDispatched).toBe(false);
    expect((await service.get(context, fixture.shipmentId)).shipment.status).toBe("exception");
    await expect(confirm(fixture)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.get({ ...context, tenantId: otherTenantId }, fixture.shipmentId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.recordManualConfirmation({ ...context, tenantId: otherTenantId }, fixture.shipmentId, { expectedVersion: 1, confirmedAt: new Date().toISOString(), evidenceReference: "Wrong tenant", idempotencyKey: randomUUID() })).rejects.toBeInstanceOf(NotFoundException);
  });

  async function shipmentFixture(quantity: number) {
    const orderId = createEntityId(), snapshotId = createEntityId(), lineId = createEntityId(), revisionId = createEntityId();
    const product = await syntheticManufacturingProduct(database, context);
    const draft = OrderWorkDraftSchema.parse({ printProfileVersionId: product.profileVersionId, specificationVersionId: product.specificationVersionId,
      artworkVersionId: product.artworkVersionId, designExecutor: "human", fields: [], images: [], instructions: "Synthetic reviewed handover source", customerApprovalRequired: false, dueAt: null });
    const workKey = Buffer.alloc(32, 15), encryptedDataKey = vault.encrypt(workKey.toString("base64")), encryptedDraft = sealWork(workKey, draft);
    workKey.fill(0);
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(orderSourceSnapshots).values({ id: snapshotId, tenantId, accountId, platform: "amazon", externalEventId: randomUUID(), externalOrderId: `PHYSICAL-${orderId}`, normalizedOrderId: orderId, redactedPayload: { synthetic: true }, payloadChecksum: "a".repeat(64) });
      await tx.insert(orders).values({ id: orderId, tenantId, accountId, sourceSnapshotId: snapshotId, platform: "amazon", externalOrderId: `PHYSICAL-${orderId}`, providerStatus: "paid", workflowState: "awaiting_shipment", orderTotalMinor: 2500, orderCurrency: "USD", lineCount: 1, addressStatus: "protected", addressCountryCode: "US", latestEventSequence: 1, placedAt: new Date() });
      await tx.insert(orderLines).values({ id: lineId, tenantId, orderId, externalLineId: `LINE-${lineId}`, title: "Synthetic handover item", quantity, unitPriceMinor: 2500, unitPriceCurrency: "USD" });
      await tx.insert(orderEvents).values({ id: createEntityId(), tenantId, orderId, sequence: 1, type: "order_ingested", toWorkflowState: "awaiting_shipment", idempotencyKey: randomUUID(), actorUserId: userId });
      await tx.insert(orderWorkItems).values({ id: lineId, tenantId, revision: 1, encryptedDataKey, expiresAt: new Date(Date.now() + 86400000) });
      await tx.insert(orderWorkRevisions).values({ id: revisionId, tenantId, workItemId: lineId, revision: 1, profileVersionId: product.profileVersionId,
        encryptedDraft, checksum: createHash("sha256").update(JSON.stringify(draft)).digest("hex"), createdBy: userId });
    });
    const [stock] = await syntheticPassedProduction(database, context, orderId, [{ id: lineId, quantity }], undefined, {
      vault, workSources: new Map([[lineId, { revisionId, manufacturing: product.manufacturing }]]),
    });
    const created = await service.create(context, orderId, { shipDate: new Date().toISOString(), promisedDeliveryAt: null, estimatedDeliveryAt: null, shipFromCountryCode: "US", idempotencyKey: randomUUID(), packages: Array.from({ length: quantity }, (_, i) => ({ packageReferenceId: `PKG-${i}`, trackingNumber: `TRACK-${orderId}-${i}`, carrierCode: "UPS", carrierName: "UPS", carrierService: "Ground", labelAssetId: null, externalLabelId: null, labelCostMinor: null, labelCurrency: null, weightGrams: null, dimensionsMm: null, lines: [{ orderLineId: lineId, quantity: 1, productionAllocations: [{ productionOrderId: stock!.productionOrderId, productionVersionId: stock!.productionVersionId, qualityInspectionId: stock!.qualityInspectionId, expectedProductionProjectionVersion: stock!.expectedProductionProjectionVersion, quantity: 1 }] }] })) });
    await service.reviewVersion(context, created.shipment.id, created.versions[0]!.id, { decision: "approved", reasonCode: "SYNTHETIC", reason: "Synthetic approval", expectedCurrentVersion: 1, idempotencyKey: randomUUID() });
    return { orderId, lineId, shipmentId: created.shipment.id, versionId: created.versions[0]!.id, packages: created.packages, stock: stock! };
  }
  async function startWriteback(fixture: Awaited<ReturnType<typeof shipmentFixture>>) {
    const result = await service.requestWriteback(context, fixture.shipmentId, { shipmentVersionId: fixture.versionId, idempotencyKey: randomUUID() });
    await service.recordWritebackEvent(context, result.request.id, { action: "dispatched", expectedProjectionVersion: 1, providerCode: null, externalReference: null, occurredAt: new Date().toISOString() });
    return result.request;
  }
  function tracking(fixture: Awaited<ReturnType<typeof shipmentFixture>>, index: number, status: "information_received" | "delivery_exception" | "picked_up" | "in_transit") {
    return service.recordTrackingEvent(context, fixture.shipmentId, { packageId: fixture.packages[index]!.id, status, provider: "synthetic", externalEventId: randomUUID(), detailCode: status.toUpperCase(), occurredAt: new Date().toISOString(), estimatedDeliveryAt: null });
  }
  function confirm(fixture: Awaited<ReturnType<typeof shipmentFixture>>, idempotencyKey = randomUUID(), confirmedAt = new Date().toISOString()) {
    return service.recordManualConfirmation(context, fixture.shipmentId, { expectedVersion: 1, evidenceReference: "Synthetic seller console check", confirmedAt, idempotencyKey });
  }
  async function projection(id: string) {
    const rows = await withTenant(database.db, context, (tx) => tx.execute(sql`select * from (${workProjection}) v where id=${id}`));
    return rows[0];
  }
});
