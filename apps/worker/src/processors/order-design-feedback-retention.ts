import type { TenantContext } from "@yummyai/contracts";
import { orderDesignAgentRuns as runs, orderWorkItems as works, orderLines, orders, withTenant, type DatabaseConnection } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { and, eq, isNull, lte, or, sql } from "drizzle-orm";

/** Ciphertext cleanup uses locators only. It never decrypts feedback, buyer
 * originals or project layers, and cannot erase references for a live order. */
export async function purgeExpiredOrderDesignFeedback(database: DatabaseConnection, context: TenantContext,
  storage: Pick<Storage, "purgeExpiredOrderDesignFeedback"> | undefined, now = new Date()) {
  if (Number.isNaN(now.getTime())) throw new TypeError("A valid feedback retention cutoff is required");
  const expired = or(lte(works.expiresAt, now), eq(orders.addressStatus, "anonymized"));
  const candidates = await withTenant(database.db, context, tx => tx.select({ id: runs.id, workItemId: runs.workItemId }).from(runs)
    .innerJoin(works, eq(works.id, runs.workItemId)).innerJoin(orderLines, eq(orderLines.id, works.id)).innerJoin(orders, eq(orders.id, orderLines.orderId))
    .where(and(expired, isNull(runs.revisionFeedbackPurgedAt), sql`jsonb_array_length(${runs.revisionFeedbackObjects})>0`)).limit(100));
  if (candidates.length && !storage) throw new Error("ORDER_DESIGN_FEEDBACK_PURGER_UNAVAILABLE");
  for (const candidate of candidates) await withTenant(database.db, context, async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`order-work:${candidate.workItemId}`},0))`);
    const read = () => tx.select({ run: runs, workId: works.id }).from(runs)
      .innerJoin(works, eq(works.id, runs.workItemId)).innerJoin(orderLines, eq(orderLines.id, works.id)).innerJoin(orders, eq(orders.id, orderLines.orderId))
      .where(and(eq(runs.id, candidate.id), expired, isNull(runs.revisionFeedbackPurgedAt))).for("update");
    const [source] = await read(); if (!source) return;
    for (const object of source.run.revisionFeedbackObjects) await storage!.purgeExpiredOrderDesignFeedback({
      tenantId: context.tenantId, attachmentId: object.id, objectKey: object.objectKey,
    }, { assertExpired: async () => {
      const [current] = await read();
      if (!current || !current.run.revisionFeedbackObjects.some(pin => pin.id === object.id && pin.objectKey === object.objectKey))
        throw new Error("ORDER_DESIGN_FEEDBACK_RETENTION_CHANGED");
    } });
    await tx.update(runs).set({ revisionFeedbackPurgedAt: now }).where(eq(runs.id, candidate.id));
  });
  return { purgedRuns: candidates.length };
}
