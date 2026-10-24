import type { ReactNode } from "react";
import type { KnowledgeEvaluationReport } from "@yummyai/contracts/knowledge/governance";
import type { KnowledgeEvaluationComparison } from "@yummyai/contracts/knowledge/evaluation-read";
import { KnowledgeAnswer } from "./knowledge-shared";

function Pin({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}
export function EvaluationChecks({ report }: { report: KnowledgeEvaluationReport }) {
  const recorded = report.assessmentState === "recorded" && report.assessment != null;
  const checks = recorded ? report.assessment!.checks : report.checks;
  return <section className="kb-eval-report" aria-label="原评测断言与封存评分">
    <h4>{recorded ? "原完成事务已封存评分" : report.assessmentState === "awaiting_result" ? "结果尚未完成 尚无封存评分" :
      report.assessmentState === "unavailable" ? "原评分依据当前不可核对" : "历史记录未保留封存评分"}</h4>
    <p className="kb-meta">{recorded ? "以下为原完成时保存的确定性断言 不因原正文后来到期而重算或降为等待" :
      "以下兼容检查不冒充历史封存评分 不据此计算同样本优劣或合格率"}</p>
    {report.assessmentState === "recorded" && !report.assessment && <p className="kb-error" role="alert">封存评分正文缺失 未用当前检查补造原评分</p>}
    {report.assessment && <dl className="kb-evaluation-pins">
      <Pin label="封存评分 ID"><code>{report.assessment.id}</code></Pin><Pin label="原输出校验值"><code>{report.assessment.outputChecksum}</code></Pin>
      <Pin label="封存时间">{report.assessment.createdAt}</Pin><Pin label="评分依据指纹"><code>{report.assessment.basisFingerprint}</code></Pin>
    </dl>}
    <dl>{checks.map(check => <div key={check.key}><dt>{check.label} · {{ pass: "断言通过", fail: "断言未通过", pending: "未有完成依据" }[check.status]}</dt>
      <dd className={check.status === "fail" ? "kb-warning" : "kb-meta"}>{check.detail}</dd></div>)}</dl>
    <p className="kb-meta">确定性短语和引用断言不等于事实正确 人工核验 {report.manualReviews.length ? "已有独立记录" : "尚未记录"}</p>
  </section>;
}
export function KnowledgeEvaluationReportView({ report, label = "原评测运行" }: { report: KnowledgeEvaluationReport; label?: string }) {
  const protocol = report.protocol, method = report.answer.methodSelection, invocation = report.answer.invocations?.[0];
  return <section className="kb-evaluation-result" aria-label={label}>
    <h3>{label}</h3><dl className="kb-evaluation-pins">
      <Pin label="原评测运行 ID"><code>{report.id}</code></Pin><Pin label="原问题 ID"><code>{report.caseId}</code></Pin>
      <Pin label="登记时间">{report.createdAt}</Pin><Pin label="实际回答运行 ID"><code>{report.answer.id}</code></Pin>
      <Pin label="原模型">{report.answer.modelLabel} · {report.answer.model}</Pin><Pin label="原提示词版本">{report.answer.promptVersion}</Pin>
      <Pin label="完整原输入指纹"><code>{report.answer.inputFingerprint}</code></Pin><Pin label="原断言版本"><code>{report.assertionVersion}</code></Pin>
    </dl>
    {protocol ? <details className="kb-evaluation-details"><summary>核对原问题修订与固定执行依据</summary><dl className="kb-evaluation-pins">
      <Pin label="评测协议">{protocol.version}</Pin><Pin label="固定问题修订">V{protocol.caseRevision}</Pin>
      <Pin label="原读取范围">{protocol.dataScope}</Pin>
      <Pin label="原问题校验值"><code>{protocol.caseChecksum}</code></Pin><Pin label="原请求校验值"><code>{protocol.requestChecksum}</code></Pin>
      <Pin label="同样本依据指纹"><code>{protocol.basisFingerprint}</code></Pin><Pin label="原模型配置 ID"><code>{protocol.modelId}</code></Pin>
      <Pin label="协议登记时间">{protocol.createdAt}</Pin>
    </dl></details> : <p className="kb-warning">旧运行没有原评测协议 不以今天的问题修订 模型或方法补填历史</p>}
    {method ? <details className="kb-evaluation-details"><summary>核对原方法与调用身份</summary><dl className="kb-evaluation-pins">
      <Pin label="原方法">{method.methodKey} · {method.mode === "published" ? "发布版本 V" + method.version : "内置方法"}</Pin>
      <Pin label="原执行契约校验值"><code>{method.contractChecksum}</code></Pin>
      {method.mode === "published" && <><Pin label="原方法版本 ID"><code>{method.versionId}</code></Pin><Pin label="原方法版本校验值"><code>{method.checksum}</code></Pin></>}
      <Pin label="原调用记录">{invocation ? <code>{invocation.id}</code> : "未保留调用身份"}</Pin>
      {invocation?.model && <><Pin label="原调用模型标识"><code>{invocation.model.key}</code></Pin><Pin label="原模型版本">{invocation.model.version ?? "原记录未保留"}</Pin></>}
    </dl><p className="kb-meta">模型显示名称相同不代表固定路由相同 缺失信息保持未知</p></details> : <p className="kb-meta">此运行未保留方法选择 不从当前配置反推</p>}
    <EvaluationChecks report={report} />
    <section className="kb-evaluation-availability" aria-label="当前原回答可读状态"><h4>当前原回答与依据</h4>
      {report.answer.stale ? <p className="kb-warning">当前正文或依据状态已变化 原封存评分独立保留 不自动改源重跑</p> :
        report.answer.status === "completed" && report.answer.result === null ? <p className="kb-warning">当前原回答正文不可读 原身份和封存评分独立保留 不伪造新回答</p> :
          <p className="kb-meta">以下为本次受权读取的原回答 运行状态与原封存评分分别核对</p>}
      <KnowledgeAnswer view={report.answer} />
    </section>
    <details className="kb-evaluation-details"><summary>核对该次完整固定问题与断言</summary>
      <h4>{report.caseSnapshot.label}</h4><p className="kb-prose">{report.caseSnapshot.search.query}</p>
      <p className="kb-meta">{report.caseSnapshot.search.platform} / {report.caseSnapshot.search.market} / {report.caseSnapshot.search.topic} · {report.caseSnapshot.expectRefusal ? "要求无依据时拒答" : "未要求一律拒答"}</p>
      <p className="kb-meta">原 SPU 范围 {report.caseSnapshot.search.spuIds.length ? report.caseSnapshot.search.spuIds.join(" · ") : "未指定 SPU"}</p>
      <h4>原期望事实</h4>{report.caseSnapshot.expectedFacts.length ? <ul>{report.caseSnapshot.expectedFacts.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>该次没有登记期望事实 不填充默认断言</p>}
      <h4>原禁止表述</h4>{report.caseSnapshot.forbiddenClaims.length ? <ul>{report.caseSnapshot.forbiddenClaims.map((text, index) => <li key={index}>{text}</li>)}</ul> : <p>该次没有登记禁止表述</p>}
      <h4>原必需知识卡 ID</h4>{report.caseSnapshot.requiredEntryIds.length ? <ul>{report.caseSnapshot.requiredEntryIds.map(id => <li key={id}><code>{id}</code></li>)}</ul> : <p>未定义必需来源 不作为来源完整的证明</p>}
    </details>
    <section aria-label="原评测人工核验记录"><h4>人工事实核验</h4>
      {report.manualReviews.length ? report.manualReviews.map((review, index) => <p className="kb-prose" key={index}>
        {{ pass: "通过", fail: "未通过", needs_review: "待补证据" }[review.result]} · {review.reason} · {review.createdAt}</p>) : <p className="kb-meta">尚无独立人工核验 不把断言通过当作事实已批准</p>}
      <p className="kb-meta">本记录未包含人工复核分钟 存储维护及所有尝试成本 不据此计算单位合格成本</p>
    </section>
  </section>;
}
export function KnowledgeEvaluationComparisonView({ value }: { value: KnowledgeEvaluationComparison }) {
  return <section className="kb-evaluation-comparison" aria-label="两次原运行的受权比较">
    <h3>{value.comparable ? "原同样本依据可比" : "原依据不满足同样本比较"}</h3>
    {value.reasons.length > 0 && <ul className="kb-warning">{value.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    <p className="kb-meta">按明确选择的两个原运行读取 不重跑模型 不替换知识 不从最近两条或另一正文拼接比较 这不是完整多题数据集或规则基线验收</p>
    <div className="kb-diff-values"><KnowledgeEvaluationReportView report={value.baseline} label="基线原评测" /><KnowledgeEvaluationReportView report={value.candidate} label="候选原评测" /></div>
  </section>;
}
