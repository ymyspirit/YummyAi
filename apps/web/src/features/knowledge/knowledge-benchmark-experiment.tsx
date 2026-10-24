"use client";
import { useEffect, useState } from "react";
import { Play } from "lucide-react";
import { AssistModelSchema, type AssistModel } from "@yummyai/contracts/ai/assist";
import { BUSINESS_BENCHMARK_RULE_VERSION, BUSINESS_BENCHMARK_GRADER_VERSION, ROLE_BENCHMARK_RULE_VERSION, ROLE_BENCHMARK_GRADER_VERSION, benchmarkExecutionVersions, BenchmarkExperimentPageSchema, BenchmarkExperimentSchema, BenchmarkVersionSchema, BenchmarkAttemptPageSchema,
  BenchmarkAttemptSchema, CreateBenchmarkExperimentSchema, StartBenchmarkAttemptSchema, ReviewBenchmarkAttemptSchema,
  type BenchmarkAttempt, type BenchmarkCellSchema } from "@yummyai/contracts/knowledge/benchmark";
import type { z } from "zod";
import { assistApi, assistReadDenied } from "../ai-assist/assist-client";
import { TaskDrawer, TaskDrawerActions } from "../navigation/task-drawer";
import { useBenchmarkRead, useBenchmarkPage, useBenchmarkMutation, useBenchmarkDismiss, benchmarkError, type BenchmarkScope } from "./knowledge-benchmark-client";
import { BenchmarkPairs, BenchmarkPair, BenchmarkMutationFeedback, BenchmarkPager, BenchmarkVersionView } from "./knowledge-benchmark-dataset";
import { KnowledgeBenchmarkCosts } from "./knowledge-benchmark-costs";
import { BenchmarkRoleResult } from "./knowledge-benchmark-role-result";

const states = { not_started: "尚未运行", queued: "排队中", running: "处理中", completed: "技术处理完成", failed: "执行失败", cancelled: "已取消", uncertain: "提交结果未知", unavailable: "原依据不可用" };
export function BenchmarkAttemptView({ value }: { value: BenchmarkAttempt }) {
  const business = value.assessment?.graderVersion === BUSINESS_BENCHMARK_GRADER_VERSION || value.assessment?.graderVersion === ROLE_BENCHMARK_GRADER_VERSION || value.evaluationRunId === null && Boolean(value.nativeRunId);
  return <section className="kb-benchmark-section" aria-label="原实验尝试结果"><h3>{value.arm === "baseline" ? "规则基线" : "候选"} · 尝试 {value.ordinal}</h3>
    <BenchmarkPairs><BenchmarkPair label="原尝试 ID"><code>{value.id}</code></BenchmarkPair><BenchmarkPair label="原实验 / 样本"><code>{value.experimentId}</code><br /><code>{value.itemId}</code></BenchmarkPair>
      <BenchmarkPair label="运行状态">{states[value.state]} · {value.createdAt}</BenchmarkPair><BenchmarkPair label="原请求编号"><code>{value.requestId}</code></BenchmarkPair>
      <BenchmarkPair label="原生评测运行">{value.evaluationRunId ? <code>{value.evaluationRunId}</code> : value.nativeRunId ? "业务样本 不建立知识问题运行" : "本次未建立知识问题运行"}</BenchmarkPair>
      <BenchmarkPair label="原生 AI 运行">{value.nativeRunId ? <code>{value.nativeRunId}</code> : value.arm === "baseline" ? "规则基线未发起模型调用" : "原引用未保留 不猜测其他任务 ID"}</BenchmarkPair>
      <BenchmarkPair label="模型费用">{value.modelCost.amountUsd === null ? "未知 不当作零" : "USD " + value.modelCost.amountUsd} · {{ not_submitted: "未提交提供方", usage_estimate: "按用量估算", billing_acknowledged: "已有人工账单补证", unknown: "费用未知" }[value.modelCost.source]}</BenchmarkPair>
      <BenchmarkPair label="实际调用边界">确认提供方 {value.modelCost.confirmedProviderCalls} · 可能提供方 {value.modelCost.possibleProviderCalls} · 本地处理 {value.modelCost.localProcessingAttempts}</BenchmarkPair>
      <BenchmarkPair label="账单补证 ID">{value.modelCost.billingReceiptId ? <code>{value.modelCost.billingReceiptId}</code> : "尚无账单补证"}</BenchmarkPair></BenchmarkPairs>
    {value.assessment ? <section aria-label="原封存硬检查"><h4>{value.assessment.hardPass ? "原硬检查通过" : "原硬失败 不可由人工通过覆盖"}</h4>
      <p>评分 <code>{value.assessment.id}</code> · {value.assessment.graderVersion} · {value.assessment.createdAt}</p>
      <details className="kb-benchmark-details"><summary>完整硬检查与固定依据</summary><p>原题 <code>{value.assessment.caseChecksum}</code><br />依据 <code>{value.assessment.basisFingerprint}</code><br />原输出 <code>{value.assessment.outputChecksum}</code></p>
        <ul>{value.assessment.checks.map((check, index) => <li className={check.status === "fail" ? "kb-warning" : undefined} key={index}>{check.label} · {check.status === "pass" ? "通过" : "硬失败"}<p>{check.detail}</p></li>)}</ul></details>
    </section> : <p className="kb-warning">尚无实际封存评分 不用当前文字或历史别次评分补造</p>}
    {value.resultAvailable && value.result ? <section aria-label="本次受权读取原答案"><h4>原答案</h4><p>{value.result.summary}</p>
      {value.result.findings.map((finding, index) => <div key={index}><strong>{finding.title}</strong><p>{{ fact: "资料观察", inference: "推测", recommendation: "建议" }[finding.kind]} · {{ info: "说明", warning: "待核对", error: "错误" }[finding.severity]}</p><p>{finding.detail}</p>{finding.location && <p>原位置 {finding.location}</p>}<ul>{finding.evidence.map((source, at) => <li key={at}><code>{source.sourceId}</code> · {source.detail}</li>)}</ul></div>)}
      {!business && <><h4>结构化数值答案</h4>{value.result.typedAnswers?.length ? <ul>{value.result.typedAnswers.map((answer, index) => <li key={index}>{answer.key} · <strong>{answer.value} {answer.unit} {answer.currency}</strong>
        <ul>{answer.evidence.map((source, at) => <li key={at}><code>{source.sourceId}</code> · {source.detail}</li>)}</ul></li>)}</ul> : <p>没有结构化数值答案 是否构成硬失败以原封存检查为准 不从自然语言猜值</p>}
      </>}{business && <BenchmarkRoleResult result={value.result} ruleBaseline={value.arm === "baseline"} />}
      {value.result.missingInformation.length > 0 && <ul className="kb-warning">{value.result.missingInformation.map((text, index) => <li key={index}>{text}</li>)}</ul>}
    </section> : <p className="kb-warning">原答案当前不可读或尚未完成 原尝试 费用与已有评分独立保留 不重新调用模型</p>}
    <section aria-label="最近一次实际人工核验"><h4>最近一次实际人工核验</h4>{value.review ? <>
      <p>{{ pass: "人工通过", fail: "人工未通过", needs_review: "仍需补充核验" }[value.review.decision]} · {value.review.minutes} 分钟 · 小时费率 {value.review.hourlyUsd === null ? "未知" : "USD " + value.review.hourlyUsd}</p>
      <p>{value.review.reason}</p><p><code>{value.review.id}</code> · 序号 {value.review.sequence} · {value.review.createdAt}</p>
      <p>前次核验 {value.review.previousId ? <code>{value.review.previousId}</code> : "无"}</p></> : <p>尚无实际人工核验 不将硬检查通过当成人工事实批准</p>}
      <p className="kb-meta">此处显示最新核验 全部人工分钟与费用由服务累计 旧核验 ID 可从原封存报告核对</p></section>
  </section>;
}

export function KnowledgeBenchmarkExperiment({ scope, initialVersionId, initialExperimentId = "", initialAttemptId = "" }: { scope: BenchmarkScope; initialVersionId: string; initialExperimentId?: string; initialAttemptId?: string }) {
  const page = useBenchmarkPage("experiments", BenchmarkExperimentPageSchema, scope);
  const [selected, setSelected] = useState(initialExperimentId), [idDraft, setIdDraft] = useState(""), [versionDraft, setVersionDraft] = useState(initialVersionId), [versionId, setVersionId] = useState(initialVersionId);
  const [label, setLabel] = useState(""), [reason, setReason] = useState(""), [max, setMax] = useState("1"), [models, setModels] = useState<AssistModel[]>([]), [modelId, setModelId] = useState("");
  const [modelError, setModelError] = useState(""), [itemId, setItemId] = useState(""), [arm, setArm] = useState(""), [attemptId, setAttemptId] = useState(initialAttemptId), [attemptDraft, setAttemptDraft] = useState("");
  const [starting, setStarting] = useState<z.infer<typeof BenchmarkCellSchema> | null>(null), [revision, setRevision] = useState(0);
  const experiment = useBenchmarkRead(selected ? "experiments/" + selected : null, BenchmarkExperimentSchema, scope, selected, revision);
  const version = useBenchmarkRead(versionId ? "versions/" + versionId : null, BenchmarkVersionSchema, scope, versionId);
  const attempts = useBenchmarkPage(selected ? "experiments/" + selected + "/attempts?" + new URLSearchParams({ ...(itemId ? { itemId } : {}), ...(arm ? { arm } : {}) }) : null, BenchmarkAttemptPageSchema, scope);
  const attempt = useBenchmarkRead(attemptId ? "attempts/" + attemptId : null, BenchmarkAttemptSchema, scope, attemptId, revision);
  const create = useBenchmarkMutation(scope);
  const baselineVersion = version.data ? benchmarkExecutionVersions(version.data.items.map(item => item.fields.role)).baselineVersion : null;
  useEffect(() => { const abort = new AbortController();
    assistApi<unknown>("models", undefined, abort.signal).then(raw => { if (!abort.signal.aborted && scope.current()) setModels(AssistModelSchema.array().parse(raw)); })
      .catch(error => { if (!abort.signal.aborted && scope.current()) { if (assistReadDenied(error)) scope.deny(); else setModelError(benchmarkError(error)); } });
    return () => abort.abort(); }, [scope]);
  const changed = () => { setRevision(value => value + 1); attempts.reset(); };
  return <section aria-label="固定样本实验"><h3>规则基线与候选实验</h3><p className="kb-meta">固定全题分母 以每题最新实际出生尝试为候选结果 新失败或未完成尝试不会回退挑选旧通过项</p>
    <BenchmarkPager page={page} label="实验" /><ul className="kb-benchmark-list">{page.data?.items.map(item => <li key={item.id}><div><strong>{item.label}</strong><p>{item.itemCount} 题 · {item.model.label} · {item.createdAt}</p><code>{item.id}</code></div>
      <button className="oc-button" onClick={() => { setSelected(item.id); setAttemptId(""); setItemId(""); }}>读取实验 {item.id.slice(-8)}</button></li>)}</ul>
    <form className="kb-benchmark-inline" aria-label="按原实验 ID 读取" onSubmit={event => { event.preventDefault(); setSelected(idDraft.trim()); setAttemptId(""); setItemId(""); }}><label>原实验 ID<input value={idDraft} onChange={event => setIdDraft(event.target.value)} /></label><button className="oc-button" disabled={!idDraft.trim()}>读取原实验</button></form>
    {scope.canManage && scope.canRun && <details className="kb-benchmark-details" open={Boolean(initialVersionId) || undefined}><summary>准备新的固定版本实验</summary>
      <form className="kb-benchmark-inline" aria-label="核对实验发布版本" onSubmit={event => { event.preventDefault(); setVersionId(versionDraft.trim()); version.reload(); }}>
        <label>实验数据集发布版本 ID<input value={versionDraft} disabled={create.locked} onChange={event => setVersionDraft(event.target.value)} /></label><button className="oc-button" disabled={!versionDraft.trim() || create.locked}>核对实验发布版本</button></form>
      {version.error && <p role="alert" className="kb-error">{version.error}</p>}{version.data && <BenchmarkVersionView value={version.data} />}
      <form className="kb-form" aria-label="创建固定版本实验" onSubmit={event => { event.preventDefault();
        const input = CreateBenchmarkExperimentSchema.safeParse({ datasetVersionId: version.data?.id, label, baselineVersion, modelId, maxAttemptsPerItem: Number(max), reason, requestId: crypto.randomUUID() });
        if (input.success && version.data?.items.every(item => item.usable) && versionDraft.trim() === version.data.id) void create.submit("experiments", input.data); else create.invalid("请核对实际可用的发布版本 模型 每题上限与实验依据"); }}>
        <fieldset disabled={create.locked}><label>实验名称<input required maxLength={180} value={label} onChange={event => setLabel(event.target.value)} /></label>
          <label>候选评测模型<select aria-label="候选评测模型" required value={modelId} onChange={event => setModelId(event.target.value)}><option value="">选择真实配置的模型</option>{models.map(model => <option key={model.id} value={model.id}>{model.label} · {model.model}</option>)}</select></label>
          <label>每题候选尝试上限<input type="number" min="1" max="5" step="1" required value={max} onChange={event => setMax(event.target.value)} /></label>
          <label>实验创建依据<textarea aria-label="实验创建依据" required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
          <p>规则注册版本 <code>{baselineVersion ?? "先读取真实发布版本"}</code> · 创建免费执行同样本规则基线 候选每一题需另行明确确认付费 不批量自动调用</p>
          {baselineVersion === BUSINESS_BENCHMARK_RULE_VERSION && <p className="kb-warning">业务基线仅核对已固定事实与声明的文本要求 不证明金额语义或方案最优 人工核验必需</p>}
          {baselineVersion === ROLE_BENCHMARK_RULE_VERSION && <p className="kb-warning">角色规则基线只摘录原事实和缺项 不查看图片 创意角色要求三个原创方向 规则不会补造方向以通过结构检查 原硬失败仍计入成本与分母</p>}
          <button className="oc-button primary" disabled={!version.data || version.reading || versionDraft.trim() !== version.data.id}>创建实验并运行免费规则基线</button></fieldset></form>
      {modelError && <p className="kb-error" role="alert">{modelError}</p>}<BenchmarkMutationFeedback action={create} onDone={id => { setSelected(id); page.reset(); }} doneLabel="读取实际实验和规则基线" />
    </details>}
    {experiment.reading && <p role="status">正在读取原实验全部固定样本</p>}{experiment.error && <p className="kb-error" role="alert">{experiment.error}</p>}
    {experiment.data && <section className="kb-benchmark-section" aria-label="固定分母实验详情"><h3>{experiment.data.label}</h3><BenchmarkPairs>
      <BenchmarkPair label="原实验 ID"><code>{experiment.data.id}</code></BenchmarkPair><BenchmarkPair label="固定数据集版本"><code>{experiment.data.datasetVersionId}</code></BenchmarkPair>
      <BenchmarkPair label="固定分母 / 每题上限">{experiment.data.itemCount} 题 / {experiment.data.maxAttemptsPerItem} 次</BenchmarkPair><BenchmarkPair label="原规则版本">{experiment.data.baselineVersion}</BenchmarkPair>
      <BenchmarkPair label="原候选模型">{experiment.data.model.label} · {experiment.data.model.model}<br /><code>{experiment.data.modelId}</code></BenchmarkPair>
      <BenchmarkPair label="原读取范围 / 登记时间">{experiment.data.dataScope} · {experiment.data.createdAt}</BenchmarkPair></BenchmarkPairs>
      <button className="oc-button" onClick={changed}>重新读取实验与成本</button>
      <ul className="kb-benchmark-list" aria-label="全部固定样本结果">{experiment.data.cells.map(cell => <li key={cell.itemId}><div><strong>{cell.key} · {cell.label}</strong><p>规则基线 {cell.baselineHardPass ? "硬检查通过" : "硬失败"} · 候选 {states[cell.state]} · 最新尝试 {cell.latestAttemptOrdinal}</p>
        <p>{cell.qualified ? "本题最新尝试符合原合格口径" : "本题当前未计合格"} · 人审 {cell.reviewDecision ?? "尚无"}</p><code>{cell.itemId}</code></div>
        <div className="kb-inline-actions"><button className="oc-button" onClick={() => setAttemptId(cell.baselineAttemptId)}>读取规则基线 {cell.key}</button>
          {cell.latestAttemptId && <button className="oc-button" onClick={() => setAttemptId(cell.latestAttemptId!)}>读取最新候选 {cell.key}</button>}
          {scope.canManage && scope.canRun && <button className="oc-button primary" disabled={cell.latestAttemptOrdinal >= experiment.data!.maxAttemptsPerItem || ["queued", "running", "uncertain", "unavailable"].includes(cell.state)} onClick={() => setStarting(cell)}><Play size={14} aria-hidden="true" />准备本题新的付费尝试 {cell.key}</button>}
          {["queued", "running", "uncertain", "unavailable"].includes(cell.state) && <p className="kb-meta">先按原尝试核对当前结果或依据 不盲目新付费</p>}</div></li>)}</ul>
      <h4>全部尝试与失败历史</h4><div className="kb-benchmark-inline"><label>尝试样本筛选<select aria-label="尝试样本筛选" value={itemId} onChange={event => setItemId(event.target.value)}><option value="">全部固定样本</option>{experiment.data.cells.map(cell => <option key={cell.itemId} value={cell.itemId}>{cell.key} · {cell.label}</option>)}</select></label>
        <label>尝试类型筛选<select aria-label="尝试类型筛选" value={arm} onChange={event => setArm(event.target.value)}><option value="">规则与候选全部</option><option value="baseline">规则基线</option><option value="candidate">候选模型</option></select></label></div>
      <BenchmarkPager page={attempts} label="尝试历史" /><ul className="kb-benchmark-list">{attempts.data?.items.map(item => <li key={item.id}><p>{item.arm === "baseline" ? "规则" : "候选"} · 尝试 {item.ordinal} · {states[item.state]}<br /><code>{item.id}</code></p><button className="oc-button" onClick={() => setAttemptId(item.id)}>读取原尝试 {item.id.slice(-8)}</button></li>)}</ul>
    </section>}
    <form className="kb-benchmark-inline" aria-label="按原尝试 ID 读取" onSubmit={event => { event.preventDefault(); setAttemptId(attemptDraft.trim()); }}><label>原尝试 ID<input value={attemptDraft} onChange={event => setAttemptDraft(event.target.value)} /></label><button className="oc-button" disabled={!attemptDraft.trim()}>读取原实验尝试</button></form>
    {attempt.reading && <p role="status">正在受权读取原尝试</p>}{attempt.error && <p className="kb-error" role="alert">{attempt.error}</p>}
    {attempt.data && <><BenchmarkAttemptView value={attempt.data} /><button className="oc-button" onClick={() => setSelected(attempt.data!.experimentId)}>读取此尝试所属原实验</button>{scope.canApprove && attempt.data.assessment && attempt.data.resultAvailable && <AttemptReview key={attempt.data.id} scope={scope} attempt={attempt.data} onChanged={() => { attempt.reload(); changed(); }} />}</>}
    {experiment.data && <KnowledgeBenchmarkCosts key={experiment.data.id} scope={scope} experimentId={experiment.data.id} experimentCreatedAt={experiment.data.createdAt} revision={revision} />}
    {starting && experiment.data && <StartAttempt scope={scope} experimentId={experiment.data.id} cell={starting} onClose={() => setStarting(null)} onDone={id => { setAttemptId(id); setStarting(null); changed(); }} />}
  </section>;
}

function StartAttempt({ scope, experimentId, cell, onClose, onDone }: { scope: BenchmarkScope; experimentId: string; cell: z.infer<typeof BenchmarkCellSchema>; onClose(): void; onDone(id: string): void }) {
  const [confirmed, setConfirmed] = useState(false), action = useBenchmarkMutation(scope);
  const exit = useBenchmarkDismiss(scope, onClose);
  return <TaskDrawer title="核对本题新的付费尝试" state={{ dirty: confirmed && !action.receipt && !exit.closing, busy: action.busy, loading: false }} onClose={() => exit.dismiss()}
    footer={<TaskDrawerActions><button className="oc-button" disabled={action.busy || exit.closing} onClick={() => exit.dismiss()}>关闭付费尝试核对</button></TaskDrawerActions>}>
    <div className="kb-benchmark" data-benchmark-closing={exit.closing} inert={exit.closing}>
    <form className="kb-form kb-benchmark" aria-label="明确开始本题付费尝试" onSubmit={event => { event.preventDefault();
      const input = StartBenchmarkAttemptSchema.safeParse({ itemId: cell.itemId, expectedLatestAttemptId: cell.latestAttemptId, confirmNewPaidAttempt: confirmed, requestId: crypto.randomUUID() });
      if (input.success) void action.submit("experiments/" + experimentId + "/attempts/start", input.data); else action.invalid("请明确核对并确认这次新的付费尝试"); }}>
      <p>{cell.key} · {cell.label}</p><p>固定样本 <code>{cell.itemId}</code></p><p>原最新尝试 {cell.latestAttemptId ? <code>{cell.latestAttemptId}</code> : "尚无"}</p>
      <p className="kb-warning">这是新的候选模型尝试 可能产生实际费用 不用于恢复原提交 未知结果先按原 ID 核对</p>
      <fieldset disabled={action.locked}><label className="kb-checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已核对原样本及最新尝试 明确开始这一次新的付费调用</label>
        <button className="oc-button primary" disabled={!confirmed}>确认本题新的付费尝试</button></fieldset></form>
    <BenchmarkMutationFeedback action={action} onDone={id => exit.dismiss(() => onDone(id))} doneLabel="读取实际原尝试与结果" /></div>
  </TaskDrawer>;
}
function AttemptReview({ scope, attempt, onChanged }: { scope: BenchmarkScope; attempt: BenchmarkAttempt; onChanged(): void }) {
  const [previousId] = useState(attempt.review?.id ?? null), [decision, setDecision] = useState("needs_review"), [minutes, setMinutes] = useState("");
  const [hourly, setHourly] = useState(""), [reason, setReason] = useState(""), action = useBenchmarkMutation(scope);
  return <section aria-label="登记本次人工核验"><form className="kb-form" aria-label="本次人工核验与实际分钟" onSubmit={event => { event.preventDefault();
    const input = ReviewBenchmarkAttemptSchema.safeParse({ expectedReviewId: previousId, decision, minutes, hourlyUsd: hourly === "" ? null : hourly, reason, requestId: crypto.randomUUID() });
    if (input.success) void action.submit("attempts/" + attempt.id + "/review", input.data); else action.invalid("请核对实际分钟 小时费率或未知 结论与原评分依据"); }}>
    <h4>登记本次人工核验与耗时</h4><p>原评分 <code>{attempt.assessment?.id}</code> · 人工通过不能覆盖硬失败</p>
    <fieldset disabled={action.locked}><label>实际人工结论<select aria-label="实际人工结论" value={decision} onChange={event => setDecision(event.target.value)}><option value="needs_review">仍需补充核验</option><option value="pass">已核对事实和引用 通过</option><option value="fail">事实或引用不通过</option></select></label>
      <label>本次实际核验分钟<input required inputMode="decimal" value={minutes} onChange={event => setMinutes(event.target.value)} /></label><label>本次小时费率 USD 未知留空<input inputMode="decimal" value={hourly} onChange={event => setHourly(event.target.value)} /></label>
      <label>事实核验与耗时依据<textarea aria-label="事实核验与耗时依据" required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button className="oc-button primary">追加本次人工核验记录</button></fieldset></form>
    <BenchmarkMutationFeedback action={action} onDone={onChanged} doneLabel="确认原核验回执并重读" /></section>;
}
