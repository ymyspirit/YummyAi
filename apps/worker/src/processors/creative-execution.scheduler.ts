import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { CreativeExecutionKind } from "@yummyai/contracts/harness";
import { creativeExecutions, organizations, withTenant, type DatabaseConnection } from "@yummyai/database";
import { createQueue, createTraceId, enqueueJob, QueueName, type QueueNameValue } from "@yummyai/jobs";
import type { Storage } from "@yummyai/storage";
import type { Queue } from "bullmq";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { CreativeExecutionRecovery } from "./creative-execution-recovery.js";
import { creativeOwnerStopped } from "./creative-execution-owner-state.js";

export const creativeExecutionQueues: Record<CreativeExecutionKind, QueueNameValue> = {
  creative_candidate: QueueName.CreativeDesign, creative_adaptation: QueueName.CreativeDesignAdaptation,
  template_compile: QueueName.MockupTemplateCompile, mockup_render: QueueName.MockupRender, studio_generation: QueueName.StudioGeneration,
};

/** Dispatch only new durable originals. Old queued business rows never become inferred authority. */
export class CreativeExecutionScheduler {
  private readonly actorId = createEntityId();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<{ queued: number; failed: number; purged: number }>;
  private readonly queue: Queue;
  constructor(private readonly database: DatabaseConnection, private readonly storage: Storage, private readonly kind: CreativeExecutionKind,
    queue?: Queue, private readonly tenantIds?: readonly string[]) {
    this.queue = queue ?? createQueue(creativeExecutionQueues[kind]);
  }
  start() {
    const tick = () => { void this.dispatch().catch(() => process.stderr.write("Creative dispatch unavailable\n")); };
    this.timer = setInterval(tick, 60000); this.timer.unref(); tick();
  }
  dispatch() {
    if (this.pending) return this.pending;
    const pending = this.dispatchOnce(); this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
    return pending;
  }
  private async dispatchOnce() {
    let queued = 0, failed = 0, purged = 0;
    const query = this.database.db.select({ id: organizations.id }).from(organizations);
    const tenants = await (this.tenantIds ? query.where(inArray(organizations.id, [...this.tenantIds])) : query);
    const recovery = new CreativeExecutionRecovery(this.database, this.storage, undefined, creativeOwnerStopped);
    for (const tenant of tenants) {
      const context: TenantContext = { tenantId: tenant.id, userId: this.actorId, permissions: [], dataScope: "tenant" };
      purged += await recovery.purgeExpired(context, [this.kind]);
      const intents = await withTenant(this.database.db, context, async tx => {
        const rows = await tx.select().from(creativeExecutions).where(and(eq(creativeExecutions.kind, this.kind), isNull(creativeExecutions.parentExecutionId),
          inArray(creativeExecutions.phase, ["pending", "preparing", "submitted", "response_staging", "response_ready"]),
          sql`${creativeExecutions.nextAttemptAt}<=clock_timestamp()`,
          sql`(${creativeExecutions.leaseExpiresAt} IS NULL OR ${creativeExecutions.leaseExpiresAt}<=clock_timestamp())`,
          sql`(${creativeExecutions.lastDispatchedAt} IS NULL OR ${creativeExecutions.lastDispatchedAt}<=clock_timestamp()-interval '1 minute')`))
          .orderBy(asc(creativeExecutions.createdAt)).limit(100).for("update", { skipLocked: true });
        const groups = new Map<string, { ownerId: string; requestedBy: string; rows: Array<{ id: string; generation: number }> }>();
        for (const row of rows) {
          const ownerId = row.candidateId ?? row.creativeVersionId ?? row.inspectionId ?? row.mockupItemId ?? row.studioGenerationId!;
          const key = `${row.requestedBy}:${ownerId}`, group = groups.get(key) ?? { ownerId, requestedBy: row.requestedBy, rows: [] };
          const generation = row.dispatchCount + 1;
          await tx.update(creativeExecutions).set({ dispatchCount: generation, lastDispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` }).where(eq(creativeExecutions.id, row.id));
          group.rows.push({ id: row.id, generation }); groups.set(key, group);
        }
        return [...groups.values()];
      });
      for (const intent of intents) {
        const payload = this.kind === "creative_candidate" ? { candidateId: intent.ownerId } : this.kind === "creative_adaptation" ? { creativeDesignVersionId: intent.ownerId }
          : this.kind === "template_compile" ? { inspectionId: intent.ownerId } : this.kind === "mockup_render" ? { itemId: intent.ownerId } : { generationId: intent.ownerId };
        const jobId = createEntityId();
        try {
          await enqueueJob(this.queue, `${this.kind}.execute`, { jobId, idempotencyKey: jobId, correlationId: intent.ownerId,
            traceId: createTraceId(), tenantId: tenant.id, requestedBy: intent.requestedBy, requestedAt: new Date().toISOString(), attempt: 0, maxAttempts: 1, payload });
          queued++;
        } catch {
          failed++;
          await withTenant(this.database.db, context, async tx => {
            for (const row of intent.rows) await tx.update(creativeExecutions).set({ lastDispatchedAt: null })
              .where(and(eq(creativeExecutions.id, row.id), eq(creativeExecutions.dispatchCount, row.generation),
                inArray(creativeExecutions.phase, ["pending", "preparing", "submitted", "response_staging", "response_ready"])));
          });
        }
      }
    }
    return { queued, failed, purged };
  }
  async close() { if (this.timer) clearInterval(this.timer); try { await this.pending; } finally { await this.queue.close(); } }
}
