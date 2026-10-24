import { type creativeExecutions, creativeDesignBatches, creativeDesignBatchItems, creativeDesignCandidates, creativeDesignVersions,
  creativeStudioGenerations, mockupBatches, mockupBatchItems, mockupBatchOutputs, mockupTemplateSourceInspections,
  type TenantTransaction } from "@yummyai/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { creativeMockupStep } from "@yummyai/pod-core";

type Execution = typeof creativeExecutions.$inferSelect;
const closedItem = (status: string) => status === "completed" || status === "cancelled";

// Cancellation owns the parent before its children. Read only the association
// first, then acquire that same parent lock before taking child locks or writing.
// The child is reread under the lock: a pre-lock state is never mutation authority.
async function lockCreativeParent(tx: TenantTransaction, batchId: string) {
  const [batch] = await tx.select().from(creativeDesignBatches).where(eq(creativeDesignBatches.id, batchId)).for("update");
  return batch && !batch.archivedAt && !closedItem(batch.status) ? batch : undefined;
}

async function lockCreativeCandidate(tx: TenantTransaction, candidateId: string) {
  const [source] = await tx.select({ batchId: creativeDesignBatchItems.batchId }).from(creativeDesignCandidates)
    .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
    .where(eq(creativeDesignCandidates.id, candidateId));
  const batch = source ? await lockCreativeParent(tx, source.batchId) : undefined;
  if (!batch) return undefined;
  const [current] = await tx.select({ candidate: creativeDesignCandidates, item: creativeDesignBatchItems }).from(creativeDesignCandidates)
    .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
    .where(and(eq(creativeDesignCandidates.id, candidateId), eq(creativeDesignBatchItems.batchId, batch.id)))
    .for("update", { of: [creativeDesignCandidates, creativeDesignBatchItems] });
  return current && !closedItem(current.item.status) ? { ...current, batch } : undefined;
}

async function lockCreativeVersion(tx: TenantTransaction, versionId: string) {
  const [source] = await tx.select({ batchId: creativeDesignBatchItems.batchId }).from(creativeDesignVersions)
    .innerJoin(creativeDesignCandidates, eq(creativeDesignVersions.sourceCandidateId, creativeDesignCandidates.id))
    .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
    .where(eq(creativeDesignVersions.id, versionId));
  const batch = source ? await lockCreativeParent(tx, source.batchId) : undefined;
  if (!batch) return undefined;
  const [current] = await tx.select({ version: creativeDesignVersions, item: creativeDesignBatchItems }).from(creativeDesignVersions)
    .innerJoin(creativeDesignCandidates, eq(creativeDesignVersions.sourceCandidateId, creativeDesignCandidates.id))
    .innerJoin(creativeDesignBatchItems, eq(creativeDesignCandidates.itemId, creativeDesignBatchItems.id))
    .where(and(eq(creativeDesignVersions.id, versionId), eq(creativeDesignBatchItems.batchId, batch.id)))
    .for("update", { of: [creativeDesignVersions, creativeDesignBatchItems] });
  return current && !closedItem(current.item.status) ? current : undefined;
}

async function lockMockupParent(tx: TenantTransaction, batchId: string) {
  const [batch] = await tx.select().from(mockupBatches).where(eq(mockupBatches.id, batchId)).for("update");
  return batch && !closedItem(batch.status) ? batch : undefined;
}

async function lockMockupItem(tx: TenantTransaction, itemId: string) {
  const [source] = await tx.select({ batchId: mockupBatchItems.batchId }).from(mockupBatchItems).where(eq(mockupBatchItems.id, itemId));
  const batch = source ? await lockMockupParent(tx, source.batchId) : undefined;
  if (!batch) return undefined;
  const [item] = await tx.select().from(mockupBatchItems)
    .where(and(eq(mockupBatchItems.id, itemId), eq(mockupBatchItems.batchId, batch.id))).for("update");
  return item && !closedItem(item.status) ? item : undefined;
}

/** Only the original owner's running state; approval and production release remain separate. */
export async function creativeOwnerRunning(tx: TenantTransaction, row: Execution) {
  if (row.kind === "creative_candidate") {
    const current = await lockCreativeCandidate(tx, row.candidateId!);
    if (!current || !["queued", "running", "failed"].includes(current.candidate.status)) return;
    await tx.update(creativeDesignCandidates).set({ status: "running", errorCode: null, errorMessage: null,
      completedAt: null, updatedAt: sql`clock_timestamp()` }).where(eq(creativeDesignCandidates.id, current.candidate.id));
    await refreshCreativeProgress(tx, current.batch.id);
  } else if (row.kind === "template_compile") {
    await tx.update(mockupTemplateSourceInspections).set({ status: "running", errorCode: null, errorMessage: null, completedAt: null })
      .where(eq(mockupTemplateSourceInspections.id, row.inspectionId!));
  } else if (row.kind === "studio_generation") {
    await tx.update(creativeStudioGenerations).set({ status: "running", error: null, updatedAt: sql`clock_timestamp()` })
      .where(eq(creativeStudioGenerations.id, row.studioGenerationId!));
  } else if (row.kind === "mockup_render") {
    const item = await lockMockupItem(tx, row.mockupItemId!);
    if (!item) return;
    const step = creativeMockupStep(row.stepKey);
    const changed = await tx.update(mockupBatchOutputs).set({ status: "running", errorCode: null, errorMessage: null, completedAt: null })
      .where(and(eq(mockupBatchOutputs.itemId, row.mockupItemId!), eq(mockupBatchOutputs.templateSlotId, step.slotId), eq(mockupBatchOutputs.attempt, step.attempt), inArray(mockupBatchOutputs.status, ["queued", "failed"]))).returning({ id: mockupBatchOutputs.id });
    if (!changed.length) return;
    await tx.update(mockupBatchItems).set({ status: "running", updatedAt: sql`clock_timestamp()` }).where(eq(mockupBatchItems.id, item.id));
    await refreshMockupProgress(tx, item.batchId);
  }
}

export async function creativeOwnerStopped(tx: TenantTransaction, row: Execution, code: string, deferred: boolean) {
  const message = deferred ? "原执行将从已有检查点恢复" : code === "CREATIVE_RESULT_UNCERTAIN"
    ? "原调用结果与费用待核对 请勿重复生成" : "原执行的权限、输入或本地处理需要核对";
  if (row.kind === "creative_candidate") {
    const current = await lockCreativeCandidate(tx, row.candidateId!);
    if (!current || !["queued", "running", "failed"].includes(current.candidate.status)) return;
    await tx.update(creativeDesignCandidates).set({ status: deferred ? "queued" : "failed", errorCode: code, errorMessage: message,
      completedAt: deferred ? null : sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(creativeDesignCandidates.id, current.candidate.id));
    await refreshCreativeProgress(tx, current.batch.id);
  } else if (row.kind === "creative_adaptation") {
    if (!deferred) {
      const current = await lockCreativeVersion(tx, row.creativeVersionId!);
      if (!current) return;
      await tx.update(creativeDesignVersions).set({ status: "rejected", rejectionReason: message })
        .where(and(eq(creativeDesignVersions.id, current.version.id), eq(creativeDesignVersions.status, "adapting")));
    }
  } else if (row.kind === "template_compile") {
    await tx.update(mockupTemplateSourceInspections).set({ status: deferred ? "queued" : "failed", errorCode: code, errorMessage: message,
      completedAt: deferred ? null : sql`clock_timestamp()` }).where(and(eq(mockupTemplateSourceInspections.id, row.inspectionId!), inArray(mockupTemplateSourceInspections.status, ["queued", "running"])));
  } else if (row.kind === "studio_generation") {
    await tx.update(creativeStudioGenerations).set({ status: deferred ? "queued" : "failed",
      error: code === "CREATIVE_RESULT_UNCERTAIN" ? "studio_submission_interrupted" : "studio_generation_failed", updatedAt: sql`clock_timestamp()` })
      .where(and(eq(creativeStudioGenerations.id, row.studioGenerationId!), inArray(creativeStudioGenerations.status, ["queued", "running"])));
  } else {
    const item = await lockMockupItem(tx, row.mockupItemId!);
    if (!item) return;
    const step = creativeMockupStep(row.stepKey);
    await tx.update(mockupBatchOutputs).set({ status: deferred ? "queued" : "failed", errorCode: code, errorMessage: message,
      completedAt: deferred ? null : sql`clock_timestamp()` }).where(and(eq(mockupBatchOutputs.itemId, row.mockupItemId!),
        eq(mockupBatchOutputs.templateSlotId, step.slotId), eq(mockupBatchOutputs.attempt, step.attempt), inArray(mockupBatchOutputs.status, ["queued", "running"])));
    await refreshMockupItem(tx, row.mockupItemId!);
  }
}

export async function refreshMockupItem(tx: TenantTransaction, itemId: string) {
  const item = await lockMockupItem(tx, itemId);
  if (!item) return;
  const rows = await tx.select().from(mockupBatchOutputs).where(eq(mockupBatchOutputs.itemId, itemId));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!latest.has(row.slotKey) || latest.get(row.slotKey)!.attempt < row.attempt) latest.set(row.slotKey, row);
  const outputs = [...latest.values()];
  const active = outputs.some(output => ["queued", "running"].includes(output.status));
  const good = outputs.filter(output => ["succeeded", "approved", "rejected"].includes(output.status)).length;
  await tx.update(mockupBatchItems).set({ status: active ? "running" : good === outputs.length ? "awaiting_review"
    : good ? "partially_succeeded" : "failed", completedAt: active ? null : sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(mockupBatchItems.id, itemId));
  await refreshMockupProgress(tx, item.batchId);
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

export async function refreshMockupProgress(tx: TenantTransaction, batchId: string) {
  if (!await lockMockupParent(tx, batchId)) return;
  const items = await tx.select({ status: mockupBatchItems.status }).from(mockupBatchItems).where(eq(mockupBatchItems.batchId, batchId));
  const failedCount = items.filter((item) => item.status === "failed").length;
  const completedCount = items.filter((item) => item.status === "completed").length;
  const finishedRendering = items.every((item) => ["awaiting_review", "partially_succeeded", "failed", "completed"].includes(item.status));
  const status = finishedRendering
    ? failedCount === items.length ? "failed" : failedCount > 0 || items.some((item) => item.status === "partially_succeeded") ? "partially_succeeded" : "awaiting_review"
    : "running";
  await tx.update(mockupBatches).set({ status, failedCount, completedCount, completedAt: finishedRendering ? new Date() : null, updatedAt: new Date() })
    .where(eq(mockupBatches.id, batchId));
}


