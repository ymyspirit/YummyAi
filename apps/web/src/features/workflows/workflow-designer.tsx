"use client";

import dagre from "@dagrejs/dagre";
import type {
  WorkflowDefinitionDetail,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowPort,
} from "@yummyai/contracts/workflow";
import {
  addEdge,
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  useEdgesState,
  useNodesState,
  getBezierPath,
} from "@xyflow/react";
import {
  ArrowLeft,
  Bot,
  Check,
  CircleStop,
  Copy,
  Diamond,
  GitFork,
  LayoutDashboard,
  Redo2,
  Save,
  Send,
  Undo2,
  UserRoundCheck,
  UserRoundCog,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useTransition } from "react";

import { cloneWorkflowDefinition, publishWorkflowDefinition, saveWorkflowDraft } from "./workflow-actions";

type CanvasData = { definition: WorkflowNode };
type EvidenceData = {
  kind?: WorkflowEdge["kind"];
  evidence?: string;
  conditionValue?: string;
  artifactType?: WorkflowEdge["artifactType"];
  version?: string;
  validationStatus?: WorkflowEdge["validationStatus"];
  sourcePortId?: string;
  targetPortId?: string;
};
type CanvasSnapshot = { nodes: Array<Node<CanvasData>>; edges: Array<Edge<EvidenceData>> };

const ARTIFACT_TYPES: Array<NonNullable<WorkflowEdge["artifactType"]>> = [
  "any", "research_snapshot", "product_facts", "sku", "design_version", "product_package",
  "listing_version", "image", "template", "text", "production_package",
];
const CONDITION_KEYS = ["product.has_verified_facts", "product.has_authorized_assets", "review.is_approved"];

const nodeTypes = { workflowNode: WorkflowNodeCard };
const edgeTypes = { evidence: EvidenceEdge };
const LIBRARY: Array<{ kind: WorkflowNodeKind; label: string; icon: LucideIcon }> = [
  { kind: "human_task", label: "人工任务", icon: UserRoundCog },
  { kind: "approval_gate", label: "审核门", icon: UserRoundCheck },
  { kind: "condition_gate", label: "条件分支", icon: GitFork },
  { kind: "internal_action", label: "YummyAI / POD", icon: Bot },
  { kind: "external_action", label: "外部系统（预留）", icon: Workflow },
  { kind: "end", label: "结束", icon: CircleStop },
];

export function WorkflowDesigner({ definition }: { definition: WorkflowDefinitionDetail }) {
  const version = definition.draft ?? definition.published;
  const readOnly = definition.scope === "official";
  const initial = useMemo(() => canvasFromGraph(version?.graph ?? { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } }), [version]);
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<CanvasData>>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<EvidenceData>>(initial.edges);
  const [selectedId, setSelectedId] = useState<string>();
  const [selectedEdgeId, setSelectedEdgeId] = useState<string>();
  const [revision, setRevision] = useState(definition.revision);
  const [history, setHistory] = useState<CanvasSnapshot[]>([]);
  const [future, setFuture] = useState<CanvasSnapshot[]>([]);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string }>();
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const selected = nodes.find((node) => node.id === selectedId);
  const selectedEdge = edges.find((edge) => edge.id === selectedEdgeId);

  const checkpoint = useCallback(() => {
    setHistory((current) => [...current.slice(-29), { nodes: structuredClone(nodes), edges: structuredClone(edges) }]);
    setFuture([]);
  }, [edges, nodes]);

  const connect = useCallback((connection: Connection) => {
    if (readOnly) return;
    checkpoint();
    setEdges((current) => addEdge({
      ...connection,
      id: `edge-${connection.source}-${connection.target}-${Date.now()}`,
      type: "evidence",
      data: { kind: "success", evidence: "待定义交付物", validationStatus: "pending" },
    }, current));
  }, [checkpoint, readOnly, setEdges]);

  const addNode = (kind: WorkflowNodeKind) => {
    if (readOnly) return;
    checkpoint();
    const id = `${kind}-${Date.now()}`;
    const workflowNode: WorkflowNode = {
      id,
      kind,
      title: LIBRARY.find((item) => item.kind === kind)?.label ?? "新节点",
      description: "",
      ownerRole: kind === "approval_gate" ? "审核负责人" : "流程执行人",
      inputPorts: [],
      outputPorts: [],
      config: { parameters: {} },
      position: { x: 360, y: 140 + nodes.length * 48 },
    };
    setNodes((current) => [...current, { id, type: "workflowNode", position: workflowNode.position, data: { definition: workflowNode } }]);
    setSelectedId(id);
    setSelectedEdgeId(undefined);
  };

  const updateSelected = (patch: Partial<WorkflowNode>) => {
    if (!selected || readOnly) return;
    setNodes((current) => current.map((node) => node.id === selected.id
      ? { ...node, data: { definition: { ...node.data.definition, ...patch } } }
      : node));
  };

  const updateSelectedEdge = (patch: Partial<EvidenceData>) => {
    if (!selectedEdge || readOnly) return;
    setEdges((current) => current.map((edge) => edge.id === selectedEdge.id
      ? { ...edge, data: { ...edge.data, ...patch } }
      : edge));
  };

  const autoLayout = () => {
    if (readOnly) return;
    checkpoint();
    const graph = new dagre.graphlib.Graph().setDefaultEdgeLabel(() => ({}));
    graph.setGraph({ rankdir: "TB", nodesep: 70, ranksep: 95, marginx: 40, marginy: 40 });
    nodes.forEach((node) => graph.setNode(node.id, { width: 270, height: 104 }));
    edges.forEach((edge) => graph.setEdge(edge.source, edge.target));
    dagre.layout(graph);
    setNodes((current) => current.map((node) => {
      const position = graph.node(node.id);
      return { ...node, position: { x: position.x - 135, y: position.y - 52 } };
    }));
  };

  const undo = () => {
    const previous = history.at(-1);
    if (!previous) return;
    setFuture((current) => [{ nodes: structuredClone(nodes), edges: structuredClone(edges) }, ...current]);
    setHistory((current) => current.slice(0, -1));
    setNodes(previous.nodes);
    setEdges(previous.edges);
  };
  const redo = () => {
    const next = future[0];
    if (!next) return;
    setHistory((current) => [...current, { nodes: structuredClone(nodes), edges: structuredClone(edges) }]);
    setFuture((current) => current.slice(1));
    setNodes(next.nodes);
    setEdges(next.edges);
  };

  const graph = (): WorkflowGraph => ({
    nodes: nodes.map((node) => ({ ...node.data.definition, position: node.position })),
    edges: edges.map((edge): WorkflowEdge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.data?.kind ?? "success",
      ...(edge.data?.sourcePortId ? { sourcePortId: edge.data.sourcePortId } : {}),
      ...(edge.data?.targetPortId ? { targetPortId: edge.data.targetPortId } : {}),
      ...(edge.data?.evidence ? { label: edge.data.evidence } : {}),
      ...(edge.data?.conditionValue ? { conditionValue: edge.data.conditionValue } : {}),
      ...(edge.data?.artifactType ? { artifactType: edge.data.artifactType } : {}),
      ...(edge.data?.version ? { artifactVersion: edge.data.version } : {}),
      validationStatus: edge.data?.validationStatus ?? "pending",
    })),
    viewport: version?.graph.viewport ?? { x: 0, y: 0, zoom: 1 },
  });

  const save = () => startTransition(async () => {
    const result = await saveWorkflowDraft(definition.id, { graph: graph(), expectedRevision: revision });
    setFeedback({ tone: result.status, message: result.data?.issues.length ? `${result.message} ${result.data.issues.join("；")}` : result.message });
    if (result.status === "success" && result.data) setRevision(result.data.revision);
  });
  const validate = () => {
    const current = graph();
    const startCount = current.nodes.filter((node) => node.kind === "start").length;
    const endCount = current.nodes.filter((node) => node.kind === "end").length;
    const conditionWithoutDefault = current.nodes.filter((node) => node.kind === "condition_gate" && !current.edges.some((edge) => edge.source === node.id && edge.kind === "default"));
    const issues = [
      ...(startCount === 1 ? [] : [`开始节点应为 1 个，当前 ${startCount} 个`]),
      ...(endCount ? [] : ["至少需要一个结束节点"]),
      ...(conditionWithoutDefault.length ? ["条件节点需要默认出口"] : []),
    ];
    setFeedback({ tone: issues.length ? "error" : "success", message: issues.length ? issues.join("；") : "基础拓扑检查通过；发布时服务端会继续校验可达性、环路、端口与能力。" });
  };
  const publish = () => startTransition(async () => {
    const result = await publishWorkflowDefinition(definition.id, revision);
    setFeedback({ tone: result.status, message: result.message });
    if (result.status === "success" && result.data) setRevision(result.data.revision);
  });
  const clone = () => startTransition(async () => {
    const result = await cloneWorkflowDefinition(definition.id);
    setFeedback({ tone: result.status, message: result.message });
    if (result.status === "success" && result.data) router.push(`/workflows/templates/${result.data.id}/edit`);
  });

  return (
    <div className="workflow-designer">
      <header className="workflow-designer-toolbar">
        <div className="workflow-designer-title">
          <Link aria-label="返回工作流中心" href="/workflows"><ArrowLeft size={18} /></Link>
          <div><span>{readOnly ? "官方模板 · 只读" : "设计模式"}</span><h1>{definition.name}</h1></div>
          <code>v{version?.version ?? 1} · r{revision}</code>
        </div>
        <div className="workflow-toolbar-actions">
          <button disabled={!history.length || readOnly} onClick={undo} title="撤销" type="button"><Undo2 size={16} /></button>
          <button disabled={!future.length || readOnly} onClick={redo} title="重做" type="button"><Redo2 size={16} /></button>
          <button disabled={readOnly} onClick={autoLayout} type="button"><LayoutDashboard size={15} />自动排版</button>
          <button onClick={validate} type="button"><Check size={15} />验证流程</button>
          {readOnly ? <button className="primary" disabled={pending} onClick={clone} type="button"><Copy size={15} />克隆为团队模板</button> : (
            <>
              <button disabled={pending} onClick={save} type="button"><Save size={15} />保存草稿</button>
              <button className="primary" disabled={pending} onClick={publish} type="button"><Send size={15} />发布版本</button>
            </>
          )}
        </div>
      </header>
      {feedback ? <div className={`workflow-canvas-feedback ${feedback.tone}`}>{feedback.message}</div> : null}
      <div className="workflow-designer-grid">
        <aside className="workflow-node-library">
          <h2>节点库</h2>
          <p>点击添加到画布</p>
          <section><h3>人工任务</h3>{LIBRARY.slice(0, 1).map((item) => <LibraryButton disabled={readOnly} item={item} key={item.kind} onClick={() => addNode(item.kind)} />)}</section>
          <section><h3>审核与条件</h3>{LIBRARY.slice(1, 3).map((item) => <LibraryButton disabled={readOnly} item={item} key={item.kind} onClick={() => addNode(item.kind)} />)}</section>
          <section><h3>YummyAI 与 POD</h3>{LIBRARY.slice(3, 4).map((item) => <LibraryButton disabled={readOnly} item={item} key={item.kind} onClick={() => addNode(item.kind)} />)}</section>
          <section><h3>外部系统</h3>{LIBRARY.slice(4, 5).map((item) => <LibraryButton disabled={readOnly} item={item} key={item.kind} onClick={() => addNode(item.kind)} />)}<small>v1 执行器未启用，包含该节点时不能发布。</small></section>
          <section><h3>流程控制</h3>{LIBRARY.slice(5).map((item) => <LibraryButton disabled={readOnly} item={item} key={item.kind} onClick={() => addNode(item.kind)} />)}</section>
        </aside>
        <section className="workflow-flow-stage" aria-label="工作流设计画布">
          <ReactFlow
            colorMode="dark"
            defaultViewport={version?.graph.viewport}
            edges={edges}
            edgeTypes={edgeTypes}
            fitView
            nodes={nodes}
            nodesConnectable={!readOnly}
            nodesDraggable={!readOnly}
            nodesFocusable
            nodeTypes={nodeTypes}
            onConnect={connect}
            onEdgeClick={(_, edge) => { setSelectedEdgeId(edge.id); setSelectedId(undefined); }}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onNodeClick={(_, node) => { setSelectedId(node.id); setSelectedEdgeId(undefined); }}
            onNodesChange={readOnly ? undefined : onNodesChange}
            onPaneClick={() => { setSelectedId(undefined); setSelectedEdgeId(undefined); }}
            proOptions={{ hideAttribution: true }}
          >
            <Background color="#283435" gap={22} size={1.3} />
            <Controls showInteractive={false} />
            <MiniMap maskColor="rgba(15,20,21,.82)" nodeColor={(node) => statusColor((node.data as CanvasData).definition.kind)} pannable zoomable />
          </ReactFlow>
        </section>
        <aside className="workflow-node-inspector">
          {selected ? (
            <>
              <div className="workflow-inspector-heading"><span>{kindLabel(selected.data.definition.kind)}</span><code>{selected.id}</code></div>
              <label>节点标题<input disabled={readOnly} value={selected.data.definition.title} onChange={(event) => updateSelected({ title: event.target.value })} /></label>
              <label>责任角色<input disabled={readOnly} value={selected.data.definition.ownerRole} onChange={(event) => updateSelected({ ownerRole: event.target.value })} /></label>
              <label>所需业务权限<input disabled={readOnly} placeholder="例如 design:review" value={selected.data.definition.requiredPermission ?? ""} onChange={(event) => updateSelected({ requiredPermission: event.target.value || undefined })} /></label>
              <label>输入端口<textarea disabled={readOnly} placeholder="facts | 已确认事实 | product_facts | required" rows={3} value={formatPorts(selected.data.definition.inputPorts)} onChange={(event) => updateSelected({ inputPorts: parsePorts(event.target.value) })} /><small>每行：ID | 名称 | 类型 | required（可选）</small></label>
              <label>输出端口<textarea disabled={readOnly} placeholder="package | 产品包 ZIP | product_package" rows={3} value={formatPorts(selected.data.definition.outputPorts)} onChange={(event) => updateSelected({ outputPorts: parsePorts(event.target.value) })} /><small>类型需与交接连线和下游端口兼容</small></label>
              <label>说明<textarea disabled={readOnly} rows={4} value={selected.data.definition.description} onChange={(event) => updateSelected({ description: event.target.value })} /></label>
              <label>员工必做操作<textarea disabled={readOnly} rows={5} value={(selected.data.definition.config.requiredActions ?? []).join("\n")} onChange={(event) => updateSelected({ config: { ...selected.data.definition.config, requiredActions: lines(event.target.value) } })} /></label>
              <label>阻断条件<textarea disabled={readOnly} rows={4} value={(selected.data.definition.config.blockingConditions ?? []).join("\n")} onChange={(event) => updateSelected({ config: { ...selected.data.definition.config, blockingConditions: lines(event.target.value) } })} /></label>
              {selected.data.definition.kind === "approval_gate" ? <><label>审核方式<select disabled={readOnly} value={selected.data.definition.config.approvalMode ?? "any"} onChange={(event) => updateSelected({ config: { ...selected.data.definition.config, approvalMode: event.target.value as "any" | "all" } })}><option value="any">任一审核人批准</option><option value="all">全部审核人批准</option></select></label><label>返工目标节点 ID<input disabled={readOnly} value={selected.data.definition.reworkTargetNodeId ?? ""} onChange={(event) => updateSelected({ reworkTargetNodeId: event.target.value || undefined })} /></label></> : null}
              {selected.data.definition.kind === "condition_gate" ? <label>注册条件规则<select disabled={readOnly} value={selected.data.definition.config.conditionKey ?? ""} onChange={(event) => updateSelected({ config: { ...selected.data.definition.config, conditionKey: event.target.value || undefined } })}><option value="">请选择规则</option>{CONDITION_KEYS.map((key) => <option key={key} value={key}>{key}</option>)}</select></label> : null}
              {selected.data.definition.kind === "internal_action" || selected.data.definition.kind === "external_action" ? <label>能力 Key<input disabled={readOnly} value={selected.data.definition.config.capabilityKey ?? ""} onChange={(event) => updateSelected({ config: { ...selected.data.definition.config, capabilityKey: event.target.value || undefined } })} /></label> : null}
            </>
          ) : selectedEdge ? (
            <>
              <div className="workflow-inspector-heading"><span>证据交接连线</span><code>{selectedEdge.id}</code></div>
              <label>连线类型
                <select disabled={readOnly} value={selectedEdge.data?.kind ?? "success"} onChange={(event) => updateSelectedEdge({ kind: event.target.value as WorkflowEdge["kind"] })}>
                  <option value="success">成功出口</option><option value="condition">条件命中</option><option value="default">默认分支</option><option value="rework">返工关系</option>
                </select>
              </label>
              {(selectedEdge.data?.kind ?? "success") === "condition" ? <label>条件值<input disabled={readOnly} placeholder="选择已注册规则的匹配值" value={selectedEdge.data?.conditionValue ?? ""} onChange={(event) => updateSelectedEdge({ conditionValue: event.target.value || undefined })} /></label> : null}
              <label>交付物名称<input disabled={readOnly} placeholder="例如 已确认产品事实" value={selectedEdge.data?.evidence ?? ""} onChange={(event) => updateSelectedEdge({ evidence: event.target.value || undefined })} /></label>
              <label>交付物类型
                <select disabled={readOnly} value={selectedEdge.data?.artifactType ?? ""} onChange={(event) => updateSelectedEdge({ artifactType: (event.target.value || undefined) as WorkflowEdge["artifactType"] })}>
                  <option value="">未指定</option>{ARTIFACT_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label>版本标识<input disabled={readOnly} placeholder="例如 v3" value={selectedEdge.data?.version ?? ""} onChange={(event) => updateSelectedEdge({ version: event.target.value || undefined })} /></label>
              <label>验证状态
                <select disabled={readOnly} value={selectedEdge.data?.validationStatus ?? "pending"} onChange={(event) => updateSelectedEdge({ validationStatus: event.target.value as WorkflowEdge["validationStatus"] })}>
                  <option value="pending">待验证</option><option value="valid">已验证</option><option value="invalid">无效</option>
                </select>
              </label>
            </>
          ) : <div className="workflow-inspector-empty"><Diamond size={24} /><strong>选择节点或连线</strong><p>配置任务责任、条件分支与证据交接信息。</p></div>}
        </aside>
      </div>
    </div>
  );
}

function WorkflowNodeCard({ data, selected }: NodeProps<Node<CanvasData>>) {
  const node = data.definition;
  return (
    <div className={`workflow-canvas-node kind-${node.kind} ${selected ? "selected" : ""}`}>
      {node.kind !== "start" ? <Handle position={Position.Top} type="target" /> : null}
      <div className="workflow-node-kind"><span style={{ background: statusColor(node.kind) }} />{kindLabel(node.kind)}</div>
      <strong>{node.title}</strong>
      <small>{node.ownerRole}</small>
      {node.config.artifactLabel ? <em>{node.config.artifactLabel}</em> : null}
      {node.kind !== "end" ? <Handle position={Position.Bottom} type="source" /> : null}
    </div>
  );
}

function EvidenceEdge(props: EdgeProps<Edge<EvidenceData>>) {
  const [path, labelX, labelY] = getBezierPath(props);
  return (
    <>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} style={{ stroke: props.selected ? "#E8793E" : "#718384", strokeWidth: props.selected ? 2.5 : 1.7 }} />
      <EdgeLabelRenderer><div className="workflow-edge-evidence" style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}><b>{props.data?.evidence ?? "交付物"}</b>{props.data?.version ? <code>{props.data.version}</code> : null}<i className={props.data?.validationStatus ?? "pending"} /></div></EdgeLabelRenderer>
    </>
  );
}

function LibraryButton({ item, onClick, disabled }: { item: (typeof LIBRARY)[number]; onClick(): void; disabled: boolean }) {
  const Icon = item.icon;
  return <button disabled={disabled} onClick={onClick} type="button"><Icon size={15} /><span>{item.label}</span><b>+</b></button>;
}

function canvasFromGraph(graph: WorkflowGraph): CanvasSnapshot {
  return {
    nodes: graph.nodes.map((node) => ({ id: node.id, type: "workflowNode", position: node.position, data: { definition: node } })),
    edges: graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "evidence",
      data: {
        kind: edge.kind,
        evidence: edge.label,
        conditionValue: edge.conditionValue,
        artifactType: edge.artifactType,
        version: edge.artifactVersion,
        validationStatus: edge.validationStatus,
        sourcePortId: edge.sourcePortId,
        targetPortId: edge.targetPortId,
      },
    })),
  };
}

function kindLabel(kind: WorkflowNodeKind) {
  return ({ start: "开始", end: "结束", human_task: "人工任务", approval_gate: "审核门", condition_gate: "条件分支", internal_action: "内部能力", external_action: "外部能力" } as const)[kind];
}

function statusColor(kind: WorkflowNodeKind) {
  if (kind === "start" || kind === "end") return "#3CA777";
  if (kind === "approval_gate") return "#E8793E";
  if (kind === "condition_gate") return "#D7A644";
  if (kind === "external_action") return "#D95757";
  if (kind === "internal_action") return "#5A8FB4";
  return "#718384";
}

function lines(value: string) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function formatPorts(ports: WorkflowPort[]) {
  return ports.map((port) => `${port.id} | ${port.label} | ${port.dataType}${port.required ? " | required" : ""}`).join("\n");
}

function parsePorts(value: string): WorkflowPort[] {
  return value.split("\n").flatMap((line) => {
    const [id, label, dataType, required] = line.split("|").map((part) => part?.trim());
    if (!id || !label || !dataType || !ARTIFACT_TYPES.includes(dataType as WorkflowPort["dataType"])) return [];
    return [{ id, label, dataType: dataType as WorkflowPort["dataType"], required: required === "required" }];
  });
}
