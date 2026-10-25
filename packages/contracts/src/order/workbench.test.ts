import { describe, expect, it } from "vitest";
import { orderOperatorTask, orderOperatorException } from "./workbench.js";
import { OrderWorkListViewSchema } from "./workspace.js";

const row = {
  sideState: null, preparation: "pending_review", artwork: "not_pushed", production: "not_released",
  readyQuantity: 0, shippedQuantity: 0, quantity: 2, held: false, sourceChanged: false,
  proof: "not_required", afterSalesCount: 0, platform: "etsy", dueAt: null,
};
describe("operations tasks preserve handoff and evidence boundaries", () => {
  it.each([
    [{}, "review_order", "orders", true],
    [{ preparation: "ready_to_push" }, "dispatch_design", "orders", true],
    [{ artwork: "in_review", preparation: "pushed" }, "review_artwork", "artwork", true],
    [{ artwork: "in_progress", preparation: "pushed", designExecutor: "agent" }, "waiting_design", "artwork", false],
    [{ artwork: "approved", preparation: "pushed" }, "waiting_production", "production", true],
    [{ artwork: "approved", proof: "pending" }, "customer_proof", "artwork", true],
    [{ artwork: "approved", proof: "approved", proofVersionCurrent: false }, "customer_proof", "artwork", true],
    [{ readyQuantity: 2, labelStatus: "ready" }, "waiting_shipping", "shipments", true],
    [{ shippedQuantity: 2, platformConfirmationPending: true }, "confirm_shipment", "shipments", true],
    [{ shippedQuantity: 2 }, "complete", "shipments", false],
    [{ artwork: "in_progress", designRunStatus: "needs_attention" }, "design_attention", "artwork", false],
    [{ production: "quality_hold" }, "production_attention", "production", false],
  ] as const)("derives the next role task for %o", (changes, key, module, actionable) => {
    const task = orderOperatorTask({ ...row, ...changes });
    expect(task).toMatchObject({ key, module, actionable });
  });
  it("does not infer a person or a completion estimate", () => {
    expect(orderOperatorTask({ ...row, artwork: "queued" }).owner).toBe("制图岗位");
    expect(orderOperatorTask({ ...row, artwork: "queued", designExecutor: "agent" }).owner).toBe("设计 Agent");
  });
  it.each(["submitted", "acknowledged"])("follows the factory's two statuses after %s without requiring an extra acknowledgement or start", production => {
    const task = orderOperatorTask({ ...row, preparation: "pushed", artwork: "approved", production, orderStatus: "reviewed" });
    expect(task).toMatchObject({ key: "waiting_production", title: "跟进工厂排产与发货", action: "核对工厂状态", module: "production" });
    expect(task.description).toMatch(/Excel.*CSV/);
    expect(task.description).toContain("质检");
    expect(task.action).not.toMatch(/接单|开工/);
  });
  it("keeps missing platform dates and internal overdue plans separate from workflow progress", () => {
    const now = Date.parse("2026-10-06T00:00:00Z");
    expect(orderOperatorException({ ...row, platform: "amazon" }, now)).toBe(true);
    expect(orderOperatorException(row, now)).toBe(false);
    expect(orderOperatorException({ ...row, dueAt: "2026-10-05T00:00:00Z" }, now)).toBe(true);
    expect(orderOperatorException({ ...row, platform: "amazon", shippedQuantity: 2 }, now)).toBe(false);
    expect(orderOperatorException({ ...row, held: true, archivedAt: "2026-10-05T00:00:00Z" }, now)).toBe(false);
    expect(orderOperatorException({ ...row, sourceChanged: true, sideState: "cancelled" }, now)).toBe(false);
  });
});

describe("matching order quantities preserve old response compatibility", () => {
  const legacy = { items: [], total: 0, groupTotal: 0, page: 1, pageSize: 25 };
  it("distinguishes omitted legacy quantities from a confirmed empty match", () => {
    expect(OrderWorkListViewSchema.parse(legacy).matchingQuantity).toBeUndefined();
    expect(OrderWorkListViewSchema.parse({ ...legacy, matchingQuantity: 0 }).matchingQuantity).toBe(0);
    expect(OrderWorkListViewSchema.parse({ ...legacy, total: 3, groupTotal: 2, matchingQuantity: 6 }).matchingQuantity).toBe(6);
  });
  it("rejects negative and fractional unit totals", () => {
    for (const matchingQuantity of [-1, 1.5])
      expect(OrderWorkListViewSchema.safeParse({ ...legacy, matchingQuantity }).success).toBe(false);
  });
});
