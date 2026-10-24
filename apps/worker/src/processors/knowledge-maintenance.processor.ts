import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  knowledgeSources,
  knowledgeSourceChecks,
  organizations,
  memberships,
  membershipRoles,
  roles,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { checkKnowledgeSource, purgeKnowledgeOriginals } from "@yummyai/knowledge-core";
import { createQueue, createTraceId, enqueueJob, QueueName, type JobEnvelope } from "@yummyai/jobs";
import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

const Payload = z
  .object({ operation: z.enum(["check", "purge"]), sourceId: z.uuidv7().nullable() })
  .strict();
export class KnowledgeMaintenanceProcessor {
  constructor(private readonly database: DatabaseConnection) {}
  async process(envelope: JobEnvelope) {
    const payload = Payload.parse(envelope.payload);
    const context: TenantContext = {
      tenantId: envelope.tenantId,
      userId: envelope.requestedBy,
      permissions: [],
      dataScope: "tenant",
    };
    if (payload.operation === "purge") return purgeKnowledgeOriginals(this.database, context);
    if (!payload.sourceId) throw new Error("knowledge_source_required");
    const grants = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ permissions: roles.permissions })
        .from(memberships)
        .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active"))),
    );
    const permissions = new Set(grants.flatMap((g) => g.permissions));
    const [source] = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(knowledgeSources).where(eq(knowledgeSources.id, payload.sourceId!)),
    );
    if (!source?.monitoring || source.archivedAt) return { skipped: true };
    if (!permissions.has("workflow:manage") || !permissions.has("workflow:read")) {
      const diagnostic = "自动监控负责人权限已变化，请有权限的负责人重新登记或手动检查来源";
      await withTenant(this.database.db, context, async (tx) => {
        await tx
          .update(knowledgeSources)
          .set({ lastError: diagnostic })
          .where(eq(knowledgeSources.id, source.id));
        await tx
          .insert(knowledgeSourceChecks)
          .values({
            id: createEntityId(),
            tenantId: context.tenantId,
            sourceId: source.id,
            result: "failed",
            diagnostic,
          });
      });
      return { changed: false, diagnostic };
    }
    return checkKnowledgeSource(this.database, context, source.id);
  }
}
export class KnowledgeMaintenanceScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private stopping = false;
  private pending?: Promise<void>;
  private readonly workerIdentity = createEntityId();
  constructor(private readonly database: DatabaseConnection, private readonly queue = createQueue(QueueName.KnowledgeMaintenance)) {}
  start() {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(
      () =>
        void this.dispatch().catch(() =>
          process.stderr.write("Knowledge maintenance dispatch failed\n"),
        ),
      60_000,
    );
    this.timer.unref();
    void this.dispatch().catch(() =>
      process.stderr.write("Knowledge maintenance dispatch failed\n"),
    );
  }
  dispatch() {
    if (this.running || this.stopping) return Promise.resolve();
    const pending = this.dispatchOnce();
    this.pending = pending;
    void pending.finally(() => { if (this.pending === pending) this.pending = undefined; }).catch(() => undefined);
    return pending;
  }
  private async dispatchOnce() {
    if (this.running) return;
    this.running = true;
    try {
      // Organization inventory is infrastructure metadata. Every business read stays under forced RLS.
      const tenants = await this.database.db.select({ id: organizations.id }).from(organizations);
      for (const tenant of tenants) {
        const context: TenantContext = {
          tenantId: tenant.id,
          userId: this.workerIdentity,
          permissions: [],
          dataScope: "tenant",
        };
        const due = await withTenant(this.database.db, context, (tx) =>
          tx
            .select()
            .from(knowledgeSources)
            .where(
              and(
                eq(knowledgeSources.monitoring, true),
                isNull(knowledgeSources.archivedAt),
                sql`(${knowledgeSources.nextCheckAt} IS NULL OR ${knowledgeSources.nextCheckAt}<=now())`,
              ),
            )
            .limit(200),
        );
        for (const source of due) {
          const jobId = createEntityId();
          await enqueueJob(this.queue, "knowledge.check", {
            jobId,
            tenantId: tenant.id,
            requestedBy: source.createdBy,
            idempotencyKey: jobId,
            correlationId: source.id,
            traceId: createTraceId(),
            requestedAt: new Date().toISOString(),
            attempt: 0,
            maxAttempts: 1,
            payload: { operation: "check", sourceId: source.id },
          });
          // Reserve the next dispatch without extending successful evidence freshness.
          await withTenant(this.database.db, context, (tx) =>
            tx
              .update(knowledgeSources)
              .set({ nextCheckAt: new Date(Date.now() + source.checkEveryHours * 3600_000) })
              .where(
                and(eq(knowledgeSources.id, source.id), eq(knowledgeSources.monitoring, true)),
              ),
          );
        }
        await purgeKnowledgeOriginals(this.database, context);
      }
    } finally {
      this.running = false;
    }
  }
  async close() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    try { await this.pending; } finally { await this.queue.close(); }
  }
}
