import { Gauge } from "lucide-react";

import {
  OperationsDashboard,
  type OperationsDashboardView,
} from "../../features/dashboard/operations-dashboard";
import { ErpSidebar } from "../../features/navigation/erp-sidebar";
import { apiFetch } from "../../server-api";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const result = await loadDashboard();
  return (
    <div className="research-shell ops-shell">
      <ErpSidebar
        active="dashboard"
        contextLabel="OPERATIONS"
        note="当前阶段仅跟踪抓取、AI、产品、设计、刊登与审核。订单和销售将在交易能力上线后启用。"
      />
      <main className="research-main ops-main">
        {result.data ? (
          <OperationsDashboard data={result.data} />
        ) : (
          <section className="analysis-error" role="alert">
            <Gauge size={28} />
            <h1>运营数据暂不可用</h1>
            <p>{result.error ?? "请配置仪表盘 API 后重试。"}</p>
            <a href="/research">前往研究资料库</a>
          </section>
        )}
      </main>
    </div>
  );
}

async function loadDashboard(): Promise<{ data?: OperationsDashboardView; error?: string }> {
  if (process.env.DASHBOARD_DEMO_MODE === "1") return { data: demoData() };
  const base = process.env.API_BASE_URL;
  if (!base) return { error: "尚未配置运营 API。请设置 API_BASE_URL 后重试。" };
  const today = new Date().toISOString().slice(0, 10);
  const from = `${today.slice(0, 8)}01`;
  try {
    const [metricsResponse, notificationsResponse] = await Promise.all([
      apiFetch(
        `${base.replace(/\/$/, "")}/v1/dashboard?from=${from}&to=${today}&timezone=Asia%2FShanghai`,
        { cache: "no-store" },
      ),
      apiFetch(`${base.replace(/\/$/, "")}/v1/notifications?limit=20`, { cache: "no-store" }),
    ]);
    if (!metricsResponse.ok) throw new Error(`仪表盘读取失败 (${metricsResponse.status})`);
    const metrics = (await metricsResponse.json()) as Omit<
      OperationsDashboardView,
      "jobs" | "notifications"
    >;
    const notifications = notificationsResponse.ok
      ? ((await notificationsResponse.json()) as OperationsDashboardView["notifications"])
      : [];
    return { data: { ...metrics, jobs: [], notifications } };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "仪表盘读取失败" };
  }
}

function demoData(): OperationsDashboardView {
  return {
    range: { from: "2026-07-01", to: "2026-07-18", timezone: "Asia/Shanghai" },
    capture: { total: 38, complete: 32, partial: 4, failed: 2, successRate: 94.7 },
    ai: { queued: 2, running: 1, costUsd: 12.48 },
    productFunnel: {
      researching: 8,
      pending_approval: 3,
      approved: 5,
      developing: 4,
      listing: 2,
      ready: 1,
    },
    design: { overdue: 2, active: 7 },
    listing: { total: 5, averageCompleteness: 86, blockers: 3 },
    risks: [
      { kind: "capture_failed", count: 2, label: "抓取失败" },
      { kind: "design_overdue", count: 2, label: "设计已逾期" },
      { kind: "listing_blocker", count: 3, label: "刊登阻断项" },
    ],
    recentActivity: [
      {
        id: "a1",
        action: "listing.review.approve",
        entityType: "listing_review",
        result: "success",
        occurredAt: "2026-07-18T04:12:00Z",
      },
      {
        id: "a2",
        action: "design.version.upload",
        entityType: "design_version",
        result: "success",
        occurredAt: "2026-07-18T03:48:00Z",
      },
      {
        id: "a3",
        action: "capture.normalize",
        entityType: "capture_snapshot",
        result: "failure",
        occurredAt: "2026-07-18T03:25:00Z",
      },
    ],
    myTasks: [
      {
        id: "t1",
        title: "Travel mug production proof",
        status: "in_review",
        dueAt: "2026-07-19T00:00:00Z",
      },
      {
        id: "t2",
        title: "Etsy personalization copy",
        status: "open",
        dueAt: "2026-07-21T00:00:00Z",
      },
    ],
    jobs: [
      {
        id: "j1",
        jobId: "job1",
        label: "AI-03 定价分析",
        state: "running",
        progress: 62,
        occurredAt: "2026-07-18T04:14:00Z",
      },
      {
        id: "j2",
        jobId: "job2",
        label: "Amazon 导出包",
        state: "failed",
        progress: 71,
        message: "1 个素材仍在研究域",
        occurredAt: "2026-07-18T04:08:00Z",
      },
      {
        id: "j3",
        jobId: "job3",
        label: "Etsy 媒体归档",
        state: "queued",
        progress: 0,
        occurredAt: "2026-07-18T04:15:00Z",
      },
    ],
    notifications: [
      {
        id: "n1",
        kind: "job_failed",
        title: "Amazon 导出被阻断",
        body: "素材 mug-lifestyle-02.png 尚未进入授权域。",
        createdAt: "2026-07-18T04:08:00Z",
      },
      {
        id: "n2",
        kind: "review_requested",
        title: "Listing V04 等待审核",
        body: "Travel Mug Gift / Amazon US",
        createdAt: "2026-07-18T04:02:00Z",
      },
      {
        id: "n3",
        kind: "review_decided",
        title: "设计 V03 已批准",
        body: "生产文件已锁定为主版本。",
        readAt: "2026-07-18T03:50:00Z",
        createdAt: "2026-07-18T03:42:00Z",
      },
    ],
  };
}
