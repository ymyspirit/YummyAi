import type { CustomerIntelligenceWorkspaceView } from "@yummyai/contracts/customer-intelligence";
import { Activity, AlertTriangle, BadgeCheck, CircleAlert, FileBarChart2, MessageSquareText, Radar, ShieldCheck } from "lucide-react";

export function CustomerIntelligenceWorkspace({ data }: { data: CustomerIntelligenceWorkspaceView }) {
  const latestAnalysis = data.analyses[0];
  const recommendations = latestAnalysis?.recommendations ?? [];
  const negativeThemes = latestAnalysis?.themes.filter((theme) => (theme.negativeBps ?? 0) >= 5000) ?? [];
  if (!data.advertisingReports.length && !data.signals.length && !data.definitions.length) {
    return <section className="customer-intelligence-empty" aria-labelledby="customer-intelligence-empty-title"><Radar size={32} /><strong id="customer-intelligence-empty-title">还没有广告或客户信号证据</strong><span>先接收已授权的广告报告，或从已存在的评论、退货、客服、质检和关键词证据建立脱敏信号。</span></section>;
  }
  return <div className="customer-intelligence-workspace">
    <section className="customer-intelligence-chain" aria-label="广告与 VOC 证据链">
      <ChainStep icon={<MegaphoneIcon />} code="AD REPORTS" label="广告来源" value={`${data.advertisingReports.length} 份报告`} detail={latestReportDetail(data)} />
      <span className="customer-intelligence-arrow" aria-hidden="true">→</span>
      <ChainStep icon={<MessageSquareText size={16} />} code="REDACTED SIGNALS" label="客户信号" value={`${data.signals.length} 条脱敏事实`} detail={`${new Set(data.signals.map((signal) => signal.themeCode)).size} 个主题`} />
      <span className="customer-intelligence-arrow" aria-hidden="true">→</span>
      <ChainStep icon={<FileBarChart2 size={16} />} code="VERSIONED VOC" label="主题分析" value={latestAnalysis ? `V${latestAnalysis.definitionVersion}` : "尚未运行"} detail={latestAnalysis ? `${latestAnalysis.themes.length} 个主题 · ${latestAnalysis.signalIds.length} 个信号` : "等待固定定义与窗口"} />
      <span className="customer-intelligence-arrow" aria-hidden="true">→</span>
      <ChainStep icon={<ShieldCheck size={16} />} code="REVIEW ONLY" label="建议审阅" value={`${recommendations.length} 条建议`} detail="不会直接改写 Listing 或预算" />
    </section>

    <section className="customer-intelligence-signals" aria-label="广告与 VOC 摘要">
      <Signal code="REPORTS" label="广告报告" value={data.advertisingReports.length} />
      <Signal code="SPEND" label="记录广告花费" value={formatSpend(data.advertisingReports)} />
      <Signal code="SIGNALS" label="脱敏客户信号" value={data.signals.length} />
      <Signal code="NEGATIVE" label="高负向主题" value={negativeThemes.length} tone={negativeThemes.length ? "amber" : "green"} />
    </section>

    <section className="customer-intelligence-panel" aria-labelledby="customer-intelligence-reports-title">
      <PanelHeader code="SOURCE CURRENCY / ATTRIBUTION" title="广告报告" detail={`${data.advertisingReports.length} 份不可变报告`} id="customer-intelligence-reports-title" />
      <div className="customer-intelligence-table-scroll"><table className="customer-intelligence-table"><thead><tr><th>来源 / 报告</th><th>期间</th><th>归因窗口</th><th>花费</th><th>销售额</th><th>CTR</th><th>ROAS</th></tr></thead><tbody>{data.advertisingReports.map((report) => <tr key={report.id}><td><strong>{providerLabel(report.provider)}</strong><code>{report.externalReportId}</code></td><td><time dateTime={report.periodStart}>{formatDate(report.periodStart)}</time><span>至 {formatDate(report.periodEnd)}</span></td><td><b>{report.attributionWindowDays} 天</b><span>{report.sourceCurrency}</span></td><td className="customer-intelligence-money">{formatMoney(report.totals.spendMinor, report.sourceCurrency)}</td><td className="customer-intelligence-money">{formatMoney(report.totals.salesMinor, report.sourceCurrency)}</td><td>{ratio(report.totals.clicks, report.totals.impressions)}</td><td>{ratio(report.totals.salesMinor, report.totals.spendMinor)}</td></tr>)}</tbody></table></div>
      {!data.advertisingReports.length ? <InlineEmpty message="尚无广告报告；来源币种与归因窗口会在接收后固定。" /> : null}
    </section>

    <div className="customer-intelligence-columns">
      <section className="customer-intelligence-panel" aria-labelledby="customer-intelligence-signals-title"><PanelHeader code="CONSENT / REDACTION" title="客户信号" detail={`${data.signals.length} 条脱敏事实`} id="customer-intelligence-signals-title" />{data.signals.length ? <ol className="customer-intelligence-list">{data.signals.slice(0, 10).map((signal) => <li key={signal.id}><span className={`customer-signal-dot sentiment-${signal.sentiment}`} aria-label={sentimentLabel(signal.sentiment)} /><div><strong>{signal.themeCode}</strong><span>{sourceLabel(signal.sourceType)} · {signal.consentBasis}</span></div><b className="tabular-nums">{signal.occurrenceCount}</b></li>)}</ol> : <InlineEmpty message="还没有可分析的脱敏信号。" />}</section>
      <section className="customer-intelligence-panel" aria-labelledby="customer-intelligence-definitions-title"><PanelHeader code="VERSIONED DEFINITIONS" title="VOC 口径" detail={`${data.definitions.length} 个定义`} id="customer-intelligence-definitions-title" />{data.definitions.length ? <ol className="customer-intelligence-list">{data.definitions.map((definition) => <li key={definition.id}><BadgeCheck size={15} /><div><strong>{definition.name}</strong><span>来源权重 {definition.version.sourceWeights.length} 项 · 最少 {definition.version.minimumOccurrences} 次</span></div><b>V{definition.currentVersion}</b></li>)}</ol> : <InlineEmpty message="先建立版本化 VOC 定义，再运行主题分析。" />}</section>
    </div>

    <section className="customer-intelligence-panel" aria-labelledby="customer-intelligence-analysis-title"><PanelHeader code="PINNED ANALYSIS / REVIEW QUEUE" title="主题分析与建议" detail={latestAnalysis ? `${latestAnalysis.status === "complete" ? "完整" : "缺信号"} · V${latestAnalysis.definitionVersion}` : "尚未运行分析"} id="customer-intelligence-analysis-title" />{latestAnalysis ? <><div className="customer-intelligence-theme-grid">{latestAnalysis.themes.map((theme) => <article key={theme.id}><span>{theme.themeCode}</span><strong>{theme.negativeBps === null ? "—" : `${(theme.negativeBps / 100).toFixed(1)}%`}</strong><small>{theme.totalOccurrences} 次 · {theme.signalIds.length} 个信号</small></article>)}</div><div className="customer-intelligence-table-scroll"><table className="customer-intelligence-table"><thead><tr><th>主题</th><th>建议动作</th><th>状态</th><th>证据</th><th>边界</th></tr></thead><tbody>{recommendations.map((recommendation) => <tr key={recommendation.id}><td><strong>{recommendation.themeCode}</strong></td><td>{actionLabel(recommendation.action)}</td><td><span className={`customer-recommendation-status status-${recommendation.status}`}><CircleAlert size={13} />{statusLabel(recommendation.status)}</span></td><td><b className="tabular-nums">{recommendation.evidenceSignalIds.length}</b> 个信号</td><td>只供审阅，不自动写 Listing / 广告</td></tr>)}</tbody></table></div></> : <InlineEmpty icon="analysis" message="尚无固定窗口分析；分析完成后这里会显示主题、证据和待审阅建议。" />}</section>
  </div>;
}

function ChainStep({ icon, code, label, value, detail }: { icon: React.ReactNode; code: string; label: string; value: string; detail: string }) { return <div className="customer-intelligence-chain-step">{icon}<small>{code}</small><strong>{label}</strong><b>{value}</b><span>{detail}</span></div>; }
function Signal({ code, label, value, tone = "blue" }: { code: string; label: string; value: string | number; tone?: string }) { return <div className={`customer-intelligence-signal signal-${tone}`}><small>{code}</small><span>{label}</span><b className="tabular-nums">{value}</b></div>; }
function PanelHeader({ code, title, detail, id }: { code: string; title: string; detail: string; id?: string }) { return <header><div><small>{code}</small><h2 id={id}>{title}</h2></div><span>{detail}</span></header>; }
function InlineEmpty({ message, icon = "alert" }: { message: string; icon?: "alert" | "analysis" }) { return <p className="customer-intelligence-inline-empty">{icon === "analysis" ? <Activity size={15} /> : <AlertTriangle size={15} />}{message}</p>; }
function MegaphoneIcon() { return <Radar size={16} />; }
function latestReportDetail(data: CustomerIntelligenceWorkspaceView) { const report = data.advertisingReports[0]; return report ? `${report.sourceCurrency} · ${report.attributionWindowDays} 天归因` : "等待广告来源"; }
function providerLabel(provider: string) { return provider === "amazon_ads" ? "Amazon Ads" : provider === "etsy_ads" ? "Etsy Ads" : "人工导入"; }
function sourceLabel(source: string) { return source === "return_reason" ? "退货原因" : source === "support_contact" ? "客服联系" : source === "quality_defect" ? "质量缺陷" : source === "keyword" ? "关键词" : "评论"; }
function sentimentLabel(sentiment: string) { return sentiment === "negative" ? "负向" : sentiment === "positive" ? "正向" : sentiment === "mixed" ? "混合" : "中性"; }
function statusLabel(status: string) { return status === "approved" ? "已批准" : status === "rejected" ? "已驳回" : "待审阅"; }
function actionLabel(action: string) { return action === "investigate_product" ? "调查产品" : action === "review_listing_expectations" ? "复核 Listing 预期" : action === "review_campaign_terms" ? "复核广告词" : "复核服务流程"; }
function formatSpend(reports: CustomerIntelligenceWorkspaceView["advertisingReports"]) { const report = reports[0]; return report ? formatMoney(reports.reduce((sum, row) => sum + row.totals.spendMinor, 0), report.sourceCurrency) : "—"; }
function formatMoney(minor: number, currency: string) { return new Intl.NumberFormat("zh-CN", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100); }
function ratio(numerator: number, denominator: number) { return denominator ? `${((numerator / denominator) * 100).toFixed(1)}%` : "—"; }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
