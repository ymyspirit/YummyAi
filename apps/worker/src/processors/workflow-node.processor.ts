import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  organizations,
  workflowNodeAttempts,
  workflowNodeRuns,
  workflowRuns,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import {
  createQueue,
  createTraceId,
  enqueueJob,
  QueueName,
  WorkflowNodeJobPayloadSchema,
  type JobEnvelope,
} from "@yummyai/jobs";
import type { WorkflowNodeRuntime } from "@yummyai/workflow-core";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Queue } from "bullmq";

export class WorkflowNodeProcessor {
  constructor(private readonly runtime: WorkflowNodeRuntime) {}
  process(envelope: JobEnvelope) {
    return this.runtime.execute(
      { tenantId: envelope.tenantId, userId: envelope.requestedBy },
      WorkflowNodeJobPayloadSchema.parse(envelope.payload),
    );
  }
}

export class WorkflowNodeScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<{ queued: number; failed: number; legacy: number }>;
  private stopping = false;
  private readonly identity = createEntityId();
  constructor(
    private readonly database: DatabaseConnection,
    private readonly runtime: WorkflowNodeRuntime,
    private readonly queue: Queue = createQueue(QueueName.WorkflowNode),
    private readonly tenantIds?: readonly string[],
  ) {}
  start() {
    const dispatch = () =>
      void this.dispatch().catch(() => process.stderr.write("Workflow node dispatch failed\n"));
    this.timer = setInterval(dispatch, 60_000);
    this.timer.unref();
    dispatch();
  }
  async dispatch() {
    if (this.stopping || this.pending) return { queued: 0, failed: 0, legacy: 0 };
    this.pending = this.perform();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  private async perform() {
    let queued = 0,
      failed = 0,
      legacy = 0;
    // Internal maintenance selection narrows discovery; execution still resolves
    // the original actor's current membership and permissions in the runtime.
    const query = this.database.db.select({ id: organizations.id }).from(organizations);
    const tenants = await (this.tenantIds ? query.where(inArray(organizations.id, [...this.tenantIds])) : query);
    for (const tenant of tenants) {
      const context: TenantContext = {
        tenantId: tenant.id,
        userId: this.identity,
        permissions: [],
        dataScope: "tenant",
      };
      const reserved = await withTenant(this.database.db, context, async (tx) => {
        const rows = await tx
          .select({ attempt: workflowNodeAttempts, runId: workflowRuns.id })
          .from(workflowNodeAttempts)
          .innerJoin(workflowNodeRuns, eq(workflowNodeRuns.id, workflowNodeAttempts.nodeRunId))
          .innerJoin(workflowRuns, eq(workflowRuns.id, workflowNodeRuns.runId))
          .where(
            and(
              eq(workflowRuns.status, "active"),
              eq(workflowNodeRuns.status, "in_progress"),
              eq(workflowRuns.currentNodeId, workflowNodeRuns.nodeId),
              eq(workflowNodeRuns.attemptCount, workflowNodeAttempts.attemptNumber),
              sql`(${workflowNodeAttempts.status} IN ('queued','waiting') OR (${workflowNodeAttempts.status}='running' AND (${workflowNodeAttempts.leaseExpiresAt} IS NULL OR ${workflowNodeAttempts.leaseExpiresAt}<=clock_timestamp())))`,
              sql`${workflowNodeAttempts.nextAttemptAt}<=clock_timestamp()`,
              sql`(${workflowNodeAttempts.lastDispatchedAt} IS NULL OR ${workflowNodeAttempts.lastDispatchedAt}<=clock_timestamp()-interval '1 minute')`,
            ),
          )
          .orderBy(asc(workflowNodeAttempts.nextAttemptAt))
          .limit(100)
          .for("update", { of: workflowNodeAttempts, skipLocked: true });
        const intents = [];
        for (const { attempt, runId } of rows) {
          const jobId = createEntityId(),
            generation = attempt.dispatchCount + 1;
          await tx
            .update(workflowNodeAttempts)
            .set({
              dispatchCount: generation,
              lastDispatchedAt: sql`clock_timestamp()`,
              queueJobId: jobId,
            })
            .where(eq(workflowNodeAttempts.id, attempt.id));
          intents.push({
            runId,
            nodeRunId: attempt.nodeRunId,
            attemptId: attempt.id,
            requestedBy: attempt.requestedBy,
            legacy: !attempt.inputSnapshot || !attempt.requestedBy,
            jobId,
            generation,
          });
        }
        return intents;
      });
      for (const intent of reserved) {
        if (intent.legacy) {
          if (await this.runtime.settleLegacy(context, intent)) legacy++;
          continue;
        }
        try {
          await enqueueJob(this.queue, "workflow-node.execute", {
            jobId: intent.jobId,
            tenantId: tenant.id,
            requestedBy: intent.requestedBy!,
            correlationId: intent.runId,
            idempotencyKey: intent.jobId,
            traceId: createTraceId(),
            requestedAt: new Date().toISOString(),
            attempt: 0,
            maxAttempts: 3,
            payload: {
              runId: intent.runId,
              nodeRunId: intent.nodeRunId,
              attemptId: intent.attemptId,
            },
          });
          queued++;
        } catch {
          failed++;
          await withTenant(this.database.db, context, (tx) =>
            tx
              .update(workflowNodeAttempts)
              .set({
                lastDispatchedAt: null,
                errorCode: "QUEUE_UNAVAILABLE",
                errorMessage: "节点派发暂不可用，保留执行意图等待恢复",
              })
              .where(
                and(
                  eq(workflowNodeAttempts.id, intent.attemptId),
                  eq(workflowNodeAttempts.dispatchCount, intent.generation),
                  sql`${workflowNodeAttempts.status} IN ('queued','waiting','running')`,
                ),
              ),
          );
        }
      }
    }
    return { queued, failed, legacy };
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    if (this.pending) await this.pending;
    await this.queue.close();
  }
}
