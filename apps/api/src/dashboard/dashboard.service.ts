import { Inject, Injectable } from "@nestjs/common";
import type { TenantContext } from "@yummyai/contracts";
import {
  aiBudgetLedger,
  auditEvents,
  captureSnapshots,
  designTasks,
  jobProgressEvents,
  listingVersions,
  listings,
  productPlans,
  type DatabaseConnection,
  withTenant,
} from "@yummyai/database";
import { and, desc, eq, gte, lt, ne, sql } from "drizzle-orm";
import { z } from "zod";

import { DASHBOARD_REPOSITORY, DATABASE_CONNECTION } from "../platform.tokens.js";

export const DashboardDateRangeSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timezone: z.string().min(1).max(80),
}).refine((range) => range.from <= range.to, { message: "from must not be after to", path: ["from"] });

export interface DashboardDateRange { from: string; to: string; timezone: string }
export interface UtcDateRange { from: Date; toExclusive: Date }
export interface DashboardMetrics {
  generatedAt: string;
  range: { from: string; to: string; timezone: string };
  capture: { total: number; complete: number; partial: number; failed: number; successRate: number };
  ai: { queued: number; running: number; costUsd: number };
  aiLedger: Array<{ id: string; taskType: string; modelKey: string; provider: string; amountUsd: number; occurredAt: string }>;
  productFunnel: Record<string, number>;
  design: { overdue: number; active: number };
  listing: { total: number; averageCompleteness: number; blockers: number };
  freshness: Record<"capture" | "ai" | "product" | "design" | "listing", string | null>;
  jobs: Array<{ id: string; jobId: string; label: string; state: "queued" | "running" | "completed" | "failed" | "cancelled"; progress: number; message?: string; occurredAt: string }>;
  risks: Array<{ kind: "capture_failed" | "design_overdue" | "listing_blocker" | "job_failed"; count: number; label: string }>;
  recentActivity: Array<{ id: string; action: string; entityType: string; result: string; occurredAt: string }>;
  myTasks: Array<{ id: string; title: string; status: string; dueAt?: string }>;
}

export interface DashboardRepository { getMetrics(context: TenantContext, range: UtcDateRange): Promise<Omit<DashboardMetrics, "generatedAt" | "range" | "risks"> & { failedJobs: number }>; }

@Injectable()
export class DashboardService {
  constructor(@Inject(DASHBOARD_REPOSITORY) private readonly repository: DashboardRepository) {}

  async getMetrics(context: TenantContext, rawRange: DashboardDateRange): Promise<DashboardMetrics> {
    const range = DashboardDateRangeSchema.parse(rawRange);
    const metrics = await this.repository.getMetrics(context, toUtcRange(range));
    const risks = ([
      { kind: "capture_failed", count: metrics.capture.failed, label: "抓取失败" },
      { kind: "design_overdue", count: metrics.design.overdue, label: "设计已逾期" },
      { kind: "listing_blocker", count: metrics.listing.blockers, label: "刊登阻断项" },
      { kind: "job_failed", count: metrics.failedJobs, label: "任务执行失败" },
    ] satisfies DashboardMetrics["risks"]).filter((risk) => risk.count > 0);
    return { generatedAt: new Date().toISOString(), range, capture: metrics.capture, ai: metrics.ai, aiLedger: metrics.aiLedger, productFunnel: metrics.productFunnel, design: metrics.design, listing: metrics.listing, freshness: metrics.freshness, jobs: metrics.jobs, recentActivity: metrics.recentActivity, myTasks: metrics.myTasks, risks };
  }
}

@Injectable()
export class DrizzleDashboardRepository implements DashboardRepository {
  constructor(@Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection) {}

  async getMetrics(context: TenantContext, range: UtcDateRange) {
    const captures = await withTenant(this.database.db, context, (tx) => tx.select({ status: captureSnapshots.status, count: sql<number>`count(*)::int`, latest: sql<Date | null>`max(${captureSnapshots.capturedAt})` }).from(captureSnapshots).where(and(gte(captureSnapshots.capturedAt, range.from), lt(captureSnapshots.capturedAt, range.toExclusive))).groupBy(captureSnapshots.status));
    const ledgerRows = await withTenant(this.database.db, context, (tx) => tx.select({ id: aiBudgetLedger.id, taskType: aiBudgetLedger.taskType, modelKey: aiBudgetLedger.modelKey, provider: aiBudgetLedger.provider, amountUsd: aiBudgetLedger.amountUsd, createdAt: aiBudgetLedger.createdAt }).from(aiBudgetLedger).where(and(eq(aiBudgetLedger.state, "committed"), gte(aiBudgetLedger.createdAt, range.from), lt(aiBudgetLedger.createdAt, range.toExclusive))).orderBy(desc(aiBudgetLedger.createdAt)).limit(100));
    const jobRows = await withTenant(this.database.db, context, (tx) => tx.select().from(jobProgressEvents).where(lt(jobProgressEvents.occurredAt, range.toExclusive)).orderBy(desc(jobProgressEvents.occurredAt)).limit(2_000));
    const productRows = await withTenant(this.database.db, context, (tx) => tx.select({ status: productPlans.status, count: sql<number>`count(*)::int`, latest: sql<Date | null>`max(${productPlans.updatedAt})` }).from(productPlans).groupBy(productPlans.status));
    const activeDesigns = await withTenant(this.database.db, context, (tx) => tx.select({ id: designTasks.id, title: designTasks.title, status: designTasks.status, dueAt: designTasks.dueAt, createdBy: designTasks.createdBy, updatedAt: designTasks.updatedAt }).from(designTasks).where(and(ne(designTasks.status, "approved"), ne(designTasks.status, "archived"))));
    const listingRows = await withTenant(this.database.db, context, (tx) => tx.select({ listingId: listings.id, versionId: listingVersions.id, completeness: sql<number>`coalesce((${listingVersions.validation}->>'completeness')::numeric, 0)`, blockerCount: sql<number>`jsonb_array_length(coalesce(${listingVersions.validation}->'blockers', '[]'::jsonb))`, createdAt: listingVersions.createdAt }).from(listings).innerJoin(listingVersions, eq(listingVersions.listingId, listings.id)).orderBy(desc(listingVersions.versionNumber)));
    const activityRows = await withTenant(this.database.db, context, (tx) => tx.select({ id: auditEvents.id, action: auditEvents.action, entityType: auditEvents.entityType, result: auditEvents.result, occurredAt: auditEvents.occurredAt }).from(auditEvents).where(and(gte(auditEvents.occurredAt, range.from), lt(auditEvents.occurredAt, range.toExclusive))).orderBy(desc(auditEvents.occurredAt)).limit(12));

    const captureByStatus = Object.fromEntries(captures.map((row) => [row.status, Number(row.count)]));
    const capture = { total: captures.reduce((sum, row) => sum + Number(row.count), 0), complete: captureByStatus.complete ?? 0, partial: captureByStatus.partial ?? 0, failed: captureByStatus.failed ?? 0, successRate: 0 };
    capture.successRate = capture.total ? Math.round(((capture.complete + capture.partial) / capture.total) * 1_000) / 10 : 0;
    const latestJobs = firstBy(jobRows, (row) => row.jobId);
    const latestListings = firstBy(listingRows, (row) => row.listingId);
    const now = new Date();
    const overdue = activeDesigns.filter((task) => task.dueAt && task.dueAt < now).length;
    return {
      capture,
      ai: { queued: latestJobs.filter((job) => job.state === "queued").length, running: latestJobs.filter((job) => job.state === "running").length, costUsd: ledgerRows.reduce((sum, row) => sum + Number(row.amountUsd), 0) },
      aiLedger: ledgerRows.slice(0, 12).map((row) => ({ id: row.id, taskType: row.taskType, modelKey: row.modelKey, provider: row.provider, amountUsd: Number(row.amountUsd), occurredAt: row.createdAt.toISOString() })),
      productFunnel: Object.fromEntries(productRows.map((row) => [row.status, Number(row.count)])),
      design: { overdue, active: activeDesigns.length },
      listing: { total: latestListings.length, averageCompleteness: latestListings.length ? Math.round(latestListings.reduce((sum, row) => sum + Number(row.completeness), 0) / latestListings.length) : 0, blockers: latestListings.reduce((sum, row) => sum + Number(row.blockerCount), 0) },
      freshness: {
        capture: latestIso(captures.map((row) => row.latest)),
        ai: latestIso([...ledgerRows.map((row) => row.createdAt), ...latestJobs.map((row) => row.occurredAt)]),
        product: latestIso(productRows.map((row) => row.latest)),
        design: latestIso(activeDesigns.map((row) => row.updatedAt)),
        listing: latestIso(latestListings.map((row) => row.createdAt)),
      },
      jobs: latestJobs.filter((job) => ["queued", "running", "failed"].includes(job.state)).slice(0, 12).map((job) => ({
        id: job.id,
        jobId: job.jobId,
        label: jobLabel(job.metadata, job.jobId),
        state: job.state as DashboardMetrics["jobs"][number]["state"],
        progress: job.progress,
        ...(job.message ? { message: job.message } : {}),
        occurredAt: job.occurredAt.toISOString(),
      })),
      failedJobs: latestJobs.filter((job) => job.state === "failed").length,
      recentActivity: activityRows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() })),
      myTasks: activeDesigns.filter((task) => task.createdBy === context.userId).slice(0, 8).map((task) => ({ id: task.id, title: task.title, status: task.status, dueAt: task.dueAt?.toISOString() })),
    };
  }
}

export function toUtcRange(range: DashboardDateRange): UtcDateRange {
  DashboardDateRangeSchema.parse(range);
  return { from: zonedMidnight(range.from, range.timezone), toExclusive: zonedMidnight(nextDate(range.to), range.timezone) };
}

function zonedMidnight(date: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const guess = Date.UTC(year, month - 1, day);
  const formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  let target = guess;
  for (let index = 0; index < 2; index += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(target)).map((part) => [part.type, part.value]));
    const displayed = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
    target += guess - displayed;
  }
  return new Date(target);
}

function nextDate(date: string) { const [year, month, day] = date.split("-").map(Number) as [number, number, number]; return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10); }
function firstBy<T>(rows: readonly T[], key: (row: T) => string) { const seen = new Set<string>(); return rows.filter((row) => { const value = key(row); if (seen.has(value)) return false; seen.add(value); return true; }); }
function latestIso(values: ReadonlyArray<Date | string | null | undefined>) { const timestamps = values.flatMap((value) => value ? [new Date(value).getTime()] : []).filter(Number.isFinite); return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null; }
function jobLabel(metadata: Record<string, unknown>, jobId: string) { const label = metadata.label ?? metadata.taskType ?? metadata.kind; return typeof label === "string" && label.trim() ? label : `任务 ${jobId.slice(0, 12)}`; }
