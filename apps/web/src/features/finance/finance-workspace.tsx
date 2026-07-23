import type {
  FinanceFactType,
  FinanceProfitRunView,
  FinanceWorkspaceView,
} from "@yummyai/contracts/finance";
import {
  ArrowDownRight,
  ArrowRight,
  BadgeDollarSign,
  Banknote,
  CircleAlert,
  CircleCheck,
  FileCheck2,
  Landmark,
  Scale,
} from "lucide-react";

export function FinanceWorkspace({ data }: { data: FinanceWorkspaceView }) {
  const latestRun = data.runs[0];
  const completeRuns = data.runs.filter((run) => run.status === "complete");
  const incompleteRuns = data.runs.filter((run) => run.status === "incomplete");
  const latestComplete = completeRuns[0];

  if (!data.statements.length && !data.metrics.length) {
    return (
      <section className="finance-empty" aria-labelledby="finance-empty-title">
        <Landmark size={32} />
        <strong id="finance-empty-title">还没有财务证据</strong>
        <span>先接收结算单、费用单与历史汇率，再建立利润口径。系统不会用缺失成本计算利润。</span>
      </section>
    );
  }

  return (
    <>
      <section className="finance-equation" aria-label="最新利润证据等式">
        <EquationTerm
          code="REVENUE"
          label="确认收入"
          value={moneyOrMissing(latestRun?.revenueMinor, latestRun?.reportingCurrency)}
          icon={<Banknote size={17} />}
        />
        <ArrowDownRight className="finance-equation-operator" size={18} aria-hidden="true" />
        <EquationTerm
          code="COST"
          label="确认成本"
          value={moneyOrMissing(latestRun?.costMinor, latestRun?.reportingCurrency)}
          icon={<Scale size={17} />}
        />
        <ArrowRight className="finance-equation-operator" size={18} aria-hidden="true" />
        <EquationTerm
          code="PROFIT"
          label="贡献利润"
          value={moneyOrMissing(latestRun?.profitMinor, latestRun?.reportingCurrency)}
          icon={<BadgeDollarSign size={17} />}
          result
        />
        <div className={`finance-equation-state state-${latestRun?.status ?? "empty"}`}>
          {latestRun?.status === "complete" ? <CircleCheck size={16} /> : <CircleAlert size={16} />}
          <span>
            <b>{latestRun?.status === "complete" ? "计算完整" : "等待完整证据"}</b>
            {latestRun?.status === "complete" && latestRun.marginBps !== null
              ? `利润率 ${formatBps(latestRun.marginBps)}`
              : diagnosticSummary(latestRun)}
          </span>
        </div>
      </section>

      <section className="finance-signals" aria-label="财务证据摘要">
        <Signal code="STATEMENTS" label="不可变结算单" value={data.statements.length} />
        <Signal code="FX RATES" label="历史汇率" value={data.fxRates.length} />
        <Signal code="COMPLETE" label="完整利润计算" value={completeRuns.length} tone="green" />
        <Signal code="INCOMPLETE" label="缺证据计算" value={incompleteRuns.length} tone="amber" />
      </section>

      <section className="finance-panel" aria-labelledby="finance-statements-title">
        <PanelHeader code="SOURCE EVIDENCE" title="财务证据台账" detail={`${data.statements.length} 份结算与费用证据`} />
        <div className="finance-table-scroll">
          <table className="finance-table finance-statement-table">
            <thead>
              <tr><th>来源 / 单据</th><th>类型</th><th>期间</th><th>币种</th><th>事实行</th><th>记录时间</th></tr>
            </thead>
            <tbody>
              {data.statements.map((statement) => (
                <tr key={statement.id}>
                  <td><strong>{providerLabel(statement.provider)}</strong><code>{statement.externalStatementId}</code></td>
                  <td><span className="finance-kind">{statementKindLabel(statement.statementKind)}</span></td>
                  <td><time dateTime={statement.periodStart}>{formatDate(statement.periodStart)}</time><span>至 {formatDate(statement.periodEnd)}</span></td>
                  <td><b className="finance-currency">{statement.sourceCurrency}</b></td>
                  <td><b className="finance-number">{statement.lines.length}</b></td>
                  <td><time dateTime={statement.recordedAt}>{formatDateTime(statement.recordedAt)}</time></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="finance-panel" aria-labelledby="finance-runs-title">
        <PanelHeader code="PINNED CALCULATIONS" title="利润计算记录" detail={`${data.runs.length} 次不可变计算`} />
        <div className="finance-table-scroll">
          <table className="finance-table finance-run-table">
            <thead>
              <tr><th>状态</th><th>指标版本</th><th>收入</th><th>成本</th><th>利润</th><th>利润率</th><th>证据</th><th>计算时间</th></tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr key={run.id}>
                  <td><RunStatus run={run} /></td>
                  <td><strong>V{run.metricVersion}</strong><code>{shortId(run.metricVersionId)}</code></td>
                  <td><b className="finance-money">{moneyOrMissing(run.revenueMinor, run.reportingCurrency)}</b></td>
                  <td><b className="finance-money">{moneyOrMissing(run.costMinor, run.reportingCurrency)}</b></td>
                  <td><b className={run.profitMinor !== null && run.profitMinor < 0 ? "finance-money is-negative" : "finance-money is-profit"}>{moneyOrMissing(run.profitMinor, run.reportingCurrency)}</b></td>
                  <td><b className="finance-number">{run.marginBps === null ? "缺失" : formatBps(run.marginBps)}</b></td>
                  <td><span>{run.statementIds.length} 单据 · {run.fxRateIds.length} 汇率</span></td>
                  <td><time dateTime={run.calculatedAt}>{formatDateTime(run.calculatedAt)}</time></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!data.runs.length ? <InlineEmpty message="利润口径已建立，但还没有计算记录。" /> : null}
      </section>

      <div className="finance-columns">
        <section className="finance-panel" aria-labelledby="finance-diagnostics-title">
          <PanelHeader code="COMPLETENESS" title="完整性诊断" detail={`${incompleteRuns.length} 次待补齐`} />
          {incompleteRuns.length ? (
            <ol className="finance-diagnostic-list">
              {incompleteRuns.slice(0, 8).map((run) => (
                <li key={run.id}>
                  <CircleAlert size={15} />
                  <div>
                    <strong>{formatDateTime(run.calculatedAt)} · V{run.metricVersion}</strong>
                    <span>{diagnosticSummary(run)}</span>
                  </div>
                  <code>{shortId(run.id)}</code>
                </li>
              ))}
            </ol>
          ) : <InlineEmpty icon="check" message="现有利润计算均具备完整证据。" />}
        </section>

        <section className="finance-panel" aria-labelledby="finance-metrics-title">
          <PanelHeader code="VERSIONED DEFINITIONS" title="利润口径" detail={`${data.metrics.length} 个指标`} />
          {data.metrics.length ? (
            <ol className="finance-metric-list">
              {data.metrics.map((metric) => (
                <li key={metric.id}>
                  <FileCheck2 size={15} />
                  <div>
                    <strong>{metric.name}</strong>
                    <span>{metric.version.reportingCurrency} · 必需 {metric.version.requiredFactTypes.map(factTypeLabel).join("、") || "无"}</span>
                  </div>
                  <b>V{metric.currentVersion}</b>
                </li>
              ))}
            </ol>
          ) : <InlineEmpty message="还没有版本化利润口径。" />}
        </section>
      </div>

      <section className="finance-panel" aria-labelledby="finance-breakdowns-title">
        <PanelHeader code="DRILL-DOWN" title="最新完整利润拆分" detail={latestComplete ? `${latestComplete.breakdowns.length} 个维度结果` : "暂无完整结果"} />
        {latestComplete ? (
          <div className="finance-table-scroll">
            <table className="finance-table finance-breakdown-table">
              <thead>
                <tr><th>维度</th><th>对象</th><th>收入</th><th>成本</th><th>利润</th><th>事实数</th></tr>
              </thead>
              <tbody>
                {latestComplete.breakdowns.map((breakdown) => (
                  <tr key={`${breakdown.dimension}:${breakdown.key}`}>
                    <td><span className="finance-kind">{dimensionLabel(breakdown.dimension)}</span></td>
                    <td><code>{breakdown.dimension === "period" ? breakdown.key : shortId(breakdown.key)}</code></td>
                    <td><b className="finance-money">{formatMoney(breakdown.revenueMinor, latestComplete.reportingCurrency)}</b></td>
                    <td><b className="finance-money">{formatMoney(breakdown.costMinor, latestComplete.reportingCurrency)}</b></td>
                    <td><b className={breakdown.profitMinor < 0 ? "finance-money is-negative" : "finance-money is-profit"}>{formatMoney(breakdown.profitMinor, latestComplete.reportingCurrency)}</b></td>
                    <td><b className="finance-number">{breakdown.factCount}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <InlineEmpty message="补齐必需事实、汇率和分类后才会生成利润拆分。" />}
      </section>

      <section className="finance-panel" aria-labelledby="finance-fx-title">
        <PanelHeader code="HISTORICAL RATES" title="历史汇率" detail={`${data.fxRates.length} 条锁定汇率`} />
        {data.fxRates.length ? (
          <div className="finance-fx-grid">
            {data.fxRates.map((rate) => (
              <article key={rate.id}>
                <span>{rate.source}</span>
                <strong>{rate.baseCurrency} / {rate.quoteCurrency}</strong>
                <b>{formatRatio(rate.rateNumerator, rate.rateDenominator)}</b>
                <time dateTime={rate.effectiveAt}>生效 {formatDateTime(rate.effectiveAt)}</time>
              </article>
            ))}
          </div>
        ) : <InlineEmpty message="还没有历史汇率证据；跨币种事实无法完成利润计算。" />}
      </section>
    </>
  );
}

function EquationTerm({
  code,
  label,
  value,
  icon,
  result = false,
}: {
  code: string;
  label: string;
  value: string;
  icon: React.ReactNode;
  result?: boolean;
}) {
  return (
    <div className={result ? "finance-equation-term is-result" : "finance-equation-term"}>
      <span>{icon}</span>
      <p><small>{code}</small><strong>{label}</strong></p>
      <b>{value}</b>
    </div>
  );
}

function Signal({ code, label, value, tone = "navy" }: { code: string; label: string; value: number; tone?: "navy" | "green" | "amber" }) {
  return <div className={`finance-signal signal-${tone}`}><small>{code}</small><strong>{label}</strong><b>{value}</b></div>;
}

function PanelHeader({ code, title, detail }: { code: string; title: string; detail: string }) {
  return <header><div><p className="section-code">{code}</p><h2>{title}</h2></div><span>{detail}</span></header>;
}

function RunStatus({ run }: { run: FinanceProfitRunView }) {
  return (
    <span className={`finance-status status-${run.status}`}>
      {run.status === "complete" ? <CircleCheck size={13} /> : <CircleAlert size={13} />}
      {run.status === "complete" ? "完整" : "缺证据"}
    </span>
  );
}

function InlineEmpty({ message, icon = "alert" }: { message: string; icon?: "alert" | "check" }) {
  return <p className="finance-inline-empty">{icon === "check" ? <CircleCheck size={15} /> : <CircleAlert size={15} />}{message}</p>;
}

function diagnosticSummary(run?: FinanceProfitRunView) {
  if (!run) return "尚未运行利润计算";
  const parts = [];
  if (run.diagnostics.missingFactTypes.length) parts.push(`缺事实 ${run.diagnostics.missingFactTypes.map(factTypeLabel).join("、")}`);
  if (run.diagnostics.missingFxPairs.length) parts.push(`缺汇率 ${run.diagnostics.missingFxPairs.join("、")}`);
  if (run.diagnostics.unclassifiedFactTypes.length) parts.push(`未分类 ${run.diagnostics.unclassifiedFactTypes.map(factTypeLabel).join("、")}`);
  return parts.join("；") || "证据完整";
}

function factTypeLabel(type: FinanceFactType) {
  return ({
    sale_revenue: "商品收入",
    shipping_revenue: "运费收入",
    marketplace_commission: "平台佣金",
    advertising_spend: "广告支出",
    fulfillment_fee: "履约费",
    storage_fee: "仓储费",
    refund: "退款",
    chargeback: "拒付",
    procurement_cost: "采购成本",
    production_cost: "生产成本",
    freight_cost: "头程运费",
    carrier_cost: "承运成本",
    tax: "税费",
    other_fee: "其他费用",
  })[type];
}

function providerLabel(provider: FinanceWorkspaceView["statements"][number]["provider"]) {
  return ({ amazon: "Amazon", etsy: "Etsy", advertising: "广告平台", carrier: "承运商", supplier: "供应商", tax_authority: "税务机构", manual: "人工凭证" })[provider];
}

function statementKindLabel(kind: FinanceWorkspaceView["statements"][number]["statementKind"]) {
  return ({ marketplace_settlement: "平台结算", advertising_invoice: "广告账单", fulfillment_invoice: "履约账单", carrier_invoice: "物流账单", supplier_invoice: "供应商账单", tax_statement: "税务单据", operational_cost: "运营成本", manual_adjustment: "人工调整" })[kind];
}

function dimensionLabel(dimension: FinanceProfitRunView["breakdowns"][number]["dimension"]) {
  return ({ order: "订单", order_line: "订单行", sku: "SKU", listing: "Listing", store: "店铺", platform: "平台", supplier: "供应商", period: "期间" })[dimension];
}

function moneyOrMissing(value: number | null | undefined, currency: string | undefined) {
  return value === null || value === undefined || !currency ? "缺失" : formatMoney(value, currency);
}

function formatMoney(value: number, currency: string) {
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency,
    currencyDisplay: "code",
  }).format(value / 100);
}

function formatBps(value: number) {
  return `${(value / 100).toFixed(2)}%`;
}

function formatRatio(numerator: number, denominator: number) {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 6 }).format(numerator / denominator);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}
