import { createHash } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, type AmazonReportImportInput, type AmazonReportLineView, type RecordCustomizationFileScanInput, type TenantContext } from "@yummyai/contracts";
import {
  amazonOrderReportBatches, amazonOrderReportLines, amazonOrderReportVersions, amazonOrderReportReadModels,
  amazonOrderReportProcessingRequests,
  connectDatabase, marketplaceAccounts, migrateDatabase, orderLines, orderProtectedAccessEvents,
  orderProtectedDetails, orders, withTenant, memberships, membershipRoles, roles, purgeExpiredAmazonOrderReports,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { AMAZON_CUSTOM_PARSER_REVISION } from "./amazon-custom-archive.js";
import type { AmazonReportArchiveGateway } from "./amazon-report-archive.gateway.js";
import { AmazonArchiveAccessError } from "./amazon-report-archive.gateway.js";
import { AmazonReportArchiveProcessor, AmazonReportBatchPendingError, DrizzleAmazonReportBatchRepository, createAmazonReportBatchProcessor } from "@yummyai/order-intake";
import { OrderService } from "./order.service.js";
import type { AmazonReportRetentionEnqueuer } from "./redis-amazon-report-retention-enqueuer.js";

type SourceRow = { orderId: string; lineId: string; custom: boolean; sku?: string; quantity?: number; url?: string };
const marketplaceId = "ATVPDKIKX0DER";
const tsvHeaders = ["order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased", "currency", "item-price", "customized-url", "buyer-name", "recipient-name", "ship-address-1", "ship-city", "ship-state", "ship-postal-code", "ship-country"];
function sourceRow(custom = true): SourceRow { return { orderId: `SYNTHETIC-ORDER-${createEntityId()}`, lineId: `SYNTHETIC-LINE-${createEntityId()}`, custom }; }
function deferred() { let resolve!: () => void; const promise = new Promise<void>((callback) => { resolve = callback; }); return { promise, resolve }; }
function sourceUrl(row: SourceRow) { return row.url ?? `https://zme-caps.amazon.com/synthetic/${row.lineId}`; }
function tsv(rows: SourceRow[]) {
  return [tsvHeaders.join("\t"), ...rows.map((row) => [row.orderId, row.lineId, "2026-09-01T12:00:00Z", row.sku ?? "SYNTHETIC-SAME-SKU", "Synthetic custom product", String(row.quantity ?? 1), "USD", "29.99", row.custom ? sourceUrl(row) : "", "Synthetic Buyer", "Synthetic Recipient", "Synthetic Private Address", "Synthetic City", "CA", "00000", "US"].join("\t"))].join("\r\n");
}
function unpricedTsv(rows: SourceRow[]) {
  const records = tsv(rows).split(/\r?\n/).map(row => row.split("\t"));
  const retained = tsvHeaders.map((name, index) => ({ name, index })).filter(({ name }) => !["currency", "item-price"].includes(name));
  return records.map((record, index) => [...retained.map(column => record[column.index]),
    ...(index === 0 ? ["quantity-shipped", "quantity-to-ship", "promise-date"] : ["0", record[5], "2026-09-30T12:00:00Z"]),
  ].join("\t")).join("\r\n");
}
async function customZip(row: SourceRow, value = "Synthetic buyer choice", overrides: Record<string, unknown> = {}, withPreview = true, dimensions = { width: 16, height: 12 }) {
  const zip = new JSZip();
  const fixedDate = new Date("2026-09-01T12:00:00Z");
  const content = {
    orderId: row.orderId, orderItemId: row.lineId, marketplaceId, quantity: row.quantity ?? 1,
    customizationData: { type: "PageContainerCustomization", label: "Front", ...(withPreview ? { snapshot: { imageName: "preview.jpg" } } : {}), children: [
      { type: "TextCustomization", label: "Personalized text", inputValue: value },
      { type: "ImageCustomization", label: "Photo", image: { imageName: "buyer.jpg", buyerFilename: "synthetic-upload.jpg" } },
    ] },
    ...overrides,
  };
  zip.file("order.json", JSON.stringify(content), { date: fixedDate });
  const picture = await sharp({ create: { ...dimensions, channels: 3, background: "blue" } }).jpeg().toBuffer();
  zip.file("buyer.jpg", picture, { date: fixedDate });
  if (withPreview) zip.file("preview.jpg", picture, { date: fixedDate });
  zip.file("layout.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>synthetic()</script></svg>', { date: fixedDate });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("manual Amazon order reports and private customization files", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(), tenantB = createEntityId(), userA = createEntityId(), userB = createEntityId(), accountA = createEntityId(), accountB = createEntityId();
  const memberA = createEntityId(), memberB = createEntityId(), roleA = createEntityId(), roleB = createEntityId(), notificationRoleA = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write", "order:pii:read"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: [...contextA.permissions], dataScope: "tenant" };
  const vault = new SecretVault(Buffer.alloc(32, 107));
  const audit = new AuditService(database);
  const orderService = new OrderService(database, vault, audit);
  const archives = new Map<string, Uint8Array>();
  const cleanScan = (): RecordCustomizationFileScanInput => ({ result: "clean", engine: "synthetic-scanner", signatureVersion: "synthetic-signature-1", scannedAt: new Date().toISOString() });
  const gateway: AmazonReportArchiveGateway = {
    download: vi.fn(async (url: string) => { const bytes = archives.get(url); if (!bytes) throw new Error("Synthetic fixture unavailable"); return bytes; }),
    scan: vi.fn(async () => cleanScan()),
  };
  const processing = { schedule: vi.fn(async () => undefined) };
  const retention: AmazonReportRetentionEnqueuer = { schedule: vi.fn(async () => undefined) };
  const service = new AmazonOrderReportService(database, vault, orderService, audit, gateway, retention, processing);
  const input = (rows: SourceRow[], accountId = accountA): AmazonReportImportInput => ({ accountId, marketplaceId, fileName: "synthetic-report.txt", content: tsv(rows) });
  it("imports an unpriced unshipped report with unknown money and still processes its private customization", async () => {
    const row = sourceRow();
    archives.set(sourceUrl(row), await customZip(row));
    const batch = await service.importReport(contextA, { ...input([row]), content: unpricedTsv([row]) });
    expect(batch).toMatchObject({ status: "completed", newOrderCount: 1, failedOrderCount: 0 });
    const [line] = (await service.workspace(contextA, { batchId: batch.id })).lines;
    expect(line).toMatchObject({ currency: null, itemTotalMinor: null, state: "pending" });
    const order = await orderService.get(contextA, line!.orderId);
    expect(order).toMatchObject({ orderTotal: null, workflowState: "pending", providerStatus: "report_imported" });
    expect(order.lines[0]!.unitPrice).toBeNull();
    const parsed = await service.process(contextA, line!.id, null);
    expect(parsed.line).toMatchObject({ state: "ready", reviewed: false, currency: null, itemTotalMinor: null });
    expect(parsed.surfaces[0]!.fields.some(field => field.value === "Synthetic buyer choice")).toBe(true);
    const duplicate = await service.importReport(contextA, { ...input([row]), content: unpricedTsv([row]) });
    expect(duplicate).toMatchObject({ newOrderCount: 0, duplicateOrderCount: 1, failedOrderCount: 0 });
    expect((await service.detail(contextA, line!.id)).versionId).toBe(parsed.versionId);
  });

  it("fills unknown order money from a priced report and never erases known money with an unpriced replay", async () => {
    const row = sourceRow(false), unpriced = { ...input([row]), content: unpricedTsv([row]) };
    const initial = await service.importReport(contextA, unpriced);
    const [line] = (await service.workspace(contextA, { batchId: initial.id })).lines;
    expect((await orderService.get(contextA, line!.orderId)).orderTotal).toBeNull();
    const priced = await service.importReport(contextA, input([row]));
    expect(priced).toMatchObject({ newOrderCount: 0, duplicateOrderCount: 1, failedOrderCount: 0 });
    const known = await orderService.get(contextA, line!.orderId);
    expect(known.orderTotal).toEqual({ amountMinor: 2999, currency: "USD" });
    expect(known.lines[0]!.unitPrice).toEqual({ amountMinor: 2999, currency: "USD" });
    await service.importReport(contextA, unpriced);
    const after = await orderService.get(contextA, line!.orderId);
    expect(after.orderTotal).toEqual(known.orderTotal);
    expect(after.lines[0]!.unitPrice).toEqual(known.lines[0]!.unitPrice);
    expect((await service.detail(contextA, line!.id)).line).toMatchObject({ currency: null, itemTotalMinor: null });
  });

  it("marks an aggregate unknown when a new unpriced line is added and restores it only with complete evidence", async () => {
    const first = sourceRow(false), second = { ...sourceRow(false), orderId: first.orderId };
    const initial = await service.importReport(contextA, input([first]));
    const [line] = (await service.workspace(contextA, { batchId: initial.id })).lines;
    await service.importReport(contextA, { ...input([second]), content: unpricedTsv([second]) });
    const incomplete = await orderService.get(contextA, line!.orderId);
    expect(incomplete.orderTotal).toBeNull();
    expect(incomplete.lines.find(item => item.externalLineId === first.lineId)!.unitPrice).toEqual({ amountMinor: 2999, currency: "USD" });
    expect(incomplete.lines.find(item => item.externalLineId === second.lineId)!.unitPrice).toBeNull();
    await service.importReport(contextA, input([first, second]));
    expect((await orderService.get(contextA, line!.orderId)).orderTotal).toEqual({ amountMinor: 5998, currency: "USD" });
  });

  it("returns a safe structured import diagnostic before creating a batch", async () => {
    const before = (await service.workspace(contextA, { accountId: accountA })).batches.map(batch => batch.id);
    const malformed = input([sourceRow(false)]);
    malformed.content = malformed.content.replace("29.99", "PRIVATE-INVALID-AMOUNT");
    let caught: unknown;
    try { await service.importReport(contextA, malformed); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(UnprocessableEntityException);
    const body = (caught as UnprocessableEntityException).getResponse();
    expect(body).toMatchObject({ row: 2 });
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect((await service.workspace(contextA, { accountId: accountA })).batches.map(batch => batch.id)).toEqual(before);
  });
  async function importRows(rows: SourceRow[]) {
    const batch = await service.importReport(contextA, input(rows));
    expect(batch.status).toBe("completed");
    const workspace = await service.workspace(contextA, { batchId: batch.id });
    return { batch, lines: workspace.lines };
  }
  async function importedLine(row = sourceRow(), value = "Synthetic buyer choice") {
    if (row.custom) archives.set(sourceUrl(row), await customZip(row, value));
    const result = await importRows([row]);
    return { row, batch: result.batch, line: result.lines[0]! };
  }
  const lineBySource = (lines: AmazonReportLineView[], source: SourceRow) => lines.find((line) => line.externalLineId === source.lineId)!;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "Synthetic Report A", `report-a-${tenantA}`, tenantB, "Synthetic Report B", `report-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `report-a-${userA}`, `report-a-${userA}@example.test`, "Synthetic A", userB, `report-b-${userB}`, `report-b-${userB}@example.test`, "Synthetic B"]);
    for (const [context, membershipId, roleId, accountId] of [[contextA, memberA, roleA, accountA], [contextB, memberB, roleB, accountB]] as const) {
      await withTenant(database.db, context, async (tx) => {
        await tx.insert(memberships).values({ id: membershipId, tenantId: context.tenantId, userId: context.userId, status: "active" });
        await tx.insert(roles).values({ id: roleId, tenantId: context.tenantId, name: "Synthetic report operator", permissions: [...context.permissions], dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId: context.tenantId, membershipId, roleId });
        await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: context.tenantId, platform: "amazon", displayName: "Synthetic Shop", region: "NA", authorizationMode: "amazon_private", marketplaceIds: [marketplaceId], createdBy: context.userId });
      });
    }
    await withTenant(database.db, contextA, async (tx) => {
      await tx.insert(roles).values({ id: notificationRoleA, tenantId: tenantA, name: "Synthetic notification reader", permissions: [Permission.NotificationRead], dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: tenantA, membershipId: memberA, roleId: notificationRoleA });
    });
  }, 60_000);
  afterAll(async () => { await database.client.end(); });

  it.each(["disabled_member", "order_write_revoked", "pii_revoked", "self_scope", "team_scope"] as const)(
    "does not decrypt or download queued attachments after %s and does not replay on restored access", async (change) => {
      const fixture = await importedLine(), download = vi.fn(gateway.download), scan = vi.fn(gateway.scan);
      const decrypt = vi.spyOn(vault, "withSecret");
      const worker = createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, { download, scan }));
      try {
        await withTenant(database.db, contextA, async (tx) => {
          if (change === "disabled_member") await tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, memberA));
          else if (change === "self_scope" || change === "team_scope") await tx.update(roles).set({ dataScope: change === "self_scope" ? "self" : "team" }).where(eq(roles.id, roleA));
          else await tx.update(roles).set({ permissions: contextA.permissions.filter(permission => permission !== (change === "order_write_revoked" ? Permission.OrderWrite : Permission.OrderPiiRead)) }).where(eq(roles.id, roleA));
        });
        await expect(worker.process(contextA, fixture.batch.id)).resolves.toMatchObject({ completed: 0, failed: 1 });
        expect(download).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled(); expect(decrypt).not.toHaveBeenCalled();
        const [line] = await withTenant(database.db, contextA, tx => tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.line.id)));
        const [request] = await withTenant(database.db, contextA, tx => tx.select().from(amazonOrderReportProcessingRequests).where(eq(amazonOrderReportProcessingRequests.reportLineId, fixture.line.id)));
        expect(line).toMatchObject({ state: "failed", lastErrorCode: "processing_blocked", currentVersionId: null, versionNumber: 0 });
        expect(request).toMatchObject({ status: "failed", lastErrorCode: "processing_blocked", attemptCount: 0 });
      } finally {
        decrypt.mockRestore();
        await withTenant(database.db, contextA, async (tx) => {
          await tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, memberA));
          await tx.update(roles).set({ permissions: [...contextA.permissions], dataScope: "tenant" }).where(eq(roles.id, roleA));
        });
      }
      await expect(worker.process(contextA, fixture.batch.id)).resolves.toMatchObject({ completed: 0, failed: 1 });
      expect(download).not.toHaveBeenCalled();
    },
  );

  it.each(["download", "scan"] as const)("discards in-flight bytes when access is revoked during %s", async (stage) => {
    const fixture = await importedLine();
    const revoke = () => withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: [Permission.OrderRead] }).where(eq(roles.id, roleA)));
    const download = vi.fn(async () => { if (stage === "download") await revoke(); return archives.get(sourceUrl(fixture.row))!; });
    const scan = vi.fn(async () => { if (stage === "scan") await revoke(); return cleanScan(); });
    const worker = createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, { download, scan }));
    try {
      await expect(worker.process(contextA, fixture.batch.id)).resolves.toMatchObject({ completed: 0, failed: 1 });
      expect(download).toHaveBeenCalledTimes(1); expect(scan).toHaveBeenCalledTimes(stage === "download" ? 0 : 1);
      const [line] = await withTenant(database.db, contextA, tx => tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.line.id)));
      const versions = await withTenant(database.db, contextA, tx => tx.select({ id: amazonOrderReportVersions.id }).from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, fixture.line.id)));
      expect(line).toMatchObject({ state: "failed", lastErrorCode: "processing_blocked", currentVersionId: null, versionNumber: 0, processingToken: null });
      expect(versions).toEqual([]);
    } finally {
      await withTenant(database.db, contextA, tx => tx.update(roles).set({ permissions: [...contextA.permissions], dataScope: "tenant" }).where(eq(roles.id, roleA)));
    }
  });

  it("erases expired private report evidence even after its requesting member is disabled", async () => {
    const fixture = await importedLine();
    await createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, gateway)).process(contextA, fixture.batch.id);
    try {
      await withTenant(database.db, contextA, async (tx) => {
        await tx.update(memberships).set({ status: "disabled" }).where(eq(memberships.id, memberA));
        await tx.update(amazonOrderReportLines).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(amazonOrderReportLines.id, fixture.line.id));
      });
      await purgeExpiredAmazonOrderReports(database, { ...contextA, permissions: [] });
      const [line] = await withTenant(database.db, contextA, tx => tx.select({ state: amazonOrderReportLines.state, source: amazonOrderReportLines.encryptedSource }).from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.line.id)));
      const versions = await withTenant(database.db, contextA, tx => tx.select({ archive: amazonOrderReportVersions.encryptedArchive, document: amazonOrderReportVersions.encryptedDocument }).from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, fixture.line.id)));
      const [batch] = await withTenant(database.db, contextA, tx => tx.select({ report: amazonOrderReportBatches.encryptedReport }).from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, fixture.batch.id)));
      expect(line).toEqual({ state: "expired", source: null });
      expect(versions).toEqual([{ archive: null, document: null }]); expect(batch).toEqual({ report: null });
    } finally {
      await withTenant(database.db, contextA, tx => tx.update(memberships).set({ status: "active" }).where(eq(memberships.id, memberA)));
    }
  });

  it("processes persisted attachment requests after import returns, without a browser, review or workflow transitions", async () => {
    const fixture = await importedLine();
    const download = vi.fn(gateway.download);
    const worker = createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, { download, scan: gateway.scan }));
    expect(processing.schedule).toHaveBeenCalledWith(contextA, fixture.batch.id);
    await expect(worker.process(contextA, fixture.batch.id)).resolves.toMatchObject({ completed: 1, failed: 0 });
    const detail = await service.detail(contextA, fixture.line.id);
    expect(detail.line).toMatchObject({ state: "ready", reviewed: false, versionNumber: 1 });
    const before = await orderService.get(contextA, fixture.line.orderId);
    await worker.process(contextA, fixture.batch.id);
    expect(download).toHaveBeenCalledTimes(1);
    expect((await orderService.get(contextA, fixture.line.orderId)).workflowState).toBe(before.workflowState);
    expect((await service.detail(contextA, fixture.line.id)).versionId).toBe(detail.versionId);
    await expect(worker.process(contextB, fixture.batch.id)).resolves.toMatchObject({ ignored: true });
  });

  it("retries a transient attachment independently while preserving completed versions and failed source diagnostics", async () => {
    const good = sourceRow(), retry = sourceRow(), permanent = sourceRow();
    for (const row of [good, retry]) archives.set(sourceUrl(row), await customZip(row));
    const { batch, lines } = await importRows([good, retry, permanent]);
    let retries = 0;
    const download = vi.fn(async (url: string) => {
      if (url === sourceUrl(permanent)) throw new AmazonArchiveAccessError("link_unavailable");
      if (url === sourceUrl(retry) && retries++ === 0) throw new AmazonArchiveAccessError("download_timeout");
      return archives.get(url)!;
    });
    const worker = createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, { download, scan: gateway.scan }));
    await expect(worker.process(contextA, batch.id)).rejects.toBeInstanceOf(AmazonReportBatchPendingError);
    const completed = await service.detail(contextA, lineBySource(lines, good).id);
    expect((await service.detail(contextA, lineBySource(lines, retry).id)).line).toMatchObject({ state: "pending", lastErrorCode: "download_timeout" });
    await expect(worker.process(contextA, batch.id)).resolves.toMatchObject({ completed: 2, failed: 1 });
    expect((await service.detail(contextA, lineBySource(lines, good).id)).versionId).toBe(completed.versionId);
    expect(download.mock.calls.filter(([url]) => url === sourceUrl(good))).toHaveLength(1);
    expect((await service.detail(contextA, lineBySource(lines, permanent).id)).line).toMatchObject({ state: "failed", reviewed: false, lastErrorCode: "link_unavailable" });
  });

  it("does not let a queued job replace an explicitly uploaded and reviewed version", async () => {
    const fixture = await importedLine();
    const uploaded = await service.process(contextA, fixture.line.id, null, await customZip(fixture.row, "Operator supplied ZIP"));
    await service.review(contextA, fixture.line.id, uploaded.versionId!);
    const download = vi.fn(gateway.download);
    await createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, { download, scan: gateway.scan })).process(contextA, fixture.batch.id);
    expect(download).not.toHaveBeenCalled();
    expect((await service.detail(contextA, fixture.line.id)).line.reviewed).toBe(true);
    expect((await service.detail(contextA, fixture.line.id)).versionId).toBe(uploaded.versionId);
  });

  it("reclaims an interrupted line with the same request and does not revive an expired source", async () => {
    const fixture = await importedLine();
    await withTenant(database.db, contextA, async (tx) => {
      await tx.update(amazonOrderReportLines).set({ state: "processing", processingToken: createEntityId(), processingStartedAt: new Date(Date.now() - 121_000) }).where(eq(amazonOrderReportLines.id, fixture.line.id));
      await tx.update(amazonOrderReportProcessingRequests).set({ status: "processing", attemptCount: 1, updatedAt: new Date(Date.now() - 121_000) }).where(eq(amazonOrderReportProcessingRequests.reportLineId, fixture.line.id));
    });
    const worker = createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, gateway));
    await expect(worker.process(contextA, fixture.batch.id)).resolves.toMatchObject({ completed: 1 });
    const expired = await importedLine();
    await withTenant(database.db, contextA, (tx) => tx.update(amazonOrderReportLines).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(amazonOrderReportLines.id, expired.line.id)));
    const download = vi.fn(gateway.download);
    await createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, { download, scan: gateway.scan })).process(contextA, expired.batch.id);
    expect(download).not.toHaveBeenCalled();
    expect((await service.detail(contextA, expired.line.id)).line.state).toBe("expired");
  });

  it("retains no source bytes and materializes no orders when the attachment queue is unavailable", async () => {
    const row = sourceRow();
    const failedProcessing = { schedule: vi.fn<(context: TenantContext, batchId: string) => Promise<void>>(async () => { throw new Error("Synthetic queue unavailable"); }) };
    const guarded = new AmazonOrderReportService(database, vault, orderService, audit, gateway, retention, failedProcessing);
    await expect(guarded.importReport(contextA, input([row]))).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await withTenant(database.db, contextA, (tx) => tx.select().from(orders).where(eq(orders.externalOrderId, row.orderId)))).toEqual([]);
    const batchId = failedProcessing.schedule.mock.calls[0]![1];
    const [batch] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, batchId)));
    expect(batch).toMatchObject({ status: "failed", encryptedReport: null });
  });

  it("resumes pending attachments using a new durable dispatch without widening tenant scope", async () => {
    const fixture = await importedLine();
    const [before] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportProcessingRequests).where(eq(amazonOrderReportProcessingRequests.reportLineId, fixture.line.id)));
    await expect(service.resume(contextB, { batchId: fixture.batch.id })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.resume(contextA, { batchId: fixture.batch.id })).resolves.toEqual({ queued: 1 });
    const [after] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportProcessingRequests).where(eq(amazonOrderReportProcessingRequests.reportLineId, fixture.line.id)));
    expect(after.requestId).not.toBe(before.requestId);
    expect(after.dispatchId).toBeTruthy();
    expect(processing.schedule).toHaveBeenCalledWith(contextA, fixture.batch.id, after.dispatchId);
    await expect(createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, gateway)).process(contextA, fixture.batch.id, after.dispatchId!)).resolves.toMatchObject({ completed: 1 });
  });

  it("recovers every eligible line beyond the 1000-row display window using stable pagination", async () => {
    const fixture = await importedLine();
    await withTenant(database.db, contextA, async (tx) => {
      const [core] = await tx.select().from(orderLines).where(eq(orderLines.id, fixture.line.orderLineId));
      const [report] = await tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.line.id));
      const source = vault.withSecret(report.encryptedSource!, (value) => JSON.parse(value) as { line: Record<string, unknown>; marketplaceId: string; warnings: string[] });
      const copied = Array.from({ length: 1001 }, (_, index) => ({ coreId: createEntityId(), reportId: createEntityId(), externalLineId: `SYNTHETIC-PAGED-${index}-${fixture.line.id}` }));
      await tx.insert(orderLines).values(copied.map((line) => ({ ...core, id: line.coreId, externalLineId: line.externalLineId })));
      await tx.insert(amazonOrderReportLines).values(copied.map((line) => {
        const next = { ...source, line: { ...source.line, externalLineId: line.externalLineId } };
        return { ...report, id: line.reportId, orderLineId: line.coreId, state: "failed", lastErrorCode: "download_timeout", updatedAt: new Date(),
          encryptedSource: vault.encrypt(JSON.stringify(next)), sourceChecksum: createHash("sha256").update(JSON.stringify(next)).digest("hex") };
      }));
      await tx.update(orders).set({ lineCount: 1002 }).where(eq(orders.id, fixture.line.orderId));
      await tx.update(amazonOrderReportLines).set({ updatedAt: new Date(Date.now() - 86_400_000) }).where(eq(amazonOrderReportLines.id, fixture.line.id));
    });
    const display = await service.workspace(contextA, { batchId: fixture.batch.id });
    expect(display.lines).toHaveLength(1000);
    expect(display.lines.some((line) => line.id === fixture.line.id)).toBe(false);
    await expect(service.resume(contextA, { batchId: fixture.batch.id })).resolves.toEqual({ queued: 1002 });
    const requests = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportProcessingRequests).where(eq(amazonOrderReportProcessingRequests.batchId, fixture.batch.id)));
    expect(requests).toHaveLength(1002);
    expect(requests.every((request) => request.status === "pending" && request.dispatchId)).toBe(true);
    expect(requests.some((request) => request.reportLineId === fixture.line.id)).toBe(true);
  }, 60_000);

  it("keeps an active third attempt alive when another worker has an older pending snapshot", async () => {
    const fixture = await importedLine();
    await withTenant(database.db, contextA, (tx) => tx.update(amazonOrderReportProcessingRequests).set({ attemptCount: 2 }).where(eq(amazonOrderReportProcessingRequests.reportLineId, fixture.line.id)));
    const [request] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportProcessingRequests).where(eq(amazonOrderReportProcessingRequests.reportLineId, fixture.line.id)));
    const entered = deferred(), release = deferred();
    const download = vi.fn(async () => { entered.resolve(); await release.promise; return archives.get(sourceUrl(fixture.row))!; });
    const processor = new AmazonReportArchiveProcessor(database, vault, { download, scan: gateway.scan });
    const active = processor.process(contextA, fixture.line.id, null, undefined, request.requestId);
    await entered.promise;
    try {
      await expect(processor.process(contextA, fixture.line.id, null, undefined, request.requestId)).rejects.toMatchObject({ code: "busy" });
      await new DrizzleAmazonReportBatchRepository(database).retire(contextA, request, false);
      await expect(service.resume(contextA, { batchId: fixture.batch.id })).resolves.toEqual({ queued: 0 });
      const [current] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportProcessingRequests).where(eq(amazonOrderReportProcessingRequests.reportLineId, fixture.line.id)));
      expect(current).toMatchObject({ status: "processing", attemptCount: 3 });
    } finally { release.resolve(); }
    await active;
    expect(download).toHaveBeenCalledTimes(1);
    expect((await service.detail(contextA, fixture.line.id)).line).toMatchObject({ state: "ready", reviewed: false });
  });

  it("leaves a row locked by an import or claim alone and can recover it after that transaction", async () => {
    const fixture = await importedLine();
    const entered = deferred(), release = deferred();
    const locked = withTenant(database.db, contextA, async (tx) => {
      await tx.select({ id: amazonOrderReportLines.id }).from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.line.id)).for("update");
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    try { await expect(service.resume(contextA, { batchId: fixture.batch.id })).resolves.toEqual({ queued: 0 }); }
    finally { release.resolve(); await locked; }
    await expect(service.resume(contextA, { batchId: fixture.batch.id })).resolves.toEqual({ queued: 1 });
  });

  it("keeps an operator ZIP when a later report rotates its URL but still downloads older bytes", async () => {
    const fixture = await importedLine();
    const original = archives.get(sourceUrl(fixture.row))!;
    const operator = await service.process(contextA, fixture.line.id, null, await customZip(fixture.row, "Operator corrected B"));
    await service.review(contextA, fixture.line.id, operator.versionId!);
    const changed = { ...fixture.row, url: `${sourceUrl(fixture.row)}?rotated=1` };
    archives.set(sourceUrl(changed), original);
    const batch = await service.importReport(contextA, input([changed]));
    await expect(createAmazonReportBatchProcessor(database, new AmazonReportArchiveProcessor(database, vault, gateway)).process(contextA, batch.id)).resolves.toMatchObject({ failed: 1 });
    const [current] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.line.id)));
    expect(current).toMatchObject({ state: "failed", lastErrorCode: "attachment_changed", currentVersionId: operator.versionId, reviewedVersionId: operator.versionId });
    expect(await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, fixture.line.id)))).toHaveLength(1);
    // Only the explicit operator retry may select the different remote archive.
    const selected = await service.process(contextA, fixture.line.id, operator.versionId);
    expect(selected.versionId).not.toBe(operator.versionId);
    expect(selected.line.reviewed).toBe(false);
  });

  it("imports custom and ordinary items together and preserves report line totals", async () => {
    const custom = { ...sourceRow(), quantity: 3 }, ordinary = { ...sourceRow(false), orderId: custom.orderId };
    const { batch, lines } = await importRows([custom, ordinary]);
    expect(batch).toMatchObject({ rowCount: 2, orderCount: 1, newOrderCount: 1, duplicateOrderCount: 0, failedOrderCount: 0 });
    expect(lineBySource(lines, custom)).toMatchObject({ state: "pending", quantity: 3, itemTotalMinor: 2999, reviewed: false, hasPreview: false });
    expect(lineBySource(lines, ordinary)).toMatchObject({ state: "none", versionNumber: 0, hasPreview: false });
    const core = await orderService.get(contextA, lines[0].orderId);
    expect(core.lines).toHaveLength(2);
    expect(core.orderTotal).toEqual({ amountMinor: 5998, currency: "USD" });
    expect(JSON.stringify(lines)).not.toContain("Synthetic Private Address");
    expect(JSON.stringify(lines)).not.toContain("zme-caps");
  });

  it("does not duplicate orders, lines or versions on reimport and preserves reviewed unchanged content", async () => {
    const fixture = await importedLine();
    const parsed = await service.process(contextA, fixture.line.id, null);
    expect(parsed.line).toMatchObject({ state: "ready", versionNumber: 1, hasPreview: true });
    const reviewed = await service.review(contextA, fixture.line.id, parsed.versionId!);
    expect(reviewed.line.reviewed).toBe(true);
    const second = await service.importReport(contextA, input([fixture.row]));
    expect(second).toMatchObject({ newOrderCount: 0, duplicateOrderCount: 1, failedOrderCount: 0 });
    const again = await service.detail(contextA, fixture.line.id);
    expect(again.versionId).toBe(parsed.versionId);
    expect(again.line.reviewed).toBe(true);
    const processedAgain = await service.process(contextA, fixture.line.id, parsed.versionId!);
    expect(processedAgain.versionId).toBe(parsed.versionId);
    expect(processedAgain.line.reviewed).toBe(true);
    const stored = await withTenant(database.db, contextA, async (tx) => ({
      orders: await tx.select().from(orders).where(eq(orders.externalOrderId, fixture.row.orderId)),
      lines: await tx.select().from(orderLines).where(eq(orderLines.orderId, fixture.line.orderId)),
      versions: await tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, fixture.line.id)),
    }));
    expect(stored.orders).toHaveLength(1); expect(stored.lines).toHaveLength(1); expect(stored.versions).toHaveLength(1);
  });

  it("keeps separate customer choices for two order lines sharing a SKU", async () => {
    const first = sourceRow(), second = { ...sourceRow(), orderId: first.orderId };
    archives.set(sourceUrl(first), await customZip(first, "Synthetic first choice"));
    archives.set(sourceUrl(second), await customZip(second, "Synthetic second choice"));
    const { lines } = await importRows([first, second]);
    const firstDetail = await service.process(contextA, lineBySource(lines, first).id, null);
    const secondDetail = await service.process(contextA, lineBySource(lines, second).id, null);
    expect(firstDetail.surfaces[0].fields[0].value).toBe("Synthetic first choice");
    expect(secondDetail.surfaces[0].fields[0].value).toBe("Synthetic second choice");
    expect(firstDetail.versionId).not.toBe(secondDetail.versionId);
    expect(firstDetail.line.skuCode).toBe(secondDetail.line.skuCode);
  });

  it("preserves the reviewed version after a rotated source URL resolves to the same ZIP bytes", async () => {
    const fixture = await importedLine();
    const first = await service.process(contextA, fixture.line.id, null);
    await service.review(contextA, fixture.line.id, first.versionId!);
    const rotated = { ...fixture.row, url: `${sourceUrl(fixture.row)}?synthetic-rotation=1` };
    archives.set(sourceUrl(rotated), archives.get(sourceUrl(fixture.row))!);
    const batch = await service.importReport(contextA, input([rotated]));
    expect(batch).toMatchObject({ duplicateOrderCount: 1, failedOrderCount: 0 });
    const updated = await service.process(contextA, fixture.line.id, first.versionId!);
    expect(updated.versionId).toBe(first.versionId);
    expect(updated.line).toMatchObject({ state: "ready", versionNumber: 1, reviewed: true });
    const versions = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, fixture.line.id)));
    expect(versions).toHaveLength(1);
  });

  it("hides old customer images and text while a changed report source awaits processing", async () => {
    const fixture = await importedLine();
    const first = await service.process(contextA, fixture.line.id, null);
    await service.review(contextA, fixture.line.id, first.versionId!);
    const changed = { ...fixture.row, url: `${sourceUrl(fixture.row)}?synthetic-change=1` };
    await service.importReport(contextA, input([changed]));
    const pending = await service.detail(contextA, fixture.line.id);
    expect(pending.line).toMatchObject({ state: "pending", hasPreview: false, reviewed: false, lastErrorCode: "source_changed" });
    expect(pending.surfaces).toEqual([]);
    expect(pending.files).toEqual([]);
    await expect(service.file(contextA, fixture.line.id, first.surfaces[0].previewFileKey!, first.versionId!)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("never regresses an API-synchronized provider status when an older manual report returns", async () => {
    const fixture = await importedLine();
    const current = await orderService.get(contextA, fixture.line.orderId);
    await orderService.ingestNormalized(contextA, { accountId: accountA, platform: "amazon", externalEventId: `synthetic-api-${createEntityId()}`, externalOrderId: fixture.row.orderId, providerStatus: "Shipped", placedAt: current.placedAt, orderTotal: current.orderTotal, lines: current.lines.map((line) => ({ externalLineId: line.externalLineId, externalListingId: line.externalListingId, skuCode: line.skuCode, title: line.title, quantity: line.quantity, unitPrice: line.unitPrice, customizationCount: line.customizationCount })), redactedSource: { source: "synthetic_api" }, protectedDetails: null });
    const changed = { ...fixture.row, url: `${sourceUrl(fixture.row)}?new-synthetic-link=1` };
    await service.importReport(contextA, input([changed]));
    expect((await orderService.get(contextA, fixture.line.orderId)).providerStatus).toBe("Shipped");
  });

  it("creates an immutable new version for changed ZIP content and requires it to be reviewed again", async () => {
    const fixture = await importedLine();
    const first = await service.process(contextA, fixture.line.id, null);
    await service.review(contextA, fixture.line.id, first.versionId!);
    const changed = await service.process(contextA, fixture.line.id, first.versionId!, await customZip(fixture.row, "Synthetic changed choice"));
    expect(changed.versionId).not.toBe(first.versionId);
    expect(changed.line).toMatchObject({ versionNumber: 2, reviewed: false });
    expect(changed.surfaces[0].fields[0].value).toBe("Synthetic changed choice");
    await expect(service.review(contextA, fixture.line.id, first.versionId!)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.process(contextA, fixture.line.id, first.versionId!)).rejects.toBeInstanceOf(ConflictException);
    const stored = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, fixture.line.id)));
    expect(stored).toHaveLength(2);
    const previous = stored.find((version) => version.id === first.versionId)!;
    expect(vault.withSecret(previous.encryptedDocument!, (value) => value)).toContain("Synthetic buyer choice");
  });

  it("creates a new immutable interpretation for a legacy parser revision even when ZIP bytes are unchanged", async () => {
    const fixture = await importedLine();
    const encrypt = vault.encrypt.bind(vault);
    // Create a legacy fixture through the normal insert path, never by rewriting an immutable version.
    const oldWriter = vi.spyOn(vault, "encrypt").mockImplementation((plaintext: string) => {
      try {
        const value = JSON.parse(plaintext) as Record<string, unknown>;
        if (value.document && value.files && value.parserRevision !== undefined) {
          delete value.parserRevision;
          return encrypt(JSON.stringify(value));
        }
      } catch { /* The second envelope contains base64 ZIP data, not JSON. */ }
      return encrypt(plaintext);
    });
    let first;
    try { first = await service.process(contextA, fixture.line.id, null); }
    finally { oldWriter.mockRestore(); }
    await service.review(contextA, fixture.line.id, first.versionId!);
    const updated = await service.process(contextA, fixture.line.id, first.versionId!);
    expect(updated.versionId).not.toBe(first.versionId);
    expect(updated.line).toMatchObject({ versionNumber: 2, reviewed: false });
    const versions = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, fixture.line.id)));
    expect(versions).toHaveLength(2);
    const oldVersion = versions.find((version) => version.id === first.versionId)!;
    const newVersion = versions.find((version) => version.id === updated.versionId)!;
    expect(oldVersion.checksum).toBe(newVersion.checksum);
    expect(vault.withSecret(oldVersion.encryptedDocument!, (value) => JSON.parse(value).parserRevision)).toBeUndefined();
    expect(vault.withSecret(newVersion.encryptedDocument!, (value) => JSON.parse(value).parserRevision)).toBe(AMAZON_CUSTOM_PARSER_REVISION);
  });

  it("retains encrypted reports, customer inputs and source archives without exposing file bytes in detail JSON", async () => {
    const fixture = await importedLine();
    const detail = await service.process(contextA, fixture.line.id, null);
    const stored = await withTenant(database.db, contextA, async (tx) => ({
      batch: (await tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, fixture.batch.id)))[0],
      line: (await tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.line.id)))[0],
      version: (await tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, detail.versionId!)))[0],
    }));
    expect(JSON.stringify(stored)).not.toContain("Synthetic buyer choice");
    expect(JSON.stringify(stored)).not.toContain("Synthetic Private Address");
    expect(JSON.stringify(stored)).not.toContain("zme-caps");
    expect(stored.version.encryptedArchive).toBeTruthy();
    expect(JSON.stringify(detail)).not.toContain("contentBase64");
    const previewKey = detail.surfaces[0].previewFileKey!;
    expect(await service.file(contextA, fixture.line.id, previewKey)).toMatchObject({ mediaType: "image/png", inline: true });
    const svg = detail.files.find((file) => file.name === "layout.svg")!;
    expect(await service.file(contextA, fixture.line.id, svg.key)).toMatchObject({ mediaType: "image/svg+xml", inline: false });
    const accesses = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProtectedAccessEvents).where(eq(orderProtectedAccessEvents.orderId, fixture.line.orderId)));
    expect(accesses.length).toBeGreaterThanOrEqual(3);
  });

  it("reads small encrypted summaries and thumbnails without decrypting or changing the source document", async () => {
    const fixture = await importedLine();
    const detail = await service.process(contextA, fixture.line.id, null, await customZip(fixture.row, "Synthetic buyer choice", {}, true, { width: 1200, height: 900 }));
    const key = detail.surfaces[0].previewFileKey!;
    const [before] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, detail.versionId!)));
    const original = await service.file(contextA, fixture.line.id, key, detail.versionId!);
    const decrypt = vi.spyOn(vault, "withSecret");
    try {
      const reviews = await service.reviewDetails(contextA, [fixture.line.id]);
      expect(reviews[0]).toEqual(detail);
      expect(JSON.stringify(reviews)).not.toContain("contentBase64");
      const thumbnail = await service.file(contextA, fixture.line.id, key, detail.versionId!, true);
      expect(await sharp(thumbnail.body).metadata()).toMatchObject({ width: 320, height: 240, format: "png" });
      expect(thumbnail.body.byteLength).toBeLessThan(original.body.byteLength);
      expect(decrypt.mock.calls.map(call => call[0])).not.toContain(before.encryptedDocument);
      expect(decrypt.mock.calls.map(call => call[0])).not.toContain(before.encryptedArchive);
    } finally { decrypt.mockRestore(); }
    const [after] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, detail.versionId!)));
    expect(after).toEqual(before);
    expect((await service.file(contextA, fixture.line.id, key, detail.versionId!)).body).toEqual(original.body);
    const [projection] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportReadModels).where(eq(amazonOrderReportReadModels.versionId, detail.versionId!)));
    expect(projection.encryptedMetadata).toBeTruthy();
    expect(projection.encryptedThumbnails).toBeTruthy();
    expect(JSON.stringify(projection)).not.toContain("Synthetic buyer choice");
    expect(JSON.stringify(projection)).not.toContain("contentBase64");
  });

  it("backfills an existing immutable version once and keeps its evidence unchanged", async () => {
    const fixture = await importedLine();
    const detail = await service.process(contextA, fixture.line.id, null);
    // Insert a pre-migration version with no derived row; never rewrite an immutable payload.
    const legacyId = createEntityId();
    const legacy = await withTenant(database.db, contextA, async (tx) => {
      const [source] = await tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, detail.versionId!));
      const [version] = await tx.insert(amazonOrderReportVersions).values({ ...source, id: legacyId, versionNumber: 2 }).returning();
      await tx.update(amazonOrderReportLines).set({ currentVersionId: legacyId, versionNumber: 2 }).where(eq(amazonOrderReportLines.id, fixture.line.id));
      return version;
    });
    const decrypt = vi.spyOn(vault, "withSecret");
    try {
      const first = await service.detail(contextA, fixture.line.id);
      expect(first.versionId).toBe(legacyId);
      expect(first.surfaces).toEqual(detail.surfaces);
      expect(decrypt.mock.calls.filter(call => call[0] === legacy.encryptedDocument)).toHaveLength(1);
      decrypt.mockClear();
      expect(await service.detail(contextA, fixture.line.id)).toEqual(first);
      await service.file(contextA, fixture.line.id, first.surfaces[0].previewFileKey!, legacyId, true);
      expect(decrypt.mock.calls.map(call => call[0])).not.toContain(legacy.encryptedDocument);
    } finally { decrypt.mockRestore(); }
    const stored = await withTenant(database.db, contextA, async (tx) => ({
      versions: await tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, legacyId)),
      projections: await tx.select().from(amazonOrderReportReadModels).where(eq(amazonOrderReportReadModels.versionId, legacyId)),
    }));
    expect(stored.versions).toEqual([legacy]);
    expect(stored.projections).toHaveLength(1);
  });

  it("rejects a stale version pinned file request after a newer ZIP is accepted", async () => {
    const fixture = await importedLine();
    const first = await service.process(contextA, fixture.line.id, null);
    const latest = await service.process(contextA, fixture.line.id, first.versionId!, await customZip(fixture.row, "Synthetic replacement"));
    expect(latest.versionId).not.toBe(first.versionId);
    await expect(service.file(contextA, fixture.line.id, first.surfaces[0].previewFileKey!, first.versionId!)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.file(contextA, fixture.line.id, first.surfaces[0].previewFileKey!, first.versionId!, true)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.file(contextA, fixture.line.id, latest.surfaces[0].previewFileKey!, latest.versionId!)).resolves.toMatchObject({ mediaType: "image/png", inline: true });
  });

  it("erases report attachments and denies file access when the underlying order is anonymized", async () => {
    const fixture = await importedLine();
    const detail = await service.process(contextA, fixture.line.id, null);
    const core = await orderService.get(contextA, fixture.line.orderId);
    // Existing order PII may have an earlier retention deadline than imported attachments.
    await withTenant(database.db, contextA, (tx) => tx.update(orderProtectedDetails).set({ retentionExpiresAt: new Date(Date.now() - 1_000) }).where(eq(orderProtectedDetails.orderId, fixture.line.orderId)));
    const [protectedData] = await withTenant(database.db, contextA, (tx) => tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, fixture.line.orderId)));
    await orderService.anonymizeProtectedDetails({ ...contextA, permissions: [...contextA.permissions, "order:pii:anonymize"] }, fixture.line.orderId, {
      expectedSequence: core.latestEventSequence, expectedEnvelopeVersion: protectedData.envelopeVersion,
      idempotencyKey: `synthetic-erasure-${createEntityId()}`, reason: "Synthetic erasure request",
    });
    await expect(service.file(contextA, fixture.line.id, detail.surfaces[0].previewFileKey!, detail.versionId!)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.file(contextA, fixture.line.id, detail.surfaces[0].previewFileKey!, detail.versionId!, true)).rejects.toBeInstanceOf(NotFoundException);
    const erased = await service.detail(contextA, fixture.line.id);
    expect(erased.line).toMatchObject({ state: "expired", hasPreview: false });
    expect(erased.files).toEqual([]); expect(erased.surfaces).toEqual([]);
    const [version] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, detail.versionId!)));
    expect(version.encryptedArchive).toBeNull(); expect(version.encryptedDocument).toBeNull();
    const [projection] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportReadModels).where(eq(amazonOrderReportReadModels.versionId, detail.versionId!)));
    expect(projection).toMatchObject({ encryptedMetadata: null, encryptedThumbnails: null });
    await expect(service.process(contextA, fixture.line.id, detail.versionId!)).rejects.toBeInstanceOf(ConflictException);
  });

  it("preserves useful text while reporting an absent Amazon preview", async () => {
    const fixture = await importedLine();
    const result = await service.process(contextA, fixture.line.id, null, await customZip(fixture.row, "Synthetic text-only preview", {}, false));
    expect(result.line).toMatchObject({ state: "partial", hasPreview: false });
    expect(result.surfaces[0].previewFileKey).toBeNull();
    expect(result.surfaces[0].fields[0].value).toBe("Synthetic text-only preview");
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it("rejects mismatched ZIP identity while leaving the imported order available for retry", async () => {
    const fixture = await importedLine();
    const failed = await service.process(contextA, fixture.line.id, null, await customZip(fixture.row, "Synthetic secret", { orderItemId: "SYNTHETIC-WRONG-LINE" }));
    expect(failed.line).toMatchObject({ state: "failed", lastErrorCode: "archive_invalid", versionNumber: 0 });
    expect(failed.files).toEqual([]);
    const corrected = await service.process(contextA, fixture.line.id, null);
    expect(corrected.line.state).toBe("ready");
  });

  it.each([
    ["infected", "synthetic-signature-1", "file_rejected"], ["failed", "unavailable", "scan_unavailable"], ["clean", "unavailable", "scan_unavailable"],
  ] as const)("does not parse or retain a ZIP when scanning yields %s/%s", async (result, signatureVersion, code) => {
    const fixture = await importedLine();
    const unsafeGateway: AmazonReportArchiveGateway = { download: gateway.download, scan: vi.fn(async () => ({ ...cleanScan(), result, signatureVersion })) };
    const checked = new AmazonOrderReportService(database, vault, orderService, audit, unsafeGateway, retention, processing);
    const failed = await checked.process(contextA, fixture.line.id, null);
    expect(failed.line).toMatchObject({ state: "failed", lastErrorCode: code, versionNumber: 0 });
    expect(failed.files).toEqual([]);
    expect(await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, fixture.line.id)))).toEqual([]);
  });

  it("enforces tenant boundaries for workspace, detail, file, review, processing and account import", async () => {
    const fixture = await importedLine();
    const detail = await service.process(contextA, fixture.line.id, null);
    expect((await service.workspace(contextB)).lines).toEqual([]);
    await expect(service.workspace(contextB, { accountId: accountA })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.workspace(contextB, { batchId: fixture.batch.id })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.detail(contextB, fixture.line.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.file(contextB, fixture.line.id, detail.surfaces[0].previewFileKey!)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.file(contextB, fixture.line.id, detail.surfaces[0].previewFileKey!, detail.versionId!, true)).rejects.toBeInstanceOf(NotFoundException);
    expect(await withTenant(database.db, contextB, (tx) => tx.select().from(amazonOrderReportReadModels).where(eq(amazonOrderReportReadModels.versionId, detail.versionId!)))).toEqual([]);
    await expect(service.review(contextB, fixture.line.id, detail.versionId!)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.process(contextB, fixture.line.id, detail.versionId!)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.importReport(contextB, input([sourceRow()], accountA))).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.importReport(contextA, { ...input([sourceRow()]), marketplaceId: "WRONG-SYNTHETIC-MARKETPLACE" })).rejects.toBeInstanceOf(UnprocessableEntityException);
    const protectedRows = await withTenant(database.db, contextB, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, detail.versionId!)));
    expect(protectedRows).toEqual([]);
  });

  it("requires PII permission for private details and every modifying action", async () => {
    const fixture = await importedLine();
    const detail = await service.process(contextA, fixture.line.id, null);
    const restricted = { ...contextA, permissions: ["order:read", "order:write"] };
    await expect(service.detail(restricted, fixture.line.id)).rejects.toThrow();
    await expect(service.file(restricted, fixture.line.id, detail.surfaces[0].previewFileKey!, detail.versionId!, true)).rejects.toThrow();
    await expect(service.process(restricted, fixture.line.id, null)).rejects.toThrow();
    await expect(service.importReport(restricted, input([sourceRow()]))).rejects.toThrow();
    const publicWorkspace = await service.workspace(restricted);
    expect(JSON.stringify(publicWorkspace)).not.toContain("Synthetic Private Address");
    expect(JSON.stringify(publicWorkspace)).not.toContain("Synthetic buyer choice");
  });

  it("claims an order line only once while an archive download is in flight", async () => {
    const fixture = await importedLine();
    const entered = deferred(), release = deferred();
    const delayed: AmazonReportArchiveGateway = { download: vi.fn(async () => { entered.resolve(); await release.promise; return archives.get(sourceUrl(fixture.row))!; }), scan: gateway.scan };
    const concurrent = new AmazonOrderReportService(database, vault, orderService, audit, delayed, retention, processing);
    const first = concurrent.process(contextA, fixture.line.id, null);
    await entered.promise;
    try {
      await expect(concurrent.process(contextA, fixture.line.id, null)).rejects.toBeInstanceOf(ConflictException);
      expect(delayed.download).toHaveBeenCalledTimes(1);
    } finally { release.resolve(); }
    const completed = await first;
    expect(completed.line).toMatchObject({ state: "ready", versionNumber: 1 });
    expect(await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, fixture.line.id)))).toHaveLength(1);
  });

  it("does not retain report PII or create orders when retention scheduling fails", async () => {
    const row = sourceRow();
    const failedSchedule: AmazonReportRetentionEnqueuer = { schedule: vi.fn(async () => { throw new Error("Synthetic queue unavailable"); }) };
    const guarded = new AmazonOrderReportService(database, vault, orderService, audit, gateway, failedSchedule, processing);
    const fileName = `synthetic-queue-failed-${createEntityId()}.txt`;
    await expect(guarded.importReport(contextA, { ...input([row]), fileName })).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(failedSchedule.schedule).toHaveBeenCalledOnce();
    const stored = await withTenant(database.db, contextA, async (tx) => ({
      batches: await tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.fileName, fileName)),
      orders: await tx.select().from(orders).where(eq(orders.externalOrderId, row.orderId)),
    }));
    expect(stored.batches).toHaveLength(1);
    expect(stored.batches[0]).toMatchObject({ status: "failed", encryptedReport: null });
    expect(stored.orders).toEqual([]);
    expect(await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.batchId, stored.batches[0].id)))).toEqual([]);
  });

  it("rejects reimport of expired report attachments even when an existing API order retains its own protected details", async () => {
    const row = sourceRow();
    const existing = await orderService.ingestNormalized(contextA, {
      accountId: accountA, platform: "amazon", externalEventId: `synthetic-api-first-${createEntityId()}`,
      externalOrderId: row.orderId, providerStatus: "Unshipped", placedAt: "2026-09-01T12:00:00.000Z",
      orderTotal: { amountMinor: 2999, currency: "USD" },
      lines: [{ externalLineId: row.lineId, externalListingId: null, skuCode: "SYNTHETIC-SAME-SKU", title: "Synthetic custom product", quantity: 1, unitPrice: { amountMinor: 2999, currency: "USD" }, customizationCount: 1 }],
      redactedSource: { source: "synthetic_api" },
      protectedDetails: {
        buyer: { name: "Synthetic API Buyer", email: null, phone: null },
        shippingAddress: { recipient: "Synthetic API Recipient", lines: ["Synthetic API Address"], city: "Synthetic City", region: "CA", postalCode: "00000", countryCode: "US" },
        customizations: [],
      },
    });
    const fixture = await importedLine(row);
    expect(fixture.line.orderId).toBe(existing.id);
    await service.process(contextA, fixture.line.id, null);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
    try {
      expect((await service.detail(contextA, fixture.line.id)).line.state).toBe("expired");
      expect((await orderService.get(contextA, existing.id)).address.status).toBe("protected");
      const fileName = `synthetic-expired-api-reimport-${createEntityId()}.txt`;
      await expect(service.importReport(contextA, { ...input([row]), fileName })).rejects.toBeInstanceOf(ConflictException);
      expect(await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.fileName, fileName)))).toEqual([]);
      const [source] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.line.id)));
      expect(source.encryptedSource).toBeNull();
    } finally { vi.useRealTimers(); }
  });

  it("expires private files and blocks reading, reacquiring or reviewing them after retention", async () => {
    const fixture = await importedLine();
    const detail = await service.process(contextA, fixture.line.id, null);
    // Advance the application clock instead of modifying immutable version identities.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 31 * 86_400_000));
    try {
    const expired = await service.detail(contextA, fixture.line.id);
    expect(expired.line).toMatchObject({ state: "expired", hasPreview: false });
    expect(expired.files).toEqual([]); expect(expired.surfaces).toEqual([]);
    await expect(service.file(contextA, fixture.line.id, detail.surfaces[0].previewFileKey!)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.file(contextA, fixture.line.id, detail.surfaces[0].previewFileKey!, detail.versionId!, true)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.process(contextA, fixture.line.id, detail.versionId!)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.review(contextA, fixture.line.id, detail.versionId!)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.importReport(contextA, input([fixture.row]))).rejects.toBeInstanceOf(ConflictException);
    expect((await service.detail(contextA, fixture.line.id)).line.state).toBe("expired");
    const stored = await withTenant(database.db, contextA, async (tx) => ({
      batch: (await tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, fixture.batch.id)))[0],
      line: (await tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, fixture.line.id)))[0],
      version: (await tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, detail.versionId!)))[0],
      details: (await tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, fixture.line.orderId)))[0],
    }));
    expect(stored.batch.encryptedReport).toBeNull(); expect(stored.line.encryptedSource).toBeNull();
    expect(stored.version.encryptedDocument).toBeNull(); expect(stored.version.encryptedArchive).toBeNull();
    const [projection] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportReadModels).where(eq(amazonOrderReportReadModels.versionId, detail.versionId!)));
    expect(projection).toMatchObject({ encryptedMetadata: null, encryptedThumbnails: null });
    expect(stored.details.encryptedEnvelope).toBeNull();
    expect((await orderService.get(contextA, fixture.line.orderId)).address.status).toBe("anonymized");
    } finally { vi.useRealTimers(); }
  });
});
