import { createHash } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  amazonOrderReportBatches as batches, amazonOrderReportBatchItems as batchItems, amazonOrderReportLines as reportLines,
  connectDatabase, migrateDatabase, withTenant, marketplaceAccounts, memberships, membershipRoles, roles,
  orders, orderLines, orderEvents, orderProtectedDetails, orderSourceSnapshots, orderWorkItems, type DatabaseConnection,
} from "@yummyai/database";
import { parseAmazonOrderReport } from "@yummyai/order-intake";
import { workProjection } from "@yummyai/order-core";
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { OrderService } from "./order.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";

const sha = (text: string) => createHash("sha256").update(text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")).digest("hex");
const market = "ATVPDKIKX0DER";
function originalReport(externalOrderId: string, promise = "2026-10-28T06:59:59+00:00", sku = "SYNTHETIC-SKU") {
  const headers = ["order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased", "quantity-shipped", "quantity-to-ship", "promise-date", "buyer-name", "recipient-name", "ship-address-1", "ship-city", "ship-country"];
  return [headers.join("\t"), ...["A", "B"].map((suffix, index) => [externalOrderId, `${externalOrderId}-${suffix}`,
    "2026-10-24T12:00:00Z", sku, "Synthetic pillow", index ? "1" : "2", "0", index ? "1" : "2", index ? "" : promise,
    "Synthetic Buyer", "Synthetic Recipient", "Synthetic Private Street", "Synthetic City", "US"].join("\t"))].join("\r\n");
}

describe.sequential("native unshipped report shipping deadline refresh", () => {
  let database: DatabaseConnection, audit: AuditService, orderService: OrderService, service: AmazonOrderReportService;
  const tenant = createEntityId(), user = createEntityId(), otherTenant = createEntityId(), otherUser = createEntityId();
  const memberId = createEntityId(), roleId = createEntityId(), accountId = createEntityId();
  const permissions = [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead];
  // No permissionScopes on purpose: the new native owner must still load the
  // real current membership instead of treating this as a credential adapter.
  const context: TenantContext = { tenantId: tenant, userId: user, permissions, dataScope: "tenant" };
  const other: TenantContext = { ...context, tenantId: otherTenant, userId: otherUser };
  const vault = new SecretVault(Buffer.alloc(32, 109));
  const retention = { schedule: vi.fn(async () => undefined) }, processing = { schedule: vi.fn(async () => undefined) };
  const gateway = { download: vi.fn(async (): Promise<Uint8Array> => { throw Error("Synthetic no download expected"); }),
    scan: vi.fn(async (): Promise<never> => { throw Error("Synthetic no scan expected"); }) };
  beforeAll(async () => {
    requireDisposableIntegrationEnvironment();
    database = connectDatabase(); await migrateDatabase(database);
    await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic shipping A',$2),($3,'Synthetic shipping B',$4)", [tenant, `ship-${tenant}`, otherTenant, `ship-${otherTenant}`]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic shipping A'),($4,$5,$6,'Synthetic shipping B')", [user, `ship-${user}`, `${user}@example.test`, otherUser, `ship-${otherUser}`, `${otherUser}@example.test`]);
    for (const actor of [context, other]) await withTenant(database.db, actor, async tx => {
      const membershipId = actor === context ? memberId : createEntityId(), assignedRole = actor === context ? roleId : createEntityId();
      await tx.insert(memberships).values({ id: membershipId, tenantId: actor.tenantId, userId: actor.userId, status: "active" });
      await tx.insert(roles).values({ id: assignedRole, tenantId: actor.tenantId, name: `Synthetic shipping ${actor.userId}`, permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: actor.tenantId, membershipId, roleId: assignedRole });
    });
    await withTenant(database.db, context, tx => tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: tenant,
      platform: "amazon", displayName: "Synthetic shipping shop", region: "NA", authorizationMode: "amazon_private", marketplaceIds: [market], createdBy: user }));
    audit = new AuditService(database); orderService = new OrderService(database, vault, audit);
    service = new AmazonOrderReportService(database, vault, orderService, audit, gateway, retention, processing);
  }, 60_000);
  // The exact disposable runner owns removal of the database and all immutable
  // fixture history. Do not add delete privileges to production source tables.
  afterAll(async () => { if (database) await database.client.end(); });

  async function legacy() {
    const externalOrderId = `SYNTHETIC-${createEntityId()}`, text = originalReport(externalOrderId);
    const parsed = parseAmazonOrderReport(text), source = parsed.orders[0]!, expiry = new Date(Date.now() + 86_400_000);
    const order = (await orderService.materializeNormalized(context, {
      accountId, platform: "amazon", externalEventId: `legacy-${externalOrderId}`, externalOrderId,
      providerStatus: "report_imported", placedAt: source.placedAt, orderTotal: null, protectedDetails: source.protectedDetails,
      lines: source.lines.map(line => ({ externalLineId: line.externalLineId, skuCode: line.skuCode, title: line.title,
        externalListingId: null, quantity: line.quantity, unitPrice: null, customizationCount: 0 })),
      redactedSource: { source: "amazon_manual_report", reportType: "unshipped", marketplaceId: market, lineCount: 2 },
    }, { manualReport: true, protectedExpiresAt: expiry })).order;
    const batchId = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(batches).values({ id: batchId, tenantId: tenant, accountId, marketplaceId: market, fileName: "synthetic-legacy.txt",
        reportChecksum: sha(text), encryptedReport: vault.encrypt(text), rowCount: parsed.rowCount, orderCount: 1,
        newOrderCount: 1, status: "completed", createdBy: user, expiresAt: expiry });
      await tx.insert(batchItems).values({ id: createEntityId(), tenantId: tenant, batchId, orderId: order.id, externalOrderId, status: "imported" });
      for (const line of order.lines) await tx.insert(reportLines).values({ id: createEntityId(), tenantId: tenant,
        orderId: order.id, orderLineId: line.id, batchId, sourceChecksum: sha(JSON.stringify(line)),
        encryptedSource: vault.encrypt(JSON.stringify({ lineId: line.externalLineId })), state: "none", expiresAt: expiry });
    });
    return { batchId, order, externalOrderId, text };
  }
  const sources = (orderId: string) => withTenant(database.db, context, tx => tx.select().from(orderSourceSnapshots)
    .where(eq(orderSourceSnapshots.normalizedOrderId, orderId)).orderBy(orderSourceSnapshots.id));
  const business = (orderId: string, batchId: string) => withTenant(database.db, context, async tx => ({
    orders: await tx.select().from(orders).where(eq(orders.id, orderId)),
    lines: await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(orderLines.id),
    events: await tx.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)).orderBy(orderEvents.id),
    privacy: await tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, orderId)),
    report: await tx.select().from(reportLines).where(eq(reportLines.orderId, orderId)).orderBy(reportLines.id),
    batch: await tx.select().from(batches).where(eq(batches.id, batchId)),
    work: await tx.select().from(orderWorkItems).where(inArray(orderWorkItems.id, tx.select({ id: orderLines.id }).from(orderLines).where(eq(orderLines.orderId, orderId)))),
  }));

  it("new imports retain a per-line platform promise without recording any shipment", async () => {
    const external = `SYNTHETIC-${createEntityId()}`;
    const batch = await service.importReport(context, { accountId, marketplaceId: market, fileName: "synthetic-new.txt", content: originalReport(external) });
    const [item] = await withTenant(database.db, context, tx => tx.select().from(batchItems).where(eq(batchItems.batchId, batch.id)));
    const [source] = await sources(item!.orderId!);
    expect(source.redactedPayload).toMatchObject({ source: "amazon_manual_report", reportType: "unshipped", batchId: batch.id,
      orderId: external, platformShipBySource: "amazon_unshipped_report_promise_date", platformShipByField: "promise-date",
      platformShipByAtByLine: { [`${external}-A`]: "2026-10-28T06:59:59.000Z", [`${external}-B`]: null } });
    expect(JSON.stringify(source.redactedPayload)).not.toContain("Synthetic Private Street");
    expect((await orderService.get(context, item!.orderId!)).workflowState).toBe("pending");
  });

  it("appends one historic sibling idempotently and preserves all existing business rows", async () => {
    const f = await legacy(), before = await business(f.order.id, f.batchId), original = await sources(f.order.id);
    retention.schedule.mockClear(); processing.schedule.mockClear(); gateway.download.mockClear(); gateway.scan.mockClear();
    const first = await service.refreshPlatformDeadlines(context, f.batchId);
    expect(first).toMatchObject({ addedSources: 1, replayed: false, deadlinesKnown: 1, deadlinesMissing: 1 });
    const replay = await service.refreshPlatformDeadlines(context, f.batchId);
    expect(replay).toMatchObject({ addedSources: 0, replayed: true, sources: first.sources });
    const after = await sources(f.order.id); expect(after).toHaveLength(original.length + 1);
    expect(after.find(row => row.id === original[0]!.id)).toEqual(original[0]);
    expect(await business(f.order.id, f.batchId)).toEqual(before);
    for (const mock of [retention.schedule, processing.schedule, gateway.download, gateway.scan]) expect(mock).not.toHaveBeenCalled();
    const projected = await withTenant(database.db, context, tx => tx.execute(sql`select "externalLineId","platformShipByAt","platformDeadlineSource","platformDeadlineSourceVersionId" from (${workProjection}) v where "orderId"=${f.order.id}`));
    const promised = projected.find(row => row.externalLineId === `${f.externalOrderId}-A`)!;
    expect(new Date(promised.platformShipByAt as string).toISOString()).toBe("2026-10-28T06:59:59.000Z");
    expect(promised.platformDeadlineSource).toBe("report_import");
    expect(promised.platformDeadlineSourceVersionId).toBe(first.sources[0]!.sourceVersionId);
  });

  it("reimporting the same unshipped file keeps one order and never resets its progressed workflow", async () => {
    const external = `SYNTHETIC-${createEntityId()}`, content = originalReport(external);
    const input = { accountId, marketplaceId: market, fileName: "synthetic-replay.txt", content };
    const first = await service.importReport(context, input);
    const [item] = await withTenant(database.db, context, tx => tx.select().from(batchItems).where(eq(batchItems.batchId, first.id)));
    const original = await orderService.get(context, item!.orderId!);
    const progressed = await orderService.transition(context, original.id, { toState: "awaiting_customization",
      expectedSequence: original.latestEventSequence, idempotencyKey: createEntityId(), reason: "Synthetic actual intake progress" });
    const oldSources = await sources(original.id);
    const repeat = await service.importReport(context, input);
    expect(repeat).toMatchObject({ newOrderCount: 0, duplicateOrderCount: 1, failedOrderCount: 0 });
    const current = await orderService.get(context, original.id);
    expect(current.workflowState).toBe(progressed.workflowState);
    expect(current.sideState).toBe(progressed.sideState);
    expect(current.lines).toEqual(progressed.lines);
    const after = await sources(original.id);
    expect(after).toHaveLength(2);
    expect(after.find(row => row.id === oldSources[0]!.id)).toEqual(oldSources[0]);
    expect(after.find(row => row.redactedPayload.batchId === repeat.id)?.externalEventId).toContain(`report-deadline-aware:${repeat.id}:`);
  });

  it("does not expose another tenant's batch", async () => {
    const f = await legacy(); await expect(service.refreshPlatformDeadlines(other, f.batchId)).rejects.toBeInstanceOf(NotFoundException);
    expect(await sources(f.order.id)).toHaveLength(1);
  });

  it("rechecks current membership, permission and tenant scope despite a stale caller ceiling", async () => {
    const f = await legacy();
    for (const change of ["revoked", "self", "disabled"] as const) {
      await withTenant(database.db, context, async tx => {
        if (change === "disabled") await tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, memberId));
        else await tx.update(roles).set(change === "self" ? { dataScope: "self" } : { permissions: [Permission.OrderRead] }).where(eq(roles.id, roleId));
      });
      try { await expect(service.refreshPlatformDeadlines(context, f.batchId)).rejects.toBeInstanceOf(ForbiddenError); }
      finally { await withTenant(database.db, context, async tx => {
        await tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, memberId));
        await tx.update(roles).set({ permissions, dataScope: "tenant" }).where(eq(roles.id, roleId));
      }); }
    }
    expect(await sources(f.order.id)).toHaveLength(1);
  });

  it.each(["expired", "erased", "checksum", "line_identity", "partial"])("rejects unavailable or changed original evidence: %s", async change => {
    const f = await legacy();
    await withTenant(database.db, context, async tx => {
      if (change === "expired") await tx.update(batches).set({ expiresAt: new Date(0) }).where(eq(batches.id, f.batchId));
      if (change === "erased") await tx.update(batches).set({ encryptedReport: null }).where(eq(batches.id, f.batchId));
      if (change === "checksum") await tx.update(batches).set({ encryptedReport: vault.encrypt(f.text+'\n') }).where(eq(batches.id, f.batchId));
      if (change === "line_identity") {
        const different = originalReport(f.externalOrderId, "2026-10-28T06:59:59Z", "SYNTHETIC-OTHER-SKU");
        await tx.update(batches).set({ encryptedReport: vault.encrypt(different), reportChecksum: sha(different) }).where(eq(batches.id, f.batchId));
      }
      if (change === "partial") await tx.update(batches).set({ status: "partial", newOrderCount: 0, failedOrderCount: 1 }).where(eq(batches.id, f.batchId));
    });
    await expect(service.refreshPlatformDeadlines(context, f.batchId)).rejects.toBeInstanceOf(change === "checksum" ? UnprocessableEntityException : ConflictException);
    expect(await sources(f.order.id)).toHaveLength(1);
  });

  it("report precedence keeps a newer changed deadline when an older batch is refreshed", async () => {
    const f = await legacy();
    const newer = await service.importReport(context, { accountId, marketplaceId: market, fileName: "synthetic-newer.txt",
      content: originalReport(f.externalOrderId, "2026-10-30T06:59:59+00:00") });
    const newerSource = (await sources(f.order.id)).find(row => row.redactedPayload.batchId === newer.id)!;
    expect(newerSource).toBeDefined();
    // This deliberately creates the OLD batch's sibling after the new import;
    // snapshot received_at therefore cannot select the authoritative report.
    const refreshed = await service.refreshPlatformDeadlines(context, f.batchId);
    expect(refreshed.addedSources).toBe(1);
    const [line] = await withTenant(database.db, context, tx => tx.execute(sql`
      select "platformShipByAt","platformDeadlineSource","platformDeadlineSourceVersionId"
      from (${workProjection}) v where "orderId"=${f.order.id} and "externalLineId"=${`${f.externalOrderId}-A`}`));
    expect(new Date(line!.platformShipByAt as string).toISOString()).toBe("2026-10-30T06:59:59.000Z");
    expect(line!.platformDeadlineSource).toBe("report_import");
    expect(line!.platformDeadlineSourceVersionId).toBe(newerSource.id);
    expect(line!.platformDeadlineSourceVersionId).not.toBe(refreshed.sources[0]!.sourceVersionId);
  });

  it("report precedence keeps the newest unknown deadline rather than reviving an older promise", async () => {
    const external = `SYNTHETIC-${createEntityId()}`;
    const first = await service.importReport(context, { accountId, marketplaceId: market, fileName: "synthetic-promised.txt",
      content: originalReport(external, "2026-10-28T06:59:59Z") });
    const [item] = await withTenant(database.db, context, tx => tx.select().from(batchItems).where(eq(batchItems.batchId, first.id)));
    const newest = await service.importReport(context, { accountId, marketplaceId: market, fileName: "synthetic-unknown.txt",
      content: originalReport(external, "2026-10-30") });
    const newestSource = (await sources(item!.orderId!)).find(row => row.redactedPayload.batchId === newest.id)!;
    expect(newestSource.redactedPayload.platformShipByAtByLine).toMatchObject({ [`${external}-A`]: null });
    await service.refreshPlatformDeadlines(context, first.id);
    const [line] = await withTenant(database.db, context, tx => tx.execute(sql`
      select "platformShipByAt","platformDeadlineSource" from (${workProjection}) v
      where "orderId"=${item!.orderId!} and "externalLineId"=${`${external}-A`}`));
    expect(line!.platformShipByAt).toBeNull();
    expect(line!.platformDeadlineSource).toBe("missing");
  });
});
