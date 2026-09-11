import { SecretVault } from "@yummyai/ai-core";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import { createEntityId, type AmazonReportImportInput, type AmazonReportLineView, type RecordCustomizationFileScanInput, type TenantContext } from "@yummyai/contracts";
import {
  amazonOrderReportBatches, amazonOrderReportLines, amazonOrderReportVersions,
  connectDatabase, marketplaceAccounts, migrateDatabase, orderLines, orderProtectedAccessEvents,
  orderProtectedDetails, orders, withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { AMAZON_CUSTOM_PARSER_REVISION } from "./amazon-custom-archive.js";
import type { AmazonReportArchiveGateway } from "./amazon-report-archive.gateway.js";
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
async function customZip(row: SourceRow, value = "Synthetic buyer choice", overrides: Record<string, unknown> = {}, withPreview = true) {
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
  const picture = await sharp({ create: { width: 16, height: 12, channels: 3, background: "blue" } }).jpeg().toBuffer();
  zip.file("buyer.jpg", picture, { date: fixedDate });
  if (withPreview) zip.file("preview.jpg", picture, { date: fixedDate });
  zip.file("layout.svg", '<svg xmlns="http://www.w3.org/2000/svg"><script>synthetic()</script></svg>', { date: fixedDate });
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

describe("manual Amazon order reports and private customization files", () => {
  const database = connectDatabase();
  const tenantA = createEntityId(), tenantB = createEntityId(), userA = createEntityId(), userB = createEntityId(), accountA = createEntityId(), accountB = createEntityId();
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
  const retention: AmazonReportRetentionEnqueuer = { schedule: vi.fn(async () => undefined) };
  const service = new AmazonOrderReportService(database, vault, orderService, audit, gateway, retention);
  const input = (rows: SourceRow[], accountId = accountA): AmazonReportImportInput => ({ accountId, marketplaceId, fileName: "synthetic-report.txt", content: tsv(rows) });
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
    await withTenant(database.db, contextA, (tx) => tx.insert(marketplaceAccounts).values({ id: accountA, tenantId: tenantA, platform: "amazon", displayName: "Synthetic Shop A", region: "NA", authorizationMode: "amazon_private", marketplaceIds: [marketplaceId], createdBy: userA }));
    await withTenant(database.db, contextB, (tx) => tx.insert(marketplaceAccounts).values({ id: accountB, tenantId: tenantB, platform: "amazon", displayName: "Synthetic Shop B", region: "NA", authorizationMode: "amazon_private", marketplaceIds: [marketplaceId], createdBy: userB }));
  }, 60_000);
  afterAll(async () => { await database.client.end(); });

  it("imports custom and ordinary items together and preserves report line totals", async () => {
    const custom = { ...sourceRow(), quantity: 3 }, ordinary = { ...sourceRow(false), orderId: custom.orderId };
    const { batch, lines } = await importRows([custom, ordinary]);
    expect(batch).toMatchObject({ rowCount: 2, orderCount: 1, newOrderCount: 1, duplicateOrderCount: 0, failedOrderCount: 0 });
    expect(lineBySource(lines, custom)).toMatchObject({ state: "pending", quantity: 3, itemTotalMinor: 2999, reviewed: false, hasPreview: false });
    expect(lineBySource(lines, ordinary)).toMatchObject({ state: "none", versionNumber: 0, hasPreview: false });
    const core = await orderService.get(contextA, lines[0].orderId);
    expect(core.lines).toHaveLength(2);
    expect(core.orderTotal.amountMinor).toBe(5998);
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

  it("rejects a stale version pinned file request after a newer ZIP is accepted", async () => {
    const fixture = await importedLine();
    const first = await service.process(contextA, fixture.line.id, null);
    const latest = await service.process(contextA, fixture.line.id, first.versionId!, await customZip(fixture.row, "Synthetic replacement"));
    expect(latest.versionId).not.toBe(first.versionId);
    await expect(service.file(contextA, fixture.line.id, first.surfaces[0].previewFileKey!, first.versionId!)).rejects.toBeInstanceOf(ConflictException);
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
    const erased = await service.detail(contextA, fixture.line.id);
    expect(erased.line).toMatchObject({ state: "expired", hasPreview: false });
    expect(erased.files).toEqual([]); expect(erased.surfaces).toEqual([]);
    const [version] = await withTenant(database.db, contextA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, detail.versionId!)));
    expect(version.encryptedArchive).toBeNull(); expect(version.encryptedDocument).toBeNull();
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
    const checked = new AmazonOrderReportService(database, vault, orderService, audit, unsafeGateway, retention);
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
    await expect(service.review(contextB, fixture.line.id, detail.versionId!)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.process(contextB, fixture.line.id, detail.versionId!)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.importReport(contextB, input([sourceRow()], accountA))).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.importReport(contextA, { ...input([sourceRow()]), marketplaceId: "WRONG-SYNTHETIC-MARKETPLACE" })).rejects.toBeInstanceOf(UnprocessableEntityException);
    const protectedRows = await withTenant(database.db, contextB, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, detail.versionId!)));
    expect(protectedRows).toEqual([]);
  });

  it("requires PII permission for private details and every modifying action", async () => {
    const fixture = await importedLine();
    const restricted = { ...contextA, permissions: ["order:read", "order:write"] };
    await expect(service.detail(restricted, fixture.line.id)).rejects.toThrow();
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
    const concurrent = new AmazonOrderReportService(database, vault, orderService, audit, delayed, retention);
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
    const guarded = new AmazonOrderReportService(database, vault, orderService, audit, gateway, failedSchedule);
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
    expect(stored.details.encryptedEnvelope).toBeNull();
    expect((await orderService.get(contextA, fixture.line.orderId)).address.status).toBe("anonymized");
    } finally { vi.useRealTimers(); }
  });
});
