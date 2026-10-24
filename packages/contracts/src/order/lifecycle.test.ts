import { describe, expect, it } from "vitest";
import { orderLifecycleStatus, orderOperatorTask, OrderLifecycleStatusSchema, ORDER_LIFECYCLE_LABELS } from "./workbench.js";

const item = (patch = {}) => ({ sideState: null, artwork: "not_pushed", proof: "not_required", quantity: 1,
  readyQuantity: 0, shippedQuantity: 0, ...patch });

describe("whole-order lifecycle", () => {
  it("has the six agreed business states and no print-label state", () => {
    expect(Object.values(ORDER_LIFECYCLE_LABELS)).toEqual(["处理中", "待审核", "已审核", "已生产", "已出库", "已作废"]);
    expect(OrderLifecycleStatusSchema.safeParse("label_printed").success).toBe(false);
    expect(orderLifecycleStatus([])).toBeNull();
  });
  it("waits for every required artwork to be submitted", () => {
    expect(orderLifecycleStatus([item({ artwork: "approved" }), item({ artwork: "in_progress" })])).toBe("processing");
    expect(orderLifecycleStatus([item({ artwork: "approved" }), item({ artwork: "in_review" })])).toBe("awaiting_review");
    expect(orderLifecycleStatus([item({ artwork: "approved" }), item({ artwork: "changes_requested" })])).toBe("processing");
  });
  it("requires all artwork approvals and any current customer proof", () => {
    expect(orderLifecycleStatus([item({ artwork: "approved" }), item({ artwork: "approved" })])).toBe("reviewed");
    expect(orderLifecycleStatus([item({ artwork: "approved", proof: "pending" })])).toBe("awaiting_review");
    expect(orderLifecycleStatus([item({ artwork: "approved", proof: "approved" })])).toBe("awaiting_review");
    expect(orderLifecycleStatus([item({ artwork: "approved", proof: "approved", proofVersionCurrent: false })])).toBe("awaiting_review");
    expect(orderLifecycleStatus([item({ artwork: "approved", proof: "approved", proofVersionCurrent: true })])).toBe("reviewed");
  });
  it("requires all quantities, including three pillows sharing one artwork", () => {
    expect(orderLifecycleStatus([item({ artwork: "approved", quantity: 3, readyQuantity: 2 })])).toBe("reviewed");
    expect(orderLifecycleStatus([item({ quantity: 3, readyQuantity: 3 })])).toBe("produced");
    expect(orderLifecycleStatus([item({ readyQuantity: 1 }), item({ readyQuantity: 1 }), item()])).toBe("processing");
  });
  it("does not advance for a label or a factory acknowledgement", () => {
    expect(orderLifecycleStatus([item({ artwork: "approved", production: "acknowledged", labelStatus: "ready" })])).toBe("reviewed");
    expect(orderLifecycleStatus([item({ readyQuantity: 1, labelStatus: "ready" })])).toBe("produced");
  });
  it("requires physical shipment of every item and every quantity", () => {
    expect(orderLifecycleStatus([item({ quantity: 3, readyQuantity: 3, shippedQuantity: 2 })])).toBe("produced");
    expect(orderLifecycleStatus([item({ quantity: 3, readyQuantity: 3, shippedQuantity: 3 })])).toBe("shipped");
    expect(orderLifecycleStatus([item({ readyQuantity: 1, shippedQuantity: 1 }), item({ readyQuantity: 1 })])).toBe("produced");
  });
  it("retains the real milestone when paused and gives confirmed voiding priority", () => {
    expect(orderLifecycleStatus([item({ readyQuantity: 1, held: true })])).toBe("produced");
    expect(orderLifecycleStatus([item({ sideState: "cancelled", shippedQuantity: 1 })])).toBe("voided");
  });
  it("directs completed items to the remaining whole-order work", () => {
    const task = { ...item({ artwork: "approved" }), held: false, sourceChanged: false, preparation: "pushed",
      production: "not_released", afterSalesCount: 0, dueAt: null, platform: "amazon" };
    expect(orderOperatorTask({ ...task, orderStatus: "processing" })).toMatchObject({ title: "等待整单图稿审核", module: "orders", actionable: false });
    expect(orderOperatorTask({ ...task, orderStatus: "reviewed", readyQuantity: 1 })).toMatchObject({ title: "等待整单生产完成", module: "production", actionable: false });
    expect(orderOperatorTask({ ...task, orderStatus: "produced", readyQuantity: 1 })).toMatchObject({ title: "核对整单包裹与已有运单", module: "shipments" });
  });
});
