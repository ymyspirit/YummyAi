import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, type NormalizeOrderInput, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase, listingVersions, listings, orderEvents, orderLineCatalogLinks, orderLines,
  orderProtectedAccessEvents, orderProtectedDetails, orderSourceSnapshots, orders, productPlans, skus, spus, withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";

describe("order kernel", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId();
  const accountA = createEntityId(); const accountB = createEntityId();
  const productPlanId = createEntityId(); const spuId = createEntityId(); const skuId = createEntityId();
  const listingId = createEntityId(); const listingVersionId = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write", "order:pii:read", "order:pii:anonymize"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: ["order:read", "order:write", "order:pii:read", "order:pii:anonymize"], dataScope: "tenant" };
  const vault = new SecretVault(Buffer.alloc(32, 17));
  const input = fixture(accountA);
  let service: OrderService;
  let orderId: string;

  beforeAll(async () => {
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1,$2,$3),($4,$5,$6)`,
      [tenantA, "Order Tenant A", `order-a-${tenantA}`, tenantB, "Order Tenant B", `order-b-${tenantB}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)`,
      [userA, `order-user-a-${userA}`, `a-${userA}@example.test`, "Order A", userB, `order-user-b-${userB}`, `b-${userB}@example.test`, "Order B"],
    );
    await database.client.unsafe(
      `insert into marketplace_accounts (id, tenant_id, platform, display_name, region, authorization_mode, created_by) values ($1,$2,'etsy',$3,'GLOBAL','etsy_oauth',$4),($5,$6,'etsy',$7,'GLOBAL','etsy_oauth',$8)`,
      [accountA, tenantA, "Order Shop A", userA, accountB, tenantB, "Order Shop B", userB],
    );
    await withTenant(database.db, contextA, async (tx) => {
      const customization = { version: 1, fields: [] };
      await tx.insert(productPlans).values({ id: productPlanId, tenantId: tenantA, name: "Pinned order catalog", customization, status: "approved", createdBy: userA });
      await tx.insert(spus).values({ id: spuId, tenantId: tenantA, productPlanId, code: "PILLOW", name: "Personalized pillow", customization, status: "ready" });
      await tx.insert(skus).values({ id: skuId, tenantId: tenantA, spuId, code: "PILLOW-PINK", status: "active" });
      await tx.insert(listings).values({ id: listingId, tenantId: tenantA, spuId, platform: "etsy", marketplaceId: "etsy", locale: "en-US", status: "approved", primaryVersionId: listingVersionId, createdBy: userA });
      await tx.insert(listingVersions).values({
        id: listingVersionId, tenantId: tenantA, listingId, versionNumber: 1, ruleVersion: "etsy-2026.07", status: "approved", source: "human", createdBy: userA, approvedBy: userA, approvedAt: new Date(),
        content: { platform: "etsy", locale: "en-US", title: "Personalized pillow", description: "Pinned order test", bullets: [], tags: ["pillow"], mainImageId: "asset-main", mediaAssetIds: ["asset-main"], variants: [{ skuId, skuCode: "PILLOW-PINK", optionValues: { color: "pink" } }], attributes: {}, compliance: {} },
        validation: { completeness: 100, blockers: [], warnings: [] },
      });
    });
    service = new OrderService(database, vault, new AuditService(database));
    orderId = (await service.ingestNormalized(contextA, input)).id;
  });

  afterAll(async () => { await database.client.end(); });

  it("deduplicates the same provider delivery and creates one initial event", async () => {
    const replay = await service.ingestNormalized(contextA, input);
    expect(replay.id).toBe(orderId);
    const [orderRows, snapshotRows, eventRows] = await Promise.all([
      withTenant(database.db, contextA, (tx) => tx.select().from(orders).where(eq(orders.id, orderId))),
      withTenant(database.db, contextA, (tx) => tx.select().from(orderSourceSnapshots).where(eq(orderSourceSnapshots.normalizedOrderId, orderId))),
      withTenant(database.db, contextA, (tx) => tx.select().from(orderEvents).where(eq(orderEvents.orderId, orderId))),
    ]);
    expect(orderRows).toHaveLength(1);
    expect(snapshotRows).toHaveLength(1);
    expect(eventRows).toHaveLength(1);
  });

  it("keeps protected fields out of public views and encrypted at rest", async () => {
    const order = await service.get(contextA, orderId);
    const serialized = JSON.stringify(order);
    expect(serialized).not.toContain("buyer@example.test");
    expect(serialized).not.toContain("1 Test Street");
    expect(serialized).not.toContain("encryptedEnvelope");
    const [stored] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, orderId)).limit(1));
    expect(stored?.encryptedEnvelope).not.toContain("buyer@example.test");
    expect(stored?.encryptedEnvelope).not.toContain("1 Test Street");
  });

  it("filters the public order projection by marketplace account", async () => {
    await expect(service.list(contextA, { accountId: accountA, limit: 50 })).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: orderId, accountId: accountA })]),
    );
    await expect(service.list(contextA, { accountId: createEntityId(), limit: 50 })).resolves.toEqual([]);
    await expect(service.list(contextB, { accountId: accountA, limit: 50 })).resolves.toEqual([]);
  });

  it("pins the order line to the catalog version available at materialization time", async () => {
    const [line] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).limit(1));
    const [link] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, line!.id)).limit(1));
    expect(link).toMatchObject({ skuId, listingId, listingVersionId, matchSource: "sku" });

    const replacementVersionId = createEntityId();
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(listingVersions).values({
        id: replacementVersionId, tenantId: tenantA, listingId, versionNumber: 2, ruleVersion: "etsy-2026.07", status: "approved", source: "human", createdBy: userA, approvedBy: userA, approvedAt: new Date(),
        content: { platform: "etsy", locale: "en-US", title: "Changed catalog title", description: "New catalog version", bullets: [], tags: ["pillow"], mainImageId: "asset-main", mediaAssetIds: ["asset-main"], variants: [{ skuId, skuCode: "PILLOW-PINK", optionValues: { color: "pink" } }], attributes: {}, compliance: {} },
        validation: { completeness: 100, blockers: [], warnings: [] },
      });
      await tx.update(listings).set({ primaryVersionId: replacementVersionId }).where(eq(listings.id, listingId));
    });
    const [stillPinned] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderLineCatalogLinks).where(eq(orderLineCatalogLinks.orderLineId, line!.id)).limit(1));
    expect(stillPinned?.listingVersionId).toBe(listingVersionId);
  });

  it("decrypts PII only through a purpose-bound read and appends access evidence", async () => {
    const detail = await service.fulfillmentDetails(contextA, orderId, "fulfillment");
    expect(detail.protectedDetails?.buyer.email).toBe("buyer@example.test");
    const access = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProtectedAccessEvents).where(eq(orderProtectedAccessEvents.orderId, orderId)));
    expect(access).toHaveLength(1);
    expect(access[0]).toMatchObject({ purpose: "fulfillment", granted: true, actorUserId: userA });
  });

  it("applies transitions once, rejects stale commands, and blocks held orders", async () => {
    const transitioned = await service.transition(contextA, orderId, { toState: "awaiting_customization", expectedSequence: 1, idempotencyKey: "transition-0001" });
    expect(transitioned).toMatchObject({ workflowState: "awaiting_customization", latestEventSequence: 2 });
    const replay = await service.transition(contextA, orderId, { toState: "awaiting_customization", expectedSequence: 1, idempotencyKey: "transition-0001" });
    expect(replay.latestEventSequence).toBe(2);
    await expect(service.transition(contextA, orderId, { toState: "awaiting_design", expectedSequence: 1, idempotencyKey: "transition-stale" })).rejects.toBeInstanceOf(ConflictException);
    const held = await service.changeSideState(contextA, orderId, { action: "hold", expectedSequence: 2, idempotencyKey: "side-hold-0001", reason: "Manual review" });
    expect(held).toMatchObject({ sideState: "on_hold", latestEventSequence: 3 });
    await expect(service.transition(contextA, orderId, { toState: "awaiting_design", expectedSequence: 3, idempotencyKey: "transition-held" })).rejects.toBeInstanceOf(ConflictException);
    const released = await service.changeSideState(contextA, orderId, { action: "release", expectedSequence: 3, idempotencyKey: "side-release-0001", reason: "Review complete" });
    expect(released).toMatchObject({ sideState: null, latestEventSequence: 4 });
  });

  it("opens and resolves exceptions without changing main workflow state", async () => {
    const opened = await service.openException(contextA, orderId, { category: "address", code: "ADDRESS_REVIEW", message: "Address review required", idempotencyKey: "exception-open-0001" });
    expect(opened.status).toBe("open");
    expect(await service.listExceptions(contextA, "open")).toEqual(expect.arrayContaining([expect.objectContaining({ id: opened.id, orderId })]));
    expect(await service.listExceptions(contextB, "open")).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: opened.id })]));
    const before = await service.get(contextA, orderId);
    const resolved = await service.resolveException(contextA, orderId, opened.id, { resolution: "Address evidence verified", idempotencyKey: "exception-resolve-0001" });
    const after = await service.get(contextA, orderId);
    expect(resolved.status).toBe("resolved");
    expect(await service.listExceptions(contextA, "resolved")).toEqual(expect.arrayContaining([expect.objectContaining({ id: opened.id })]));
    expect(after.workflowState).toBe(before.workflowState);
    expect(after.latestEventSequence).toBe(before.latestEventSequence + 1);
  });

  it("appends late provider updates while converging the current provider projection", async () => {
    const before = await service.get(contextA, orderId);
    const updated = await service.ingestNormalized(contextA, { ...fixture(accountA, "receipt-1001-update"), externalOrderId: "receipt-1001", providerStatus: "shipped" });
    expect(updated).toMatchObject({ id: orderId, providerStatus: "shipped", latestEventSequence: before.latestEventSequence + 1 });
    const snapshots = await withTenant(database.db, contextA, (tx) => tx.select().from(orderSourceSnapshots).where(eq(orderSourceSnapshots.normalizedOrderId, orderId)));
    const events = await service.events(contextA, orderId);
    expect(snapshots).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "provider_update_received", code: "shipped" });
  });

  it("prevents another tenant from observing order or protected data", async () => {
    await expect(service.get(contextB, orderId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.fulfillmentDetails(contextB, orderId, "fulfillment")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects source snapshots whose protected fields are not redacted", async () => {
    await expect(service.ingestNormalized(contextA, { ...fixture(accountA, "receipt-unsafe"), redactedSource: { buyer_email: "buyer@example.test" } })).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it("irreversibly anonymizes expired protected details without breaking order history", async () => {
    const before = await service.get(contextA, orderId);
    const [details] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, orderId)).limit(1));
    expect(details?.status).toBe("protected");
    const command = { expectedSequence: before.latestEventSequence, expectedEnvelopeVersion: details!.envelopeVersion, idempotencyKey: "retention-anonymize-0001", reason: "Tenant retention period elapsed" };
    await expect(service.anonymizeProtectedDetails(contextA, orderId, command, new Date("2026-07-22T12:00:00.000Z"))).rejects.toBeInstanceOf(ConflictException);
    await withTenant(database.db, contextA, (tx) => tx.update(orderProtectedDetails).set({ retentionExpiresAt: new Date("2026-07-21T12:00:00.000Z") }).where(eq(orderProtectedDetails.orderId, orderId)));
    const anonymized = await service.anonymizeProtectedDetails(contextA, orderId, command, new Date("2026-07-22T12:00:00.000Z"));
    expect(anonymized).toMatchObject({ address: { status: "anonymized", countryCode: null }, latestEventSequence: before.latestEventSequence + 1 });
    expect((await service.anonymizeProtectedDetails(contextA, orderId, command, new Date("2026-07-22T12:00:00.000Z"))).latestEventSequence).toBe(anonymized.latestEventSequence);
    const [stored] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, orderId)).limit(1));
    expect(stored).toMatchObject({ encryptedEnvelope: null, countryCode: null, status: "anonymized", envelopeVersion: details!.envelopeVersion + 1 });
    expect(stored?.anonymizedAt).toEqual(new Date("2026-07-22T12:00:00.000Z"));
    expect((await service.fulfillmentDetails(contextA, orderId, "retention")).protectedDetails).toBeNull();
    const afterProviderUpdate = await service.ingestNormalized(contextA, { ...fixture(accountA, "receipt-after-anonymization"), externalOrderId: "receipt-1001", providerStatus: "delivered" });
    expect(afterProviderUpdate.address).toEqual({ status: "anonymized", countryCode: null });
    const [stillAnonymized] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, orderId)).limit(1));
    expect(stillAnonymized?.encryptedEnvelope).toBeNull();
    await expect(service.anonymizeProtectedDetails(contextB, orderId, command, new Date("2026-07-22T12:00:00.000Z"))).rejects.toBeInstanceOf(NotFoundException);
  });
});

function fixture(accountId: string, suffix = "receipt-1001"): NormalizeOrderInput {
  return {
    accountId, platform: "etsy", externalEventId: `${suffix}:v1`, externalOrderId: suffix, providerStatus: "paid",
    placedAt: "2026-07-20T04:00:00.000Z", orderTotal: { amountMinor: 2640, currency: "USD" },
    lines: [{ externalLineId: `${suffix}-line-1`, externalListingId: "listing-55", skuCode: "PILLOW-PINK", title: "Personalized pillow", quantity: 1, unitPrice: { amountMinor: 2640, currency: "USD" }, customizationCount: 1 }],
    redactedSource: { receipt_id: suffix, status: "paid", buyer_name: "[REDACTED]", address: "[REDACTED]" },
    protectedDetails: { buyer: { name: "Buyer", email: "buyer@example.test", phone: null }, shippingAddress: { recipient: "Buyer", lines: ["1 Test Street"], city: "Test", region: "CA", postalCode: "00000", countryCode: "US" }, customizations: [{ externalLineId: `${suffix}-line-1`, values: [{ key: "name", label: "Name", type: "text", value: "Alex" }] }] },
  };
}
