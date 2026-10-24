"use client";
import { WorkflowResponsibilityPanel } from "./workflow-responsibility-panel";
import { observeViewTransition } from "../navigation/view-transition";
import { NotificationMenu } from "../notifications/notification-menu";

import type {
  WorkflowNode,
  WorkflowNodeRunStatus,
  WorkflowRunDetail,
} from "@yummyai/contracts/workflow";
import {
  Background,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  getBezierPath,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import {
  AlertOctagon,
  ArrowLeft,
  Check,
  CheckCircle2,
  CircleDashed,
  Clock3,
  FileCheck2,
  LocateFixed,
  GitPullRequestArrow,
  List,
  Map as MapIcon,
  MessageSquareText,
  PauseCircle,
  RefreshCcw,
  RotateCcw,
  ShieldCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { flushSync } from "react-dom";

import { commandWorkflowNode } from "./workflow-actions";
import {
  WorkflowArtifacts,
  WorkflowExecutionHistory,
  WorkflowRepairPanel,
  useNodeInspection,
} from "./workflow-operator-panels";
import { useWorkflowRun } from "./use-workflow-run";
import "./workflow-operator.css";

type RunNodeData = {
  definition: WorkflowNode;
  status: WorkflowNodeRunStatus;
  current: boolean;
  note?: string;
};
type RunEdgeData = { evidence: string; version?: string; validationStatus: string };
const nodeTypes = { runNode: RunNodeCard };
const edgeTypes = { evidence: RunEvidenceEdge };

export function WorkflowRunWorkspace({ run: initialRun }: { run: WorkflowRunDetail }) {
  const [pending, startTransition] = useTransition();
  const { run, refresh, refreshKey, notice, locked } = useWorkflowRun(initialRun, pending);
  const params = useSearchParams();
  const [selectedId, setSelectedId] = useState(
    run.graph.nodes.some((node) => node.id === params.get("node"))
      ? params.get("node")!
      : (run.nodes.find((node) => node.id === params.get("task"))?.nodeId ?? run.currentNodeId ??
          run.nodes.find((node) => node.status === "blocked")?.nodeId ??
          run.graph.nodes[1]?.id),
  );
  const [view, setView] = useState<"canvas" | "list">("canvas");
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string }>();
  const router = useRouter();
  const flow = useRef<{
    fitView(options: { nodes: Array<{ id: string }>; duration: number; padding: number }): unknown;
  } | null>(null);
  const transition = (change: () => void) => {
    if (
      typeof document.startViewTransition === "function" &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches
    )
      observeViewTransition(document.startViewTransition(() => flushSync(change)));
    else change();
  };
  const selectNode = (id: string) =>
    transition(() => {
      setSelectedId(id);
      const url = new URL(window.location.href);
      url.searchParams.set("node", id);
      window.history.replaceState(null, "", url);
    });
  useEffect(() => {
    if (window.matchMedia("(max-width: 820px)").matches) setView("list");
  }, []);
  const runByNode = useMemo(
    () => new globalThis.Map(run.nodes.map((node) => [node.nodeId, node] as const)),
    [run.nodes],
  );
  const canvasNodes: Array<Node<RunNodeData>> = useMemo(
    () =>
      run.graph.nodes.map((node) => {
        const nodeRun = runByNode.get(node.id)!;
        return {
          id: node.id,
          type: "runNode",
          position: node.position,
          data: {
            definition: node,
            status: nodeRun.status,
            current: run.currentNodeId === node.id,
            note: nodeRun.note,
          },
          draggable: false,
        };
      }),
    [run.currentNodeId, run.graph.nodes, runByNode],
  );
  const canvasEdges: Array<Edge<RunEdgeData>> = useMemo(
    () =>
      run.graph.edges.map((edge) => {
        const artifact = run.artifacts.find(
          (item) =>
            item.nodeId === edge.source &&
            (!edge.artifactType || item.artifactType === edge.artifactType),
        );
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: "evidence",
          animated: edge.source === run.currentNodeId,
          data: {
            evidence: artifact?.label ?? "尚无产物",
            version: artifact?.artifactVersion ?? edge.artifactVersion,
            validationStatus: artifact?.validationStatus ?? edge.validationStatus ?? "pending",
          },
        };
      }),
    [run.artifacts, run.currentNodeId, run.graph.edges],
  );
  const selectedDefinition = run.graph.nodes.find((node) => node.id === selectedId);
  const selectedRun = run.nodes.find((node) => node.nodeId === selectedId);
  const currentFocus = canvasNodes.filter((node) => node.id === run.currentNodeId);

  const command = (input: Parameters<typeof commandWorkflowNode>[2]) =>
    startTransition(async () => {
      if (!selectedDefinition) return;
      const result = await commandWorkflowNode(run.id, selectedDefinition.id, input);
      setFeedback({ tone: result.status, message: result.message });
      if (result.status === "success" || result.httpStatus === 409) {
        await refresh();
        router.refresh();
      }
    });

  if (locked)
    return (
      <div className="wf-run-unavailable" role="alert">
        <h1>任务暂不可查看</h1>
        <p>{notice}</p>
        <button onClick={() => void refresh()} type="button">
          重新读取
        </button>
        <Link href="/workflows">返回工作流中心</Link>
      </div>
    );

  return (
    <div className="workflow-run-workspace">
      <header className="workflow-run-toolbar">
        <div>
          <Link aria-label="返回工作流中心" href="/workflows">
            <ArrowLeft size={18} />
          </Link>
          <div>
            <span>
              {run.definitionName} · v{run.definitionVersion}
            </span>
            <h1>{run.productName}</h1>
          </div>
          <RunState status={run.status} />
        </div>
        <section className="workflow-run-summary">
          <span>
            <b>
              {run.completedNodes}/{run.totalNodes}
            </b>
            任务完成
          </span>
          <span>
            <b>r{run.revision}</b>当前修订
          </span>
          <button disabled={pending} onClick={() => void refresh()} type="button">
            <RefreshCcw size={15} />
            刷新
          </button>
          {run.currentNodeId ? (
            <button
              onClick={() => {
                selectNode(run.currentNodeId!);
                void flow.current?.fitView({
                  nodes: [{ id: run.currentNodeId! }],
                  duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180,
                  padding: 0.65,
                });
              }}
              type="button"
            >
              <LocateFixed size={15} />
              当前任务
            </button>
          ) : null}
          <div>
            <button
              aria-pressed={view === "canvas"}
              className={view === "canvas" ? "active" : ""}
              onClick={() => transition(() => setView("canvas"))}
              type="button"
            >
              <MapIcon size={15} />
              画布
            </button>
            <button
              aria-pressed={view === "list"}
              className={view === "list" ? "active" : ""}
              onClick={() => transition(() => setView("list"))}
              type="button"
            >
              <List size={15} />
              列表
            </button>
          </div>
          <NotificationMenu initialNotifications={[]} />
        </section>
      </header>
      <div className={`wf-sync-notice ${notice ? "error" : ""}`} role="status">
        {notice ??
          (run.status === "active"
            ? "后台运行时自动更新 可以离开后返回此页"
            : "执行记录与产物已保存 可随时返回核对")}
      </div>
      {feedback ? (
        <div
          className={`workflow-canvas-feedback ${feedback.tone}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </div>
      ) : null}
      <div className={`workflow-run-grid view-${view}`}>
        <section className="workflow-run-stage" aria-label="工作流运行拓扑">
          {view === "canvas" ? (
            <ReactFlow
              colorMode="dark"
              edges={canvasEdges}
              edgeTypes={edgeTypes}
              elementsSelectable
              fitView
              fitViewOptions={{
                nodes: currentFocus.length ? currentFocus : canvasNodes,
                padding: 0.65,
                maxZoom: 0.92,
              }}
              nodes={canvasNodes}
              nodesConnectable={false}
              nodeTypes={nodeTypes}
              onInit={(instance) => {
                flow.current = instance;
              }}
              onNodeClick={(_, node) => selectNode(node.id)}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#283435" gap={22} size={1.3} />
              <Controls showInteractive={false} />
              <MiniMap
                maskColor="rgba(15,20,21,.82)"
                nodeColor={(node) => runStatusColor(node.data.status as WorkflowNodeRunStatus)}
                pannable
                zoomable
              />
            </ReactFlow>
          ) : (
            <ol className="workflow-run-list-view">
              {run.graph.nodes
                .filter((node) => !["start", "end"].includes(node.kind))
                .map((node, index) => {
                  const item = runByNode.get(node.id)!;
                  return (
                    <li
                      className={`${item.status} ${selectedId === node.id ? "selected" : ""}`}
                      key={node.id}
                    >
                      <button
                        aria-current={selectedId === node.id ? "step" : undefined}
                        aria-label={`打开任务 ${index + 1}：${node.title}`}
                        onClick={() => selectNode(node.id)}
                        type="button"
                      >
                        <span>{index + 1}</span>
                        <div>
                          <strong>{node.title}</strong>
                          <small>{node.ownerRole}</small>
                          {item.note ? <p>{item.note}</p> : null}
                        </div>
                        <RunNodeState status={item.status} />
                      </button>
                    </li>
                  );
                })}
            </ol>
          )}
        </section>
        <aside className="workflow-run-drawer">
          {selectedDefinition && selectedRun ? (
            <RunNodeDrawer
              command={command}
              definition={selectedDefinition}
              disabled={pending}
              key={selectedDefinition.id}
              revision={run.revision}
              run={selectedRun}
              isCurrent={run.currentNodeId === selectedDefinition.id}
              detail={run}
              refreshKey={refreshKey}
              onResult={(result) => {
                setFeedback({ tone: result.status, message: result.message });
                if (result.status === "success" || result.httpStatus === 409) {
                  void refresh();
                  router.refresh();
                }
              }}
            />
          ) : (
            <div className="workflow-inspector-empty">
              <CircleDashed size={24} />
              <strong>选择任务节点</strong>
              <p>查看输入、必做操作、交付物和阻断条件。</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function RunNodeDrawer({
  definition,
  run,
  revision,
  isCurrent,
  disabled,
  command,
  detail,
  refreshKey,
  onResult,
}: {
  definition: WorkflowNode;
  run: WorkflowRunDetail["nodes"][number];
  revision: number;
  isCurrent: boolean;
  disabled: boolean;
  command(input: Parameters<typeof commandWorkflowNode>[2]): void;
  detail: WorkflowRunDetail;
  refreshKey: number;
  onResult: Parameters<typeof WorkflowRepairPanel>[0]["onResult"];
}) {
  const [draft, setDraft] = useState<{ value: string; revision: number }>();
  const [repairBusy, setRepairBusy] = useState(false);
  const note = draft?.value ?? run.note ?? "";
  const [reason, setReason] = useState(run.blockerReason ?? "");
  const inspection = useNodeInspection(
    detail.id,
    definition.id,
    `${revision}:${refreshKey}`,
    detail.status === "active",
  );
  const access = inspection.value?.access;
  const commandDisabled = disabled || repairBusy || !access?.canCommand;
  const staleNote = Boolean(draft && draft.revision !== revision);
  useEffect(() => {
    if (draft && draft.value === run.note) setDraft(undefined);
  }, [draft, run.note]);
  return (
    <>
      <div className="workflow-drawer-title">
        <div>
          <span>{definition.ownerRole}</span>
          <h2>{definition.title}</h2>
        </div>
        <RunNodeState status={run.status} />
      </div>
      <p className="workflow-drawer-description">{definition.description}</p>
      {!["start", "end"].includes(definition.kind) ? (
        <WorkflowResponsibilityPanel
          key={`${detail.id}:${definition.id}`}
          runId={detail.id}
          nodeId={definition.id}
          revision={revision}
          disabled={disabled}
          onResult={onResult}
        />
      ) : null}
      {definition.config.requiredActions?.length ? (
        <section className="workflow-drawer-checklist">
          <h3>必做操作</h3>
          <ol>
            {definition.config.requiredActions.map((item) => (
              <li key={item}>
                <Check size={14} />
                {item}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {definition.config.artifactLabel ? (
        <section className="workflow-deliverable">
          <FileCheck2 size={17} />
          <div>
            <small>本节点交付物</small>
            <strong>{definition.config.artifactLabel}</strong>
          </div>
        </section>
      ) : null}
      {definition.config.blockingConditions?.length ? (
        <details className="workflow-blocking-rules">
          <summary>
            <AlertOctagon size={15} />
            阻断条件
          </summary>
          <ul>
            {definition.config.blockingConditions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </details>
      ) : null}
      {definition.kind === "internal_action" ? (
        <WorkflowExecutionHistory inspection={inspection.value} error={inspection.error} />
      ) : null}
      <WorkflowArtifacts run={detail} nodeId={definition.id} />
      <label className="workflow-note-editor">
        任务说明
        <textarea
          disabled={commandDisabled}
          maxLength={2000}
          onChange={(event) =>
            setDraft({ value: event.target.value, revision: draft?.revision ?? revision })
          }
          rows={3}
          value={note}
        />
      </label>
      {staleNote ? (
        <div className="wf-operator-notice error">
          <p>流程已更新 你的文字仍保留</p>
          <p>最新已保存的说明：{run.note || "暂无说明"}</p>
          <button className="wf-quiet-button" onClick={() => setDraft(undefined)} type="button">
            载入最新说明
          </button>
          <button
            className="wf-quiet-button"
            onClick={() => setDraft((current) => (current ? { ...current, revision } : undefined))}
            type="button"
          >
            保留文字继续编辑
          </button>
        </div>
      ) : null}
      <button
        className="workflow-note-save"
        disabled={commandDisabled || staleNote}
        onClick={() =>
          command({ type: "update_note", note, expectedRevision: draft?.revision ?? revision })
        }
        type="button"
      >
        <MessageSquareText size={14} />
        保存说明
      </button>
      {inspection.error ? (
        <p className="wf-operator-notice error" role="alert">
          {inspection.error}
        </p>
      ) : inspection.value && !access?.canCommand ? (
        <p className="wf-operator-notice">当前成员可查看记录 暂无操作权限</p>
      ) : null}

      {isCurrent && ["in_progress", "blocked", "failed"].includes(run.status) ? (
        <div className="workflow-command-panel">
          {run.status === "in_progress" ? (
            <label>
              阻断或退回原因
              <textarea
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                value={reason}
              />
            </label>
          ) : null}
          <div>
            {run.status === "in_progress" && definition.kind === "approval_gate" ? (
              <>
                <button
                  className="success"
                  disabled={commandDisabled || !access?.canApprove}
                  onClick={() =>
                    command({
                      type: "approve",
                      note: note || undefined,
                      expectedRevision: revision,
                    })
                  }
                  type="button"
                >
                  <ShieldCheck size={15} />
                  批准
                </button>
                <button
                  className="danger"
                  disabled={commandDisabled || !access?.canApprove || !reason.trim()}
                  onClick={() => command({ type: "reject", reason, expectedRevision: revision })}
                  type="button"
                >
                  <GitPullRequestArrow size={15} />
                  退回返工
                </button>
              </>
            ) : null}
            {run.status === "in_progress" &&
            !["approval_gate", "internal_action"].includes(definition.kind) ? (
              <button
                className="success"
                disabled={commandDisabled}
                onClick={() =>
                  command({
                    type: "complete",
                    note: note || undefined,
                    parameters: {},
                    expectedRevision: revision,
                  })
                }
                type="button"
              >
                <CheckCircle2 size={15} />
                完成并推进
              </button>
            ) : null}
            {run.status === "in_progress" ? (
              <button
                className="danger"
                disabled={commandDisabled || !reason.trim()}
                onClick={() => command({ type: "block", reason, expectedRevision: revision })}
                type="button"
              >
                <PauseCircle size={15} />
                设为阻断
              </button>
            ) : null}
            {run.status === "blocked" ? (
              <button
                className="success"
                disabled={commandDisabled}
                onClick={() => command({ type: "unblock", expectedRevision: revision })}
                type="button"
              >
                <RefreshCcw size={15} />
                解除阻断
              </button>
            ) : null}
            {run.status === "failed" && definition.kind === "internal_action" ? (
              <button
                className="success"
                disabled={commandDisabled || !access?.canRetry}
                onClick={() => command({ type: "retry", expectedRevision: revision })}
                type="button"
              >
                <RefreshCcw size={15} />
                沿用原输入重试
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {isCurrent && run.status === "failed" && access?.canRepair ? (
        <WorkflowRepairPanel
          runId={detail.id}
          nodeId={definition.id}
          revision={revision}
          disabled={disabled}
          onBusyChange={setRepairBusy}
          onResult={onResult}
        />
      ) : null}
      {run.status === "completed" && !["start", "end"].includes(definition.kind) ? (
        <button
          className="workflow-reopen"
          disabled={commandDisabled}
          onClick={() =>
            command({ type: "reopen", reason: "员工主动返工", expectedRevision: revision })
          }
          type="button"
        >
          <RotateCcw size={14} />
          重新打开此任务
        </button>
      ) : null}
    </>
  );
}

function RunNodeCard({ data, selected }: NodeProps<Node<RunNodeData>>) {
  const node = data.definition;
  return (
    <div
      className={`workflow-canvas-node run ${data.status} ${data.current ? "current" : ""} ${selected ? "selected" : ""}`}
    >
      {node.kind !== "start" ? <Handle position={Position.Top} type="target" /> : null}
      <div className="workflow-node-kind">
        <span style={{ background: runStatusColor(data.status) }} />
        {RunNodeStateText(data.status)}
      </div>
      <strong>{node.title}</strong>
      <small>{node.ownerRole}</small>
      {data.note ? (
        <em>{data.note}</em>
      ) : node.config.artifactLabel ? (
        <em>{node.config.artifactLabel}</em>
      ) : null}
      {node.kind !== "end" ? <Handle position={Position.Bottom} type="source" /> : null}
    </div>
  );
}

function RunEvidenceEdge(props: EdgeProps<Edge<RunEdgeData>>) {
  const [path, labelX, labelY] = getBezierPath(props);
  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        markerEnd={props.markerEnd}
        style={{
          stroke: props.animated ? "#E8793E" : "#718384",
          strokeWidth: props.animated ? 2.2 : 1.6,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="workflow-edge-evidence"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)` }}
        >
          <b>{props.data?.evidence}</b>
          {props.data?.version ? (
            <code title={props.data.version}>
              {props.data.version.length > 16
                ? `${props.data.version.slice(0, 12)}…`
                : props.data.version}
            </code>
          ) : null}
          <i className={props.data?.validationStatus ?? "pending"} />
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

function RunState({ status }: { status: WorkflowRunDetail["status"] }) {
  const label = (
    {
      not_started: "未开始",
      active: "执行中",
      blocked: "已阻断",
      failed: "执行失败",
      completed: "已完成",
      cancelled: "已取消",
    } as const
  )[status];
  return (
    <span className={`workflow-run-status ${status}`}>
      {status === "completed" ? (
        <CheckCircle2 size={13} />
      ) : status === "blocked" || status === "failed" ? (
        <AlertOctagon size={13} />
      ) : status === "cancelled" ? (
        <X size={13} />
      ) : (
        <Clock3 size={13} />
      )}
      {label}
    </span>
  );
}

function RunNodeState({ status }: { status: WorkflowNodeRunStatus }) {
  return (
    <span className={`workflow-node-state ${status}`}>
      <i />
      {RunNodeStateText(status)}
    </span>
  );
}

function RunNodeStateText(status: WorkflowNodeRunStatus) {
  return (
    {
      not_started: "待执行",
      in_progress: "执行中",
      blocked: "阻断",
      failed: "失败",
      completed: "已完成",
      skipped: "已跳过",
      cancelled: "已取消",
    } as const
  )[status];
}

function runStatusColor(status: WorkflowNodeRunStatus) {
  if (status === "completed") return "#3CA777";
  if (status === "blocked" || status === "failed") return "#D95757";
  if (status === "in_progress") return "#E8793E";
  if (status === "skipped" || status === "cancelled") return "#667273";
  return "#718384";
}
