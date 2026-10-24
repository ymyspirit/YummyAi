"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { observeViewTransition } from "../navigation/view-transition";
import { ListChecks, Play, RefreshCw, Square } from "lucide-react";
import { BusinessTaskPanel } from "../business-tasks/business-task-panel";
import { salesTaskView } from "../business-tasks/sales-task-view";
import type { SalesPlanView } from "@yummyai/contracts/catalog/sales-plan";
import { AssistModelSchema, type AssistModel } from "@yummyai/contracts/ai/assist";
import { AssistTaskBasisSchema, type AssistTaskBasis } from "@yummyai/contracts/ai/task-workspace";
import { PreparationListSchema, PreparationViewSchema, type PreparationView } from "@yummyai/contracts/catalog/sales-plan-agent";
import { salesPlanRequest } from "./sales-plan-client";
import "./sales-plan-agent.css";

const stateLabels = { running: "执行中", blocked: "待处理", waiting: "等待分析与核对", ready: "可提交审核", cancelled: "已停止" };
const analysisLabels = { queued: "排队中", running: "分析中", completed: "分析完成", failed: "分析失败", cancelled: "分析已取消" };
export function SalesPlanAgent({ plan, disabledReason, canWrite, onProgress }: {
  plan: SalesPlanView; disabledReason: string; canWrite: boolean; onProgress: () => void;
}) {
  const params = useSearchParams(), selected = params.get("preparation");
  const [view, setView] = useState<PreparationView | null>(null);
  const [runs, setRuns] = useState<Array<{ id: string; createdAt: string; status: keyof typeof stateLabels }>>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [reload, setReload] = useState(0), [basis, setBasis] = useState<AssistTaskBasis | null>(null);
  const [kind, setKind] = useState<"creative" | "sku_package">("sku_package");
  const [models, setModels] = useState<AssistModel[]>([]), [modelId, setModelId] = useState("");
  const pending = useRef<{ signature: string; key: string } | null>(null), generation = useRef(0);
  const transition = useRef<ViewTransition | null>(null);
  const change = useCallback((update: () => void) => {
    const token = generation.current;
    transition.current?.skipTransition();
    if (document.startViewTransition && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      transition.current = document.startViewTransition(() => { if (token === generation.current) flushSync(update); });
      observeViewTransition(transition.current);
    } else update();
  }, []);
  useEffect(() => () => { generation.current++; transition.current?.skipTransition(); }, []);
  const path = `${plan.id}/launch/agent`;
  const navigate = useCallback((id: string) => {
    const query = new URLSearchParams(window.location.search);
    query.set("preparation", id);
    history.replaceState(null, "", `/sales-plans?${query}#sales-plan-agent`);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    generation.current++;
    setLoading(true); setError(""); setView(null); setBasis(null);
    void (async () => {
      const list = PreparationListSchema.parse(await salesPlanRequest(path, undefined, abort.signal));
      if (abort.signal.aborted) return;
      setRuns(list.runs);
      const id = selected ?? list.runs[0]?.id;
      if (!id) return;
      const next = PreparationViewSchema.parse(await salesPlanRequest(`${path}/${id}`, undefined, abort.signal));
      if (!abort.signal.aborted) change(() => { setView(next); if (!selected) navigate(id); });
    })().catch(cause => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "任务读取失败，请重试"); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [path, selected, plan.revision, reload, navigate, change]);
  useEffect(() => {
    if (!view || (!view.busy && !["queued", "running"].includes(view.analysis?.status ?? ""))) return;
    const abort = new AbortController();
    const id = view.run.id;
    const read = () => {
      if (document.visibilityState !== "visible") return;
      void salesPlanRequest(`${path}/${id}`, undefined, abort.signal).then(result => {
        if (!abort.signal.aborted) {
          const next = PreparationViewSchema.parse(result);
          if (next.run.revision !== view.run.revision || next.analysis?.status !== view.analysis?.status || next.sourceChanged !== view.sourceChanged || next.busy !== view.busy)
            change(() => { setView(next); setError(""); });
          else setError("");
        }
      }).catch(() => { if (!abort.signal.aborted) setError("任务状态读取失败，请刷新重试"); });
    };
    const interval = setInterval(read, 5000);
    window.addEventListener("focus", read);
    return () => { abort.abort(); clearInterval(interval); window.removeEventListener("focus", read); };
  }, [path, view?.run.id, view?.run.revision, view?.busy, view?.analysis?.status, view?.sourceChanged, change]);
  useEffect(() => { setBasis(null); }, [kind, plan.revision, selected]);

  async function command(action: "start" | "resume" | "cancel" | "analyze") {
    if (busy || disabledReason || !canWrite || (action !== "start" && !view)) return;
    const token = generation.current;
    const body = { expectedRevision: plan.revision,
      ...(action !== "start" ? { expectedRunRevision: view!.run.revision } : {}),
      ...(action === "analyze" ? { kind, modelId, expectedFingerprint: basis?.fingerprint } : {}) };
    const signature = JSON.stringify({ path, id: view?.run.id, action, body });
    const key = pending.current?.signature === signature ? pending.current.key : crypto.randomUUID();
    pending.current = { signature, key }; setBusy(true); setError("");
    try {
      const result = PreparationViewSchema.parse(await salesPlanRequest(
        action === "start" ? path : `${path}/${view!.run.id}/${action}`,
        { ...body, idempotencyKey: key },
      ));
      if (token !== generation.current) return;
      pending.current = null;
      change(() => { setView(result); setBasis(null); navigate(result.run.id); onProgress(); });
    } catch (cause) {
      if (token === generation.current) setError(cause instanceof Error ? cause.message : "执行未完成，请读取原任务后继续");
    } finally { setBusy(false); }
  }
  async function preview() {
    if (!view) return;
    const token = generation.current;
    setBusy(true); setError(""); setBasis(null);
    try {
      const next = AssistTaskBasisSchema.parse(await salesPlanRequest(`${path}/${view.run.id}/basis`, {
        kind, expectedRevision: plan.revision, expectedRunRevision: view.run.revision,
      }));
      const response = await fetch("/api/ai-assists/models", { cache: "no-store" });
      if (!response.ok) throw new Error("模型配置读取失败，请核对 AI 设置和权限");
      const available = AssistModelSchema.array().parse(await response.json());
      if (token !== generation.current) return;
      change(() => { setModels(available); setModelId(""); setBasis(next); });
    } catch (cause) { if (token === generation.current) setError(cause instanceof Error ? cause.message : "分析依据读取失败"); }
    finally { setBusy(false); }
  }
  const disabled = !!disabledReason || !canWrite || busy || loading;
  const model = models.find(m => m.id === modelId);
  return <section className="sp-agent" aria-label="上架准备 Agent" id="sales-plan-agent">
    <header className="sp-agent-heading">
      <div><h3><ListChecks size={17} aria-hidden="true" />上架准备 Agent</h3>
        <p>核对当前资料 → 准备刊登草稿 → 检查审核条件</p></div>
      <button className="oc-button" disabled={busy || loading} onClick={() => setReload(v => v + 1)} aria-label="刷新上架准备任务"><RefreshCw size={14} />刷新</button>
    </header>
    <p className="sp-agent-note">开始后可创建或同步本地刊登草稿。付费分析单独确认，审核与发布沿用原流程</p>
    {error && <p className="oc-error" role="alert">{error}</p>}
    {loading && <p role="status" className="sp-agent-loading">正在读取任务与当前依据…</p>}
    {!loading && !view && !error && <div className="sp-agent-empty">
      <p>把这个销售方案准备到可提交刊登审核，记录每一步依据、产物和待办</p>
      <button className="oc-button oc-button-primary" disabled={disabled} onClick={() => void command("start")}><Play size={14} />检查并准备草稿</button>
    </div>}
    {view && <>
      <div className="sp-agent-summary" aria-live="polite">
        <strong>{view.sourceChanged && view.run.status === "ready" ? "资料已变化，需重新核对" : stateLabels[view.run.status]}</strong>
        <span>方案 V{view.run.planRevision} · {view.run.evidence.length} 项版本依据 · {view.run.toolCalls} 次业务工具调用</span>
        <p>{view.run.message}</p>
      </div>
      {view.sourceChanged && <p className="sp-hint">资料或刊登状态已有变化，继续时将按当前方案 V{plan.revision} 重新检查</p>}
      <BusinessTaskPanel task={salesTaskView(view)} planLabel="Agent 执行计划" disabled={disabled || !!error} />
      {view.analysis && <div className="sp-agent-analysis" aria-label="Agent 分析结果">
        <span>{analysisLabels[view.analysis.status]}{view.analysis.stale ? " · 依据已过期" : ""} · {view.analysis.costUsd === null ? "费用待确认" : `费用 $${view.analysis.costUsd.toFixed(4)}`}</span>
        <Link href={view.analysis.href}>查看并核对建议</Link>
      </div>}
      <div className="sp-agent-actions">
        {view.run.status !== "cancelled" && <>
          <button className="oc-button oc-button-primary" disabled={disabled || !view.canContinue} onClick={() => void command("resume")}><Play size={14} />{view.sourceChanged ? `按 V${plan.revision} 继续任务` : "继续原任务"}</button>
          <button className="oc-button" disabled={disabled} onClick={() => void command("cancel")}><Square size={13} />停止任务</button>
        </>}
        {["ready", "cancelled"].includes(view.run.status) && <button className="oc-button" disabled={disabled} onClick={() => void command("start")}>建立新任务</button>}
        {view.run.status !== "cancelled" && !view.busy && view.run.analyses.length < 2 && <>
          <label>分析环节<select aria-label="Agent 分析环节" value={kind} disabled={disabled} onChange={event => { const next = event.target.value as typeof kind; change(() => { setKind(next); setBasis(null); }); }}>
            <option value="sku_package">刊登文案</option><option value="creative">原创方向</option></select></label>
          <button className="oc-button" disabled={disabled || view.run.planRevision !== plan.revision} onClick={() => void preview()}>读取 Agent 分析依据</button>
        </>}
      </div>
      {basis && <div className="sp-agent-basis" role="region" aria-label="Agent 分析依据">
        <dl>{basis.rows.map(row => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
        <p>{basis.sources.length} 项固定来源 · 本任务最多 2 次分析</p>
        {basis.diagnostics.map((text, i) => <p key={i}>{text}</p>)}
        <label>分析模型<select aria-label="Agent 分析模型" value={modelId} onChange={e => setModelId(e.target.value)} disabled={disabled}>
          <option value="">请选择已配置模型</option>{models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select></label>
        {model && <p>{model.maxTaskCostUsd === null ? "价格未配置，实际费用以渠道账单为准" : `单次费用上限 $${model.maxTaskCostUsd}`} · 沿用组织预算与现有分析渠道</p>}
        {!models.length && <p>暂无可用模型，请到 AI 设置配置</p>}
        <button className="oc-button" disabled={disabled || !modelId} onClick={() => void command("analyze")}>确认依据并开始分析</button>
      </div>}
      <details className="sp-agent-history"><summary>执行记录 · 最近 {view.history.length} 条</summary>
        <ol>{view.history.map((item, i) => <li key={`${item.at}-${i}`}><time>{new Date(item.at).toLocaleString("zh-CN")}</time><span>{item.message}</span></li>)}</ol>
      </details>
    </>}
    {runs.length > 1 && <label className="sp-agent-history-select">任务历史<select aria-label="上架准备任务历史" value={view?.run.id ?? selected ?? ""} onChange={e => navigate(e.target.value)}>
      {runs.map(run => <option key={run.id} value={run.id}>{new Date(run.createdAt).toLocaleString("zh-CN")} · {stateLabels[run.status]}</option>)}
    </select></label>}
  </section>;
}
