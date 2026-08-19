import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { NotificationService, type NotificationRecord, type NotificationRepository } from "./notification.service.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "tenant" };

describe("notification service", () => {
  it("persists read state and supports unread inbox filters", async () => {
    const repository = new MemoryNotifications(); const service = new NotificationService(repository);
    const created = await service.create(context, { kind: "job_failed", title: "Export failed", body: "Research media was blocked" });
    expect(await service.list(context, { unreadOnly: true })).toHaveLength(1);
    await service.markRead(context, created.id);
    expect(await service.list(context, { unreadOnly: true })).toHaveLength(0);
    expect((await service.list(context))[0]?.readAt).toBeDefined();
  });

  it("marks all current-user notifications read", async () => {
    const repository = new MemoryNotifications(); const service = new NotificationService(repository);
    await service.create(context, { kind: "review_requested", title: "Review V04", body: "Amazon listing needs approval" });
    await service.create(context, { kind: "design_overdue", title: "Design overdue", body: "Production file is due" });
    await expect(service.markAllRead(context)).resolves.toBe(2);
  });
});

class MemoryNotifications implements NotificationRepository {
  rows: NotificationRecord[] = [];
  async create(_context: TenantContext, input: Parameters<NotificationRepository["create"]>[1]) { const row: NotificationRecord = { id: createEntityId(), kind: input.kind, title: input.title, body: input.body, resourceType: input.resourceType, resourceId: input.resourceId, metadata: input.metadata, createdAt: new Date().toISOString() }; this.rows.push(row); return row; }
  async list(_context: TenantContext, options: { unreadOnly: boolean; limit: number }) { return this.rows.filter((row) => !options.unreadOnly || !row.readAt).slice(0, options.limit); }
  async markRead(_context: TenantContext, id: string) { const row = this.rows.find((entry) => entry.id === id); if (row) row.readAt = new Date().toISOString(); return row; }
  async markAllRead() { let count = 0; for (const row of this.rows) if (!row.readAt) { row.readAt = new Date().toISOString(); count += 1; } return count; }
}
