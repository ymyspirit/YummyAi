import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  aiAssistRuns as runs,
  aiAssistExecutions as executions,
  organizations,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import type { Queue } from "bullmq";
import { and, asc, eq, sql } from "drizzle-orm";
import { expireAssistInTransaction } from "./ai-assist-execution.js";
import { expireKnowledgeBenchmarkBodiesInTenant } from "../knowledge-benchmark-retention.js";

/** The original run plus its execution row is the outbox; Redis is transport only. */
export class AiAssistScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<{ queued: number; failed: number; expired: number }>;
  private readonly identity = createEntityId();
  constructor(
    private readonly database: DatabaseConnection,
    private readonly queue: Queue = createQueue(QueueName.AiAssist),
  ) {}
  start() {
    const tick = () =>
      void this.dispatch().catch(() => process.stderr.write("AI assist dispatch unavailable\n"));
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    tick();
  }
  dispatch() {
    if (this.pending) return this.pending;
    const pending = this.dispatchOnce();
    this.pending = pending;
    void pending
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      })
      .catch(() => undefined);
    return pending;
  }
  private async dispatchOnce() {
    let queued = 0,
      failed = 0,
      expired = 0;
    // Enumerate only organization routing IDs outside RLS. All task data uses the ordinary tenant role.
    const tenants = await this.database.db.select({ id: organizations.id }).from(organizations);
    for (const tenant of tenants) {
      const benchmarkRetention = await expireKnowledgeBenchmarkBodiesInTenant(this.database, tenant.id);
      if (benchmarkRetention.failed) process.stderr.write("Knowledge benchmark retention has deferred bodies\n");
      const context: TenantContext = {
        tenantId: tenant.id,
        userId: this.identity,
        permissions: [],
        dataScope: "tenant",
      };
      const pending = await withTenant(this.database.db, context, async (tx) => {
        const overdue = await tx
          .select({ run: runs, execution: executions })
          .from(runs)
          .innerJoin(executions, eq(executions.runId, runs.id))
          .where(
            and(
              sql`${runs.expiresAt}<=clock_timestamp()`,
              sql`(${runs.encryptedInput} IS NOT NULL OR ${runs.encryptedOutput} IS NOT NULL OR ${executions.encryptedResponse} IS NOT NULL)`,
            ),
          )
          .orderBy(asc(runs.expiresAt))
          .limit(100)
          .for("update", { skipLocked: true });
        for (const row of overdue) {
          await expireAssistInTransaction(tx, row.run, row.execution);
          expired++;
        }
        const candidates = await tx
          .select({ run: runs, execution: executions })
          .from(runs)
          .innerJoin(executions, eq(executions.runId, runs.id))
          .where(
            and(
              sql`${runs.status} IN ('queued','running') AND ${runs.expiresAt}>clock_timestamp()`,
              sql`${executions.phase} IN ('pending','preparing','response_ready') AND ${executions.nextAttemptAt}<=clock_timestamp()`,
              sql`(${executions.leaseExpiresAt} IS NULL OR ${executions.leaseExpiresAt}<=clock_timestamp())`,
              sql`(${executions.lastDispatchedAt} IS NULL OR ${executions.lastDispatchedAt}<=clock_timestamp()-interval '1 minute')`,
            ),
          )
          .orderBy(asc(runs.createdAt))
          .limit(100)
          .for("update", { skipLocked: true });
        const intents = [];
        for (const { run, execution } of candidates) {
          const generation = execution.dispatchCount + 1;
          await tx
            .update(executions)
            .set({ dispatchCount: generation, lastDispatchedAt: sql`clock_timestamp()`, updatedAt: new Date() })
            .where(eq(executions.runId, run.id));
          intents.push({ id: run.id, actor: run.ownerId, generation });
        }
        return intents;
      });
      for (const intent of pending) {
        try {
          const jobId = createEntityId();
          await enqueueJob(this.queue, "assist.analyze", {
            jobId,
            idempotencyKey: jobId,
            correlationId: intent.id,
            traceId: createTraceId(),
            tenantId: tenant.id,
            requestedBy: intent.actor,
            requestedAt: new Date().toISOString(),
            attempt: 0,
            maxAttempts: 1,
            payload: { runId: intent.id, operation: "analyze" },
          });
          queued++;
        } catch {
          failed++;
          await withTenant(this.database.db, context, (tx) =>
            tx
              .update(executions)
              .set({ lastDispatchedAt: null })
              .where(
                and(
                  eq(executions.runId, intent.id),
                  eq(executions.dispatchCount, intent.generation),
                ),
              ),
          );
        }
      }
    }
    return { queued, failed, expired };
  }
  async close() {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    await this.queue.close();
  }
}
