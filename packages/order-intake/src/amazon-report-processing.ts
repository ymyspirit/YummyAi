import { createHash } from "node:crypto";
import type { SecretVault } from "@yummyai/ai-core";
import { ForbiddenError, Permission, intersectPermissionContexts, requireTenantOrderPermissions } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { amazonOrderReportLines as reportLines, amazonOrderReportVersions as versions, amazonOrderReportReadModels as readModels, amazonOrderReportProcessingRequests as requests, marketplaceAccounts, orders, orderLines, auditEvents, loadCurrentMembershipContext, purgeExpiredAmazonOrderReports, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { AMAZON_CUSTOM_PARSER_REVISION, parseAmazonCustomArchive } from "./amazon-custom-archive.js";
import { AmazonArchiveAccessError, type AmazonReportArchiveGateway, MAX_AMAZON_ARCHIVE_BYTES } from "./amazon-report-archive.gateway.js";
import { createAmazonReportReadModel, type StoredDocument, type StoredSource, type ReadModel } from "./amazon-report-read-model.js";

export class AmazonReportProcessingError extends Error {
  constructor(readonly code: "conflict" | "invalid" | "not_found" | "busy" | "superseded", message: string) { super(message); this.name = "AmazonReportProcessingError"; }
}

/** The single archive execution path shared by HTTP recovery and the Worker. */
export class AmazonReportArchiveProcessor {
  constructor(private readonly database: DatabaseConnection, private readonly vault: SecretVault, private readonly gateway: AmazonReportArchiveGateway) {}
  private readonly audit = { recordInTransaction: async (tx: TenantTransaction, context: TenantContext, event: { action: string; resourceType: string; resourceId: string; result: "success" | "failure"; metadata: Record<string, unknown> }) => {
    await tx.insert(auditEvents).values({ id: createEntityId(), tenantId: context.tenantId, actorUserId: context.userId, action: event.action, entityType: event.resourceType, entityId: event.resourceId, result: event.result, metadata: event.metadata });
  }};
  async process(
    context: TenantContext,
    id: string,
    expectedVersionId: string | null,
    upload?: Uint8Array,
    requestId?: string,
  ): Promise<void> {
    requireTenantOrderPermissions(context, [Permission.OrderWrite, Permission.OrderPiiRead]);
    if (upload && (!upload.byteLength || upload.byteLength > MAX_AMAZON_ARCHIVE_BYTES))
      throw new AmazonReportProcessingError("invalid", "ZIP 大小必须为 1 字节至 20 MiB");
    await purgeExpiredAmazonOrderReports(this.database, context);
    const token = createEntityId();
    const claimed = await withTenant(this.database.db, context, async (tx) => {
      await this.currentAuthority(tx, context, requestId !== undefined);
      await lockLine(tx, context, id);
      const row = await this.loadLine(tx, id);
      const [request] = requestId ? await tx.select().from(requests).where(and(eq(requests.reportLineId, id), eq(requests.requestId, requestId))) : [];
      if (requestId && (!request || !["pending", "processing"].includes(request.status)))
        throw new AmazonReportProcessingError("superseded", "后台附件任务已完成或被替代");
      if (request && (request.sourceChecksum !== row.report.sourceChecksum || request.expectedVersionId !== row.report.currentVersionId || request.requestedBy !== context.userId))
        throw new AmazonReportProcessingError("superseded", "后台附件任务的来源或版本已变化");
      if (
        row.report.state === "expired" ||
        row.order.addressStatus === "anonymized" ||
        !row.report.encryptedSource
      )
        throw new AmazonReportProcessingError("conflict", "定制资料已到保存期限，不能重新获取");
      if (row.report.currentVersionId !== expectedVersionId)
        throw new AmazonReportProcessingError("conflict", "定制版本已更新，请刷新后操作");
      if (row.report.lastErrorCode === "report_conflict")
        throw new AmazonReportProcessingError("conflict", "报告商品或数量与现有订单不一致，请先核对来源");
      const [account] = await tx.select({ status: marketplaceAccounts.status }).from(marketplaceAccounts).where(eq(marketplaceAccounts.id, row.order.accountId));
      if (!account || ["disabled", "revoked"].includes(account.status))
        throw new AmazonReportProcessingError("conflict", "店铺已停用，无法继续解析附件");
      if (
        row.report.processingStartedAt &&
        Date.now() - row.report.processingStartedAt.getTime() < 120_000
      )
        throw new AmazonReportProcessingError("busy", "该订单行正在解析，请稍后刷新");
      if (request && request.attemptCount >= 3)
        throw new AmazonReportProcessingError("superseded", "后台附件任务已达到重试上限");
      const source = this.vault.withSecret(
        row.report.encryptedSource,
        (value) => JSON.parse(value) as StoredSource,
      );
      if (request) {
        await tx.update(requests).set({ status: "processing", attemptCount: request.attemptCount + 1, lastErrorCode: null, updatedAt: new Date() }).where(eq(requests.requestId, request.requestId));
      } else {
        // An explicit operator retry/upload owns the new execution. A queued old task
        // must never later overwrite its version or undo its review.
        await tx.update(requests).set({ status: "superseded", updatedAt: new Date() }).where(and(eq(requests.reportLineId, id), inArray(requests.status, ["pending", "processing"])));
      }
      await tx
        .update(reportLines)
        .set({
          state: "processing",
          processingToken: token,
          processingStartedAt: new Date(),
          lastErrorCode: null,
          updatedAt: new Date(),
        })
        .where(eq(reportLines.id, id));
      return { ...row, source, attemptCount: request ? request.attemptCount + 1 : 0 };
    });
    try {
      if (!upload && !claimed.source.line.customizedUrl)
        throw new AmazonArchiveAccessError("customization_missing");
      // The claim transaction has ended. A revoked actor must not start another
      // download or process bytes that arrived after that authority was removed.
      await withTenant(this.database.db, context, tx => this.currentAuthority(tx, context, requestId !== undefined));
      const body = upload ?? (await this.gateway.download(claimed.source.line.customizedUrl!));
      await withTenant(this.database.db, context, tx => this.currentAuthority(tx, context, requestId !== undefined));
      let evidence;
      try {
        evidence = await this.gateway.scan(body);
      } catch {
        throw new AmazonArchiveAccessError("scan_unavailable");
      }
      if (evidence.result !== "clean" || evidence.signatureVersion === "unavailable")
        throw new AmazonArchiveAccessError(
          evidence.result === "infected" ? "file_rejected" : "scan_unavailable",
        );
      const parsed = await parseAmazonCustomArchive(body, {
        externalOrderId: claimed.order.externalOrderId,
        externalLineId: claimed.line.externalLineId,
      });
      const raw = parsed.document.raw as Record<string, unknown> | null;
      if (
        raw &&
        typeof raw.marketplaceId === "string" &&
        raw.marketplaceId !== claimed.source.marketplaceId
      )
        throw new AmazonArchiveAccessError("marketplace_mismatch");
      const account = await this.account(context, claimed.order.accountId);
      if (
        raw &&
        account.externalAccountId &&
        typeof raw.merchantId === "string" &&
        raw.merchantId !== account.externalAccountId
      )
        throw new AmazonArchiveAccessError("merchant_mismatch");
      if (raw && typeof raw.quantity === "number" && raw.quantity !== claimed.line.quantity)
        throw new AmazonArchiveAccessError("quantity_mismatch");
      const warnings = [...new Set([...claimed.source.warnings, ...parsed.document.warnings])];
      parsed.document.warnings =
        warnings.length > 499
          ? [...warnings.slice(0, 499), "诊断条目较多，仅显示前 499 条，请检查原始报告。"]
          : warnings;
      const stored: StoredDocument = {
        parserRevision: AMAZON_CUSTOM_PARSER_REVISION,
        document: parsed.document,
        files: parsed.files.map((file) => ({
          key: file.key,
          name: file.name,
          mediaType: file.mediaType,
          role: file.role,
          originalFileKey: file.originalFileKey,
          width: file.width,
          height: file.height,
          byteSize: file.body.byteLength,
          contentBase64: Buffer.from(file.body).toString("base64"),
        })),
      };
      const digest = checksum(body);
      const protectedDocument = this.vault.encrypt(JSON.stringify(stored));
      const protectedArchive = this.vault.encrypt(Buffer.from(body).toString("base64"));
      const readModel = await createAmazonReportReadModel(stored);
      await withTenant(this.database.db, context, async (tx) => {
        await this.currentAuthority(tx, context, requestId !== undefined);
        await lockLine(tx, context, id);
        const row = await this.loadLine(tx, id);
        const [currentRequest] = requestId ? await tx.select().from(requests).where(and(eq(requests.reportLineId, id), eq(requests.requestId, requestId), eq(requests.status, "processing"))) : [];
        if (
          (requestId && !currentRequest) ||
          row.report.processingToken !== token ||
          row.report.sourceChecksum !== claimed.report.sourceChecksum ||
          row.report.expiresAt <= new Date() ||
          row.order.addressStatus === "anonymized"
        )
          throw new AmazonReportProcessingError("superseded", "来源已更新，旧解析结果已丢弃");
        const [prior] = row.report.currentVersionId
          ? await tx
              .select()
              .from(versions)
              .where(eq(versions.id, row.report.currentVersionId))
              .limit(1)
          : [];
        const unchanged =
          prior?.checksum === digest &&
          !!prior.encryptedDocument &&
          this.vault.withSecret(
            prior.encryptedDocument,
            (value) =>
              (JSON.parse(value) as StoredDocument).parserRevision ===
               AMAZON_CUSTOM_PARSER_REVISION,
           );
        // A changed remote archive may be older than an operator's replacement.
        // Keep the accepted source pinned until an explicit operator action chooses
        // the new bytes. Parser-only changes still create a new unreviewed version.
        if (requestId && prior && prior.checksum !== digest)
          throw new AmazonArchiveAccessError("attachment_changed");
        const versionId = unchanged ? row.report.currentVersionId! : createEntityId();
        const versionNumber = unchanged ? row.report.versionNumber : row.report.versionNumber + 1;
        if (!unchanged)
          await tx.insert(versions).values({
            id: versionId,
            tenantId: context.tenantId,
            reportLineId: id,
            versionNumber,
            checksum: digest,
            encryptedDocument: protectedDocument,
            encryptedArchive: protectedArchive,
            scanEngine: evidence.engine,
            scanSignature: evidence.signatureVersion,
            expiresAt: row.report.expiresAt,
          });
        await this.storeReadModel(tx, context.tenantId, versionId, readModel);
        await tx
          .update(reportLines)
          .set({
            currentVersionId: versionId,
            versionNumber,
            state: parsed.document.warnings.length ? "partial" : "ready",
            processingToken: null,
            processingStartedAt: null,
            lastErrorCode: null,
            updatedAt: new Date(),
            hasPreview: parsed.document.surfaces.some((surface) => !!surface.previewFileKey),
            ...(!unchanged ? { reviewedVersionId: null, reviewedBy: null, reviewedAt: null } : {}),
          })
          .where(eq(reportLines.id, id));
        if (requestId) await tx.update(requests).set({ status: "completed", lastErrorCode: null, updatedAt: new Date() }).where(eq(requests.requestId, requestId));
        await this.audit.recordInTransaction(tx, context, {
          action: "order.report.parsed",
          resourceType: "amazon_order_report_line",
          resourceId: id,
          result: "success",
          metadata: { versionNumber, unchanged },
        });
      });
    } catch (error) {
      const code = error instanceof ForbiddenError ? "processing_blocked" : error instanceof AmazonArchiveAccessError ? error.code : "archive_invalid";
      await withTenant(this.database.db, context, async (tx) => {
        await lockLine(tx, context, id);
        const [current] = await tx.select({ processingToken: reportLines.processingToken, state: reportLines.state,
          expiresAt: reportLines.expiresAt, retained: sql<boolean>`${reportLines.encryptedSource} is not null`,
        }).from(reportLines).where(eq(reportLines.id, id));
        // This metadata-only settlement cannot adopt bytes or revive erased or
        // superseded sources, even when the original operator has lost access.
        if (current?.processingToken !== token || current.state === "expired" ||
          current.expiresAt <= new Date() || !current.retained) return;
        const retry = !!requestId && shouldRetryAmazonArchive(code, claimed.attemptCount);
        await tx
          .update(reportLines)
          .set({
            state: retry ? "pending" : "failed",
            lastErrorCode: code,
            processingToken: null,
            processingStartedAt: null,
            updatedAt: new Date(),
          })
          .where(and(eq(reportLines.id, id), eq(reportLines.processingToken, token)));
        if (requestId) await tx.update(requests).set({ status: retry ? "pending" : "failed", lastErrorCode: code, updatedAt: new Date() }).where(eq(requests.requestId, requestId));
        await this.audit.recordInTransaction(tx, context, {
          action: "order.report.parse_failed",
          resourceType: "amazon_order_report_line",
          resourceId: id,
          result: "failure",
          metadata: { code },
        });
      });
      if (error instanceof ForbiddenError) throw error;
    }
    return;
  }

  private async currentAuthority(tx: TenantTransaction, input: TenantContext, requireMembership: boolean) {
    const required = [Permission.OrderWrite, Permission.OrderPiiRead] as const;
    requireTenantOrderPermissions(input, required);
    // Persisted background tasks always require a current member. Explicit
    // server credential adapters retain the existing no-membership HTTP mode.
    const current = requireMembership || input.permissionScopes !== undefined
      ? await loadCurrentMembershipContext(tx, input, { lock: true }) : input;
    requireTenantOrderPermissions(intersectPermissionContexts(input, current), required);
  }

  private async account(context: TenantContext, id: string) {
    const [account] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, id)).limit(1),
    );
    if (!account) throw new AmazonReportProcessingError("not_found", "店铺不存在");
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
      .for("update", { of: reportLines })
      .$dynamic();
    if (protectRead) query.for("share", { of: orders });
    const [row] = await query;
    if (!row) throw new AmazonReportProcessingError("not_found", "订单行不存在");
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

}

function checksum(value: string | Uint8Array) { return createHash("sha256").update(value).digest("hex"); }
export function shouldRetryAmazonArchive(code: string, attemptCount: number) { return attemptCount < 3 && ["download_failed", "download_timeout", "scan_unavailable"].includes(code); }
async function lockLine(tx: TenantTransaction, context: TenantContext, id: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${id}:amazon-report-line`}, 0))`); }
