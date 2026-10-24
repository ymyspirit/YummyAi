import { describe, expect, it } from "vitest";
import { orderDeadline, operatorView } from "./order-operator-view";
import type { OrderWorkListItem } from "@yummyai/contracts/order/workspace";

describe("operator views and deadline communication", () => {
  it("defaults to role tasks and preserves explicit historical workflow links", () => {
    expect(operatorView(new URLSearchParams())).toBe("todo");
    expect(operatorView(new URLSearchParams("stage=in_review"))).toBe("all");
    expect(operatorView(new URLSearchParams("archived=only"))).toBe("all");
    expect(operatorView(new URLSearchParams("archived=active&q=order"))).toBe("todo");
    expect(operatorView(new URLSearchParams("workView=waiting"))).toBe("waiting");
  });
  const base = { platform: "amazon", dueAt: null, quantity: 1, shippedQuantity: 0, sideState: null } as OrderWorkListItem;
  const now = Date.parse("2026-10-06T00:00:00Z");
  it("marks unknown platform dates without treating them as zero risk or inventing a date", () => {
    expect(orderDeadline(base, now)).toEqual({ text: "平台交期待核对", tone: "warning", missing: true });
    expect(orderDeadline({ ...base, platform: "etsy" }, now).tone).toBe("normal");
  });
  it("shows the actual platform date independently of an internal due date", () => {
    expect(orderDeadline({ ...base, dueAt: "2026-10-01T00:00:00Z", platformShipByAt: "2026-10-06T08:00:00Z" }, now)).toMatchObject({ text: "距平台截止 8 小时", tone: "warning" });
    expect(orderDeadline({ ...base, platformShipByAt: "2026-10-05T00:00:00Z" }, now)).toMatchObject({ text: "平台截止已过 1 天", tone: "danger" });
  });
  it("does not raise shipment-deadline alarms for cancelled, archived or already handed-over items", () => {
    for (const changes of [{ sideState: "cancelled" }, { archivedAt: "2026-10-05T00:00:00Z" }, { shippedQuantity: 1 }])
      expect(orderDeadline({ ...base, ...changes, platformShipByAt: "2026-10-05T00:00:00Z" }, now).tone).toBe("normal");
  });
});
