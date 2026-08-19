import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperationsDashboard, type OperationsDashboardView } from "./operations-dashboard";

describe("operations dashboard", () => {
  it("renders P0 operational metrics, risks, failed jobs, and overdue tasks", () => {
    const html = renderToStaticMarkup(<OperationsDashboard data={fixture()} />);
    for (const value of ["研究抓取", "抓取可用率", "AI 任务", "本期模型成本", "统一行动中心", "产品推进漏斗", "交付就绪度", "风险信号", "我的待办"]) expect(html).toContain(value);
    expect(html).toContain("Amazon 导出"); expect(html).toContain("设计已逾期");
    expect(html).toContain('/products?status=researching'); expect(html).toContain('/research?dateFrom=2026-07-01&amp;dateTo=2026-07-18');
    expect(html).toContain('/research?dateFrom=2026-07-01&amp;dateTo=2026-07-18&amp;captureStatus=failed'); expect(html).toContain('/design?status=overdue'); expect(html).toContain('id="ai-ledger"'); expect(html).toContain("最近记录");
    expect(html).not.toContain("销售额"); expect(html).not.toContain("订单量");
  });
  it("shows explicit empty states", () => { const data = fixture(); data.risks = []; data.recentActivity = []; data.myTasks = []; data.jobs = []; const html = renderToStaticMarkup(<OperationsDashboard data={data} />); expect(html).toContain("当前无待处理事项"); expect(html).toContain("当前没有运行中的后台任务"); expect(html).toContain("所选时间段内暂无活动"); });
});

function fixture(): OperationsDashboardView { return { generatedAt: "2026-07-18T04:10:00Z", range: { from: "2026-07-01", to: "2026-07-18", timezone: "Asia/Shanghai" }, capture: { total: 38, complete: 32, partial: 4, failed: 2, successRate: 94.7 }, ai: { queued: 2, running: 1, costUsd: 12.48 }, aiLedger: [{ id: "ledger", taskType: "AI-03", modelKey: "analyst.pricing", provider: "openai", amountUsd: 12.48, occurredAt: "2026-07-18T04:00:00Z" }], productFunnel: { researching: 8, pending_approval: 3, approved: 5, developing: 4, listing: 2, ready: 1 }, design: { overdue: 2, active: 7 }, listing: { total: 5, averageCompleteness: 86, blockers: 3 }, freshness: { capture: "2026-07-18T03:00:00Z", ai: "2026-07-18T04:00:00Z", product: "2026-07-18T02:00:00Z", design: "2026-07-18T03:30:00Z", listing: "2026-07-18T03:45:00Z" }, risks: [{ kind: "capture_failed", count: 2, label: "抓取失败" }, { kind: "design_overdue", count: 2, label: "设计已逾期" }], recentActivity: [{ id: "a", action: "listing.review.approve", entityType: "listing_review", result: "success", occurredAt: "2026-07-18T04:00:00Z" }], myTasks: [{ id: "t", title: "Travel mug production proof", status: "in_review", dueAt: "2026-07-19T00:00:00Z" }], jobs: [{ id: "j", jobId: "job", label: "Amazon 导出", state: "failed", progress: 71, message: "研究素材被阻断", occurredAt: "2026-07-18T04:00:00Z" }], notifications: [] }; }
