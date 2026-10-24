import { createEntityId } from "@yummyai/contracts/common/ids";
import { WorkflowRunDetailSchema } from "@yummyai/contracts/workflow";
import { buildWorkflowStarterGraph } from "./workflow-center";

export function operatorRun(capability = "yummyai.custom_product.generate_provisional_facts") {
  const graph = buildWorkflowStarterGraph("linear");
  const node = graph.nodes.find((node) => node.id === "work")!;
  node.kind = "internal_action";
  node.config = { parameters: {}, capabilityKey: capability };
  return WorkflowRunDetailSchema.parse({
    id: createEntityId(),
    definitionId: createEntityId(),
    definitionVersionId: createEntityId(),
    definitionName: "Operator fixture",
    definitionVersion: 1,
    productPlanId: createEntityId(),
    productName: "Synthetic product",
    title: "Synthetic workflow",
    status: "failed",
    currentNodeId: "work",
    completedNodes: 1,
    totalNodes: 3,
    revision: 8,
    updatedAt: new Date().toISOString(),
    graph,
    nodes: graph.nodes.map((node) => ({
      id: createEntityId(),
      nodeId: node.id,
      kind: node.kind,
      title: node.title,
      ownerRole: node.ownerRole,
      status: node.id === "work" ? "failed" : node.id === "start" ? "completed" : "not_started",
      parameterSnapshot: {},
      attemptCount: node.id === "work" ? 1 : 0,
      updatedAt: new Date().toISOString(),
    })),
    artifacts: [],
    events: [],
  });
}
