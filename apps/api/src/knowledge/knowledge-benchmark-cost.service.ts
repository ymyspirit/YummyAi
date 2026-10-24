import { ConflictException, Inject, Injectable, NotFoundException, PreconditionFailedException, UnprocessableEntityException } from "@nestjs/common";
import { openBenchmarkValue, sealBenchmarkValue, summarizeBenchmarkArmCost, type SecretVault } from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  BENCHMARK_COST_VERSION, BenchmarkCostSummarySchema, BenchmarkExpenseSchema,
  BenchmarkPageQuerySchema, BenchmarkReportPageSchema, BenchmarkReportSchema,
  CreateBenchmarkReportSchema, RecordBenchmarkExpenseSchema,
  type BenchmarkCostSummary, type BenchmarkExpense, type BenchmarkReport,
} from "@yummyai/contracts/knowledge/benchmark";
import { knowledgeBenchmarkExpenses as expenses, knowledgeBenchmarkReports as reports, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { ZodError } from "zod";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import {
  assertBenchmarkFieldsScope, benchmarkChecksum, benchmarkId, benchmarkInput, benchmarkReadOptions,
  currentBenchmarkContext, recordBenchmarkCommand, replayBenchmarkCommand,
} from "./knowledge-benchmark-dataset.service.js";
import { KnowledgeBenchmarkExperimentService, lockBenchmarkExperiment, requireBenchmarkExperiment } from "./knowledge-benchmark-experiment.service.js";
import { recordKnowledgeGovernanceEvent } from "./knowledge-import.service.js";

function expenseView(row: typeof expenses.$inferSelect): BenchmarkExpense {
  return BenchmarkExpenseSchema.parse({ id: row.id, experimentId: row.experimentId, arm: row.arm,
    previousId: row.previousId, sequence: row.sequence, storageUsd: row.storageUsd, maintenanceUsd: row.maintenanceUsd,
    activityFingerprint: row.activityFingerprint, periodStart: row.periodStart.toISOString(), periodEnd: row.periodEnd.toISOString(),
    allocationBasis: row.allocationBasis, createdAt: row.createdAt.toISOString() });
}
function reportChecksum(value: Omit<BenchmarkReport, "manifestChecksum">) { return benchmarkChecksum(value); }
function serializationRollback(error: unknown): boolean {
  let current = error;
  const visited = new Set<object>();
  for (let depth = 0; depth < 8 && current && typeof current === "object" && !visited.has(current); depth++) {
    visited.add(current);
    const failure = current as { code?: unknown; cause?: unknown };
    if (failure.code === "40001") return true;
    current = failure.cause;
  }
  return false;
}
async function retryReportSnapshot<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) { if (attempt >= 2 || !serializationRollback(error)) throw error; }
  }
}
function reportView(vault: SecretVault, row: typeof reports.$inferSelect) {
  try {
    const value = BenchmarkReportSchema.parse(row.manifest);
    const { manifestChecksum, ...body } = value;
    const proof = openBenchmarkValue<{ tenantId: string; createdBy: string; manifest: BenchmarkReport }>(vault, "report", row.proof);
    if (value.id !== row.id || value.experimentId !== row.experimentId || value.sequence !== row.sequence || value.createdAt !== row.createdAt.toISOString() ||
      manifestChecksum !== row.manifestChecksum || manifestChecksum !== reportChecksum(body) || proof.tenantId !== row.tenantId ||
      proof.createdBy !== row.createdBy || benchmarkChecksum(proof.manifest) !== benchmarkChecksum(value)) throw new Error("benchmark_report_invalid");
    return value;
  } catch { throw new ConflictException("benchmark_report_unavailable"); }
}

@Injectable()
export class KnowledgeBenchmarkCostService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(KnowledgeBenchmarkExperimentService) private readonly experiments: KnowledgeBenchmarkExperimentService,
    @Inject(AI_ASSIST_VAULT) private readonly vault: SecretVault,
  ) {}

  async snapshotInTransaction(tx: TenantTransaction, current: TenantContext, id: string) {
    const value = await this.experiments.stateInTransaction(tx, current, benchmarkId(id));
    const expenseRows = await tx.selectDistinctOn([expenses.arm]).from(expenses).where(eq(expenses.experimentId, value.row.id))
      .orderBy(expenses.arm, desc(expenses.sequence));
    const latestExpenses = expenseRows.map(expenseView);
    const [clock] = await tx.execute<{ now: string }>(sql`select transaction_timestamp() as now`);
    const asOf = new Date(clock!.now).toISOString();
    const arms = (["baseline", "candidate"] as const).map(arm => {
      const armAttempts = value.attempts.filter(row => row.arm === arm), ids = new Set(armAttempts.map(row => row.id));
      const armReviews = value.reviewRows.filter(row => ids.has(row.attemptId));
      const activityFingerprint = benchmarkChecksum({ version: 1, experimentId: value.row.id, arm,
        attemptIds: armAttempts.map(row => row.id).sort(),
        assessmentIds: value.assessmentRows.filter(row => ids.has(row.attemptId)).map(row => row.id).sort(),
        reviewIds: armReviews.map(row => row.id).sort() });
      const outcomes = value.version.items.map(item => {
        const latest = armAttempts.filter(row => row.itemId === item.id).sort((a, b) => b.ordinal - a.ordinal)[0];
        return { state: latest?.state ?? "not_started" as const, hardPass: latest?.assessment?.hardPass ?? null, reviewDecision: latest?.review?.decision ?? null };
      });
      try {
        return summarizeBenchmarkArmCost({ arm, totalItems: value.row.itemCount, activityFingerprint, outcomes,
          attempts: armAttempts.map(row => ({ id: row.id, modelCost: row.modelCost })),
          reviews: armReviews.map(row => ({ id: row.id, minutes: row.minutes, hourlyUsd: row.hourlyUsd })),
          expense: latestExpenses.find(row => row.arm === arm) ?? null });
      } catch (error) {
        if (error instanceof ZodError || error instanceof RangeError) throw new UnprocessableEntityException("benchmark_cost_unrepresentable");
        throw error;
      }
    });
    const summary = BenchmarkCostSummarySchema.parse({ experimentId: value.row.id, currency: "USD", policyVersion: BENCHMARK_COST_VERSION,
      asOf, baseline: arms[0], candidate: arms[1], latestExpenses });
    return { ...value, expenseRows, summary };
  }

  async summary(ceiling: TenantContext, rawId: string): Promise<BenchmarkCostSummary> {
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling);
      return (await this.snapshotInTransaction(tx, current, rawId)).summary;
    }, benchmarkReadOptions);
  }

  async expense(ceiling: TenantContext, rawId: string, raw: unknown) {
    const id = benchmarkId(rawId), input = benchmarkInput(RecordBenchmarkExpenseSchema, raw);
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling, "review"), prior = await replayBenchmarkCommand(tx, current, "expense.record", id, input);
      if (prior) return prior;
      await lockBenchmarkExperiment(tx, current, id);
      const value = await this.snapshotInTransaction(tx, current, id);
      assertBenchmarkFieldsScope(current, value.row.dataScope, value.version.items.map(item => item.fields), "review");
      const latest = value.expenseRows.find(row => row.arm === input.arm), arm = value.summary[input.arm];
      if ((latest?.id ?? null) !== input.expectedExpenseId) throw new ConflictException("benchmark_expense_changed");
      if (input.expectedActivityFingerprint !== arm.activityFingerprint) throw new ConflictException("benchmark_activity_changed");
      const relevantIds = new Set(value.attemptRows.filter(row => row.arm === input.arm).map(row => row.id));
      const latestActivity = Math.max(value.row.createdAt.getTime(),
        ...value.attemptRows.filter(row => relevantIds.has(row.id)).map(row => row.createdAt.getTime()),
        ...value.assessmentRows.filter(row => relevantIds.has(row.attemptId)).map(row => row.createdAt.getTime()),
        ...value.reviewRows.filter(row => relevantIds.has(row.attemptId)).map(row => row.createdAt.getTime()));
      if (Date.parse(input.periodStart) > value.row.createdAt.getTime() || Date.parse(input.periodEnd) < latestActivity)
        throw new PreconditionFailedException("benchmark_expense_period_uncovered");
      const [time] = await tx.execute<{ future: boolean }>(sql`select ${input.periodEnd}::timestamptz > knowledge_benchmark_now()+interval '5 seconds' as future`);
      if (!time || time.future) throw new PreconditionFailedException("benchmark_expense_period_future");
      const expenseId = createEntityId(), sequence = (latest?.sequence ?? 0) + 1, createdAt = new Date();
      await tx.insert(expenses).values({ id: expenseId, tenantId: current.tenantId, createdBy: current.userId, creationTransactionId: "0", createdAt,
        experimentId: id, arm: input.arm, previousId: input.expectedExpenseId, sequence, storageUsd: input.storageUsd, maintenanceUsd: input.maintenanceUsd,
        activityFingerprint: input.expectedActivityFingerprint, periodStart: new Date(input.periodStart), periodEnd: new Date(input.periodEnd), allocationBasis: input.allocationBasis });
      const receipt = { id: expenseId, revision: sequence };
      await recordKnowledgeGovernanceEvent(tx, current, expenseId, "benchmark.expense.record", input.allocationBasis, { experimentId: id, arm: input.arm, sequence });
      await recordBenchmarkCommand(tx, current, "expense.record", id, input, receipt, value.row.dataScope, createdAt);
      return receipt;
    });
  }

  async report(ceiling: TenantContext, rawId: string, raw: unknown) {
    const id = benchmarkId(rawId), input = benchmarkInput(CreateBenchmarkReportSchema, raw);
    return retryReportSnapshot(() => withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling, "review"), prior = await replayBenchmarkCommand(tx, current, "report.create", id, input);
      if (prior) return prior;
      await lockBenchmarkExperiment(tx, current, id);
      const value = await this.snapshotInTransaction(tx, current, id);
      assertBenchmarkFieldsScope(current, value.row.dataScope, value.version.items.map(item => item.fields), "review");
      const attemptIds = value.attemptRows.map(row => row.id).sort(), assessmentIds = value.assessmentRows.map(row => row.id).sort(),
        reviewIds = value.reviewRows.map(row => row.id).sort(), expenseIds = value.expenseRows.map(row => row.id).sort(),
        billingReceiptIds = [...new Set([...value.billing.values()].map(row => row.id))].sort();
      if (reviewIds.length > 3000 || attemptIds.length > 300 || assessmentIds.length > 300 || billingReceiptIds.length > 250)
        throw new ConflictException("benchmark_report_evidence_limit");
      const [latest] = await tx.select({ sequence: reports.sequence }).from(reports).where(eq(reports.experimentId, id)).orderBy(desc(reports.sequence)).limit(1);
      const reportId = createEntityId(), sequence = (latest?.sequence ?? 0) + 1, createdAt = new Date();
      const body = { id: reportId, experimentId: id, sequence, datasetVersionId: value.version.row.id, datasetChecksum: value.version.row.checksum,
        baselineVersion: value.row.baselineVersion, graderVersion: value.row.graderVersion, createdAt: createdAt.toISOString(),
        attemptIds, assessmentIds, reviewIds, expenseIds, billingReceiptIds, summary: value.summary };
      const manifest = BenchmarkReportSchema.parse({ ...body, manifestChecksum: benchmarkChecksum(body) });
      const [inserted] = await tx.insert(reports).values({ id: reportId, tenantId: current.tenantId, createdBy: current.userId, creationTransactionId: "0", createdAt,
        experimentId: id, sequence, manifestChecksum: manifest.manifestChecksum, manifest,
        proof: sealBenchmarkValue(this.vault, "report", { tenantId: current.tenantId, createdBy: current.userId, manifest }) })
        .onConflictDoNothing().returning({ id: reports.id });
      if (!inserted) throw new ConflictException("benchmark_report_changed");
      const receipt = { id: reportId, revision: sequence };
      await recordKnowledgeGovernanceEvent(tx, current, reportId, "benchmark.report.create", input.reason, { experimentId: id, sequence, manifestChecksum: manifest.manifestChecksum });
      await recordBenchmarkCommand(tx, current, "report.create", id, input, receipt, value.row.dataScope, createdAt);
      return receipt;
    }, benchmarkReadOptions));
  }

  async reports(ceiling: TenantContext, rawId: string, raw: unknown = {}) {
    const id = benchmarkId(rawId), query = benchmarkInput(BenchmarkPageQuerySchema, raw);
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling);
      await requireBenchmarkExperiment(tx, current, id);
      if (query.cursor) {
        const [anchor] = await tx.select({ id: reports.id }).from(reports).where(and(eq(reports.id, query.cursor), eq(reports.experimentId, id), eq(reports.createdBy, current.userId)));
        if (!anchor) throw new NotFoundException("benchmark_cursor_not_found");
      }
      const rows = await tx.select().from(reports).where(and(eq(reports.experimentId, id), eq(reports.createdBy, current.userId), query.cursor ? lt(reports.id, query.cursor) : undefined))
        .orderBy(desc(reports.id)).limit(query.limit + 1);
      const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(reports).where(eq(reports.experimentId, id));
      return BenchmarkReportPageSchema.parse({ items: rows.slice(0, query.limit).map(row => reportView(this.vault, row)), total: count!.total,
        nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null });
    }, benchmarkReadOptions);
  }

  async readReport(ceiling: TenantContext, rawId: string) {
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling), [row] = await tx.select().from(reports).where(and(eq(reports.id, benchmarkId(rawId)), eq(reports.createdBy, current.userId)));
      if (!row) throw new NotFoundException("benchmark_report_not_found");
      await requireBenchmarkExperiment(tx, current, row.experimentId);
      return reportView(this.vault, row);
    }, benchmarkReadOptions);
  }
}
