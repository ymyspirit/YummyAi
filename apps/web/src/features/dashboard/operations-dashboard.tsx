import { Activity, AlertTriangle, ArrowRight, ArrowUpRight, Bot, CheckCircle2, Clock3, FileCheck2, Layers3, ScanSearch, Sparkles, TimerReset } from "lucide-react";

import { JobProgress, type JobProgressView } from "../jobs/job-progress";
import { NotificationMenu, type NotificationView } from "../notifications/notification-menu";

export interface OperationsDashboardView {
  generatedAt: string;
  range: { from: string; to: string; timezone: string };
  capture: { total: number; complete: number; partial: number; failed: number; successRate: number };
  ai: { queued: number; running: number; costUsd: number };
  aiLedger: Array<{ id: string; taskType: string; modelKey: string; provider: string; amountUsd: number; occurredAt: string }>;
  productFunnel: Record<string, number>;
  design: { overdue: number; active: number };
  listing: { total: number; averageCompleteness: number; blockers: number };
  freshness: Record<"capture" | "ai" | "product" | "design" | "listing", string | null>;
  risks: Array<{ kind: string; count: number; label: string }>;
  recentActivity: Array<{ id: string; action: string; entityType: string; result: string; occurredAt: string }>;
  myTasks: Array<{ id: string; title: string; status: string; dueAt?: string }>;
  jobs: JobProgressView[];
  notifications: NotificationView[];
}

const funnelOrder = ["researching", "pending_approval", "approved", "developing", "listing", "ready"];

export function OperationsDashboard({ data }: { data: OperationsDashboardView }) {
  const funnelMax = Math.max(1, ...funnelOrder.map((status) => data.productFunnel[status] ?? 0));
  const actions = actionItems(data);
  return <div className="ops-workbench">
    <header className="ops-header"><div><p className="kicker">P0 / OPERATIONS CONTROL</p><h1>运营总览</h1><p>从研究抓取到刊登审批，只呈现当前阶段可执行、可追责的运营信号。</p></div><div className="ops-header-tools"><div className="ops-range"><span>LOCAL DATE RANGE</span><strong>{data.range.from} — {data.range.to}</strong><small>{data.range.timezone} · 生成于 {formatTime(data.generatedAt)}</small></div><NotificationMenu initialNotifications={data.notifications} /></div></header>

    <section className="ops-pulse" aria-label="核心指标">
      <Metric icon={<ScanSearch size={19} />} code="CAPTURE" label="研究抓取" value={String(data.capture.total)} detail={`${data.capture.complete} 完整 · ${data.capture.failed} 失败`} freshness={data.freshness.capture} href={researchHref(data)} tone="blue" />
      <Metric icon={<CheckCircle2 size={19} />} code="SUCCESS" label="抓取可用率" value={`${data.capture.successRate}%`} detail={`${data.capture.partial} 份部分可用`} freshness={data.freshness.capture} href={researchHref(data)} tone="green" />
      <Metric icon={<Bot size={19} />} code="AI QUEUE" label="AI 任务" value={String(data.ai.queued + data.ai.running)} detail={`${data.ai.running} 运行 · ${data.ai.queued} 排队`} freshness={data.freshness.ai} href="#background-jobs" tone="amber" />
      <Metric icon={<Sparkles size={19} />} code="AI COST" label="本期模型成本" value={`$${data.ai.costUsd.toFixed(2)}`} detail="仅已提交账本" freshness={data.freshness.ai} href="#ai-ledger" tone="navy" />
    </section>

    <section className="ops-action-center" aria-labelledby="action-center-title">
      <header><div><p className="section-code">UNIFIED ACTION CENTER</p><h2 id="action-center-title">统一行动中心</h2><span>风险、失败任务和个人待办按真实来源合并，不生成推测性分数。</span></div><strong>{actions.length} ITEMS</strong></header>
      {actions.length ? <ol>{actions.map((item) => <li key={item.id}><span className={`action-priority ${item.priority}`}>{item.priority === "high" ? <AlertTriangle size={15} /> : <Clock3 size={15} />}</span><div><small>{item.source}</small><strong>{item.title}</strong><p>{item.detail}</p></div><b>{item.meta}</b><a href={item.href}>处理<ArrowRight size={14} /></a></li>)}</ol> : <div className="ops-action-clear"><CheckCircle2 size={22} /><div><strong>当前无待处理事项</strong><span>风险、失败任务与个人待办均为空。</span></div></div>}
    </section>

    <div className="ops-grid">
      <section className="ops-board funnel-board"><BoardHead code="PRODUCT FUNNEL" title="产品推进漏斗" icon={<Layers3 size={18} />} /><ol>{funnelOrder.map((status, index) => { const count = data.productFunnel[status] ?? 0; return <li key={status}><a aria-label={`查看${funnelLabel(status)}产品`} href={`/products?status=${encodeURIComponent(status)}`}><span>{String(index + 1).padStart(2, "0")}</span><div><p><strong>{funnelLabel(status)}</strong><b>{count}</b></p><i><em style={{ width: `${Math.max(count ? 8 : 0, (count / funnelMax) * 100)}%` }} /></i></div><ArrowUpRight size={14} /></a></li>; })}</ol><SourceFreshness value={data.freshness.product} /></section>

      <section className="ops-board readiness-board"><BoardHead code="RELEASE READINESS" title="交付就绪度" icon={<FileCheck2 size={18} />} /><a className="readiness-score" href="/listings?sort=completeness&direction=asc"><strong>{data.listing.averageCompleteness}</strong><span>/ 100</span><p>Listing 平均完整度</p></a><dl><ReadinessLink href="/listings" label="刊登工作区" value={data.listing.total} /><ReadinessLink href="/listings?blockers=with" label="阻断项" risk={data.listing.blockers > 0} value={data.listing.blockers} /><ReadinessLink href="/design?status=active" label="设计进行中" value={data.design.active} /><ReadinessLink href="/design?status=overdue" label="设计逾期" risk={data.design.overdue > 0} value={data.design.overdue} /></dl><SourceFreshness value={latestFreshness(data.freshness.listing, data.freshness.design)} /><a href="/listings">进入刊登控制台 <ArrowUpRight size={14} /></a></section>

      <section className="ops-board jobs-board" id="background-jobs"><BoardHead code="LIVE JOBS" title="后台任务" icon={<Activity size={18} />} /><JobProgress jobs={data.jobs} /><div className="ai-ledger" id="ai-ledger"><header><div><p>COMMITTED LEDGER</p><h3>本期模型账本</h3></div><strong>${data.ai.costUsd.toFixed(2)}</strong></header>{data.aiLedger.length ? <ol>{data.aiLedger.map((entry) => <li key={entry.id}><span><strong>{entry.taskType}</strong><small>{entry.provider} · {entry.modelKey}</small></span><b>${entry.amountUsd.toFixed(4)}</b><time>{formatTime(entry.occurredAt)}</time></li>)}</ol> : <p className="ops-empty">所选时间段内没有已提交模型账本记录。</p>}</div><SourceFreshness value={data.freshness.ai} /></section>

      <section className="ops-board activity-board"><BoardHead code="AUDIT FEED" title="最近活动" icon={<TimerReset size={18} />} />{data.recentActivity.length ? <ol>{data.recentActivity.map((event) => <li key={event.id}><span className={event.result === "success" ? "activity-ok" : "activity-fail"}>{event.result === "success" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span><div><strong>{activityLabel(event.action)}</strong><small>{event.entityType}</small></div><time>{formatTime(event.occurredAt)}</time></li>)}</ol> : <p className="ops-empty">所选时间段内暂无活动。</p>}</section>

    </div>
  </div>;
}

function actionItems(data: OperationsDashboardView) {
  const riskHref: Record<string, string> = { capture_failed: researchHref(data, "failed"), design_overdue: "/design?status=overdue", listing_blocker: "/listings?blockers=with", job_failed: "#background-jobs" };
  const risks = data.risks.map((risk) => ({ id: `risk-${risk.kind}`, priority: "high" as const, source: "风险信号", title: risk.label, detail: "打开对应工作区查看真实记录并分派处理。", meta: `${risk.count} 项`, href: riskHref[risk.kind] ?? "/" }));
  const failedJobs = data.jobs.filter((job) => job.state === "failed").map((job) => ({ id: `job-${job.id}`, priority: "high" as const, source: "后台任务", title: job.label, detail: job.message ?? "任务执行失败，请查看进度事件。", meta: `${job.progress}%`, href: "#background-jobs" }));
  const tasks = data.myTasks.map((task) => ({ id: `task-${task.id}`, priority: task.dueAt && Date.parse(task.dueAt) < Date.now() ? "high" as const : "normal" as const, source: "我的待办", title: task.title, detail: `当前状态：${task.status}`, meta: task.dueAt ? formatDate(task.dueAt) : "未设截止", href: `/design?task=${encodeURIComponent(task.id)}` }));
  return [...risks, ...failedJobs, ...tasks];
}

function Metric({ icon, code, label, value, detail, freshness, href, tone }: { icon: React.ReactNode; code: string; label: string; value: string; detail: string; freshness: string | null; href: string; tone: string }) { return <a aria-label={`${label}：${value}，打开明细`} className={`ops-metric metric-${tone}`} href={href}><span>{icon}</span><p><small>{code}</small><strong>{label}</strong></p><b>{value}</b><em>{detail} · {freshnessLabel(freshness)}</em><ArrowUpRight className="ops-metric-link" size={13} /></a>; }
function BoardHead({ code, title, icon }: { code: string; title: string; icon: React.ReactNode }) { return <header><span>{icon}</span><div><p>{code}</p><h2>{title}</h2></div></header>; }
function ReadinessLink({ href, label, risk = false, value }: { href: string; label: string; risk?: boolean; value: number }) { return <div><dt>{label}</dt><dd className={risk ? "risk-value" : ""}><a aria-label={`${label} ${value}，打开明细`} href={href}>{value}<ArrowUpRight size={12} /></a></dd></div>; }
function SourceFreshness({ value }: { value: string | null }) { return <p className="ops-source-freshness"><Clock3 size={12} />{freshnessLabel(value)}</p>; }
function funnelLabel(status: string) { return ({ researching: "机会研究", pending_approval: "等待批准", approved: "立项通过", developing: "产品开发", listing: "刊登准备", ready: "可发布" } as Record<string, string>)[status] ?? status; }
function activityLabel(action: string) { return action.split(".").map((part) => part.replace(/_/g, " ")).join(" / "); }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
function freshnessLabel(value: string | null) { return value ? `最近记录 ${formatTime(value)}` : "当前范围无记录"; }
function latestFreshness(...values: Array<string | null>) { return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null; }
function researchHref(data: OperationsDashboardView, captureStatus?: string) { const query = new URLSearchParams({ dateFrom: data.range.from, dateTo: data.range.to }); if (captureStatus) query.set("captureStatus", captureStatus); return `/research?${query.toString()}`; }
