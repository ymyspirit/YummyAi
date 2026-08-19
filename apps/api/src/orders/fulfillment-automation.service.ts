import { createHash } from "node:crypto";

import type { SecretVault } from "@yummyai/ai-core";
import { ConflictException, HttpException, HttpStatus, Inject, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import {
  CancelFulfillmentAutomationInputSchema, ReconcileFulfillmentAutomationInputSchema,
  ScheduleFulfillmentAutomationInputSchema, UpdateFulfillmentAutomationPolicyInputSchema, createEntityId,
  type CancelFulfillmentAutomationInput, type ReconcileFulfillmentAutomationInput,
  type ScheduleFulfillmentAutomationInput, type TenantContext, type UpdateFulfillmentAutomationPolicyInput,
} from "@yummyai/contracts";
import {
  fulfillmentAutomationEvents, fulfillmentAutomationPolicies, fulfillmentAutomationTasks,
  type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { and, asc, count, desc, eq, gte, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { NotificationService } from "../notifications/notification.service.js";
import { DATABASE_CONNECTION, FULFILLMENT_AUTOMATION_ENQUEUER, ORDER_PII_VAULT } from "../platform.tokens.js";

@Injectable()
export class FulfillmentAutomationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ORDER_PII_VAULT) private readonly vault: SecretVault,
    @Inject(FULFILLMENT_AUTOMATION_ENQUEUER) private readonly enqueuer: FulfillmentAutomationEnqueuer,
    @Inject(NotificationService) private readonly notifications: NotificationService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async schedule(context: TenantContext, rawInput: ScheduleFulfillmentAutomationInput) {
    const input = ScheduleFulfillmentAutomationInputSchema.parse(rawInput);
    const taskId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `fulfillment-automation-quota:${context.tenantId}`);
      const [replayed] = await tx.select({ id: fulfillmentAutomationTasks.id }).from(fulfillmentAutomationTasks).where(eq(fulfillmentAutomationTasks.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return replayed.id;
      const [policy] = await tx.select().from(fulfillmentAutomationPolicies).where(eq(fulfillmentAutomationPolicies.tenantId, context.tenantId)).limit(1);
      const [usage] = await tx.select({ value: count() }).from(fulfillmentAutomationTasks).where(gte(fulfillmentAutomationTasks.createdAt, new Date(Date.now() - 3_600_000)));
      const quota = policy?.hourlyQuota ?? 20;
      if ((usage?.value ?? 0) >= quota) throw new HttpException("Fulfillment automation hourly quota exceeded", HttpStatus.TOO_MANY_REQUESTS);
      const id = createEntityId();
      await tx.insert(fulfillmentAutomationTasks).values({
        id, tenantId: context.tenantId, type: input.type, runAt: new Date(input.runAt),
        maxAttempts: Math.min(input.maxAttempts, policy?.maxAttempts ?? 3), idempotencyKey: input.idempotencyKey, requestedBy: context.userId,
      });
      await appendEvent(tx, context, id, 1, "scheduled", null, "scheduled", "TASK_SCHEDULED", "Task scheduled", input.idempotencyKey);
      return id;
    });
    const task = await this.get(context, taskId);
    try {
      await this.enqueuer.enqueue({ taskId, deliveryId: taskId, tenantId: context.tenantId, requestedBy: context.userId, runAt: task.task.runAt.toISOString(), maxAttempts: task.task.maxAttempts });
    } catch {
      await this.queueFailure(context, taskId);
      throw new ServiceUnavailableException("Fulfillment automation queue is unavailable");
    }
    await this.audit.record(context, { action: "fulfillment_automation.schedule", resourceType: "fulfillment_automation_task", resourceId: taskId, result: "success", metadata: { type: input.type, runAt: input.runAt } });
    return this.get(context, taskId);
  }

  async cancel(context: TenantContext, taskId: string, rawInput: CancelFulfillmentAutomationInput) {
    const input = CancelFulfillmentAutomationInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `fulfillment-automation:${taskId}`);
      const [task] = await tx.select().from(fulfillmentAutomationTasks).where(eq(fulfillmentAutomationTasks.id, taskId)).limit(1);
      if (!task) throw new NotFoundException("Fulfillment automation task not found");
      if (await hasEvent(tx, taskId, input.idempotencyKey)) return;
      if (task.projectionVersion !== input.expectedProjectionVersion) throw new ConflictException("Fulfillment automation version changed");
      if (task.status !== "scheduled") throw new ConflictException("Only a scheduled automation task can be cancelled");
      await appendEvent(tx, context, taskId, await nextSequence(tx, taskId), "cancelled", task.status, "cancelled", "OPERATOR_CANCELLED", null, input.idempotencyKey, this.vault.encrypt(input.reason), checksum(input.reason));
      await tx.update(fulfillmentAutomationTasks).set({ status: "cancelled", projectionVersion: task.projectionVersion + 1, updatedAt: new Date() }).where(eq(fulfillmentAutomationTasks.id, taskId));
    });
    await this.audit.record(context, { action: "fulfillment_automation.cancel", resourceType: "fulfillment_automation_task", resourceId: taskId, result: "success", metadata: {} });
    return this.get(context, taskId);
  }

  async reconcile(context: TenantContext, taskId: string, rawInput: ReconcileFulfillmentAutomationInput) {
    const input = ReconcileFulfillmentAutomationInputSchema.parse(rawInput);
    let enqueue: { deliveryId: string; runAt: string; maxAttempts: number } | undefined;
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `fulfillment-automation:${taskId}`);
      const [task] = await tx.select().from(fulfillmentAutomationTasks).where(eq(fulfillmentAutomationTasks.id, taskId)).limit(1);
      if (!task) throw new NotFoundException("Fulfillment automation task not found");
      if (await hasEvent(tx, taskId, input.idempotencyKey)) return;
      if (task.projectionVersion !== input.expectedProjectionVersion) throw new ConflictException("Fulfillment automation version changed");
      if (!["failed", "dead_letter", "reconciliation_required"].includes(task.status)) throw new ConflictException("Task does not require reconciliation");
      const toStatus = input.outcome === "rescheduled" ? "scheduled" : input.outcome;
      const runAt = input.runAt ? new Date(input.runAt) : task.runAt;
      await appendEvent(tx, context, taskId, await nextSequence(tx, taskId), "reconciled", task.status, toStatus, `MANUAL_${input.outcome.toUpperCase()}`, null, input.idempotencyKey, this.vault.encrypt(input.reason), checksum(input.reason));
      await tx.update(fulfillmentAutomationTasks).set({ status: toStatus, runAt, attemptCount: input.outcome === "rescheduled" ? 0 : task.attemptCount, projectionVersion: task.projectionVersion + 1, updatedAt: new Date() }).where(eq(fulfillmentAutomationTasks.id, taskId));
      if (input.outcome === "rescheduled") enqueue = { deliveryId: createEntityId(), runAt: runAt.toISOString(), maxAttempts: task.maxAttempts };
    });
    if (enqueue) await this.enqueuer.enqueue({ taskId, tenantId: context.tenantId, requestedBy: context.userId, ...enqueue });
    await this.audit.record(context, { action: "fulfillment_automation.reconcile", resourceType: "fulfillment_automation_task", resourceId: taskId, result: "success", metadata: { outcome: input.outcome } });
    return this.get(context, taskId);
  }

  async updatePolicy(context: TenantContext, rawInput: UpdateFulfillmentAutomationPolicyInput) {
    const input = UpdateFulfillmentAutomationPolicyInputSchema.parse(rawInput);
    const [policy] = await withTenant(this.database.db, context, (tx) => tx.insert(fulfillmentAutomationPolicies).values({ tenantId: context.tenantId, ...input, updatedBy: context.userId })
      .onConflictDoUpdate({ target: fulfillmentAutomationPolicies.tenantId, set: { ...input, updatedBy: context.userId, updatedAt: new Date() } }).returning());
    await this.audit.record(context, { action: "fulfillment_automation.policy.update", resourceType: "fulfillment_automation_policy", resourceId: context.tenantId, result: "success", metadata: input });
    return policy;
  }

  list(context: TenantContext) { return withTenant(this.database.db, context, (tx) => tx.select().from(fulfillmentAutomationTasks).orderBy(desc(fulfillmentAutomationTasks.createdAt)).limit(100)); }

  async get(context: TenantContext, taskId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [task] = await tx.select().from(fulfillmentAutomationTasks).where(eq(fulfillmentAutomationTasks.id, taskId)).limit(1);
      if (!task) throw new NotFoundException("Fulfillment automation task not found");
      const events = await tx.select({ id: fulfillmentAutomationEvents.id, sequence: fulfillmentAutomationEvents.sequence, action: fulfillmentAutomationEvents.action, fromStatus: fulfillmentAutomationEvents.fromStatus, toStatus: fulfillmentAutomationEvents.toStatus, code: fulfillmentAutomationEvents.code, summary: fulfillmentAutomationEvents.summary, detailChecksum: fulfillmentAutomationEvents.detailChecksum, actorUserId: fulfillmentAutomationEvents.actorUserId, occurredAt: fulfillmentAutomationEvents.occurredAt }).from(fulfillmentAutomationEvents).where(eq(fulfillmentAutomationEvents.taskId, taskId)).orderBy(asc(fulfillmentAutomationEvents.sequence));
      return { task, events };
    });
  }

  private async queueFailure(context: TenantContext, taskId: string) {
    await withTenant(this.database.db, context, async (tx) => {
      const [task] = await tx.select().from(fulfillmentAutomationTasks).where(eq(fulfillmentAutomationTasks.id, taskId)).limit(1);
      if (!task || task.status !== "scheduled") return;
      await appendEvent(tx, context, taskId, await nextSequence(tx, taskId), "dead_letter", task.status, "dead_letter", "QUEUE_UNAVAILABLE", "Queue unavailable", `queue-failure:${taskId}`);
      await tx.update(fulfillmentAutomationTasks).set({ status: "dead_letter", projectionVersion: task.projectionVersion + 1, updatedAt: new Date() }).where(eq(fulfillmentAutomationTasks.id, taskId));
    });
    await this.notifications.create(context, { kind: "job_failed", title: "履约自动化进入死信", body: "任务未能进入执行队列，需要人工检查。", resourceType: "fulfillment_automation_task", resourceId: taskId, metadata: { code: "QUEUE_UNAVAILABLE" } });
  }
}

async function appendEvent(tx: TenantTransaction, context: TenantContext, taskId: string, sequence: number, action: string, fromStatus: string | null, toStatus: string, code: string | null, summary: string | null, idempotencyKey: string, encryptedDetail: string | null = null, detailChecksum: string | null = null) {
  await tx.insert(fulfillmentAutomationEvents).values({ id: createEntityId(), tenantId: context.tenantId, taskId, sequence, action, fromStatus, toStatus, code, summary, encryptedDetail, detailChecksum, idempotencyKey, actorUserId: context.userId });
}
async function nextSequence(tx: TenantTransaction, taskId: string) { const [latest] = await tx.select({ sequence: fulfillmentAutomationEvents.sequence }).from(fulfillmentAutomationEvents).where(eq(fulfillmentAutomationEvents.taskId, taskId)).orderBy(desc(fulfillmentAutomationEvents.sequence)).limit(1); return (latest?.sequence ?? 0) + 1; }
async function hasEvent(tx: TenantTransaction, taskId: string, key: string) { const [event] = await tx.select({ id: fulfillmentAutomationEvents.id }).from(fulfillmentAutomationEvents).where(and(eq(fulfillmentAutomationEvents.taskId, taskId), eq(fulfillmentAutomationEvents.idempotencyKey, key))).limit(1); return Boolean(event); }
async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
function checksum(value: string) { return createHash("sha256").update(value).digest("hex"); }

export interface FulfillmentAutomationEnqueuer { enqueue(input: { taskId: string; deliveryId: string; tenantId: string; requestedBy: string; runAt: string; maxAttempts: number }): Promise<void> }
