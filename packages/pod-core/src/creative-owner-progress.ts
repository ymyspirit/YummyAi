import { creativeDesignBatches, creativeDesignBatchItems, creativeDesignCandidates, type TenantTransaction } from "@yummyai/database";
import { asc, eq, inArray } from "drizzle-orm";

const closedItem = (status: string) => status === "completed" || status === "cancelled";

export async function lockCreativeParent(tx: TenantTransaction, batchId: string) {
  const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, batchId)).for("update");
  return batch && !batch.archivedAt && !closedItem(batch.status) ? batch : undefined;
}


export async function refreshCreativeProgress(tx: TenantTransaction, batchId: string) {
  if (!await lockCreativeParent(tx, batchId)) return;
  const items = await tx.select({ id: creativeDesignBatchItems.id, status: creativeDesignBatchItems.status }).from(creativeDesignBatchItems)
    .where(eq(creativeDesignBatchItems.batchId, batchId)).orderBy(asc(creativeDesignBatchItems.id)).for("update");
  if (!items.length) return;
  const candidates = await tx.select().from(creativeDesignCandidates).where(inArray(creativeDesignCandidates.itemId, items.map((item) => item.id)));
  for (const item of items) {
    if (closedItem(item.status)) continue;
    const statuses = candidates.filter((candidate) => candidate.itemId === item.id).map((candidate) => candidate.status);
    const itemStatus = statuses.every((status) => status === "failed") ? "failed"
      : statuses.every((status) => ["generated", "selected", "failed"].includes(status)) ? statuses.includes("failed") ? "partially_succeeded" : "awaiting_review"
        : statuses.some((status) => status === "running") ? "running" : "queued";
    await tx.update(creativeDesignBatchItems).set({ status: itemStatus, completedAt: ["failed", "partially_succeeded", "awaiting_review"].includes(itemStatus) ? new Date() : null, updatedAt: new Date() })
      .where(eq(creativeDesignBatchItems.id, item.id));
  }
  const generatedCount = candidates.filter((candidate) => ["generated", "selected"].includes(candidate.status)).length;
  const failedItemCount = items.filter((item) => {
    const statuses = candidates.filter((candidate) => candidate.itemId === item.id).map((candidate) => candidate.status);
    return statuses.every((status) => status === "failed");
  }).length;
  const terminal = candidates.every((candidate) => ["generated", "selected", "failed", "cancelled"].includes(candidate.status));
  const status = terminal ? generatedCount > 0 ? failedItemCount > 0 ? "partially_succeeded" : "awaiting_review" : "failed" : "running";
  await tx.update(creativeDesignBatches).set({
    status, generatedCount, failedCount: failedItemCount,
    completedAt: terminal ? new Date() : null, updatedAt: new Date(),
  }).where(eq(creativeDesignBatches.id, batchId));
}

