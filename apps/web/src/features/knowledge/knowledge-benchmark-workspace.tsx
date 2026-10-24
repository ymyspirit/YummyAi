"use client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Permission } from "@yummyai/authz/permissions";
import { requiredAssistPermissions } from "@yummyai/authz/assist-policy";
import { benchmarkDomainMinimumScope } from "@yummyai/authz/business-benchmark-policy";
import { BenchmarkReportSchema, BUSINESS_BENCHMARK_ROLES } from "@yummyai/contracts/knowledge/benchmark";
import { useErpAccess } from "../identity/erp-access";
import { useOwnedViewTransition } from "../navigation/use-owned-view-transition";
import { knowledgeReadDenied, KnowledgeRequestError } from "./knowledge-api";
import { KnowledgeBenchmarkDataset, BenchmarkMutationFeedback } from "./knowledge-benchmark-dataset";
import { KnowledgeBenchmarkExperiment } from "./knowledge-benchmark-experiment";
import { BenchmarkReportView } from "./knowledge-benchmark-costs";
import { benchmarkIntentEvent, benchmarkError, clearBenchmarkIntents, readBenchmarkIntents, readBenchmarkReceipt, forgetBenchmarkIntent,
  useBenchmarkMutation, useBenchmarkRead, type BenchmarkIntent, type BenchmarkScope } from "./knowledge-benchmark-client";
import "./knowledge-benchmark.css";

type Selection = { kind: "dataset" | "version" | "experiment" | "attempt" | "report"; id: string };
export function KnowledgeBenchmarkWorkspace() {
  const access = useErpAccess(), owner = useRef({ authority: access.authority, preference: access.preferenceScope });
  const transition = useOwnedViewTransition();
  const [denied, setDenied] = useState(false), [pane, setPane] = useState<"datasets" | "experiments">("datasets"), [selection, setSelection] = useState<Selection | null>(null);
  const [proposedVersion, setProposedVersion] = useState(""), [markers, setMarkers] = useState<BenchmarkIntent[]>([]);
  const alive = useRef(true), blocked = useRef(false), identity = useRef(access.authority), readable = useRef(false);
  identity.current = access.authority; readable.current = access.can(Permission.WorkflowRead);
  const matches = owner.current.authority === access.authority && owner.current.preference === access.preferenceScope;
  const allowed = matches && access.authority !== null && access.can(Permission.WorkflowRead);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useLayoutEffect(() => { if (!allowed) { blocked.current = true; transition.cancel(); clearBenchmarkIntents(); } }, [allowed, transition]);
  const deny = useCallback(() => {
    blocked.current = true; transition.cancel(); clearBenchmarkIntents(); setMarkers([]); setSelection(null); setProposedVersion(""); setDenied(true);
    window.dispatchEvent(new Event("focus"));
  }, [transition]);
  const canManage = access.can(Permission.WorkflowManage), canRun = access.can(Permission.WorkflowRun), canApprove = access.can(Permission.WorkflowApprove);
  const roleKey = BUSINESS_BENCHMARK_ROLES.filter(role => requiredAssistPermissions(role, "run").every(bit =>
    benchmarkDomainMinimumScope(role, bit) === "tenant" ? access.canTenant(bit) : access.can(bit))).join(",");
  const businessRoles = useMemo(() => BUSINESS_BENCHMARK_ROLES.filter(role => roleKey.split(",").includes(role)), [roleKey]);
  const authority = access.authority ?? "";
  const scope: BenchmarkScope = useMemo(() => ({ authority, canManage, canRun, canApprove, businessRoles, deny,
    current: () => alive.current && !blocked.current && readable.current && identity.current === authority && owner.current.authority === authority }), [authority, canManage, canRun, canApprove, businessRoles, deny]);
  useLayoutEffect(() => {
    if (!allowed || denied) return;
    const update = () => { if (scope.current()) setMarkers(readBenchmarkIntents(authority)); }; update(); window.addEventListener(benchmarkIntentEvent, update);
    return () => window.removeEventListener(benchmarkIntentEvent, update);
  }, [authority, scope, allowed, denied]);
  const useVersion = (id: string) => { setProposedVersion(id); setSelection(null); setPane("experiments"); };
  const open = (value: Selection) => { setSelection(value); setPane(value.kind === "dataset" || value.kind === "version" ? "datasets" : "experiments"); };
  if (!allowed || denied) return <section className="kb-benchmark" aria-label="固定数据集与实验"><p role="status" className="kb-error">当前本人或知识评测读取范围已变化 原数据集 实验 答案和填写已隐藏 请重新核对当前权限</p></section>;
  return <section className="kb-benchmark" aria-label="固定数据集与实验"><header><h2>固定数据集与实验</h2><p>知识问答与八类真实业务角色 · 知识和业务分别发布数据集</p></header>
    <p className="kb-warning">固定题目与预期长期保留 仅填写已脱敏分析内容 不填写客户原文或身份信息 依据到期不等于删除固定题目和预期</p>
    <p className="kb-meta">采购与经营汇总及订单隐私沿原租户范围门 创意 模板与 SKU 仍按实际本人或团队资源授权 商品和资产附加权限由原业务依据核验 不以评测权限扩大读取</p>
    <section className="kb-benchmark-section" aria-label="本人评测原请求恢复"><h3>本人评测原请求恢复</h3>
      <p className="kb-meta">本标签页只保存原请求 ID 操作 父 ID 校验值和回执引用 不保存问题 答案或费用正文 只读查回执不运行模型</p>
      {!markers.length && <p>当前标签页没有待确认意图 不据此判断没有历史实验</p>}
      {markers.map(marker => <RequestRecovery key={marker.requestId} value={marker} scope={scope} onOpen={open} />)}</section>
    <nav className="kb-tabs" aria-label="固定评测工作区"><button aria-current={pane === "datasets" ? "page" : undefined} onClick={() => transition.change(() => { if (scope.current()) { setPane("datasets"); setSelection(null); } })}>数据集与发布版本</button>
      <button aria-current={pane === "experiments" ? "page" : undefined} onClick={() => transition.change(() => { if (scope.current()) { setPane("experiments"); setSelection(null); } })}>实验 尝试与成本报告</button></nav>
    <div key={pane + ":" + (selection?.kind ?? "") + ":" + (selection?.id ?? "")} className="kb-benchmark-pane">
      {pane === "datasets" ? <KnowledgeBenchmarkDataset scope={scope} onUseVersion={useVersion} initialDatasetId={selection?.kind === "dataset" ? selection.id : ""} initialVersionId={selection?.kind === "version" ? selection.id : ""} /> :
        <KnowledgeBenchmarkExperiment scope={scope} initialVersionId={proposedVersion} initialExperimentId={selection?.kind === "experiment" ? selection.id : ""} initialAttemptId={selection?.kind === "attempt" ? selection.id : ""} />}
    </div>
    {selection?.kind === "report" && <OriginalReport scope={scope} id={selection.id} />}
    <p className="kb-meta">所有分页数量与费用摘要由当前受权服务返回 不从已读页推算全量 合格不等于外部业务放行或提供方账单验真</p>
  </section>;
}
function OriginalReport({ scope, id }: { scope: BenchmarkScope; id: string }) {
  const read = useBenchmarkRead("reports/" + id, BenchmarkReportSchema, scope, id);
  return <section aria-label="按回执读取原封存报告">{read.reading && <p role="status">正在读取原封存报告</p>}{read.error && <p className="kb-error" role="alert">{read.error}</p>}
    <button className="oc-button" disabled={read.reading} onClick={read.reload}>重读此原封存报告</button>{read.data && <BenchmarkReportView value={read.data} />}</section>;
}
function RequestRecovery({ value, scope, onOpen }: { value: BenchmarkIntent; scope: BenchmarkScope; onOpen(value: Selection): void }) {
  const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof readBenchmarkReceipt>>>(null), [error, setError] = useState(""), [reading, setReading] = useState(false);
  const generation = useRef(0), active = useRef<AbortController | null>(null), alive = useRef(true), action = useBenchmarkMutation(scope);
  useEffect(() => { alive.current = true; return () => { alive.current = false; generation.current++; active.current?.abort(); }; }, []);
  async function read() {
    const token = ++generation.current; active.current?.abort(); const abort = new AbortController(); active.current = abort;
    setReading(true); setError("");
    try { const result = await readBenchmarkReceipt(value, scope, abort.signal); if (alive.current && !abort.signal.aborted && token === generation.current && scope.current()) setReceipt(result); }
    catch (failure) { if (alive.current && !abort.signal.aborted && token === generation.current && scope.current()) {
      if (knowledgeReadDenied(failure) && (!(failure instanceof KnowledgeRequestError) || failure.status !== 404 || value.receiptId || receipt)) scope.deny();
      else setError(failure instanceof KnowledgeRequestError && failure.status === 404 ? "原回执尚未找到 这不是未提交证明 不生成新键或从当前资料重建原正文 请继续核对" : benchmarkError(failure));
    } } finally { if (alive.current && !abort.signal.aborted && token === generation.current && scope.current()) setReading(false); }
  }
  function open(id: string) {
    if (value.operation === "dataset.create" || value.operation === "dataset.save") onOpen({ kind: "dataset", id });
    else if (value.operation === "dataset.publish") onOpen({ kind: "version", id });
    else if (value.operation === "experiment.create") onOpen({ kind: "experiment", id });
    else if (value.operation === "attempt.start") onOpen({ kind: "attempt", id });
    else if (value.operation === "attempt.review" && value.parentId) onOpen({ kind: "attempt", id: value.parentId });
    else if (value.operation === "report.create") onOpen({ kind: "report", id });
    else if (value.parentId) onOpen({ kind: "experiment", id: value.parentId });
  }
  return <article className="kb-benchmark-recovery" aria-label={"原评测请求 " + value.requestId}><p>{value.operation} · 原请求 <code>{value.requestId}</code></p>
    <details className="kb-benchmark-details"><summary>核对原请求身份与摘要</summary><p>父对象 {value.parentId ?? "根创建操作"}</p><code>{value.requestChecksum}</code></details>
    <button className="oc-button" disabled={reading || action.busy} onClick={() => void read()}>只读取原命令回执</button>
    {reading && <p role="status">正在核对当前本人原回执</p>}{error && <p className="kb-error" role="alert">{error}</p>}
    {receipt && <section aria-label="已找回的原命令回执"><p>真实登记 <code>{receipt.receipt.id}</code> · 修订 {receipt.receipt.revision} · {receipt.createdAt}</p>
      <div className="kb-inline-actions"><button className="oc-button" onClick={() => open(receipt.receipt.id)}>读取原登记结果</button>
        <button className="oc-button" onClick={() => { try { forgetBenchmarkIntent(value); } catch { setError("原回执已登记 恢复标识尚未清除 请保留原编号后重试确认"); } }}>确认原回执并清除恢复标识</button></div>
      {value.operation === "expense.record" && <p className="kb-meta">后续实验成本是另一次当前读取 原封存报告保持原摘要 不能把当前余额冒充原执行时结果</p>}</section>}
    {!receipt && value.attemptInput && scope.canManage && scope.canRun && !value.receiptId && <><p className="kb-warning">原候选意图只含固定 ID 可按相同正文与编号恢复 若原请求未到达会登记这一次 不会改为新的付费尝试</p>
      <button className="oc-button" disabled={action.busy} onClick={() => { if (window.confirm("仅恢复这次原付费意图 不换键 如果服务器尚未收到将登记这一次 是否继续")) void action.restore(value); }}>按原纯 ID 请求恢复</button></>}
    <BenchmarkMutationFeedback action={action} onDone={open} doneLabel="读取恢复的原尝试" />
  </article>;
}
