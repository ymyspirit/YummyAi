import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  AnalysisReportSchema,
  AnalysisRequestSchema,
  createEntityId,
  type AnalysisReport,
  type AnalysisRequest,
  type TenantContext,
} from "@yummyai/contracts";
import { analysisReports, type DatabaseConnection, withTenant } from "@yummyai/database";
import type { JobEnvelope } from "@yummyai/jobs";
import { and, asc, desc, eq } from "drizzle-orm";

import { ANALYSIS_JOB_ENQUEUER, DATABASE_CONNECTION } from "../platform.tokens.js";

export interface AnalysisJobEnqueuer {
  enqueue(envelope: JobEnvelope): Promise<void>;
}

@Injectable()
export class AnalysisService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(ANALYSIS_JOB_ENQUEUER) private readonly jobs: AnalysisJobEnqueuer,
  ) {}

  async create(context: TenantContext, rawInput: AnalysisRequest) {
    const input = AnalysisRequestSchema.parse(rawInput);
    const jobId = createEntityId();
    const reportSeriesId = input.reportSeriesId ?? createEntityId();
    const envelope: JobEnvelope = {
      jobId,
      tenantId: context.tenantId,
      requestedBy: context.userId,
      correlationId: createEntityId(),
      idempotencyKey: createEntityId(),
      requestedAt: new Date().toISOString(),
      attempt: 0,
      maxAttempts: 3,
      payload: { ...input, reportSeriesId },
    };
    await this.jobs.enqueue(envelope);
    return { jobId, reportSeriesId, status: "queued" as const };
  }

  async latest(context: TenantContext, reportSeriesId: string): Promise<AnalysisReport> {
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ report: analysisReports.report })
        .from(analysisReports)
        .where(and(eq(analysisReports.tenantId, context.tenantId), eq(analysisReports.reportSeriesId, reportSeriesId)))
        .orderBy(desc(analysisReports.version))
        .limit(1),
    );
    if (!row) throw new NotFoundException("Analysis report not found");
    return AnalysisReportSchema.parse(row.report);
  }

  async versions(context: TenantContext, reportSeriesId: string): Promise<AnalysisReport[]> {
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ report: analysisReports.report })
        .from(analysisReports)
        .where(and(eq(analysisReports.tenantId, context.tenantId), eq(analysisReports.reportSeriesId, reportSeriesId)))
        .orderBy(asc(analysisReports.version)),
    );
    return rows.map((row) => AnalysisReportSchema.parse(row.report));
  }
}
