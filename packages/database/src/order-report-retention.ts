import type { TenantContext } from "@yummyai/contracts";
import { and, eq, inArray, isNotNull, lte, ne, or } from "drizzle-orm";

import type { DatabaseConnection } from "./client.js";
import {
  amazonOrderReportBatches as batches, amazonOrderReportBatchItems as batchItems,
  amazonOrderReportLines as reportLines, amazonOrderReportVersions as versions,
} from "./schema/order-report.js";
import { orderProtectedDetails, orders } from "./schema/order.js";
import { productionEditorProjects } from "./schema/production-editor.js";
import { withTenant } from "./tenant-transaction.js";

/** Clear encrypted report evidence without decrypting it or leaving the tenant transaction. */
export async function purgeExpiredAmazonOrderReports(database: DatabaseConnection, context: TenantContext, now = new Date()): Promise<void> {
  if (Number.isNaN(now.getTime())) throw new TypeError("A valid retention cutoff is required");
  await withTenant(database.db, context, async (tx) => {
    // Look at lifecycle state, not remaining ciphertext: a previous run may already
    // have removed the source while a later report still contains the same order.
    const erased = await tx.select({ id: reportLines.id, orderId: orders.id }).from(reportLines).innerJoin(orders, eq(orders.id, reportLines.orderId))
      .where(or(eq(orders.addressStatus, "anonymized"), eq(reportLines.state, "expired"), lte(reportLines.expiresAt, now)))
      .orderBy(orders.id, reportLines.id).for("update", { of: orders });
    if (erased.length) {
      const erasedLineIds = erased.map((row) => row.id);
      await tx.update(versions).set({ encryptedArchive: null, encryptedDocument: null })
        .where(and(inArray(versions.reportLineId, erasedLineIds), or(isNotNull(versions.encryptedDocument), isNotNull(versions.encryptedArchive))));
      await tx.update(reportLines).set({ encryptedSource: null, state: "expired", lastErrorCode: "retention_expired", hasPreview: false, processingToken: null, processingStartedAt: null })
        .where(and(inArray(reportLines.id, erasedLineIds), or(isNotNull(reportLines.encryptedSource), ne(reportLines.state, "expired"), eq(reportLines.hasPreview, true), isNotNull(reportLines.processingToken))));
    }
    await tx.update(batches).set({ encryptedReport: null }).where(and(lte(batches.expiresAt, now), isNotNull(batches.encryptedReport)));
    await tx.update(versions).set({ encryptedArchive: null, encryptedDocument: null }).where(and(lte(versions.expiresAt, now), or(isNotNull(versions.encryptedDocument), isNotNull(versions.encryptedArchive))));
    // Only report-associated, expired orders are touched; other orders retain their own policy.
    const expired = await tx.selectDistinct({ orderId: reportLines.orderId }).from(reportLines).where(eq(reportLines.state, "expired"));
    if (expired.length) {
      const changed = await tx.update(orderProtectedDetails).set({ encryptedEnvelope: null, status: "anonymized", countryCode: null, anonymizedAt: now, updatedAt: now })
        .where(and(inArray(orderProtectedDetails.orderId, expired.map((row) => row.orderId)), lte(orderProtectedDetails.retentionExpiresAt, now), eq(orderProtectedDetails.status, "protected")))
        .returning({ orderId: orderProtectedDetails.orderId });
      if (changed.length) {
        const changedOrderIds = changed.map((row) => row.orderId);
        await tx.update(orders).set({ addressStatus: "anonymized", addressCountryCode: null }).where(inArray(orders.id, changedOrderIds));
        // Later imports may have added sibling lines with later expiries. Once
        // the containing order is anonymized, clear those in this same run.
        const siblingLines = await tx.select({ id: reportLines.id }).from(reportLines).where(inArray(reportLines.orderId, changedOrderIds));
        if (siblingLines.length) {
          const siblingIds = siblingLines.map((row) => row.id);
          await tx.update(versions).set({ encryptedArchive: null, encryptedDocument: null })
            .where(and(inArray(versions.reportLineId, siblingIds), or(isNotNull(versions.encryptedDocument), isNotNull(versions.encryptedArchive))));
          await tx.update(reportLines).set({ encryptedSource: null, state: "expired", lastErrorCode: "retention_expired", hasPreview: false, processingToken: null, processingStartedAt: null })
            .where(and(inArray(reportLines.id, siblingIds), or(isNotNull(reportLines.encryptedSource), ne(reportLines.state, "expired"), eq(reportLines.hasPreview, true), isNotNull(reportLines.processingToken))));
        }
      }
    }
    // A batch can mix new and old orders. Its encrypted original must be erased
    // when any included order expires, even if this batch has a later deadline.
    const affectedBatches = await tx.selectDistinct({ id: batchItems.batchId }).from(batchItems)
      .innerJoin(orders, eq(orders.id, batchItems.orderId))
      .leftJoin(reportLines, eq(reportLines.orderId, orders.id))
      .where(or(eq(orders.addressStatus, "anonymized"), eq(reportLines.state, "expired"), lte(reportLines.expiresAt, now)));
    if (affectedBatches.length) await tx.update(batches).set({ encryptedReport: null })
      .where(and(inArray(batches.id, affectedBatches.map((row) => row.id)), isNotNull(batches.encryptedReport)));
    // Production copies inherit their source order's deadline. Erasing the
    // per-project key also makes encrypted original/preview/render blobs unreadable.
    const expiredSourceLines = await tx.select({ id: reportLines.id }).from(reportLines)
      .innerJoin(orders, eq(orders.id, reportLines.orderId))
      .where(or(eq(orders.addressStatus, "anonymized"), eq(reportLines.state, "expired"), lte(reportLines.expiresAt, now)));
    await tx.update(productionEditorProjects).set({ encryptedDataKey: null, status: "expired", name: "已到期生产项目", updatedAt: now })
      .where(and(isNotNull(productionEditorProjects.encryptedDataKey), or(
        lte(productionEditorProjects.expiresAt, now),
        expiredSourceLines.length ? inArray(productionEditorProjects.sourceReportLineId, expiredSourceLines.map((row) => row.id)) : undefined,
      )));
  });
}
