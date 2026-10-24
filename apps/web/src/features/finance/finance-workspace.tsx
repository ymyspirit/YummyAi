import type {
  FinanceFactType,
  FinanceProfitRunView,
  FinanceWorkspaceView,
} from "@yummyai/contracts/finance";
import { financeCoverageLabel, isFinanceProfitVerified } from "@yummyai/contracts/finance";
import { formatFinanceMinorAmount } from "@yummyai/contracts/finance/monetary";
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
import { Fragment } from "react";
import "./finance-monetary.css";

export function FinanceWorkspace({ data }: { data: FinanceWorkspaceView }) {
  const runs = data.runs.map((run) => isFinanceProfitVerified(run) ? run : {
    ...run, status: "incomplete" as const, revenueMinor: null, costMinor: null, profitMinor: null, marginBps: null, breakdowns: [],
  });
  const latestRun = runs[0];
  const completeRuns = runs.filter(isFinanceProfitVerified);
  const incompleteRuns = runs.filter((run) => !isFinanceProfitVerified(run));
  const latestComplete = completeRuns[0];

  if (!data.statements.length && !data.metrics.length && !runs.length && !data.fxRates.length) {
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
            <b>{latestRun?.status === "complete" ? "所选口径验证通过" : "等待完整证据"}</b>
            {latestRun?.status === "complete" && latestRun.marginBps !== null
              ? `利润率 ${formatBps(latestRun.marginBps)}`
              : diagnosticSummary(latestRun)}
          </span>
        </div>
      </section>

      <p className="finance-inline-empty">核验粒度：{financeCoverageLabel(latestRun?.diagnostics.coverage?.dimension)}。完整性仅覆盖本次选定单据中的对象及口径必需费用；不代表店铺所有订单或所有实际成本均已入账。</p>
      {latestRun ? <p className="finance-monetary-basis" role="note" aria-label="最新计算货币与舍入依据">{monetaryBasisSummary(latestRun)}</p> : null}

      <section className="finance-signals" aria-label="财务证据摘要">
        <Signal code="STATEMENTS" label="不可变结算单" value={data.statements.length} />
        <Signal code="FX RATES" label="历史汇率" value={data.fxRates.length} />
        <Signal code="COMPLETE" label="完整利润计算" value={completeRuns.length} tone="green" />
        <Signal code="INCOMPLETE" label="缺证据计算" value={incompleteRuns.length} tone="amber" />
      </section>

      <section className="finance-panel" aria-labelledby="finance-statements-title">
        <PanelHeader headingId="finance-statements-title" code="SOURCE EVIDENCE" title="财务证据台账" detail={`${data.statements.length} 份结算与费用证据`} />
        <p className="finance-source-note">来源作用域与源明细标识仅表示 ERP 已记录的身份覆盖 不代表银行或外部平台已验真 旧记录缺少身份时保留未知</p>
        <div className="finance-table-scroll">
          <table className="finance-table finance-statement-table">
            <thead>
              <tr><th>来源 / 单据</th><th>类型</th><th>期间</th><th>币种</th><th>事实行</th><th>记录时间</th></tr>
            </thead>
            <tbody>
              {data.statements.map((statement) => (
                <Fragment key={statement.id}>
                  <tr>
                    <td><strong>{providerLabel(statement.provider)}</strong><code>{statement.externalStatementId}</code><span className={`finance-source-summary${statement.sourceIdentity ? "" : " is-unverified"}`}>{statementSourceLabel(statement)}</span></td>
                    <td><span className="finance-kind">{statementKindLabel(statement.statementKind)}</span></td>
                    <td><time dateTime={statement.periodStart}>{formatDate(statement.periodStart)}</time><span>至 {formatDate(statement.periodEnd)}</span></td>
                    <td><b className="finance-currency">{statement.sourceCurrency}</b></td>
                    <td><b className="finance-number">{statement.lines.length}</b><span className="finance-source-coverage">源标识 {sourceEntryCount(statement)}/{statement.lines.length}</span></td>
                    <td><time dateTime={statement.recordedAt}>{formatDateTime(statement.recordedAt)}</time></td>
                  </tr>
                  <tr className="finance-source-row"><td colSpan={6}><StatementSourceDetails statement={statement} /></td></tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="finance-panel" aria-labelledby="finance-runs-title">
        <PanelHeader headingId="finance-runs-title" code="PINNED CALCULATIONS" title="利润计算记录" detail={`${data.runs.length} 次不可变计算`} />
        <div className="finance-table-scroll">
          <table className="finance-table finance-run-table">
            <thead>
              <tr><th>状态 / 核验粒度</th><th>指标版本</th><th>收入</th><th>成本</th><th>利润</th><th>利润率</th><th>证据</th><th>计算时间</th></tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <Fragment key={run.id}>
                  <tr>
                    <td><RunStatus run={run} /><span>{financeCoverageLabel(run.diagnostics.coverage?.dimension)}</span></td>
                    <td><strong>V{run.metricVersion}</strong><code>{shortId(run.metricVersionId)}</code></td>
                    <td><b className="finance-money">{moneyOrMissing(run.revenueMinor, run.reportingCurrency)}</b></td>
                    <td><b className="finance-money">{moneyOrMissing(run.costMinor, run.reportingCurrency)}</b></td>
                    <td><b className={run.profitMinor !== null && run.profitMinor < 0 ? "finance-money is-negative" : "finance-money is-profit"}>{moneyOrMissing(run.profitMinor, run.reportingCurrency)}</b></td>
                    <td><b className="finance-number">{run.marginBps === null ? "缺失" : formatBps(run.marginBps)}</b></td>
                    <td><span>{run.statementIds.length} 单据 · {run.fxRateIds.length} 汇率</span></td>
                    <td><time dateTime={run.calculatedAt}>{formatDateTime(run.calculatedAt)}</time></td>
                  </tr>
                  <tr className="finance-run-monetary">
                    <td colSpan={8}><p className="finance-monetary-basis">{monetaryBasisSummary(run)}</p><RunSourceIdentity run={run} /></td>
                  </tr>
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        {!data.runs.length ? <InlineEmpty message="利润口径已建立，但还没有计算记录。" /> : null}
      </section>

      <div className="finance-columns">
        <section className="finance-panel" aria-labelledby="finance-diagnostics-title">
          <PanelHeader headingId="finance-diagnostics-title" code="COMPLETENESS" title="完整性诊断" detail={`${incompleteRuns.length} 次待补齐`} />
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
          <PanelHeader headingId="finance-metrics-title" code="VERSIONED DEFINITIONS" title="利润口径" detail={`${data.metrics.length} 个指标`} />
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
        <PanelHeader headingId="finance-breakdowns-title" code="DRILL-DOWN" title="最新已核验利润拆分" detail={latestComplete ? financeCoverageLabel(latestComplete.diagnostics.coverage?.dimension) : "暂无完整结果"} />
        {latestComplete?.diagnostics.coverage?.dimension === "aggregate" ? <InlineEmpty message="账单汇总仅验证本批单据的费用类型，不生成未经归属核验的订单或 SKU 利润。" /> : null}
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
                    <td><b className="finance-money">{formatFinanceMinorAmount(breakdown.revenueMinor, latestComplete.reportingCurrency)}</b></td>
                    <td><b className="finance-money">{formatFinanceMinorAmount(breakdown.costMinor, latestComplete.reportingCurrency)}</b></td>
                    <td><b className={breakdown.profitMinor < 0 ? "finance-money is-negative" : "finance-money is-profit"}>{formatFinanceMinorAmount(breakdown.profitMinor, latestComplete.reportingCurrency)}</b></td>
                    <td><b className="finance-number">{breakdown.factCount}</b></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <InlineEmpty message="补齐必需事实、汇率和分类后才会生成利润拆分。" />}
      </section>

      <section className="finance-panel" aria-labelledby="finance-fx-title">
        <PanelHeader headingId="finance-fx-title" code="HISTORICAL RATES" title="历史汇率" detail={`${data.fxRates.length} 条锁定汇率`} />
        {data.fxRates.length ? (
          <div className="finance-fx-grid">
            {data.fxRates.map((rate) => (
              <article key={rate.id}>
                <span>{rate.source}</span>
                <strong>{rate.baseCurrency} / {rate.quoteCurrency}</strong>
                <b className="finance-fx-ratio" aria-label="原始汇率分子与分母">{rate.rateNumerator} / {rate.rateDenominator}</b>
                {rate.monetaryBasis ? (
                  <p className="finance-monetary-basis">
                    1 {rate.baseCurrency} 主货币单位 = {rate.rateNumerator} / {rate.rateDenominator} {rate.quoteCurrency} 主货币单位
                    <br />固定精度 {rate.baseCurrency} {rate.monetaryBasis.baseMinorDigits} 位 · {rate.quoteCurrency} {rate.monetaryBasis.quoteMinorDigits} 位
                    <br />币种表 {rate.monetaryBasis.currencyTableVersion}
                  </p>
                ) : <p className="finance-monetary-basis is-unverified">单位待核对 · 原汇率未留存主货币单位与最小单位精度依据</p>}
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

function PanelHeader({ headingId, code, title, detail }: { headingId: string; code: string; title: string; detail: string }) {
  return <header><div><p className="section-code">{code}</p><h2 id={headingId}>{title}</h2></div><span>{detail}</span></header>;
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

type FinanceStatement = FinanceWorkspaceView["statements"][number];

function sourceEntryCount(statement: FinanceStatement) {
  return statement.lines.filter(line => Boolean(line.sourceEntryId?.trim())).length;
}

function statementSourceLabel(statement: FinanceStatement) {
  const identity = statement.sourceIdentity;
  if (!identity) return "历史来源身份未知";
  if (identity.kind === "marketplace_account") return statement.accountId ? `市场账户作用域 ${statement.accountId}` : "市场账户标识缺失 作用域待核对";
  if (identity.kind === "supplier") return `供应商作用域 ${identity.supplierId}`;
  return `命名来源 ${identity.sourceName}`;
}

function StatementSourceDetails({ statement }: { statement: FinanceStatement }) {
  const identity = statement.sourceIdentity, recorded = sourceEntryCount(statement);
  return <details className="finance-source-details" aria-label={`来源与明细标识 ${statement.externalStatementId} ${statement.id}`}>
    <summary>核对来源与明细标识 · {statement.externalStatementId} · 已记录 {recorded}/{statement.lines.length} 行</summary>
    <div className="finance-source-detail-body">
      <dl><dt>ERP 单据 ID</dt><dd><code>{statement.id}</code></dd><dt>外部单据编号</dt><dd><code>{statement.externalStatementId}</code></dd><dt>来源作用域</dt><dd>{statementSourceLabel(statement)}</dd></dl>
      {!identity && <p className="finance-source-summary is-unverified">历史依据未知 不用当前账户、供应商或单号补推原来源身份 即使个别明细有标识也不代表原作用域已知</p>}
      {recorded !== statement.lines.length && <p className="finance-source-summary is-unverified">{statement.lines.length - recorded} 行缺少源明细标识 下方保留各行事实 ID 供核对</p>}
      {!statement.lines.length ? <p className="finance-source-note">这份单据当前没有可读取的事实行</p> : <ol className="finance-source-entry-list">{statement.lines.map(line => <li key={line.id}><strong>{factTypeLabel(line.factType)}</strong><dl><dt>事实 ID</dt><dd><code>{line.id}</code></dd><dt>源明细标识</dt><dd>{line.sourceEntryId?.trim() ? <code>{line.sourceEntryId}</code> : <span className="finance-source-summary is-unverified">未记录 源明细身份未知</span>}</dd></dl></li>)}</ol>}
    </div>
  </details>;
}

function RunSourceIdentity({ run }: { run: FinanceProfitRunView }) {
  const diagnostic = run.diagnostics.sourceIdentity;
  const recorded = run.sourceIdentityVersion === 1 && diagnostic?.schemaVersion === 1;
  const missing = diagnostic?.unidentifiedFactIds ?? [];
  return <div className="finance-run-source">
    <p className={`finance-monetary-basis${recorded && !missing.length ? "" : " is-unverified"}`}>{!recorded ? "历史来源身份依据未知 该次计算未保存完整来源核验记录" : missing.length ? `本次计算 ${missing.length} 条事实缺少来源身份记录 结果待核对` : "本次计算所选事实的来源身份记录覆盖完整"}</p>
    {!!missing.length && <details className="finance-source-details"><summary>定位缺少来源身份的事实 · {missing.length} 条</summary><div className="finance-source-detail-body"><p className="finance-source-note">以下为该次计算保存的缺失事实 ID 不从当前台账反推或补填旧计算依据</p><ol className="finance-source-missing-list">{missing.map(id => <li key={id}><code>{id}</code></li>)}</ol></div></details>}
  </div>;
}

function diagnosticSummary(run?: FinanceProfitRunView) {
  if (!run) return "尚未运行利润计算";
  const parts = [];
  if (run.diagnostics.missingFactTypes.length) parts.push(`缺事实 ${run.diagnostics.missingFactTypes.map(factTypeLabel).join("、")}`);
  if (run.diagnostics.missingFxPairs.length) parts.push(`缺汇率 ${run.diagnostics.missingFxPairs.join("、")}`);
  if (run.diagnostics.unclassifiedFactTypes.length) parts.push(`未分类 ${run.diagnostics.unclassifiedFactTypes.map(factTypeLabel).join("、")}`);
  const monetary = run.diagnostics.monetary;
  if (monetary?.unknownCurrencies.length) parts.push(`币种精度待核对 ${monetary.unknownCurrencies.join("、")}`);
  if (monetary?.ambiguousFxRateIds.length) parts.push(`汇率单位待核对 ${monetary.ambiguousFxRateIds.map(shortId).join("、")}`);
  if (!run.monetaryBasis) parts.push("旧计算未留存货币精度与舍入依据，请重算");
  const sourceIdentity = run.diagnostics.sourceIdentity;
  if (run.sourceIdentityVersion !== 1 || sourceIdentity?.schemaVersion !== 1) parts.push("历史来源身份依据未知，请重新计算后核对");
  if (sourceIdentity?.unidentifiedFactIds.length) parts.push(`${sourceIdentity.unidentifiedFactIds.length} 条事实缺少来源身份，详见该次计算的完整事实 ID`);
  const coverage = run.diagnostics.coverage;
  if (!coverage) parts.push("旧计算未验证归属，请重算");
  else {
    if (!coverage.checkedEntityCount) parts.push("没有可核验对象");
    if (coverage.unattributedFactIds.length) parts.push(`${coverage.unattributedFactIds.length} 条事实未归属${financeCoverageLabel(coverage.dimension)}`);
    if (coverage.missingByEntity.length) parts.push(coverage.missingByEntity.map((entry) => `${entry.key === "aggregate" ? "本批单据" : shortId(entry.key)} 缺 ${entry.missingFactTypes.map(factTypeLabel).join("、")}`).join("；"));
  }
  return parts.join("；") || (isFinanceProfitVerified(run) ? "证据完整" : "计算依据未验证，请重算");
}

function monetaryBasisSummary(run: FinanceProfitRunView) {
  const basis = run.monetaryBasis;
  if (!basis) return "货币与舍入依据待核对 · 旧计算未留存固定币种精度与舍入规则";
  const currencies = basis.currencies.map(({ currency, minorDigits }) => `${currency} ${minorDigits === null ? "精度待核对" : `${minorDigits} 位小数`}`).join("、");
  return `固定货币精度 ${currencies || "待核对"}；逐条事实换算后舍入至最小单位，恰好一半时远离零；币种表 ${basis.currencyTableVersion}`;
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
  return value === null || value === undefined || !currency ? "缺失" : formatFinanceMinorAmount(value, currency);
}

function formatBps(value: number) {
  if (!Number.isSafeInteger(value)) return "比例待核对";
  const integer = BigInt(value);
  const magnitude = integer < 0n ? -integer : integer;
  return `${integer < 0n ? "-" : ""}${magnitude / 100n}.${(magnitude % 100n).toString().padStart(2, "0")}%`;
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
