import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { agentPlanRuns, agentPlanSteps, organizations, withTenant, type DatabaseConnection } from "@yummyai/database";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import type { Queue } from "bullmq";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AgentRuntimeSchedulerEvent, AgentRuntimeSchedulerObserver } from "../agent-runtime-observer.js";

type DispatchResult = { queued: number; failed: number; expirationQueued: number };

/** Database metadata is the outbox. Redis retries never authorize a new model
 * request; the original run and per-turn submission evidence do. */
export class AgentPlanScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<DispatchResult>;
  private stopping = false;
  private readonly identity = createEntityId();

  constructor(
    private readonly database: DatabaseConnection,
    private readonly queue: Queue = createQueue(QueueName.AgentPlan),
    private readonly tenantIds?: readonly string[],
    private readonly observer?: AgentRuntimeSchedulerObserver,
  ) {}

  start() {
    if (this.stopping || this.timer) return;
    const tick = () => void this.dispatch().catch(() => process.stderr.write("Agent plan dispatch unavailable\n"));
    this.timer = setInterval(tick, 30_000);
    this.timer.unref();
    this.observe("started");
    tick();
  }

  dispatch(): Promise<DispatchResult> {
    if (this.stopping) return Promise.resolve({ queued: 0, failed: 0, expirationQueued: 0 });
    if (this.pending) return this.pending;
    this.observe("dispatching");
    const pending = this.perform().then(result => {
      if (!this.stopping) this.observe(result.failed === 0 ? "succeeded" : "failed");
      return result;
    }, error => {
      if (!this.stopping) this.observe("failed");
      throw error;
    });
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
    return pending;
  }

  private observe(event: AgentRuntimeSchedulerEvent) {
    try { this.observer?.(event); } catch { /* Observation never changes an original dispatch. */ }
  }

  private async perform(): Promise<DispatchResult> {
    const result: DispatchResult = { queued: 0, failed: 0, expirationQueued: 0 };
    const query = this.database.db.select({ id: organizations.id }).from(organizations);
    const tenants = await (this.tenantIds ? query.where(inArray(organizations.id, [...this.tenantIds])) : query);
    for (const tenant of tenants) {
      if (this.stopping) break;
      const context: TenantContext = { tenantId: tenant.id, userId: this.identity, permissions: [], dataScope: "tenant" };
      const intents = await withTenant(this.database.db, context, async tx => {
        const due = await tx.select({ id: agentPlanRuns.id, actor: agentPlanRuns.ownerId, generation: agentPlanRuns.dispatchCount,
          expired: sql<boolean>`${agentPlanRuns.expiresAt}<=clock_timestamp()` })
          .from(agentPlanRuns).where(and(
            sql`(${agentPlanRuns.leaseExpiresAt} is null or ${agentPlanRuns.leaseExpiresAt}<=clock_timestamp())`,
            sql`(${agentPlanRuns.lastDispatchedAt} is null or ${agentPlanRuns.lastDispatchedAt}<=clock_timestamp()-interval '1 minute')`,
            sql`((
              ${agentPlanRuns.status} in ('queued','running','stopping') and ${agentPlanRuns.expiresAt}>clock_timestamp()
              and ${agentPlanRuns.nextAttemptAt}<=clock_timestamp()
            ) or (
              ${agentPlanRuns.expiresAt}<=clock_timestamp() and (
                ${agentPlanRuns.encryptedInput} is not null or ${agentPlanRuns.encryptedResult} is not null
                or exists(select 1 from ${agentPlanSteps} s where s.tenant_id=${agentPlanRuns.tenantId} and s.run_id=${agentPlanRuns.id}
                  and (s.encrypted_input is not null or s.encrypted_output is not null or s.encrypted_response is not null))
              )
            ))`,
          )).orderBy(asc(agentPlanRuns.createdAt)).limit(100).for("update", { skipLocked: true });
        const intents = [];
        for (const row of due) {
          const generation = row.generation + 1;
          await tx.update(agentPlanRuns).set({ dispatchCount: generation, lastDispatchedAt: sql`clock_timestamp()` })
            .where(eq(agentPlanRuns.id, row.id));
          intents.push({ id: row.id, actor: row.actor, generation, operation: row.expired ? "expire" as const : "execute" as const });
        }
        return intents;
      });
      for (const intent of intents) {
        // Every reserved intent remains discoverable if shutdown or Redis fails.
        if (this.stopping) {
          await this.releaseDispatch(context, intent.id, intent.generation);
          continue;
        }
        try {
          const jobId = createEntityId();
          await enqueueJob(this.queue, "agent-plan.execute", { jobId, idempotencyKey: jobId, correlationId: intent.id,
            traceId: createTraceId(), tenantId: tenant.id, requestedBy: intent.actor, requestedAt: new Date().toISOString(),
            attempt: 0, maxAttempts: 1, payload: { runId: intent.id, operation: intent.operation } });
          result.queued++;
          if (intent.operation === "expire") result.expirationQueued++;
        } catch {
          result.failed++;
          await this.releaseDispatch(context, intent.id, intent.generation);
        }
      }
    }
    return result;
  }

  private releaseDispatch(context: TenantContext, id: string, generation: number) {
    return withTenant(this.database.db, context, tx => tx.update(agentPlanRuns).set({ lastDispatchedAt: null })
      .where(and(eq(agentPlanRuns.id, id), eq(agentPlanRuns.dispatchCount, generation))));
  }

  async close() {
    this.stopping = true;
    this.observe("closing");
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    await this.queue.close();
  }
}
