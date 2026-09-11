import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  amazonOrderReportBatches, amazonOrderReportBatchItems, amazonOrderReportLines, amazonOrderReportVersions,
  connectDatabase, marketplaceAccounts, migrateDatabase, orderLines, orders, orderProtectedDetails, orderSourceSnapshots, purgeExpiredAmazonOrderReports, withTenant,
} from "./index.js";

function context(): TenantContext {
  return { tenantId: createEntityId(), userId: createEntityId(), permissions: ["orders:read", "orders:write"], dataScope: "tenant" };
}

describe("Amazon report persistence guards", () => {
  const database = connectDatabase();
  const tenantA = context();
  const tenantB = context();
  const accountId = createEntityId();
  const batchId = createEntityId();
  const orderIds = [createEntityId(), createEntityId()];
  const lineIds = [createEntityId(), createEntityId()];
  const reportLineIds = [createEntityId(), createEntityId()];
  const versionId = createEntityId();
  const otherBatchId = createEntityId();
  const expiresAt = new Date(Date.now() + 86400_000);

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [
      tenantA.tenantId, "Report test A", `report-a-${tenantA.tenantId}`, tenantB.tenantId, "Report test B", `report-b-${tenantB.tenantId}`,
    ]);
    await withTenant(database.db, tenantA, async (tx) => {
      await tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: tenantA.tenantId, platform: "amazon", displayName: "Reports", region: "NA", authorizationMode: "amazon_private" });
      await tx.insert(amazonOrderReportBatches).values({ id: batchId, tenantId: tenantA.tenantId, accountId, marketplaceId: "ATVPDKIKX0DER", fileName: "fixture.txt", reportChecksum: "a".repeat(64), encryptedReport: "fixture-report", rowCount: 2, orderCount: 2, expiresAt });
      for (let index = 0; index < 2; index += 1) {
        const orderId = orderIds[index];
        const orderLineId = lineIds[index];
        const reportLineId = reportLineIds[index];
        const sourceId = createEntityId();
        await tx.insert(orderSourceSnapshots).values({ id: sourceId, tenantId: tenantA.tenantId, accountId, platform: "amazon", externalEventId: `fixture-${index}`, externalOrderId: `fixture-${index}`, normalizedOrderId: orderId, redactedPayload: {}, payloadChecksum: "a".repeat(64) });
        await tx.insert(orders).values({ id: orderId, tenantId: tenantA.tenantId, accountId, sourceSnapshotId: sourceId, platform: "amazon", externalOrderId: `fixture-${index}`, providerStatus: "not_provided", orderTotalMinor: 1000, orderCurrency: "USD", lineCount: 1, placedAt: new Date() });
        await tx.insert(orderLines).values({ id: orderLineId, tenantId: tenantA.tenantId, orderId, externalLineId: `line-${index}`, title: "Fixture product", quantity: 3, unitPriceMinor: 333, unitPriceCurrency: "USD" });
        await tx.insert(amazonOrderReportLines).values({ id: reportLineId, tenantId: tenantA.tenantId, orderId, orderLineId, batchId, sourceChecksum: "a".repeat(64), encryptedSource: "fixture-source", itemTotalMinor: 1000, currency: "USD", expiresAt });
      }
      await tx.insert(amazonOrderReportBatchItems).values({ id: createEntityId(), tenantId: tenantA.tenantId, batchId, orderId: orderIds[0], externalOrderId: "fixture-0", status: "imported" });
      await tx.insert(amazonOrderReportVersions).values({ id: versionId, tenantId: tenantA.tenantId, reportLineId: reportLineIds[0], versionNumber: 1, checksum: "b".repeat(64), encryptedDocument: "fixture-envelope", encryptedArchive: "fixture-archive", scanEngine: "fixture", scanSignature: "1", expiresAt });
      await tx.update(amazonOrderReportLines).set({ currentVersionId: versionId, versionNumber: 1, state: "ready" }).where(eq(amazonOrderReportLines.id, reportLineIds[0]));
    });
    await withTenant(database.db, tenantB, async (tx) => {
      const otherAccountId = createEntityId();
      await tx.insert(marketplaceAccounts).values({ id: otherAccountId, tenantId: tenantB.tenantId, platform: "amazon", displayName: "Other reports", region: "NA", authorizationMode: "amazon_private" });
      await tx.insert(amazonOrderReportBatches).values({ id: otherBatchId, tenantId: tenantB.tenantId, accountId: otherAccountId, marketplaceId: "ATVPDKIKX0DER", fileName: "other-fixture.txt", reportChecksum: "a".repeat(64), encryptedReport: "other-report", rowCount: 1, orderCount: 1, expiresAt });
    });
  });

  afterAll(async () => database.client.end());

  it("hides every report entity from another tenant under the non-owner role", async () => {
    await withTenant(database.db, tenantB, async (tx) => {
      expect((await tx.select().from(amazonOrderReportBatches)).map((row) => row.id)).toEqual([otherBatchId]);
      expect(await tx.select().from(amazonOrderReportBatchItems)).toEqual([]);
      expect(await tx.select().from(amazonOrderReportLines)).toEqual([]);
      expect(await tx.select().from(amazonOrderReportVersions)).toEqual([]);
      const [role] = await tx.execute(sql`select current_user as name`);
      expect(role.name).toBe("yummyai_app");
    });
    await expect(withTenant(database.db, tenantB, (tx) => tx.insert(amazonOrderReportBatchItems).values({ id: createEntityId(), tenantId: tenantA.tenantId, batchId, externalOrderId: "cross-tenant", status: "failed" }))).rejects.toThrow();
  });

  it("rejects a same-tenant order and order-line mismatch", async () => {
    await expect(withTenant(database.db, tenantA, (tx) => tx.update(amazonOrderReportLines).set({ orderId: orderIds[1] }).where(eq(amazonOrderReportLines.id, reportLineIds[0])))).rejects.toThrow();
  });

  it("rejects current and reviewed versions owned by a different report line", async () => {
    for (const field of ["currentVersionId", "reviewedVersionId"] as const) {
      await expect(withTenant(database.db, tenantA, (tx) => tx.update(amazonOrderReportLines).set({ [field]: versionId }).where(eq(amazonOrderReportLines.id, reportLineIds[1])))).rejects.toThrow();
    }
  });

  it("preserves version evidence and only permits irreversible content erasure", async () => {
    await expect(withTenant(database.db, tenantA, (tx) => tx.update(amazonOrderReportVersions).set({ encryptedDocument: "replacement" }).where(eq(amazonOrderReportVersions.id, versionId)))).rejects.toThrow();
    await expect(withTenant(database.db, tenantA, (tx) => tx.update(amazonOrderReportVersions).set({ checksum: "c".repeat(64) }).where(eq(amazonOrderReportVersions.id, versionId)))).rejects.toThrow();
    await withTenant(database.db, tenantA, (tx) => tx.update(amazonOrderReportVersions).set({ encryptedDocument: null, encryptedArchive: null }).where(eq(amazonOrderReportVersions.id, versionId)));
    await expect(withTenant(database.db, tenantA, (tx) => tx.update(amazonOrderReportVersions).set({ encryptedDocument: "restored" }).where(eq(amazonOrderReportVersions.id, versionId)))).rejects.toThrow();
    const [retained] = await withTenant(database.db, tenantA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, versionId)));
    expect(retained?.checksum).toBe("b".repeat(64));
    expect(retained?.encryptedDocument).toBeNull();
    expect(retained?.encryptedArchive).toBeNull();
  });

  it("purges expired evidence idempotently within one tenant while preserving not-yet-due evidence", async () => {
    await purgeExpiredAmazonOrderReports(database, tenantA, new Date(expiresAt.getTime() - 1));
    const [before] = await withTenant(database.db, tenantA, (tx) => tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, batchId)));
    expect(before?.encryptedReport).toBe("fixture-report");
    await purgeExpiredAmazonOrderReports(database, tenantA, expiresAt);
    await purgeExpiredAmazonOrderReports(database, tenantA, expiresAt);
    const [after] = await withTenant(database.db, tenantA, (tx) => tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, batchId)));
    expect(after?.encryptedReport).toBeNull();
    const lines = await withTenant(database.db, tenantA, (tx) => tx.select().from(amazonOrderReportLines));
    expect(lines).toHaveLength(2);
    expect(lines.every((row) => row.encryptedSource === null && row.state === "expired" && !row.hasPreview)).toBe(true);
    const [other] = await withTenant(database.db, tenantB, (tx) => tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, otherBatchId)));
    expect(other?.encryptedReport).toBe("other-report");
  });

  it("erases later reports and orphaned ciphertext even when the original order source was already cleared", async () => {
    const laterBatchId = createEntityId();
    const orphanVersionId = createEntityId();
    const laterExpiry = new Date(expiresAt.getTime() + 30 * 86400_000);
    await withTenant(database.db, tenantA, async (tx) => {
      await tx.insert(amazonOrderReportBatches).values({ id: laterBatchId, tenantId: tenantA.tenantId, accountId, marketplaceId: "ATVPDKIKX0DER", fileName: "later-fixture.txt", reportChecksum: "d".repeat(64), encryptedReport: "later-report-containing-expired-order", rowCount: 1, orderCount: 1, expiresAt: laterExpiry });
      await tx.insert(amazonOrderReportBatchItems).values({ id: createEntityId(), tenantId: tenantA.tenantId, batchId: laterBatchId, orderId: orderIds[0], externalOrderId: "fixture-0", status: "duplicate" });
      await tx.insert(amazonOrderReportVersions).values({ id: orphanVersionId, tenantId: tenantA.tenantId, reportLineId: reportLineIds[0], versionNumber: 2, checksum: "e".repeat(64), encryptedDocument: "orphan-document", encryptedArchive: "orphan-archive", scanEngine: "fixture", scanSignature: "1", expiresAt: laterExpiry });
    });
    await purgeExpiredAmazonOrderReports(database, tenantA, expiresAt);
    const [batch] = await withTenant(database.db, tenantA, (tx) => tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, laterBatchId)));
    const [version] = await withTenant(database.db, tenantA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, orphanVersionId)));
    expect(batch?.expiresAt).toEqual(laterExpiry);
    expect(batch?.encryptedReport).toBeNull();
    expect(version?.encryptedDocument).toBeNull();
    expect(version?.encryptedArchive).toBeNull();
    const [other] = await withTenant(database.db, tenantB, (tx) => tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, otherBatchId)));
    expect(other?.encryptedReport).toBe("other-report");
  });

  it("clears later-expiring sibling lines in the same run that anonymizes their parent order", async () => {
    const siblingLineId = createEntityId();
    const siblingReportLineId = createEntityId();
    const siblingVersionId = createEntityId();
    const laterBatchId = createEntityId();
    const laterExpiry = new Date(expiresAt.getTime() + 30 * 86400_000);
    await withTenant(database.db, tenantA, async (tx) => {
      await tx.insert(orderProtectedDetails).values({ id: createEntityId(), tenantId: tenantA.tenantId, orderId: orderIds[1], encryptedEnvelope: "expired-order-pii", retentionExpiresAt: expiresAt });
      await tx.update(orders).set({ addressStatus: "protected", lineCount: 2 }).where(eq(orders.id, orderIds[1]));
      await tx.insert(orderLines).values({ id: siblingLineId, tenantId: tenantA.tenantId, orderId: orderIds[1], externalLineId: "later-sibling", title: "Later fixture line", quantity: 1, unitPriceMinor: 1000, unitPriceCurrency: "USD" });
      await tx.insert(amazonOrderReportBatches).values({ id: laterBatchId, tenantId: tenantA.tenantId, accountId, marketplaceId: "ATVPDKIKX0DER", fileName: "sibling-fixture.txt", reportChecksum: "f".repeat(64), encryptedReport: "later-sibling-report", rowCount: 1, orderCount: 1, expiresAt: laterExpiry });
      await tx.insert(amazonOrderReportBatchItems).values({ id: createEntityId(), tenantId: tenantA.tenantId, batchId: laterBatchId, orderId: orderIds[1], externalOrderId: "fixture-1", status: "duplicate" });
      await tx.insert(amazonOrderReportLines).values({ id: siblingReportLineId, tenantId: tenantA.tenantId, orderId: orderIds[1], orderLineId: siblingLineId, batchId: laterBatchId, sourceChecksum: "f".repeat(64), encryptedSource: "later-sibling-source", itemTotalMinor: 1000, currency: "USD", expiresAt: laterExpiry });
      await tx.insert(amazonOrderReportVersions).values({ id: siblingVersionId, tenantId: tenantA.tenantId, reportLineId: siblingReportLineId, versionNumber: 1, checksum: "f".repeat(64), encryptedDocument: "later-sibling-document", encryptedArchive: "later-sibling-archive", scanEngine: "fixture", scanSignature: "1", expiresAt: laterExpiry });
      await tx.update(amazonOrderReportLines).set({ currentVersionId: siblingVersionId, versionNumber: 1, state: "ready", hasPreview: true }).where(eq(amazonOrderReportLines.id, siblingReportLineId));
    });
    await purgeExpiredAmazonOrderReports(database, tenantA, expiresAt);
    const [parent] = await withTenant(database.db, tenantA, (tx) => tx.select().from(orders).where(eq(orders.id, orderIds[1])));
    const [line] = await withTenant(database.db, tenantA, (tx) => tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, siblingReportLineId)));
    const [version] = await withTenant(database.db, tenantA, (tx) => tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.id, siblingVersionId)));
    const [batch] = await withTenant(database.db, tenantA, (tx) => tx.select().from(amazonOrderReportBatches).where(eq(amazonOrderReportBatches.id, laterBatchId)));
    expect(parent?.addressStatus).toBe("anonymized");
    expect(line).toMatchObject({ encryptedSource: null, state: "expired", hasPreview: false });
    expect(version).toMatchObject({ encryptedDocument: null, encryptedArchive: null });
    expect(batch?.encryptedReport).toBeNull();
  });
});
