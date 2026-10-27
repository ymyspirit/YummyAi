import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ASSIST_MAX_OUTPUT_TOKENS,
  assistPromptVersion,
  assistSystemInstructions,
  isBenchmarkAssist,
  assistFingerprint,
  assistExecutionPolicy,
  assistInvocationView,
  assistScope,
  assistUsesReviewedGuidance,
  artworkAuditReport,
  calculateCostUsd,
  authenticateKnowledgeEvaluation,
  businessBenchmarkBasisFingerprint,
  businessBenchmarkCaseChecksum,
  businessBenchmarkSourcePins,
  knowledgeEvaluationChecksum,
  type AssistContext,
  type SecretVault,
} from "@yummyai/ai-core";
import { authorize, ForbiddenError, permissionScope, Permission, ASSIST_ACCESS_POLICY_VERSION, authorizeAssistRequest, requiredAssistPermissions, requiredAssistRequestPermissions, assertBusinessBenchmarkScope, intersectPermissionContexts, erpPermissionContext } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  AssistModelInputSchema,
  AssistBudgetStateSchema,
  CreateAssistSchema,
  type CreateAssist,
  type AssistKind,
  type AssistModel,
  type AssistResult,
  type AssistView,
} from "@yummyai/contracts/ai/assist";
import { BusinessBenchmarkCaseSchema, BUSINESS_BENCHMARK_ROLES, LEGACY_BUSINESS_BENCHMARK_ROLES } from "@yummyai/contracts/knowledge/benchmark";
import { AssistAutomaticAuditReuseProofSchema, AssistReceiptQuerySchema, AssistReceiptViewSchema, assistRequestRecoveryText } from "@yummyai/contracts/ai/assist-recovery";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import {
  aiAssistRuns as runs,
  aiAssistExecutions as executions,
  aiBudgetLedger,
  aiBudgetPolicies,
  modelProviderConfigs,
  modelRoutes,
  modelBillingReconciliations,
  knowledgeBenchmarkItems,
  knowledgeBenchmarkVersions,
  assertBusinessBenchmarkResources,
  type BusinessTask,
  readModelBillingAcknowledgments,
  captureAssistInputAuthority,
  assertAssistInputAuthority,
  loadCurrentMembershipContext,
  withTenant,
  type DatabaseConnection,
  type TenantTransaction,
} from "@yummyai/database";
import { assertEvaluationScope, currentEvaluationContext, knowledgeExecutionAuthority, type KnowledgeEvaluationExecution } from "@yummyai/knowledge-core";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AssistContextService } from "./assist-context.service.js";
import { configuredAssistModels } from "./configured-assist-models.js";
import { assistTaskFingerprint } from "./assist-task-fingerprint.js";

export abstract class AssistEnqueuer {
  abstract enqueue(input: {
    id: string;
    tenantId: string;
    userId: string;
    expiresAt: Date;
  }): Promise<void>;
}
export function authorizeAssist(context: TenantContext, kind: AssistKind, write = false) {
  for (const permission of requiredAssistPermissions(kind, write ? "run" : "read")) authorize(context, permission);
}
/** Internal owner admission only; not accepted by CreateAssistSchema or HTTP. */
export type AssistOwnerAdmission = {
  benchmarkItemId?: string;
  prepared?(request: CreateAssist): Promise<AssistContext>;
  before(tx: TenantTransaction): Promise<void>;
  replay(tx: TenantTransaction, run: typeof runs.$inferSelect): Promise<void>;
  created(tx: TenantTransaction, run: typeof runs.$inferSelect, input: AssistContext, vault: SecretVault): Promise<void>;
};

@Injectable()
export class AssistService {
  previewBusiness(context: TenantContext, raw: unknown) {
    return this.contexts.previewBusiness(context, raw);
  }
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AI_ASSIST_VAULT) private readonly vault: SecretVault,
    @Inject(AssistContextService) private readonly contexts: AssistContextService,
    @Inject(AssistEnqueuer) private readonly queue: AssistEnqueuer,
  ) {}

  async models(context: TenantContext): Promise<AssistModel[]> {
    const allowed = [Permission.DesignRead, Permission.OrderRead, Permission.FinanceRead, Permission.ProcurementRead, Permission.WorkflowRead];
    if (!allowed.some((p) => context.permissions.includes(p))) authorize(context, Permission.DesignRead);
    return withTenant(this.database.db, context, tx => configuredAssistModels(tx, context.userId));
  }

  async addModel(context: TenantContext, raw: unknown) {
    authorize(context, Permission.ModelConfigure);
    const input = AssistModelInputSchema.parse(raw);
    return withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`}, 0))`);
      const [provider] = await tx
        .select()
        .from(modelProviderConfigs)
        .where(
          and(
            eq(modelProviderConfigs.id, input.providerConfigId),
            eq(modelProviderConfigs.status, "enabled"),
          ),
        );
      if (!provider || !["openai", "openai-compatible"].includes(provider.provider))
        throw new BadRequestException("请选择启用的 OpenAI 或 OpenAI 兼容渠道");
      const [removed] = await tx.select().from(modelRoutes).where(and(eq(modelRoutes.modelKey, input.label), eq(modelRoutes.taskType, "studio_analysis"), eq(modelRoutes.status, "disabled")));
      if (removed) {
        await tx.update(modelRoutes).set({ status: "enabled", updatedAt: new Date(), targets: [{ providerConfigId: input.providerConfigId, providerModel: input.model, timeoutMs: 120000, analysisPricing: { inputUsdPerMillion: input.inputUsdPerMillion, outputUsdPerMillion: input.outputUsdPerMillion, maxTaskCostUsd: input.maxTaskCostUsd } }] }).where(eq(modelRoutes.id, removed.id));
        return { id: removed.id };
      }
      const [created] = await tx
        .insert(modelRoutes)
        .values({
          id: createEntityId(),
          tenantId: context.tenantId,
          modelKey: input.label,
          taskType: "studio_analysis",
          targets: [
            {
              providerConfigId: input.providerConfigId,
              providerModel: input.model,
              timeoutMs: 120000,
              analysisPricing: {
                inputUsdPerMillion: input.inputUsdPerMillion,
                outputUsdPerMillion: input.outputUsdPerMillion,
                maxTaskCostUsd: input.maxTaskCostUsd,
              },
            },
          ],
        })
        .onConflictDoNothing()
        .returning({ id: modelRoutes.id });
      if (!created) throw new ConflictException("图文分析模型的显示名称已存在");
      return created;
    });
  }

  authenticateEvaluation(receipt: KnowledgeEvaluationExecution) { authenticateKnowledgeEvaluation(this.vault, receipt); }

  /** Server-only owner entry point. No transport can submit a prepared context. */
  async preparePinnedEvaluation(context: TenantContext, raw: unknown): Promise<AssistContext> {
    const request = CreateAssistSchema.parse(raw);
    if (request.kind !== "knowledge_answer" || request.purpose !== "evaluation") throw new BadRequestException("固定样本只支持已登记评测适配器");
    authorizeAssist(context, request.kind, true);
    const basis = await this.contexts.prepareForExecution(context, request, true);
    const attachments = { hasKnowledge: assistUsesReviewedGuidance(basis) };
    authorizeAssistRequest(context, request, "run", attachments);
    return { ...basis, accessPolicy: { version: ASSIST_ACCESS_POLICY_VERSION,
      requiredPermissions: requiredAssistRequestPermissions(request, "run", attachments), dataScope: context.dataScope } };
  }

  async assertPinnedEvaluationInTransaction(tx: TenantTransaction, context: TenantContext, input: AssistContext) {
    if (input.request.kind !== "knowledge_answer" || input.request.purpose !== "evaluation" || !input.inputAuthority || !input.accessPolicy)
      throw new ConflictException("原固定执行依据不完整");
    authorizeAssistRequest(context, input.request, "run", { hasKnowledge: assistUsesReviewedGuidance(input), pinnedDataScope: input.accessPolicy.dataScope });
    if (input.expiresAt && new Date(input.expiresAt) <= new Date()) throw new ConflictException("原固定执行依据已到期");
    await this.contexts.assertMethodCurrent(tx, context, input, true);
    const current = await captureAssistInputAuthority(tx, context, input.request,
      await knowledgeExecutionAuthority(tx, context, input.knowledge, null));
    try { assertAssistInputAuthority(input.inputAuthority, current); }
    catch { throw new ConflictException("原固定来源或方法已变化，请核对后发布新版本"); }
  }

  /** Internal benchmark adapter; HTTP cannot provide this prepared payload. */
  async preparePinnedBusiness(context: TenantContext, raw: unknown): Promise<AssistContext> {
    const request = CreateAssistSchema.parse(raw);
    if (!BUSINESS_BENCHMARK_ROLES.some(role => role === request.kind))
      throw new BadRequestException("benchmark_business_role_invalid");
    if (!LEGACY_BUSINESS_BENCHMARK_ROLES.some(role => role === request.kind)) {
      const basis = await this.contexts.preparePinnedBusiness(context, request);
      if (!basis.benchmarkResources) throw new ConflictException("benchmark_basis_unavailable");
      const requiredPermissions = Object.keys(basis.benchmarkResources.permissionScopes) as Permission[];
      for (const bit of requiredPermissions) authorize(context, bit);
      return { ...basis, accessPolicy: { version: ASSIST_ACCESS_POLICY_VERSION, requiredPermissions, dataScope: context.dataScope } };
    }
    for (const bit of requiredAssistPermissions(request.kind, "read")) {
      authorize(context, bit);
      if (permissionScope(context, bit) !== "tenant") throw new ForbiddenError(bit, "outside_data_scope");
    }
    const basis = await this.contexts.preparePinnedBusiness(context, request);
    const attachments = { hasKnowledge: assistUsesReviewedGuidance(basis) };
    const requiredPermissions = requiredAssistRequestPermissions(request, "run", attachments);
    const rank = { self: 0, team: 1, tenant: 2 };
    for (const bit of requiredPermissions) {
      authorize(context, bit);
      if (rank[permissionScope(context, bit)] < rank[context.dataScope]) throw new ForbiddenError(bit, "outside_data_scope");
      if (requiredAssistPermissions(request.kind, "read").includes(bit) && permissionScope(context, bit) !== "tenant")
        throw new ForbiddenError(bit, "outside_data_scope");
    }
    return { ...basis, accessPolicy: { version: ASSIST_ACCESS_POLICY_VERSION, requiredPermissions, dataScope: context.dataScope } };
  }

  async assertPinnedBusinessInTransaction(tx: TenantTransaction, context: TenantContext, input: AssistContext) {
    if (!BUSINESS_BENCHMARK_ROLES.some(role => role === input.request.kind))
      throw new ConflictException("benchmark_business_role_invalid");
    if (!input.accessPolicy?.dataScope || input.expiresAt && Date.parse(input.expiresAt) <= Date.now())
      throw new ConflictException("benchmark_basis_expired");
    if (!LEGACY_BUSINESS_BENCHMARK_ROLES.some(role => role === input.request.kind)) {
      if (input.request.kind === "knowledge_answer") throw new ConflictException("benchmark_business_role_invalid");
      assertBusinessBenchmarkScope(context, input.accessPolicy.dataScope, input.request.kind);
      await assertBusinessBenchmarkResources(tx, context, [input.request as BusinessTask], input.benchmarkResources, "run");
      await this.contexts.assertPinnedBusinessInTransaction(tx, context, input);
      return;
    }
    const rank = { self: 0, team: 1, tenant: 2 };
    for (const bit of requiredAssistRequestPermissions(input.request, "run", { hasKnowledge: assistUsesReviewedGuidance(input) })) {
      authorize(context, bit);
      if (rank[permissionScope(context, bit)] < rank[input.accessPolicy.dataScope]) throw new ForbiddenError(bit, "outside_data_scope");
      if (requiredAssistPermissions(input.request.kind, "read").includes(bit) && permissionScope(context, bit) !== "tenant")
        throw new ForbiddenError(bit, "outside_data_scope");
    }
    await this.contexts.assertPinnedBusinessInTransaction(tx, context, input);
  }

  async create(context: TenantContext, raw: unknown, admission?: AssistOwnerAdmission): Promise<AssistView> {
    const parsed = CreateAssistSchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("分析参数无效，请重新读取当前依据后提交");
    const input = parsed.data;
    authorizeAssist(context, input.kind, true);
    const requestFingerprint = assistFingerprint(input);
    const [prior] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(runs)
        .where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, input.requestId))),
    );
    if (prior) {
      if (prior.benchmarkItemId && prior.benchmarkItemId !== admission?.benchmarkItemId)
        throw new ConflictException("benchmark_native_receipt_invalid");
      if (admission) await withTenant(this.database.db, context, async tx => { await admission.before(tx); await admission.replay(tx, prior); });
      if (prior.requestFingerprint !== requestFingerprint)
        throw new ConflictException("同一请求不能更换分析参数");
      const view = await this.get(context, prior.id);
      if (prior.status === "queued" && prior.expiresAt > new Date()) {
        authorizeAssistRequest(context, input, "run", { hasKnowledge: assistUsesReviewedGuidance(view), pinnedDataScope: view.accessPolicy?.dataScope ?? "tenant" });
        if (!prior.encryptedInput) throw new ConflictException("原任务输入已清理，请读取当前资料并新建任务");
        const pinned = await this.vault.withSecret(prior.encryptedInput, async value => JSON.parse(value) as AssistContext);
        await this.contexts.assertExecutionCurrent(context, pinned);
        try {
          await this.queue.enqueue({
            id: prior.id,
            tenantId: context.tenantId,
            userId: context.userId,
            expiresAt: prior.expiresAt,
          });
        } catch {
          // A replay has the same durable intent as the initial dispatch. Queue
          // loss must not disguise an already committed run as a fresh failure.
          await withTenant(this.database.db, context, tx => tx.update(runs)
            .set({ errorCode: "assist_dispatch_pending" })
            .where(and(eq(runs.id, prior.id), eq(runs.status, "queued"))));
          return this.get(context, prior.id);
        }
      }
      return view;
    }
    if (input.kind === "knowledge_answer" && input.purpose === "evaluation" && !admission)
      throw new BadRequestException("请从原生评测入口启动任务");
    const model = (await this.models(context)).find((m) => m.id === input.modelId);
    if (!model)
      throw new BadRequestException("尚未配置可用的文本模型，请先在 AI 模型配置中添加并启用");
    const basis = admission?.prepared ? await admission.prepared(input) : await this.contexts.prepareForExecution(context, input);
    if (admission?.prepared) {
      if (assistFingerprint(basis.request) !== assistFingerprint(input)) throw new ConflictException("固定样本的原运输身份不一致");
      await this.contexts.assertExecutionCurrent(context, basis);
    }
    const attachments = { hasKnowledge: assistUsesReviewedGuidance(basis) };
    authorizeAssistRequest(context, input, "run", attachments);
    const prepared: AssistContext = { ...basis, accessPolicy: {
      version: ASSIST_ACCESS_POLICY_VERSION,
      requiredPermissions: admission?.benchmarkItemId && basis.benchmarkResources
        ? [...new Set([...requiredAssistRequestPermissions(input, "run", attachments), ...Object.keys(basis.benchmarkResources.permissionScopes)])]
        : requiredAssistRequestPermissions(input, "run", attachments),
      dataScope: context.dataScope,
    } };
    if (input.expectedTaskFingerprint && assistTaskFingerprint(prepared) !== input.expectedTaskFingerprint)
      throw new ConflictException("任务依据已变化，请重新读取并核对后再开始分析");
    const estimate = model.inputUsdPerMillion !== null && model.outputUsdPerMillion !== null ? calculateCostUsd(
      (JSON.stringify(prepared.data).length + assistSystemInstructions(false, isBenchmarkAssist(prepared), prepared.request.kind === "order_review").length + 8000) * 3 +
        prepared.images.length * 4096,
      ASSIST_MAX_OUTPUT_TOKENS,
      model.inputUsdPerMillion,
      model.outputUsdPerMillion,
    ) : null;
    if (estimate !== null && model.maxTaskCostUsd !== null && estimate > model.maxTaskCostUsd)
      throw new BadRequestException("本次资料的预估费用超过模型单次上限，请减少来源或调整配置");
    const row = await withTenant(this.database.db, context, async (tx) => {
      if (admission) await admission.before(tx);
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`}, 0))`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, input.requestId)));
      if (existing) {
        if (existing.benchmarkItemId && existing.benchmarkItemId !== admission?.benchmarkItemId)
          throw new ConflictException("benchmark_native_receipt_invalid");
        if (existing.requestFingerprint !== requestFingerprint)
          throw new ConflictException("同一请求不能更换分析参数");
        if (admission) await admission.replay(tx, existing);
        return existing;
      }
      if (input.kind === "artwork_preflight" && input.automaticAudit) {
        const recent = await tx.select().from(runs).where(and(eq(runs.scope, assistScope(input)), eq(runs.kind, input.kind), isNull(runs.benchmarkItemId))).orderBy(desc(runs.createdAt)).limit(50);
        for (const candidate of recent) {
          if (!candidate.encryptedInput || candidate.expiresAt <= new Date()) continue;
          const snapshot = await this.vault.withSecret(candidate.encryptedInput, value => JSON.parse(value) as AssistContext);
          if (snapshot.artworkAudit?.versionId !== input.expectedEditorVersionId || snapshot.artworkAudit?.revision !== input.expectedRevision || snapshot.artworkAudit?.policy !== prepared.artworkAudit?.policy) continue;
          if (["queued", "running"].includes(candidate.status) || !input.retryAudit) return candidate;
          break;
        }
      }
      const [route] = await tx
        .select()
        .from(modelRoutes)
        .where(
          and(
            eq(modelRoutes.id, model.id),
            eq(modelRoutes.status, "enabled"),
            inArray(modelRoutes.taskType, ["studio_analysis", "studio_text"]),
          ),
        );
      const target = route?.targets[0];
      const [provider] = target
        ? await tx
            .select()
            .from(modelProviderConfigs)
            .where(
              and(
                eq(modelProviderConfigs.id, target.providerConfigId),
                eq(modelProviderConfigs.status, "enabled"),
              ),
            )
        : [];
      if (
        !route ||
        route.targets.length !== 1 ||
        !target ||
        !provider ||
        !["openai", "openai-compatible"].includes(provider.provider)
      )
        throw new ConflictException({ code: "assist_model_changed", message: "模型配置已变化，请刷新后重试" });
      const currentModel = (await configuredAssistModels(tx, context.userId)).find(m => m.id === model.id);
      if (!currentModel || JSON.stringify(currentModel) !== JSON.stringify(model))
        throw new ConflictException({ code: "assist_pricing_changed", message: "模型计价配置已更新，请刷新后重试" });
      const [active] = await tx.execute<{ count: string }>(sql`select (
        (select count(*) from ai_assist_runs where tenant_id=${context.tenantId}::uuid and status in('queued','running') and expires_at>clock_timestamp())+
        (select count(*) from agent_loop_runs where tenant_id=${context.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())+
        (select count(*) from agent_plan_runs where tenant_id=${context.tenantId}::uuid and status in('queued','running','stopping') and expires_at>clock_timestamp())
      )::text as count`);
      if (Number(active?.count ?? 4) >= 4)
        throw new ConflictException({ code: "assist_concurrency_limit", message: "当前租户已有 4 个分析任务，请等待完成后再发起" });
      const [policy] = await tx.select().from(aiBudgetPolicies);
      if (policy && (estimate === null || model.maxTaskCostUsd === null))
        throw new ConflictException({ code: "assist_pricing_required", message: "组织已启用 AI 预算，请先为此模型填写渠道单价和单次费用上限" });
      const taskCap = model.maxTaskCostUsd === null ? null : Math.min(
        model.maxTaskCostUsd,
        policy
          ? (policy.taskCapsUsd[input.kind] ?? Number(policy.defaultTaskCapUsd))
          : model.maxTaskCostUsd,
      );
      if (estimate !== null && taskCap !== null && estimate > taskCap) throw new ConflictException({ code: "assist_task_budget_exceeded", message: "本次预估超过组织配置的单次 AI 预算" });
      if (policy && taskCap !== null) {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const [unpriced] = await tx.select({ id: runs.id }).from(runs).where(and(
          gte(runs.createdAt, monthStart), sql`${runs.modelSnapshot}->>'maxTaskCostUsd' is null`,
          sql`${runs.startedAt} is not null`, sql`${runs.costUsd} is null`,
          sql`not exists (select 1 from ${executions} e where e.run_id=${runs.id} and e.submission_state='not_submitted')`,
          sql`not exists (select 1 from ${modelBillingReconciliations} b where b.owner='assist' and b.assist_run_id=${runs.id})`,
        )).limit(1);
        if (unpriced) throw new ConflictException({ code: "assist_unpriced_usage", message: "本月存在未计价的 AI 调用，请先核对账单与预算，避免低估已发生费用" });
        const [sum] = await tx
          .select({ total: sql<string>`coalesce(sum(${aiBudgetLedger.amountUsd}), 0)` })
          .from(aiBudgetLedger)
          .where(
            and(
              gte(aiBudgetLedger.createdAt, monthStart),
              inArray(aiBudgetLedger.state, ["reserved", "committed"]),
            ),
          );
        if (Number(sum?.total ?? 0) + taskCap > Number(policy.monthlyCapUsd))
          throw new ConflictException({ code: "assist_monthly_budget_exceeded", message: "组织当月 AI 预算不足" });
      }
      const id = createEntityId();
      await this.contexts.assertMethodCurrent(tx,context,prepared,true);
      const [created] = await tx
        .insert(runs)
        .values({
          id,
          ...(admission?.benchmarkItemId ? { benchmarkItemId: admission.benchmarkItemId } : {}),
          tenantId: context.tenantId,
          ownerId: context.userId,
          requestId: input.requestId,
          kind: input.kind,
          scope: assistScope(input),
          orderLineId: "orderLineId" in input ? input.orderLineId : prepared.sensitiveOrderLineId ?? null,
          inputFingerprint: assistFingerprint(prepared),
          requestFingerprint,
          encryptedInput: this.vault.encrypt(JSON.stringify(prepared)),
          modelSnapshot: { ...model, maxTaskCostUsd: taskCap, providerConfigId: provider.id },
          promptVersion: assistPromptVersion(isBenchmarkAssist(prepared), prepared.request.kind === "order_review"),
          reservedCostUsd: taskCap?.toFixed(6) ?? "0",
          // Use the same database clock as created_at, including after lock waits.
          expiresAt: sql`least(now() + ${"orderLineId" in input || input.kind === "after_sales_review" ? 1 : 30} * interval '1 day', ${prepared.expiresAt ?? null}::timestamptz)`,
        })
        .returning();
      // A zero reservation is not a bill. Unknown costs remain null on the run.
      if (taskCap !== null) await tx.insert(aiBudgetLedger).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        requestId: id,
        taskType: input.kind,
        modelKey: model.model,
        provider: provider.provider,
        amountUsd: taskCap.toFixed(6),
        state: "reserved",
      });
      await tx.insert(executions).values({ runId: id, tenantId: context.tenantId, inputFingerprint: created!.inputFingerprint, policyChecksum: assistExecutionPolicy(!!prepared.artworkAudit, isBenchmarkAssist(prepared), prepared.request.kind === "order_review").checksum });
      if (admission) await admission.created(tx, created!, prepared, this.vault);
      return created!;
    });
    if (row.status === "queued") {
      try {
        await this.queue.enqueue({
          id: row.id,
          tenantId: context.tenantId,
          userId: context.userId,
          expiresAt: row.expiresAt,
        });
        await withTenant(this.database.db, context, tx => tx.update(executions)
          .set({ lastDispatchedAt: new Date(), dispatchCount: 1 })
          .where(and(eq(executions.runId, row.id), eq(executions.dispatchCount, 0))));
      } catch {
        await withTenant(this.database.db, context, async (tx) => {
          await tx
            .update(runs)
            .set({
              errorCode: "assist_dispatch_pending",
            })
            .where(and(eq(runs.id, row.id), eq(runs.status, "queued")));
        });
        // Committed intent survives Redis loss. Retry dispatch of this original run.
      }
    }
    return this.get(context, row.id);
  }

  /** Transport proof only, made from the actual native owner's returned audit.
   * Original paid/request records remain unchanged. */
  automaticAuditReuseProof(raw: unknown, view: AssistView) {
    const parsed = CreateAssistSchema.safeParse(raw), original = view.request, audit = view.artworkAudit;
    if (!parsed.success || parsed.data.kind !== "artwork_preflight" || !parsed.data.automaticAudit ||
      original?.kind !== "artwork_preflight" || !original.automaticAudit || original.requestId === parsed.data.requestId) return null;
    const input = parsed.data;
    if (view.kind !== input.kind || !audit || view.stale || original.orderLineId !== input.orderLineId ||
      original.expectedRevision !== input.expectedRevision || original.expectedEditorVersionId !== input.expectedEditorVersionId ||
      audit.orderLineId !== input.orderLineId || audit.revision !== input.expectedRevision || audit.versionId !== input.expectedEditorVersionId) return null;
    return AssistAutomaticAuditReuseProofSchema.parse({ version: "assist-automatic-audit-reuse-v1", disposition: "existing_policy_run",
      submittedRequestId: input.requestId, submittedRequestChecksum: createHash("sha256").update(assistRequestRecoveryText(input)).digest("hex"), runId: view.id,
      originalRequestId: original.requestId, originalRequestChecksum: createHash("sha256").update(assistRequestRecoveryText(original)).digest("hex"),
      policy: audit.policy, orderLineId: audit.orderLineId, revision: audit.revision, editorVersionId: audit.versionId });
  }

  async list(context: TenantContext, kind: AssistKind, scope: string, automaticAudit = false) {
    authorizeAssist(context, kind);
    if (automaticAudit) {
      if (kind !== "artwork_preflight") throw new BadRequestException("自动核对仅适用于生产稿");
      const candidates = await withTenant(this.database.db, context, tx => tx.select().from(runs).where(and(eq(runs.kind, kind), eq(runs.scope, scope), isNull(runs.benchmarkItemId))).orderBy(desc(runs.createdAt)).limit(50));
      const result = [];
      for (const row of candidates) {
        if (!row.encryptedInput || row.expiresAt <= new Date()) continue;
        const input = await this.vault.withSecret(row.encryptedInput, value => JSON.parse(value) as AssistContext);
        if (input.artworkAudit) result.push({id: row.id, status: row.status, createdAt: row.createdAt, modelLabel: row.modelSnapshot.label});
      }
      return result.slice(0, 20);
    }
    return withTenant(this.database.db, context, (tx) =>
      tx
        .select({
          id: runs.id,
          status: runs.status,
          createdAt: runs.createdAt,
          modelLabel: sql<string>`${runs.modelSnapshot}->>'label'`,
        })
        .from(runs)
        .where(and(eq(runs.ownerId, context.userId), eq(runs.kind, kind), eq(runs.scope, scope), isNull(runs.benchmarkItemId)))
        .orderBy(desc(runs.createdAt))
        .limit(20),
    );
  }

  /** Read an original owner/request receipt. Never enqueue, reserve or resubmit. */
  async receipt(context: TenantContext, raw: unknown) {
    const parsed = AssistReceiptQuerySchema.safeParse(raw);
    if (!parsed.success) throw new BadRequestException("原请求编号或摘要无法核对");
    const query = parsed.data;
    const original = await withTenant(this.database.db, context, async tx => {
      const current = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      if (!current.permissions.length) throw new ForbiddenError(Permission.DesignRead, "missing_permission");
      const [row] = await tx.select().from(runs).where(and(eq(runs.ownerId, current.userId), eq(runs.requestId, query.requestId), isNull(runs.benchmarkItemId))).limit(1);
      if (row) {
        authorizeAssist(current, row.kind);
        if (row.requestFingerprint !== query.requestChecksum) throw new ConflictException({ code: "assist_request_binding_mismatch", message: "原请求摘要不一致 请保留原编号核对" });
      }
      return { row: row ?? null, current };
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
    const run = original.row ? await this.get(original.current, original.row.id, { purgeExpired: false }) : null;
    const current = await withTenant(this.database.db, context, async tx => {
      const final = intersectPermissionContexts(context, await loadCurrentMembershipContext(tx, context, { lock: true }));
      if (erpSessionAuthority(final) !== erpSessionAuthority(original.current)) throw new ConflictException({ code: "authority_changed", message: "当前权限或资料范围已变化" });
      if (original.row) {
        authorizeAssist(final, original.row.kind);
        if (original.row.expiresAt > new Date() && original.row.encryptedInput) {
          const input = await this.vault.withSecret(original.row.encryptedInput, text => JSON.parse(text) as AssistContext);
          const attachments = { hasKnowledge: assistUsesReviewedGuidance(input), pinnedDataScope: input.accessPolicy?.dataScope ?? "tenant" };
          authorizeAssistRequest(final, input.request, "read", attachments);
          const rank = { self: 0, team: 1, tenant: 2 };
          for (const bit of requiredAssistRequestPermissions(input.request, "read", attachments))
            if (rank[permissionScope(final, bit)] < rank[attachments.pinnedDataScope]) throw new ForbiddenError(bit, "outside_data_scope");
        }
      }
      return final;
    }, { isolationLevel: "repeatable read", accessMode: "read write" });
    // A retention boundary crossed during the read must not release the old body.
    if (original.row && run?.request && original.row.expiresAt <= new Date())
      throw new ConflictException({ code: "assist_request_expired", message: "原任务内容保留期已结束 请重新读取原记录" });
    return AssistReceiptViewSchema.parse({ version: "assist-request-receipt-v1", contextAuthority: erpSessionAuthority(erpPermissionContext(current)), ...query,
      state: original.row ? "found" : "not_found", run });
  }

  async get(context: TenantContext, id: string, options: { purgeExpired?: boolean } = {}): Promise<AssistView> {
    const records = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ row: runs, execution: executions, budget: aiBudgetLedger })
        .from(runs)
        .leftJoin(aiBudgetLedger, and(eq(aiBudgetLedger.requestId, runs.id), eq(aiBudgetLedger.tenantId, runs.tenantId)))
        .leftJoin(executions, and(eq(executions.runId,runs.id),eq(executions.tenantId,runs.tenantId)))
        .where(eq(runs.id, id)),
    );
    const record=records[0];
    const row = record?.row;
    if (!row) throw new NotFoundException("分析记录不存在");
    // Automatic artwork reports are order evidence, shared with authorized tenant
    // reviewers. Other assistants remain private to their owner.
    if (row.ownerId !== context.userId && !(!row.benchmarkItemId && row.kind === "artwork_preflight" && row.encryptedInput && row.expiresAt > new Date() && await this.vault.withSecret(row.encryptedInput, value => !!(JSON.parse(value) as AssistContext).artworkAudit))) throw new NotFoundException("分析记录不存在");
    authorizeAssist(context, row.kind);
    const expired = row.expiresAt <= new Date();
    if (options.purgeExpired !== false && expired && !row.benchmarkItemId && (row.encryptedInput || row.encryptedOutput))
      await withTenant(this.database.db, context, (tx) =>
        tx.update(runs).set({ encryptedInput: null, encryptedOutput: null }).where(eq(runs.id, id)),
      );
    const input =
      !expired && row.encryptedInput
        ? await this.vault.withSecret(
            row.encryptedInput,
            async (v) => JSON.parse(v) as AssistContext,
          )
        : null;
    const readContext = row.benchmarkItemId ? await withTenant(this.database.db, context,
      tx => this.benchmarkReadContext(tx, context, row, input), { isolationLevel: "repeatable read", accessMode: "read write" }) : context;
    if (input) authorizeAssistRequest(readContext, input.request, "read", { hasKnowledge: assistUsesReviewedGuidance(input), pinnedDataScope: input.accessPolicy?.dataScope ?? "tenant" });
    let stale: boolean;
    if (!input) stale = true;
    else if (row.benchmarkItemId) {
      try { await this.contexts.assertExecutionCurrent(readContext, input); stale = false; }
      catch (error) { if (error instanceof ConflictException) stale = true; else throw error; }
    } else stale = await this.contexts.stale(context, input.request, input);
    const output =
      !expired && row.encryptedOutput
        ? await this.vault.withSecret(
            row.encryptedOutput,
            async (v) =>
              JSON.parse(v) as {
                result: AssistResult;
                diagnostics: string[];
                images?: Array<{ sourceId: string; dataUrl: string }>;
              },
          )
        : null;
    const images =
      stale && row.kind !== "creative"
        ? []
        : (output?.images ?? []).map((image, index) => ({
            sourceId: image.sourceId,
            label: input?.sources.find((s) => s.id === image.sourceId)?.label ?? "分析图片",
            path: `/api/ai-assists/runs/${id}/images/${index}`,
          }));
    const {reconciliations,budgets} = await withTenant(this.database.db,context,async tx=>({
      reconciliations:await readModelBillingAcknowledgments(tx,"assist",[id]),
      budgets:await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.requestId,id)),
    }),{isolationLevel:"repeatable read",accessMode:"read only"});
    if (input?.request.kind === "knowledge_answer") await this.contexts.assertKnowledgeReadAccess(context, input);
    if (row.benchmarkItemId) {
      await withTenant(this.database.db, context, tx => this.benchmarkReadContext(tx, context, row, input),
        { isolationLevel: "repeatable read", accessMode: "read write" });
      if (!expired && row.expiresAt <= new Date()) throw new ConflictException("benchmark_result_expired");
    }
    return {
      id: row.id,
      kind: row.kind,
      scope: row.scope,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      modelLabel: row.modelSnapshot.label,
      model: row.modelSnapshot.model,
      maxTaskCostUsd: row.modelSnapshot.maxTaskCostUsd,
      promptVersion: row.promptVersion,
      accessPolicy: input?.accessPolicy ?? null,
      inputAuthority: input?.inputAuthority ? { version: input.inputAuthority.version, capturedAt: input.inputAuthority.capturedAt, fingerprint: input.inputAuthority.fingerprint } : null,
      executionContract: input?.executionContract ?? null,
      methodSelection: input?.methodSelection ?? null,
      invocations: [assistInvocationView(row,record?.execution??null,budgets[0]??null,input?.executionContract??null,budgets.length>1,reconciliations.get(id)??null)],
      inputFingerprint: row.inputFingerprint,
      request: stale && row.kind === "after_sales_review" ? null : input?.request ?? null,
      stale,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costUsd === null ? null : Number(row.costUsd),
      budgetState: budgets.length!==1||budgets[0]?.state==null ? null : AssistBudgetStateSchema.parse(budgets[0].state),
      error: expired
        ? "分析内容保留期已结束，请基于当前资料重新分析"
        : row.errorCode
          ? assistError(row.errorCode)
          : null,
      sources: stale && row.kind !== "creative" ? [] : (input?.sources ?? []),
      knowledge: stale && row.kind !== "creative" ? [] : (input?.knowledge ?? []),
      checks: stale && row.kind !== "creative" ? [] : (input?.checks ?? []),
      diagnostics: [...(input?.diagnostics ?? []), ...(output?.diagnostics ?? [])],
      result: stale && row.kind !== "creative" ? null : (output?.result ?? null),
      artworkAudit: !stale && input ? artworkAuditReport(input, output?.result ?? null, (output?.images ?? []).map(i => i.sourceId), row.status === "completed") : null,
      images,
    };
  }

  private async benchmarkReadContext(tx: TenantTransaction, ceiling: TenantContext, row: typeof runs.$inferSelect, input: AssistContext | null) {
    const current = await currentEvaluationContext(tx, ceiling);
    const [item] = await tx.select({ id: knowledgeBenchmarkItems.id, fields: knowledgeBenchmarkItems.fields,
      caseId: knowledgeBenchmarkItems.caseId, caseChecksum: knowledgeBenchmarkItems.caseChecksum,
      basisFingerprint: knowledgeBenchmarkItems.basisFingerprint, taskFingerprint: knowledgeBenchmarkItems.taskFingerprint,
      sourcePins: knowledgeBenchmarkItems.sourcePins, createdBy: knowledgeBenchmarkItems.createdBy,
      dataScope: knowledgeBenchmarkVersions.dataScope,
    }).from(knowledgeBenchmarkItems).innerJoin(knowledgeBenchmarkVersions, eq(knowledgeBenchmarkVersions.id, knowledgeBenchmarkItems.versionId))
      .where(eq(knowledgeBenchmarkItems.id, row.benchmarkItemId!));
    const parsed = BusinessBenchmarkCaseSchema.safeParse(item?.fields);
    if (!item || !parsed.success || item.createdBy !== current.userId || row.ownerId !== current.userId ||
      row.tenantId !== current.tenantId || item.caseId !== null || parsed.data.role !== row.kind || row.promptVersion !== assistPromptVersion(false, row.kind === "order_review"))
      throw new ConflictException("benchmark_native_receipt_invalid");
    assertEvaluationScope(current, item.dataScope, "read");
    assertBusinessBenchmarkScope(current, item.dataScope, parsed.data.role);
    const first = item.sourcePins[0], bindings = first && "kind" in first ? first.resourceBindings : undefined;
    if (!LEGACY_BUSINESS_BENCHMARK_ROLES.some(role => role === parsed.data.role) && !bindings) throw new ConflictException("benchmark_basis_unavailable");
    await assertBusinessBenchmarkResources(tx, current, [parsed.data.task], bindings, input ? "content" : "metadata");
    if (input && (input.benchmarkExecutionVersion || assistFingerprint(input) !== row.inputFingerprint ||
      input.request.kind !== row.kind || input.request.requestId !== row.requestId || input.request.modelId !== row.modelSnapshot.id ||
      assistScope(input.request) !== row.scope || input.accessPolicy?.dataScope !== item.dataScope ||
      businessBenchmarkCaseChecksum(parsed.data) !== item.caseChecksum || businessBenchmarkBasisFingerprint(parsed.data, input) !== item.basisFingerprint ||
      assistTaskFingerprint(input) !== item.taskFingerprint ||
      knowledgeEvaluationChecksum(businessBenchmarkSourcePins(input)) !== knowledgeEvaluationChecksum(item.sourcePins)))
      throw new ConflictException("benchmark_native_receipt_invalid");
    return current;
  }

  /** Server-only safeguard: a benchmark result is evidence for evaluation, never an adoption decision. */
  async assertBusinessAdoptionAllowed(context: TenantContext, id: string) {
    const [row] = await withTenant(this.database.db, context, tx => tx.select({ benchmarkItemId: runs.benchmarkItemId })
      .from(runs).where(and(eq(runs.id, id), eq(runs.ownerId, context.userId))));
    if (!row) throw new NotFoundException("分析记录不存在");
    if (row.benchmarkItemId) throw new ConflictException("benchmark_adoption_forbidden");
  }

  async image(context: TenantContext, id: string, index: number): Promise<Buffer> {
    const view = await this.get(context, id);
    if (!view.images[index] || view.stale)
      throw new NotFoundException("分析图片已不可读取，请重新分析当前资料");
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ row: runs, output: runs.encryptedOutput })
        .from(runs)
        .where(eq(runs.id, id)),
    );
    if (!row?.output) throw new NotFoundException("分析图片已过期");
    const images = this.vault.withSecret(
      row.output,
      (v) => (JSON.parse(v) as { images: Array<{ dataUrl: string }> }).images,
    );
    const dataUrl = images[index]?.dataUrl;
    if (!dataUrl?.startsWith("data:image/jpeg;base64,"))
      throw new NotFoundException("分析图片不可用");
    const body = Buffer.from(dataUrl.slice("data:image/jpeg;base64,".length), "base64");
    if (row.row.benchmarkItemId) {
      try {
        await withTenant(this.database.db, context, async tx => {
          if (!row.row.encryptedInput || row.row.expiresAt <= new Date()) throw new ConflictException("benchmark_result_expired");
          const input = this.vault.withSecret(row.row.encryptedInput, value => JSON.parse(value) as AssistContext);
          await this.benchmarkReadContext(tx, context, row.row, input);
          if (row.row.expiresAt <= new Date()) throw new ConflictException("benchmark_result_expired");
        }, { isolationLevel: "repeatable read", accessMode: "read write" });
      } catch (error) { body.fill(0); throw error; }
    }
    return body;
  }
}
function assistError(code: string) {
  const messages: Record<string, string> = {
    assist_provider_unavailable: "渠道已停用或不支持图文分析，请检查配置",
    assist_pricing_required: "组织已启用预算，请先配置此模型的渠道价格和费用上限",
    assist_protocol_unsupported: "渠道不支持当前图片或结构化输出参数，请核对模型的图文分析能力",
    assist_auth_failed: "渠道拒绝访问，请核对已保存的 Key 和模型权限",
    assist_model_unavailable: "渠道未找到此模型或接口，请刷新模型目录并核对 API 地址",
    assist_rate_limited: "渠道额度不足或请求受限，请查看渠道余额与限额后重试",
    assist_provider_failed: "渠道暂时未能完成分析，未自动重试，请核对渠道状态",
    assist_queue_unavailable: "后台任务暂不可用，请重新发起",
    assist_dispatch_pending: "任务已保存，后台正在恢复原任务的排队，无需重新发起",
    assist_local_retry_pending: "模型响应已保存，正在恢复本地处理，不会重复调用模型",
    assist_submission_unknown: "原模型请求的结果不明，预算保留；请核对渠道记录，系统不会自动重发",
    assist_local_processing_failed: "本地处理未完成，已停止自动恢复；保留原响应与费用记录供核对",
    assist_execution_version_unsupported: "原任务执行版本暂不受支持，请核对版本后处理",
    assist_checkpoint_invalid: "原响应校验未通过，已停止处理且不会重发模型请求",
    assist_evaluation_proof_invalid: "原评测协议或评分来源无法核验，已停止执行且不会重发模型请求",
    assist_source_changed: "任务依据的版本、状态或有效期已变化；请重新读取当前依据后分析，已产生的费用记录保留",
    assist_authority_snapshot_missing: "旧任务缺少业务依赖快照，未继续执行；请基于当前资料新建任务",
    assist_authority_snapshot_invalid: "业务依赖快照无法核验，已停止执行，请重新读取依据",
    assist_authority_capacity_exceeded: "业务依赖超过核验上限，请缩小任务范围",
    assist_harness_contract_missing: "旧任务缺少工具与执行方法快照，未继续调用模型；请基于当前资料新建任务",
    assist_harness_contract_invalid: "工具与执行方法快照无法核验，已停止执行",
    assist_harness_contract_changed: "已固定的工具或执行方法版本不受当前执行器支持，请核对后新建任务",
    assist_harness_tool_unavailable: "执行方法没有可用的已注册工具，任务已停止",
    assist_harness_tool_input_invalid: "输入不满足已固定工具契约，请重新读取当前资料",
    assist_harness_tool_output_invalid: "输出不满足已固定工具契约，本次结果未采用，已有费用记录保留",
    assist_method_unavailable: "已选方法没有可核验的发布记录，请检查方法版本",
    assist_method_withdrawn: "方法已停用，旧任务停止执行；重新启用后请基于当前方法新建任务",
    assist_method_snapshot_missing: "旧任务缺少方法发布快照，不能沿用当前组织的方法授权，请重新读取后新建任务",
    assist_method_changed: "已固定的方法版本与当前注册能力不一致，请核对部署及方法版本",
    assist_method_sources_unavailable: "方法引用的知识已失效、撤销或存在冲突，本次结果未采用，已产生的费用保留",
    assist_interrupted: "上次调用中断，未自动重复计费请求；重试前请核对渠道账单",
    assist_expired: "分析资料已过期，请重新发起",
    assist_access_changed: "当前权限或资料访问范围已变化，请重新读取有权访问的依据",
    assist_input_changed: "任务输入与已保存的任务类型不一致，请重新核对依据",
    assist_invalid_evidence: "模型返回了无法核验的来源，本次结果未采用",
    assist_invalid_match: "模型推荐了候选库之外的匹配，本次结果未采用",
    assist_invalid_order_field_binding: "模型给出的字段关系与本单原始资料不一致，本次字段建议未采用",
    assist_invalid_result: "模型未返回完整的结构化结果，请检查模型是否支持结构化图文分析",
    assist_invalid_artwork_checks: "模型未完整返回三项看图核对，本次未判定通过；可重新核对或人工复核",
    assist_model_output_truncated: "模型输出达到长度限制，未返回完整核对结果",
    assist_model_output_missing: "渠道响应中没有可读取的核对结果，请检查所选模型的图文输出能力",
    assist_model_output_invalid_json: "模型没有返回约定的结构化结果，本次未采用",
    assist_network_failed: "连接模型渠道失败，本次未自动重试",
    assist_missing_evidence: "模型结论缺少依据，本次结果未采用",
    assist_missing_product_evidence: "文案缺少商品资料依据，运营知识不能代替商品规格，本次结果未采用",
  };
  return messages[code] ?? "分析失败，请检查渠道、图文能力和结构化输出支持；重试会发起新的模型调用";
}
