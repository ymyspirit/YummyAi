import type { OrderWorkflowState } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { assertOrderTransition, InvalidOrderSideStateError, InvalidOrderTransitionError, nextOrderSideState, orderTransitions } from "./order-state-machine.js";

describe("order state machine", () => {
  it("allows only the explicit forward workflow graph", () => {
    const states = Object.keys(orderTransitions) as OrderWorkflowState[];
    for (const state of states) for (const target of states) {
      const allowed = orderTransitions[state].includes(target);
      if (allowed) expect(() => assertOrderTransition(state, target, null)).not.toThrow();
      else expect(() => assertOrderTransition(state, target, null)).toThrow(InvalidOrderTransitionError);
    }
  });

  it("blocks main transitions while held or cancelled", () => {
    expect(() => assertOrderTransition("pending", "awaiting_customization", "on_hold")).toThrow(InvalidOrderTransitionError);
    expect(() => assertOrderTransition("pending", "awaiting_customization", "cancelled")).toThrow(InvalidOrderTransitionError);
  });

  it("keeps hold and cancellation independent from main state", () => {
    expect(nextOrderSideState("hold", "awaiting_design", null)).toBe("on_hold");
    expect(nextOrderSideState("release", "awaiting_design", "on_hold")).toBeNull();
    expect(nextOrderSideState("cancel", "awaiting_design", null)).toBe("cancelled");
  });

  it("cannot cancel a shipped order or release an active order", () => {
    expect(() => nextOrderSideState("cancel", "shipped", null)).toThrow(InvalidOrderSideStateError);
    expect(() => nextOrderSideState("release", "pending", null)).toThrow(InvalidOrderSideStateError);
  });
});
