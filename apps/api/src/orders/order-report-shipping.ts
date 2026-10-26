import { createHash } from "node:crypto";
import { ConflictException, NotFoundException, UnprocessableEntityException } from "@nestjs/common";
import type { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, EntityIdSchema, type TenantContext } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import {
  amazonOrderReportBatches as batches, amazonOrderReportBatchItems as batchItems,
  amazonOrderReportLines as reportLines, marketplaceAccounts, orders, orderLines,
  orderProtectedDetails, orderSourceSnapshots, type DatabaseConnection,
} from "@yummyai/database";
import { currentOrderAuthority, withOrderAuthority } from "@yummyai/order-core";
import { parseAmazonOrderReport, type ParsedAmazonReportOrder } from "@yummyai/order-intake";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { AuditService } from "../audit/audit.service.js";

type DeadlineOrder = Pick<ParsedAmazonReportOrder, "externalOrderId"> & {
  lines: Array<Pick<ParsedAmazonReportOrder["lines"][number], "externalLineId" | "quantity" | "skuCode" | "platformShipByAt">>;
};
type ReportDeadlineBasis = { batchId: string; reportChecksum: string; reportCreatedAt: string; marketplaceId: string };
const checksum = (value: string) => createHash("sha256").update(value).digest("hex");
function conflict(code: string): never { throw new ConflictException({ code }); }

/** Non-PII source evidence shared by new imports and the bounded historic refresh. */
export function amazonReportDeadlineEvidence(source: DeadlineOrder, reportType: "priced" | "unshipped", basis: ReportDeadlineBasis): Record<string, unknown> {
  if (reportType !== "unshipped") return {};
  return {
    source: "amazon_manual_report", reportType, marketplaceId: basis.marketplaceId,
    orderId: source.externalOrderId, batchId: basis.batchId, reportChecksum: basis.reportChecksum,
    reportCreatedAt: basis.reportCreatedAt,
    platformShipBySource: "amazon_unshipped_report_promise_date", platformShipByField: "promise-date",
    platformShipByAtByLine: Object.fromEntries(source.lines.map(line => [line.externalLineId, line.platformShipByAt ?? null])),
  };
}

/** Native order owner operation: only immutable source siblings and its audit. */
export async function refreshAmazonReportPlatformDeadlines(
  dependencies: { database: DatabaseConnection; vault: SecretVault; audit: AuditService },
  context: TenantContext,
  batchId: string,
) {
  EntityIdSchema.parse(batchId);
  const required = [Permission.OrderWrite, Permission.OrderPiiRead];
  return withOrderAuthority(dependencies.database.db, context, required, async tx => {
    const authority = await currentOrderAuthority(tx, context, required, { lock: true, requireMembership: true });
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${batchId}:report-deadline`},0))`);
    const [initial] = await tx.select().from(batches).where(eq(batches.id, batchId));
    if (!initial) throw new NotFoundException("订单报告批次不存在");
    const [account] = await tx.select().from(marketplaceAccounts).where(eq(marketplaceAccounts.id, initial.accountId)).for("share");
    if (!account || account.deletedAt) throw new NotFoundException("订单报告批次不存在");
    if (account.platform !== "amazon" || ["disabled", "revoked"].includes(account.status) ||
      account.marketplaceIds.length > 0 && !account.marketplaceIds.includes(initial.marketplaceId))
      conflict("report_deadline_account_unavailable");
    const items = await tx.select().from(batchItems).where(eq(batchItems.batchId, batchId));
    const ids = items.flatMap(item => item.orderId ? [item.orderId] : []);
    if (!ids.length || new Set(ids).size !== items.length || items.some(item => !["imported", "duplicate"].includes(item.status)))
      conflict("report_deadline_batch_incomplete");
    // Match the retention owner's parent-first lock order. Immutable source and
    // batch-item tables need no UPDATE privilege or row locks.
    const orderRows = await tx.select().from(orders).where(inArray(orders.id, ids)).orderBy(orders.id).for("share");
    const [batch] = await tx.select().from(batches).where(eq(batches.id, batchId)).for("share");
    const [clock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    const now = new Date(clock.now);
    if (!batch || batch.accountId !== account.id || batch.marketplaceId !== initial.marketplaceId || batch.status !== "completed" ||
      batch.failedOrderCount !== 0 || batch.newOrderCount + batch.duplicateOrderCount !== batch.orderCount ||
      batch.orderCount !== items.length || batch.orderCount > 1_000 || !batch.encryptedReport) conflict("report_deadline_batch_unavailable");
    if (batch.expiresAt <= now) conflict("report_deadline_source_expired");
    if (orderRows.length !== ids.length || orderRows.some(order => order.accountId !== batch.accountId || order.platform !== "amazon" || order.addressStatus === "anonymized"))
      conflict("report_deadline_order_identity_mismatch");
    const privacy = await tx.select().from(orderProtectedDetails).where(inArray(orderProtectedDetails.orderId, ids)).orderBy(orderProtectedDetails.orderId).for("share");
    const privateReports = await tx.select().from(reportLines).where(inArray(reportLines.orderId, ids)).orderBy(reportLines.id).for("share");
    if (privacy.length !== ids.length || privacy.some(row => row.status !== "protected" || !row.encryptedEnvelope || row.retentionExpiresAt <= now) ||
      privateReports.some(row => row.state === "expired" || row.expiresAt <= now)) conflict("report_deadline_source_expired");
    const encryptedReport = batch.encryptedReport;
    if (!encryptedReport) conflict("report_deadline_batch_unavailable");
    let parsed: { reportType: "priced" | "unshipped"; rowCount: number; orders: DeadlineOrder[] };
    try {
      parsed = dependencies.vault.withSecret(encryptedReport, content => {
        if (Buffer.byteLength(content, "utf8") > 5 * 1024 * 1024) throw new Error("report_deadline_original_too_large");
        if (checksum(content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n")) !== batch.reportChecksum)
          throw new Error("report_deadline_checksum_mismatch");
        const original = parseAmazonOrderReport(content);
        return { reportType: original.reportType, rowCount: original.rowCount,
          orders: original.orders.map(order => ({ externalOrderId: order.externalOrderId,
            lines: order.lines.map(line => ({ externalLineId: line.externalLineId, skuCode: line.skuCode,
              quantity: line.quantity, platformShipByAt: line.platformShipByAt ?? null })) })) };
      });
    } catch { throw new UnprocessableEntityException({ code: "report_deadline_original_invalid" }); }
    if (parsed.reportType !== "unshipped" || parsed.orders.length !== batch.orderCount || parsed.rowCount !== batch.rowCount)
      conflict("report_deadline_report_family_mismatch");
    const lines = await tx.select().from(orderLines).where(inArray(orderLines.orderId, ids)).orderBy(orderLines.id).for("share");
    const sources: Array<{ orderId: string; sourceVersionId: string }> = [];
    let addedSources = 0, deadlinesKnown = 0, deadlinesMissing = 0;
    for (const source of parsed.orders) {
      const item = items.find(candidate => candidate.externalOrderId === source.externalOrderId);
      const order = orderRows.find(candidate => candidate.id === item?.orderId && candidate.externalOrderId === source.externalOrderId);
      if (!order) conflict("report_deadline_order_identity_mismatch");
      for (const line of source.lines) {
        const current = lines.find(candidate => candidate.orderId === order.id && candidate.externalLineId === line.externalLineId);
        if (!current || current.skuCode !== line.skuCode || current.quantity !== line.quantity)
          conflict("report_deadline_line_identity_mismatch");
        if (line.platformShipByAt) deadlinesKnown++; else deadlinesMissing++;
      }
      const payload = amazonReportDeadlineEvidence(source, parsed.reportType, {
        batchId, reportChecksum: batch.reportChecksum, reportCreatedAt: batch.createdAt.toISOString(), marketplaceId: batch.marketplaceId,
      });
      const payloadChecksum = checksum(canonicalJson(payload));
      const externalEventId = `report-deadline:${batchId}:${source.externalOrderId}`;
      const [existing] = await tx.select().from(orderSourceSnapshots).where(and(
        eq(orderSourceSnapshots.accountId, batch.accountId), eq(orderSourceSnapshots.platform, "amazon"), eq(orderSourceSnapshots.externalEventId, externalEventId),
      ));
      if (existing) {
        if (existing.normalizedOrderId !== order.id || existing.externalOrderId !== source.externalOrderId ||
          existing.payloadChecksum !== payloadChecksum || canonicalJson(existing.redactedPayload) !== canonicalJson(payload))
          conflict("report_deadline_replay_mismatch");
        sources.push({ orderId: order.id, sourceVersionId: existing.id });
      } else {
        const id = createEntityId();
        await tx.insert(orderSourceSnapshots).values({ id, tenantId: context.tenantId, accountId: batch.accountId, platform: "amazon",
          externalEventId, externalOrderId: source.externalOrderId, normalizedOrderId: order.id, redactedPayload: payload, payloadChecksum });
        sources.push({ orderId: order.id, sourceVersionId: id }); addedSources++;
      }
    }
    const [finishedClock] = await tx.execute<{ now: Date }>(sql`select clock_timestamp() as now`);
    const finishedAt = new Date(finishedClock.now);
    if (batch.expiresAt <= finishedAt || privacy.some(row => row.retentionExpiresAt <= finishedAt) ||
      privateReports.some(row => row.expiresAt <= finishedAt)) conflict("report_deadline_source_expired");
    await dependencies.audit.recordInTransaction(tx, authority, {
      action: "order.report.platform_deadlines.refresh", resourceType: "amazon_order_report", resourceId: batchId, result: "success",
      metadata: { accountId: batch.accountId, reportChecksum: batch.reportChecksum, source: "amazon_unshipped_report_promise_date",
        addedSources, replayed: addedSources === 0, deadlinesKnown, deadlinesMissing, sourceVersionIds: sources.map(source => source.sourceVersionId) },
    });
    return { batchId, addedSources, replayed: addedSources === 0, deadlinesKnown, deadlinesMissing, sources };
  });
}
