import type { AnalysisReport } from "@yummyai/contracts";
import { Coins, Cpu, GitCompareArrows, Layers3 } from "lucide-react";

import { ComparisonMatrix } from "./comparison-matrix";
import { EvidencePanel } from "./evidence-panel";
import { ReportDiff } from "./report-diff";

export function AnalysisReportView({ report, versions }: { report: AnalysisReport; versions: AnalysisReport[] }) {
  return (
    <>
      <header className="analysis-hero">
        <div><p className="kicker">{report.taskType} / EVIDENCE REPORT</p><h1>{report.title}</h1><p>{report.executiveSummary}</p></div>
        <div className="version-stamp"><span>当前版本</span><strong>V{report.version}</strong><small>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(report.createdAt))}</small></div>
      </header>
      <section className="report-ledger" aria-label="模型与版本元数据">
        <div><Cpu size={16} /><span>模型路由</span><strong>{report.model.modelKey}</strong><small>{report.model.providerId}</small></div>
        <div><Coins size={16} /><span>本次成本</span><strong className="mono">${report.model.costUsd.toFixed(4)}</strong><small>USD</small></div>
        <div><Layers3 size={16} /><span>输入快照</span><strong className="mono">{report.inputSnapshotIds.length}</strong><small>固定版本</small></div>
        <div><GitCompareArrows size={16} /><span>提示模板</span><strong className="mono">{report.promptTemplateVersion}</strong><small>可复现</small></div>
      </section>
      <ReportDiff versions={versions} />
      <EvidencePanel sections={report.sections} />
      {report.comparison && <ComparisonMatrix rows={report.comparison} />}
    </>
  );
}
