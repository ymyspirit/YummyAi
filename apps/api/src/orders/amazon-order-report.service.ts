import { AmazonReportArchiveProcessor, AmazonReportProcessingError, createAmazonReportReadModel, extractAmazonRequirementSources, type StoredSource, type StoredDocument, type StoredFile, type ReviewMetadata, type ReadModel } from "@yummyai/order-intake";
import { createHash } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, Permission, authorize } from "@yummyai/authz";
import { currentOrderAuthority } from "@yummyai/order-core";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import type { OrderWorkSummaryAvailability } from "@yummyai/contracts/order/workspace";
import {
  AmazonReportBatchViewSchema,
  AmazonReportDetailViewSchema,
  AmazonReportImportInputSchema,
  AmazonReportLineViewSchema,
  createEntityId,
  type AmazonReportImportInput,
  type AmazonReportBatchView,
  type AmazonReportDetailView,
  type AmazonReportLineView,
  type AmazonReportWorkspaceView,
  type TenantContext,
  type NormalizeOrderInput,
} from "@yummyai/contracts";
import {
  amazonOrderReportBatches as batches,
  amazonOrderReportBatchItems as batchItems,
  amazonOrderReportLines as reportLines,
  amazonOrderReportVersions as versions,
  amazonOrderReportReadModels as readModels,
  amazonOrderReportProcessingRequests as processingRequests,
  marketplaceAccounts,
  orders,
  orderLines,
  orderProtectedDetails,
  orderProtectedAccessEvents,
  purgeExpiredAmazonOrderReports,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql, type SQL } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION, ORDER_PII_VAULT } from "../platform.tokens.js";
import { OrderService } from "./order.service.js";
import {
  parseAmazonOrderReport,
  AmazonReportParseError,
  type ParsedAmazonReportOrder,
} from "./amazon-report-parser.js";
import {
  AmazonReportArchiveGateway,
} from "./amazon-report-archive.gateway.js";
import { AmazonReportRetentionEnqueuer } from "./redis-amazon-report-retention-enqueuer.js";
import { AmazonReportProcessingEnqueuer } from "./redis-amazon-report-processing-enqueuer.js";
import { orderSummaryAvailability, orderSummaryUnavailableReason } from "./order-summary-source.js";
import { amazonReportDeadlineEvidence, refreshAmazonReportPlatformDeadlines } from "./order-report-shipping.js";

type ReportLine = typeof reportLines.$inferSelect;

type SummaryReportLine = Omit<ReportLine, "encryptedSource">;
type SummarySource = {
  row: { report: SummaryReportLine; order: typeof orders.$inferSelect; line: typeof orderLines.$inferSelect };
  report: SummaryReportLine;
  availability: OrderWorkSummaryAvailability;
  pin: string;
  retentionDeadlines: Date[];
};
function summaryColumns<T extends Record<string, unknown>, K extends keyof T>(columns: T, omitted: readonly K[]): Omit<T, K> {
  const result = { ...columns }; for (const key of omitted) delete result[key]; return result;
}
const summaryReportColumns = summaryColumns(getTableColumns(reportLines), ["encryptedSource"]);
const summaryVersionColumns = summaryColumns(getTableColumns(versions), ["encryptedDocument", "encryptedArchive"]);
const summaryPrivacyColumns = summaryColumns(getTableColumns(orderProtectedDetails), ["encryptedEnvelope"]);
// Built-in PostgreSQL SHA-256 retains byte-level change detection without
// transferring full encrypted photos, ZIPs or address envelopes for a header check.
const summaryCiphertextHash = (column: SQL) => sql<string | null>`encode(sha256(convert_to(${column},'UTF8')),'hex')`;

export type OrderSummaryReportSelection = { id: string; versionId: string | null; pinned: boolean };
export type OrderSummaryReportRead = {
  selection: OrderSummaryReportSelection;
  availability: OrderWorkSummaryAvailability;
  error: string | null;
  detail: AmazonReportDetailView | null;
  /** Internal proof only. It is never part of the order summary wire DTO. */
  sourcePin: string | null;
  /** Request-local deadlines let the coordinator reject a source that expires during catalog work. */
  retentionDeadlines?: readonly Date[];
};
@Injectable()
export class AmazonOrderReportService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(OrderService) private readonly orderService: OrderService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(AmazonReportArchiveGateway) private readonly gateway: AmazonReportArchiveGateway,
    @Inject(AmazonReportRetentionEnqueuer)
    private readonly retention: AmazonReportRetentionEnqueuer,
    @Inject(AmazonReportProcessingEnqueuer) private readonly processing: AmazonReportProcessingEnqueuer,
  ) {}

  /** Native, authorized source refresh; no order, PII, work or queue is rewritten. */
  refreshPlatformDeadlines(context: TenantContext, batchId: string) {
    return refreshAmazonReportPlatformDeadlines({ database: this.database, vault: this.vault, audit: this.audit }, context, batchId);
  }

  async importReport(
    context: TenantContext,
    rawInput: AmazonReportImportInput,
  ): Promise<AmazonReportBatchView> {
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    const input = AmazonReportImportInputSchema.parse(rawInput);
    if (Buffer.byteLength(input.content, "utf8") > 5 * 1024 * 1024)
      throw new UnprocessableEntityException({ code: "report_too_large" });
    let parsed: ReturnType<typeof parseAmazonOrderReport>;
    try {
      parsed = parseAmazonOrderReport(input.content);
    } catch (error) {
      throw new UnprocessableEntityException(error instanceof AmazonReportParseError
        ? error.diagnostic : { code: "report_format_invalid" });
    }
    if (!parsed.orders.length || parsed.orders.length > 1_000)
      throw new UnprocessableEntityException({ code: "report_order_limit" });
    const account = await this.account(context, input.accountId);
    if (account.platform !== "amazon" || ["disabled", "revoked"].includes(account.status))
      throw new UnprocessableEntityException({ code: "report_account_unavailable" });
    if (account.marketplaceIds.length && !account.marketplaceIds.includes(input.marketplaceId))
      throw new UnprocessableEntityException({ code: "report_marketplace_mismatch" });
    await this.cleanupExpired(context);
    const erased = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.accountId, input.accountId),
            eq(orders.addressStatus, "anonymized"),
            inArray(
              orders.externalOrderId,
              parsed.orders.map((row) => row.externalOrderId),
            ),
          ),
        )
        .limit(1),
    );
    if (erased.length)
      throw new ConflictException("报告包含已清理个人资料的订单，请移除这些订单后再导入");
    const expiredReports = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ id: reportLines.id })
        .from(reportLines)
        .innerJoin(orders, eq(orders.id, reportLines.orderId))
        .where(
          and(
            eq(orders.accountId, input.accountId),
            inArray(
              orders.externalOrderId,
              parsed.orders.map((row) => row.externalOrderId),
            ),
            or(eq(reportLines.state, "expired"), lte(reportLines.expiresAt, new Date())),
          ),
        )
        .limit(1),
    );
    if (expiredReports.length)
      throw new ConflictException("报告包含已到资料保存期限的订单，请移除这些订单后再导入");
    const batchId = createEntityId();
    const reportChecksum = checksum(input.content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n"));
    const expiresAt = new Date(Date.now() + 30 * 86_400_000);
    const [createdBatch] = await withTenant(this.database.db, context, (tx) =>
      tx.insert(batches).values({
        id: batchId,
        tenantId: context.tenantId,
        accountId: input.accountId,
        marketplaceId: input.marketplaceId,
        fileName: [...input.fileName]
          .map((character) =>
            character.charCodeAt(0) < 32 || ["/", "\\"].includes(character) ? "_" : character,
          )
          .join("")
          .slice(0, 200),
        reportChecksum,
        encryptedReport: null,
        rowCount: parsed.rowCount,
        orderCount: parsed.orders.length,
        createdBy: context.userId,
        expiresAt,
      }).returning({ createdAt: batches.createdAt }),
    );
    if (!createdBatch) throw new ConflictException("订单报告批次未创建");
    try {
      await this.retention.schedule(context, batchId, expiresAt);
      await this.processing.schedule(context, batchId);
    } catch {
      await withTenant(this.database.db, context, (tx) =>
        tx
          .update(batches)
          .set({ encryptedReport: null, status: "failed", failedOrderCount: parsed.orders.length })
          .where(eq(batches.id, batchId)),
      );
      throw new UnprocessableEntityException({ code: "report_queue_unavailable" });
    }
    // Register durable cleanup before the first private report bytes reach storage.
    await withTenant(this.database.db, context, (tx) =>
      tx
        .update(batches)
        .set({ encryptedReport: this.vault.encrypt(input.content) })
        .where(eq(batches.id, batchId)),
    );
    let newOrderCount = 0,
      duplicateOrderCount = 0,
      failedOrderCount = 0;
    for (const source of parsed.orders) {
      let targetOrderId: string | null = null;
      try {
        const existed = await withTenant(this.database.db, context, async (tx) => {
          const [found] = await tx
            .select({ id: orders.id })
            .from(orders)
            .where(
              and(
                eq(orders.accountId, account.id),
                eq(orders.platform, "amazon"),
                eq(orders.externalOrderId, source.externalOrderId),
              ),
            )
            .limit(1);
          return !!found;
        });
        const result = await this.orderService.materializeNormalized(
          context,
          normalize(input.accountId, input.marketplaceId, source, parsed.reportType, {
            batchId, reportChecksum, reportCreatedAt: createdBatch.createdAt.toISOString(),
          }),
          { manualReport: true, protectedExpiresAt: expiresAt },
        );
        targetOrderId = result.order.id;
        await withTenant(this.database.db, context, async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${targetOrderId}:amazon-report`}, 0))`,
          );
          const [lockedOrder] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, result.order.id))
            .for("update")
            .limit(1);
          if (!lockedOrder || lockedOrder.addressStatus === "anonymized")
            throw new ConflictException("订单个人资料已清理");
          for (const sourceLine of source.lines) {
            const line = result.order.lines.find(
              (candidate) => candidate.externalLineId === sourceLine.externalLineId,
            );
            if (!line) throw new Error("missing_order_line");
            const [prior] = await tx
              .select()
              .from(reportLines)
              .where(eq(reportLines.orderLineId, line.id))
              .for("update")
              .limit(1);
            if (prior && (prior.state === "expired" || prior.expiresAt <= new Date()))
              throw new ConflictException("订单定制资料已到保存期限");
            const sourceChecksum = checksum(
              JSON.stringify({ marketplaceId: input.marketplaceId, line: sourceLine }),
            );
            if (prior?.sourceChecksum === sourceChecksum) continue;
            const sourceChanged = !!prior;
            const conflict =
              line.quantity !== sourceLine.quantity || line.skuCode !== sourceLine.skuCode;
            const missingCustomization =
              !sourceLine.customizedUrl &&
              (!!sourceLine.customizedPage ||
                line.customizationCount > 0 ||
                !!prior?.currentVersionId);
            const nextState =
              conflict || missingCustomization
                ? "failed"
                : sourceLine.customizedUrl
                  ? "pending"
                  : "none";
            const values = {
              batchId,
              sourceChecksum,
              encryptedSource: this.vault.encrypt(
                JSON.stringify({
                  line: sourceLine,
                  marketplaceId: input.marketplaceId,
                  warnings: parsed.warnings,
                } satisfies StoredSource),
              ),
              itemTotalMinor: sourceLine.itemTotalMinor,
              currency: sourceLine.currency,
              state: nextState,
              lastErrorCode: conflict
                ? "report_conflict"
                : missingCustomization
                  ? "customization_missing"
                  : sourceChanged
                    ? "source_changed"
                    : null,
              hasPreview: false,
              processingToken: null,
              processingStartedAt: null,
              updatedAt: new Date(),
            };
            const reportLineId = prior?.id ?? createEntityId();
            if (prior) await tx.update(reportLines).set(values).where(eq(reportLines.id, prior.id));
            else
              await tx.insert(reportLines).values({
                id: reportLineId,
                tenantId: context.tenantId,
                orderId: result.order.id,
                orderLineId: line.id,
                expiresAt,
                ...values,
              });
            if (nextState === "pending") {
              const request = { tenantId: context.tenantId, reportLineId, requestId: createEntityId(), dispatchId: null, batchId,
                sourceChecksum, expectedVersionId: prior?.currentVersionId ?? null, requestedBy: context.userId,
                status: "pending", attemptCount: 0, lastErrorCode: null, createdAt: new Date(), updatedAt: new Date() };
              await tx.insert(processingRequests).values(request).onConflictDoUpdate({ target: processingRequests.reportLineId, set: request });
            } else {
              await tx.update(processingRequests).set({ status: "superseded", updatedAt: new Date() }).where(eq(processingRequests.reportLineId, reportLineId));
            }
          }
          const [currentOrder] = await tx
            .select()
            .from(orders)
            .where(eq(orders.id, result.order.id))
            .limit(1);
          if (
            currentOrder?.providerStatus === "report_imported" &&
            currentOrder.workflowState === "pending" &&
            !currentOrder.sideState
          ) {
            const sources = await tx
              .select()
              .from(reportLines)
              .where(eq(reportLines.orderId, result.order.id));
            if (
              sources.length === currentOrder.lineCount &&
              sources.every(
                (row) => !!row.encryptedSource && row.lastErrorCode !== "report_conflict",
              )
            ) {
              const money = reportOrderMoney(sources.map(row => this.vault.withSecret(row.encryptedSource!,
                value => (JSON.parse(value) as StoredSource).line)));
              if (
                money &&
                (currentOrder.orderCurrency === null || money.currency === currentOrder.orderCurrency)
              ) {
                await tx
                  .update(orders)
                  .set({ orderTotalMinor: money.amountMinor, orderCurrency: money.currency })
                  .where(eq(orders.id, result.order.id));
              }
            }
          }
          await tx.insert(batchItems).values({
            id: createEntityId(),
            tenantId: context.tenantId,
            batchId,
            orderId: result.order.id,
            externalOrderId: source.externalOrderId,
            status: existed || result.replayed ? "duplicate" : "imported",
          });
        });
        if (existed || result.replayed) duplicateOrderCount++;
        else newOrderCount++;
      } catch {
        failedOrderCount++;
        // A failed row may have crossed its erasure boundary after preflight.
        // The complete source contains that row, so discard the batch ciphertext too.
        await withTenant(this.database.db, context, (tx) =>
          tx.update(batches).set({ encryptedReport: null }).where(eq(batches.id, batchId)),
        );
        await withTenant(this.database.db, context, (tx) =>
          tx
            .insert(batchItems)
            .values({
              id: createEntityId(),
              tenantId: context.tenantId,
              batchId,
              orderId: targetOrderId,
              externalOrderId: source.externalOrderId,
              status: "failed",
              errorCode: "order_import_failed",
            })
            .onConflictDoNothing(),
        );
      }
    }
    await withTenant(this.database.db, context, (tx) =>
      tx
        .update(batches)
        .set({
          newOrderCount,
          duplicateOrderCount,
          failedOrderCount,
          status:
            failedOrderCount === parsed.orders.length
              ? "failed"
              : failedOrderCount
                ? "partial"
                : "completed",
        })
        .where(eq(batches.id, batchId)),
    );
    await this.audit.record(context, {
      action: "order.report.import",
      resourceType: "amazon_order_report",
      resourceId: batchId,
      result: failedOrderCount ? "failure" : "success",
      metadata: { newOrderCount, duplicateOrderCount, failedOrderCount },
    });
    return this.batch(context, batchId);
  }

  async workspace(
    context: TenantContext,
    filter: { accountId?: string; batchId?: string } = {},
  ): Promise<AmazonReportWorkspaceView> {
    authorize(context, Permission.OrderRead);
    await this.cleanupExpired(context);
    if (filter.accountId) await this.account(context, filter.accountId);
    return withTenant(this.database.db, context, async (tx) => {
      const batchRows = await tx
        .select()
        .from(batches)
        .where(filter.accountId ? eq(batches.accountId, filter.accountId) : undefined)
        .orderBy(desc(batches.createdAt))
        .limit(30);
      let ids: string[] | undefined;
      if (filter.batchId) {
        const [selected] = await tx
          .select()
          .from(batches)
          .where(eq(batches.id, filter.batchId))
          .limit(1);
        if (!selected || (filter.accountId && selected.accountId !== filter.accountId))
          throw new NotFoundException("导入批次不存在");
        ids = (
          await tx
            .select({ id: batchItems.orderId })
            .from(batchItems)
            .where(eq(batchItems.batchId, filter.batchId))
        ).flatMap((row) => (row.id ? [row.id] : []));
        if (!ids.length) return { batches: batchRows.map(toBatch), lines: [] };
      }
      const rows = await tx
        .select({ report: reportLines, order: orders, line: orderLines })
        .from(reportLines)
        .innerJoin(orders, eq(orders.id, reportLines.orderId))
        .innerJoin(orderLines, eq(orderLines.id, reportLines.orderLineId))
        .where(
          and(
            filter.accountId ? eq(orders.accountId, filter.accountId) : undefined,
            ids ? inArray(orders.id, ids) : undefined,
          ),
        )
        .orderBy(desc(reportLines.updatedAt))
        .limit(1_000);
      return {
        batches: batchRows.map(toBatch),
        lines: rows.map((row) => toLine(row.report, row.order, row.line)),
      };
    });
  }

  /** Explicit recovery: queue before committing each group, with a dispatch marker
   * so an early Worker waits for the transaction rather than dropping the work. */
  async resume(context: TenantContext, filter: { accountId?: string; batchId?: string }) {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    if (filter.accountId) await this.account(context, filter.accountId);
    if (filter.batchId) await withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select({ accountId: batches.accountId }).from(batches).where(eq(batches.id, filter.batchId!));
      if (!batch || (filter.accountId && batch.accountId !== filter.accountId)) throw new NotFoundException("导入批次不存在");
    });
    let queued = 0;
    let cursor: string | undefined;
    // Recovery is independent of the display's 1,000-line window. Filter first,
    // then keyset-page by immutable UUID so updatedAt changes cannot skip rows.
    while (true) {
      const eligible = () => and(
        inArray(reportLines.state, ["pending", "failed", "processing"]),
        or(isNull(reportLines.lastErrorCode), notInArray(reportLines.lastErrorCode, ["report_conflict", "customization_missing"])),
        isNotNull(reportLines.encryptedSource), gt(reportLines.expiresAt, new Date()),
        sql`${orders.addressStatus} <> 'anonymized'`,
        or(isNull(reportLines.processingStartedAt), lte(reportLines.processingStartedAt, new Date(Date.now() - 120_000))),
      );
      const page = await withTenant(this.database.db, context, async (tx) => {
        const rows = await tx.select({ id: reportLines.id, batchId: reportLines.batchId, sourceChecksum: reportLines.sourceChecksum, currentVersionId: reportLines.currentVersionId })
          .from(reportLines).innerJoin(orders, eq(orders.id, reportLines.orderId))
          .where(and(
            cursor ? gt(reportLines.id, cursor) : undefined,
            filter.accountId ? eq(orders.accountId, filter.accountId) : undefined,
            filter.batchId ? inArray(reportLines.orderId, tx.select({ id: batchItems.orderId }).from(batchItems).where(eq(batchItems.batchId, filter.batchId))) : undefined,
            eligible(),
          )).orderBy(reportLines.id).limit(200).for("update", { of: reportLines, skipLocked: true });
        // Keep every dispatch atomic. Skip lines currently locked by import or a
        // claim so recovery neither interrupts them nor inverts multi-line locks.
        for (const batchId of new Set(rows.map((line) => line.batchId))) {
          const dispatchId = createEntityId();
          await this.processing.schedule(context, batchId, dispatchId);
          for (const line of rows.filter((candidate) => candidate.batchId === batchId)) {
            const request = { tenantId: context.tenantId, reportLineId: line.id, requestId: createEntityId(), dispatchId, batchId,
              sourceChecksum: line.sourceChecksum, expectedVersionId: line.currentVersionId, requestedBy: context.userId,
              status: "pending", attemptCount: 0, lastErrorCode: null, createdAt: new Date(), updatedAt: new Date() };
            await tx.insert(processingRequests).values(request).onConflictDoUpdate({ target: processingRequests.reportLineId, set: request });
            await tx.update(reportLines).set({ state: "pending", processingToken: null, processingStartedAt: null, lastErrorCode: null, updatedAt: new Date() }).where(eq(reportLines.id, line.id));
          }
        }
        return { count: rows.length, lastId: rows.at(-1)?.id };
      });
      queued += page.count;
      if (!page.lastId) break;
      cursor = page.lastId;
    }
    await this.audit.record(context, { action: "order.report.resume", resourceType: "amazon_order_report", resourceId: filter.batchId, result: "success", metadata: { queued } });
    return { queued };
  }

  async detail(context: TenantContext, id: string): Promise<AmazonReportDetailView> {
    const result = await this.reviewDetails(context, [id]);
    return result[0]!;
  }

  /** A page of review metadata shares retention cleanup and tenant transaction. File bytes stay private. */
  async reviewDetails(context: TenantContext, ids: string[]): Promise<AmazonReportDetailView[]> {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    if (ids.length > 100) throw new UnprocessableEntityException("每次最多读取 100 条定制资料");
    await this.cleanupExpired(context);
    return withTenant(this.database.db, context, async (tx) => {
      const result: AmazonReportDetailView[] = [];
      for (const id of [...new Set(ids)]) {
        const row = await this.loadLine(tx, id, true);
        const stored = await this.readModel(tx, row.report, row.order.addressStatus);
        await this.access(tx, context, row.report.orderId);
        result.push(
          AmazonReportDetailViewSchema.parse({
            line: toLine(row.report, row.order, row.line),
            surfaces: stored?.metadata.surfaces ?? [],
            files: stored?.metadata.files ?? [],
            warnings: stored?.metadata.warnings ?? [],
            versionId: row.report.currentVersionId,
          }),
        );
      }
      return result;
    });
  }

  /** Summary-only partial reads. Keep legacy detail/reviewDetails behavior intact,
   * including its own cleanup, access audit and lazy immutable read-model path. */
  async reviewSummaryDetails(context: TenantContext, selections: readonly OrderSummaryReportSelection[]): Promise<OrderSummaryReportRead[]> {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    if (selections.length > 100) throw new UnprocessableEntityException("每次最多读取 100 条定制资料");
    await withTenant(this.database.db, context, tx => currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead], { requireMembership: true }));
    await this.cleanupExpired(context);
    const unique = [...new Map(selections.map(selection => [canonicalJson(selection), selection])).values()];
    if (!unique.length) return [];
    try {
      return await withTenant(this.database.db, context, async tx => {
        await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead], { requireMembership: true });
        const sources = await this.summarySources(tx, unique);
        const versionIds = [...new Set([...sources.values()].filter(source => source.availability === "available")
          .flatMap(source => source.report.currentVersionId ? [source.report.currentVersionId] : []))];
        const projections = versionIds.length ? await tx.select({ versionId: readModels.versionId, encryptedMetadata: readModels.encryptedMetadata })
          .from(readModels).where(inArray(readModels.versionId, versionIds)) : [];
        const byVersion = new Map(projections.map(projection => [projection.versionId, projection]));
        const result: OrderSummaryReportRead[] = [], auditRows: Array<typeof orderProtectedAccessEvents.$inferInsert> = [];
        for (const selection of unique) {
          const source = sources.get(canonicalJson(selection));
          if (!source) { result.push(this.unavailableSummaryReport(selection, "failed")); continue; }
          if (source.availability !== "available") { result.push(this.unavailableSummaryReport(selection, source.availability)); continue; }
          try {
            const projection = source.report.currentVersionId ? byVersion.get(source.report.currentVersionId) : undefined;
            // Only legacy versions without a derived model use the original,
            // isolated read/derive path. Normal list reads never fetch full media.
            const stored = projection ? projection.encryptedMetadata ? {
              metadata: this.vault.withSecret(projection.encryptedMetadata, raw => JSON.parse(raw) as ReviewMetadata), thumbnails: [],
            } : null : await tx.transaction(inner => this.readModel(inner, source.report, source.row.order.addressStatus));
            if (source.report.currentVersionId && ["ready", "partial"].includes(source.report.state) && !stored) {
              result.push(this.unavailableSummaryReport(selection, "cleared")); continue;
            }
            auditRows.push({ id: createEntityId(), tenantId: context.tenantId, orderId: source.row.report.orderId,
              purpose: "fulfillment", actorUserId: context.userId, granted: true });
            const report = source.report.currentVersionId && stored && selection.pinned
              ? { ...source.report, state: stored.metadata.warnings.length ? "partial" : "ready", hasPreview: stored.metadata.files.some(file => file.role === "preview") }
              : source.report;
            const detail = AmazonReportDetailViewSchema.parse({ line: toLine(report, source.row.order, source.row.line),
              surfaces: stored?.metadata.surfaces ?? [], files: stored?.metadata.files ?? [], warnings: stored?.metadata.warnings ?? [],
              versionId: source.report.currentVersionId });
            result.push({ selection, availability: "available", error: null, detail, sourcePin: source.pin, retentionDeadlines: source.retentionDeadlines });
          } catch (error) {
            if (error instanceof ForbiddenError) throw error;
            result.push(this.unavailableSummaryReport(selection, "failed"));
          }
        }
        if (auditRows.length) await tx.insert(orderProtectedAccessEvents).values(auditRows);
        const current = await this.summarySources(tx, unique);
        for (let index = 0; index < result.length; index++) {
          const read = result[index]!, source = current.get(canonicalJson(read.selection));
          if (!source) result[index] = this.unavailableSummaryReport(read.selection, "failed");
          else if (source.availability !== "available") result[index] = this.unavailableSummaryReport(read.selection, source.availability);
          else if (read.availability === "available" && source.pin !== read.sourcePin)
            result[index] = this.unavailableSummaryReport(read.selection, "failed", "定制资料已变化 请重新读取");
        }
        await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead], { requireMembership: true });
        return result;
      });
    } catch (error) {
      if (error instanceof ForbiddenError) throw error;
      // A database fault rolls the batch back first. Retry its local read in
      // isolated transactions, never re-download/reprocess an archive or write a
      // replacement version. A damaged row cannot suppress healthy peer rows.
      const result: OrderSummaryReportRead[] = [];
      for (const selection of unique) {
        try {
          result.push(await withTenant(this.database.db, context, async tx => {
            await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead], { requireMembership: true });
            const source = await this.summarySource(tx, selection);
            if (source.availability !== "available") return this.unavailableSummaryReport(selection, source.availability);
            const stored = await this.readModel(tx, source.report, source.row.order.addressStatus);
            if (source.report.currentVersionId && ["ready", "partial"].includes(source.report.state) && !stored)
              return this.unavailableSummaryReport(selection, "cleared");
            await this.access(tx, context, source.row.report.orderId);
            const report = source.report.currentVersionId && stored && selection.pinned
              ? { ...source.report, state: stored.metadata.warnings.length ? "partial" : "ready", hasPreview: stored.metadata.files.some(file => file.role === "preview") }
              : source.report;
            const detail = AmazonReportDetailViewSchema.parse({ line: toLine(report, source.row.order, source.row.line),
              surfaces: stored?.metadata.surfaces ?? [], files: stored?.metadata.files ?? [], warnings: stored?.metadata.warnings ?? [],
              versionId: source.report.currentVersionId });
            const current = await this.summarySource(tx, selection);
            if (current.availability !== "available") return this.unavailableSummaryReport(selection, current.availability);
            if (current.pin !== source.pin) return this.unavailableSummaryReport(selection, "failed", "定制资料已变化 请重新读取");
            return { selection, availability: "available" as const, error: null, detail, sourcePin: source.pin, retentionDeadlines: source.retentionDeadlines };
          }));
        } catch (failure) {
          if (failure instanceof ForbiddenError) throw failure;
          result.push(this.unavailableSummaryReport(selection, "failed"));
        }
      }
      return result;
    }
  }

  /** The coordinator owns order locks. Revalidate every original selection in
   * one lightweight batch; the per-row savepoint path is only a fault fallback. */
  async verifySummaryDetailsInTransaction(tx: TenantTransaction, context: TenantContext,
    reads: readonly OrderSummaryReportRead[]): Promise<OrderSummaryReportRead[]> {
    await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead], { requireMembership: true });
    const ordered = [...reads].sort((a, b) => (a.selection.versionId ?? a.selection.id).localeCompare(b.selection.versionId ?? b.selection.id));
    let sources: Map<string, SummarySource> | null = null;
    try { sources = await tx.transaction(inner => this.summarySources(inner, ordered.filter(read => read.availability !== "failed").map(read => read.selection))); }
    catch (error) { if (error instanceof ForbiddenError) throw error; }
    const result: OrderSummaryReportRead[] = [];
    for (const read of ordered) {
      if (read.availability === "failed") { result.push(read); continue; }
      try {
        const source = sources ? sources.get(canonicalJson(read.selection)) : await tx.transaction(inner => this.summarySource(inner, read.selection));
        if (!source) result.push(this.unavailableSummaryReport(read.selection, "failed"));
        else if (source.availability !== "available") result.push(this.unavailableSummaryReport(read.selection, source.availability));
        else if (read.availability !== "available") result.push(read);
        else if (!read.sourcePin || source.pin !== read.sourcePin) result.push(this.unavailableSummaryReport(read.selection, "failed", "定制资料已变化 请重新读取"));
        else result.push({ ...read, retentionDeadlines: source.retentionDeadlines });
      } catch (error) {
        if (error instanceof ForbiddenError) throw error;
        result.push(this.unavailableSummaryReport(read.selection, "failed"));
      }
    }
    return result;
  }

  private unavailableSummaryReport(selection: OrderSummaryReportSelection, availability: Exclude<OrderWorkSummaryAvailability, "available">,
    error = orderSummaryUnavailableReason(availability)): OrderSummaryReportRead {
    return { selection, availability, error, detail: null, sourcePin: null };
  }

  /** One request-local source batch; no private body or key leaves this transaction. */
  private async summarySources(tx: TenantTransaction, selections: readonly OrderSummaryReportSelection[]): Promise<Map<string, SummarySource>> {
    const unique = [...new Map(selections.map(selection => [canonicalJson(selection), selection])).values()];
    if (!unique.length) return new Map();
    const ids = [...new Set(unique.map(selection => selection.id))].sort();
    const discovered = await tx.select({ orderId: reportLines.orderId }).from(reportLines).where(inArray(reportLines.id, ids));
    const orderIds = [...new Set(discovered.map(row => row.orderId))].sort();
    // Same retention lock direction as the coordinator: order, privacy, version.
    if (orderIds.length) await tx.select({ id: orders.id }).from(orders).where(inArray(orders.id, orderIds)).orderBy(asc(orders.id)).for("share");
    const privacy = orderIds.length ? await tx.select({ ...summaryPrivacyColumns,
      retained: sql<boolean>`nullif(${orderProtectedDetails.encryptedEnvelope},'') is not null`,
      envelopeHash: summaryCiphertextHash(sql`${orderProtectedDetails.encryptedEnvelope}`) })
      .from(orderProtectedDetails).where(inArray(orderProtectedDetails.orderId, orderIds)).orderBy(asc(orderProtectedDetails.orderId)).for("share") : [];
    const rows = await tx.select({ report: summaryReportColumns, order: orders, line: orderLines,
      sourceRetained: sql<boolean>`nullif(${reportLines.encryptedSource},'') is not null`,
      sourceHash: summaryCiphertextHash(sql`${reportLines.encryptedSource}`) })
      .from(reportLines).innerJoin(orders, eq(orders.id, reportLines.orderId)).innerJoin(orderLines, eq(orderLines.id, reportLines.orderLineId))
      .where(inArray(reportLines.id, ids)).orderBy(asc(orders.id), asc(reportLines.id));
    const rowById = new Map(rows.map(row => [row.report.id, row]));
    const versionIds = [...new Set(unique.flatMap(selection => {
      const id = selection.pinned ? selection.versionId : rowById.get(selection.id)?.report.currentVersionId;
      return id ? [id] : [];
    }))].sort();
    const selectedVersions = versionIds.length ? await tx.select({ ...summaryVersionColumns,
      documentRetained: sql<boolean>`nullif(${versions.encryptedDocument},'') is not null`,
      documentHash: summaryCiphertextHash(sql`${versions.encryptedDocument}`),
      archiveHash: summaryCiphertextHash(sql`${versions.encryptedArchive}`) })
      .from(versions).where(inArray(versions.id, versionIds)).orderBy(asc(versions.id)).for("share", { of: versions, skipLocked: true }) : [];
    const versionById = new Map(selectedVersions.map(version => [version.id, version])), privacyByOrder = new Map(privacy.map(row => [row.orderId, row]));
    const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock!.now), result = new Map<string, SummarySource>();
    for (const selection of unique) {
      const row = rowById.get(selection.id); if (!row) continue;
      const protectedDetail = privacyByOrder.get(row.order.id);
      const selectedId = selection.pinned ? selection.versionId : row.report.currentVersionId;
      const candidate = selectedId ? versionById.get(selectedId) : undefined;
      const version = candidate?.reportLineId === row.report.id ? candidate : undefined;
      const retentionDeadlines = [row.report.expiresAt, ...(protectedDetail ? [protectedDetail.retentionExpiresAt] : []), ...(version ? [version.expiresAt] : [])];
      let availability = orderSummaryAvailability({ anonymized: row.order.addressStatus === "anonymized" || protectedDetail?.status === "anonymized",
        deadlines: retentionDeadlines,
        cleared: Boolean(protectedDetail && !protectedDetail.retained) || Boolean(version && !version.documentRetained) ||
          (!selection.pinned && row.report.state !== "none" && !row.sourceRetained),
        failed: Boolean(selectedId && !version) || !selection.pinned && (row.report.state === "failed" ||
          (["ready", "partial"].includes(row.report.state) && !selectedId)),
      }, now);
      if (availability === "available" && row.report.state === "expired") availability = "expired";
      const report: SummaryReportLine = selection.pinned ? { ...row.report, currentVersionId: selectedId,
        versionNumber: version?.versionNumber ?? 0, updatedAt: version?.createdAt ?? row.report.updatedAt,
        state: version ? "ready" : "none", hasPreview: false,
        currency: row.report.currentVersionId === selectedId ? row.report.currency : null,
        itemTotalMinor: row.report.currentVersionId === selectedId ? row.report.itemTotalMinor : null,
      } : row.report;
      // This pin is internal to this read. It covers every original header and
      // all four original ciphertexts, without persisting a new source version.
      const pin = checksum(canonicalJson(JSON.parse(JSON.stringify({ selection, report: row.report, order: row.order, line: row.line,
        sourceRetained: row.sourceRetained, sourceHash: row.sourceHash, privacy: protectedDetail ?? null, version: version ?? null }))));
      result.set(canonicalJson(selection), { row, report, availability, pin, retentionDeadlines });
    }
    return result;
  }

  private async summarySource(tx: TenantTransaction, selection: OrderSummaryReportSelection): Promise<SummarySource> {
    const source = (await this.summarySources(tx, [selection])).get(canonicalJson(selection));
    if (!source) throw new NotFoundException("订单行不存在");
    return source;
  }

  /** Internal review handoff: never replace unavailable pinned evidence with the latest report. */
  async detailFromVersion(context: TenantContext, id: string, versionId: string): Promise<AmazonReportDetailView | null> {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    return withTenant(this.database.db, context, async (tx) => {
      const source = await this.versionLine(tx, id, versionId);
      if (!source) return null;
      const stored = await this.readModel(tx, source.report, source.order.addressStatus);
      if (!stored) return null;
      await this.access(tx, context, source.report.orderId);
      return AmazonReportDetailViewSchema.parse({
        line: {
          ...toLine(source.report, source.order, source.line),
          state: stored.metadata.warnings.length ? "partial" : "ready",
          hasPreview: stored.metadata.files.some((file) => file.role === "preview"),
        },
        ...stored.metadata,
        versionId,
      });
    });
  }

  /** Owner-only projection of the original customization tree; no archive is rewritten. */
  async requirementSources(context: TenantContext, id: string, expectedVersionId: string) {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    return withTenant(this.database.db, context, async tx => {
      const current = await currentOrderAuthority(tx, context, [Permission.OrderRead, Permission.OrderPiiRead]);
      const source = await this.versionLine(tx, id, expectedVersionId);
      const stored = source && await this.readDocument(tx, source.report, source.order.addressStatus);
      if (!source || !stored) throw new NotFoundException("原始定制要求不存在或已到保存期限");
      let legacySurfaces: AmazonReportDetailView["surfaces"] | undefined;
      if (!Array.isArray(stored.document?.surfaces)) {
        // Some retained inputs only have the original version's derived metadata.
        // Read it without backfilling a document or inventing raw provenance.
        const [projection] = await tx.select({ encryptedMetadata: readModels.encryptedMetadata }).from(readModels)
          .where(eq(readModels.versionId, expectedVersionId)).limit(1);
        if (!projection?.encryptedMetadata) throw new NotFoundException("原始定制要求不存在或已到保存期限");
        const parsed = this.vault.withSecret(projection.encryptedMetadata, value =>
          AmazonReportDetailViewSchema.shape.surfaces.safeParse((JSON.parse(value) as Partial<ReviewMetadata> | null)?.surfaces));
        if (!parsed.success) throw new NotFoundException("原始定制要求不存在或已到保存期限");
        legacySurfaces = parsed.data;
      }
      const result = extractAmazonRequirementSources(stored.document, legacySurfaces);
      await this.access(tx, current, source.report.orderId);
      return result;
    });
  }

  /** Only owning services may choose a pinned version; public clients choose a work revision. */
  async fileFromVersion(context: TenantContext, id: string, versionId: string, key: string) {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    return withTenant(this.database.db, context, async (tx) => {
      const source = await this.versionLine(tx, id, versionId);
      const document = source && await this.readDocument(tx, source.report, source.order.addressStatus);
      const file = document?.files.find((candidate) => candidate.key === key);
      if (!source || !file) throw new NotFoundException("制作依据文件不存在或已到保存期限");
      await this.access(tx, context, source.report.orderId);
      return {
        body: Buffer.from(file.contentBase64, "base64"),
        mediaType: file.mediaType,
        name: file.name.split("/").at(-1)!,
        inline: ["preview", "buyer_image"].includes(file.role) && file.mediaType === "image/png",
      };
    });
  }

  private async versionLine(tx: TenantTransaction, id: string, versionId: string) {
    const row = await this.loadLine(tx, id, true);
    if (row.order.addressStatus === "anonymized" || row.report.state === "expired" || row.report.expiresAt <= new Date())
      return null;
    const [version] = await tx.select({
      versionNumber: versions.versionNumber,
      createdAt: versions.createdAt,
      expiresAt: versions.expiresAt,
      available: sql<boolean>`${versions.encryptedDocument} is not null`,
    }).from(versions)
      .where(and(eq(versions.id, versionId), eq(versions.reportLineId, id)))
      .for("share", { of: versions });
    if (!version?.available || version.expiresAt <= new Date()) return null;
    return {
      ...row,
      report: {
        ...row.report,
        currentVersionId: versionId,
        versionNumber: version.versionNumber,
        updatedAt: version.createdAt,
        state: "ready",
        lastErrorCode: null,
        // Archive versions pin customization, not a historical financial snapshot.
        currency: row.report.currentVersionId === versionId ? row.report.currency : null,
        itemTotalMinor: row.report.currentVersionId === versionId ? row.report.itemTotalMinor : null,
      },
    };
  }

  async process(context: TenantContext, id: string, expectedVersionId: string | null, upload?: Uint8Array): Promise<AmazonReportDetailView> {
    try { await new AmazonReportArchiveProcessor(this.database, this.vault, this.gateway).process(context, id, expectedVersionId, upload); }
    catch (error) {
      if (error instanceof AmazonReportProcessingError) {
        if (error.code === "not_found") throw new NotFoundException(error.message);
        if (error.code === "invalid") throw new UnprocessableEntityException(error.message);
        throw new ConflictException(error.message);
      }
      throw error;
    }
    return this.detail(context, id);
  }

  async review(
    context: TenantContext,
    id: string,
    expectedVersionId: string,
  ): Promise<AmazonReportDetailView> {
    authorize(context, Permission.OrderWrite);
    authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    await withTenant(this.database.db, context, async (tx) => {
      await this.reviewInTransaction(tx, context, id, expectedVersionId);
    });
    return this.detail(context, id);
  }

  /** Owning-service confirmation, atomic with the operator's reviewed work revision. */
  async reviewInTransaction(
    tx: TenantTransaction,
    context: TenantContext,
    id: string,
    expectedVersionId: string,
    options: { expectedWorkLineId?: string } = {},
  ): Promise<void> {
    const current = await currentOrderAuthority(tx, context, [Permission.OrderWrite, Permission.OrderPiiRead]);
    await lockLine(tx, current, id);
    // Keep the same advisory -> report row direction as archive processing.
    const [locked] = await tx.select({ id: reportLines.id }).from(reportLines)
      .where(eq(reportLines.id, id)).for("update");
    if (!locked) throw new NotFoundException("订单行不存在");
    const row = await this.loadLine(tx, id);
    if (row.line.orderId !== row.order.id || options.expectedWorkLineId !== undefined &&
      (row.report.orderLineId !== options.expectedWorkLineId || row.line.id !== options.expectedWorkLineId))
      throw new NotFoundException("订单行不存在");
    if (row.report.currentVersionId !== expectedVersionId || !["ready", "partial"].includes(row.report.state))
      throw new ConflictException("仅可核对当前已解析版本，请刷新后重试");
    const document = await this.readDocument(tx, row.report, row.order.addressStatus);
    if (!document) throw new ConflictException("定制文件已不可用");
    await tx.update(reportLines).set({
      reviewedVersionId: expectedVersionId,
      reviewedBy: current.userId,
      reviewedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(reportLines.id, id));
    await this.audit.recordInTransaction(tx, current, {
      action: "order.report.reviewed",
      resourceType: "amazon_order_report_line",
      resourceId: id,
      result: "success",
      metadata: { versionId: expectedVersionId },
    });
  }

  async file(
    context: TenantContext,
    id: string,
    key: string,
    expectedVersionId?: string,
    thumbnail = false,
  ): Promise<{ body: Uint8Array; mediaType: string; name: string; inline: boolean }> {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    return withTenant(this.database.db, context, async (tx) => {
      const row = await this.loadLine(tx, id, true);
      if (expectedVersionId && row.report.currentVersionId !== expectedVersionId)
        throw new ConflictException("定制版本已更新，请刷新详情");
      if (thumbnail) {
        const projection = await this.readModel(tx, row.report, row.order.addressStatus, true);
        const image = projection?.thumbnails.find((candidate) => candidate.key === key);
        if (!image) throw new NotFoundException("订单缩略图不存在或已到保存期限");
        await this.access(tx, context, row.report.orderId);
        return {
          body: Buffer.from(image.contentBase64, "base64"),
          mediaType: "image/png",
          name: image.name,
          inline: true,
        };
      }
      const document = await this.readDocument(tx, row.report, row.order.addressStatus);
      if (!document) throw new NotFoundException("定制文件不存在或已到保存期限");
      const file = document.files.find((candidate) => candidate.key === key);
      if (!file) throw new NotFoundException("定制文件不存在");
      await this.access(tx, context, row.report.orderId);
      return {
        body: Buffer.from(file.contentBase64, "base64"),
        mediaType: file.mediaType,
        name: file.name,
        inline: ["preview", "buyer_image"].includes(file.role) && file.mediaType === "image/png",
      };
    });
  }

  /** Internal handoff only. Resolve an original from the immutable report version
   * selected by operations, even after a later report has become current. */
  async originalFromVersion(
    context: TenantContext,
    id: string,
    versionId: string,
    selectedKey: string,
  ) {
    authorize(context, Permission.OrderRead);
    authorize(context, Permission.OrderPiiRead);
    await this.cleanupExpired(context);
    return withTenant(this.database.db, context, async (tx) => {
      const row = await this.loadLine(tx, id);
      if (
        row.order.addressStatus === "anonymized" ||
        row.report.state === "expired" ||
        row.report.expiresAt <= new Date()
      )
        throw new NotFoundException("订单原图已到保存期限");
      const [version] = await tx
        .select()
        .from(versions)
        .where(and(eq(versions.id, versionId), eq(versions.reportLineId, id)));
      if (!version?.encryptedDocument || version.expiresAt <= new Date())
        throw new NotFoundException("推送时的原图版本已不可用");
      const document = this.vault.withSecret(
        version.encryptedDocument,
        (value) => JSON.parse(value) as StoredDocument,
      );
      const selected = document.files.find(
        (file) => file.key === selectedKey && file.role === "buyer_image",
      );
      const original =
        selected?.originalFileKey &&
        document.files.find((file) => file.key === selected.originalFileKey);
      if (!original) throw new NotFoundException("推送时未包含这张买家原图");
      await this.access(tx, context, row.report.orderId);
      return {
        body: Buffer.from(original.contentBase64, "base64"),
        name: original.name.split("/").at(-1)!,
        mediaType: original.mediaType,
      };
    });
  }

  private async batch(context: TenantContext, id: string): Promise<AmazonReportBatchView> {
    return withTenant(this.database.db, context, async (tx) => {
      const [row] = await tx.select().from(batches).where(eq(batches.id, id)).limit(1);
      if (!row) throw new NotFoundException("导入批次不存在");
      const items = await tx.select().from(batchItems).where(eq(batchItems.batchId, id));
      return AmazonReportBatchViewSchema.parse({
        ...toBatch(row),
        items: items.map(({ id, orderId, externalOrderId, status, errorCode }) => ({
          id,
          orderId,
          externalOrderId,
          status,
          errorCode,
        })),
      });
    });
  }

  private async account(context: TenantContext, id: string) {
    const [account] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, id)).limit(1),
    );
    if (!account || account.deletedAt) throw new NotFoundException("店铺不存在");
    return account;
  }

  private async loadLine(tx: TenantTransaction, id: string, protectRead = false) {
    const query = tx
      .select({ report: reportLines, order: orders, line: orderLines })
      .from(reportLines)
      .innerJoin(orders, eq(orders.id, reportLines.orderId))
      .innerJoin(orderLines, eq(orderLines.id, reportLines.orderLineId))
      .where(eq(reportLines.id, id))
      .limit(1)
      .$dynamic();
    if (protectRead) query.for("share", { of: orders });
    const [row] = await query;
    if (!row) throw new NotFoundException("订单行不存在");
    return row;
  }

  private async storeReadModel(
    tx: TenantTransaction,
    tenantId: string,
    versionId: string,
    projection: ReadModel,
  ) {
    await tx
      .insert(readModels)
      .values({
        tenantId,
        versionId,
        encryptedMetadata: this.vault.encrypt(JSON.stringify(projection.metadata)),
        encryptedThumbnails: this.vault.encrypt(JSON.stringify(projection.thumbnails)),
      })
      .onConflictDoNothing();
  }

  private async readModel(
    tx: TenantTransaction,
    line: Pick<ReportLine, "id" | "tenantId" | "currentVersionId" | "state" | "expiresAt">,
    addressStatus: string,
    thumbnails = false,
  ): Promise<ReadModel | null> {
    if (
      addressStatus === "anonymized" ||
      !line.currentVersionId ||
      !["ready", "partial"].includes(line.state) ||
      line.expiresAt <= new Date()
    )
      return null;
    const [row] = await tx
      .select({
        versionId: readModels.versionId,
        encryptedMetadata: readModels.encryptedMetadata,
        encryptedThumbnails: thumbnails ? readModels.encryptedThumbnails : sql<string | null>`null`,
        available: sql<boolean>`${versions.encryptedDocument} is not null`,
        expiresAt: versions.expiresAt,
      })
      .from(versions)
      .leftJoin(readModels, eq(readModels.versionId, versions.id))
      .where(and(eq(versions.id, line.currentVersionId), eq(versions.reportLineId, line.id)))
      .for("share", { of: versions });
    if (!row?.available || row.expiresAt <= new Date()) return null;
    if (row.versionId) {
      if (!row.encryptedMetadata) return null;
      return {
        metadata: this.vault.withSecret(
          row.encryptedMetadata,
          (value) => JSON.parse(value) as ReviewMetadata,
        ),
        thumbnails: row.encryptedThumbnails
          ? this.vault.withSecret(
              row.encryptedThumbnails,
              (value) => JSON.parse(value) as StoredFile[],
            )
          : [],
      };
    }
    // Existing immutable sources acquire a derived read model once, without rewriting their version.
    const document = await this.readDocument(tx, line, addressStatus);
    if (!document) return null;
    const projection = await createAmazonReportReadModel(document);
    await this.storeReadModel(tx, line.tenantId, line.currentVersionId, projection);
    return projection;
  }

  private async readDocument(
    tx: TenantTransaction,
    line: Pick<ReportLine, "id" | "currentVersionId" | "state" | "expiresAt">,
    addressStatus: string,
  ): Promise<StoredDocument | null> {
    if (
      addressStatus === "anonymized" ||
      !line.currentVersionId ||
      !["ready", "partial"].includes(line.state) ||
      line.expiresAt <= new Date()
    )
      return null;
    const [version] = await tx
      .select({ encryptedDocument: versions.encryptedDocument, expiresAt: versions.expiresAt })
      .from(versions)
      .where(and(eq(versions.id, line.currentVersionId), eq(versions.reportLineId, line.id)))
      .limit(1);
    if (!version?.encryptedDocument || version.expiresAt <= new Date()) return null;
    return this.vault.withSecret(
      version.encryptedDocument,
      (value) => JSON.parse(value) as StoredDocument,
    );
  }

  private async access(tx: TenantTransaction, context: TenantContext, orderId: string) {
    await tx.insert(orderProtectedAccessEvents).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      orderId,
      purpose: "fulfillment",
      actorUserId: context.userId,
      granted: true,
    });
  }

  async cleanupExpired(context: TenantContext) {
    await purgeExpiredAmazonOrderReports(this.database, context);
  }
}

function normalize(
  accountId: string,
  marketplaceId: string,
  source: ParsedAmazonReportOrder,
  reportType: "priced" | "unshipped",
  basis: { batchId: string; reportChecksum: string; reportCreatedAt: string },
): NormalizeOrderInput {
  const money = reportOrderMoney(source.lines);
  return {
    accountId,
    platform: "amazon",
    externalEventId: reportType === "unshipped"
      ? `report-deadline-aware:${basis.batchId}:${checksum(JSON.stringify(source))}`
      : `report:${marketplaceId}:${checksum(JSON.stringify(source))}`,
    externalOrderId: source.externalOrderId,
    providerStatus: "report_imported",
    placedAt: source.placedAt,
    orderTotal: money,
    lines: source.lines.map((line) => ({
      externalLineId: line.externalLineId,
      externalListingId: null,
      skuCode: line.skuCode,
      title: line.title,
      quantity: line.quantity,
      unitPrice: line.itemTotalMinor === null || line.currency === null ? null : {
        amountMinor: Math.round(line.itemTotalMinor / line.quantity),
        currency: line.currency,
      },
      customizationCount: line.customizedUrl || line.customizedPage ? 1 : 0,
    })),
    protectedDetails: source.protectedDetails,
    redactedSource: {
      source: "amazon_manual_report",
      reportType,
      marketplaceId,
      lineCount: source.lines.length,
      ...amazonReportDeadlineEvidence(source, reportType, { ...basis, marketplaceId }),
    },
  };
}

/** Missing financial evidence is unknown, never a zero-valued order. */
function reportOrderMoney(lines: ParsedAmazonReportOrder["lines"]): NormalizeOrderInput["orderTotal"] {
  const currency = lines[0]?.currency;
  if (!currency || lines.some(line => line.currency !== currency || line.itemTotalMinor === null ||
    line.shippingTotalMinor === null || line.taxTotalMinor === null)) return null;
  const total = lines.reduce((sum, line) => sum + line.itemTotalMinor! + line.shippingTotalMinor! + line.taxTotalMinor!, 0);
  if (!Number.isSafeInteger(total)) throw new UnprocessableEntityException({ code: "report_amount_out_of_range" });
  return { amountMinor: total, currency };
}

function toBatch(row: typeof batches.$inferSelect): AmazonReportBatchView {
  return AmazonReportBatchViewSchema.parse({
    id: row.id,
    accountId: row.accountId,
    marketplaceId: row.marketplaceId,
    fileName: row.fileName,
    rowCount: row.rowCount,
    orderCount: row.orderCount,
    newOrderCount: row.newOrderCount,
    duplicateOrderCount: row.duplicateOrderCount,
    failedOrderCount: row.failedOrderCount,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });
}

function toLine(
  report: SummaryReportLine,
  order: typeof orders.$inferSelect,
  line: typeof orderLines.$inferSelect,
): AmazonReportLineView {
  return AmazonReportLineViewSchema.parse({
    id: report.id,
    orderId: report.orderId,
    orderLineId: report.orderLineId,
    externalOrderId: order.externalOrderId,
    externalLineId: line.externalLineId,
    skuCode: line.skuCode,
    title: line.title,
    quantity: line.quantity,
    currency: report.currency,
    itemTotalMinor: report.itemTotalMinor,
    state: report.state,
    versionNumber: report.versionNumber,
    reviewed:
      !!report.currentVersionId &&
      report.reviewedVersionId === report.currentVersionId &&
      ["ready", "partial"].includes(report.state),
    lastErrorCode: report.lastErrorCode,
    updatedAt: report.updatedAt.toISOString(),
    hasPreview: report.hasPreview && ["ready", "partial"].includes(report.state),
  });
}

function checksum(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex");
}
function lockLine(tx: TenantTransaction, context: TenantContext, id: string) {
  return tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${id}:amazon-report-line`}, 0))`,
  );
}
