import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  afterSalesCases, fulfillmentAutomationEvents, fulfillmentAutomationTasks, notifications,
  orderProtectedDetails, productionOrders, returnShipments, shipmentWritebackRequests,
  type DatabaseConnection, type TenantTransaction, withTenant,
} from "@yummyai/database";
import { FulfillmentAutomationJobPayloadSchema, type JobEnvelope } from "@yummyai/jobs";
import { and, count, desc, eq, inArray, lt, sql } from "drizzle-orm";

export interface FulfillmentAutomationSnapshot { taskId: string; type: string; projectionVersion: number; attemptCount: number; maxAttempts: number; requestedBy: string }
export interface FulfillmentAutomationResult { status: "completed" | "reconciliation_required"; code: string; summary: string }
export interface FulfillmentAutomationExecutionRepository {
  claim(context: TenantContext, taskId: string): Promise<FulfillmentAutomationSnapshot | undefined>;
  complete(context: TenantContext, snapshot: FulfillmentAutomationSnapshot, result: FulfillmentAutomationResult): Promise<void>;
  fail(context: TenantContext, snapshot: FulfillmentAutomationSnapshot, code: string): Promise<{ retry: boolean }>;
}
export interface FulfillmentAutomationRunner { run(context: TenantContext, snapshot: FulfillmentAutomationSnapshot): Promise<FulfillmentAutomationResult> }

export class FulfillmentAutomationProcessor {
  constructor(private readonly repository: FulfillmentAutomationExecutionRepository, private readonly runner: FulfillmentAutomationRunner) {}
  async process(envelope: JobEnvelope) {
    const { taskId } = FulfillmentAutomationJobPayloadSchema.parse(envelope.payload);
    const context: TenantContext = { tenantId: envelope.tenantId, userId: envelope.requestedBy, permissions: [], dataScope: "tenant" };
    const snapshot = await this.repository.claim(context, taskId);
    if (!snapshot) return { taskId, status: "ignored" };
    try {
      const result = await this.runner.run(context, snapshot);
      await this.repository.complete(context, snapshot, result);
      return { taskId, status: result.status };
    } catch {
      const outcome = await this.repository.fail(context, snapshot, "AUTOMATION_EXECUTION_FAILED");
      if (outcome.retry) throw new Error("Fulfillment automation retry scheduled");
      return { taskId, status: "dead_letter" };
    }
  }
}

export class DrizzleFulfillmentAutomationExecutionRepository implements FulfillmentAutomationExecutionRepository {
  constructor(private readonly database: DatabaseConnection) {}
  async claim(context: TenantContext, taskId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      await lock(tx, taskId);
      const [task] = await tx.select().from(fulfillmentAutomationTasks).where(eq(fulfillmentAutomationTasks.id, taskId)).limit(1);
      if (!task || task.status !== "scheduled" || task.runAt > new Date()) return undefined;
      const attemptCount = task.attemptCount + 1;
      await appendEvent(tx, context, task, "claimed", "running", "TASK_CLAIMED", "Task claimed by worker");
      await tx.update(fulfillmentAutomationTasks).set({ status: "running", attemptCount, projectionVersion: task.projectionVersion + 1, updatedAt: new Date() }).where(eq(fulfillmentAutomationTasks.id, taskId));
      return { taskId, type: task.type, projectionVersion: task.projectionVersion + 1, attemptCount, maxAttempts: task.maxAttempts, requestedBy: task.requestedBy };
    });
  }
  async complete(context: TenantContext, snapshot: FulfillmentAutomationSnapshot, result: FulfillmentAutomationResult) {
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, snapshot.taskId);
      const [task] = await tx.select().from(fulfillmentAutomationTasks).where(eq(fulfillmentAutomationTasks.id, snapshot.taskId)).limit(1);
      if (!task || task.status !== "running" || task.projectionVersion !== snapshot.projectionVersion) return;
      await appendEvent(tx, context, task, result.status === "completed" ? "completed" : "reconciliation_required", result.status, result.code, result.summary);
      await tx.update(fulfillmentAutomationTasks).set({ status: result.status, projectionVersion: task.projectionVersion + 1, updatedAt: new Date() }).where(eq(fulfillmentAutomationTasks.id, task.id));
      if (result.status === "reconciliation_required") await notify(tx, context, task, "履约自动化需要人工对账", result.code);
    });
  }
  async fail(context: TenantContext, snapshot: FulfillmentAutomationSnapshot, code: string) {
    return withTenant(this.database.db, context, async (tx) => {
      await lock(tx, snapshot.taskId);
      const [task] = await tx.select().from(fulfillmentAutomationTasks).where(eq(fulfillmentAutomationTasks.id, snapshot.taskId)).limit(1);
      if (!task || task.status !== "running" || task.projectionVersion !== snapshot.projectionVersion) return { retry: false };
      const retry = task.attemptCount < task.maxAttempts;
      const status = retry ? "scheduled" : "dead_letter";
      const action = retry ? "retry_scheduled" : "dead_letter";
      await appendEvent(tx, context, task, action, status, code, retry ? "Retry scheduled by queue policy" : "Retry limit exhausted");
      await tx.update(fulfillmentAutomationTasks).set({ status, projectionVersion: task.projectionVersion + 1, updatedAt: new Date() }).where(eq(fulfillmentAutomationTasks.id, task.id));
      if (!retry) await notify(tx, context, task, "履约自动化进入死信", code);
      return { retry };
    });
  }
}

export class DrizzleFulfillmentAttentionRunner implements FulfillmentAutomationRunner {
  constructor(private readonly database: DatabaseConnection) {}
  async run(context: TenantContext, snapshot: FulfillmentAutomationSnapshot): Promise<FulfillmentAutomationResult> {
    const now = new Date();
    if (snapshot.type === "attention_scan") {
      const counts = await withTenant(this.database.db, context, async (tx) => {
        const [[production], [writebacks], [returns], [afterSales]] = await Promise.all([
          tx.select({ value: count() }).from(productionOrders).where(and(inArray(productionOrders.status, ["planned", "submitted", "acknowledged", "in_production"]), lt(productionOrders.expectedCompletionAt, now))),
          tx.select({ value: count() }).from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.status, "reconciliation_required")),
          tx.select({ value: count() }).from(returnShipments).where(eq(returnShipments.status, "lost")),
          tx.select({ value: count() }).from(afterSalesCases).where(eq(afterSalesCases.status, "awaiting_internal")),
        ]);
        return { production: production?.value ?? 0, writebacks: writebacks?.value ?? 0, returns: returns?.value ?? 0, afterSales: afterSales?.value ?? 0 };
      });
      const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
      return { status: total ? "reconciliation_required" : "completed", code: total ? "FULFILLMENT_ATTENTION_REQUIRED" : "NO_ATTENTION_REQUIRED", summary: `production=${counts.production};writebacks=${counts.writebacks};returns=${counts.returns};afterSales=${counts.afterSales}` };
    }
    if (snapshot.type === "shipment_reconciliation_scan") {
      const [result] = await withTenant(this.database.db, context, (tx) => tx.select({ value: count() }).from(shipmentWritebackRequests).where(eq(shipmentWritebackRequests.status, "reconciliation_required")));
      const value = result?.value ?? 0;
      return { status: value ? "reconciliation_required" : "completed", code: value ? "SHIPMENT_RECONCILIATION_REQUIRED" : "NO_SHIPMENT_RECONCILIATION", summary: `writebacks=${value}` };
    }
    const [expired] = await withTenant(this.database.db, context, (tx) => tx.select({ value: count() }).from(orderProtectedDetails).where(and(eq(orderProtectedDetails.status, "protected"), lt(orderProtectedDetails.retentionExpiresAt, now))));
    const value = expired?.value ?? 0;
    return { status: value ? "reconciliation_required" : "completed", code: value ? "PII_RETENTION_ACTION_REQUIRED" : "NO_EXPIRED_PII", summary: `expired=${value}` };
  }
}

async function appendEvent(tx: TenantTransaction, context: TenantContext, task: typeof fulfillmentAutomationTasks.$inferSelect, action: string, toStatus: string, code: string, summary: string) {
  const [latest] = await tx.select({ sequence: fulfillmentAutomationEvents.sequence }).from(fulfillmentAutomationEvents).where(eq(fulfillmentAutomationEvents.taskId, task.id)).orderBy(desc(fulfillmentAutomationEvents.sequence)).limit(1);
  await tx.insert(fulfillmentAutomationEvents).values({ id: createEntityId(), tenantId: context.tenantId, taskId: task.id, sequence: (latest?.sequence ?? 0) + 1, action, fromStatus: task.status, toStatus, code, summary, idempotencyKey: `${action}:${task.projectionVersion}`, actorUserId: context.userId });
}
async function notify(tx: TenantTransaction, context: TenantContext, task: typeof fulfillmentAutomationTasks.$inferSelect, title: string, code: string) {
  await tx.insert(notifications).values({ id: createEntityId(), tenantId: context.tenantId, userId: task.requestedBy, kind: "job_failed", title, body: "任务需要人工检查，详情请查看履约自动化事件。", resourceType: "fulfillment_automation_task", resourceId: task.id, metadata: { code } });
}
async function lock(tx: TenantTransaction, key: string) { await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`); }
