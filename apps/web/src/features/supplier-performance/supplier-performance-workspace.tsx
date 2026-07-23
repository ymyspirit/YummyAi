import type {
  SupplierKpiMetric,
  SupplierPerformanceWorkspaceView,
  SupplierScorecardRunView,
} from "@yummyai/contracts/supplier-performance";
import {
  ChartNoAxesCombined,
  CircleAlert,
  CircleCheck,
  ClipboardCheck,
  FileCheck2,
  Gauge,
} from "lucide-react";

const metricOrder: SupplierKpiMetric[] = [
  "quality",
  "on_time_delivery",
  "price_variance",
  "response_time",
  "acceptance",
  "cancellation",
  "capacity_adherence",
];

export function SupplierPerformanceWorkspace({
  data,
}: {
  data: SupplierPerformanceWorkspaceView;
}) {
  const supplierById = new Map(data.suppliers.map((supplier) => [supplier.id, supplier]));
  const latestBySupplier = new Map<string, SupplierScorecardRunView>();
  for (const scorecard of data.scorecards) {
    if (!latestBySupplier.has(scorecard.supplierId)) latestBySupplier.set(scorecard.supplierId, scorecard);
  }
  const latest = data.scorecards[0];
  const completeCount = data.scorecards.filter((scorecard) => scorecard.status === "complete").length;
  const incompleteCount = data.scorecards.length - completeCount;

  return (
    <>
      <section className="supplier-performance-ruler" aria-label="最新供应商绩效标尺">
        <div className="supplier-ruler-total">
          <Gauge size={19} />
          <span><small>LATEST SCORE</small><strong>{latest?.overallScoreBps === null || !latest ? "缺证据" : formatBps(latest.overallScoreBps)}</strong></span>
        </div>
        <div className="supplier-ruler-metrics">
          {metricOrder.map((metric) => {
            const value = latest?.metrics.find((entry) => entry.metric === metric)?.scoreBps ?? null;
            return (
              <div className={toneClass(value)} key={metric}>
                <small>{metricLabel(metric)}</small>
                <b>{value === null ? "—" : formatBps(value)}</b>
              </div>
            );
          })}
        </div>
        <div className={`supplier-ruler-state state-${latest?.status ?? "empty"}`}>
          {latest?.status === "complete" ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          <span><b>{latest?.status === "complete" ? "评分完整" : "等待完整样本"}</b>{latest ? diagnosticSummary(latest) : "尚未生成供应商评分"}</span>
        </div>
      </section>

      <section className="supplier-performance-signals" aria-label="供应商绩效摘要">
        <Signal code="SUPPLIERS" label="供应商" value={data.suppliers.length} />
        <Signal code="DEFINITIONS" label="KPI 定义" value={data.definitions.length} />
        <Signal code="COMPLETE" label="完整评分" value={completeCount} tone="green" />
        <Signal code="INCOMPLETE" label="待补样本" value={incompleteCount} tone="amber" />
      </section>

      <section className="supplier-performance-panel" aria-labelledby="supplier-scorecards-title">
        <PanelHeader code="VERSIONED SCORECARDS" title="供应商评分记录" detail={`${data.scorecards.length} 次不可变计算`} id="supplier-scorecards-title" />
        {data.suppliers.length ? (
          <div className="supplier-performance-table-scroll">
            <table className="supplier-performance-table supplier-scorecard-table">
              <thead><tr><th>供应商</th><th>状态</th><th>总分</th><th>定义版本</th><th>窗口</th><th>诊断</th><th>计算时间</th></tr></thead>
              <tbody>
                {data.suppliers.map((supplier) => {
                  const scorecard = latestBySupplier.get(supplier.id);
                  return (
                    <tr key={supplier.id}>
                      <td><strong>{supplier.name}</strong><span>{supplier.kind} · {supplier.regionCode}</span></td>
                      <td>{scorecard ? <Status scorecard={scorecard} /> : <span className="supplier-status status-empty">未评分</span>}</td>
                      <td><b className="supplier-score">{scorecard?.overallScoreBps === null || !scorecard ? "—" : formatBps(scorecard.overallScoreBps)}</b></td>
                      <td>{scorecard ? <span>V{scorecard.definitionVersion}<code>{shortId(scorecard.definitionVersionId)}</code></span> : "—"}</td>
                      <td>{scorecard ? <><time dateTime={scorecard.windowStart}>{formatDate(scorecard.windowStart)}</time><span>至 {formatDate(scorecard.windowEnd)}</span></> : "—"}</td>
                      <td>{scorecard ? diagnosticSummary(scorecard) : "尚无固定窗口评分"}</td>
                      <td>{scorecard ? <time dateTime={scorecard.calculatedAt}>{formatDateTime(scorecard.calculatedAt)}</time> : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <InlineEmpty message="还没有供应商；供应商进入履约体系后才会生成绩效档案。" />}
      </section>

      <section className="supplier-performance-panel" aria-labelledby="supplier-evidence-title">
        <PanelHeader code="EVIDENCE MATRIX" title="最新 KPI 证据矩阵" detail={latest ? supplierById.get(latest.supplierId)?.name ?? shortId(latest.supplierId) : "暂无评分"} id="supplier-evidence-title" />
        {latest ? (
          <div className="supplier-performance-table-scroll">
            <table className="supplier-performance-table supplier-evidence-table">
              <thead><tr><th>KPI</th><th>分数</th><th>样本</th><th>原始比值</th><th>证据引用</th></tr></thead>
              <tbody>
                {metricOrder.map((metric) => {
                  const entry = latest.metrics.find((item) => item.metric === metric)!;
                  return (
                    <tr key={metric}>
                      <td><span className="supplier-metric-name">{metricLabel(metric)}</span></td>
                      <td><b className={toneClass(entry.scoreBps)}>{entry.scoreBps === null ? "缺失" : formatBps(entry.scoreBps)}</b></td>
                      <td><b className="supplier-sample">{entry.sampleCount}</b></td>
                      <td><code>{entry.rawNumerator} / {entry.rawDenominator}</code><span>{rawUnitLabel(entry.rawUnit)}</span></td>
                      <td><b>{entry.evidenceReferences.length}</b><span>条固定证据</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <InlineEmpty message="建立 KPI 定义并运行评分后，这里会显示每项指标的原始证据。" />}
      </section>

      <div className="supplier-performance-columns">
        <section className="supplier-performance-panel" aria-labelledby="supplier-diagnostics-title">
          <PanelHeader code="COMPLETENESS" title="样本完整性" detail={`${incompleteCount} 次待补齐`} id="supplier-diagnostics-title" />
          {data.scorecards.filter((scorecard) => scorecard.status === "incomplete").length ? (
            <ol className="supplier-diagnostic-list">
              {data.scorecards.filter((scorecard) => scorecard.status === "incomplete").slice(0, 8).map((scorecard) => (
                <li key={scorecard.id}>
                  <CircleAlert size={15} />
                  <div><strong>{supplierById.get(scorecard.supplierId)?.name ?? shortId(scorecard.supplierId)}</strong><span>{diagnosticSummary(scorecard)}</span></div>
                  <code>{shortId(scorecard.id)}</code>
                </li>
              ))}
            </ol>
          ) : <InlineEmpty icon="check" message="现有评分均满足固定定义的最小样本要求。" />}
        </section>

        <section className="supplier-performance-panel" aria-labelledby="supplier-definitions-title">
          <PanelHeader code="PINNED DEFINITIONS" title="KPI 口径" detail={`${data.definitions.length} 个定义`} id="supplier-definitions-title" />
          {data.definitions.length ? (
            <ol className="supplier-definition-list">
              {data.definitions.map((definition) => (
                <li key={definition.id}>
                  <FileCheck2 size={15} />
                  <div><strong>{definition.name}</strong><span>{missingPolicyLabel(definition.version.missingDataPolicy)} · 7 项 KPI · 权重 100%</span></div>
                  <b>V{definition.currentVersion}</b>
                </li>
              ))}
            </ol>
          ) : <InlineEmpty message="还没有版本化 KPI 定义。" />}
        </section>
      </div>
    </>
  );
}

function Signal({ code, label, value, tone = "navy" }: { code: string; label: string; value: number; tone?: "navy" | "green" | "amber" }) {
  return <div className={`supplier-performance-signal signal-${tone}`}><small>{code}</small><strong>{label}</strong><b>{value}</b></div>;
}

function PanelHeader({ code, title, detail, id }: { code: string; title: string; detail: string; id: string }) {
  return <header><div><p className="section-code">{code}</p><h2 id={id}>{title}</h2></div><span>{detail}</span></header>;
}

function Status({ scorecard }: { scorecard: SupplierScorecardRunView }) {
  return <span className={`supplier-status status-${scorecard.status}`}>{scorecard.status === "complete" ? <CircleCheck size={13} /> : <CircleAlert size={13} />}{scorecard.status === "complete" ? "完整" : "缺样本"}</span>;
}

function InlineEmpty({ message, icon = "alert" }: { message: string; icon?: "alert" | "check" }) {
  return <p className="supplier-performance-empty">{icon === "check" ? <ClipboardCheck size={15} /> : <ChartNoAxesCombined size={15} />}{message}</p>;
}

function diagnosticSummary(scorecard: SupplierScorecardRunView) {
  const parts = [];
  if (scorecard.diagnostics.missingMetrics.length) parts.push(`缺 ${scorecard.diagnostics.missingMetrics.map(metricLabel).join("、")}`);
  if (scorecard.diagnostics.insufficientSampleMetrics.length) parts.push(`样本不足 ${scorecard.diagnostics.insufficientSampleMetrics.map(metricLabel).join("、")}`);
  return parts.join("；") || "七项 KPI 样本完整";
}

function metricLabel(metric: SupplierKpiMetric) {
  return ({
    quality: "质量",
    on_time_delivery: "准时交付",
    price_variance: "价格准确",
    response_time: "响应时效",
    acceptance: "订单接受",
    cancellation: "履约稳定",
    capacity_adherence: "产能履约",
  })[metric];
}

function rawUnitLabel(unit: SupplierScorecardRunView["metrics"][number]["rawUnit"]) {
  return ({ weighted_bps: "加权质量分", sample_ratio: "达标样本比", money_ratio: "价格准确值比", unit_ratio: "按时完成数量比" })[unit];
}

function missingPolicyLabel(policy: "exclude" | "zero" | "incomplete") {
  return ({ exclude: "缺失项重分配权重", zero: "缺失项按零计入", incomplete: "缺失项阻止总分" })[policy];
}

function toneClass(score: number | null) {
  if (score === null) return "tone-missing";
  if (score >= 9_000) return "tone-strong";
  if (score >= 7_500) return "tone-watch";
  return "tone-risk";
}

function formatBps(value: number) {
  return `${(value / 100).toFixed(1)}%`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}
