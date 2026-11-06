import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, marketplaceAccounts, memberships, membershipRoles, roles, orders, orderProtectedDetails, withTenant } from "@yummyai/database";
import { normalizeAmazonOrder } from "@yummyai/marketplace-connectors";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { lockWholeOrder } from "./whole-order-fulfillment.js";

// The disposable acceptance runner owns all fixture identities and teardown.
describe("provider status stops local fulfillment without releasing operator holds", () => {
  const database = connectDatabase(), tenantId = createEntityId(), userId = createEntityId(), accountId = createEntityId();
  const context: TenantContext = { tenantId, userId, permissions: ["order:read", "order:write", "order:pii:read"], dataScope: "tenant" };
  const service = new OrderService(database, new SecretVault(Buffer.alloc(32, 29)), new AuditService(database));
  beforeAll(async () => {
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic provider lifecycle',$2)", [tenantId, "provider-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic provider operator')", [userId, userId, userId + "@example.invalid"]);
    await withTenant(database.db, context, async tx => {
      const member = createEntityId(), role = createEntityId();
      await tx.insert(memberships).values({ id: member, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: role, tenantId, name: "Synthetic provider role", permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: member, roleId: role });
      await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId, platform: "amazon", displayName: "Synthetic provider store", region: "NA", authorizationMode: "amazon_private", createdBy: userId });
    });
  });
  afterAll(async () => { await database.client.end(); });
  function input(orderId: string, hour: number, status = "UNSHIPPED", fulfilledBy: string | undefined = "MERCHANT", cancellation?: Record<string, unknown>) {
    const priced = status === "UNSHIPPED";
    return normalizeAmazonOrder(accountId, createEntityId(), { orderId, createdTime: "2026-11-01T00:00:00Z", lastUpdatedTime: `2026-11-01T${hour.toString().padStart(2, "0")}:00:00Z`,
      salesChannel: { marketplaceId: "ATVPDKIKX0DER" }, fulfillment: { fulfillmentStatus: status, fulfilledBy },
      proceeds: priced ? { grandTotal: { amount: "50.00", currencyCode: "USD" } } : undefined,
      recipient: { deliveryAddress: { name: "Synthetic Recipient", addressLine1: "Synthetic Street " + hour, city: "Test", stateOrRegion: "CA", postalCode: "00000", countryCode: "US" } },
      orderItems: [{ orderItemId: "line-1", quantityOrdered: 2, product: { title: "Synthetic product", sellerSku: "SYNTHETIC",
        price: priced ? { unitPrice: { amount: "25.00", currencyCode: "USD" } } : undefined }, cancellation }],
    }).order;
  }
  const row = async (id: string) => (await withTenant(database.db, context, tx => tx.select().from(orders).where(eq(orders.id, id))))[0]!;
  const privacy = async (id: string) => (await withTenant(database.db, context, tx => tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, id))))[0]!;
  async function blocked(id: string) {
    const current = await service.get(context, id);
    await expect(service.changeSideState(context, id, { action: "release", expectedSequence: current.latestEventSequence, idempotencyKey: createEntityId(), reason: "Synthetic bypass attempt" })).rejects.toBeInstanceOf(ConflictException);
    await expect(withTenant(database.db, context, tx => lockWholeOrder(tx, id))).rejects.toBeInstanceOf(ConflictException);
  }
  it("imports unknown pending money, blocks fulfillment and resumes only on a newer merchant-ready update", async () => {
    const externalId = createEntityId(), pending = await service.ingestNormalized(context, input(externalId, 10, "PENDING"));
    expect(pending).toMatchObject({ sideState: "on_hold", orderTotal: null });
    expect(pending.lines[0]!.unitPrice).toBeNull(); await blocked(pending.id);
    const ready = await service.ingestNormalized(context, input(externalId, 11));
    expect(ready).toMatchObject({ sideState: null, orderTotal: { amountMinor: 5000, currency: "USD" } });
    expect(ready.lines[0]!.unitPrice).toEqual({ amountMinor: 2500, currency: "USD" });
    expect(await row(ready.id)).toMatchObject({ providerBlockReason: null, providerHold: false });
    expect((await service.events(context, ready.id)).at(-1)?.code).toBe("provider_fulfillment_resumed");
  });
  it.each([
    ["UNSHIPPED", "AMAZON", "amazon_fulfilled"], ["CANCELLED", "MERCHANT", "cancelled"],
    ["PARTIALLY_SHIPPED", "MERCHANT", "partially_shipped"], ["SHIPPED", "MERCHANT", "already_shipped"],
  ])("blocks %s / %s from creating a local whole-order production", async (status, fulfiller, reason) => {
    const order = await service.ingestNormalized(context, input(createEntityId(), 10, status, fulfiller));
    expect(await row(order.id)).toMatchObject({ sideState: "on_hold", providerBlockReason: reason }); await blocked(order.id);
    await expect(service.get({ ...context, tenantId: createEntityId() }, order.id)).rejects.toBeInstanceOf(NotFoundException);
  });
  it("never releases a manual hold when the platform becomes ready", async () => {
    const externalId = createEntityId(), initial = await service.ingestNormalized(context, input(externalId, 10));
    await service.changeSideState(context, initial.id, { action: "hold", expectedSequence: initial.latestEventSequence, idempotencyKey: createEntityId(), reason: "Operator address review" });
    await service.ingestNormalized(context, input(externalId, 11, "PENDING"));
    const ready = await service.ingestNormalized(context, input(externalId, 12));
    expect(await row(ready.id)).toMatchObject({ sideState: "on_hold", providerHold: false, providerBlockReason: null });
    expect((await service.changeSideState(context, ready.id, { action: "release", expectedSequence: ready.latestEventSequence, idempotencyKey: createEntityId(), reason: "Operator confirmed address" })).sideState).toBeNull();
  });
  it("keeps an interrupted production paused after a cancellation request is withdrawn", async () => {
    const externalId = createEntityId(), initial = await service.ingestNormalized(context, input(externalId, 10));
    await withTenant(database.db, context, tx => tx.update(orders).set({ workflowState: "in_production" }).where(eq(orders.id, initial.id)));
    await service.ingestNormalized(context, input(externalId, 11, "UNSHIPPED", "MERCHANT", { cancellationRequest: { requester: "BUYER" } }));
    expect(await row(initial.id)).toMatchObject({ sideState: "on_hold", providerBlockReason: "cancellation_requested" }); await blocked(initial.id);
    await service.ingestNormalized(context, input(externalId, 12));
    expect(await row(initial.id)).toMatchObject({ sideState: "on_hold", providerHold: false, providerBlockReason: null });
  });
  it("retains old or simultaneous contradictory events without changing current money, address or pause", async () => {
    const externalId = createEntityId(), initial = await service.ingestNormalized(context, input(externalId, 12, "PENDING"));
    const before = await privacy(initial.id);
    for (const hour of [11, 12]) {
      const result = await withTenant(database.db, context, tx => service.materializeNormalizedInTransaction(tx, context, input(externalId, hour)));
      expect(result.sourceAccepted).toBe(false);
      expect(await privacy(initial.id)).toEqual(before);
      expect(await row(initial.id)).toMatchObject({ providerStatus: "PENDING", sideState: "on_hold", orderTotalMinor: null });
    }
    expect((await service.events(context, initial.id)).at(-1)?.code).toBe("provider_update_not_applied");
  });
  it("the database guard rejects bypassing a platform hold through a direct tenant write", async () => {
    const initial = await service.ingestNormalized(context, input(createEntityId(), 10, "PENDING"));
    await expect(withTenant(database.db, context, tx => tx.update(orders).set({ sideState: null }).where(eq(orders.id, initial.id)))).rejects.toThrow();
    expect((await row(initial.id)).sideState).toBe("on_hold");
  });
  it("requires a newer update to clear a cancellation even when the fulfillment status did not change", async () => {
    const externalId = createEntityId();
    const initial = await service.ingestNormalized(context, input(externalId, 10, "UNSHIPPED", "MERCHANT", { cancellationRequest: {} }));
    await service.ingestNormalized(context, input(externalId, 10));
    expect(await row(initial.id)).toMatchObject({ sideState: "on_hold", providerBlockReason: "cancellation_requested" });
    await service.ingestNormalized(context, input(externalId, 11));
    expect(await row(initial.id)).toMatchObject({ sideState: null, providerBlockReason: null });
  });
  it("accepts confirmation of an unknown fulfiller without inventing a later platform timestamp", async () => {
    const externalId = createEntityId(), source = input(externalId, 10);
    source.redactedSource.fulfilledBy = null;
    const initial = await service.ingestNormalized(context, source);
    expect(await row(initial.id)).toMatchObject({ sideState: "on_hold", providerBlockReason: "fulfillment_unknown" });
    await service.ingestNormalized(context, input(externalId, 10));
    expect(await row(initial.id)).toMatchObject({ sideState: null, providerBlockReason: null, providerUpdatedAt: new Date("2026-11-01T10:00:00Z") });
  });
});
