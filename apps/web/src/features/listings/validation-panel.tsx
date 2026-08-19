import type { ListingValidation } from "@yummyai/platform-rules";
import { AlertTriangle, CheckCircle2, CircleAlert, ShieldCheck } from "lucide-react";

export function ValidationPanel({ validation, ruleVersion }: { validation: ListingValidation; ruleVersion: string }) {
  return (
    <aside className="listing-validation" aria-labelledby="validation-title">
      <header><p className="section-code">LIVE VALIDATION</p><h2 id="validation-title">刊登健康度</h2><span className="listing-score">{validation.completeness}<small>%</small></span></header>
      <div className="score-track" aria-label={`完整度 ${validation.completeness}%`}><span style={{ width: `${validation.completeness}%` }} /></div>
      <section><h3><CircleAlert size={15} />阻断项 <b>{validation.blockers.length}</b></h3>{validation.blockers.map((issue) => <article className="validation-blocker" key={`${issue.code}-${issue.path}`}><code>{issue.path}</code><p>{issue.message}</p></article>)}{!validation.blockers.length && <p className="validation-clear"><CheckCircle2 size={15} />没有阻断项</p>}</section>
      <section><h3><AlertTriangle size={15} />建议 <b>{validation.warnings.length}</b></h3>{validation.warnings.map((issue) => <article className="validation-warning" key={`${issue.code}-${issue.path}`}><code>{issue.path}</code><p>{issue.message}</p></article>)}</section>
      <footer><ShieldCheck size={15} /><div><span>RULESET</span><strong>{ruleVersion}</strong></div></footer>
    </aside>
  );
}
