import { orderOperatorTask } from "@yummyai/contracts/order/workbench";
import type { OrderWorkListItem, OrderWorkspaceModule } from "@yummyai/contracts/order/workspace";

export type OrderItemWorkflow = {
  module: OrderWorkspaceModule;
  action: string;
  title: string;
  description: string;
  step: "requirements" | "design" | "review" | "fulfillment";
};

const knownDesignStatuses = new Set(["queued", "running", "awaiting_review", "needs_attention", "cancelled"]);

/** Navigation and copy only. The canonical task retains its blocking priority;
 * confirming requirements and explicitly dispatching remain separate commands. */
export function orderItemWorkflow(line: OrderWorkListItem): OrderItemWorkflow {
  const task = orderOperatorTask(line);
  const current = { module: task.module, action: task.action, title: task.title, description: task.description };
  if (line.preparation === "pushed" && line.designRunStatus && !knownDesignStatuses.has(line.designRunStatus)
    && ["waiting_design", "review_artwork", "design_attention", "dispatch_design"].includes(task.key)) {
    return { module: "artwork", action: "核对设计状态", title: "核对本件设计状态",
      description: "请先核对原任务状态与已保存的设计结果", step: "design" };
  }
  switch (task.key) {
    case "review_order":
    case "complete_information":
      return { ...current, step: "requirements" };
    case "dispatch_design":
      // List rows do not contain the pinned recipe or runtime capability.
      // Even designExecutor=agent is not proof that an Agent run can start.
      return { module: "orders", action: "派发设计", title: "派发本件设计",
        description: "审单已确认 按本件已保存的制作方式派发设计", step: "design" };
    case "waiting_design":
      return { ...current, module: "artwork", action: "查看设计进度", title: "跟进本件设计", step: "design" };
    case "design_attention":
      return { ...current, step: "design" };
    case "review_artwork":
      return { ...current, module: "artwork", action: "审核本件设计稿", title: "审核本件设计稿", step: "review" };
    case "customer_proof":
    case "customer_changes":
      return { ...current, step: "review" };
    case "waiting_production":
      // A reviewed item can still be waiting for its siblings' artwork.
      return { ...current, step: task.module === "orders" ? "review" : "fulfillment" };
    default:
      return { ...current, step: task.module === "orders" ? "requirements" : "fulfillment" };
  }
}
