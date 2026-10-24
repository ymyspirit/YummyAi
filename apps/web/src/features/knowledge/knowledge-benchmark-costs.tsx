"use client";
import { useState } from "react";
import { BenchmarkCostSummarySchema, BenchmarkReportPageSchema, BenchmarkReportSchema, RecordBenchmarkExpenseSchema, CreateBenchmarkReportSchema,
  type BenchmarkArmCost, type BenchmarkCostSummary, type BenchmarkReport, type BenchmarkExpense } from "@yummyai/contracts/knowledge/benchmark";
import { TaskDrawer, TaskDrawerActions } from "../navigation/task-drawer";
import { useBenchmarkRead, useBenchmarkPage, useBenchmarkMutation, useBenchmarkDismiss, localBenchmarkTime, benchmarkInstant, type BenchmarkScope } from "./knowledge-benchmark-client";
import { BenchmarkPairs, BenchmarkPair, BenchmarkMutationFeedback, BenchmarkPager } from "./knowledge-benchmark-dataset";

export function BenchmarkArmCostView({ value }: { value: BenchmarkArmCost }) {
  const money = (amount: string | null) => amount === null ? "未知 未按零补齐" : "USD " + amount;
  return <section className="kb-benchmark-section" aria-label={value.arm === "baseline" ? "规则基线全部尝试成本" : "候选全部尝试成本"}>
    <h4>{value.arm === "baseline" ? "规则基线" : "候选模型"} · {{ complete: "成本已完整核对", estimated: "含费用估算", incomplete: "成本尚不完整" }[value.state]}</h4>
    <BenchmarkPairs><BenchmarkPair label="固定题数 / 合格题数">{value.totalItems} / {value.qualifiedItems}</BenchmarkPair>
      <BenchmarkPair label="全部尝试">{value.allAttempts} · 尚未运行 {value.notRunItems} · 待人工 {value.pendingReviewItems} · 硬失败 {value.hardFailedItems}</BenchmarkPair>
      <BenchmarkPair label="外部与本地尝试">确认提供方调用 {value.confirmedProviderCalls} · 可能调用 {value.possibleProviderCalls} · 本地处理 {value.localProcessingAttempts}</BenchmarkPair>
      <BenchmarkPair label="累计实际人工分钟">{value.reviewMinutes}</BenchmarkPair>
      <BenchmarkPair label="已知模型费用">{money(value.modelKnownUsd)}</BenchmarkPair><BenchmarkPair label="已知人工费用">{money(value.humanKnownUsd)}</BenchmarkPair>
      <BenchmarkPair label="已知存储 / 维护">{money(value.storageKnownUsd)} / {money(value.maintenanceKnownUsd)}</BenchmarkPair>
      <BenchmarkPair label="已知费用部分">{money(value.knownSubtotalUsd)} · 不自动当作完整成本</BenchmarkPair>
      <BenchmarkPair label="服务端核对的完整总额">{money(value.totalUsd)}</BenchmarkPair>
      <BenchmarkPair label="确定单位合格成本">{value.unitQualifiedCostUsd !== null ? money(value.unitQualifiedCostUsd) : value.qualifiedItems === 0 ? "无合格产出 不计算" : "当前依据不足 不显示确定值"}</BenchmarkPair>
      <BenchmarkPair label="估算单位合格成本">{value.estimatedUnitQualifiedCostUsd === null ? "没有可展示的估算值" : money(value.estimatedUnitQualifiedCostUsd) + " · 仅估算"}</BenchmarkPair>
    </BenchmarkPairs>{value.missing.length > 0 && <ul className="kb-warning" aria-label="成本缺口">{value.missing.map((text, index) => <li key={index}>{text}</li>)}</ul>}
    <details className="kb-benchmark-details"><summary>核对成本覆盖的活动指纹</summary><code>{value.activityFingerprint}</code></details>
    <p className="kb-meta">全部失败和旧尝试成本也保留 不与预算预留相加 不以本地重试数冒充付费调用数 合格按每题最新实际尝试及硬检查 人工核验决定</p>
  </section>;
}
export function BenchmarkCostSummaryView({ value }: { value: BenchmarkCostSummary }) {
  return <section aria-label="服务端全部尝试成本"><p>核对截止 {value.asOf} · 成本口径 {value.policyVersion} · {value.currency}</p>
    <div className="kb-benchmark-columns"><BenchmarkArmCostView value={value.baseline} /><BenchmarkArmCostView value={value.candidate} /></div></section>;
}
export function BenchmarkReportView({ value }: { value: BenchmarkReport }) {
  const groups = [["原尝试 ID", value.attemptIds], ["原评分 ID", value.assessmentIds], ["原人工核验 ID", value.reviewIds], ["原存储维护声明 ID", value.expenseIds], ["原账单补证 ID", value.billingReceiptIds]] as const;
  return <section aria-label="不可变实验报告"><h3>原封存报告 · 序号 {value.sequence}</h3><BenchmarkPairs>
    <BenchmarkPair label="原报告 / 原实验"><code>{value.id}</code><br /><code>{value.experimentId}</code></BenchmarkPair>
    <BenchmarkPair label="原数据集版本"><code>{value.datasetVersionId}</code></BenchmarkPair><BenchmarkPair label="封存时间">{value.createdAt}</BenchmarkPair>
    <BenchmarkPair label="原数据集校验值"><code>{value.datasetChecksum}</code></BenchmarkPair><BenchmarkPair label="报告清单校验值"><code>{value.manifestChecksum}</code></BenchmarkPair>
    <BenchmarkPair label="规则 / 评分版本">{value.baselineVersion}<br />{value.graderVersion}</BenchmarkPair></BenchmarkPairs>
    <p className="kb-meta">以下是原封存截止的结果 不用今天新增的尝试或费用覆盖旧报告 后续核对需另封存新报告</p>
    <BenchmarkCostSummaryView value={value.summary} />{groups.map(([label, ids]) => <details key={label} className="kb-benchmark-details"><summary>{label} · {ids.length} 条</summary>
      {ids.length ? <ul>{ids.map(id => <li key={id}><code>{id}</code></li>)}</ul> : <p>原清单为零条 不据此补造费用或核验</p>}</details>)}
  </section>;
}
export function KnowledgeBenchmarkCosts({ scope, experimentId, experimentCreatedAt, revision }: { scope: BenchmarkScope; experimentId: string; experimentCreatedAt: string; revision: number }) {
  const costs = useBenchmarkRead("experiments/" + experimentId + "/costs", BenchmarkCostSummarySchema, scope, experimentId, revision);
  const reports = useBenchmarkPage("experiments/" + experimentId + "/reports", BenchmarkReportPageSchema, scope);
  const [expenseArm, setExpenseArm] = useState<"baseline" | "candidate" | null>(null), [reportId, setReportId] = useState(""), [reportDraft, setReportDraft] = useState("");
  const [reason, setReason] = useState(""), seal = useBenchmarkMutation(scope);
  const report = useBenchmarkRead(reportId ? "reports/" + reportId : null, BenchmarkReportSchema, scope, reportId);
  return <section className="kb-benchmark-section" aria-label="实验成本与封存报告"><h3>全部尝试成本与封存报告</h3>
    <button className="oc-button" disabled={costs.reading} onClick={costs.reload}>重新读取全部成本依据</button>
    {costs.reading && <p role="status">正在重新核对全部尝试和成本 旧摘要暂不显示</p>}{costs.error && <p className="kb-error" role="alert">{costs.error}</p>}
    {costs.data && <><BenchmarkCostSummaryView value={costs.data} />{scope.canApprove && <div className="kb-inline-actions">
      <button className="oc-button" onClick={() => setExpenseArm("baseline")}>登记规则基线累计存储维护</button><button className="oc-button" onClick={() => setExpenseArm("candidate")}>登记候选累计存储维护</button></div>}
      <details className="kb-benchmark-details"><summary>当前最新累计声明及覆盖</summary>{costs.data.latestExpenses.length ? costs.data.latestExpenses.map(expense => <p key={expense.id}>
        {expense.arm === "baseline" ? "规则基线" : "候选"} · 声明序号 {expense.sequence}<br /><code>{expense.id}</code><br />{expense.periodStart} 至 {expense.periodEnd}<br />{expense.allocationBasis}<br />
        {expense.activityFingerprint === costs.data![expense.arm].activityFingerprint ? "覆盖本次已读活动" : "已有新增尝试或人工核验 原声明覆盖失效 需重新核对累计值"}</p>) : <p>尚无累计存储维护声明 保持未知</p>}</details>
    </>}
    {scope.canApprove && <form className="kb-form" aria-label="封存实验报告" onSubmit={event => { event.preventDefault();
      const input = CreateBenchmarkReportSchema.safeParse({ reason, requestId: crypto.randomUUID() });
      if (input.success) void seal.submit("experiments/" + experimentId + "/reports", input.data); else seal.invalid("请填写本次封存依据"); }}>
      <fieldset disabled={seal.locked}><label>报告封存依据<textarea aria-label="报告封存依据" required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <p className="kb-meta">可以如实封存未完成或含未知费用的现状 不把封存动作当作实验通过或业务发布</p><button className="oc-button primary">明确封存本次实验报告</button></fieldset></form>}
    <BenchmarkMutationFeedback action={seal} onDone={id => { setReportId(id); reports.reset(); }} doneLabel="读取实际封存报告" />
    <h4>全部封存版本</h4><BenchmarkPager page={reports} label="实验报告" /><ul className="kb-benchmark-list">{reports.data?.items.map(item => <li key={item.id}><p>报告 {item.sequence} · {item.createdAt}<br /><code>{item.id}</code></p><button className="oc-button" onClick={() => setReportId(item.id)}>读取原报告 {item.id.slice(-8)}</button></li>)}</ul>
    <form className="kb-benchmark-inline" aria-label="按原报告 ID 读取" onSubmit={event => { event.preventDefault(); setReportId(reportDraft.trim()); }}><label>原报告 ID<input value={reportDraft} onChange={event => setReportDraft(event.target.value)} /></label><button className="oc-button" disabled={!reportDraft.trim()}>读取原封存报告</button></form>
    {report.error && <p className="kb-error" role="alert">{report.error}</p>}{report.data && <BenchmarkReportView value={report.data} />}
    {expenseArm && costs.data && <ExpenseEditor key={expenseArm} scope={scope} experimentId={experimentId} experimentCreatedAt={experimentCreatedAt} arm={costs.data[expenseArm]} previous={costs.data.latestExpenses.find(item => item.arm === expenseArm) ?? null}
      onClose={() => setExpenseArm(null)} onDone={() => { setExpenseArm(null); costs.reload(); }} />}
  </section>;
}

function ExpenseEditor({ scope, experimentId, experimentCreatedAt, arm, previous, onClose, onDone }: { scope: BenchmarkScope; experimentId: string; experimentCreatedAt: string; arm: BenchmarkArmCost; previous: BenchmarkExpense | null; onClose(): void; onDone(): void }) {
  const [basis] = useState(() => ({ fingerprint: arm.activityFingerprint, previousId: previous?.id ?? null }));
  const [storage, setStorage] = useState(previous?.storageUsd ?? ""), [maintenance, setMaintenance] = useState(previous?.maintenanceUsd ?? "");
  const [start, setStart] = useState(() => localBenchmarkTime(previous?.periodStart ?? experimentCreatedAt)), [end, setEnd] = useState(() => localBenchmarkTime(new Date().toISOString()));
  const [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false), action = useBenchmarkMutation(scope);
  const exit = useBenchmarkDismiss(scope, onClose);
  const stale = basis.fingerprint !== arm.activityFingerprint;
  return <TaskDrawer title="登记累计存储维护成本" state={{ dirty: !action.receipt && !exit.closing, busy: action.busy, loading: false }} onClose={() => exit.dismiss()}
    footer={<TaskDrawerActions><button className="oc-button" disabled={action.busy || exit.closing} onClick={() => { if (action.receipt || window.confirm("关闭将清除本页费用填写 原编号仍可查回执")) exit.dismiss(); }}>关闭成本填写</button>
      <button className="oc-button primary" form="kb-benchmark-expense" type="submit" disabled={action.locked || stale || !confirmed || exit.closing}>登记原活动的累计成本</button></TaskDrawerActions>}>
    <div className="kb-benchmark" data-benchmark-closing={exit.closing} inert={exit.closing}>
    <form id="kb-benchmark-expense" className="kb-form kb-benchmark" aria-label="登记累计存储维护成本" onSubmit={event => { event.preventDefault();
      try { const input = RecordBenchmarkExpenseSchema.safeParse({ arm: arm.arm, expectedExpenseId: basis.previousId, expectedActivityFingerprint: basis.fingerprint,
        storageUsd: storage === "" ? null : storage, maintenanceUsd: maintenance === "" ? null : maintenance, periodStart: benchmarkInstant(start), periodEnd: benchmarkInstant(end), allocationBasis: reason, confirmedActual: confirmed, requestId: crypto.randomUUID() });
        if (input.success && !stale) void action.submit("experiments/" + experimentId + "/expenses", input.data); else action.invalid("请核对累计成本 期间 活动指纹与实际分摊依据");
      } catch { action.invalid("请选择完整有效的成本归属期间"); } }}>
      <p>{arm.arm === "baseline" ? "规则基线" : "候选"} · 本次固定活动 <code>{basis.fingerprint}</code></p>
      <p className="kb-meta">填写覆盖本次活动的累计替代值 不是本次增量 空白表示未知 只有实际核对确为零才输入 0 声明是操作者记录 不等于提供方账单 API 验真</p>
      {stale && <p role="alert" className="kb-warning">活动已经变化 未提交填写需关闭后重读 不自动改绑 若原请求已发仍按原正文核对</p>}
      <fieldset disabled={action.locked || stale}><label>累计存储费用 USD<input inputMode="decimal" value={storage} onChange={event => setStorage(event.target.value)} /></label>
        <label>累计维护费用 USD<input inputMode="decimal" value={maintenance} onChange={event => setMaintenance(event.target.value)} /></label>
        <label>成本期间开始 本机当地时间<input type="datetime-local" step="0.001" required value={start} onChange={event => setStart(event.target.value)} /></label>
        <label>成本期间结束 本机当地时间<input type="datetime-local" step="0.001" required value={end} onChange={event => setEnd(event.target.value)} /></label>
        <label>实际累计分摊依据<textarea aria-label="实际累计分摊依据" required maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} /></label>
        <label className="kb-checkbox"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我已按上述活动和期间核对累计存储维护值 未知项保持空白</label></fieldset>
    </form><BenchmarkMutationFeedback action={action} onDone={() => exit.dismiss(onDone)} doneLabel="确认成本登记回执并重读摘要" /></div>
  </TaskDrawer>;
}
