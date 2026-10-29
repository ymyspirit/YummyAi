import { describe, expect, it } from "vitest";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { FactoryErpStatusViewSchema } from "@yummyai/contracts/order/factory-erp-import";
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
    expect(view).toMatchObject({ status: "scheduled_by_submission", nextAction: "同步工厂进度" });
    expect(view.title).toContain("按提交默认");
    expect(view.reason).not.toContain("接受");
  });
  it("keeps an old received-only receipt without requiring an acceptance step or inventing a submitted event", () => {
    const view = attentionItem(deliveryRow("received"));
    expect(view).toMatchObject({ status: "legacy_received", nextAction: "同步工厂进度" });
    expect(view.title).toContain("已收件"); expect(view.reason).not.toContain("接受");
    expect(view.title).not.toContain("默认");
    expect(attentionItem({ ...deliveryRow("received"), submitted: true }).status).toBe("scheduled_by_submission");
  });
  it("projects verified ERP scheduled and shipped states without private values or physical shipment facts", () => {
    const row = { ...deliveryRow("submitted"), has_factory_observation: true };
    const scheduled = attentionItem(row, factoryProgress("scheduled"));
    expect(scheduled).toMatchObject({ status: "factory_scheduled", nextAction: "同步工厂进度", priority: "pending" });
    expect(scheduled.title).toContain("工厂已排产");
    const shipped = attentionItem(row, factoryProgress("shipped"));
    expect(shipped).toMatchObject({ status: "factory_shipped", nextAction: "核对实际发货" });
    expect(shipped.reason).toContain("实际交运数量");
    expect(shipped.updatedAt).toBe("2026-10-14T00:00:00.000Z");
    expect(JSON.stringify(shipped)).not.toMatch(/PRIVATE-ERP|shippedQuantity|rawStatus|trackingReference|carrier/);
    expect(row.status).toBe("submitted");
  });
  it("keeps an unverified ERP source unknown rather than falling back to an apparent confirmed status", () => {
    const view = attentionItem({ ...deliveryRow("submitted"), has_factory_observation: true, priority: 0 });
    expect(view).toMatchObject({ status: "factory_status_unavailable", nextAction: "核对原交付记录", priority: "blocked" });
    expect(view.title).not.toContain("已发货"); expect(view.title).not.toContain("已排产");
  });
  it("keeps original rejection and distinguishes pending void review from confirmed order handling", () => {
    const row = { ...deliveryRow("accepted"), has_factory_observation: true, factory_void_requires_review: true, priority: 0 };
    expect(attentionItem(row, factoryProgress("shipped", { exception: "voided_requires_review" })))
      .toMatchObject({ status: "factory_voided_requires_review", priority: "blocked", nextAction: "核对工厂作废" });
    expect(attentionItem(row, factoryProgress("shipped", { voidSummary: confirmedVoidSummary() })))
      .toMatchObject({ status: "factory_voided_requires_handling", nextAction: "处理作废异常" });
    expect(attentionItem(deliveryRow("rejected"), factoryProgress("shipped")))
      .toMatchObject({ status: "rejected", nextAction: "处理拒收" });
    expect(attentionItem(deliveryRow("submitted"), factoryProgress("shipped", { bindingReleased: true, status: null })))
      .toMatchObject({ status: "scheduled_by_submission" });
  });
});

function deliveryRow(status: string) {
  return { source: "delivery" as const, id: createEntityId(), order_id: createEntityId(), package_id: createEntityId(), line_id: createEntityId(),
    status, priority: 2, updated_at: "2026-10-13T00:00:00Z", due_at: "2026-10-15T00:00:00Z" };
}
function factoryProgress(status: "scheduled" | "shipped", extra: Record<string, unknown> = {}) {
  return FactoryErpStatusViewSchema.parse({ bindingId: createEntityId(), externalId: "PRIVATE-ERP-IDENTITY", status, exception: null,
    observationId: createEntityId(), importId: createEntityId(), rawStatus: "PRIVATE-ERP-RAW", updatedAtLocal: "PRIVATE-ERP-TIME",
    recordedAt: "2026-10-14T00:00:00.000Z", trackingReference: "PRIVATE-ERP-TRACKING", carrier: "PRIVATE-ERP-CARRIER",
    carrierService: "PRIVATE-ERP-SERVICE", shippedQuantity: null, bindingReleased: false, ...extra });
}
function confirmedVoidSummary() {
  const hash = "a".repeat(64), at = "2026-10-14T00:00:00.000Z";
  const observation = { id: createEntityId(), sequence: 1, importId: createEntityId(), rowNumber: 2,
    rowChecksum: hash, fileChecksum: hash, previewChecksum: hash, recordedAt: at };
  const latestReview = { id: createEntityId(), bindingId: createEntityId(), factoryId: createEntityId(), observation,
    source: { importId: observation.importId, fileChecksum: hash, previewChecksum: hash, rowNumber: 2 }, originalBindingRevision: 1,
    originalItemsChecksum: hash, originalObservationSequence: 1, reviewRevision: 1, previousReviewId: null,
    outcome: "confirmed_voided", reasonCode: "factory_contact", provenance: "operator_attested", requestChecksum: hash, createdAt: at };
  return { total: 1, pending: 0, requiresOrderHandling: 1,
    latest: { ...observation, sourceReadable: true, latestReview, pending: false, requiresOrderHandling: true }, nextPending: null };
}
