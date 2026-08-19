import {
  WorkflowGraphSchema,
  type WorkflowGraph,
  type WorkflowPortDataType,
  type WorkflowValidationIssue,
  type WorkflowValidationResult,
} from "@yummyai/contracts/workflow";

export interface WorkflowCapabilityDescriptor {
  key: string;
  enabled: boolean;
  executor: "internal" | "external";
  inputTypes: readonly WorkflowPortDataType[];
  outputTypes: readonly WorkflowPortDataType[];
  requiredPermission?: string;
  rightsPolicy?: "none" | "authorized_only" | "reference_analysis_only";
}

export interface WorkflowValidationRegistry {
  capabilities: ReadonlyMap<string, WorkflowCapabilityDescriptor>;
  conditions: ReadonlySet<string>;
  externalExecutorEnabled: boolean;
}

export function validateWorkflowGraph(
  rawGraph: WorkflowGraph,
  registry: WorkflowValidationRegistry,
): WorkflowValidationResult {
  const parsed = WorkflowGraphSchema.safeParse(rawGraph);
  if (!parsed.success) {
    return {
      valid: false,
      issues: parsed.error.issues.map((issue) => ({
        code: "schema_invalid",
        message: `${issue.path.join(".") || "graph"}: ${issue.message}`,
      })),
    };
  }
  const graph = parsed.data;
  const issues: WorkflowValidationIssue[] = [];
  const nodeById = new Map<string, (typeof graph.nodes)[number]>();
  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) {
      issues.push({ code: "duplicate_node_id", message: `节点 ID ${node.id} 重复`, nodeId: node.id });
    }
    nodeById.set(node.id, node);
    assertUniquePorts(node.id, node.inputPorts, "输入", issues);
    assertUniquePorts(node.id, node.outputPorts, "输出", issues);
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) {
      issues.push({ code: "duplicate_edge_id", message: `连线 ID ${edge.id} 重复`, edgeId: edge.id });
    }
    edgeIds.add(edge.id);
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    if (!source || !target) {
      issues.push({ code: "dangling_edge", message: `连线 ${edge.id} 指向不存在的节点`, edgeId: edge.id });
      continue;
    }
    const sourcePort = edge.sourcePortId
      ? source.outputPorts.find((port) => port.id === edge.sourcePortId)
      : undefined;
    const targetPort = edge.targetPortId
      ? target.inputPorts.find((port) => port.id === edge.targetPortId)
      : undefined;
    if (edge.sourcePortId && !sourcePort) {
      issues.push({ code: "source_port_missing", message: `找不到输出端口 ${edge.sourcePortId}`, edgeId: edge.id });
    }
    if (edge.targetPortId && !targetPort) {
      issues.push({ code: "target_port_missing", message: `找不到输入端口 ${edge.targetPortId}`, edgeId: edge.id });
    }
    const sourceType = sourcePort?.dataType ?? edge.artifactType;
    const targetType = targetPort?.dataType;
    if (sourceType && targetType && !portsCompatible(sourceType, targetType)) {
      issues.push({
        code: "port_type_mismatch",
        message: `${source.title} 的 ${sourceType} 不能交付给 ${target.title} 的 ${targetType}`,
        edgeId: edge.id,
      });
    }
  }

  const starts = graph.nodes.filter((node) => node.kind === "start");
  const ends = graph.nodes.filter((node) => node.kind === "end");
  if (starts.length !== 1) {
    issues.push({ code: "start_count", message: `流程必须且只能有一个开始节点，当前为 ${starts.length} 个` });
  }
  if (!ends.length) issues.push({ code: "end_missing", message: "流程至少需要一个结束节点" });

  const normalEdges = graph.edges.filter((edge) => edge.kind !== "rework" && nodeById.has(edge.source) && nodeById.has(edge.target));
  const outgoing = groupEdges(normalEdges, "source");
  for (const node of graph.nodes) {
    const nodeEdges = outgoing.get(node.id) ?? [];
    if (node.kind !== "condition_gate" && node.kind !== "end" && nodeEdges.length > 1) {
      issues.push({
        code: "parallel_fanout",
        message: `${node.title} 存在并行扇出；v1 只允许条件节点分支`,
        nodeId: node.id,
      });
    }
    if (node.kind === "condition_gate") {
      if (!node.config.conditionKey || !registry.conditions.has(node.config.conditionKey)) {
        issues.push({ code: "condition_unregistered", message: `${node.title} 未选择已注册条件`, nodeId: node.id });
      }
      if (nodeEdges.filter((edge) => edge.kind === "default").length !== 1) {
        issues.push({ code: "condition_default", message: `${node.title} 必须且只能有一个默认出口`, nodeId: node.id });
      }
    }
    if (node.kind === "internal_action" || node.kind === "external_action") {
      const capability = node.config.capabilityKey
        ? registry.capabilities.get(node.config.capabilityKey)
        : undefined;
      if (!capability) {
        issues.push({ code: "capability_missing", message: `${node.title} 的执行能力未注册`, nodeId: node.id });
      } else if (!capability.enabled) {
        issues.push({ code: "capability_disabled", message: `${node.title} 的执行能力尚未启用`, nodeId: node.id });
      } else if (node.kind === "external_action" && capability.executor !== "external") {
        issues.push({ code: "executor_mismatch", message: `${node.title} 不是外部执行能力`, nodeId: node.id });
      }
      if (node.kind === "external_action" && !registry.externalExecutorEnabled) {
        issues.push({ code: "external_executor_disabled", message: `${node.title} 无法发布：外部执行器未启用`, nodeId: node.id });
      }
    }
    if (node.reworkTargetNodeId && !nodeById.has(node.reworkTargetNodeId)) {
      issues.push({ code: "rework_target_missing", message: `${node.title} 的返工目标不存在`, nodeId: node.id });
    }
  }

  if (starts[0]) {
    const reachable = visitFrom(starts[0].id, outgoing);
    for (const node of graph.nodes) {
      if (!reachable.has(node.id)) {
        issues.push({ code: "node_unreachable", message: `${node.title} 无法从开始节点到达`, nodeId: node.id });
      }
    }
  }
  for (const nodeId of findCycleNodes(graph.nodes.map((node) => node.id), outgoing)) {
    issues.push({ code: "execution_cycle", message: `正常执行边形成环路：${nodeId}`, nodeId });
  }
  return { valid: issues.length === 0, issues };
}

function assertUniquePorts(
  nodeId: string,
  ports: ReadonlyArray<{ id: string }>,
  direction: string,
  issues: WorkflowValidationIssue[],
) {
  const ids = new Set<string>();
  for (const port of ports) {
    if (ids.has(port.id)) issues.push({ code: "duplicate_port_id", message: `${direction}端口 ${port.id} 重复`, nodeId });
    ids.add(port.id);
  }
}

function portsCompatible(source: WorkflowPortDataType, target: WorkflowPortDataType) {
  return source === "any" || target === "any" || source === target;
}

function groupEdges(
  edges: WorkflowGraph["edges"],
  key: "source" | "target",
): Map<string, WorkflowGraph["edges"]> {
  const grouped = new Map<string, WorkflowGraph["edges"]>();
  for (const edge of edges) grouped.set(edge[key], [...(grouped.get(edge[key]) ?? []), edge]);
  return grouped;
}

function visitFrom(startId: string, outgoing: Map<string, WorkflowGraph["edges"]>) {
  const visited = new Set<string>();
  const pending = [startId];
  while (pending.length) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of outgoing.get(current) ?? []) pending.push(edge.target);
  }
  return visited;
}

function findCycleNodes(nodeIds: string[], outgoing: Map<string, WorkflowGraph["edges"]>) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const cycles = new Set<string>();
  const visit = (nodeId: string) => {
    if (visiting.has(nodeId)) {
      cycles.add(nodeId);
      return;
    }
    if (visited.has(nodeId)) return;
    visiting.add(nodeId);
    for (const edge of outgoing.get(nodeId) ?? []) visit(edge.target);
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  for (const nodeId of nodeIds) visit(nodeId);
  return cycles;
}
