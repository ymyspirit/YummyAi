import { SecretVault } from "@yummyai/ai-core";
import { HttpException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, fulfillmentAutomationEvents, fulfillmentAutomationTasks, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { NotificationService, type NotificationRepository } from "../notifications/notification.service.js";
import { FulfillmentAutomationService, type FulfillmentAutomationEnqueuer } from "./fulfillment-automation.service.js";

describe("fulfillment automation scheduling and recovery", () => {
  const database = connectDatabase(); const tenantA = createEntityId(); const tenantB = createEntityId(); const tenantC = createEntityId(); const userA = createEntityId(); const userB = createEntityId(); const userC = createEntityId();
  const contextA: TenantContext = { tenantId: tenantA, userId: userA, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const contextB: TenantContext = { tenantId: tenantB, userId: userB, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const contextC: TenantContext = { tenantId: tenantC, userId: userC, permissions: ["order:read", "order:write"], dataScope: "tenant" };
  const enqueue = vi.fn().mockResolvedValue(undefined); let service: FulfillmentAutomationService;
  beforeAll(async () => {
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3),($4,$5,$6)", [tenantA, "Automation A", `automation-a-${tenantA}`, tenantB, "Automation B", `automation-b-${tenantB}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)", [userA, `automation-a-${userA}`, `a-${userA}@example.test`, "A", userB, `automation-b-${userB}`, `b-${userB}@example.test`, "B"]);
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,$2,$3)", [tenantC, "Automation Load", `automation-load-${tenantC}`]);
    await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,$4)", [userC, `automation-load-${userC}`, `load-${userC}@example.test`, "Load"]);
    const notifications = new NotificationService({ create: vi.fn(), list: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() } as unknown as NotificationRepository);
    service = new FulfillmentAutomationService(database, new SecretVault(Buffer.alloc(32, 81)), { enqueue } as FulfillmentAutomationEnqueuer, notifications, new AuditService(database));
  });
  afterAll(async () => { await database.client.end(); });

  it("enforces tenant quota, replay, cross-tenant isolation, and encrypted cancellation evidence", async () => {
    await service.updatePolicy(contextA, { hourlyQuota: 1, maxAttempts: 2 });
    const input = { type: "attention_scan" as const, runAt: "2026-07-23T12:00:00.000Z", maxAttempts: 3, idempotencyKey: "fulfillment-task-0001" };
    const scheduled = await service.schedule(contextA, input);
    expect(scheduled.task).toMatchObject({ status: "scheduled", maxAttempts: 2, projectionVersion: 1 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ taskId: scheduled.task.id, deliveryId: scheduled.task.id, maxAttempts: 2 }));
    expect((await service.schedule(contextA, input)).task.id).toBe(scheduled.task.id);
    await expect(service.schedule(contextA, { ...input, idempotencyKey: "fulfillment-task-0002" })).rejects.toBeInstanceOf(HttpException);
    await expect(service.get(contextB, scheduled.task.id)).rejects.toBeInstanceOf(NotFoundException);
    const cancelled = await service.cancel(contextA, scheduled.task.id, { expectedProjectionVersion: 1, reason: "Private operator cancellation reason", idempotencyKey: "fulfillment-cancel-0001" });
    expect(cancelled.task.status).toBe("cancelled");
    expect(JSON.stringify(cancelled)).not.toContain("Private operator cancellation reason");
    const [event] = await withTenant(database.db, contextA, (tx) => tx.select().from(fulfillmentAutomationEvents).where(eq(fulfillmentAutomationEvents.action, "cancelled")));
    expect(event?.encryptedDetail).not.toContain("Private operator cancellation reason");
  });

  it("allows a dead-letter task to be manually rescheduled with a fresh queue delivery", async () => {
    const taskId = createEntityId();
    await withTenant(database.db, contextB, async (tx) => {
      await tx.insert(fulfillmentAutomationTasks).values({ id: taskId, tenantId: tenantB, type: "shipment_reconciliation_scan", status: "dead_letter", runAt: new Date("2026-07-22T12:00:00.000Z"), attemptCount: 2, maxAttempts: 2, projectionVersion: 2, idempotencyKey: "dead-letter-fixture-0001", requestedBy: userB });
      await tx.insert(fulfillmentAutomationEvents).values({ id: createEntityId(), tenantId: tenantB, taskId, sequence: 1, action: "dead_letter", fromStatus: "running", toStatus: "dead_letter", code: "RETRY_EXHAUSTED", summary: "Retry limit exhausted", idempotencyKey: "dead-letter-event-0001", actorUserId: userB });
    });
    const reconciled = await service.reconcile(contextB, taskId, { outcome: "rescheduled", expectedProjectionVersion: 2, reason: "Operator verified dependencies", runAt: "2026-07-24T12:00:00.000Z", idempotencyKey: "manual-reschedule-0001" });
    expect(reconciled.task).toMatchObject({ status: "scheduled", attemptCount: 0, projectionVersion: 3 });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ taskId, deliveryId: expect.any(String), runAt: "2026-07-24T12:00:00.000Z" }));
    expect(enqueue.mock.calls.at(-1)?.[0].deliveryId).not.toBe(taskId);
  });

  it("serializes concurrent scheduling at the tenant quota", async () => {
    await service.updatePolicy(contextC, { hourlyQuota: 10, maxAttempts: 2 });
    const outcomes = await Promise.allSettled(Array.from({ length: 25 }, (_, index) => service.schedule(contextC, {
      type: "attention_scan", runAt: "2026-07-25T12:00:00.000Z", maxAttempts: 3,
      idempotencyKey: `fulfillment-load-${index.toString().padStart(4, "0")}`,
    })));
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(10);
    expect(outcomes.filter((entry) => entry.status === "rejected" && entry.reason instanceof HttpException)).toHaveLength(15);
    const tasks = await service.list(contextC);
    expect(tasks).toHaveLength(10);
  });

  it("moves queue admission failure to dead letter and notifies without automatic replay", async () => {
    const createNotification = vi.fn().mockResolvedValue({});
    const notifications = new NotificationService({ create: createNotification, list: vi.fn(), markRead: vi.fn(), markAllRead: vi.fn() } as unknown as NotificationRepository);
    const failed = new FulfillmentAutomationService(database, new SecretVault(Buffer.alloc(32, 81)), { enqueue: vi.fn().mockRejectedValue(new Error("redis unavailable")) }, notifications, new AuditService(database));
    const idempotencyKey = "fulfillment-queue-failure-0001";
    await expect(failed.schedule(contextB, { type: "attention_scan", runAt: "2026-07-25T12:00:00.000Z", maxAttempts: 2, idempotencyKey })).rejects.toBeInstanceOf(ServiceUnavailableException);
    const [task] = await withTenant(database.db, contextB, (tx) => tx.select().from(fulfillmentAutomationTasks).where(eq(fulfillmentAutomationTasks.idempotencyKey, idempotencyKey)).limit(1));
    expect(task).toMatchObject({ status: "dead_letter", projectionVersion: 2, attemptCount: 0 });
    const events = await withTenant(database.db, contextB, (tx) => tx.select().from(fulfillmentAutomationEvents).where(eq(fulfillmentAutomationEvents.taskId, task!.id)));
    expect(events.map((event) => event.action)).toEqual(["scheduled", "dead_letter"]);
    expect(createNotification).toHaveBeenCalledOnce();
  });
});
