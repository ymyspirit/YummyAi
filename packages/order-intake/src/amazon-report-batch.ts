import type { TenantContext } from "@yummyai/contracts";
import { ForbiddenError } from "@yummyai/authz";
import { amazonOrderReportBatches as batches, amazonOrderReportLines as lines, amazonOrderReportProcessingRequests as requests, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { type AmazonReportArchiveProcessor, AmazonReportProcessingError } from "./amazon-report-processing.js";

export type ReportProcessingTask = Pick<typeof requests.$inferSelect, "reportLineId" | "requestId" | "sourceChecksum" | "expectedVersionId" | "requestedBy" | "status" | "attemptCount" | "updatedAt">;
export interface AmazonReportBatchRepository {
  read(context: TenantContext, batchId: string, dispatchId?: string): Promise<{ exists: boolean; importing: boolean; tasks: ReportProcessingTask[] }>;
  retire(context: TenantContext, task: ReportProcessingTask, failed: boolean): Promise<void>;
}
export interface AmazonReportLineExecutor {
  process(context: TenantContext, id: string, expectedVersionId: string | null, upload?: Uint8Array, requestId?: string): Promise<void>;
}

export class AmazonReportBatchPendingError extends Error {
  readonly retryAfterMs = 125_000;
  constructor() { super("Amazon report attachments remain pending"); this.name = "AmazonReportBatchPendingError"; }
}

/** One unavailable attachment cannot prevent another line from completing. */
export class AmazonReportBatchProcessor {
  constructor(private readonly repository: AmazonReportBatchRepository, private readonly executor: AmazonReportLineExecutor) {}

  async process(context: TenantContext, batchId: string, dispatchId?: string) {
    const initial = await this.repository.read(context, batchId, dispatchId);
    if (!initial.exists) return { completed: 0, failed: 0, ignored: true };
    let cursor = 0;
    let unavailable = false;
    const runnable = initial.tasks.filter((task) => ["pending", "processing"].includes(task.status));
    const run = async () => {
      while (cursor < runnable.length) {
        const task = runnable[cursor++]!;
        if (task.status === "processing" && Date.now() - task.updatedAt.getTime() < 120_000) continue;
        if (task.attemptCount >= 3) { await this.repository.retire(context, task, true); continue; }
        try {
          await this.executor.process({ ...context, userId: task.requestedBy }, task.reportLineId, task.expectedVersionId, undefined, task.requestId);
        } catch (error) {
          if (error instanceof ForbiddenError) { await this.repository.retire(context, task, true); continue; }
          if (!(error instanceof AmazonReportProcessingError)) { unavailable = true; continue; }
          if (error.code !== "busy") await this.repository.retire(context, task, ["conflict", "invalid"].includes(error.code));
        }
      }
    };
    await Promise.all([run(), run()]);
    if (unavailable) throw new Error("Amazon report attachment execution unavailable");
    const latest = await this.repository.read(context, batchId, dispatchId);
    // The queue is registered before data is committed. Wait for initial import or
    // an explicit recovery dispatch to materialize, even when the page has closed.
    if (latest.importing || (dispatchId && !latest.tasks.length) || latest.tasks.some((task) => ["pending", "processing"].includes(task.status))) throw new AmazonReportBatchPendingError();
    return { completed: latest.tasks.filter((task) => task.status === "completed").length, failed: latest.tasks.filter((task) => task.status === "failed").length, ignored: false };
  }
}

export class DrizzleAmazonReportBatchRepository implements AmazonReportBatchRepository {
  constructor(private readonly database: DatabaseConnection) {}

  read(context: TenantContext, batchId: string, dispatchId?: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [batch] = await tx.select({ status: batches.status }).from(batches).where(eq(batches.id, batchId));
      const tasks = await tx.select({ reportLineId: requests.reportLineId, requestId: requests.requestId, sourceChecksum: requests.sourceChecksum,
        expectedVersionId: requests.expectedVersionId, requestedBy: requests.requestedBy, status: requests.status, attemptCount: requests.attemptCount, updatedAt: requests.updatedAt,
      }).from(requests).where(and(eq(requests.batchId, batchId), dispatchId ? eq(requests.dispatchId, dispatchId) : undefined));
      return { exists: !!batch, importing: batch?.status === "importing", tasks };
    });
  }

  retire(context: TenantContext, task: ReportProcessingTask, failed: boolean) {
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:${task.reportLineId}:amazon-report-line`}, 0))`);
      // All archive mutations lock the line before its request, including import
      // and explicit recovery, so retirement cannot invert their lock order.
      await tx.select({ id: lines.id }).from(lines).where(eq(lines.id, task.reportLineId)).for("update");
      const [current] = await tx.select().from(requests).where(and(eq(requests.reportLineId, task.reportLineId), eq(requests.requestId, task.requestId))).for("update");
      if (!current || !["pending", "processing"].includes(current.status)) return;
      if (current.status === "processing" && Date.now() - current.updatedAt.getTime() < 120_000) return;
      const code = failed ? (task.attemptCount >= 3 ? "processing_interrupted" : "processing_blocked") : "source_changed";
      await tx.update(requests).set({ status: failed ? "failed" : "superseded", lastErrorCode: code, updatedAt: new Date() }).where(eq(requests.requestId, task.requestId));
      if (failed) await tx.update(lines).set({ state: "failed", lastErrorCode: code, processingToken: null, processingStartedAt: null, updatedAt: new Date() }).where(and(eq(lines.id, task.reportLineId), eq(lines.sourceChecksum, task.sourceChecksum), sql`${lines.state} in ('pending','processing')`));
    });
  }
}

export function createAmazonReportBatchProcessor(database: DatabaseConnection, archive: AmazonReportArchiveProcessor) {
  return new AmazonReportBatchProcessor(new DrizzleAmazonReportBatchRepository(database), archive);
}
