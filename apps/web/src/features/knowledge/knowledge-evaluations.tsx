"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, Play, Plus, RefreshCw, Search, X } from "lucide-react";
import { Permission } from "@yummyai/authz/permissions";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AssistModelSchema, type AssistModel } from "@yummyai/contracts/ai/assist";
import {
  KnowledgeEvaluationCaseSchema, KnowledgeEvaluationReportSchema, KnowledgeSavedRecordSchema,
  SaveKnowledgeEvaluationSchema, ReviewKnowledgeEvaluationSchema, type KnowledgeEvaluationCase,
  type KnowledgeEvaluationReport, type KnowledgeGovernanceView,
} from "@yummyai/contracts/knowledge/governance";
import {
  KnowledgeEvaluationRunPageSchema, KnowledgeEvaluationComparisonSchema,
  type KnowledgeEvaluationRunPage, type KnowledgeEvaluationComparison,
} from "@yummyai/contracts/knowledge/evaluation-read";
import type { KnowledgeWorkspace } from "@yummyai/contracts/knowledge";
import { TaskDrawer, TaskDrawerActions } from "../navigation/task-drawer";
import { useErpAccess } from "../identity/erp-access";
import { assistApi, assistReadDenied } from "../ai-assist/assist-client";
import { governanceApi, knowledgeReadDenied, KnowledgeRequestError } from "./knowledge-api";
import { KnowledgeScopeForm, KnowledgeCardChoices } from "./knowledge-shared";
import { KnowledgeEvaluationReportView, KnowledgeEvaluationComparisonView } from "./knowledge-evaluation-results";
import {
  clearEvaluationIntents, readEvaluationIntents, saveEvaluationIntent, removeEvaluationIntent, evaluationRequestChecksum,
  type KnowledgeEvaluationIntent,
} from "./knowledge-evaluation-recovery";

const blank = (): KnowledgeEvaluationCase => ({ label: "", search: { query: "", topic: "all", platform: "all", market: "ALL", spuIds: [] },
  expectedFacts: [], forbiddenClaims: [], requiredEntryIds: [], expectRefusal: false });
const lines = (value: string) => value.split("\n").map(text => text.trim()).filter(Boolean);
type Editor = { id: string; revision: number; fields: KnowledgeEvaluationCase };
type Lane = "list" | "detail" | "compare";
type Props = { data: KnowledgeGovernanceView; library: KnowledgeWorkspace; onChanged(): void };

export function KnowledgeEvaluations(props: Props) {
  const access = useErpAccess(), owner = useRef({ authority: access.authority, preference: access.preferenceScope });
  const matches = owner.current.authority === access.authority && owner.current.preference === access.preferenceScope;
  const canRead = access.authority !== null && access.can(Permission.WorkflowRead);
  useLayoutEffect(() => { if (!matches || !canRead) clearEvaluationIntents(); }, [matches, canRead]);
  if (!matches || !canRead) return <section className="kb-expanded kb-evaluation" aria-label="回答质量评测">
    <p role="status">当前身份或评测读取范围已变化 原回答 历史和填写已隐藏 请核对当前权限</p></section>;
  return <EvaluationSession key={access.authority} {...props} authority={access.authority!}
    canManage={access.can(Permission.WorkflowManage)} canRun={access.can(Permission.WorkflowManage) && access.can(Permission.WorkflowRun)}
    canApprove={access.can(Permission.WorkflowApprove)} />;
}

function EvaluationSession({ data, library, onChanged, authority, canManage, canRun, canApprove }: Props & {
  authority: string; canManage: boolean; canRun: boolean; canApprove: boolean;
}) {
  const [models, setModels] = useState<AssistModel[]>([]), [modelId, setModelId] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null), [mutation, setMutation] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [denied, setDenied] = useState(false);
  const [intents, setIntents] = useState<KnowledgeEvaluationIntent[]>([]), [prepared, setPrepared] = useState<KnowledgeEvaluationIntent | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false), [historyCase, setHistoryCase] = useState("");
  const [page, setPage] = useState<KnowledgeEvaluationRunPage | null>(null), [trail, setTrail] = useState<Array<string | undefined>>([undefined]);
  const [report, setReport] = useState<KnowledgeEvaluationReport | null>(null), [runDraft, setRunDraft] = useState("");
  const [baselineId, setBaselineId] = useState(""), [candidateId, setCandidateId] = useState("");
  const [comparison, setComparison] = useState<KnowledgeEvaluationComparison | null>(null);
  const [reviewResult, setReviewResult] = useState<"pass" | "fail" | "needs_review">("needs_review"), [reason, setReason] = useState("");
  const [reviewUnknown, setReviewUnknown] = useState<{ id: string; result: string; reason: string } | null>(null);
  const [reading, setReading] = useState<Record<Lane, boolean>>({ list: false, detail: false, compare: false });
  const [closing, setClosing] = useState<"history" | "editor" | "prepared" | null>(null);
  const alive = useRef(true), blocked = useRef(false), posting = useRef(false), epoch = useRef(0), closeTimer = useRef<number | null>(null);
  const live = useRef({ authority, canRun, canManage, canApprove }); live.current = { authority, canRun, canManage, canApprove };
  const currentCase = useRef(historyCase); currentCase.current = historyCase;
  const requests = useRef({ list: 0, detail: 0, compare: 0, aborts: new Map<Lane, AbortController>() });
  const cancel = useCallback(() => {
    for (const lane of ["list", "detail", "compare"] as const) { requests.current[lane]++; requests.current.aborts.get(lane)?.abort(); }
    requests.current.aborts.clear();
  }, []);
  const deny = useCallback(() => {
    blocked.current = true; epoch.current++; cancel(); clearEvaluationIntents(authority);
    setDenied(true); setIntents([]); setPrepared(null); setEditor(null); setModels([]); setReport(null); setPage(null); setComparison(null); setReason("");
    setHistoryOpen(false); setHistoryCase(""); setReviewUnknown(null); setMutation(""); setNotice(""); setError("");
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    window.dispatchEvent(new Event("focus"));
  }, [authority, cancel]);
  const failure = useCallback((cause: unknown, fallback: string) => {
    if (knowledgeReadDenied(cause) || assistReadDenied(cause)) { deny(); return; }
    setError(cause instanceof Error ? cause.message : fallback);
  }, [deny]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; cancel();
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current); }; }, [cancel]);
  useLayoutEffect(() => { setIntents(readEvaluationIntents(authority)); }, [authority]);
  useEffect(() => {
    const abort = new AbortController(), valid = () => alive.current && !blocked.current && !abort.signal.aborted && live.current.authority === authority;
    assistApi<unknown>("models", undefined, abort.signal).then(value => {
      if (valid()) setModels(AssistModelSchema.array().parse(value));
    }).catch(cause => { if (valid()) failure(cause, "模型读取失败"); });
    return () => abort.abort();
  }, [authority, failure]);
  function begin(lane: Lane) {
    requests.current[lane]++; requests.current.aborts.get(lane)?.abort();
    const abort = new AbortController(), token = requests.current[lane], view = epoch.current;
    requests.current.aborts.set(lane, abort); setReading(value => ({ ...value, [lane]: true }));
    const valid = () => alive.current && !blocked.current && !abort.signal.aborted && live.current.authority === authority && epoch.current === view && requests.current[lane] === token;
    return { abort, valid, done: () => { if (valid()) setReading(value => ({ ...value, [lane]: false })); } };
  }
  function openRead() {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    epoch.current++; cancel(); setHistoryOpen(true); setComparison(null); setReport(null); setPage(null);
    setReading({ list: false, detail: false, compare: false }); setReason(""); setError(""); setClosing(null);
  }
  async function loadPage(id: string, cursor?: string, nextTrail: Array<string | undefined> = [undefined], open = false) {
    if (open) { openRead(); currentCase.current = id; setHistoryCase(id); setTrail([undefined]); }
    const ticket = begin("list"); setError("");
    try {
      const result = KnowledgeEvaluationRunPageSchema.parse(await governanceApi("evaluations/" + id + "/run-page?" +
        new URLSearchParams({ limit: "20", ...(cursor ? { cursor } : {}) }), undefined, ticket.abort.signal, authority));
      if (!ticket.valid() || currentCase.current !== id) return;
      if (result.items.some(item => item.caseId !== id)) throw new KnowledgeRequestError(502, "历史记录与原问题不一致 未以另一问题回填");
      setPage(result); setTrail(nextTrail);
    } catch (cause) { if (ticket.valid()) failure(cause, "原评测历史读取未完成"); }
    finally { ticket.done(); }
  }
  async function loadRun(rawId: string, open = false, refresh = false, original?: KnowledgeEvaluationIntent) {
    const parsed = EntityIdSchema.safeParse(rawId.trim()); if (!parsed.success) { setError("请填写完整有效的原评测运行 ID"); return; }
    if (open) { openRead(); currentCase.current = ""; setHistoryCase(""); }
    requests.current.compare++; requests.current.aborts.get("compare")?.abort();
    const id = parsed.data, intent = original ?? intents.find(item => item.runId === id), expectedCase = intent?.caseId ?? currentCase.current, ticket = begin("detail");
    setReading(value => ({ ...value, compare: false })); setRunDraft(id);
    if (!refresh) { setReport(null); setComparison(null); setReason(""); } setError("");
    try {
      const value = KnowledgeEvaluationReportSchema.parse(await governanceApi("evaluation-runs/" + id, undefined, ticket.abort.signal, authority));
      if (!ticket.valid()) return;
      if (value.id !== id || expectedCase && value.caseId !== expectedCase) throw new KnowledgeRequestError(502, "原评测身份与所选问题不一致 未采用返回内容");
      if (value.protocol && (value.protocol.runId !== id || value.protocol.inputFingerprint !== value.answer.inputFingerprint) ||
        value.assessment && (value.assessment.runId !== id || value.protocol && value.assessment.basisFingerprint !== value.protocol.basisFingerprint))
        throw new KnowledgeRequestError(502, "原协议 评分和回答身份不一致 未拼接为原结果");
      if (intent && value.protocol) {
        const checksum = await evaluationRequestChecksum(intent);
        if (!ticket.valid()) return;
        if (value.protocol.modelId !== intent.input.modelId || value.protocol.requestChecksum !== checksum)
          throw new KnowledgeRequestError(502, "原运行与固定原模型 正文和编号不一致 未采用替代结果");
      }
      setReport(value);
      if (!expectedCase) { currentCase.current = value.caseId; setHistoryCase(value.caseId); }
      if (reviewUnknown?.id === id && value.manualReviews.some(item => item.result === reviewUnknown.result && item.reason === reviewUnknown.reason)) {
        setReviewUnknown(null); setNotice("原人工核验已在真实历史中找到 本次只读回执 未再次登记");
      }
    } catch (cause) { if (ticket.valid()) failure(cause, "原评测结果读取未完成 请按原 ID 重读"); }
    finally { ticket.done(); }
  }
  const readLatest = useRef(loadRun); readLatest.current = loadRun;
  const active = report && ["queued", "running"].includes(report.answer.status);
  useEffect(() => {
    if (!historyOpen || !report || !active || comparison || reading.detail) return;
    const id = report.id, timer = window.setTimeout(() => void readLatest.current(id, false, true), 3000);
    return () => { window.clearTimeout(timer); };
  }, [historyOpen, report, active, comparison, reading.detail]); // A slow read completes before another poll is scheduled.
  async function compareRuns() {
    const left = EntityIdSchema.safeParse(baselineId.trim()), right = EntityIdSchema.safeParse(candidateId.trim());
    if (!left.success || !right.success || left.data === right.data) { setError("明确选择两个不同的有效原运行 ID 不自动采用最近两次"); return; }
    requests.current.detail++; requests.current.aborts.get("detail")?.abort();
    const ticket = begin("compare"); setComparison(null); setReport(null); setReading(value => ({ ...value, detail: false })); setError(""); setReason("");
    try {
      const value = KnowledgeEvaluationComparisonSchema.parse(await governanceApi("evaluation-comparisons?" +
        new URLSearchParams({ baselineRunId: left.data, candidateRunId: right.data }), undefined, ticket.abort.signal, authority));
      if (!ticket.valid()) return;
      if (value.baseline.id !== left.data || value.candidate.id !== right.data) throw new KnowledgeRequestError(502, "比较结果不是明确选择的两次原运行");
      setComparison(value);
    } catch (cause) { if (ticket.valid()) failure(cause, "原运行比较读取未完成"); }
    finally { ticket.done(); }
  }
  function updateIntent(value: KnowledgeEvaluationIntent) {
    setIntents(current => [...current.filter(item => item.caseId !== value.caseId), value]);
  }
  async function startOriginal(original: KnowledgeEvaluationIntent) {
    if (posting.current || blocked.current || !canRun || original.authority !== authority) return;
    if (original.runId) { void loadRun(original.runId, true, false, original); return; }
    try { saveEvaluationIntent(original); updateIntent(original); }
    catch { setError("原正文和编号未能完整保存 或已有本问题待恢复记录 本次未发送"); return; }
    posting.current = true; setMutation("start"); setPrepared(null); setError("");
    const valid = () => alive.current && !blocked.current && live.current.authority === authority && live.current.canRun;
    try {
      const saved = KnowledgeSavedRecordSchema.parse(await governanceApi("evaluations/" + original.caseId + "/start", original.input, undefined, authority));
      if (!valid()) return;
      const recorded = { ...original, runId: saved.id }; updateIntent(recorded);
      try { saveEvaluationIntent(recorded); }
      catch { setError("原评测已经登记 当前运行编号保留在本页 请抄录原 ID 后读取 勿重新提交"); }
      setNotice("原评测已登记 运行 ID " + saved.id + " 随后的读取失败不表示未启动");
      void loadRun(saved.id, true, false, recorded);
    } catch (cause) { if (valid()) failure(cause, "原评测提交结果未知 请按固定正文和编号恢复"); }
    finally { posting.current = false; if (valid()) setMutation(""); }
  }
  function prepareStart(id: string) {
    if (!canRun || !modelId || mutation || prepared) return;
    if (intents.some(item => item.caseId === id)) { setError("本问题仍有原评测意图 请先恢复结果并确认原运行编号"); return; }
    setPrepared({ version: 1, authority, caseId: id, input: { modelId, requestId: crypto.randomUUID() }, runId: null }); setError(""); setClosing(null);
  }
  function finishIntent(value: KnowledgeEvaluationIntent) {
    if (!value.runId) return;
    try { removeEvaluationIntent(value); setIntents(current => current.filter(item => item.caseId !== value.caseId));
      setNotice("仅清除本人的恢复副本 原运行 费用和业务事实未取消 新付费尝试需再次明确确认"); }
    catch { setError("恢复副本未能清除 原运行仍已登记 请按原 ID 读取 不重新付费"); }
  }
  function close(kind: "history" | "editor" | "prepared") {
    if (kind === "history") { epoch.current++; cancel(); setReading({ list: false, detail: false, compare: false }); }
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    const finish = () => {
      if (!alive.current || blocked.current || live.current.authority !== authority) return;
      setClosing(null);
      if (kind === "history") { setHistoryOpen(false); setReport(null); setComparison(null); setPage(null); setHistoryCase(""); currentCase.current = ""; setReason(""); }
      else if (kind === "editor") setEditor(null); else setPrepared(null);
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else { setClosing(kind); closeTimer.current = window.setTimeout(finish, 150); }
  }
  async function saveCase(input: Parameters<typeof SaveKnowledgeEvaluationSchema.parse>[0]) {
    if (!editor || !canManage || posting.current || blocked.current) return;
    posting.current = true; setMutation("case"); setError("");
    try {
      KnowledgeSavedRecordSchema.parse(await governanceApi(editor.id ? "evaluations/" + editor.id + "/save" : "evaluations/create", input, undefined, authority));
      if (!alive.current || blocked.current || live.current.authority !== authority || !live.current.canManage) return;
      setEditor(null); setNotice("固定评测问题已保存 原运行的快照和评分保持原样"); onChanged();
    } catch (cause) { if (alive.current && !blocked.current && live.current.authority === authority) failure(cause, "固定问题未保存"); }
    finally { posting.current = false; if (alive.current && !blocked.current) setMutation(""); }
  }
  async function archiveCase() {
    if (!editor?.id || !canManage || posting.current || blocked.current) return;
    posting.current = true; setMutation("case"); setError("");
    try {
      await governanceApi("evaluations/" + editor.id + "/archive", { expectedRevision: editor.revision, reason: "运营人员显式归档此评测问题" }, undefined, authority);
      if (!alive.current || blocked.current || live.current.authority !== authority) return;
      setEditor(null); onChanged();
    } catch (cause) { if (alive.current && !blocked.current) failure(cause, "归档未完成"); }
    finally { posting.current = false; if (alive.current && !blocked.current) setMutation(""); }
  }
  async function reviewAnswer() {
    if (!report || !canApprove || posting.current || reviewUnknown || blocked.current) return;
    const originalId = report.id, input = ReviewKnowledgeEvaluationSchema.safeParse({ result: reviewResult, reason });
    if (!input.success) { setError("请填写实际人工核验结论与完整依据"); return; }
    posting.current = true; setMutation("review"); setError("");
    const view = epoch.current, valid = () => alive.current && !blocked.current && live.current.authority === authority && live.current.canApprove && epoch.current === view;
    try {
      await governanceApi("evaluation-runs/" + originalId + "/review", input.data, undefined, authority);
      if (!valid()) return;
      setReason(""); void loadRun(originalId);
    } catch (cause) {
      if (valid()) {
        if (cause instanceof KnowledgeRequestError && (cause.status === 0 || cause.status >= 500)) setReviewUnknown({ id: originalId, ...input.data });
        failure(cause, "人工核验结果未确认 请先重读原运行 不自动再次登记");
      }
    } finally { posting.current = false; if (valid()) setMutation(""); }
  }
  if (denied) return <section className="kb-expanded kb-evaluation" aria-label="回答质量评测">
    <p role="status" className="kb-error">当前本人或评测读取范围已变化 原回答 历史和填写已清除 请重新核对当前权限</p></section>;
  const model = models.find(item => item.id === modelId);
  return <section className="kb-expanded kb-evaluation" aria-label="回答质量评测">
    <div className="kb-section-toolbar"><div><p className="kb-meta">固定单题 真实运行和人工事实核验分别记录 每次新运行可能产生实际模型费用</p>
      <p className="kb-meta">完整多题数据集 规则基线 全部尝试与单位合格成本仍待建设 不将本次两运行核对宣称为 H12 完整验收</p></div>
      {canManage && <button className="oc-button primary" disabled={!!mutation} onClick={() => { setEditor({ id: "", revision: 0, fields: blank() }); setError(""); }}><Plus size={14} aria-hidden="true" />新建评测问题</button>}</div>
    <div className="kb-form-grid"><label>回答评测模型<select aria-label="回答评测模型" value={modelId} disabled={!canRun || !!mutation || !!prepared} onChange={event => setModelId(event.target.value)}>
      <option value="">选择已配置模型</option>{models.map(item => <option key={item.id} value={item.id}>{item.label} · {item.model}</option>)}</select></label>
      <p className="kb-meta">{model ? "当前模型任务预算上限 " + (model.maxTaskCostUsd === null ? "未配置" : "$" + String(model.maxTaskCostUsd)) + " 原任务以实际保存协议为准" :
        models.length ? "选择模型后才能明确准备新的付费评测" : "暂无可用分析模型 请核对实际模型配置"}</p></div>
    {!canRun && <p className="kb-meta">新运行需要当前知识读取 管理和运行权限 读取原结果不等于有权发起新模型调用</p>}
    {error && <p className="kb-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <section className="kb-evaluation-recovery" aria-label="本人原评测恢复"><h3>本人原评测恢复</h3>
      {!intents.length && <p className="kb-meta">当前标签页没有待确认的原评测意图 不据此认定没有历史运行</p>}
      {intents.map(value => <article key={value.caseId} className="kb-evaluation-intent" aria-label={"原评测恢复 " + value.caseId}>
        <p>原问题 <code>{value.caseId}</code> · 原模型配置 <code>{value.input.modelId}</code></p><p>固定原请求编号 <code>{value.input.requestId}</code></p>
        {value.runId ? <><p>已登记原评测运行 <code>{value.runId}</code> 后续读取失败不等于未启动</p><div className="kb-inline-actions">
          <button className="oc-button" disabled={!!mutation} onClick={() => void loadRun(value.runId!, true, false, value)}>只读取原评测结果</button>
          <button className="oc-button" disabled={!!mutation} onClick={() => finishIntent(value)}>确认原运行编号并清除恢复副本</button></div></> :
          <><p className="kb-warning">原提交结果未知 仅按相同问题 模型和原编号恢复 若原请求尚未到达服务器 将按该原请求登记一次 不换键重做</p>
            <button className="oc-button" disabled={!canRun || !!mutation} onClick={() => void startOriginal(value)}>按原请求恢复评测登记</button></>}
      </article>)}
    </section>
    {prepared && <section className="kb-evaluation-intent" aria-label="核对新的付费评测" data-closing={closing === "prepared"} inert={closing === "prepared"}>
      <h3>核对新的付费评测</h3><p>这是新的独立尝试 可能再次付费 不用于恢复已经提交的原运行</p>
      <p>原问题 <code>{prepared.caseId}</code> · 本次模型配置 <code>{prepared.input.modelId}</code></p><p>固定请求编号 <code>{prepared.input.requestId}</code></p>
      <p className="kb-meta">发送前在本标签页保存完整原正文和编号 不保存问题 回答或知识摘录 不自动调用模型</p>
      <div className="kb-inline-actions"><button className="oc-button primary" disabled={!!mutation || !canRun || closing !== null} onClick={() => void startOriginal(prepared)}><Play size={14} aria-hidden="true" />确认提交这次付费评测</button>
        <button className="oc-button" disabled={!!mutation} onClick={() => close("prepared")}><X size={14} aria-hidden="true" />放弃未发送的评测填写</button></div></section>}
    <form className="kb-evaluation-search" aria-label="按原运行 ID 读取评测" onSubmit={event => { event.preventDefault(); void loadRun(runDraft, true); }}>
      <label>原评测运行 ID<input value={runDraft} onChange={event => setRunDraft(event.target.value)} autoComplete="off" disabled={!!mutation} /></label>
      <button className="oc-button" disabled={!runDraft.trim() || !!mutation}><Search size={14} aria-hidden="true" />按原运行 ID 读取</button></form>
    {!data.evaluations.length ? <p className="kb-empty">尚无固定评测问题 可先登记业务问题与无证据时应拒答的场景 原历史仍可按运行 ID 读取</p> :
      <div className="kb-rows">{data.evaluations.map(value => <div className="kb-row" key={value.id}><div><strong>{value.fields.label} · 当前问题 V{value.revision}</strong>
        <p className="kb-prose">{value.fields.search.query}</p><p className="kb-meta">{value.fields.search.platform}/{value.fields.search.market} · {value.fields.expectRefusal ? "要求拒答" : "检查回答要点与引用"}</p></div>
        <div className="kb-inline-actions"><button className="oc-button" disabled={!!mutation} onClick={() => void loadPage(value.id, undefined, [undefined], true)}>结果与版本对比</button>
          {canManage && <button className="oc-button" disabled={!!mutation} onClick={() => { setEditor({ id: value.id, revision: value.revision, fields: structuredClone(value.fields) }); setError(""); }}>编辑问题</button>}
          {canRun && <button className="oc-button primary" disabled={!!mutation || !modelId || !!prepared || intents.some(item => item.caseId === value.id)} onClick={() => prepareStart(value.id)}>运行回答评测</button>}</div></div>)}</div>}
    {editor && <EvaluationEditor key={editor.id + ":" + editor.revision} value={editor} library={library} busy={mutation === "case"} error={error}
      closing={closing === "editor"} onClose={() => close("editor")} onSave={input => void saveCase(input)} onArchive={editor.id ? () => void archiveCase() : undefined} />}
    {historyOpen && <TaskDrawer title="回答评测结果与版本对比" description="原运行 原封存评分和当前读取状态分开核对 不自动发起新模型调用"
      state={{ dirty: !!reason, busy: mutation === "review", loading: Object.values(reading).some(Boolean) }}
      onClose={() => close("history")} footer={<TaskDrawerActions>
        <button className="oc-button" disabled={!!mutation || reading.detail || closing !== null || !report} onClick={() => report && void loadRun(report.id)}><RefreshCw size={14} aria-hidden="true" />重读当前原运行</button>
        <button className="oc-button" disabled={mutation === "review"} onClick={() => { if (!reason || window.confirm("尚有人工核验填写 关闭将清除本页填写 原运行不取消")) close("history"); }}>关闭结果读取</button>
      </TaskDrawerActions>}>
      <div className="kb-form kb-evaluation" data-closing={closing === "history"} inert={closing === "history"}>
        {error && <p className="kb-error" role="alert">{error}</p>}{Object.values(reading).some(Boolean) && <p role="status">正在读取原评测依据</p>}
        {historyCase && <section aria-label="原问题完整运行历史"><h3>原问题完整运行历史</h3><p>原问题 <code>{historyCase}</code> · 本页 {page?.items.length ?? 0} 条{page ? page.nextCursor ? " 还有下一页" : " 本次查询已到末页" : " 尚未完成读取"}</p>
          <div className="kb-inline-actions"><button className="oc-button" disabled={reading.list} onClick={() => void loadPage(historyCase)}>重新读取原问题历史</button>
            <button className="oc-button" disabled={reading.list || trail.length < 2} onClick={() => { const next = trail.slice(0, -1); void loadPage(historyCase, next.at(-1), next); }}>上一页原评测运行</button>
            <button className="oc-button" disabled={reading.list || !page?.nextCursor} onClick={() => void loadPage(historyCase, page!.nextCursor!, [...trail, page!.nextCursor!])}>下一页原评测运行</button></div>
          {page && <ul className="kb-evaluation-runs">{page.items.map(value => <li key={value.id}><p>{value.answer.modelLabel} · {value.createdAt} · {value.answer.status}</p><p>原运行 <code>{value.id}</code></p>
            <div className="kb-inline-actions"><button className="oc-button" disabled={reading.detail} onClick={() => void loadRun(value.id)}>读取原运行 {value.id.slice(-8)}</button>
              <button className="oc-button" onClick={() => { requests.current.compare++; requests.current.aborts.get("compare")?.abort(); setBaselineId(value.id); setComparison(null); setReading(current => ({ ...current, compare: false })); }}>设为基线原运行 {value.id.slice(-8)}</button>
              <button className="oc-button" onClick={() => { requests.current.compare++; requests.current.aborts.get("compare")?.abort(); setCandidateId(value.id); setComparison(null); setReading(current => ({ ...current, compare: false })); }}>设为候选原运行 {value.id.slice(-8)}</button></div></li>)}</ul>}
          {page && !page.items.length && <p className="kb-empty">本查询页没有原运行 不以此推断其它问题或其它页为空</p>}</section>}
        <form className="kb-evaluation-search" onSubmit={event => { event.preventDefault(); void loadRun(runDraft); }} aria-label="在原问题内按运行 ID 读取">
          <label>原运行 ID<input value={runDraft} onChange={event => setRunDraft(event.target.value)} autoComplete="off" /></label><button className="oc-button" disabled={reading.detail || !runDraft.trim()}>读取这次原运行</button></form>
        <form className="kb-form-grid" aria-label="明确选择基线和候选运行" onSubmit={event => { event.preventDefault(); void compareRuns(); }}>
          <label>基线运行 ID<input value={baselineId} onChange={event => { setBaselineId(event.target.value); requests.current.compare++; requests.current.aborts.get("compare")?.abort(); setComparison(null); setReading(value => ({ ...value, compare: false })); }} autoComplete="off" /></label>
          <label>候选运行 ID<input value={candidateId} onChange={event => { setCandidateId(event.target.value); requests.current.compare++; requests.current.aborts.get("compare")?.abort(); setComparison(null); setReading(value => ({ ...value, compare: false })); }} autoComplete="off" /></label>
          <button className="oc-button" disabled={reading.compare || !baselineId || !candidateId}>读取并比较这两次原运行</button></form>
        {comparison ? <KnowledgeEvaluationComparisonView value={comparison} /> : report && <KnowledgeEvaluationReportView report={report} />}
        {reviewUnknown && <p role="alert" className="kb-warning">原人工核验登记结果未知 请先重读该运行核对实际历史 不自动再次登记</p>}
        {!comparison && report && canApprove && report.answer.status === "completed" && !report.answer.stale && report.answer.result && <section aria-label="登记事实性人工核验">
          <h3>事实性人工核验</h3><p>当前原运行 <code>{report.id}</code> 断言通过不代替实际人工核验</p>
          <label>事实性人工核验<select aria-label="事实性人工核验" value={reviewResult} disabled={!!mutation || !!reviewUnknown} onChange={event => setReviewResult(event.target.value as typeof reviewResult)}>
            <option value="needs_review">需要补充核验</option><option value="pass">已逐项核验 通过</option><option value="fail">存在事实或引用问题</option></select></label>
          <label>核验依据<textarea value={reason} rows={3} maxLength={1000} disabled={!!mutation || !!reviewUnknown} onChange={event => setReason(event.target.value)} /></label>
          <button className="oc-button primary" disabled={!!mutation || !!reviewUnknown || !reason.trim()} onClick={() => void reviewAnswer()}><Check size={14} aria-hidden="true" />记录人工核验</button></section>}
        {!comparison && report && canApprove && (report.answer.stale || report.answer.status === "completed" && !report.answer.result) && <p className="kb-meta">当前原回答或依据不可核对 不新增事实性人工核验 原人工记录继续保留</p>}
      </div>
    </TaskDrawer>}
  </section>;
}

function EvaluationEditor({ value, library, busy, error, closing, onClose, onSave, onArchive }: {
  value: Editor; library: KnowledgeWorkspace; busy: boolean; error: string; closing: boolean; onClose(): void;
  onSave(input: ReturnType<typeof SaveKnowledgeEvaluationSchema.parse>): void; onArchive?: () => void;
}) {
  const [fields, setFields] = useState(() => structuredClone(value.fields)), [expected, setExpected] = useState(value.fields.expectedFacts.join("\n"));
  const [forbidden, setForbidden] = useState(value.fields.forbiddenClaims.join("\n")), [validation, setValidation] = useState("");
  const pending = useRef<{ identity: string; requestId: string } | null>(null);
  const input = { ...fields, expectedFacts: lines(expected), forbiddenClaims: lines(forbidden) };
  const dirty = canonicalJson(input) !== canonicalJson(value.fields);
  return <TaskDrawer title={value.id ? "编辑评测问题" : "新建评测问题"} state={{ dirty, busy, loading: false }} onClose={onClose}
    footer={<TaskDrawerActions><button className="oc-button" disabled={busy} onClick={() => { if (!dirty || window.confirm("尚有评测问题填写 关闭将清除本页修改")) onClose(); }}>取消</button>
      {onArchive && <button className="oc-button" disabled={busy} onClick={onArchive}>归档问题</button>}
      <button className="oc-button primary" form="kb-eval-form" type="submit" disabled={busy || closing}>保存固定问题</button></TaskDrawerActions>}>
    <form className="kb-form kb-evaluation" id="kb-eval-form" data-closing={closing} inert={closing} onSubmit={event => {
      event.preventDefault(); if (busy || closing) return;
      const parsed = KnowledgeEvaluationCaseSchema.safeParse(input); if (!parsed.success) { setValidation("请完整填写问题和符合限制的断言 未截断或补造内容"); return; }
      const identity = canonicalJson({ caseId: value.id, fields: parsed.data, expectedRevision: value.revision });
      if (pending.current?.identity !== identity) pending.current = { identity, requestId: crypto.randomUUID() };
      onSave(SaveKnowledgeEvaluationSchema.parse({ fields: parsed.data, expectedRevision: value.revision, requestId: pending.current.requestId }));
    }}>
      <fieldset disabled={busy || closing}><label>问题名称<input value={fields.label} maxLength={180} required onChange={event => setFields(current => ({ ...current, label: event.target.value }))} /></label>
        <label>固定业务问题<textarea value={fields.search.query} rows={3} maxLength={300} required onChange={event => setFields(current => ({ ...current, search: { ...current.search, query: event.target.value } }))} /></label>
        <KnowledgeScopeForm value={fields.search} onChange={search => setFields(current => ({ ...current, search }))} spus={library.spus} />
        <label>期望答案要点（每行一项）<textarea rows={4} value={expected} onChange={event => setExpected(event.target.value)} /></label>
        <label>禁止出现的表述（每行一项）<textarea rows={3} value={forbidden} onChange={event => setForbidden(event.target.value)} /></label>
        <KnowledgeCardChoices label="必需引用的知识卡" entries={library.entries} value={fields.requiredEntryIds} onChange={ids => setFields(current => ({ ...current, requiredEntryIds: ids }))} />
        <label className="kb-checkbox"><input type="checkbox" checked={fields.expectRefusal} onChange={event => setFields(current => ({ ...current, expectRefusal: event.target.checked }))} />本题缺少依据 应明确拒答并说明缺口</label>
      </fieldset>{(validation || error) && <p role="alert" className="kb-error">{validation || error}</p>}
    </form>
  </TaskDrawer>;
}
