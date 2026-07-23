import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  afterSalesDecisions, connectDatabase, customerContactRecords, orderEvents, orderLines, orderSourceSnapshots,
  orders as orderTable, replacementOrderLinks, withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { OrderAfterSalesService } from "./order-after-sales.service.js";

describe("after-sales case lifecycle", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId(); const accountA = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  let service: OrderAfterSalesService;

  beforeAll(async () => {
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "After Sales A", `after-sales-a-${tenantA}`, tenantB, "After Sales B", `after-sales-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `after-sales-a-${userA}`, `a-${userA}@example.test`, "A", userB, `after-sales-b-${userB}`, `b-${userB}@example.test`, "B"]);
    await database.client.unsafe("insert into marketplace_accounts (id,tenant_id,platform,display_name,region,authorization_mode,created_by) values ($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4)", [accountA, tenantA, "After Sales Shop", userA]);
    service = new OrderAfterSalesService(database, new SecretVault(Buffer.alloc(32, 71)), new AuditService(database));
  });

  afterAll(async () => { await database.client.end(); });

  it("keeps protected contacts private and closes an approved return only after delivery", async () => {
    const orderId = await seedOrder("return", 2_500);
    const created = await service.create(contextA, orderId, {
      type: "quality_issue", reasonCode: "PRINT_DEFECT", summary: "Customer name and private issue details.", idempotencyKey: "after-sales-return-case-0001",
    });
    await expect(service.get(contextB, created.case.id)).rejects.toBeInstanceOf(NotFoundException);
    const contacted = await service.recordContact(contextA, created.case.id, {
      channel: "marketplace", direction: "inbound", body: "Private customer message body.", externalMessageId: "etsy-message-return-1",
      occurredAt: "2026-07-22T10:00:00.000Z", idempotencyKey: "after-sales-contact-0001",
    });
    expect(contacted.case.status).toBe("awaiting_internal");
    expect(JSON.stringify(contacted)).not.toContain("Private customer message body");
    const [storedContact] = await withTenant(database.db, contextA, (tx) => tx.select().from(customerContactRecords).where(eq(customerContactRecords.caseId, created.case.id)));
    expect(storedContact?.encryptedBody).not.toContain("Private customer message body");

    await expect(service.decide(contextA, created.case.id, {
      resolution: "partial_refund", refundAmountMinor: 2_500, refundCurrency: "USD", returnRequired: false,
      responsibilityParty: "supplier", reasonCode: "OVER_REFUND", reason: "Invalid full amount as partial.",
      expectedDecisionVersion: 0, idempotencyKey: "after-sales-over-refund-0001",
    })).rejects.toBeInstanceOf(UnprocessableEntityException);

    const decided = await service.decide(contextA, created.case.id, {
      resolution: "return_and_refund", refundAmountMinor: 2_500, refundCurrency: "USD", returnRequired: true,
      responsibilityParty: "supplier", reasonCode: "DEFECT_CONFIRMED", reason: "Return before refund.",
      expectedDecisionVersion: 0, idempotencyKey: "after-sales-return-decision-0001",
    });
    expect(decided.case).toMatchObject({ status: "approved", currentDecisionVersion: 1 });
    expect(JSON.stringify(decided)).not.toContain("Return before refund");
    await expect(service.decide(contextA, created.case.id, {
      resolution: "no_action", refundAmountMinor: null, refundCurrency: null, returnRequired: false,
      responsibilityParty: "undetermined", reasonCode: "STALE", reason: "Stale decision.",
      expectedDecisionVersion: 0, idempotencyKey: "after-sales-stale-decision-0001",
    })).rejects.toBeInstanceOf(ConflictException);

    const withReturn = await service.createReturnShipment(contextA, created.case.id, {
      carrierCode: "USPS", trackingNumber: "RETURN-TRACK-1", labelAssetId: null, idempotencyKey: "after-sales-return-shipment-0001",
    });
    const returnShipment = withReturn.returnShipments[0]!;
    await service.recordReturnTracking(contextA, created.case.id, returnShipment.id, {
      status: "in_transit", provider: "usps", externalEventId: "return-transit-1", detailCode: "IN_TRANSIT",
      occurredAt: "2026-07-24T10:00:00.000Z",
    });
    const delivered = await service.recordReturnTracking(contextA, created.case.id, returnShipment.id, {
      status: "delivered", provider: "usps", externalEventId: "return-delivered-1", detailCode: "DELIVERED",
      occurredAt: "2026-07-25T10:00:00.000Z",
    });
    expect(delivered.case.status).toBe("resolved");
    expect(delivered.returnTrackingEvents).toHaveLength(2);
    const replayed = await service.recordReturnTracking(contextA, created.case.id, returnShipment.id, {
      status: "delivered", provider: "usps", externalEventId: "return-delivered-1", detailCode: "DELIVERED",
      occurredAt: "2026-07-25T10:00:00.000Z",
    });
    expect(replayed.returnTrackingEvents).toHaveLength(2);
  });

  it("requires an approved replacement decision and preserves source lineage", async () => {
    const sourceOrderId = await seedOrder("replacement-source", 3_000);
    const replacementOrderId = await seedOrder("replacement-child", 0);
    const created = await service.create(contextA, sourceOrderId, {
      type: "replacement_request", reasonCode: "LOST_PACKAGE", summary: "Replacement requested.", idempotencyKey: "after-sales-replacement-case-0001",
    });
    await expect(service.linkReplacement(contextA, created.case.id, {
      replacementOrderId, reason: "Too early.", idempotencyKey: "after-sales-replacement-early-0001",
    })).rejects.toBeInstanceOf(ConflictException);
    await service.decide(contextA, created.case.id, {
      resolution: "replacement", refundAmountMinor: null, refundCurrency: null, returnRequired: false,
      responsibilityParty: "carrier", reasonCode: "CARRIER_LOSS", reason: "Replacement approved after carrier loss.",
      expectedDecisionVersion: 0, idempotencyKey: "after-sales-replacement-decision-0001",
    });
    await service.addResponsibilityEvidence(contextA, created.case.id, {
      party: "carrier", code: "TRACKING_LOST", detail: "Carrier declared the package lost.", assetId: null,
      idempotencyKey: "after-sales-responsibility-0001",
    });
    const linked = await service.linkReplacement(contextA, created.case.id, {
      replacementOrderId, reason: "Replacement order created.", idempotencyKey: "after-sales-replacement-link-0001",
    });
    expect(linked.case.status).toBe("resolved");
    expect(linked.replacements).toEqual([expect.objectContaining({ sourceOrderId, replacementOrderId })]);
    expect(linked.responsibilityEvidence).toEqual([expect.objectContaining({ party: "carrier", code: "TRACKING_LOST" })]);
    const [storedDecision] = await withTenant(database.db, contextA, (tx) => tx.select().from(afterSalesDecisions).where(eq(afterSalesDecisions.caseId, created.case.id)));
    const [storedLink] = await withTenant(database.db, contextA, (tx) => tx.select().from(replacementOrderLinks).where(eq(replacementOrderLinks.caseId, created.case.id)));
    expect(storedDecision?.encryptedReason).not.toContain("Replacement approved");
    expect(storedLink?.encryptedReason).not.toContain("Replacement order created");
  });

  async function seedOrder(suffix: string, total: number) {
    const orderId = createEntityId(); const snapshotId = createEntityId();
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(orderSourceSnapshots).values({
        id: snapshotId, tenantId: tenantA, accountId: accountA, platform: "etsy", externalEventId: `after-sales-event-${suffix}`,
        externalOrderId: `after-sales-order-${suffix}`, normalizedOrderId: orderId, redactedPayload: { receiptId: suffix }, payloadChecksum: "a".repeat(64),
      });
      await tx.insert(orderTable).values({
        id: orderId, tenantId: tenantA, accountId: accountA, sourceSnapshotId: snapshotId, platform: "etsy",
        externalOrderId: `after-sales-order-${suffix}`, providerStatus: "paid", workflowState: "completed",
        orderTotalMinor: total, orderCurrency: "USD", lineCount: 1, addressStatus: "protected",
        addressCountryCode: "US", latestEventSequence: 1, placedAt: new Date("2026-07-20T10:00:00.000Z"),
      });
      await tx.insert(orderLines).values({
        id: createEntityId(), tenantId: tenantA, orderId, externalLineId: `after-sales-line-${suffix}`,
        title: `After-sales fixture ${suffix}`, quantity: 1, unitPriceMinor: total, unitPriceCurrency: "USD",
      });
      await tx.insert(orderEvents).values({
        id: createEntityId(), tenantId: tenantA, orderId, sequence: 1, type: "order_ingested",
        toWorkflowState: "completed", idempotencyKey: `after-sales-ingest-${suffix}`, actorUserId: userA,
      });
    });
    return orderId;
  }
});
