import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import { DashboardService, toUtcRange, type DashboardRepository } from "./dashboard.service.js";

const userId = createEntityId();
const tenantA: TenantContext = { tenantId: createEntityId(), userId, permissions: [], dataScope: "tenant" };
const tenantB: TenantContext = { tenantId: createEntityId(), userId, permissions: [], dataScope: "tenant" };

describe("dashboard service", () => {
  it("counts only the current tenant's captures and AI cost", async () => {
    const repository = new TenantMetrics(); const service = new DashboardService(repository);
    repository.seed(tenantA.tenantId, 3, 1.25); repository.seed(tenantB.tenantId, 9, 8.5);
    const metrics = await service.getMetrics(tenantA, { from: "2026-07-01", to: "2026-07-18", timezone: "Asia/Shanghai" });
    expect(metrics.capture.total).toBe(3); expect(metrics.ai.costUsd).toBe(1.25);
  });

  it("converts user-local date boundaries to UTC and handles empty state", async () => {
    const range = toUtcRange({ from: "2026-07-18", to: "2026-07-18", timezone: "Asia/Shanghai" });
    expect(range.from.toISOString()).toBe("2026-07-17T16:00:00.000Z");
    expect(range.toExclusive.toISOString()).toBe("2026-07-18T16:00:00.000Z");
    const metrics = await new DashboardService(new TenantMetrics()).getMetrics(tenantA, { from: "2026-07-18", to: "2026-07-18", timezone: "UTC" });
    expect(metrics).toMatchObject({ capture: { total: 0, successRate: 0 }, listing: { total: 0, averageCompleteness: 0 }, risks: [] });
  });

  it("surfaces overdue, failed-job, and Listing risks without sales metrics", async () => {
    const repository = new TenantMetrics(); repository.seed(tenantA.tenantId, 2, 0.5, { overdue: 2, blockers: 3, failedJobs: 1 });
    const metrics = await new DashboardService(repository).getMetrics(tenantA, { from: "2026-07-01", to: "2026-07-18", timezone: "UTC" });
    expect(metrics.risks.map((risk) => risk.kind)).toEqual(["design_overdue", "listing_blocker", "job_failed"]);
    expect(metrics).not.toHaveProperty("orders"); expect(metrics).not.toHaveProperty("sales");
  });
});

class TenantMetrics implements DashboardRepository {
  private readonly rows = new Map<string, { captures: number; cost: number; overdue: number; blockers: number; failedJobs: number }>();
  seed(tenantId: string, captures: number, cost: number, patch: Partial<{ overdue: number; blockers: number; failedJobs: number }> = {}) { this.rows.set(tenantId, { captures, cost, overdue: patch.overdue ?? 0, blockers: patch.blockers ?? 0, failedJobs: patch.failedJobs ?? 0 }); }
  async getMetrics(context: TenantContext) {
    const row = this.rows.get(context.tenantId) ?? { captures: 0, cost: 0, overdue: 0, blockers: 0, failedJobs: 0 };
    return { capture: { total: row.captures, complete: row.captures, partial: 0, failed: 0, successRate: row.captures ? 100 : 0 }, ai: { queued: 0, running: 0, costUsd: row.cost }, aiLedger: [], productFunnel: {}, design: { overdue: row.overdue, active: row.overdue }, listing: { total: row.blockers ? 1 : 0, averageCompleteness: row.blockers ? 70 : 0, blockers: row.blockers }, freshness: { capture: null, ai: null, product: null, design: null, listing: null }, jobs: [], failedJobs: row.failedJobs, recentActivity: [], myTasks: [] };
  }
}
