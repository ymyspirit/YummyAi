import { Activity, AlertTriangle, ArrowUpRight, Bot, Boxes, CheckCircle2, Clock3, FileCheck2, Layers3, ScanSearch, Sparkles, TimerReset } from "lucide-react";

import { JobProgress, type JobProgressView } from "../jobs/job-progress";
import { NotificationMenu, type NotificationView } from "../notifications/notification-menu";

export interface OperationsDashboardView {
  range: { from: string; to: string; timezone: string };
  capture: { total: number; complete: number; partial: number; failed: number; successRate: number };
  ai: { queued: number; running: number; costUsd: number };
  productFunnel: Record<string, number>;
  design: { overdue: number; active: number };
  listing: { total: number; averageCompleteness: number; blockers: number };
  risks: Array<{ kind: string; count: number; label: string }>;
  recentActivity: Array<{ id: string; action: string; entityType: string; result: string; occurredAt: string }>;
  myTasks: Array<{ id: string; title: string; status: string; dueAt?: string }>;
  jobs: JobProgressView[];
  notifications: NotificationView[];
}

const funnelOrder = ["researching", "pending_approval", "approved", "developing", "listing", "ready"];

export function OperationsDashboard({ data }: { data: OperationsDashboardView }) {
  const funnelMax = Math.max(1, ...funnelOrder.map((status) => data.productFunnel[status] ?? 0));
  return <div className="ops-workbench">
    <header className="ops-header"><div><p className="kicker">P0 / OPERATIONS CONTROL</p><h1>运营总览</h1><p>从研究抓取到刊登审批，只呈现当前阶段可执行、可追责的运营信号。</p></div><div className="ops-header-tools"><div className="ops-range"><span>LOCAL DATE RANGE</span><strong>{data.range.from} — {data.range.to}</strong><small>{data.range.timezone}</small></div><NotificationMenu initialNotifications={data.notifications} /></div></header>

    <section className="ops-pulse" aria-label="核心指标">
      <Metric icon={<ScanSearch size={19} />} code="CAPTURE" label="研究抓取" value={String(data.capture.total)} detail={`${data.capture.complete} 完整 · ${data.capture.failed} 失败`} tone="blue" />
      <Metric icon={<CheckCircle2 size={19} />} code="SUCCESS" label="抓取可用率" value={`${data.capture.successRate}%`} detail={`${data.capture.partial} 份部分可用`} tone="green" />
      <Metric icon={<Bot size={19} />} code="AI QUEUE" label="AI 任务" value={String(data.ai.queued + data.ai.running)} detail={`${data.ai.running} 运行 · ${data.ai.queued} 排队`} tone="amber" />
      <Metric icon={<Sparkles size={19} />} code="AI COST" label="本期模型成本" value={`$${data.ai.costUsd.toFixed(2)}`} detail="仅已提交账本" tone="navy" />
    </section>

    <div className="ops-grid">
      <section className="ops-board funnel-board"><BoardHead code="PRODUCT FUNNEL" title="产品推进漏斗" icon={<Layers3 size={18} />} /><ol>{funnelOrder.map((status, index) => { const count = data.productFunnel[status] ?? 0; return <li key={status}><span>{String(index + 1).padStart(2, "0")}</span><div><p><strong>{funnelLabel(status)}</strong><b>{count}</b></p><i><em style={{ width: `${Math.max(count ? 8 : 0, (count / funnelMax) * 100)}%` }} /></i></div></li>; })}</ol></section>

      <section className="ops-board readiness-board"><BoardHead code="RELEASE READINESS" title="交付就绪度" icon={<FileCheck2 size={18} />} /><div className="readiness-score"><strong>{data.listing.averageCompleteness}</strong><span>/ 100</span><p>Listing 平均完整度</p></div><dl><div><dt>刊登工作区</dt><dd>{data.listing.total}</dd></div><div><dt>阻断项</dt><dd className={data.listing.blockers ? "risk-value" : ""}>{data.listing.blockers}</dd></div><div><dt>设计进行中</dt><dd>{data.design.active}</dd></div><div><dt>设计逾期</dt><dd className={data.design.overdue ? "risk-value" : ""}>{data.design.overdue}</dd></div></dl><a href="/listings/demo">进入刊登控制台 <ArrowUpRight size={14} /></a></section>

      <section className="ops-board jobs-board"><BoardHead code="LIVE JOBS" title="后台任务" icon={<Activity size={18} />} /><JobProgress jobs={data.jobs} /></section>

      <section className="ops-board risks-board"><BoardHead code="ACTION REQUIRED" title="风险与阻断" icon={<AlertTriangle size={18} />} />{data.risks.length ? <ol>{data.risks.map((risk) => <li key={risk.kind}><span><AlertTriangle size={15} /></span><div><strong>{risk.label}</strong><small>需要负责人处理</small></div><b>{risk.count}</b></li>)}</ol> : <div className="ops-clear"><CheckCircle2 size={22} /><strong>当前无阻断风险</strong><span>抓取、设计和刊登门禁均处于可控状态。</span></div>}</section>

      <section className="ops-board activity-board"><BoardHead code="AUDIT FEED" title="最近活动" icon={<TimerReset size={18} />} />{data.recentActivity.length ? <ol>{data.recentActivity.map((event) => <li key={event.id}><span className={event.result === "success" ? "activity-ok" : "activity-fail"}>{event.result === "success" ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}</span><div><strong>{activityLabel(event.action)}</strong><small>{event.entityType}</small></div><time>{formatTime(event.occurredAt)}</time></li>)}</ol> : <p className="ops-empty">所选时间段内暂无活动。</p>}</section>

      <section className="ops-board tasks-board"><BoardHead code="MY WORK" title="我的待办" icon={<Clock3 size={18} />} />{data.myTasks.length ? <ol>{data.myTasks.map((task) => <li key={task.id}><span><Boxes size={15} /></span><div><strong>{task.title}</strong><small>{task.status}</small></div><time>{task.dueAt ? formatDate(task.dueAt) : "未设截止"}</time></li>)}</ol> : <p className="ops-empty">没有分配给你的待办任务。</p>}</section>
    </div>
  </div>;
}

function Metric({ icon, code, label, value, detail, tone }: { icon: React.ReactNode; code: string; label: string; value: string; detail: string; tone: string }) { return <article className={`ops-metric metric-${tone}`}><span>{icon}</span><p><small>{code}</small><strong>{label}</strong></p><b>{value}</b><em>{detail}</em></article>; }
function BoardHead({ code, title, icon }: { code: string; title: string; icon: React.ReactNode }) { return <header><span>{icon}</span><div><p>{code}</p><h2>{title}</h2></div></header>; }
function funnelLabel(status: string) { return ({ researching: "机会研究", pending_approval: "等待批准", approved: "立项通过", developing: "产品开发", listing: "刊登准备", ready: "可发布" } as Record<string, string>)[status] ?? status; }
function activityLabel(action: string) { return action.split(".").map((part) => part.replace(/_/g, " ")).join(" / "); }
function formatTime(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value)); }
function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit" }).format(new Date(value)); }
