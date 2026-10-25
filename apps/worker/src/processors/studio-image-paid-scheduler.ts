import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { aiBudgetLedger, creativeExecutions, creativeStudioGenerations, creativeStudioImageRequests, modelProviderConfigs, withTenant,
  type DatabaseConnection } from "@yummyai/database";
import { createQueue, createTraceId, enqueueJob, QueueName } from "@yummyai/jobs";
import { admitCreativeExecution, studioImageAdmission } from "@yummyai/pod-core";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { assertStudioImageOperatorAdmission, assertStudioPaidImageEvidence, studioImageWorkerConfigured } from "./studio-image-paid-admission.js";

export interface StudioPaidImageDispatcher {
  enqueue(input: { jobId: string; tenantId: string; userId: string; generationId: string }): Promise<void>;
  close(): Promise<unknown>;
}
const defaultDispatcher = (): StudioPaidImageDispatcher => {
  const queue = createQueue(QueueName.StudioGeneration);
  return {
    async enqueue(input) {
      await enqueueJob(queue, "studio_generation.execute", { jobId: input.jobId, idempotencyKey: input.jobId, correlationId: input.generationId,
        traceId: createTraceId(), tenantId: input.tenantId, requestedBy: input.userId, requestedAt: new Date().toISOString(),
        attempt: 0, maxAttempts: 1, payload: { generationId: input.generationId } });
    },
    close: () => queue.close(),
  };
};
const phases = ["pending", "preparing", "submitted", "response_staging", "response_ready"] as const;
const paused = (cause: unknown) => cause instanceof Error && cause.message === "STUDIO_PAID_IMAGE_OPERATOR_PAUSED";

/** This scheduler owns dispatch hints for committed paid images only. It never
 * purges the broad Studio domain or claims a legacy text/video execution. */
export class StudioPaidImageScheduler {
  private readonly actorId = createEntityId();
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<{ queued: number; failed: number; skipped: number }>;
  private readonly dispatcher: StudioPaidImageDispatcher;
  private readonly cursors = new Map<string, string>();
  private readonly ownerCursors = new Map<string, string>();
  constructor(private readonly database: Pick<DatabaseConnection, "db">, dispatcher?: StudioPaidImageDispatcher,
    private readonly environment: () => Readonly<NodeJS.ProcessEnv> = () => process.env) {
    this.dispatcher = dispatcher ?? defaultDispatcher();
  }
  start() {
    const tick = () => { void this.dispatch().catch(() => process.stderr.write("Studio paid image dispatch unavailable\n")); };
    this.timer = setInterval(tick, 60_000); this.timer.unref(); tick();
  }
  dispatch() {
    if (this.pending) return this.pending;
    const pending = this.dispatchOnce(); this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
    return pending;
  }
  private async dispatchOnce() {
    let queued = 0, failed = 0, skipped = 0;
    if (!studioImageWorkerConfigured(this.environment())) return { queued, failed, skipped };
    const tenants = [...new Set(this.environment().STUDIO_PAID_IMAGE_TENANT_IDS!.split(",").map(value => value.trim().toLowerCase()))];
    for (const tenantId of tenants) {
      if (!studioImageAdmission(tenantId, this.environment()).enabled) continue;
      // The tenant-only execution index supplies identities, never access to
      // their owner-private prepared requests. Each request read runs below as
      // that exact original requestedBy under the unchanged forced RLS policy.
      const metadataContext: TenantContext = { tenantId, userId: this.actorId, permissions: [], dataScope: "tenant" };
      const owners = await withTenant(this.database.db, metadataContext, async tx => {
        if (!studioImageAdmission(tenantId, this.environment()).enabled) return [];
        const cursor = this.ownerCursors.get(tenantId);
        return tx.selectDistinct({ id: creativeExecutions.requestedBy }).from(creativeExecutions)
          .innerJoin(creativeStudioGenerations, and(eq(creativeStudioGenerations.tenantId, creativeExecutions.tenantId),
            eq(creativeStudioGenerations.id, creativeExecutions.studioGenerationId), eq(creativeStudioGenerations.ownerId, creativeExecutions.requestedBy)))
          .where(and(eq(creativeExecutions.tenantId, tenantId), eq(creativeExecutions.kind, "studio_generation"),
            eq(creativeExecutions.stepKey, "generate"), eq(creativeExecutions.effect, "external_request"), isNull(creativeExecutions.parentExecutionId),
            inArray(creativeExecutions.phase, phases), inArray(creativeStudioGenerations.status, ["queued", "running"]),
            sql`${creativeStudioGenerations.modelSnapshot}->>'capability'='image'`, sql`${creativeStudioGenerations.modelSnapshot}->'paidImage' is not null`,
            cursor ? gt(creativeExecutions.requestedBy, cursor) : undefined))
          .orderBy(asc(creativeExecutions.requestedBy)).limit(100);
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      if (owners.length === 100) this.ownerCursors.set(tenantId, owners.at(-1)!.id); else this.ownerCursors.delete(tenantId);
      for (const owner of owners) {
        if (!studioImageAdmission(tenantId, this.environment()).enabled) break;
        const context: TenantContext = { tenantId, userId: owner.id, permissions: [], dataScope: "self" };
        const cursorKey = `${tenantId}:${owner.id}`;
        let intents: Array<{ executionId: string; generationId: string; requestedBy: string; dispatchCount: number }>;
        try {
          const page = await withTenant(this.database.db, context, async tx => {
            assertStudioImageOperatorAdmission(tenantId, this.environment());
            const cursor = this.cursors.get(cursorKey);
            const rows = await tx.select({ execution: creativeExecutions, generation: creativeStudioGenerations, request: creativeStudioImageRequests })
              .from(creativeExecutions)
              .innerJoin(creativeStudioGenerations, and(eq(creativeStudioGenerations.tenantId, creativeExecutions.tenantId),
                eq(creativeStudioGenerations.id, creativeExecutions.studioGenerationId), eq(creativeStudioGenerations.ownerId, creativeExecutions.requestedBy)))
              .innerJoin(creativeStudioImageRequests, and(eq(creativeStudioImageRequests.tenantId, creativeStudioGenerations.tenantId),
                eq(creativeStudioImageRequests.generationId, creativeStudioGenerations.id), eq(creativeStudioImageRequests.ownerId, creativeStudioGenerations.ownerId)))
              .where(and(eq(creativeExecutions.tenantId, tenantId), eq(creativeExecutions.kind, "studio_generation"),
                eq(creativeExecutions.requestedBy, owner.id),
                eq(creativeExecutions.stepKey, "generate"), eq(creativeExecutions.effect, "external_request"), isNull(creativeExecutions.parentExecutionId),
                sql`${creativeStudioGenerations.modelSnapshot}->>'capability'='image'`,
                sql`${creativeStudioGenerations.modelSnapshot}->'paidImage' is not null`,
                sql`${creativeStudioImageRequests.committedAt} is not null`, isNull(creativeStudioImageRequests.cancelledAt),
                inArray(creativeStudioGenerations.status, ["queued", "running"]), cursor ? gt(creativeExecutions.id, cursor) : undefined,
                inArray(creativeExecutions.phase, phases), sql`${creativeExecutions.nextAttemptAt}<=clock_timestamp()`,
                sql`(${creativeExecutions.leaseExpiresAt} is null or ${creativeExecutions.leaseExpiresAt}<=clock_timestamp())`,
                sql`(${creativeExecutions.lastDispatchedAt} is null or ${creativeExecutions.lastDispatchedAt}<=clock_timestamp()-interval '1 minute')`))
              .orderBy(asc(creativeExecutions.id)).limit(100).for("update", { of: [creativeExecutions], skipLocked: true });
            const originals = [];
            for (const row of rows) {
              assertStudioImageOperatorAdmission(tenantId, this.environment());
              try {
                assertStudioPaidImageEvidence(row);
                await admitCreativeExecution(tx, { tenantId, userId: row.execution.requestedBy },
                  { kind: "studio_generation", ownerId: row.generation.id, stepKey: "generate" });
                const ledger = await tx.select().from(aiBudgetLedger)
                  .where(and(eq(aiBudgetLedger.tenantId, tenantId), eq(aiBudgetLedger.requestId, row.generation.id))).for("share");
                const [provider] = await tx.select({ provider: modelProviderConfigs.provider }).from(modelProviderConfigs)
                  .where(eq(modelProviderConfigs.id, row.generation.modelSnapshot.providerConfigId)).for("share");
                const hold = ledger[0];
                if (ledger.length !== 1 || !hold || hold.taskType !== "studio_image" || hold.modelKey !== row.request.quote.model
                  || !provider || hold.provider !== provider.provider
                  || !["reserved", "committed"].includes(hold.state)
                  || hold.state === "reserved" && hold.amountUsd !== row.request.quote.pricing.reservationUsd
                  || hold.state === "committed" && (!row.execution.submittedAt || !row.execution.receipt?.costUsd)
                  || row.execution.budgetLedgerId !== null && row.execution.budgetLedgerId !== hold.id
                  || row.execution.submittedAt !== null && row.execution.budgetLimitUsd !== row.request.quote.pricing.reservationUsd) { skipped++; continue; }
              } catch (cause) {
                if (paused(cause)) throw cause;
                // Current authority or a damaged original is never inferred from a queue hint.
                skipped++; continue;
              }
              assertStudioImageOperatorAdmission(tenantId, this.environment());
              const dispatchCount = row.execution.dispatchCount + 1;
              await tx.update(creativeExecutions).set({ dispatchCount, lastDispatchedAt: sql`clock_timestamp()`, updatedAt: sql`clock_timestamp()` })
                .where(eq(creativeExecutions.id, row.execution.id));
              originals.push({ executionId: row.execution.id, generationId: row.generation.id, requestedBy: row.execution.requestedBy, dispatchCount });
            }
            // Turning the gate off during an awaited read/write rolls this transaction back.
            assertStudioImageOperatorAdmission(tenantId, this.environment());
            return { originals, nextCursor: rows.length === 100 ? rows.at(-1)!.execution.id : null };
          });
          intents = page.originals;
          // An inaccessible/damaged original cannot permanently hide later valid requests.
          if (page.nextCursor) this.cursors.set(cursorKey, page.nextCursor); else this.cursors.delete(cursorKey);
        } catch (cause) {
          if (paused(cause)) break;
          throw cause;
        }
        for (const intent of intents) {
          if (!studioImageAdmission(tenantId, this.environment()).enabled) break;
          try {
            await this.dispatcher.enqueue({ jobId: createEntityId(), tenantId, userId: intent.requestedBy, generationId: intent.generationId });
            queued++;
          } catch {
            failed++;
            if (!studioImageAdmission(tenantId, this.environment()).enabled) continue;
            try {
              await withTenant(this.database.db, context, async tx => {
                assertStudioImageOperatorAdmission(tenantId, this.environment());
                await tx.update(creativeExecutions).set({ lastDispatchedAt: null }).where(and(eq(creativeExecutions.tenantId, tenantId),
                  eq(creativeExecutions.id, intent.executionId), eq(creativeExecutions.dispatchCount, intent.dispatchCount), inArray(creativeExecutions.phase, phases)));
                assertStudioImageOperatorAdmission(tenantId, this.environment());
              });
            } catch (cause) { if (!paused(cause)) throw cause; }
          }
        }
      }
    }
    return { queued, failed, skipped };
  }
  async close() { if (this.timer) clearInterval(this.timer); try { await this.pending; } finally { await this.dispatcher.close(); } }
}
