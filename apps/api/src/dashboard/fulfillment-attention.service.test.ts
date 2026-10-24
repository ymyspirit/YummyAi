import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import type { DatabaseConnection } from "@yummyai/database";
import { attentionItem, attentionSources, FulfillmentAttentionService } from "./fulfillment-attention.service.js";

const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
describe("fulfillment attention access and recovery guidance", () => {
  it("checks current domain permissions and tenant scope before reading any rows", async () => {
    const service = new FulfillmentAttentionService({} as DatabaseConnection);
    await expect(service.workspace({ ...context, permissions: [] }, {})).rejects.toThrow("Permission denied");
    const restricted = { ...context, permissions: [Permission.DashboardRead] };
    const view = await service.workspace(restricted, {});
    expect(view.sources).toHaveLength(3); expect(view.sources.every(source => !source.available && source.count === null)).toBe(true);
    await expect(service.workspace(restricted, { source: "logistics" })).rejects.toThrow("Permission denied");
    expect(attentionSources({ ...context, dataScope: "self" })).toEqual([]);
    expect(attentionSources({ ...context, dataScope: "team" })).toEqual([]);
    expect(attentionSources({ ...context, permissions: context.permissions.filter(p => p !== Permission.AssetRead) })).toEqual(["logistics", "production"]);
  });
  it("resumes the same uncertain logistics task without exposing provider details", () => {
    const id = createEntityId();
    const view = attentionItem({ source: "logistics", id, order_id: createEntityId(), package_id: null, line_id: null, status: "reconciliation_required", priority: 0, updated_at: "2026-10-13T00:00:00Z", due_at: null });
    expect(view).toMatchObject({ href: `/logistics?task=${id}`, nextAction: "核对原任务", priority: "blocked", dueAt: null });
    expect(view.reason).toContain("查单"); expect(Object.keys(view)).not.toContain("diagnostic");
  });
  it("opens the exact delivery package in its original order", () => {
    const id = createEntityId(), order = createEntityId(), line = createEntityId(), packet = createEntityId();
    const view = attentionItem({ source: "delivery", id, order_id: order, line_id: line, package_id: packet, status: "submitted", priority: 2, updated_at: "2026-10-13T00:00:00Z", due_at: "2026-10-14T00:00:00Z" });
    expect(view.href).toBe(`/production?order=${order}&line=${line}&delivery=${packet}`);
    expect(view.title).toContain("等待工厂收件"); expect(view.nextAction).toBe("核对收件");
  });
});
