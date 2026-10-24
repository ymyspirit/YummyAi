import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { organizations, podArtworkExecutions as executions, podArtworkInvocations as invocations, podArtworkTasks as tasks, withTenant, type DatabaseConnection } from "@yummyai/database";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import { enabledPodArtworkTools } from "@yummyai/pod-core";
import type { Storage } from "@yummyai/storage";
import type { Queue } from "bullmq";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { DrizzlePodArtworkExecutionRepository } from "./pod-artwork.repository.js";

/** New original POD rows are durable intents; old tasks are deliberately not inferred. */
export class PodArtworkScheduler {
  private readonly identity = createEntityId();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<{ queued: number; failed: number; purged: number }>;
  constructor(private readonly database: DatabaseConnection, private readonly storage: Storage, private readonly queue: Queue = createQueue(QueueName.PodArtwork), private readonly canSubmit = (tool: string) => enabledPodArtworkTools().has(tool as Parameters<ReturnType<typeof enabledPodArtworkTools>["has"]>[0]), private readonly tenantIds?: readonly string[]) {}

  start() {
    const tick = () => void this.dispatch().catch(() => process.stderr.write("POD dispatch unavailable\n"));
    this.timer = setInterval(tick, 60_000);
    this.timer.unref();
    tick();
  }
  dispatch() {
    if (this.pending) return this.pending;
    const pending = this.dispatchOnce();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
    return pending;
  }
  private async dispatchOnce() {
    let queued = 0, failed = 0, purged = 0;
    const tenantsQuery = this.database.db.select({ id: organizations.id }).from(organizations);
    // An internal maintenance selector can narrow enumeration, never authorize a task.
    const tenants = await (this.tenantIds ? tenantsQuery.where(inArray(organizations.id, [...this.tenantIds])) : tenantsQuery);
    const repository = new DrizzlePodArtworkExecutionRepository(this.database, this.storage);
    for (const tenant of tenants) {
      const context: TenantContext = { tenantId: tenant.id, userId: this.identity, permissions: [], dataScope: "tenant" };
      purged += await repository.purgeExpiredResponses(context);
      const intents = await withTenant(this.database.db, context, async tx => {
        const candidates = await tx.select({ task: tasks, execution: executions, submitted: invocations.submittedAt }).from(tasks)
          .innerJoin(executions, eq(executions.taskId, tasks.id))
          .leftJoin(invocations, and(eq(invocations.taskId, tasks.id), eq(invocations.attemptNumber, 1)))
          .where(and(inProgress(), sql`${executions.nextAttemptAt}<=clock_timestamp()`, sql`(${executions.leaseExpiresAt} IS NULL OR ${executions.leaseExpiresAt}<=clock_timestamp())`, sql`(${executions.lastDispatchedAt} IS NULL OR ${executions.lastDispatchedAt}<=clock_timestamp()-interval '1 minute')`))
          .orderBy(asc(tasks.createdAt)).limit(100).for("update", { of: [tasks, executions], skipLocked: true });
        const result = [];
        for (const { task, execution, submitted } of candidates) {
          if (!task.requestedBy || (!execution.responseObjectKey && !submitted && !this.canSubmit(task.toolKey))) continue;
          const generation = execution.dispatchCount + 1;
          await tx.update(executions).set({ dispatchCount: generation, lastDispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(executions.taskId, task.id));
          result.push({ id: task.id, requestedBy: task.requestedBy, generation });
        }
        return result;
      });
      for (const intent of intents) {
        try {
          const jobId = createEntityId();
          await enqueueJob(this.queue, "pod-artwork.execute", { jobId, idempotencyKey: jobId, correlationId: intent.id, traceId: createTraceId(), tenantId: tenant.id, requestedBy: intent.requestedBy, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload: { taskId: intent.id } });
          queued++;
        } catch {
          failed++;
          await withTenant(this.database.db, context, tx => tx.update(executions).set({ lastDispatchedAt: null }).where(and(eq(executions.taskId, intent.id), eq(executions.dispatchCount, intent.generation))));
        }
      }
    }
    return { queued, failed, purged };
  }
  async close() { if (this.timer) clearInterval(this.timer); await this.pending; await this.queue.close(); }
}

const inProgress = () => sql`${tasks.status} IN ('queued','running') AND ${executions.phase} IN ('pending','preparing','response_staging','response_ready')`;
