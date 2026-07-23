import type { OrderSideState, OrderWorkflowState } from "@yummyai/contracts";

export const orderTransitions: Readonly<Record<OrderWorkflowState, readonly OrderWorkflowState[]>> = {
  pending: ["awaiting_customization"],
  awaiting_customization: ["awaiting_design"],
  awaiting_design: ["awaiting_customer_approval"],
  awaiting_customer_approval: ["awaiting_routing"],
  awaiting_routing: ["in_production"],
  in_production: ["awaiting_quality_control"],
  awaiting_quality_control: ["awaiting_shipment"],
  awaiting_shipment: ["shipped"],
  shipped: ["completed"],
  completed: [],
};

export class InvalidOrderTransitionError extends Error {
  constructor(readonly from: OrderWorkflowState, readonly to: OrderWorkflowState, readonly sideState: OrderSideState | null) {
    super(sideState ? `Order ${sideState} blocks transition from ${from} to ${to}` : `Order cannot transition from ${from} to ${to}`);
    this.name = "InvalidOrderTransitionError";
  }
}

export class InvalidOrderSideStateError extends Error {
  constructor(readonly action: "hold" | "release" | "cancel", readonly workflowState: OrderWorkflowState, readonly sideState: OrderSideState | null) {
    super(`Order side-state action ${action} is invalid from ${workflowState}/${sideState ?? "active"}`);
    this.name = "InvalidOrderSideStateError";
  }
}

export function assertOrderTransition(from: OrderWorkflowState, to: OrderWorkflowState, sideState: OrderSideState | null): void {
  if (sideState || !orderTransitions[from].includes(to)) throw new InvalidOrderTransitionError(from, to, sideState);
}

export function nextOrderSideState(action: "hold" | "release" | "cancel", workflowState: OrderWorkflowState, sideState: OrderSideState | null): OrderSideState | null {
  if (action === "hold" && !sideState && workflowState !== "completed") return "on_hold";
  if (action === "release" && sideState === "on_hold") return null;
  if (action === "cancel" && sideState !== "cancelled" && !["shipped", "completed"].includes(workflowState)) return "cancelled";
  throw new InvalidOrderSideStateError(action, workflowState, sideState);
}
