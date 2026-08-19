"use client";

import type {
  WorkflowDefinitionSummary,
  WorkflowGraph,
  WorkflowRunSummary,
} from "@yummyai/contracts/workflow";
import {
  ArrowRight,
  Boxes,
  CheckCircle2,
  Clock3,
  Copy,
  GitBranch,
  LayoutTemplate,
  LockKeyhole,
  Plus,
  Play,
  Route,
  ShieldAlert,
  UserRoundCheck,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { cloneWorkflowDefinition, createWorkflowDefinition, startWorkflowRun } from "./workflow-actions";

type Tab = "official" | "team" | "personal" | "runs";
type StarterKey = "blank" | "linear" | "approval" | "amazon_custom";

const STARTERS: Array<{
  key: StarterKey;
  title: string;
  description: string;
  nodes: string[];
  icon: typeof Route;
}> = [
  { key: "blank", title: "空白流程", description: "只有开始和结束，适合完全自定义。", nodes: ["开始", "结束"], icon: Route },
  { key: "linear", title: "标准任务流", description: "从资料准备开始，完成后交付结果。", nodes: ["开始", "执行任务", "结束"], icon: CheckCircle2 },
  { key: "approval", title: "审核返工流", description: "内置执行、审核和退回返工关系。", nodes: ["开始", "执行", "审核", "结束"], icon: UserRoundCheck },
  { key: "amazon_custom", title: "Amazon Custom 副本", description: "复制完整14步官方流程，再按团队习惯调整。", nodes: ["研究", "事实", "校样", "上线"], icon: LayoutTemplate },
];

export function WorkflowCenter({
  definitions,
  runs,
  plans,
  error,
}: {
  definitions: WorkflowDefinitionSummary[];
  runs: WorkflowRunSummary[];
  plans: Array<{ id: string; name: string; status: string }>;
  error?: string;
}) {
  const [tab, setTab] = useState<Tab>(runs.length ? "runs" : "official");
  const [planByDefinition, setPlanByDefinition] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string }>();
  const [creating, setCreating] = useState(false);
  const [starter, setStarter] = useState<StarterKey>("linear");
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const shownDefinitions = useMemo(
    () => definitions.filter((definition) => definition.scope === tab),
    [definitions, tab],
  );
  const blocked = runs.filter((run) => run.status === "blocked").length;
  const completed = runs.filter((run) => run.status === "completed").length;
  const officialAmazon = definitions.find((definition) => definition.scope === "official" && definition.stableKey.includes("amazon-custom"));

  useEffect(() => {
    if (!creating) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setCreating(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [creating]);

  const clone = (id: string) => startTransition(async () => {
    const result = await cloneWorkflowDefinition(id);
    setFeedback({ tone: result.status, message: result.message });
    if (result.status === "success" && result.data) router.push(`/workflows/templates/${result.data.id}/edit`);
  });
  const start = (definitionId: string) => {
    const productPlanId = planByDefinition[definitionId];
    if (!productPlanId) {
      setFeedback({ tone: "error", message: "请先选择要开发的产品企划。" });
      return;
    }
    startTransition(async () => {
      const result = await startWorkflowRun(definitionId, productPlanId);
      setFeedback({ tone: result.status, message: result.message });
      if (result.status === "success" && result.data) router.push(`/workflows/runs/${result.data.id}`);
    });
  };
  const create = () => {
    const name = newName.trim();
    if (!name) {
      setFeedback({ tone: "error", message: "请填写工作流名称。" });
      return;
    }
    startTransition(async () => {
      const result = starter === "amazon_custom" && officialAmazon
        ? await cloneWorkflowDefinition(officialAmazon.id, name, "personal")
        : await createWorkflowDefinition({
            name,
            description: newDescription.trim() || starterDescription(starter),
            category: "product-development",
            scope: "personal",
            graph: buildWorkflowStarterGraph(starter === "amazon_custom" ? "linear" : starter),
          });
      setFeedback({ tone: result.status, message: result.message });
      if (result.status === "success" && result.data) {
        setCreating(false);
        router.push(`/workflows/templates/${result.data.id}/edit`);
      }
    });
  };

  return (
    <div className="workflow-center">
      <header className="workflow-page-header">
        <div>
          <p className="workflow-eyebrow">PRODUCT DEVELOPMENT CONTROL</p>
          <h1>工作流中心</h1>
          <p>模板定义怎么做，运行实例记录每个产品做到哪里；所有交付物沿连线逐步交接。</p>
        </div>
        <div className="workflow-header-side">
          <button className="workflow-create-trigger" onClick={() => setCreating(true)} type="button"><Plus size={16} />新建工作流</button>
          <div aria-label="工作流摘要" className="workflow-header-metrics" role="group">
            <span><b>{runs.filter((run) => ["active", "blocked", "failed"].includes(run.status)).length}</b>运行中</span>
            <span><b>{blocked}</b>阻断</span>
            <span><b>{completed}</b>已完成</span>
          </div>
        </div>
      </header>

      {error ? <div className="workflow-alert error"><ShieldAlert size={18} />{error}</div> : null}
      {feedback ? <div className={`workflow-alert ${feedback.tone}`}>{feedback.message}</div> : null}

      <nav className="workflow-tabs" aria-label="工作流分类">
        {([
          ["official", "官方模板", LayoutTemplate],
          ["team", "团队模板", GitBranch],
          ["personal", "我的模板", Boxes],
          ["runs", "运行中产品", Play],
        ] as const).map(([value, label, Icon]) => (
          <button className={tab === value ? "active" : ""} key={value} onClick={() => setTab(value)} type="button">
            <Icon size={15} />{label}
            <small>{value === "runs" ? runs.length : definitions.filter((item) => item.scope === value).length}</small>
          </button>
        ))}
      </nav>

      {tab === "runs" ? (
        <RunTable runs={runs} />
      ) : (
        <section className="workflow-template-grid">
          {shownDefinitions.map((definition) => (
            <article className="workflow-template-card" key={definition.id}>
              <div className="workflow-template-card-top">
                <span className={`workflow-scope ${definition.scope}`}>
                  {definition.scope === "official" ? <LockKeyhole size={13} /> : <GitBranch size={13} />}
                  {definition.scope === "official" ? "官方只读" : definition.scope === "team" ? "团队" : "个人草稿"}
                </span>
                <code>v{definition.publishedVersion ?? definition.draftVersion ?? 1}</code>
              </div>
              <h2>{definition.name}</h2>
              <p>{definition.description}</p>
              <dl>
                <div><dt>节点</dt><dd>{definition.nodeCount}</dd></div>
                <div><dt>活跃运行</dt><dd>{definition.activeRunCount}</dd></div>
                <div><dt>状态</dt><dd>{definition.status === "published" ? "已发布" : "草稿"}</dd></div>
              </dl>
              <div className="workflow-template-actions">
                <Link href={`/workflows/templates/${definition.id}/edit`}>
                  {definition.scope === "official" ? "查看流程" : "设计流程"}<ArrowRight size={14} />
                </Link>
                {definition.scope === "official" ? (
                  <button disabled={pending} onClick={() => clone(definition.id)} type="button"><Copy size={14} />克隆为团队模板</button>
                ) : null}
              </div>
              {definition.status === "published" ? (
                <div className="workflow-start-row">
                  <select
                    aria-label={`为 ${definition.name} 选择产品企划`}
                    onChange={(event) => setPlanByDefinition((current) => ({ ...current, [definition.id]: event.target.value }))}
                    value={planByDefinition[definition.id] ?? ""}
                  >
                    <option value="">选择产品企划…</option>
                    {plans.map((plan) => <option key={plan.id} value={plan.id}>{plan.name}</option>)}
                  </select>
                  <button disabled={pending || !plans.length} onClick={() => start(definition.id)} type="button"><Play size={14} />启动</button>
                </div>
              ) : null}
            </article>
          ))}
          {!shownDefinitions.length ? <div className="workflow-empty">这个分类还没有模板。</div> : null}
        </section>
      )}
      {creating ? (
        <div className="workflow-create-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target) setCreating(false); }} role="presentation">
          <section aria-labelledby="workflow-create-title" aria-modal="true" className="workflow-create-dialog" role="dialog">
            <header><div><span>NEW WORKFLOW</span><h2 id="workflow-create-title">从一个清楚的骨架开始</h2><p>选结构、填名称，然后直接进入画布。后续随时可以增删节点。</p></div><button aria-label="关闭新建工作流" onClick={() => setCreating(false)} type="button"><X size={18} /></button></header>
            <div className="workflow-create-body">
              <div className="workflow-starter-grid">
                {STARTERS.map((item) => {
                  const Icon = item.icon;
                  const disabled = item.key === "amazon_custom" && !officialAmazon;
                  return <button aria-pressed={starter === item.key} className={starter === item.key ? "selected" : ""} disabled={disabled} key={item.key} onClick={() => setStarter(item.key)} type="button"><div className="workflow-starter-title"><Icon size={17} /><strong>{item.title}</strong>{starter === item.key ? <CheckCircle2 size={15} /> : null}</div><p>{disabled ? "官方模板尚未加载" : item.description}</p><div className="workflow-starter-strip" aria-hidden="true">{item.nodes.map((node, index) => <span key={node}>{index ? <i /> : null}<b>{node}</b></span>)}</div></button>;
                })}
              </div>
              <div className="workflow-create-fields">
                <label>工作流名称<input autoFocus maxLength={200} onChange={(event) => setNewName(event.target.value)} placeholder="例如：照片蛋糕插牌开发流程" value={newName} /></label>
                <label>用途说明（可选）<textarea maxLength={2000} onChange={(event) => setNewDescription(event.target.value)} placeholder="员工什么时候使用这个流程？" rows={3} value={newDescription} /></label>
                <p><LockKeyhole size={13} />先保存到“我的模板”；发布后自动成为团队模板。</p>
              </div>
            </div>
            <footer><button onClick={() => setCreating(false)} type="button">取消</button><button className="primary" disabled={pending || !newName.trim()} onClick={create} type="button">{pending ? "正在创建…" : "创建并进入画布"}<ArrowRight size={15} /></button></footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function starterDescription(starter: StarterKey) {
  return STARTERS.find((item) => item.key === starter)?.description ?? "团队自定义产品开发工作流";
}

export function buildWorkflowStarterGraph(starter: Exclude<StarterKey, "amazon_custom">): WorkflowGraph {
  const node = (id: string, kind: WorkflowGraph["nodes"][number]["kind"], title: string, y: number): WorkflowGraph["nodes"][number] => ({
    id, kind, title, description: "", ownerRole: kind === "approval_gate" ? "审核负责人" : kind === "start" || kind === "end" ? "系统" : "流程执行人",
    inputPorts: [], outputPorts: [], config: { parameters: {}, ...(kind === "approval_gate" ? { approvalMode: "any" as const } : {}) }, position: { x: 320, y },
    ...(kind === "approval_gate" ? { reworkTargetNodeId: "work" } : {}),
  });
  const nodes = starter === "blank"
    ? [node("start", "start", "开始", 40), node("end", "end", "结束", 250)]
    : starter === "linear"
      ? [node("start", "start", "开始", 40), node("work", "human_task", "执行任务", 210), node("end", "end", "结束", 400)]
      : [node("start", "start", "开始", 40), node("work", "human_task", "执行任务", 210), node("approval", "approval_gate", "审核结果", 400), node("end", "end", "结束", 590)];
  const edges: WorkflowGraph["edges"] = nodes.slice(0, -1).map((current, index) => ({ id: `${current.id}-to-${nodes[index + 1]!.id}`, source: current.id, target: nodes[index + 1]!.id, kind: "success" }));
  if (starter === "approval") edges.push({ id: "approval-rework", source: "approval", target: "work", kind: "rework" });
  return { nodes, edges, viewport: { x: 0, y: 0, zoom: 1 } };
}

function RunTable({ runs }: { runs: WorkflowRunSummary[] }) {
  if (!runs.length) return <div className="workflow-empty">还没有产品运行实例。先从已发布模板选择产品企划并启动。</div>;
  return (
    <section className="workflow-run-table" aria-label="产品运行列表">
      <div className="workflow-run-table-head"><span>产品 / 工作流</span><span>当前任务</span><span>进度</span><span>状态</span><span /></div>
      {runs.map((run) => (
        <article key={run.id}>
          <div><strong>{run.productName}</strong><small>{run.definitionName} · v{run.definitionVersion}</small></div>
          <div><span>{run.currentNodeTitle ?? "流程已结束"}</span>{run.latestBlocker ? <small className="danger">{run.latestBlocker}</small> : null}</div>
          <div className="workflow-progress-cell"><span><i style={{ width: `${run.totalNodes ? run.completedNodes / run.totalNodes * 100 : 0}%` }} /></span><small>{run.completedNodes}/{run.totalNodes}</small></div>
          <div><RunStatus status={run.status} /></div>
          <Link aria-label={`打开 ${run.productName} 工作流`} href={`/workflows/runs/${run.id}`}><ArrowRight size={17} /></Link>
        </article>
      ))}
    </section>
  );
}

function RunStatus({ status }: { status: WorkflowRunSummary["status"] }) {
  const Icon = status === "completed" ? CheckCircle2 : status === "blocked" || status === "failed" ? ShieldAlert : Clock3;
  const label = ({ not_started: "未开始", active: "执行中", blocked: "阻断", failed: "失败", completed: "已完成", cancelled: "已取消" } as const)[status];
  return <span className={`workflow-run-status ${status}`}><Icon size={13} />{label}</span>;
}
