import { WorkflowGraphSchema } from "@yummyai/contracts/workflow";
import { describe, expect, it } from "vitest";

import { buildWorkflowStarterGraph } from "./workflow-center";

describe("workflow starter templates", () => {
  it.each(["blank", "linear", "approval"] as const)("builds a valid %s starter graph", (starter) => {
    const graph = WorkflowGraphSchema.parse(buildWorkflowStarterGraph(starter));
    expect(graph.nodes[0]).toMatchObject({ id: "start", kind: "start" });
    expect(graph.nodes.at(-1)).toMatchObject({ id: "end", kind: "end" });
  });

  it("includes an explicit approval rework relation", () => {
    const graph = buildWorkflowStarterGraph("approval");
    expect(graph.nodes.find((node) => node.id === "approval")).toMatchObject({
      kind: "approval_gate",
      reworkTargetNodeId: "work",
    });
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: "approval", target: "work", kind: "rework" }));
  });
});
