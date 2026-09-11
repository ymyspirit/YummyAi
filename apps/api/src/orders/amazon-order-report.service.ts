import { createHash } from "node:crypto";

import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { Permission, authorize } from "@yummyai/authz";
import {
  AmazonReportBatchViewSchema, AmazonReportDetailViewSchema, AmazonReportImportInputSchema,
  AmazonReportLineViewSchema, createEntityId,
  type AmazonReportImportInput, type AmazonReportBatchView, type AmazonReportDetailView, type AmazonReportLineView,
  type AmazonReportWorkspaceView, type TenantContext, type NormalizeOrderInput,
} from "@yummyai/contracts";
import {
  amazonOrderReportBatches as batches, amazonOrderReportBatchItems as batchItems,
  amazonOrderReportLines as reportLines, amazonOrderReportVersions as versions,
  marketplaceAccounts, orders, orderLines, orderProtectedAccessEvents,
  purgeExpiredAmazonOrderReports, withTenant, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderService } from "./order.service.js";
import { parseAmazonOrderReport, type ParsedAmazonReportLine, type ParsedAmazonReportOrder } from "./amazon-report-parser.js";
import { AMAZON_CUSTOM_PARSER_REVISION, parseAmazonCustomArchive, type AmazonCustomDocument } from "./amazon-custom-archive.js";
import { AmazonArchiveAccessError, AmazonReportArchiveGateway, MAX_AMAZON_ARCHIVE_BYTES } from "./amazon-report-archive.gateway.js";
import { AmazonReportRetentionEnqueuer } from "./redis-amazon-report-retention-enqueuer.js";

type ReportLine = typeof reportLines.$inferSelect;
type StoredFile = { key: string; name: string; mediaType: string; role: "preview" | "buyer_image" | "source"; contentBase64: string; byteSize: number; originalFileKey?: string; width?: number; height?: number };
type StoredDocument = { parserRevision?: number; document: AmazonCustomDocument; files: StoredFile[] };
type StoredSource = { line: ParsedAmazonReportLine; marketplaceId: string; warnings: string[] };

@Injectable()
export class AmazonOrderReportService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(OrderService) private readonly orderService: OrderService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AmazonReportArchiveGateway) private readonly gateway: AmazonReportArchiveGateway,
    @Inject(AmazonReportRetentionEnqueuer) private readonly retention: AmazonReportRetentionEnqueuer,
  ) {}

  async importReport(context: TenantContext, rawInput: AmazonReportImportInput): Promise<AmazonReportBatchView> {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    const input = AmazonReportImportInputSchema.parse(rawInput);
    if (Buffer.byteLength(input.content, "utf8") > 5 * 1024 * 1024) throw new UnprocessableEntityException("报告大小不能超过 5 MiB");
    let parsed: ReturnType<typeof parseAmazonOrderReport>;
    try { parsed = parseAmazonOrderReport(input.content); }
    catch (error) { throw new UnprocessableEntityException(error instanceof Error ? error.message : "报告格式无效"); }
    if (!parsed.orders.length || parsed.orders.length > 1_000) throw new UnprocessableEntityException("每批报告需要包含 1 至 1000 个订单");
    const account = await this.account(context, input.accountId);
    if (account.platform !== "amazon" || ["disabled", "revoked"].includes(account.status)) throw new UnprocessableEntityException("请选择可用的亚马逊店铺");
    if (account.marketplaceIds.length && !account.marketplaceIds.includes(input.marketplaceId)) throw new UnprocessableEntityException("所选站点不属于当前店铺");
    await this.cleanupExpired(context);
    const erased = await withTenant(this.database.db, context, (tx) => tx.select({ id: orders.id }).from(orders)
      .where(and(eq(orders.accountId, input.accountId), eq(orders.addressStatus, "anonymized"), inArray(orders.externalOrderId, parsed.orders.map((row) => row.externalOrderId)))).limit(1));
    if (erased.length) throw new ConflictException("报告包含已清理个人资料的订单，请移除这些订单后再导入");
    const expiredReports = await withTenant(this.database.db, context, (tx) => tx.select({ id: reportLines.id }).from(reportLines)
      .innerJoin(orders, eq(orders.id, reportLines.orderId))
      .where(and(eq(orders.accountId, input.accountId), inArray(orders.externalOrderId, parsed.orders.map((row) => row.externalOrderId)),
        or(eq(reportLines.state, "expired"), lte(reportLines.expiresAt, new Date())))).limit(1));
    if (expiredReports.length) throw new ConflictException("报告包含已到资料保存期限的订单，请移除这些订单后再导入");
    const batchId = createEntityId();
    const reportChecksum = checksum(input.content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
    const expiresAt = new Date(Date.now() + 30 * 86_400_000);
    await withTenant(this.database.db, context, (tx) => tx.insert(batches).values({
      id: batchId, tenantId: context.tenantId, accountId: input.accountId, marketplaceId: input.marketplaceId,
      fileName: [...input.fileName].map((character) => character.charCodeAt(0) < 32 || ["/", "\\"].includes(character) ? "_" : character).join("").slice(0, 200), reportChecksum,
      encryptedReport: null, rowCount: parsed.rowCount, orderCount: parsed.orders.length,
      createdBy: context.userId, expiresAt,
    }));
    try { await this.retention.schedule(context, batchId, expiresAt); }
    catch {
      await withTenant(this.database.db, context, (tx) => tx.update(batches).set({ encryptedReport: null, status: "failed", failedOrderCount: parsed.orders.length }).where(eq(batches.id, batchId)));
      throw new UnprocessableEntityException("后台任务服务暂不可用，报告尚未导入，请稍后重试");
    }
    // Register durable cleanup before the first private report bytes reach storage.
    await withTenant(this.database.db, context, (tx) => tx.update(batches).set({ encryptedReport: this.vault.encrypt(input.content) }).where(eq(batches.id, batchId)));
    let newOrderCount = 0, duplicateOrderCount = 0, failedOrderCount = 0;
    for (const source of parsed.orders) {
      let targetOrderId: string | null = null;
      try {
        const existed = await withTenant(this.database.db, context, async (tx) => {
          const [found] = await tx.select({ id: orders.id }).from(orders).where(and(eq(orders.accountId, account.id), eq(orders.platform, "amazon"), eq(orders.externalOrderId, source.externalOrderId))).limit(1);
          return !!found;
        });
        const result = await this.orderService.materializeNormalized(context, normalize(input.accountId, input.marketplaceId, source), { manualReport: true, protectedExpiresAt: expiresAt });
        targetOrderId = result.order.id;
        await withTenant(this.database.db, context, async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${targetOrderId}:amazon-report`}, 0))`);
          const [lockedOrder] = await tx.select().from(orders).where(eq(orders.id, result.order.id)).for("update").limit(1);
          if (!lockedOrder || lockedOrder.addressStatus === "anonymized") throw new ConflictException("订单个人资料已清理");
          for (const sourceLine of source.lines) {
            const line = result.order.lines.find((candidate) => candidate.externalLineId === sourceLine.externalLineId);
            if (!line) throw new Error("missing_order_line");
            const [prior] = await tx.select().from(reportLines).where(eq(reportLines.orderLineId, line.id)).for("update").limit(1);
            if (prior && (prior.state === "expired" || prior.expiresAt <= new Date())) throw new ConflictException("订单定制资料已到保存期限");
            const sourceChecksum = checksum(JSON.stringify({ marketplaceId: input.marketplaceId, line: sourceLine }));
            if (prior?.sourceChecksum === sourceChecksum) continue;
            const sourceChanged = !!prior;
            const conflict = line.quantity !== sourceLine.quantity || line.skuCode !== sourceLine.skuCode;
            const missingCustomization = !sourceLine.customizedUrl && (!!sourceLine.customizedPage || line.customizationCount > 0 || !!prior?.currentVersionId);
            const nextState = conflict || missingCustomization ? "failed" : sourceLine.customizedUrl ? "pending" : "none";
            const values = {
              batchId, sourceChecksum, encryptedSource: this.vault.encrypt(JSON.stringify({ line: sourceLine, marketplaceId: input.marketplaceId, warnings: parsed.warnings } satisfies StoredSource)),
              itemTotalMinor: sourceLine.itemTotalMinor, currency: sourceLine.currency,
              state: nextState, lastErrorCode: conflict ? "report_conflict" : missingCustomization ? "customization_missing" : sourceChanged ? "source_changed" : null,
              hasPreview: false, processingToken: null, processingStartedAt: null, updatedAt: new Date(),
            };
            if (prior) await tx.update(reportLines).set(values).where(eq(reportLines.id, prior.id));
            else await tx.insert(reportLines).values({ id: createEntityId(), tenantId: context.tenantId, orderId: result.order.id, orderLineId: line.id, expiresAt, ...values });
          }
          const [currentOrder] = await tx.select().from(orders).where(eq(orders.id, result.order.id)).limit(1);
          if (currentOrder?.providerStatus === "report_imported" && currentOrder.workflowState === "pending" && !currentOrder.sideState) {
            const sources = await tx.select().from(reportLines).where(eq(reportLines.orderId, result.order.id));
            if (sources.length === currentOrder.lineCount && sources.every((row) => !!row.encryptedSource && row.lastErrorCode !== "report_conflict")) {
              const total = sources.reduce((sum, row) => sum + this.vault.withSecret(row.encryptedSource!, (value) => {
                const source = (JSON.parse(value) as StoredSource).line;
                return source.itemTotalMinor + source.shippingTotalMinor + source.taxTotalMinor;
              }), 0);
              if (Number.isSafeInteger(total) && sources.every((row) => row.currency === currentOrder.orderCurrency)) {
                await tx.update(orders).set({ orderTotalMinor: total }).where(eq(orders.id, result.order.id));
              }
            }
          }
          await tx.insert(batchItems).values({ id: createEntityId(), tenantId: context.tenantId, batchId, orderId: result.order.id, externalOrderId: source.externalOrderId, status: existed || result.replayed ? "duplicate" : "imported" });
        });
        if (existed || result.replayed) duplicateOrderCount++; else newOrderCount++;
      } catch {
        failedOrderCount++;
        // A failed row may have crossed its erasure boundary after preflight.
        // The complete source contains that row, so discard the batch ciphertext too.
        await withTenant(this.database.db, context, (tx) => tx.update(batches).set({ encryptedReport: null }).where(eq(batches.id, batchId)));
        await withTenant(this.database.db, context, (tx) => tx.insert(batchItems).values({
          id: createEntityId(), tenantId: context.tenantId, batchId, orderId: targetOrderId,
          externalOrderId: source.externalOrderId, status: "failed", errorCode: "order_import_failed",
        }).onConflictDoNothing());
      }
    }
    await withTenant(this.database.db, context, (tx) => tx.update(batches).set({ newOrderCount, duplicateOrderCount, failedOrderCount,
      status: failedOrderCount === parsed.orders.length ? "failed" : failedOrderCount ? "partial" : "completed",
    }).where(eq(batches.id, batchId)));
    await this.audit.record(context, { action: "order.report.import", resourceType: "amazon_order_report", resourceId: batchId, result: failedOrderCount ? "failure" : "success", metadata: { newOrderCount, duplicateOrderCount, failedOrderCount } });
    return this.batch(context, batchId);
  }

  async workspace(context: TenantContext, filter: { accountId?: string; batchId?: string } = {}): Promise<AmazonReportWorkspaceView> {
    authorize(context, Permission.OrderRead);
    await this.cleanupExpired(context);
    if (filter.accountId) await this.account(context, filter.accountId);
    return withTenant(this.database.db, context, async (tx) => {
      const batchRows = await tx.select().from(batches).where(filter.accountId ? eq(batches.accountId, filter.accountId) : undefined).orderBy(desc(batches.createdAt)).limit(30);
      let ids: string[] | undefined;
      if (filter.batchId) {
        const [selected] = await tx.select().from(batches).where(eq(batches.id, filter.batchId)).limit(1);
        if (!selected || (filter.accountId && selected.accountId !== filter.accountId)) throw new NotFoundException("导入批次不存在");
        ids = (await tx.select({ id: batchItems.orderId }).from(batchItems).where(eq(batchItems.batchId, filter.batchId))).flatMap((row) => row.id ? [row.id] : []);
        if (!ids.length) return { batches: batchRows.map(toBatch), lines: [] };
      }
      const rows = await tx.select({ report: reportLines, order: orders, line: orderLines }).from(reportLines)
        .innerJoin(orders, eq(orders.id, reportLines.orderId)).innerJoin(orderLines, eq(orderLines.id, reportLines.orderLineId))
        .where(and(filter.accountId ? eq(orders.accountId, filter.accountId) : undefined, ids ? inArray(orders.id, ids) : undefined))
        .orderBy(desc(reportLines.updatedAt)).limit(1_000);
      return { batches: batchRows.map(toBatch), lines: rows.map((row) => toLine(row.report, row.order, row.line)) };
    });
  }

  async detail(context: TenantContext, id: string): Promise<AmazonReportDetailView> {
    authorize(context, Permission.OrderRead); authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    return withTenant(this.database.db, context, async (tx) => {
      const row = await this.loadLine(tx, id);
      const stored = await this.readDocument(tx, row.report, row.order.addressStatus);
      await this.access(tx, context, row.report.orderId);
      return AmazonReportDetailViewSchema.parse({
        line: toLine(row.report, row.order, row.line), surfaces: stored?.document.surfaces ?? [],
        files: stored?.files.map((file) => ({ key: file.key, name: file.name, mediaType: file.mediaType, role: file.role, byteSize: file.byteSize, originalFileKey: file.originalFileKey, width: file.width, height: file.height })) ?? [],
        warnings: stored?.document.warnings ?? [], versionId: row.report.currentVersionId,
      });
    });
  }

  async process(context: TenantContext, id: string, expectedVersionId: string | null, upload?: Uint8Array): Promise<AmazonReportDetailView> {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    if (upload && (!upload.byteLength || upload.byteLength > MAX_AMAZON_ARCHIVE_BYTES)) throw new UnprocessableEntityException("ZIP 大小必须为 1 字节至 20 MiB");
    await this.cleanupExpired(context);
    const token = createEntityId();
    const claimed = await withTenant(this.database.db, context, async (tx) => {
      await lockLine(tx, context, id);
      const row = await this.loadLine(tx, id);
      if (row.report.state === "expired" || row.order.addressStatus === "anonymized" || !row.report.encryptedSource) throw new ConflictException("定制资料已到保存期限，不能重新获取");
      if (row.report.currentVersionId !== expectedVersionId) throw new ConflictException("定制版本已更新，请刷新后操作");
      if (row.report.lastErrorCode === "report_conflict") throw new ConflictException("报告商品或数量与现有订单不一致，请先核对来源");
      if (row.report.processingStartedAt && Date.now() - row.report.processingStartedAt.getTime() < 120_000) throw new ConflictException("该订单行正在解析，请稍后刷新");
      const source = this.vault.withSecret(row.report.encryptedSource, (value) => JSON.parse(value) as StoredSource);
      await tx.update(reportLines).set({ state: "processing", processingToken: token, processingStartedAt: new Date(), lastErrorCode: null, updatedAt: new Date() }).where(eq(reportLines.id, id));
      return { ...row, source };
    });
    try {
      if (!upload && !claimed.source.line.customizedUrl) throw new AmazonArchiveAccessError("customization_missing");
      const body = upload ?? await this.gateway.download(claimed.source.line.customizedUrl!);
      let evidence;
      try { evidence = await this.gateway.scan(body); } catch { throw new AmazonArchiveAccessError("scan_unavailable"); }
      if (evidence.result !== "clean" || evidence.signatureVersion === "unavailable") throw new AmazonArchiveAccessError(evidence.result === "infected" ? "file_rejected" : "scan_unavailable");
      const parsed = await parseAmazonCustomArchive(body, { externalOrderId: claimed.order.externalOrderId, externalLineId: claimed.line.externalLineId });
      const raw = parsed.document.raw as Record<string, unknown> | null;
      if (raw && typeof raw.marketplaceId === "string" && raw.marketplaceId !== claimed.source.marketplaceId) throw new AmazonArchiveAccessError("marketplace_mismatch");
      const account = await this.account(context, claimed.order.accountId);
      if (raw && account.externalAccountId && typeof raw.merchantId === "string" && raw.merchantId !== account.externalAccountId) throw new AmazonArchiveAccessError("merchant_mismatch");
      if (raw && typeof raw.quantity === "number" && raw.quantity !== claimed.line.quantity) throw new AmazonArchiveAccessError("quantity_mismatch");
      const warnings = [...new Set([...claimed.source.warnings, ...parsed.document.warnings])];
      parsed.document.warnings = warnings.length > 499 ? [...warnings.slice(0, 499), "诊断条目较多，仅显示前 499 条，请检查原始报告。"] : warnings;
      const stored: StoredDocument = { parserRevision: AMAZON_CUSTOM_PARSER_REVISION, document: parsed.document, files: parsed.files.map((file) => ({
        key: file.key, name: file.name, mediaType: file.mediaType, role: file.role,
        originalFileKey: file.originalFileKey, width: file.width, height: file.height,
        byteSize: file.body.byteLength, contentBase64: Buffer.from(file.body).toString("base64"),
      })) };
      const digest = checksum(body);
      const protectedDocument = this.vault.encrypt(JSON.stringify(stored));
      const protectedArchive = this.vault.encrypt(Buffer.from(body).toString("base64"));
      await withTenant(this.database.db, context, async (tx) => {
        await lockLine(tx, context, id);
        const row = await this.loadLine(tx, id);
        if (row.report.processingToken !== token || row.report.sourceChecksum !== claimed.report.sourceChecksum || row.report.expiresAt <= new Date() || row.order.addressStatus === "anonymized") throw new ConflictException("来源已更新，旧解析结果已丢弃");
        const [prior] = row.report.currentVersionId ? await tx.select().from(versions).where(eq(versions.id, row.report.currentVersionId)).limit(1) : [];
        const unchanged = prior?.checksum === digest && !!prior.encryptedDocument && this.vault.withSecret(prior.encryptedDocument,
          (value) => (JSON.parse(value) as StoredDocument).parserRevision === AMAZON_CUSTOM_PARSER_REVISION);
        const versionId = unchanged ? row.report.currentVersionId! : createEntityId();
        const versionNumber = unchanged ? row.report.versionNumber : row.report.versionNumber + 1;
        if (!unchanged) await tx.insert(versions).values({
          id: versionId, tenantId: context.tenantId, reportLineId: id, versionNumber, checksum: digest,
          encryptedDocument: protectedDocument, encryptedArchive: protectedArchive, scanEngine: evidence.engine,
          scanSignature: evidence.signatureVersion, expiresAt: row.report.expiresAt,
        });
        await tx.update(reportLines).set({ currentVersionId: versionId, versionNumber,
          state: parsed.document.warnings.length ? "partial" : "ready", processingToken: null, processingStartedAt: null,
          lastErrorCode: null, updatedAt: new Date(), hasPreview: parsed.document.surfaces.some((surface) => !!surface.previewFileKey),
          ...(!unchanged ? { reviewedVersionId: null, reviewedBy: null, reviewedAt: null } : {}),
        }).where(eq(reportLines.id, id));
        await this.audit.recordInTransaction(tx, context, { action: "order.report.parsed", resourceType: "amazon_order_report_line", resourceId: id, result: "success", metadata: { versionNumber, unchanged } });
      });
    } catch (error) {
      const code = error instanceof AmazonArchiveAccessError ? error.code : "archive_invalid";
      await withTenant(this.database.db, context, async (tx) => {
        await tx.update(reportLines).set({ state: "failed", lastErrorCode: code, processingToken: null, processingStartedAt: null, updatedAt: new Date() })
          .where(and(eq(reportLines.id, id), eq(reportLines.processingToken, token)));
        await this.audit.recordInTransaction(tx, context, { action: "order.report.parse_failed", resourceType: "amazon_order_report_line", resourceId: id, result: "failure", metadata: { code } });
      });
    }
    return this.detail(context, id);
  }

  async review(context: TenantContext, id: string, expectedVersionId: string): Promise<AmazonReportDetailView> {
    authorize(context, Permission.OrderWrite); authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    await withTenant(this.database.db, context, async (tx) => {
      await lockLine(tx, context, id);
      const row = await this.loadLine(tx, id);
      if (row.report.currentVersionId !== expectedVersionId || !["ready", "partial"].includes(row.report.state)) throw new ConflictException("仅可核对当前已解析版本，请刷新后重试");
      const document = await this.readDocument(tx, row.report, row.order.addressStatus);
      if (!document) throw new ConflictException("定制文件已不可用");
      await tx.update(reportLines).set({ reviewedVersionId: expectedVersionId, reviewedBy: context.userId, reviewedAt: new Date(), updatedAt: new Date() }).where(eq(reportLines.id, id));
      await this.audit.recordInTransaction(tx, context, { action: "order.report.reviewed", resourceType: "amazon_order_report_line", resourceId: id, result: "success", metadata: { versionId: expectedVersionId } });
    });
    return this.detail(context, id);
  }

  async file(context: TenantContext, id: string, key: string, expectedVersionId?: string): Promise<{ body: Uint8Array; mediaType: string; name: string; inline: boolean }> {
    authorize(context, Permission.OrderRead); authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    return withTenant(this.database.db, context, async (tx) => {
      const row = await this.loadLine(tx, id);
      if (expectedVersionId && row.report.currentVersionId !== expectedVersionId) throw new ConflictException("定制版本已更新，请刷新详情");
      const document = await this.readDocument(tx, row.report, row.order.addressStatus);
      if (!document) throw new NotFoundException("定制文件不存在或已到保存期限");
      const file = document.files.find((candidate) => candidate.key === key);
      if (!file) throw new NotFoundException("定制文件不存在");
      await this.access(tx, context, row.report.orderId);
      return { body: Buffer.from(file.contentBase64, "base64"), mediaType: file.mediaType, name: file.name,
        inline: ["preview", "buyer_image"].includes(file.role) && file.mediaType === "image/png" };
    });
  }

  private async batch(context: TenantContext, id: string): Promise<AmazonReportBatchView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(batches).where(eq(batches.id, id)).limit(1);
      if (!row) throw new NotFoundException("导入批次不存在");
      const items = await tx.select().from(batchItems).where(eq(batchItems.batchId, id));
      return AmazonReportBatchViewSchema.parse({ ...toBatch(row), items: items.map(({ id, orderId, externalOrderId, status, errorCode }) => ({ id, orderId, externalOrderId, status, errorCode })) });
    });
  }

  private async account(context: TenantContext, id: string) {
    const [account] = await withTenant(this.database.db, context, (tx) => tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, id)).limit(1));
    if (!account) throw new NotFoundException("店铺不存在");
    return account;
  }

  private async loadLine(tx: TenantTransaction, id: string) {
    const [row] = await tx.select({ report: reportLines, order: orders, line: orderLines }).from(reportLines)
      .innerJoin(orders, eq(orders.id, reportLines.orderId)).innerJoin(orderLines, eq(orderLines.id, reportLines.orderLineId))
      .where(eq(reportLines.id, id)).limit(1);
    if (!row) throw new NotFoundException("订单行不存在");
    return row;
  }

  private async readDocument(tx: TenantTransaction, line: ReportLine, addressStatus: string): Promise<StoredDocument | null> {
    if (addressStatus === "anonymized" || !line.currentVersionId || !["ready", "partial"].includes(line.state) || line.expiresAt <= new Date()) return null;
    const [version] = await tx.select().from(versions).where(and(eq(versions.id, line.currentVersionId), eq(versions.reportLineId, line.id))).limit(1);
    if (!version?.encryptedDocument || version.expiresAt <= new Date()) return null;
    return this.vault.withSecret(version.encryptedDocument, (value) => JSON.parse(value) as StoredDocument);
  }

  private async access(tx: TenantTransaction, context: TenantContext, orderId: string) {
    await tx.insert(orderProtectedAccessEvents).values({ id: createEntityId(), tenantId: context.tenantId, orderId, purpose: "fulfillment", actorUserId: context.userId, granted: true });
  }

  async cleanupExpired(context: TenantContext) {
    await purgeExpiredAmazonOrderReports(this.database, context);
  }
}

function normalize(accountId: string, marketplaceId: string, source: ParsedAmazonReportOrder): NormalizeOrderInput {
  const total = source.lines.reduce((amount, line) => amount + line.itemTotalMinor + line.shippingTotalMinor + line.taxTotalMinor, 0);
  if (!Number.isSafeInteger(total)) throw new UnprocessableEntityException("订单金额超过可处理范围");
  return { accountId, platform: "amazon", externalEventId: `report:${marketplaceId}:${checksum(JSON.stringify(source))}`,
    externalOrderId: source.externalOrderId, providerStatus: "report_imported", placedAt: source.placedAt,
    orderTotal: { amountMinor: total, currency: source.lines[0]!.currency },
    lines: source.lines.map((line) => ({ externalLineId: line.externalLineId, externalListingId: null, skuCode: line.skuCode,
      title: line.title, quantity: line.quantity, unitPrice: { amountMinor: Math.round(line.itemTotalMinor / line.quantity), currency: line.currency },
      customizationCount: line.customizedUrl || line.customizedPage ? 1 : 0,
    })), protectedDetails: source.protectedDetails,
    redactedSource: { source: "amazon_manual_report", marketplaceId, lineCount: source.lines.length },
  };
}

function toBatch(row: typeof batches.$inferSelect): AmazonReportBatchView {
  return AmazonReportBatchViewSchema.parse({ id: row.id, accountId: row.accountId, marketplaceId: row.marketplaceId, fileName: row.fileName,
    rowCount: row.rowCount, orderCount: row.orderCount, newOrderCount: row.newOrderCount, duplicateOrderCount: row.duplicateOrderCount,
    failedOrderCount: row.failedOrderCount, status: row.status, createdAt: row.createdAt.toISOString() });
}

function toLine(report: ReportLine, order: typeof orders.$inferSelect, line: typeof orderLines.$inferSelect): AmazonReportLineView {
  return AmazonReportLineViewSchema.parse({ id: report.id, orderId: report.orderId, orderLineId: report.orderLineId,
    externalOrderId: order.externalOrderId, externalLineId: line.externalLineId, skuCode: line.skuCode, title: line.title,
    quantity: line.quantity, currency: report.currency, itemTotalMinor: report.itemTotalMinor,
    state: report.state, versionNumber: report.versionNumber, reviewed: !!report.currentVersionId && report.reviewedVersionId === report.currentVersionId && ["ready", "partial"].includes(report.state),
    lastErrorCode: report.lastErrorCode, updatedAt: report.updatedAt.toISOString(), hasPreview: report.hasPreview && ["ready", "partial"].includes(report.state),
  });
}

function checksum(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
function lockLine(tx: TenantTransaction, context: TenantContext, id: string) { return tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${id}:amazon-report-line`}, 0))`); }
