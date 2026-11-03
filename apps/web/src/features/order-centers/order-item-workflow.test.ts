import { describe, expect, it } from "vitest";
import { orderOperatorTask } from "@yummyai/contracts/order/workbench";
import type { OrderWorkListItem } from "@yummyai/contracts/order/workspace";
import { orderItemWorkflow } from "./order-item-workflow";

const row = (patch: Partial<OrderWorkListItem> = {}) => ({
  id: "synthetic-line", orderId: "synthetic-order", platform: "etsy", sideState: null, archivedAt: null,
  preparation: "pending_review", artwork: "not_pushed", proof: "not_required", production: "not_released",
  quantity: 1, readyQuantity: 0, shippedQuantity: 0, afterSalesCount: 0, held: false, sourceChanged: false,
  dueAt: null, designExecutor: null, designRunStatus: null, ...patch,
}) as OrderWorkListItem;

describe("per-item next steps follow the existing order workflow", () => {
  it.each([
    [{}, "开始审单"],
    [{ preparation: "needs_information" }, "补齐资料"],
  ] as const)("keeps unfinished requirements in orders for %o", (patch, action) => {
    expect(orderItemWorkflow(row(patch))).toMatchObject({ module: "orders", step: "requirements", action });
  });

  it.each(["agent", "human", null, undefined] as const)("does not infer recipe capability from executor %s", designExecutor => {
    const result = orderItemWorkflow(row({ preparation: "ready_to_push", designExecutor, productType: "shaped_pillow" }));
    expect(result).toMatchObject({ module: "orders", step: "design", action: "派发设计" });
    expect(`${result.title}${result.description}${result.action}`).not.toMatch(/启动|无人|Agent/);
  });

  it.each(["queued", "starting", "in_progress"] as const)("opens design progress for pushed %s", artwork => {
    expect(orderItemWorkflow(row({ preparation: "pushed", artwork }))).toMatchObject({ module: "artwork", step: "design", action: "查看设计进度" });
  });

  it.each([
    { preparation: "pushed", artwork: "in_review" },
    { preparation: "pushed", artwork: "in_progress", designCandidateReview: true, designRunStatus: "awaiting_review" },
  ] as const)("opens the actual review candidate without promoting it to production for %o", patch => {
    expect(orderItemWorkflow(row(patch))).toMatchObject({ module: "artwork", step: "review", action: "审核本件设计稿" });
  });

  it.each([
    { held: true }, { sideState: "on_hold" }, { sourceChanged: true },
    { archivedAt: "2026-10-30T00:00:00Z" }, { sideState: "cancelled" },
    { production: "failed" }, { production: "quality_hold" }, { designRunStatus: "needs_attention" },
  ] as const)("retains the canonical blocking task before a ready-looking candidate for %o", patch => {
    const line = row({ preparation: "pushed", artwork: "in_progress", designCandidateReview: true, ...patch });
    const task = orderOperatorTask(line), result = orderItemWorkflow(line);
    expect(result).toMatchObject({ module: task.module, action: task.action, title: task.title, description: task.description });
    expect(result.action).not.toBe("审核本件设计稿");
    expect(result.action).not.toBe("派发设计");
  });

  it.each(["failed", "unknown", "future_status"])("requires checking the pushed design's %s state instead of claiming a reviewable result", designRunStatus => {
    expect(orderItemWorkflow(row({ preparation: "pushed", artwork: "in_progress", designCandidateReview: true, designRunStatus })))
      .toMatchObject({ module: "artwork", step: "design", action: "核对设计状态" });
  });

  it("keeps an explicit server task and does not mutate its input", () => {
    const line = row({ preparation: "pushed", artwork: "in_progress", operatorTaskKey: "verify_source" });
    const before = structuredClone(line);
    expect(orderItemWorkflow(line)).toMatchObject({ module: "orders", step: "requirements", action: "核对资料变化" });
    expect(line).toEqual(before);
  });

  it("keeps customer proof on the reviewed version before production", () => {
    expect(orderItemWorkflow(row({ preparation: "pushed", artwork: "approved", proof: "pending" })))
      .toMatchObject({ module: "artwork", step: "review", action: "记录客户确认" });
    expect(orderItemWorkflow(row({ preparation: "pushed", artwork: "approved", proof: "approved", proofVersionCurrent: false })))
      .toMatchObject({ module: "artwork", step: "review", action: "记录客户确认" });
  });

  it("retains whole-order readiness before letting a reviewed item advance", () => {
    const line = row({ preparation: "pushed", artwork: "approved", orderStatus: "awaiting_review" });
    expect(orderItemWorkflow(line)).toMatchObject({ module: "orders", step: "review", action: "查看订单要求" });
  });

  it.each(["not_released", "planned", "submitted", "awaiting_quality"])("keeps canonical production work for %s", production => {
    const line = row({ preparation: "pushed", artwork: "approved", orderStatus: "reviewed", production });
    const task = orderOperatorTask(line);
    expect(orderItemWorkflow(line)).toEqual({ module: task.module, action: task.action, title: task.title, description: task.description, step: "fulfillment" });
  });

  it("waits for the whole order's production before shipping a ready item", () => {
    expect(orderItemWorkflow(row({ preparation: "pushed", artwork: "approved", readyQuantity: 1, orderStatus: "reviewed" })))
      .toMatchObject({ module: "production", step: "fulfillment", action: "查看生产进度" });
  });

  it.each([
    { readyQuantity: 1, orderStatus: "produced" },
    { shippedQuantity: 1, platformConfirmationPending: true },
    { shippedQuantity: 1 },
  ] as const)("preserves actual shipment routing for %o", patch => {
    expect(orderItemWorkflow(row(patch))).toMatchObject({ module: "shipments", step: "fulfillment" });
  });
});
