import { SecretVault } from "@yummyai/ai-core";
import { ConflictException } from "@nestjs/common";
import { createEntityId, type NormalizeOrderInput, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, orderConnectorCheckpoints, orderIngestionRisks, orderIngestionRuns, withTenant } from "@yummyai/database";
import type { MarketplaceOrderIngestionAdapter } from "@yummyai/marketplace-connectors";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { OrderIngestionService } from "./order-ingestion.service.js";
import { OrderService } from "./order.service.js";
import { OrderSyncCoordinator } from "./order-sync-coordinator.js";

describe("order ingestion persistence", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(); const tenantB = createEntityId();
  const userA = createEntityId(); const userB = createEntityId(); const accountA = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  let service: OrderIngestionService;
  let orderService: OrderService;
  let coordinator: OrderSyncCoordinator;

  beforeAll(async () => {
    await database.client.unsafe(
      "insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)",
      [tenantA, "Ingestion A", `ingestion-a-${tenantA}`, tenantB, "Ingestion B", `ingestion-b-${tenantB}`],
    );
    await database.client.unsafe(
      "insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)",
      [userA, `ingestion-a-${userA}`, `a-${userA}@example.test`, "A", userB, `ingestion-b-${userB}`, `b-${userB}@example.test`, "B"],
    );
    await database.client.unsafe(
      "insert into marketplace_accounts (id,tenant_id,platform,display_name,region,authorization_mode,created_by) values ($1,$2,'amazon',$3,'NA','amazon_private',$4)",
      [accountA, tenantA, "Amazon A", userA],
    );
    service = new OrderIngestionService(database, new AuditService(database));
    orderService = new OrderService(database, new SecretVault(Buffer.alloc(32, 23)), new AuditService(database));
    coordinator = new OrderSyncCoordinator(service, orderService);
  });

  afterAll(async () => { await database.client.end(); });

  it("finalizes counts, risks, and checkpoint atomically without retaining diagnostic PII", async () => {
    const started = await service.start(contextA, { accountId: accountA, platform: "amazon", stream: "orders", sourceVersion: "amazon-orders-2026-01-01" });
    const completed = await service.complete(contextA, started.id, {
      collectedCount: 2, reportedCount: 3, duplicateCount: 1, sourceVersion: "amazon-orders-2026-01-01",
      nextCursor: null, highWaterAt: "2026-07-22T12:00:00.000Z", status: "completed",
      risks: [{ code: "address_gap", severity: "blocker", externalOrderId: "111-222", externalLineId: null, message: "buyer@example.test Secret Street" }],
    });
    expect(completed).toMatchObject({ status: "completed", collectedCount: 2, reportedCount: 3, duplicateCount: 1, riskCount: 1, checkpointVersionStart: 1, checkpointVersionEnd: 2 });
    expect(completed.risks[0]?.message).toBe("Protected shipping address is incomplete or unavailable");
    expect(JSON.stringify(completed)).not.toMatch(/buyer@example\.test|Secret Street/);
    const [checkpoint] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderConnectorCheckpoints).where(eq(orderConnectorCheckpoints.accountId, accountA)));
    expect(checkpoint).toMatchObject({ cursor: null, version: 2 });
    expect(checkpoint?.highWaterAt?.toISOString()).toBe("2026-07-22T12:00:00.000Z");
  });

  it("isolates run and risk projections by tenant", async () => {
    expect(await service.list(contextB)).toEqual([]);
    expect(await withTenant(database.db, contextB, (tx) => tx.select().from(orderIngestionRuns))).toEqual([]);
    expect(await withTenant(database.db, contextB, (tx) => tx.select().from(orderIngestionRisks))).toEqual([]);
  });

  it("coordinates adapter pagination through immutable order materialization and checkpoint completion", async () => {
    const normalized = normalizedOrder(accountA);
    const adapter: MarketplaceOrderIngestionAdapter = {
      platform: "amazon",
      fetchPage: async () => ({
        records: [{ order: normalized, providerUpdatedAt: "2026-07-22T12:10:00.000Z" }],
        fetchedAt: "2026-07-22T12:15:00.000Z", highWaterAt: "2026-07-22T12:15:00.000Z",
        nextCursor: null, reportedCount: 1, sourceVersion: "fixture-amazon-orders-v1",
      }),
    };
    const completed = await coordinator.run(contextA, {
      connectorContext: { accountId: accountA, tenantId: tenantA, platform: "amazon", externalAccountId: "seller-a", region: "NA", marketplaceIds: ["ATVPDKIKX0DER"] },
      stream: "coordinator", adapter, credentials: { withCredential: (callback) => callback({ refreshToken: "never-queued" }) },
      request: { checkpoint: { cursor: null, highWaterAt: null, version: 1 }, updatedAfter: "2026-07-22T11:00:00.000Z", updatedBefore: "2026-07-22T12:15:00.000Z", pageSize: 50, maxPages: 2 },
    }, new AbortController().signal);
    expect(completed).toMatchObject({ status: "completed", collectedCount: 1, reportedCount: 1, duplicateCount: 0, sourceVersion: "fixture-amazon-orders-v1" });
    expect((await orderService.list(contextA, { platform: "amazon", limit: 50 })).some((order) => order.externalOrderId === normalized.externalOrderId)).toBe(true);
  });

  it("serializes concurrent starts for the same account stream", async () => {
    const attempts = await Promise.allSettled([
      service.start(contextA, { accountId: accountA, platform: "amazon", stream: "concurrency", sourceVersion: "amazon-orders-2026-01-01" }),
      service.start(contextA, { accountId: accountA, platform: "amazon", stream: "concurrency", sourceVersion: "amazon-orders-2026-01-01" }),
    ]);
    const fulfilled = attempts.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<OrderIngestionService["start"]>>> => result.status === "fulfilled");
    const rejected = attempts.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    await service.complete(contextA, fulfilled[0]!.value.id, {
      collectedCount: 0, reportedCount: 0, duplicateCount: 0, sourceVersion: "amazon-orders-2026-01-01",
      nextCursor: null, highWaterAt: "2026-07-22T12:00:00.000Z", status: "completed", risks: [],
    });
  });

  it("rejects a high-water regression", async () => {
    const started = await service.start(contextA, { accountId: accountA, platform: "amazon", stream: "orders", sourceVersion: "amazon-orders-2026-01-01" });
    await expect(service.complete(contextA, started.id, {
      collectedCount: 0, reportedCount: 0, duplicateCount: 0, sourceVersion: "amazon-orders-2026-01-01",
      nextCursor: null, highWaterAt: "2026-07-22T11:00:00.000Z", status: "completed", risks: [],
    })).rejects.toBeInstanceOf(ConflictException);
  });
});

function normalizedOrder(accountId: string): NormalizeOrderInput {
  return {
    accountId, platform: "amazon", externalEventId: "coordinator-event-1", externalOrderId: "coordinator-order-1", providerStatus: "UNSHIPPED",
    placedAt: "2026-07-22T11:30:00.000Z", orderTotal: { amountMinor: 2500, currency: "USD" },
    lines: [{ externalLineId: "coordinator-line-1", externalListingId: "B000TEST", skuCode: null, title: "Custom mug", quantity: 1, unitPrice: { amountMinor: 2500, currency: "USD" }, customizationCount: 0 }],
    redactedSource: { apiVersion: "fixture-v1", orderId: "coordinator-order-1" },
    protectedDetails: {
      buyer: { name: null, email: null, phone: null },
      shippingAddress: { recipient: null, lines: ["Fulfillment Street"], city: "Seattle", region: "WA", postalCode: "98101", countryCode: "US" },
      customizations: [],
    },
  };
}
