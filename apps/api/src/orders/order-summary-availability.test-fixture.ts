import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import {
  amazonOrderReportLines, amazonOrderReportVersions, connectDatabase,
  loadCurrentMembershipContext, marketplaceAccounts, membershipRoles, memberships, orderEvents, orderLines,
  orderProtectedDetails, orderSourceSnapshots, orderWorkEvents, orderWorkItems,
  orderWorkRevisions, orders as orderRows, purgeExpiredAmazonOrderReports, roles,
  withTenant, type DatabaseConnection,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { and, eq, sql } from "drizzle-orm";
import JSZip from "jszip";
import sharp from "sharp";
import { z } from "zod";
import { requireOrderSummaryEnvironment } from "../../../../tools/testing/require-order-summary-availability-environment.mjs";
import { AuditService } from "../audit/audit.service.js";
import { ProductionEditorService } from "../design/production-editor.service.js";
import { MarketplaceAccountService } from "../marketplaces/marketplace-account.service.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { createOrderPiiVault } from "./order-pii-vault.js";
import { OrderService } from "./order.service.js";
import { OrderWorkspaceService } from "./order-workspace.service.js";

export type OrderSummaryCaseKind = "healthy_saved" | "healthy_no_work" | "anonymized" | "expired" | "purged" | "archived";
export type OrderSummaryCase = {
  kind: OrderSummaryCaseKind;
  tenantId: string;
  accountId: string;
  orderId: string;
  lineId: string;
  reportLineId: string | null;
  reportVersionId: string | null;
  externalOrderId: string;
  externalLineId: string;
  revision: number;
  projectionVersion: number;
  /** Synthetic plaintext stays inside the test/seed process, never IPC/proof. */
  fixtureSentinel: string;
};
export const orderSummaryFixtureSentinel = (externalOrderId: string) => `synthetic-private-${externalOrderId}`;
export const OrderSummaryCasePinsSchema = z.object({
  kind: z.enum(["healthy_saved", "healthy_no_work", "anonymized", "expired", "purged", "archived"]),
  accountId: z.uuidv7(), orderId: z.uuidv7(), lineId: z.uuidv7(), reportLineId: z.uuidv7().nullable(), reportVersionId: z.uuidv7().nullable(),
  externalOrderId: z.string().min(1).max(500), externalLineId: z.string().min(1).max(300), revision: z.int().nonnegative(), projectionVersion: z.int().nonnegative(),
}).strict();
export type OrderSummaryCasePins = z.infer<typeof OrderSummaryCasePinsSchema>;

const summaryPermissions = [Permission.OrderRead, Permission.OrderWrite, Permission.OrderPiiRead,
  Permission.OrderPiiAnonymize, Permission.StoreRead, Permission.StoreManage] as const;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function latch() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

/** No connection at module scope. Source acquisition/scanning is the explicit
 * synthetic boundary; parsing, encryption, lifecycle owners and RLS are real.
 * These tiny report images are not production artwork or manufacturing proof. */
export async function createOrderSummaryFixture(options: { database?: DatabaseConnection; context?: TenantContext } = {}) {
  const isolated = requireOrderSummaryEnvironment(process.env, process.env.E2E_COMPILED_WEB === "1");
  const database = options.database ?? connectDatabase(isolated.url);
  const groupKey = `SYNTHETIC-SUMMARY-${isolated.nonce}-${createEntityId()}`;
  const owned = new Map<string, OrderSummaryCase>(), restores = new Set<() => Promise<void>>();
  const activeHolds = new Set<ReturnType<typeof latch>>();
  let closed = false;
  const effects = { archiveDownloads: 0, scans: 0, processingSchedules: 0, retentionSchedules: 0,
    modelCalls: 0, workerProcesses: 0, reportStorage: "real_encrypted_database" as const,
    editorStorage: "original_s3_adapter_unused_by_seed" as const, scanner: "synthetic_clean_archive_scan" as const, source: "synthetic_report_archive" as const };
  let base: TenantContext;
  try {
    if (options.context) {
      base = TenantContextSchema.parse(options.context);
      const actual = await withTenant(database.db, base, tx => loadCurrentMembershipContext(tx, base));
      if (actual.tenantId !== base.tenantId || actual.userId !== base.userId
        || !summaryPermissions.every(permission => actual.permissions.includes(permission)))
        throw new Error("order_summary_actual_member_permissions_required");
    } else {
      const tenantId = createEntityId(), userId = createEntityId(), membershipId = createEntityId(), roleId = createEntityId();
      base = { tenantId, userId, dataScope: "tenant", permissions: [...summaryPermissions] };
      await database.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic summary tenant',$2)", [tenantId, "summary-" + tenantId]);
      await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic summary operator')",
        [userId, "summary-" + userId, userId + "@example.invalid"]);
      await withTenant(database.db, base, async tx => {
        await tx.insert(memberships).values({ id: membershipId, tenantId, userId, status: "active" });
        await tx.insert(roles).values({ id: roleId, tenantId, name: "Synthetic summary role " + roleId,
          permissions: [...summaryPermissions], dataScope: "tenant" });
        await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId });
      });
    }
  } catch (error) {
    await database.client.end();
    throw error;
  }
  const context = await withTenant(database.db, base, tx => loadCurrentMembershipContext(tx, base));
  let vault: ReturnType<typeof createOrderPiiVault>, storage: ReturnType<typeof createStorageFromEnvironment>;
  try { vault = createOrderPiiVault(); storage = createStorageFromEnvironment(); }
  catch (error) { await database.client.end(); throw error; }
  const audit = new AuditService(database), orders = new OrderService(database, vault, audit), accounts = new MarketplaceAccountService(database, audit);
  let afterRead: ((ids: readonly string[]) => Promise<void>) | null = null;
  class ObservedReports extends AmazonOrderReportService {
    override async reviewSummaryDetails(...args: Parameters<AmazonOrderReportService["reviewSummaryDetails"]>) {
      const value = await super.reviewSummaryDetails(...args);
      const hook = afterRead;
      if (hook) await hook(args[1].map(selection => selection.id));
      return value;
    }
  }
  const scan = async () => {
    effects.scans++;
    return { result: "clean" as const, engine: "synthetic_archive_scanner", signatureVersion: "summary-fixture-v1", scannedAt: new Date().toISOString() };
  };
  const reports = new ObservedReports(database, vault, orders, audit,
    { download: async () => { effects.archiveDownloads++; throw new Error("order_summary_no_external_archive_download"); }, scan },
    { schedule: async () => { effects.retentionSchedules++; } },
    { schedule: async () => { effects.processingSchedules++; } });
  const editor = new ProductionEditorService(database, vault, storage, reports, audit,
    { enqueue: async () => { throw new Error("order_summary_no_production_render"); } }, { scan });
  const work = new OrderWorkspaceService(database, vault, storage, reports, editor, { scan });
  const current = async (who: TenantContext = context) => withTenant(database.db, who, tx => loadCurrentMembershipContext(tx, who));
  const assertOwned = (value: OrderSummaryCase) => {
    if (owned.get(value.lineId) !== value || value.tenantId !== context.tenantId) throw new Error("order_summary_case_not_owned");
  };
  const now = async () => {
    const [row] = await withTenant(database.db, context, tx => tx.execute<{ at: string }>(sql`select clock_timestamp()::text as at`));
    const result = new Date(row!.at);
    if (!Number.isFinite(result.getTime())) throw new Error("order_summary_database_clock_invalid");
    return result;
  };
  async function account() {
    return accounts.create(await current(), { platform: "amazon", displayName: "Synthetic summary " + createEntityId(), region: "NA",
      marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", requestedScopes: [] });
  }
  async function archiveBytes(value: Pick<OrderSummaryCase, "externalOrderId" | "externalLineId">, sentinel: string) {
    const zip = new JSZip();
    zip.file("order.json", JSON.stringify({ orderId: value.externalOrderId, orderItemId: value.externalLineId,
      customizationData: { type: "PageContainerCustomization", snapshot: { imageName: "preview.png" }, children: [
        { type: "TextCustomization", label: "Synthetic private choice", inputValue: sentinel },
        { type: "ImageCustomization", image: { imageName: "buyer.png", buyerFilename: "synthetic-buyer.png" } },
      ] } }));
    const image = await sharp({ create: { width: 16, height: 12, channels: 3, background: "blue" } }).png().toBuffer();
    zip.file("preview.png", image); zip.file("buyer.png", image);
    return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }
  async function reportCase(saved: boolean): Promise<OrderSummaryCase> {
    const store = await account(), id = createEntityId(), externalOrderId = `${groupKey}-${id}`,
      externalLineId = `SYNTHETIC-LINE-${id}`, fixtureSentinel = orderSummaryFixtureSentinel(externalOrderId);
    const columns = ["order-id", "order-item-id", "purchase-date", "sku", "product-name", "quantity-purchased", "currency", "item-price", "customized-url",
      "buyer-name", "recipient-name", "ship-address-1", "ship-city", "ship-state", "ship-postal-code", "ship-country"];
    const content = [columns.join("\t"), [externalOrderId, externalLineId, (await now()).toISOString(), "SYNTHETIC-SUMMARY-SKU",
      "Synthetic summary item", "1", "USD", "29.99", `https://zme-caps.amazon.com/synthetic/${id}`,
      "Synthetic Buyer", "Synthetic Recipient", "Synthetic private address", "Synthetic City", "CA", "00000", "US"].join("\t")].join("\r\n");
    const batch = await reports.importReport(await current(), { accountId: store.id, marketplaceId: "ATVPDKIKX0DER", fileName: "synthetic-summary.tsv", content });
    const selected = (await reports.workspace(await current(), { batchId: batch.id })).lines;
    if (selected.length !== 1 || selected[0]!.externalOrderId !== externalOrderId) throw new Error("order_summary_original_import_missing");
    const parsed = await reports.process(await current(), selected[0]!.id, null, await archiveBytes({ externalOrderId, externalLineId }, fixtureSentinel));
    if (!parsed.versionId || !parsed.surfaces.some(surface => surface.fields.some(field => field.value === fixtureSentinel)))
      throw new Error("order_summary_original_parse_missing");
    const detail = await work.detail(await current(), selected[0]!.orderLineId);
    let revision = detail.line.revision, projectionVersion = detail.line.projectionVersion;
    if (saved) {
      const stored = await work.save(await current(), detail.line.id, { expectedRevision: revision, expectedProjectionVersion: projectionVersion,
        expectedSourceVersionId: parsed.versionId, draft: OrderWorkDraftSchema.parse({ ...detail.draft, printProfileVersionId: null,
          designExecutor: "human", instructions: fixtureSentinel,
          fields: [{ key: "synthetic-choice", label: "Synthetic private choice", kind: "text", value: fixtureSentinel }],
          images: parsed.files.filter(file => file.role === "buyer_image").map(file => ({ origin: "report", key: file.key, usage: "Synthetic buyer image" })) }),
        status: "needs_information", reason: "Synthetic summary acceptance only; no production admission", idempotencyKey: randomUUID() });
      revision = stored.line.revision; projectionVersion = stored.line.projectionVersion;
    }
    const value: OrderSummaryCase = { kind: saved ? "healthy_saved" : "healthy_no_work", tenantId: context.tenantId, accountId: store.id,
      orderId: parsed.line.orderId, lineId: parsed.line.orderLineId, reportLineId: parsed.line.id, reportVersionId: parsed.versionId,
      externalOrderId, externalLineId, revision, projectionVersion, fixtureSentinel };
    owned.set(value.lineId, value); return value;
  }
  async function formalCase(): Promise<OrderSummaryCase> {
    const store = await account(), id = createEntityId(), externalOrderId = `${groupKey}-FORMAL-${id}`, externalLineId = `SYNTHETIC-FORMAL-LINE-${id}`;
    const result = await orders.ingestNormalized(await current(), { accountId: store.id, platform: "amazon", externalEventId: id, externalOrderId,
      providerStatus: "synthetic_original_import", placedAt: (await now()).toISOString(), orderTotal: { amountMinor: 2999, currency: "USD" },
      redactedSource: { synthetic: true, purpose: "summary_without_work_or_report" }, protectedDetails: null,
      lines: [{ externalLineId, externalListingId: null, skuCode: "SYNTHETIC-FORMAL-SKU", title: "Synthetic formal order without work", quantity: 1,
        unitPrice: { amountMinor: 2999, currency: "USD" }, customizationCount: 0 }] });
    const view = result, line = view.lines.find(row => row.externalLineId === externalLineId);
    if (!line) throw new Error("order_summary_original_formal_order_missing");
    const value: OrderSummaryCase = { kind: "healthy_no_work", tenantId: context.tenantId, accountId: store.id, orderId: view.id, lineId: line.id,
      reportLineId: null, reportVersionId: null, externalOrderId, externalLineId, revision: 0, projectionVersion: 0, fixtureSentinel: orderSummaryFixtureSentinel(externalOrderId) };
    owned.set(value.lineId, value); return value;
  }
  async function registerCase(raw: unknown) {
    const pins = OrderSummaryCasePinsSchema.parse(raw);
    if (closed || !pins.externalOrderId.startsWith(`SYNTHETIC-SUMMARY-${isolated.nonce}-`)) throw new Error("order_summary_case_nonce_mismatch");
    const actual = await current();
    await accounts.get(actual, pins.accountId);
    const [row] = await withTenant(database.db, actual, tx => tx.select({ line: orderLines, order: orderRows,
      work: orderWorkItems, report: amazonOrderReportLines, ownerId: marketplaceAccounts.createdBy })
      .from(orderLines).innerJoin(orderRows, eq(orderRows.id, orderLines.orderId))
      .innerJoin(marketplaceAccounts, eq(marketplaceAccounts.id, orderRows.accountId))
      .leftJoin(orderWorkItems, eq(orderWorkItems.id, orderLines.id))
      .leftJoin(amazonOrderReportLines, eq(amazonOrderReportLines.orderLineId, orderLines.id)).where(eq(orderLines.id, pins.lineId)));
    if (!row || row.ownerId !== actual.userId || row.order.id !== pins.orderId || row.order.accountId !== pins.accountId
      || row.order.externalOrderId !== pins.externalOrderId || row.line.externalLineId !== pins.externalLineId
      || (row.report?.id ?? null) !== pins.reportLineId || (row.work?.sourceVersionId ?? row.report?.currentVersionId ?? null) !== pins.reportVersionId
      || (row.work?.revision ?? 0) !== pins.revision || (row.work?.projectionVersion ?? 0) !== pins.projectionVersion)
      throw new Error("order_summary_case_source_mismatch");
    const value: OrderSummaryCase = { ...pins, tenantId: context.tenantId, fixtureSentinel: orderSummaryFixtureSentinel(pins.externalOrderId) };
    owned.set(value.lineId, value); return value;
  }
  async function setWorkExpiry(value: OrderSummaryCase, expiresAt: Date) {
    assertOwned(value);
    if (!Number.isFinite(expiresAt.getTime())) throw new Error("order_summary_fixture_expiry_invalid");
    const rows = await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ expiresAt })
      .where(eq(orderWorkItems.id, value.lineId)).returning({ id: orderWorkItems.id }));
    if (rows.length !== 1) throw new Error("order_summary_fixture_work_missing");
  }
  async function setReportExpiry(value: OrderSummaryCase, expiresAt: Date) {
    assertOwned(value);
    if (!value.reportLineId || !Number.isFinite(expiresAt.getTime())) throw new Error("order_summary_fixture_report_expiry_invalid");
    const rows = await withTenant(database.db, context, tx => tx.update(amazonOrderReportLines).set({ expiresAt })
      .where(eq(amazonOrderReportLines.id, value.reportLineId!)).returning({ id: amazonOrderReportLines.id }));
    if (rows.length !== 1) throw new Error("order_summary_fixture_report_missing");
  }
  async function anonymize(value: OrderSummaryCase) {
    assertOwned(value);
    const cutoff = new Date(Math.min(Date.now(), (await now()).getTime()) - 1000);
    const changed = await withTenant(database.db, context, tx => tx.update(orderProtectedDetails).set({ retentionExpiresAt: cutoff })
      .where(and(eq(orderProtectedDetails.orderId, value.orderId), eq(orderProtectedDetails.status, "protected")))
      .returning({ envelopeVersion: orderProtectedDetails.envelopeVersion }));
    if (changed.length !== 1) throw new Error("order_summary_original_protected_details_missing");
    const view = await orders.get(await current(), value.orderId);
    await orders.anonymizeProtectedDetails(await current(), value.orderId, { expectedSequence: view.latestEventSequence,
      expectedEnvelopeVersion: changed[0]!.envelopeVersion, idempotencyKey: randomUUID(), reason: "Synthetic expired retention acceptance" });
  }
  async function purge(value: OrderSummaryCase) {
    assertOwned(value);
    await purgeExpiredAmazonOrderReports(database, await current(), await now());
  }
  async function archive(value: OrderSummaryCase, archived = true) {
    assertOwned(value);
    const detail = await work.detail(await current(), value.lineId);
    return work.archive(await current(), value.lineId, { archived, expectedProjectionVersion: detail.line.projectionVersion,
      reason: "Synthetic reversible archive acceptance", idempotencyKey: randomUUID() });
  }
  async function createCase(kind: OrderSummaryCaseKind) {
    if (closed) throw new Error("order_summary_fixture_closed");
    const value = kind === "healthy_no_work" ? await formalCase() : await reportCase(true);
    value.kind = kind;
    if (kind === "anonymized" || kind === "purged") await anonymize(value);
    if (kind === "purged") await purge(value);
    if (kind === "expired") await setWorkExpiry(value, new Date((await now()).getTime() - 1));
    if (kind === "archived") await archive(value);
    return value;
  }
  async function appendReport(value: OrderSummaryCase) {
    assertOwned(value);
    if (!value.reportLineId || !value.reportVersionId) throw new Error("order_summary_report_required");
    const fixtureSentinel = `synthetic-new-source-${createEntityId()}`;
    const next = await reports.process(await current(), value.reportLineId, value.reportVersionId, await archiveBytes(value, fixtureSentinel));
    if (!next.versionId || next.versionId === value.reportVersionId) throw new Error("order_summary_original_report_append_missing");
    return { previousVersionId: value.reportVersionId, versionId: next.versionId, fixtureSentinel };
  }
  function holdNextSummaryRead(value: OrderSummaryCase) {
    assertOwned(value);
    if (!value.reportLineId || afterRead) throw new Error("order_summary_report_hold_invalid");
    const entered = latch(), released = latch(); activeHolds.add(released);
    afterRead = async ids => {
      if (!ids.includes(value.reportLineId!)) return;
      afterRead = null; entered.release(); await released.promise; activeHolds.delete(released);
    };
    return { entered: entered.promise, release: released.release };
  }
  async function setPiiAccess(enabled: boolean) {
    const actual = await current();
    const original = await withTenant(database.db, context, tx => tx.select({ id: roles.id, permissions: roles.permissions, dataScope: roles.dataScope })
      .from(roles).innerJoin(membershipRoles, eq(membershipRoles.roleId, roles.id)).innerJoin(memberships, eq(memberships.id, membershipRoles.membershipId))
      .where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active"))));
    if (!original.length || enabled) throw new Error("order_summary_use_exact_permission_restore");
    const changed = original.map(row => ({ ...row, permissions: row.permissions.filter(value => value !== Permission.OrderPiiRead) }));
    await withTenant(database.db, context, async tx => {
      for (let index = 0; index < original.length; index++) {
        const prior = original[index]!, next = changed[index]!;
        const rows = await tx.update(roles).set({ permissions: next.permissions }).where(and(eq(roles.id, prior.id),
          sql`${roles.permissions} = ${JSON.stringify(prior.permissions)}::jsonb`, eq(roles.dataScope, prior.dataScope))).returning({ id: roles.id });
        if (rows.length !== 1) throw new Error("order_summary_role_changed");
      }
    });
    let restored = false;
    const restore = async () => {
      if (restored) return;
      await withTenant(database.db, context, async tx => {
        for (let index = 0; index < original.length; index++) {
          const prior = original[index]!, next = changed[index]!;
          const rows = await tx.update(roles).set({ permissions: prior.permissions }).where(and(eq(roles.id, prior.id),
            sql`${roles.permissions} = ${JSON.stringify(next.permissions)}::jsonb`, eq(roles.dataScope, next.dataScope))).returning({ id: roles.id });
          if (rows.length !== 1) throw new Error("order_summary_role_restore_changed");
        }
      });
      restored = true; restores.delete(restore);
    };
    restores.add(restore);
    return { before: actual, after: await current(), restore };
  }
  async function corruptWorkKey(value: OrderSummaryCase) {
    assertOwned(value);
    const [prior] = await withTenant(database.db, context, tx => tx.select({ key: orderWorkItems.encryptedDataKey })
      .from(orderWorkItems).where(eq(orderWorkItems.id, value.lineId)));
    if (!prior?.key) throw new Error("order_summary_corruption_requires_original_key");
    const retainedKey = prior.key;
    const broken = "synthetic-invalid-summary-key-" + createEntityId();
    const changed = await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ encryptedDataKey: broken })
      .where(and(eq(orderWorkItems.id, value.lineId), eq(orderWorkItems.encryptedDataKey, retainedKey))).returning({ id: orderWorkItems.id }));
    if (changed.length !== 1) throw new Error("order_summary_corruption_cas_failed");
    let restored = false;
    const restore = async () => {
      if (restored) return;
      const rows = await withTenant(database.db, context, tx => tx.update(orderWorkItems).set({ encryptedDataKey: retainedKey })
        .where(and(eq(orderWorkItems.id, value.lineId), eq(orderWorkItems.encryptedDataKey, broken))).returning({ id: orderWorkItems.id }));
      if (rows.length !== 1) throw new Error("order_summary_corruption_restore_cas_failed");
      restored = true; restores.delete(restore);
    };
    restores.add(restore); return restore;
  }
  async function facts(values: readonly OrderSummaryCase[] = [...owned.values()]) {
    values.forEach(assertOwned);
    return withTenant(database.db, context, async tx => {
      const result = [];
      for (const value of values) {
        const [order] = await tx.select().from(orderRows).where(eq(orderRows.id, value.orderId));
        const [item] = await tx.select().from(orderWorkItems).where(eq(orderWorkItems.id, value.lineId));
        const [protectedRow] = await tx.select().from(orderProtectedDetails).where(eq(orderProtectedDetails.orderId, value.orderId));
        const [report] = value.reportLineId ? await tx.select().from(amazonOrderReportLines).where(eq(amazonOrderReportLines.id, value.reportLineId)) : [];
        const revisions = await tx.select().from(orderWorkRevisions).where(eq(orderWorkRevisions.workItemId, value.lineId));
        const events = await tx.select().from(orderEvents).where(eq(orderEvents.orderId, value.orderId));
        const workEvents = await tx.select().from(orderWorkEvents).where(eq(orderWorkEvents.workItemId, value.lineId));
        const sources = await tx.select().from(orderSourceSnapshots).where(eq(orderSourceSnapshots.normalizedOrderId, value.orderId));
        const versions = value.reportLineId ? await tx.select().from(amazonOrderReportVersions).where(eq(amazonOrderReportVersions.reportLineId, value.reportLineId)) : [];
        result.push({ lineId: value.lineId, orderId: value.orderId, addressStatus: order?.addressStatus ?? null,
          latestEventSequence: order?.latestEventSequence ?? null,
          work: item ? { revision: item.revision, projectionVersion: item.projectionVersion, archivedAt: item.archivedAt?.toISOString() ?? null,
            expiresAt: item.expiresAt.toISOString(), hasKey: item.encryptedDataKey !== null, sourceVersionId: item.sourceVersionId } : null,
          protected: protectedRow ? { status: protectedRow.status, hasEnvelope: protectedRow.encryptedEnvelope !== null,
            expiresAt: protectedRow.retentionExpiresAt.toISOString() } : null,
          report: report ? { id: report.id, state: report.state, currentVersionId: report.currentVersionId,
            expiresAt: report.expiresAt.toISOString(), hasSource: report.encryptedSource !== null } : null,
          revisions: revisions.map(row => ({ id: row.id, revision: row.revision, sourceVersionId: row.sourceVersionId, sha256: hash(row) })),
          events: events.map(row => ({ id: row.id, type: row.type, sha256: hash(row) })),
          workEvents: workEvents.map(row => ({ id: row.id, action: row.action, sha256: hash(row) })),
          sources: sources.map(row => ({ id: row.id, sha256: hash(row) })),
          reportVersions: versions.map(({ encryptedArchive, encryptedDocument, ...row }) => ({ id: row.id, versionNumber: row.versionNumber,
            checksum: row.checksum, hasArchive: encryptedArchive !== null, hasDocument: encryptedDocument !== null, metadataSha256: hash(row) })) });
      }
      return result;
    });
  }
  async function close() {
    if (closed) return;
    closed = true; afterRead = null;
    for (const held of activeHolds) held.release();
    activeHolds.clear();
    const failures: unknown[] = [];
    for (const restore of [...restores]) try { await restore(); } catch (error) { failures.push(error); }
    try { await database.client.end(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "order_summary_fixture_close_failed");
  }
  return { isolated, groupKey, context, database, work, reports, orders, current, createCase, registerCase, createReportWithoutWork: () => reportCase(false),
    anonymize, purge, archive, appendReport, facts, close, holdNextSummaryRead, setWorkExpiry, setReportExpiry, setPiiAccess, corruptWorkKey, now, effects };
}
