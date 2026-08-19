import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase, orderEvents, orderLines, orderSourceSnapshots, orders as orderTable,
  shipmentVersionReviews, withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { OrderShipmentService } from "./order-shipment.service.js";
import { OrderService } from "./order.service.js";

describe("shipment, tracking, and marketplace writeback", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId(); const accountA = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  let orderService: OrderService; let shipmentService: OrderShipmentService;

  beforeAll(async () => {
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "Shipment A", `shipment-a-${tenantA}`, tenantB, "Shipment B", `shipment-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `shipment-a-${userA}`, `a-${userA}@example.test`, "A", userB, `shipment-b-${userB}`, `b-${userB}@example.test`, "B"]);
    await database.client.unsafe("insert into marketplace_accounts (id,tenant_id,platform,display_name,region,authorization_mode,created_by) values ($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)", [accountA, tenantA, "Shipment Shop", userA]);
    const audit = new AuditService(database);
    orderService = new OrderService(database, new SecretVault(Buffer.alloc(32, 61)), audit);
    shipmentService = new OrderShipmentService(database, new SecretVault(Buffer.alloc(32, 62)), orderService, audit, { enqueue: async () => undefined });
  });

  afterAll(async () => { await database.client.end(); });

  it("requires immutable approval and acknowledgement before shipment, then completes only after every package is delivered", async () => {
    const fixture = await shipmentReadyOrder("lifecycle", [2, 1]);
    const created = await shipmentService.create(contextA, fixture.orderId, {
      shipDate: "2026-07-24T10:00:00.000Z", promisedDeliveryAt: "2026-07-30T10:00:00.000Z",
      estimatedDeliveryAt: "2026-07-29T10:00:00.000Z", shipFromCountryCode: "US", idempotencyKey: "shipment-lifecycle-0001",
      packages: [
        packageInput("PKG-A", "TRACK-A", [{ orderLineId: fixture.lineIds[0]!, quantity: 1 }, { orderLineId: fixture.lineIds[1]!, quantity: 1 }]),
        packageInput("PKG-B", "TRACK-B", [{ orderLineId: fixture.lineIds[0]!, quantity: 1 }]),
      ],
    });
    await expect(shipmentService.get(contextB, created.shipment.id)).rejects.toBeInstanceOf(NotFoundException);
    const beforeShipment = await orderService.get(contextA, fixture.orderId);
    await expect(orderService.transition(contextA, fixture.orderId, { toState: "shipped", expectedSequence: beforeShipment.latestEventSequence, idempotencyKey: "manual-shipment-too-early", reason: "No acknowledgement" })).rejects.toBeInstanceOf(ConflictException);

    const approved = await shipmentService.reviewVersion(contextA, created.shipment.id, created.versions[0]!.id, {
      decision: "approved", reasonCode: "LABEL_AND_CONTENT_VERIFIED", reason: "Private reviewer note",
      expectedCurrentVersion: 1, idempotencyKey: "shipment-approval-0001",
    });
    expect(approved.shipment.status).toBe("approved");
    expect(JSON.stringify(approved)).not.toContain("Private reviewer note");
    const [storedReview] = await withTenant(database.db, contextA, (tx) => tx.select().from(shipmentVersionReviews).where(eq(shipmentVersionReviews.shipmentId, created.shipment.id)));
    expect(storedReview?.encryptedReason).not.toContain("Private reviewer note");

    const requested = await shipmentService.requestWriteback(contextA, created.shipment.id, { shipmentVersionId: created.versions[0]!.id, idempotencyKey: "shipment-writeback-0001" });
    await expect(shipmentService.recordWritebackEvent(contextA, requested.request.id, {
      action: "accepted", expectedProjectionVersion: 1, providerCode: "HTTP_200", externalReference: "too-early",
      occurredAt: "2026-07-24T10:10:00.000Z",
    })).rejects.toBeInstanceOf(ConflictException);
    const dispatched = await shipmentService.recordWritebackEvent(contextA, requested.request.id, {
      action: "dispatched", expectedProjectionVersion: 1, providerCode: null, externalReference: null,
      occurredAt: "2026-07-24T10:10:00.000Z",
    });
    const uncertain = await shipmentService.recordWritebackEvent(contextA, requested.request.id, {
      action: "uncertain", expectedProjectionVersion: dispatched.request.projectionVersion,
      providerCode: "NETWORK_OUTCOME_UNKNOWN", externalReference: null, occurredAt: "2026-07-24T10:11:00.000Z",
    });
    expect(uncertain.request.status).toBe("reconciliation_required");
    await expect(shipmentService.recordWritebackEvent(contextA, requested.request.id, {
      action: "dispatched", expectedProjectionVersion: uncertain.request.projectionVersion, providerCode: null,
      externalReference: null, occurredAt: "2026-07-24T10:12:00.000Z",
    })).rejects.toBeInstanceOf(ConflictException);
    const reconciled = await shipmentService.recordWritebackEvent(contextA, requested.request.id, {
      action: "reconcile_accepted", expectedProjectionVersion: uncertain.request.projectionVersion,
      providerCode: "ETSY_RECEIPT_CONFIRMED", externalReference: "etsy-shipment-ack-1", occurredAt: "2026-07-24T10:13:00.000Z",
    });
    expect(reconciled).toMatchObject({ request: { status: "reconciled", projectionVersion: 4 } });
    expect((await orderService.get(contextA, fixture.orderId)).workflowState).toBe("shipped");
    const replayedAcknowledgement = await shipmentService.recordWritebackEvent(contextA, requested.request.id, {
      action: "reconcile_accepted", expectedProjectionVersion: uncertain.request.projectionVersion,
      providerCode: "ETSY_RECEIPT_CONFIRMED", externalReference: "etsy-shipment-ack-1", occurredAt: "2026-07-24T10:13:00.000Z",
    });
    expect(replayedAcknowledgement.events).toHaveLength(3);

    const packageA = created.packages.find((entry) => entry.packageReferenceId === "PKG-A")!;
    const packageB = created.packages.find((entry) => entry.packageReferenceId === "PKG-B")!;
    const firstDelivery = await shipmentService.recordTrackingEvent(contextA, created.shipment.id, {
      packageId: packageA.id, status: "delivered", provider: "etsy", externalEventId: "tracking-delivered-a",
      detailCode: "DELIVERED", occurredAt: "2026-07-28T10:00:00.000Z", estimatedDeliveryAt: null,
    });
    expect(firstDelivery.shipment.status).toBe("in_transit");
    expect((await orderService.get(contextA, fixture.orderId)).workflowState).toBe("shipped");
    const delivered = await shipmentService.recordTrackingEvent(contextA, created.shipment.id, {
      packageId: packageB.id, status: "delivered", provider: "etsy", externalEventId: "tracking-delivered-b",
      detailCode: "DELIVERED", occurredAt: "2026-07-28T11:00:00.000Z", estimatedDeliveryAt: null,
    });
    expect(delivered.shipment.status).toBe("delivered");
    expect((await orderService.get(contextA, fixture.orderId)).workflowState).toBe("completed");
    const replayedDelivery = await shipmentService.recordTrackingEvent(contextA, created.shipment.id, {
      packageId: packageB.id, status: "delivered", provider: "etsy", externalEventId: "tracking-delivered-b",
      detailCode: "DELIVERED", occurredAt: "2026-07-28T11:00:00.000Z", estimatedDeliveryAt: null,
    });
    expect(replayedDelivery.tracking).toHaveLength(2);
  });

  it("prevents approved split shipments from exceeding the ordered quantity", async () => {
    const fixture = await shipmentReadyOrder("allocation", [2]);
    const first = await shipmentService.create(contextA, fixture.orderId, {
      shipDate: "2026-07-24T10:00:00.000Z", promisedDeliveryAt: null, estimatedDeliveryAt: null,
      shipFromCountryCode: "US", idempotencyKey: "shipment-allocation-first",
      packages: [packageInput("FIRST", "TRACK-FIRST", [{ orderLineId: fixture.lineIds[0]!, quantity: 1 }])],
    });
    await shipmentService.reviewVersion(contextA, first.shipment.id, first.versions[0]!.id, {
      decision: "approved", reasonCode: "PARTIAL_APPROVED", reason: "First partial shipment",
      expectedCurrentVersion: 1, idempotencyKey: "shipment-allocation-first-review",
    });
    const second = await shipmentService.create(contextA, fixture.orderId, {
      shipDate: "2026-07-24T11:00:00.000Z", promisedDeliveryAt: null, estimatedDeliveryAt: null,
      shipFromCountryCode: "US", idempotencyKey: "shipment-allocation-second",
      packages: [packageInput("SECOND", "TRACK-SECOND", [{ orderLineId: fixture.lineIds[0]!, quantity: 2 }])],
    });
    await expect(shipmentService.reviewVersion(contextA, second.shipment.id, second.versions[0]!.id, {
      decision: "approved", reasonCode: "OVER_ALLOCATED", reason: "Should fail",
      expectedCurrentVersion: 1, idempotencyKey: "shipment-allocation-over-review",
    })).rejects.toBeInstanceOf(ConflictException);
    const revised = await shipmentService.appendVersion(contextA, second.shipment.id, {
      shipDate: "2026-07-24T11:00:00.000Z", promisedDeliveryAt: null, estimatedDeliveryAt: null,
      shipFromCountryCode: "US", expectedCurrentVersion: 1, idempotencyKey: "shipment-allocation-revised",
      packages: [packageInput("SECOND", "TRACK-SECOND", [{ orderLineId: fixture.lineIds[0]!, quantity: 1 }])],
    });
    const approved = await shipmentService.reviewVersion(contextA, second.shipment.id, revised.versions[1]!.id, {
      decision: "approved", reasonCode: "BALANCED", reason: "Balanced split shipment",
      expectedCurrentVersion: 2, idempotencyKey: "shipment-allocation-revised-review",
    });
    expect(approved.shipment).toMatchObject({ status: "approved", approvedVersionNumber: 2 });
  });

  it("opens explicit delay and carrier exceptions without treating provider acceptance as delivery", async () => {
    const fixture = await shipmentReadyOrder("delay", [1]);
    const created = await shipmentService.create(contextA, fixture.orderId, {
      shipDate: "2026-07-24T10:00:00.000Z", promisedDeliveryAt: "2026-07-27T10:00:00.000Z",
      estimatedDeliveryAt: "2026-07-26T10:00:00.000Z", shipFromCountryCode: "US", idempotencyKey: "shipment-delay-0001",
      packages: [packageInput("DELAY", "TRACK-DELAY", [{ orderLineId: fixture.lineIds[0]!, quantity: 1 }])],
    });
    await shipmentService.reviewVersion(contextA, created.shipment.id, created.versions[0]!.id, {
      decision: "approved", reasonCode: "APPROVED", reason: "Delay fixture",
      expectedCurrentVersion: 1, idempotencyKey: "shipment-delay-review",
    });
    const request = await shipmentService.requestWriteback(contextA, created.shipment.id, { shipmentVersionId: created.versions[0]!.id, idempotencyKey: "shipment-delay-writeback" });
    const dispatched = await shipmentService.recordWritebackEvent(contextA, request.request.id, {
      action: "dispatched", expectedProjectionVersion: 1, providerCode: null, externalReference: null,
      occurredAt: "2026-07-24T10:05:00.000Z",
    });
    await shipmentService.recordWritebackEvent(contextA, request.request.id, {
      action: "accepted", expectedProjectionVersion: dispatched.request.projectionVersion, providerCode: "HTTP_200",
      externalReference: "accepted-not-delivered", occurredAt: "2026-07-24T10:06:00.000Z",
    });
    expect((await orderService.get(contextA, fixture.orderId)).workflowState).toBe("shipped");
    const pkg = created.packages[0]!;
    const delayed = await shipmentService.recordTrackingEvent(contextA, created.shipment.id, {
      packageId: pkg.id, status: "in_transit", provider: "carrier", externalEventId: "delay-estimate-1",
      detailCode: "IN_TRANSIT", occurredAt: "2026-07-25T10:00:00.000Z", estimatedDeliveryAt: "2026-07-30T10:00:00.000Z",
    });
    expect(delayed.shipment.status).toBe("exception");
    await shipmentService.recordTrackingEvent(contextA, created.shipment.id, {
      packageId: pkg.id, status: "delivery_exception", provider: "carrier", externalEventId: "delay-exception-1",
      detailCode: "WEATHER_DELAY", occurredAt: "2026-07-26T10:00:00.000Z", estimatedDeliveryAt: "2026-07-30T10:00:00.000Z",
    });
    expect(await orderService.exceptions(contextA, fixture.orderId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "logistics", code: "DELIVERY_DELAYED" }),
      expect.objectContaining({ category: "logistics", code: "DELIVERY_EXCEPTION" }),
    ]));
    expect((await orderService.get(contextA, fixture.orderId)).workflowState).toBe("shipped");
  });

  async function shipmentReadyOrder(suffix: string, quantities: number[]) {
    const orderId = createEntityId(); const snapshotId = createEntityId();
    const lineIds = quantities.map(() => createEntityId());
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(orderSourceSnapshots).values({
        id: snapshotId, tenantId: tenantA, accountId: accountA, platform: "etsy", externalEventId: `shipment-event-${suffix}`,
        externalOrderId: `shipment-order-${suffix}`, normalizedOrderId: orderId, redactedPayload: { receiptId: suffix }, payloadChecksum: "a".repeat(64),
      });
      await tx.insert(orderTable).values({
        id: orderId, tenantId: tenantA, accountId: accountA, sourceSnapshotId: snapshotId, platform: "etsy",
        externalOrderId: `shipment-order-${suffix}`, providerStatus: "paid", workflowState: "awaiting_shipment",
        orderTotalMinor: 2500, orderCurrency: "USD", lineCount: quantities.length, addressStatus: "protected",
        addressCountryCode: "US", latestEventSequence: 1, placedAt: new Date("2026-07-22T10:00:00.000Z"),
      });
      await tx.insert(orderLines).values(quantities.map((quantity, index) => ({
        id: lineIds[index]!, tenantId: tenantA, orderId, externalLineId: `line-${suffix}-${index + 1}`,
        title: `Shipment item ${index + 1}`, quantity, unitPriceMinor: 2500, unitPriceCurrency: "USD",
      })));
      await tx.insert(orderEvents).values({
        id: createEntityId(), tenantId: tenantA, orderId, sequence: 1, type: "order_ingested",
        toWorkflowState: "awaiting_shipment", idempotencyKey: `shipment-ingest-${suffix}`, actorUserId: userA,
      });
    });
    return { orderId, lineIds };
  }
});

function packageInput(packageReferenceId: string, trackingNumber: string, lines: Array<{ orderLineId: string; quantity: number }>) {
  return {
    packageReferenceId, trackingNumber, carrierCode: "UPS", carrierName: "UPS", carrierService: "Ground",
    labelAssetId: null, externalLabelId: null, labelCostMinor: null, labelCurrency: null,
    weightGrams: null, dimensionsMm: null, lines,
  };
}
