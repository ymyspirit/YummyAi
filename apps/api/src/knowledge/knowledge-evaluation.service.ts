import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { KnowledgeEvaluationReportSchema, StartKnowledgeEvaluationSchema, ReviewKnowledgeEvaluationSchema, type KnowledgeEvaluationReport } from "@yummyai/contracts/knowledge/governance";
import { KnowledgeEvaluationRunPageQuerySchema, KnowledgeEvaluationRunPageSchema, KnowledgeEvaluationComparisonQuerySchema, KnowledgeEvaluationComparisonSchema } from "@yummyai/contracts/knowledge/evaluation-read";
import { KNOWLEDGE_EVALUATION_ASSERTIONS, KnowledgeEvaluationProtocolSchema } from "@yummyai/contracts/knowledge/evaluation-protocol";
import { knowledgeEvaluationBasis, knowledgeEvaluationChecksum, knowledgeEvaluationRequestChecksum, KnowledgeEvaluationProofError, scoreKnowledgeEvaluation, sealKnowledgeEvaluationProtocol, assistTaskFingerprint, ASSIST_BENCHMARK_PROMPT_VERSION, type AssistContext, type SecretVault } from "@yummyai/ai-core";
import type { KnowledgeBenchmarkCase } from "@yummyai/contracts/knowledge/benchmark";
import { aiAssistRuns, knowledgeEvaluationCases as cases, knowledgeEvaluationRuns as runs, knowledgeEvaluationProtocols as protocols, knowledgeGovernanceEvents as events, withTenant, type DatabaseConnection, type TenantTransaction } from "@yummyai/database";
import { currentEvaluationContext, assertEvaluationScope, evaluationDataScope, loadKnowledgeEvaluationExecution } from "@yummyai/knowledge-core";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { AssistService } from "../ai/assist.service.js";
import { recordKnowledgeGovernanceEvent } from "./knowledge-import.service.js";

export type BenchmarkEvaluationAdmission = {
  prepared: AssistContext;
  before(tx: TenantTransaction): Promise<void>;
  replay(tx: TenantTransaction, run: typeof runs.$inferSelect): Promise<void>;
  created(tx: TenantTransaction, run: typeof runs.$inferSelect, native: typeof aiAssistRuns.$inferSelect, prepared: AssistContext, vault: SecretVault): Promise<void>;
};

@Injectable()
export class KnowledgeEvaluationService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AssistService) private readonly assists: AssistService,
  ) {}
  async prepareBenchmarkItem(ceiling: TenantContext, caseId: string, fields: KnowledgeBenchmarkCase, expiresAt: Date) {
    const current = await withTenant(this.database.db, ceiling, tx => currentEvaluationContext(tx, ceiling, "run"));
    const scopes = [evaluationDataScope(current, !!fields.evaluation.search.spuIds.length), ceiling.dataScope];
    const pinnedScope: TenantContext["dataScope"] = scopes.includes("self") ? "self" : scopes.includes("team") ? "team" : "tenant";
    const context = { ...current, dataScope: pinnedScope };
    const prepared = await this.assists.preparePinnedEvaluation(context, {
      kind: "knowledge_answer", purpose: "evaluation", scopeId: caseId, search: fields.evaluation.search,
      evidenceStoreId: null, previousRunId: null, requestId: createEntityId(), modelId: createEntityId(),
      ...(fields.calculations.length ? { taskGoal: "依据benchmarkCalculations给定输入完成计算，结果必须放入typedAnswers。按key、规定小数位scale、unit和currency返回十进制字符串，引用benchmark-input:key。预期答案未提供，不从文字短语猜测数值。" } : {}),
    });
    const calculations = fields.calculations.map(task => ({ key: task.key, operator: task.operator, operands: task.operands, scale: task.scale, unit: task.unit, currency: task.currency }));
    if (calculations.length) {
      prepared.data = { ...prepared.data, benchmarkCalculations: calculations };
      prepared.sources = [...prepared.sources, ...calculations.map(task => ({ id: "benchmark-input:" + task.key,
        label: "评测样本给定计算输入 " + task.key, href: "/knowledge" }))];
    }
    prepared.expiresAt = new Date(Math.min(expiresAt.getTime(), prepared.expiresAt ? new Date(prepared.expiresAt).getTime() : expiresAt.getTime())).toISOString();
    return { prepared, dataScope: context.dataScope, basisFingerprint: knowledgeEvaluationBasis(fields.evaluation, prepared, ASSIST_BENCHMARK_PROMPT_VERSION), taskFingerprint: assistTaskFingerprint(prepared) };
  }
  assertBenchmarkItemInTransaction(tx: TenantTransaction, current: TenantContext, prepared: AssistContext) {
    return this.assists.assertPinnedEvaluationInTransaction(tx, current, prepared);
  }
  async start(ceiling: TenantContext, rawCaseId: string, raw: unknown, owner?: BenchmarkEvaluationAdmission) {
    const caseId = rawCaseId.toLowerCase();
    const parsed = StartKnowledgeEvaluationSchema.parse(raw);
    const input = { modelId: parsed.modelId.toLowerCase(), requestId: parsed.requestId.toLowerCase() };
    const initial = await withTenant(this.database.db, ceiling, async tx => {
      const current = await currentEvaluationContext(tx, ceiling, "run");
      const [prior] = await tx.select().from(runs).where(eq(runs.requestId, input.requestId));
      if (prior) {
        const receipt = await this.replay(tx, current, prior.id, caseId, input);
        if (owner) await owner.replay(tx, receipt.run);
        return { current, prior: receipt, snapshot: receipt.run.caseSnapshot, revision: null };
      }
      const [row] = await tx.select().from(cases).where(eq(cases.id, caseId));
      if (!row || row.archivedAt) throw new NotFoundException("评测问题不存在");
      if (row.benchmarkVersionId && !owner) throw new ConflictException("发布样本必须从原实验明确启动尝试");
      if (row.fields.search.spuIds.length) authorize(current, Permission.ProductRead);
      return { current, prior: null, snapshot: row.fields, revision: row.revision };
    });
    if (initial.prior && (initial.prior.native.status !== "queued" || initial.prior.native.expiresAt <= new Date())) return { id: initial.prior.run.id };
    const context = { ...initial.current, dataScope: initial.prior?.protocolView?.dataScope ?? owner?.prepared.accessPolicy?.dataScope ??
      evaluationDataScope(initial.current, !!initial.snapshot.search.spuIds.length) };
    let resultId: string | null = initial.prior?.run.id ?? null;
    await this.assists.create(context, {
      kind: "knowledge_answer", purpose: "evaluation", scopeId: caseId, search: initial.snapshot.search,
      evidenceStoreId: null, previousRunId: null, requestId: input.requestId, modelId: input.modelId,
      ...(owner?.prepared.request.taskGoal ? { taskGoal: owner.prepared.request.taskGoal } : {}),
    }, {
      ...(owner ? { prepared: async (request: AssistContext["request"]) => ({ ...owner.prepared, request }) } : {}),
      before: async tx => {
        // This lock precedes the native model/budget locks for every entry path.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"knowledge-eval-run:" + context.tenantId + ":" + input.requestId},0))`);
        if (owner) await owner.before(tx);
        const current = await currentEvaluationContext(tx, ceiling, "run");
        const [prior] = await tx.select().from(runs).where(eq(runs.requestId, input.requestId));
        if (prior) {
          const receipt = await this.replay(tx, current, prior.id, caseId, input);
          resultId = receipt.run.id;
        } else {
          const [row] = await tx.select().from(cases).where(eq(cases.id, caseId)).for("share");
          if (!row || row.archivedAt || row.revision !== initial.revision ||
            knowledgeEvaluationChecksum(row.fields) !== knowledgeEvaluationChecksum(initial.snapshot))
            throw new ConflictException("评测问题已变化，请重新读取后开始新的尝试");
          assertEvaluationScope(current, context.dataScope, "run", !!row.fields.search.spuIds.length);
          if (owner) await this.assertBenchmarkItemInTransaction(tx, current, owner.prepared);
        }
      },
      replay: async (tx, native) => {
        const [prior] = await tx.select().from(runs).where(eq(runs.requestId, input.requestId));
        if (!prior || prior.assistRunId !== native.id) throw new ConflictException("原 AI 请求未关联此评测，请核对原记录");
        const receipt = await this.replay(tx, ceiling, prior.id, caseId, input);
        resultId = receipt.run.id;
        if (owner) await owner.replay(tx, receipt.run);
      },
      created: async (tx, native, prepared, vault) => {
        const current = await currentEvaluationContext(tx, ceiling, "run");
        if (prepared.accessPolicy?.dataScope !== context.dataScope) throw new ConflictException("原评测权限范围不一致");
        assertEvaluationScope(current, context.dataScope, "run", !!initial.snapshot.search.spuIds.length);
        const id = createEntityId();
        const [evaluation] = await tx.insert(runs).values({ id, tenantId: context.tenantId, caseId, assistRunId: native.id,
          caseSnapshot: initial.snapshot, requestId: input.requestId, createdBy: context.userId }).returning();
        const protocol = KnowledgeEvaluationProtocolSchema.parse({
          version: "knowledge-evaluation-v1", runId: id, caseRevision: initial.revision,
          caseChecksum: knowledgeEvaluationChecksum(initial.snapshot),
          requestChecksum: knowledgeEvaluationRequestChecksum(caseId, input),
          basisFingerprint: knowledgeEvaluationBasis(initial.snapshot, prepared, native.promptVersion),
          inputFingerprint: native.inputFingerprint, modelId: input.modelId, dataScope: prepared.accessPolicy!.dataScope,
          promptVersion: native.promptVersion, assertionVersion: KNOWLEDGE_EVALUATION_ASSERTIONS, createdAt: native.createdAt.toISOString(),
        });
        const fields = { runId: protocol.runId, caseRevision: protocol.caseRevision, caseChecksum: protocol.caseChecksum,
          requestChecksum: protocol.requestChecksum, basisFingerprint: protocol.basisFingerprint, inputFingerprint: protocol.inputFingerprint,
          modelId: protocol.modelId, dataScope: protocol.dataScope, promptVersion: protocol.promptVersion, assertionVersion: protocol.assertionVersion };
        await tx.insert(protocols).values({ ...fields, tenantId: context.tenantId,
          createdBy: context.userId, createdAt: native.createdAt, creationTransactionId: "0",
          proof: sealKnowledgeEvaluationProtocol(vault, { tenantId: context.tenantId, createdBy: context.userId, assistRunId: native.id, protocol }),
        });
        await recordKnowledgeGovernanceEvent(tx, current, caseId, "evaluation.start", "显式启动真实回答评测", { runId: id, assistRunId: native.id, caseRevision: initial.revision });
        if (owner) await owner.created(tx, evaluation!, native, prepared, vault);
        resultId = id;
      },
    });
    if (!resultId) throw new ConflictException("评测回执未确认，请保留原请求核对");
    return { id: resultId };
  }
  private async replay(tx: TenantTransaction, ceiling: TenantContext, id: string, caseId: string, input: { modelId: string; requestId: string }) {
    const current = await currentEvaluationContext(tx, ceiling, "run");
    const receipt = await loadKnowledgeEvaluationExecution(tx, id);
    if (!receipt || receipt.run.createdBy !== current.userId || receipt.run.caseId !== caseId ||
      receipt.run.requestId !== input.requestId || receipt.native.modelSnapshot.id !== input.modelId)
      throw new ConflictException("同一评测请求已用于其他操作者、问题或模型");
    this.assists.authenticateEvaluation(receipt);
    assertEvaluationScope(current, receipt.protocolView?.dataScope ?? current.dataScope, "run", !!receipt.run.caseSnapshot.search.spuIds.length);
    return receipt;
  }
  async report(ceiling: TenantContext, id: string) {
    const { current, receipt, reviewRows } = await withTenant(this.database.db, ceiling, async tx => {
      const current = await currentEvaluationContext(tx, ceiling);
      const receipt = await loadKnowledgeEvaluationExecution(tx, id);
      if (!receipt || receipt.run.createdBy !== current.userId) throw new NotFoundException("评测记录不存在");
      this.assists.authenticateEvaluation(receipt);
      assertEvaluationScope(current, receipt.protocolView?.dataScope ?? current.dataScope, "read", !!receipt.run.caseSnapshot.search.spuIds.length);
      const reviewRows = await tx.select().from(events).where(and(eq(events.resourceId, id), eq(events.action, "evaluation.review"))).orderBy(desc(events.createdAt), desc(events.id));
      return { current, receipt, reviewRows };
    });
    const answer = await this.assists.get(current, receipt.run.assistRunId);
    const sealed = receipt.assessmentView;
    if (sealed && answer.result && knowledgeEvaluationChecksum(answer.result) !== sealed.outputChecksum) throw new KnowledgeEvaluationProofError();
    const legacy = scoreKnowledgeEvaluation(receipt.run.caseSnapshot, answer);
    // Legacy diagnostics remain visible, but are never relabelled as a sealed assessment.
    const scoring = sealed ?? legacy;
    const report = KnowledgeEvaluationReportSchema.parse({
      id: receipt.run.id, caseId: receipt.run.caseId, createdAt: receipt.run.createdAt.toISOString(),
      caseSnapshot: receipt.run.caseSnapshot, answer, retrievalRecall: scoring.retrievalRecall, citedRecall: scoring.citedRecall, checks: scoring.checks,
      manualReviews: reviewRows.map(row => ({ result: row.detail.result, reason: row.reason, createdAt: row.createdAt.toISOString() })),
      assertionVersion: KNOWLEDGE_EVALUATION_ASSERTIONS, protocol: receipt.protocolView, assessment: sealed,
      assessmentState: sealed ? "recorded" : !receipt.protocolView ? "unrecorded" :
        ["queued", "running"].includes(answer.status) && answer.request && !answer.stale ? "awaiting_result" : "unavailable",
    });
    await this.assertReportsCurrent(ceiling, [report]);
    return report;
  }
  async list(context: TenantContext, caseId: string) { return (await this.page(context, caseId)).items; }
  private async assertReportsCurrent(ceiling: TenantContext, reports: KnowledgeEvaluationReport[]) {
    await withTenant(this.database.db, ceiling, async tx => {
      const current = await currentEvaluationContext(tx, ceiling);
      for (const report of reports) {
        assertEvaluationScope(current, report.protocol?.dataScope ?? report.answer.accessPolicy?.dataScope ?? current.dataScope,
          "read", !!report.caseSnapshot.search.spuIds.length);
        const [native] = await tx.select({ owner: aiAssistRuns.ownerId, expiresAt: aiAssistRuns.expiresAt,
          input: sql<boolean>`${aiAssistRuns.encryptedInput} is not null`, output: sql<boolean>`${aiAssistRuns.encryptedOutput} is not null` })
          .from(aiAssistRuns).where(eq(aiAssistRuns.id, report.answer.id)).for("share");
        if (!native || native.owner !== current.userId) throw new NotFoundException("评测记录不存在");
        if ((native.expiresAt <= new Date() || !native.input) && (report.answer.request || report.answer.knowledge.length || report.answer.result) ||
          !native.output && report.answer.result) throw new ConflictException("原回答可读状态已变化，请按原编号重新读取");
      }
    });
  }
  async page(ceiling: TenantContext, caseId: string, raw: unknown = {}) {
    const query = KnowledgeEvaluationRunPageQuerySchema.parse(raw);
    const ids = await withTenant(this.database.db, ceiling, async tx => {
      const current = await currentEvaluationContext(tx, ceiling);
      if (query.cursor) {
        const [cursor] = await tx.select().from(runs).where(and(eq(runs.id, query.cursor), eq(runs.caseId, caseId), eq(runs.createdBy, current.userId)));
        if (!cursor) throw new NotFoundException("历史游标不存在");
      }
      return tx.select({ id: runs.id }).from(runs).where(and(eq(runs.caseId, caseId), eq(runs.createdBy, current.userId),
        query.cursor ? lt(runs.id, query.cursor) : undefined)).orderBy(desc(runs.id)).limit(query.limit + 1);
    });
    const items = [];
    for (const row of ids.slice(0, query.limit)) items.push(await this.report(ceiling, row.id));
    await this.assertReportsCurrent(ceiling, items);
    return KnowledgeEvaluationRunPageSchema.parse({ items, nextCursor: ids.length > query.limit ? items.at(-1)!.id : null });
  }
  async compare(context: TenantContext, raw: unknown) {
    const input = KnowledgeEvaluationComparisonQuerySchema.parse(raw);
    const baseline = await this.report(context, input.baselineRunId), candidate = await this.report(context, input.candidateRunId);
    const reasons: string[] = [];
    if (baseline.id === candidate.id) reasons.push("请选择两次不同的尝试");
    if (baseline.caseId !== candidate.caseId) reasons.push("不是同一个评测问题");
    if (!baseline.protocol || !candidate.protocol) reasons.push("包含没有原执行协议的历史记录");
    if (!baseline.assessment || !candidate.assessment) reasons.push("两次尝试尚未具备封存评分");
    if (baseline.protocol && candidate.protocol && baseline.protocol.basisFingerprint !== candidate.protocol.basisFingerprint)
      reasons.push("问题、知识版本、方法或执行契约不同，只能并列核对");
    if (baseline.answer.stale || candidate.answer.stale || !baseline.answer.result || !candidate.answer.result)
      reasons.push("原回答或原依据已不可读，不能进行完整比较");
    await this.assertReportsCurrent(context, [baseline, candidate]);
    return KnowledgeEvaluationComparisonSchema.parse({ baseline, candidate, comparable: !reasons.length, reasons });
  }
  async review(ceiling: TenantContext, id: string, raw: unknown) {
    const input = ReviewKnowledgeEvaluationSchema.parse(raw);
    const report = await this.report(ceiling, id);
    if (report.answer.status !== "completed" || !report.answer.result || report.answer.stale)
      throw new ConflictException("原回答或依据当前不可读，不能进行事实性人工核验");
    await withTenant(this.database.db, ceiling, async tx => {
      const current = await currentEvaluationContext(tx, ceiling, "review");
      assertEvaluationScope(current, report.protocol?.dataScope ?? report.answer.accessPolicy?.dataScope ?? current.dataScope, "review", !!report.caseSnapshot.search.spuIds.length);
      await recordKnowledgeGovernanceEvent(tx, current, id, "evaluation.review", input.reason, { result: input.result });
    });
    return { id };
  }
}
