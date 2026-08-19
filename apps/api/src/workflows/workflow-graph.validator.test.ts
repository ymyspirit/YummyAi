import { describe, expect, it } from "vitest";

import { AMAZON_CUSTOM_OFFICIAL_GRAPH } from "./amazon-custom-workflow.blueprint.js";
import { WorkflowCapabilityRegistry } from "./workflow-capability.registry.js";
import { validateWorkflowGraph } from "./workflow-graph.validator.js";

const registry = new WorkflowCapabilityRegistry().validationRegistry();

describe("workflow graph validation", () => {
  it("accepts the official Amazon Custom graph", () => {
    expect(validateWorkflowGraph(AMAZON_CUSTOM_OFFICIAL_GRAPH, registry)).toEqual({ valid: true, issues: [] });
  });

  it("rejects normal execution cycles", () => {
    const graph = structuredClone(AMAZON_CUSTOM_OFFICIAL_GRAPH);
    graph.edges.push({ id: "cycle", source: "end", target: "research_capture", kind: "success" });
    const result = validateWorkflowGraph(graph, registry);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "execution_cycle")).toBe(true);
  });

  it("requires a default branch on every condition gate", () => {
    const graph = structuredClone(AMAZON_CUSTOM_OFFICIAL_GRAPH);
    const node = graph.nodes.find((item) => item.id === "research_review")!;
    node.kind = "condition_gate";
    node.config.conditionKey = "product.has_verified_facts";
    const result = validateWorkflowGraph(graph, registry);
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "condition_default", nodeId: node.id })]));
  });

  it("rejects incompatible evidence ports", () => {
    const graph = structuredClone(AMAZON_CUSTOM_OFFICIAL_GRAPH);
    const source = graph.nodes.find((item) => item.id === "research_capture")!;
    const target = graph.nodes.find((item) => item.id === "research_review")!;
    source.outputPorts = [{ id: "out", label: "事实", dataType: "product_facts", required: true }];
    target.inputPorts = [{ id: "in", label: "图片", dataType: "image", required: true }];
    const edge = graph.edges.find((item) => item.source === source.id)!;
    edge.sourcePortId = "out";
    edge.targetPortId = "in";
    const result = validateWorkflowGraph(graph, registry);
    expect(result.issues.some((issue) => issue.code === "port_type_mismatch")).toBe(true);
  });

  it("blocks external nodes while the n8n adapter is disabled", () => {
    const graph = structuredClone(AMAZON_CUSTOM_OFFICIAL_GRAPH);
    const node = graph.nodes.find((item) => item.id === "studio_content")!;
    node.kind = "external_action";
    node.config.capabilityKey = "external.n8n.webhook";
    const result = validateWorkflowGraph(graph, registry);
    expect(result.issues.some((issue) => issue.code === "external_executor_disabled")).toBe(true);
  });

  it("enforces the 100 node contract limit", () => {
    const graph = structuredClone(AMAZON_CUSTOM_OFFICIAL_GRAPH);
    while (graph.nodes.length <= 100) {
      const index = graph.nodes.length;
      graph.nodes.push({
        id: `extra-${index}`,
        kind: "human_task",
        title: `Extra ${index}`,
        description: "",
        ownerRole: "tester",
        inputPorts: [],
        outputPorts: [],
        config: { parameters: {} },
        position: { x: 0, y: index * 20 },
      });
    }
    const result = validateWorkflowGraph(graph, registry);
    expect(result.issues.some((issue) => issue.code === "schema_invalid")).toBe(true);
  });
});
