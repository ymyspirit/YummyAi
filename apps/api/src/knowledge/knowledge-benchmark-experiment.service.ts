import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import {
  assistPromptVersion, authenticateKnowledgeEvaluation, gradeBenchmark, gradeBusinessBenchmark, openBenchmarkValue, runBenchmarkBaseline, runBusinessBenchmarkBaseline,
  sealBenchmarkValue, runRoleBenchmarkBaseline, gradeRoleBenchmark, type SecretVault,
} from "@yummyai/ai-core";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { AssistModelSchema, AssistResultSchema, type AssistResult } from "@yummyai/contracts/ai/assist";
import {
  BENCHMARK_COST_VERSION, ROLE_BENCHMARK_RULE_VERSION, BenchmarkAssessmentSchema,
  BenchmarkAttemptPageQuerySchema, BenchmarkAttemptPageSchema, BenchmarkAttemptSchema,
  BenchmarkExperimentPageSchema, BenchmarkExperimentSchema, BenchmarkExperimentSummarySchema,
  BenchmarkPageQuerySchema, BenchmarkReviewSchema, CreateBenchmarkExperimentSchema,
  ReviewBenchmarkAttemptSchema, StartBenchmarkAttemptSchema,
  benchmarkCaseLabel, benchmarkExecutionVersions, type BenchmarkAssessment, type BenchmarkAttempt, type BenchmarkReview,
} from "@yummyai/contracts/knowledge/benchmark";
import { KnowledgeEvaluationAssessmentSchema, KnowledgeEvaluationProtocolSchema } from "@yummyai/contracts/knowledge/evaluation-protocol";
import {
  aiAssistExecutions, aiAssistRuns, knowledgeBenchmarkAssessments as assessments,
  knowledgeBenchmarkAttempts as attempts, knowledgeBenchmarkExperiments as experiments,
  knowledgeBenchmarkReviews as reviews, knowledgeEvaluationAssessments as nativeAssessments,
  knowledgeEvaluationProtocols as protocols, knowledgeEvaluationRuns as evaluationRuns,
  modelRoutes, readModelBillingAcknowledgments, readModelExecutionRouteFingerprint,
  withTenant, type DatabaseConnection, type TenantTransaction,
} from "@yummyai/database";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { configuredAssistModels } from "../ai/configured-assist-models.js";
import { KnowledgeEvaluationService } from "./knowledge-evaluation.service.js";
import {
  assertBenchmarkFieldsScope, benchmarkChecksum, benchmarkId, benchmarkInput, benchmarkReadOptions, benchmarkRequestChecksum,
  currentBenchmarkContext, readBenchmarkBasis, benchmarkGuidanceCurrentInTransaction, recordBenchmarkCommand, replayBenchmarkCommand,
  requireBenchmarkVersion, type BenchmarkReceipt,
} from "./knowledge-benchmark-dataset.service.js";
import { recordKnowledgeGovernanceEvent } from "./knowledge-import.service.js";
import { businessBenchmarkTaskScope, KnowledgeBenchmarkBusinessService } from "./knowledge-benchmark-business.service.js";

export type BenchmarkExperimentRow = typeof experiments.$inferSelect;
export function benchmarkExperimentSummary(row: BenchmarkExperimentRow) {
  return BenchmarkExperimentSummarySchema.parse({ id: row.id, datasetVersionId: row.datasetVersionId, label: row.label,
    baselineVersion: row.baselineVersion, modelId: row.modelId, model: row.modelSnapshot, routeFingerprint: row.routeFingerprint, maxAttemptsPerItem: row.maxAttemptsPerItem,
    itemCount: row.itemCount, dataScope: row.dataScope, createdAt: row.createdAt.toISOString() });
}
export async function requireBenchmarkExperiment(tx: TenantTransaction, context: TenantContext, id: string, operation: "read" | "run" | "review" = "read", includeBasis = false) {
  const [row] = await tx.select().from(experiments).where(and(eq(experiments.id, id), eq(experiments.createdBy, context.userId)));
  if (!row) throw new NotFoundException("benchmark_experiment_not_found");
  const version = await requireBenchmarkVersion(tx, context, row.datasetVersionId, operation === "run" ? "run" : "read", includeBasis);
  assertBenchmarkFieldsScope(context, row.dataScope, version.items.map(item => item.fields), operation);
  if (row.itemCount !== version.items.length) throw new ConflictException("benchmark_version_incomplete");
  const business = version.items[0]?.fields.role !== "knowledge_answer";
  const expected = benchmarkExecutionVersions(version.items.map(item => item.fields.role));
  if (version.items.some(item => (item.fields.role !== "knowledge_answer") !== business) ||
    row.baselineVersion !== expected.baselineVersion || row.graderVersion !== expected.graderVersion)
    throw new ConflictException("benchmark_baseline_invalid");
  return { row, version };
}
export async function lockBenchmarkExperiment(tx: TenantTransaction, context: TenantContext, id: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge-benchmark-experiment:${context.tenantId}:${id}`},0))`);
}
export function benchmarkReviewView(row: typeof reviews.$inferSelect): BenchmarkReview {
  return BenchmarkReviewSchema.parse({ id: row.id, attemptId: row.attemptId, previousId: row.previousId, sequence: row.sequence,
    decision: row.decision, minutes: row.minutes, hourlyUsd: row.hourlyUsd, reason: row.reason, createdAt: row.createdAt.toISOString() });
}
type AssessmentHeader = Omit<typeof assessments.$inferSelect, "encryptedOutput">;
export function benchmarkAssessmentView(vault: SecretVault, row: AssessmentHeader): BenchmarkAssessment {
  try {
    const value = BenchmarkAssessmentSchema.parse({ id: row.id, attemptId: row.attemptId, graderVersion: row.graderVersion,
      caseChecksum: row.caseChecksum, basisFingerprint: row.basisFingerprint, outputChecksum: row.outputChecksum,
      hardPass: row.hardPass, checks: row.checks, createdAt: row.createdAt.toISOString() });
    const proof = openBenchmarkValue<{ tenantId: string; createdBy: string; assessment: BenchmarkAssessment }>(vault, "assessment", row.proof);
    if (proof.tenantId !== row.tenantId || proof.createdBy !== row.createdBy || benchmarkChecksum(proof.assessment) !== benchmarkChecksum(value))
      throw new Error("benchmark_assessment_invalid");
    return value;
  } catch { throw new ConflictException("benchmark_assessment_unavailable"); }
}

/** Private metadata only: neither native input/output ciphertext nor dataset basis is selected. */
async function nativeBenchmarkEvidence(tx: TenantTransaction, context: TenantContext, ids: string[], vault: SecretVault) {
  if (!ids.length) return [];
  const rows = await tx.select({ run: evaluationRuns, native: {
    id: aiAssistRuns.id, tenantId: aiAssistRuns.tenantId, ownerId: aiAssistRuns.ownerId,
    requestId: aiAssistRuns.requestId, kind: aiAssistRuns.kind, scope: aiAssistRuns.scope,
    inputFingerprint: aiAssistRuns.inputFingerprint, promptVersion: aiAssistRuns.promptVersion,
    modelSnapshot: aiAssistRuns.modelSnapshot, status: aiAssistRuns.status, costUsd: aiAssistRuns.costUsd,
    inputTokens: aiAssistRuns.inputTokens, outputTokens: aiAssistRuns.outputTokens, expiresAt: aiAssistRuns.expiresAt,
    outputRetained: sql<boolean>`${aiAssistRuns.encryptedOutput} is not null`, inputRetained: sql<boolean>`${aiAssistRuns.encryptedInput} is not null`,
  }, protocol: protocols, assessment: nativeAssessments, execution: {
    phase: aiAssistExecutions.phase, submissionState: aiAssistExecutions.submissionState,
    attemptCount: aiAssistExecutions.attemptCount,
  } }).from(evaluationRuns).innerJoin(aiAssistRuns, eq(aiAssistRuns.id, evaluationRuns.assistRunId))
    .leftJoin(protocols, eq(protocols.runId, evaluationRuns.id)).leftJoin(nativeAssessments, eq(nativeAssessments.runId, evaluationRuns.id))
    .leftJoin(aiAssistExecutions, eq(aiAssistExecutions.runId, aiAssistRuns.id)).where(inArray(evaluationRuns.id, ids));
  for (const row of rows) {
    if (row.run.createdBy !== context.userId || !row.protocol) throw new ConflictException("benchmark_native_receipt_invalid");
    const p = row.protocol, a = row.assessment;
    try { authenticateKnowledgeEvaluation(vault, { ...row,
      protocolView: KnowledgeEvaluationProtocolSchema.parse({ version: "knowledge-evaluation-v1", runId: p.runId, caseRevision: p.caseRevision,
        caseChecksum: p.caseChecksum, requestChecksum: p.requestChecksum, basisFingerprint: p.basisFingerprint, inputFingerprint: p.inputFingerprint,
        modelId: p.modelId, promptVersion: p.promptVersion, dataScope: p.dataScope, assertionVersion: p.assertionVersion, createdAt: p.createdAt.toISOString() }),
      assessmentView: a ? KnowledgeEvaluationAssessmentSchema.parse({ id: a.id, runId: a.runId, basisFingerprint: a.basisFingerprint,
        outputChecksum: a.outputChecksum, assertionVersion: a.assertionVersion, retrievalRecall: a.retrievalRecall, citedRecall: a.citedRecall,
        checks: a.checks, createdAt: a.createdAt.toISOString() }) : null,
    }); } catch { throw new ConflictException("benchmark_native_receipt_invalid"); }
  }
  return rows;
}

async function businessNativeEvidence(tx: TenantTransaction, ids: string[]) {
  if (!ids.length) return [];
  return tx.select({ native: {
    id: aiAssistRuns.id, tenantId: aiAssistRuns.tenantId, ownerId: aiAssistRuns.ownerId, benchmarkItemId: aiAssistRuns.benchmarkItemId,
    requestId: aiAssistRuns.requestId, kind: aiAssistRuns.kind, scope: aiAssistRuns.scope,
    inputFingerprint: aiAssistRuns.inputFingerprint, promptVersion: aiAssistRuns.promptVersion, modelSnapshot: aiAssistRuns.modelSnapshot,
    status: aiAssistRuns.status, costUsd: aiAssistRuns.costUsd, inputTokens: aiAssistRuns.inputTokens, outputTokens: aiAssistRuns.outputTokens,
    expiresAt: aiAssistRuns.expiresAt, outputRetained: sql<boolean>`${aiAssistRuns.encryptedOutput} is not null`,
    inputRetained: sql<boolean>`${aiAssistRuns.encryptedInput} is not null`,
  }, execution: { phase: aiAssistExecutions.phase, submissionState: aiAssistExecutions.submissionState, attemptCount: aiAssistExecutions.attemptCount } })
    .from(aiAssistRuns).leftJoin(aiAssistExecutions, eq(aiAssistExecutions.runId, aiAssistRuns.id)).where(inArray(aiAssistRuns.id, ids));
}

@Injectable()
export class KnowledgeBenchmarkExperimentService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(KnowledgeEvaluationService) private readonly evaluations: KnowledgeEvaluationService,
    @Inject(AI_ASSIST_VAULT) private readonly vault: SecretVault,
    @Inject(KnowledgeBenchmarkBusinessService) private readonly business?: KnowledgeBenchmarkBusinessService,
  ) {}

  async stateInTransaction(tx: TenantTransaction, current: TenantContext, rawId: string) {
    const value = await requireBenchmarkExperiment(tx, current, benchmarkId(rawId));
    const guidanceAvailability = new Map<string, boolean>();
    for (const item of value.version.items)
      guidanceAvailability.set(item.id, await benchmarkGuidanceCurrentInTransaction(tx, current, this.vault, item));
    const attemptRows = await tx.select().from(attempts).where(eq(attempts.experimentId, value.row.id)).orderBy(attempts.id);
    if (attemptRows.length > 300) throw new ConflictException("benchmark_attempt_limit_invalid");
    const attemptIds = attemptRows.map(row => row.id), itemMap = new Map(value.version.items.map(item => [item.id, item]));
    const assessmentRows = attemptIds.length ? await tx.select({ id: assessments.id, tenantId: assessments.tenantId, createdBy: assessments.createdBy,
      createdAt: assessments.createdAt, creationTransactionId: assessments.creationTransactionId, attemptId: assessments.attemptId,
      graderVersion: assessments.graderVersion, caseChecksum: assessments.caseChecksum, basisFingerprint: assessments.basisFingerprint,
      outputChecksum: assessments.outputChecksum, hardPass: assessments.hardPass, checks: assessments.checks, proof: assessments.proof,
      expiresAt: assessments.expiresAt, outputRetained: sql<boolean>`${assessments.encryptedOutput} is not null` })
      .from(assessments).where(inArray(assessments.attemptId, attemptIds)) : [];
    const reviewRows = attemptIds.length ? await tx.select().from(reviews).where(inArray(reviews.attemptId, attemptIds)).orderBy(reviews.sequence) : [];
    const assessmentMap = new Map(assessmentRows.map(row => [row.attemptId, { row, view: benchmarkAssessmentView(this.vault, row) }]));
    const latestReview = new Map<string, BenchmarkReview>();
    for (const row of reviewRows) latestReview.set(row.attemptId, benchmarkReviewView(row));
    const evaluationIds = attemptRows.flatMap(row => row.evaluationRunId ? [row.evaluationRunId] : []);
    const nativeRows = await nativeBenchmarkEvidence(tx, current, evaluationIds, this.vault);
    const nativeMap = new Map(nativeRows.map(row => [row.run.id, row]));
    const businessRows = await businessNativeEvidence(tx, attemptRows.flatMap(row => row.nativeRunId ? [row.nativeRunId] : []));
    const businessMap = new Map(businessRows.map(row => [row.native.id, row]));
    const nativeIds = [...nativeRows.map(row => row.native.id), ...businessRows.map(row => row.native.id)], billing = new Map<string, Awaited<ReturnType<typeof readModelBillingAcknowledgments>> extends Map<string, infer V> ? V : never>();
    for (let offset = 0; offset < nativeIds.length; offset += 20)
      for (const [id, receipt] of await readModelBillingAcknowledgments(tx, "assist", nativeIds.slice(offset, offset + 20))) billing.set(id, receipt);
    const views: BenchmarkAttempt[] = [];
    for (const row of attemptRows) {
      const item = itemMap.get(row.itemId), sealed = assessmentMap.get(row.id), knowledge = row.evaluationRunId ? nativeMap.get(row.evaluationRunId) : null,
        business = row.nativeRunId ? businessMap.get(row.nativeRunId) : null, native = knowledge ?? business;
      if (!item || row.createdBy !== current.userId || sealed && (sealed.view.caseChecksum !== item.caseChecksum || sealed.view.basisFingerprint !== item.basisFingerprint))
        throw new ConflictException("benchmark_attempt_receipt_invalid");
      if (sealed && sealed.view.graderVersion !== value.row.graderVersion)
        throw new ConflictException("benchmark_assessment_unavailable");
      if (row.arm === "candidate") {
        if (item.fields.role === "knowledge_answer") {
          if (row.nativeRunId || !knowledge || knowledge.run.caseId !== item.caseId || knowledge.native.modelSnapshot.id !== value.row.modelId ||
            knowledge.protocol!.basisFingerprint !== item.basisFingerprint || knowledge.protocol!.caseChecksum !== item.caseChecksum ||
            knowledge.run.requestId !== row.requestId || sealed && (!knowledge.assessment || knowledge.assessment.outputChecksum !== sealed.view.outputChecksum))
            throw new ConflictException("benchmark_native_receipt_invalid");
        } else if (row.evaluationRunId || item.caseId !== null || !business || business.native.benchmarkItemId !== item.id ||
          business.native.ownerId !== current.userId || business.native.tenantId !== current.tenantId || business.native.kind !== item.fields.role ||
          business.native.scope !== businessBenchmarkTaskScope(item.fields) || business.native.requestId !== row.requestId || business.native.modelSnapshot.id !== value.row.modelId ||
          business.native.promptVersion !== assistPromptVersion(false, business.native.kind === "order_review") || business.native.expiresAt > item.expiresAt ||
          business.native.status === "completed" && !sealed)
          throw new ConflictException("benchmark_native_receipt_invalid");
      } else if (row.nativeRunId || row.evaluationRunId) throw new ConflictException("benchmark_attempt_receipt_invalid");
      if (reviewRows.some(review => review.attemptId === row.id && (!sealed || review.assessmentId !== sealed.view.id || review.createdBy !== current.userId)))
        throw new ConflictException("benchmark_review_receipt_invalid");
      const acknowledged = native ? billing.get(native.native.id) : null;
      const submission = native?.execution?.submissionState;
      const notSubmitted = submission === "not_submitted";
      const usageKnown = native && native.native.costUsd !== null && native.native.inputTokens !== null && native.native.outputTokens !== null &&
        native.native.modelSnapshot.inputUsdPerMillion !== null && native.native.modelSnapshot.outputUsdPerMillion !== null;
      const modelCost: BenchmarkAttempt["modelCost"] = row.arm === "baseline" ? { amountUsd: "0.00000000", source: "not_submitted", billingReceiptId: null,
        localProcessingAttempts: 1, confirmedProviderCalls: 0, possibleProviderCalls: 0 } : {
        amountUsd: acknowledged?.amountUsd ?? (usageKnown ? native!.native.costUsd : notSubmitted ? "0.00000000" : null),
        source: acknowledged ? "billing_acknowledged" : usageKnown ? "usage_estimate" : notSubmitted ? "not_submitted" : "unknown",
        billingReceiptId: acknowledged?.id ?? null, localProcessingAttempts: native?.execution?.attemptCount ?? 0,
        confirmedProviderCalls: submission === "received" ? 1 : 0, possibleProviderCalls: submission === "submitted" || !native?.execution ? 1 : 0,
      };
      const state: BenchmarkAttempt["state"] = row.arm === "baseline" ? sealed ? "completed" : "unavailable" :
        native?.execution?.phase === "uncertain" ? "uncertain" : native?.native.status ?? "unavailable";
      const resultAvailable = (row.arm === "baseline" ? !!sealed?.row.outputRetained && sealed.row.expiresAt > new Date() :
        !!native?.native.outputRetained && native.native.inputRetained && native.native.expiresAt > new Date()) && guidanceAvailability.get(item.id) === true;
      views.push(BenchmarkAttemptSchema.parse({ id: row.id, experimentId: row.experimentId, itemId: row.itemId, arm: row.arm, ordinal: row.ordinal,
        requestId: row.requestId, evaluationRunId: row.evaluationRunId, ...(item.fields.role !== "knowledge_answer" ? { nativeRunId: row.nativeRunId } : {}), createdAt: row.createdAt.toISOString(), state,
        assessment: sealed?.view ?? null, review: latestReview.get(row.id) ?? null, modelCost, resultAvailable, result: null }));
    }
    for (const item of value.version.items) if (views.filter(row => row.itemId === item.id && row.arm === "baseline").length !== 1)
      throw new ConflictException("benchmark_baseline_incomplete");
    return { ...value, attemptRows, assessmentRows, reviewRows, nativeRows, businessRows, billing, attempts: views };
  }

  async create(ceiling: TenantContext, raw: unknown) {
    const input = benchmarkInput(CreateBenchmarkExperimentSchema, raw);
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling, "run");
      const prior = await replayBenchmarkCommand(tx, current, "experiment.create", null, input);
      if (prior) return prior;
      const version = await requireBenchmarkVersion(tx, current, input.datasetVersionId, "run", true);
      const expected = benchmarkExecutionVersions(version.items.map(item => item.fields.role));
      if (input.baselineVersion !== expected.baselineVersion)
        throw new ConflictException("benchmark_baseline_invalid");
      const graderVersion = expected.graderVersion;
      const model = (await configuredAssistModels(tx, current.userId)).find(row => row.id === input.modelId);
      const routeFingerprint = await readModelExecutionRouteFingerprint(tx, input.modelId);
      if (!model || !routeFingerprint) throw new ConflictException("benchmark_model_unavailable");
      const id = createEntityId(), createdAt = new Date();
      if (version.row.basisExpiresAt <= createdAt) throw new ConflictException("benchmark_basis_expired");
      const basis = version.items.map(item => ({ item, prepared: readBenchmarkBasis(this.vault, item) }));
      for (const { item, prepared } of basis) {
        if (item.fields.role === "knowledge_answer") await this.evaluations.assertBenchmarkItemInTransaction(tx, current, prepared);
        else {
          if (!this.business) throw new ConflictException("benchmark_business_adapter_unavailable");
          await this.business.assertInTransaction(tx, current, prepared);
        }
      }
      await tx.insert(experiments).values({ id, tenantId: current.tenantId, createdBy: current.userId, creationTransactionId: "0", createdAt,
        datasetVersionId: version.row.id, label: input.label, baselineVersion: input.baselineVersion, graderVersion,
        costVersion: BENCHMARK_COST_VERSION, modelId: input.modelId, modelSnapshot: model, routeFingerprint, maxAttemptsPerItem: input.maxAttemptsPerItem,
        itemCount: version.row.itemCount, dataScope: version.row.dataScope });
      for (const { item, prepared } of basis) {
        const attemptId = createEntityId(), requestId = createEntityId(), result = item.fields.role === "knowledge_answer" ? runBenchmarkBaseline(prepared) :
          input.baselineVersion === ROLE_BENCHMARK_RULE_VERSION ? runRoleBenchmarkBaseline(prepared) : runBusinessBenchmarkBaseline(prepared);
        const assessment = BenchmarkAssessmentSchema.parse({ id: createEntityId(), attemptId, graderVersion,
          caseChecksum: item.caseChecksum, basisFingerprint: item.basisFingerprint, outputChecksum: benchmarkChecksum(result),
          ...(item.fields.role === "knowledge_answer" ? gradeBenchmark(item.fields, result, prepared.knowledge ?? []) :
            input.baselineVersion === ROLE_BENCHMARK_RULE_VERSION ? gradeRoleBenchmark(item.fields, result, prepared, []) : gradeBusinessBenchmark(item.fields, result, prepared)), createdAt: createdAt.toISOString() });
        await tx.insert(attempts).values({ id: attemptId, tenantId: current.tenantId, createdBy: current.userId, creationTransactionId: "0", createdAt,
          experimentId: id, itemId: item.id, arm: "baseline", ordinal: 1, evaluationRunId: null, requestId,
          requestChecksum: benchmarkChecksum({ version: 1, operation: "benchmark-baseline", experimentId: id, itemId: item.id, baselineVersion: input.baselineVersion }) });
        await tx.insert(assessments).values({ ...assessment, createdAt, expiresAt: item.expiresAt, tenantId: current.tenantId,
          createdBy: current.userId, creationTransactionId: "0", proof: sealBenchmarkValue(this.vault, "assessment", { tenantId: current.tenantId, createdBy: current.userId, assessment }),
          encryptedOutput: sealBenchmarkValue(this.vault, "baseline-output", { tenantId: current.tenantId, createdBy: current.userId, attemptId,
            outputChecksum: assessment.outputChecksum, result }) });
        await recordKnowledgeGovernanceEvent(tx, current, attemptId, "benchmark.assessment", "固定规则基线已实际执行并封存评分", {
          assessmentId: assessment.id, outputChecksum: assessment.outputChecksum });
      }
      const receipt = { id, revision: 1 };
      await recordKnowledgeGovernanceEvent(tx, current, id, "benchmark.experiment.create", input.reason, { datasetVersionId: version.row.id, itemCount: version.row.itemCount });
      await recordBenchmarkCommand(tx, current, "experiment.create", null, input, receipt, version.row.dataScope, createdAt);
      return receipt;
    });
  }

  async list(ceiling: TenantContext, raw: unknown = {}) {
    const query = benchmarkInput(BenchmarkPageQuerySchema, raw);
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling);
      if (query.cursor) await requireBenchmarkExperiment(tx, current, query.cursor);
      const rows = await tx.select().from(experiments).where(and(eq(experiments.createdBy, current.userId), query.cursor ? lt(experiments.id, query.cursor) : undefined))
        .orderBy(desc(experiments.id)).limit(query.limit + 1);
      const [count] = await tx.select({ total: sql<number>`count(*)::int` }).from(experiments).where(eq(experiments.createdBy, current.userId));
      for (const row of rows) await requireBenchmarkExperiment(tx, current, row.id);
      return BenchmarkExperimentPageSchema.parse({ items: rows.slice(0, query.limit).map(benchmarkExperimentSummary), total: count!.total,
        nextCursor: rows.length > query.limit ? rows[query.limit - 1]!.id : null });
    }, benchmarkReadOptions);
  }

  async get(ceiling: TenantContext, rawId: string) {
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling), value = await this.stateInTransaction(tx, current, rawId);
      const cells = value.version.items.map(item => {
        const baseline = value.attempts.find(row => row.itemId === item.id && row.arm === "baseline")!;
        const candidate = value.attempts.filter(row => row.itemId === item.id && row.arm === "candidate").sort((a, b) => b.ordinal - a.ordinal)[0];
        return { itemId: item.id, key: item.fields.key, label: benchmarkCaseLabel(item.fields), baselineAttemptId: baseline.id,
          baselineHardPass: baseline.assessment?.hardPass === true, latestAttemptId: candidate?.id ?? null,
          latestAttemptOrdinal: candidate?.ordinal ?? 0, state: candidate?.state ?? "not_started", hardPass: candidate?.assessment?.hardPass ?? null,
          qualified: candidate?.state === "completed" && candidate.assessment?.hardPass === true && candidate.review?.decision === "pass",
          reviewDecision: candidate?.review?.decision ?? null };
      });
      return BenchmarkExperimentSchema.parse({ ...benchmarkExperimentSummary(value.row), cells });
    }, benchmarkReadOptions);
  }

  async start(ceiling: TenantContext, rawId: string, raw: unknown) {
    const id = benchmarkId(rawId), input = benchmarkInput(StartBenchmarkAttemptSchema, raw);
    const initial = await withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling, "run"), prior = await replayBenchmarkCommand(tx, current, "attempt.start", id, input);
      if (prior) return { prior, value: null, item: null, current };
      const value = await requireBenchmarkExperiment(tx, current, id, "run", true), item = value.version.items.find(row => row.id === input.itemId);
      if (!item) throw new NotFoundException("benchmark_item_not_found");
      return { prior: null, value, item, current };
    });
    if (initial.prior) return initial.prior;
    const item = initial.item!, experiment = initial.value!.row, prepared = readBenchmarkBasis(this.vault, item);
    if (item.expiresAt <= new Date()) throw new ConflictException("benchmark_basis_expired");
    let ordinal = 0, receipt: BenchmarkReceipt | null = null;
    const attemptId = createEntityId();
    const before = async (tx: TenantTransaction) => {
        const current = await currentBenchmarkContext(tx, ceiling, "run"), prior = await replayBenchmarkCommand(tx, current, "attempt.start", id, input);
        if (prior) { receipt = prior; return; }
        await lockBenchmarkExperiment(tx, current, id);
        const currentValue = await requireBenchmarkExperiment(tx, current, id, "run");
        const [latest] = await tx.select().from(attempts).where(and(eq(attempts.experimentId, id), eq(attempts.itemId, item.id), eq(attempts.arm, "candidate"))).orderBy(desc(attempts.ordinal)).limit(1);
        if ((latest?.id ?? null) !== input.expectedLatestAttemptId) throw new ConflictException("benchmark_attempt_changed");
        ordinal = (latest?.ordinal ?? 0) + 1;
        if (ordinal > currentValue.row.maxAttemptsPerItem) throw new ConflictException("benchmark_attempt_limit");
        const actual = (await configuredAssistModels(tx, current.userId)).find(row => row.id === experiment.modelId);
        if (!actual || benchmarkChecksum(actual) !== benchmarkChecksum(experiment.modelSnapshot) ||
          await readModelExecutionRouteFingerprint(tx, experiment.modelId) !== experiment.routeFingerprint)
          throw new ConflictException("benchmark_model_changed");
        if (item.fields.role === "knowledge_answer") await this.evaluations.assertBenchmarkItemInTransaction(tx, current, prepared);
        else {
          if (!this.business) throw new ConflictException("benchmark_business_adapter_unavailable");
          await this.business.assertInTransaction(tx, current, prepared);
        }
    };
    const replay = async (tx: TenantTransaction, resultId: string, business: boolean) => {
        const current = await currentBenchmarkContext(tx, ceiling, "run"), prior = await replayBenchmarkCommand(tx, current, "attempt.start", id, input);
        if (!prior) throw new ConflictException("benchmark_attempt_receipt_invalid");
        const [actual] = await tx.select().from(attempts).where(eq(attempts.id, prior.id));
        if (!actual || (business ? actual.nativeRunId !== resultId || actual.evaluationRunId !== null : actual.evaluationRunId !== resultId || actual.nativeRunId !== null) ||
          actual.experimentId !== id || actual.itemId !== item.id || actual.createdBy !== current.userId)
          throw new ConflictException("benchmark_attempt_receipt_invalid");
        receipt = prior;
    };
    const created = async (tx: TenantTransaction, evaluationRunId: string | null, native: typeof aiAssistRuns.$inferSelect) => {
        const current = await currentBenchmarkContext(tx, ceiling, "run");
        const [route] = await tx.select({ providerConfigId: sql<string>`${modelRoutes.targets}->0->>'providerConfigId'` }).from(modelRoutes).where(eq(modelRoutes.id, experiment.modelId));
        if (!ordinal || !route || route.providerConfigId !== native.modelSnapshot.providerConfigId ||
          (item.fields.role === "knowledge_answer" ? !!native.benchmarkItemId : native.benchmarkItemId !== item.id) ||
          await readModelExecutionRouteFingerprint(tx, experiment.modelId) !== experiment.routeFingerprint)
          throw new ConflictException("benchmark_model_changed");
        const publicModelSnapshot: Record<string, unknown> = { ...native.modelSnapshot };
        delete publicModelSnapshot.providerConfigId;
        if (benchmarkChecksum(AssistModelSchema.parse(publicModelSnapshot)) !== benchmarkChecksum(experiment.modelSnapshot))
          throw new ConflictException("benchmark_model_changed");
        const createdAt = native.createdAt;
        await tx.insert(attempts).values({ id: attemptId, tenantId: current.tenantId, createdBy: current.userId, creationTransactionId: "0", createdAt,
          experimentId: id, itemId: item.id, arm: "candidate", ordinal, evaluationRunId,
          ...(item.fields.role !== "knowledge_answer" ? { nativeRunId: native.id } : {}), requestId: input.requestId,
          requestChecksum: benchmarkRequestChecksum("attempt.start", id, input) });
        receipt = { id: attemptId, revision: ordinal };
        await recordKnowledgeGovernanceEvent(tx, current, attemptId, "benchmark.attempt.start", "显式启动固定样本候选尝试", { experimentId: id, itemId: item.id,
          ...(evaluationRunId ? { evaluationRunId } : { nativeRunId: native.id }), ordinal });
        await recordBenchmarkCommand(tx, current, "attempt.start", id, input, receipt, experiment.dataScope, createdAt);
    };
    const executionContext = { ...initial.current, dataScope: experiment.dataScope };
    if (item.fields.role === "knowledge_answer") {
      if (!item.caseId) throw new ConflictException("benchmark_basis_unavailable");
      await this.evaluations.start(executionContext, item.caseId, { modelId: experiment.modelId, requestId: input.requestId }, {
        prepared, before, replay: (tx, run) => replay(tx, run.id, false), created: (tx, run, native) => created(tx, run.id, native),
      });
    } else {
      if (!this.business) throw new ConflictException("benchmark_business_adapter_unavailable");
      await this.business.start(executionContext, item.id, prepared, experiment.modelId, input.requestId, {
        before, replay: (tx, native) => replay(tx, native.id, true), created: (tx, native) => created(tx, null, native),
      });
    }
    if (!receipt) throw new ConflictException("benchmark_attempt_receipt_invalid");
    return receipt;
  }

  async attempts(ceiling: TenantContext, rawId: string, raw: unknown = {}) {
    const query = benchmarkInput(BenchmarkAttemptPageQuerySchema, raw);
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling), value = await this.stateInTransaction(tx, current, rawId);
      if (query.itemId && !value.version.items.some(row => row.id === query.itemId)) throw new NotFoundException("benchmark_item_not_found");
      const filtered = value.attempts.filter(row => (!query.itemId || row.itemId === query.itemId) && (!query.arm || row.arm === query.arm)).sort((a, b) => b.id.localeCompare(a.id));
      if (query.cursor && !filtered.some(row => row.id === query.cursor)) throw new NotFoundException("benchmark_cursor_not_found");
      const page = filtered.filter(row => !query.cursor || row.id < query.cursor);
      return BenchmarkAttemptPageSchema.parse({ items: page.slice(0, query.limit), nextCursor: page.length > query.limit ? page[query.limit - 1]!.id : null, total: filtered.length });
    }, benchmarkReadOptions);
  }

  async attempt(ceiling: TenantContext, rawId: string) {
    const id = benchmarkId(rawId);
    const initial = await withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling), [row] = await tx.select().from(attempts).where(and(eq(attempts.id, id), eq(attempts.createdBy, current.userId)));
      if (!row) throw new NotFoundException("benchmark_attempt_not_found");
      const value = await this.stateInTransaction(tx, current, row.experimentId), view = value.attempts.find(item => item.id === id)!;
      if (row.arm !== "baseline" || !view.resultAvailable || !view.assessment) {
        const item = value.version.items.find(item => item.id === row.itemId);
        if (row.arm === "candidate" && row.nativeRunId && view.resultAvailable && view.assessment && item && item.fields.role !== "knowledge_answer") {
          if (!this.business) throw new ConflictException("benchmark_business_adapter_unavailable");
          const result = await this.business.resultInTransaction(tx, current, this.vault, { nativeRunId: row.nativeRunId,
            itemId: item.id, fields: item.fields, caseChecksum: item.caseChecksum, basisFingerprint: item.basisFingerprint,
            taskFingerprint: item.taskFingerprint, sourcePins: item.sourcePins, dataScope: value.row.dataScope,
            modelId: value.row.modelId, requestId: row.requestId, outputChecksum: view.assessment.outputChecksum, expiresAt: item.expiresAt });
          return { row, view, result };
        }
        return { row, view, result: null };
      }
      const [actual] = await tx.select({ encryptedOutput: assessments.encryptedOutput }).from(assessments).where(eq(assessments.attemptId, id));
      try {
        const body = openBenchmarkValue<{ tenantId: string; createdBy: string; attemptId: string; outputChecksum: string; result: AssistResult }>(this.vault, "baseline-output", actual!.encryptedOutput!);
        const result = AssistResultSchema.parse(body.result);
        if (body.tenantId !== current.tenantId || body.createdBy !== current.userId || body.attemptId !== id ||
          body.outputChecksum !== view.assessment.outputChecksum || benchmarkChecksum(result) !== body.outputChecksum)
          throw new Error("benchmark_result_invalid");
        return { row, view, result };
      } catch { throw new ConflictException("benchmark_result_unavailable"); }
    }, benchmarkReadOptions);
    let result = initial.result;
    if (initial.row.arm === "candidate" && initial.row.evaluationRunId && initial.view.resultAvailable) {
      const report = await this.evaluations.report(ceiling, initial.row.evaluationRunId);
      result = report.answer.stale ? null : report.answer.result;
      if (result && (!initial.view.assessment || benchmarkChecksum(result) !== initial.view.assessment.outputChecksum)) throw new ConflictException("benchmark_result_unavailable");
    }
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling), actual = await this.stateInTransaction(tx, current, initial.row.experimentId);
      const view = actual.attempts.find(row => row.id === id)!;
      if (!view.resultAvailable) result = null;
      return BenchmarkAttemptSchema.parse({ ...view, result, resultAvailable: !!result });
    }, benchmarkReadOptions);
  }

  async review(ceiling: TenantContext, rawId: string, raw: unknown) {
    const id = benchmarkId(rawId), input = benchmarkInput(ReviewBenchmarkAttemptSchema, raw);
    const replay = await withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling, "review");
      return replayBenchmarkCommand(tx, current, "attempt.review", id, input);
    });
    if (replay) return replay;
    const original = await this.attempt(ceiling, id);
    if (!original.result || !original.assessment || original.state !== "completed") throw new ConflictException("benchmark_review_unavailable");
    return withTenant(this.database.db, ceiling, async tx => {
      const current = await currentBenchmarkContext(tx, ceiling, "review"), prior = await replayBenchmarkCommand(tx, current, "attempt.review", id, input);
      if (prior) return prior;
      const [attempt] = await tx.select().from(attempts).where(and(eq(attempts.id, id), eq(attempts.createdBy, current.userId)));
      if (!attempt) throw new NotFoundException("benchmark_attempt_not_found");
      await lockBenchmarkExperiment(tx, current, attempt.experimentId);
      const value = await this.stateInTransaction(tx, current, attempt.experimentId);
      assertBenchmarkFieldsScope(current, value.row.dataScope, value.version.items.map(item => item.fields), "review");
      const view = value.attempts.find(row => row.id === id)!;
      if (!view.assessment || view.state !== "completed" || !view.resultAvailable) throw new ConflictException("benchmark_review_unavailable");
      const item = value.version.items.find(row => row.id === attempt.itemId)!;
      if (!await benchmarkGuidanceCurrentInTransaction(tx, current, this.vault, item, { lock: true }))
        throw new ConflictException("benchmark_review_unavailable");
      if ((view.review?.id ?? null) !== input.expectedReviewId) throw new ConflictException("benchmark_review_changed");
      const reviewId = createEntityId(), createdAt = new Date(), sequence = (view.review?.sequence ?? 0) + 1;
      await tx.insert(reviews).values({ id: reviewId, tenantId: current.tenantId, createdBy: current.userId, creationTransactionId: "0", createdAt,
        attemptId: id, assessmentId: view.assessment.id, previousId: input.expectedReviewId, sequence,
        decision: input.decision, minutes: input.minutes, hourlyUsd: input.hourlyUsd, reason: input.reason });
      const receipt = { id: reviewId, revision: sequence };
      await recordKnowledgeGovernanceEvent(tx, current, reviewId, "benchmark.attempt.review", input.reason, { attemptId: id, assessmentId: view.assessment.id, sequence });
      await recordBenchmarkCommand(tx, current, "attempt.review", id, input, receipt, value.row.dataScope, createdAt);
      return receipt;
    });
  }
}
