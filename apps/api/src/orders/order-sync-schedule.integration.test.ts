import "reflect-metadata";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { OrderSyncNodeInputSchema, type OrderSyncNodeInput } from "@yummyai/contracts/order/sync";
import { connectDatabase, withTenant, marketplaceAccounts, marketplaceStoreNodes, marketplaceStoreNodeExecutions as executions,
  memberships, membershipRoles, roles, orderSyncSchedules as schedules, orderConnectorCheckpoints, orderIngestionRuns, orders, orderSourceSnapshots } from "@yummyai/database";
import { normalizeAmazonOrder } from "@yummyai/marketplace-connectors";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditService } from "../audit/audit.service.js";
import { StoreNodeExecutionService } from "../marketplaces/store-node-execution.service.js";
import type { StoreNodeService } from "../marketplaces/store-node.service.js";
import type { MarketplaceCapabilityService } from "../marketplaces/marketplace-capability.service.js";
import { OrderService } from "./order.service.js";
import { OrderIngestionService } from "./order-ingestion.service.js";
import { OrderSyncCoordinator } from "./order-sync-coordinator.js";
import { OrderSyncScheduleService } from "./order-sync-schedule.service.js";

// The disposable runner owns all tenants and database cleanup. Provider/node I/O is not part of this DB suite.
describe("automatic order sync persistence and authority", () => {
  const database = connectDatabase(), tenantId = createEntityId(), userId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId();
  const authority: TenantContext = { tenantId, userId, permissions: [Permission.StoreRead, Permission.StoreManage, Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead], dataScope: "tenant" };
  const audit = new AuditService(database), vault = new SecretVault(Buffer.alloc(32, 21)), ingestion = new OrderIngestionService(database, audit), orderOwner = new OrderService(database, vault, audit);
  const coordinator = new OrderSyncCoordinator(ingestion, orderOwner);
  const binding = vi.fn(async (_tx, account) => {
    const [node] = await withTenant(database.db, authority, tx => tx.select().from(marketplaceStoreNodes).where(eq(marketplaceStoreNodes.accountId, account.id)));
    return { node: node!, binding: { revision: 1 }, now: new Date() };
  });
  const nodes = { executionBinding: binding } as unknown as StoreNodeService;
  const execution = new StoreNodeExecutionService(database, vault, audit, nodes, {} as MarketplaceCapabilityService, undefined, coordinator);
  const scheduler = new OrderSyncScheduleService(database, audit, nodes, execution, ingestion);
  beforeAll(async () => {
    vi.stubEnv("STORE_NODE_EXECUTION_ENABLED", "1"); vi.stubEnv("STORE_NODE_RUNTIME_ENABLED", "1");
    await scheduler.onApplicationShutdown(); // Drive exact ticks; no wall-clock background activity in this fixture.
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic order sync tenant',$2)", [tenantId, "order-sync-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic sync operator')", [userId, userId, userId + "@example.invalid"]);
    await withTenant(database.db, authority, async tx => {
      await tx.insert(memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId, name: "Synthetic sync role", permissions: authority.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId });
    });
  });
  afterAll(async () => { await scheduler.onApplicationShutdown(); vi.unstubAllEnvs(); await database.client.end(); });
  async function scene() {
    const accountId = createEntityId(), generation = createEntityId();
    await withTenant(database.db, authority, async tx => {
      await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId, createdBy: userId, platform: "amazon", displayName: `Synthetic sync ${accountId}`, region: "NA",
        marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", authorizationGeneration: generation, credentialStatus: "valid" });
      await tx.insert(marketplaceStoreNodes).values({ id: createEntityId(), tenantId, accountId, label: "Synthetic node", publicKeyPem: "fixture-only",
        publicKeySpkiSha256: "a".repeat(64), creationRequestKey: accountId.replaceAll("-", "").repeat(2), creationInputDigest: "c".repeat(64),
        authorizationGeneration: generation, createdBy: userId, membershipId, authorityCeiling: authority });
    });
    const command = { requestKey: createEntityId(), expectedVersion: 0, enabled: true };
    await scheduler.save(authority, accountId, command);
    const read = async () => (await withTenant(database.db, authority, tx => tx.select().from(schedules).where(eq(schedules.accountId, accountId))))[0]!;
    const due = async () => { const row = await read(); await withTenant(database.db, authority, tx => tx.update(schedules).set({ nextRunAt: new Date(0) }).where(eq(schedules.id, row.id))); await scheduler.advance(authority, row.id); };
    const job = async () => { const row = await read(); return (await withTenant(database.db, authority, tx => tx.select().from(executions).where(eq(executions.id, row.activeExecutionId!))))[0]!; };
    return { accountId, command, read, due, job };
  }
  function page(input: OrderSyncNodeInput, accountId: string, nextCursor: string | null = null) {
    const raw = { orderId: "synthetic-order", createdTime: input.request.updatedAfter, lastUpdatedTime: input.request.updatedAfter,
      fulfillment: { fulfillmentStatus: "UNSHIPPED" }, salesChannel: { marketplaceId: "ATVPDKIKX0DER" }, proceeds: { grandTotal: { amount: "25.00", currencyCode: "USD" } },
      orderItems: [{ orderItemId: "synthetic-line", quantityOrdered: 1, product: { title: "Synthetic pillow", price: { unitPrice: { amount: "25.00", currencyCode: "USD" } } } }] };
    return { records: [normalizeAmazonOrder(accountId, "same-source-event", raw)], nextCursor, reportedCount: 1, fetchedAt: new Date().toISOString(),
      highWaterAt: input.request.updatedBefore, sourceVersion: "amazon-orders-2026-01-01" };
  }
  async function adopt(s: Awaited<ReturnType<typeof scene>>, nextCursor: string | null = null, rollback = false) {
    const job = await s.job(), input = OrderSyncNodeInputSchema.parse(job.input);
    return withTenant(database.db, authority, async tx => {
      await coordinator.adoptNodePageInTransaction(tx, { ...job, startedAt: new Date() }, page(input, s.accountId, nextCursor));
      if (rollback) throw new Error("synthetic-page-rollback");
      // Simulate the native runtime's terminal receipt without invoking a provider or buying a label.
      await tx.update(executions).set({ state: "cancelled", phase: "finished", completedAt: new Date() }).where(eq(executions.id, job.id));
    });
  }
  it("pins a delayed query window once, advances each page atomically and deduplicates a repeated order", async () => {
    const s = await scene(); await scheduler.save(authority, s.accountId, s.command);
    expect((await s.read()).version).toBe(1);
    await s.due(); const saved = await s.read(), first = saved.request!;
    expect(saved.updatedAt.getTime() - Date.parse(first.updatedBefore)).toBe(150_000);
    expect(Date.parse(first.updatedBefore) - Date.parse(first.updatedAfter)).toBe(7 * 86400_000);
    await adopt(s, "next-page");
    expect((await s.read()).request).toMatchObject({ updatedAfter: first.updatedAfter, updatedBefore: first.updatedBefore, checkpoint: { cursor: "next-page", version: 2 } });
    await s.due(); await adopt(s);
    expect((await s.read()).request).toBeNull();
    const runs = await withTenant(database.db, authority, tx => tx.select().from(orderIngestionRuns).where(eq(orderIngestionRuns.accountId, s.accountId)));
    expect(runs.map(row => row.status)).toEqual(["partial", "completed"]); expect(runs[1]!.duplicateCount).toBe(1);
    const rows = await withTenant(database.db, authority, tx => tx.select().from(orders).where(eq(orders.accountId, s.accountId)));
    expect(rows).toHaveLength(1);
    expect(await withTenant(database.db, authority, tx => tx.select().from(orderSourceSnapshots).where(eq(orderSourceSnapshots.normalizedOrderId, rows[0]!.id)))).toHaveLength(1);
  });
  it("rolls back the whole page and rejects repeated cursors and foreign-account results", async () => {
    const s = await scene(); await s.due();
    await expect(adopt(s, "same-cursor", true)).rejects.toThrow("synthetic-page-rollback");
    expect(await withTenant(database.db, authority, tx => tx.select().from(orders).where(eq(orders.accountId, s.accountId)))).toHaveLength(0);
    expect((await s.read()).request?.checkpoint.version).toBe(1);
    await adopt(s, "same-cursor"); await s.due();
    await expect(adopt(s, "same-cursor")).rejects.toThrow();
    const job = await s.job(), payload = page(OrderSyncNodeInputSchema.parse(job.input), createEntityId());
    await expect(withTenant(database.db, authority, tx => coordinator.adoptNodePageInTransaction(tx, { ...job, startedAt: new Date() }, payload))).rejects.toThrow();
    expect((await s.read()).request?.checkpoint.version).toBe(2);
    const foreign = { ...authority, tenantId: createEntityId() };
    expect(await withTenant(database.db, foreign, tx => tx.select().from(schedules))).toEqual([]);
  });
  it("keeps the exact request on retry, and cancels the pending run when the administrator pauses", async () => {
    const s = await scene(); await s.due(); const original = (await s.read()).request, job = await s.job();
    await withTenant(database.db, authority, async tx => {
      await coordinator.failNodeRunInTransaction(tx, job, "store_node_upstream_rate_limited");
      await tx.update(executions).set({ state: "failed", phase: "finished", completedAt: new Date(), errorCode: "store_node_upstream_rate_limited" }).where(eq(executions.id, job.id));
    });
    expect(await s.read()).toMatchObject({ enabled: true, failureCount: 1, request: original, activeExecutionId: null });
    await s.due(); expect((await s.read()).request).toEqual(original);
    const pending = await s.job(); await scheduler.save(authority, s.accountId, { requestKey: createEntityId(), expectedVersion: 1, enabled: false });
    expect(await s.read()).toMatchObject({ enabled: false, activeExecutionId: null });
    const [run] = await withTenant(database.db, authority, tx => tx.select().from(orderIngestionRuns).where(eq(orderIngestionRuns.id, OrderSyncNodeInputSchema.parse(pending.input).runId)));
    expect(run?.status).toBe("failed");
    expect((await withTenant(database.db, authority, tx => tx.select().from(orderConnectorCheckpoints).where(eq(orderConnectorCheckpoints.accountId, s.accountId))))[0]?.version).toBe(1);
  });
  it("rechecks current permissions before continuing and stops an already queued run on revocation", async () => {
    const s = await scene(); await s.due();
    await withTenant(database.db, authority, tx => tx.update(roles).set({ permissions: [Permission.StoreRead] }).where(eq(roles.id, roleId)));
    try { await s.due(); expect(await s.read()).toMatchObject({ enabled: false, activeExecutionId: null, errorCode: "order_sync_configuration_changed" });
      await expect(scheduler.save(authority, s.accountId, { requestKey: createEntityId(), expectedVersion: 1, enabled: true })).rejects.toThrow();
    } finally { await withTenant(database.db, authority, tx => tx.update(roles).set({ permissions: authority.permissions }).where(eq(roles.id, roleId))); }
  });
});
