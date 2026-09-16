import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  ASSIST_INSTRUCTIONS,
  ASSIST_MAX_OUTPUT_TOKENS,
  ASSIST_PROMPT_VERSION,
  assistFingerprint,
  assistScope,
  calculateCostUsd,
  type AssistContext,
  type SecretVault,
} from "@yummyai/ai-core";
import { authorize, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  AssistModelInputSchema,
  CreateAssistSchema,
  type AssistKind,
  type AssistModel,
  type AssistResult,
  type AssistView,
} from "@yummyai/contracts/ai/assist";
import {
  aiAssistRuns as runs,
  aiBudgetLedger,
  aiBudgetPolicies,
  modelProviderConfigs,
  modelRoutes,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { AI_ASSIST_VAULT, DATABASE_CONNECTION } from "../platform.tokens.js";
import { AssistContextService } from "./assist-context.service.js";
import { authorizeBusinessAssist } from "./assist-business-context.service.js";
import { configuredAssistModels } from "./configured-assist-models.js";

export abstract class AssistEnqueuer {
  abstract enqueue(input: {
    id: string;
    tenantId: string;
    userId: string;
    expiresAt: Date;
  }): Promise<void>;
}
export function authorizeAssist(context: TenantContext, kind: AssistKind, write = false) {
  if (kind === "business_review" || kind === "procurement_review" || kind === "after_sales_review") {
    authorizeBusinessAssist(context, kind); return;
  }
  if (kind === "template_config") {
    authorize(context, Permission.DesignRead);
    if (write) authorize(context, Permission.DesignWrite);
    return;
  }
  if (kind === "sku_package") {
    authorize(context, Permission.ListingRead);
    authorize(context, Permission.ProductRead);
    authorize(context, Permission.DesignRead);
    if (write) authorize(context, Permission.ListingWrite);
    return;
  }
  authorize(
    context,
    kind === "creative"
      ? write
        ? Permission.DesignWrite
        : Permission.DesignRead
      : Permission.OrderRead,
  );
  if (kind === "creative") authorize(context, Permission.ResearchRead);
  else {
    authorize(context, Permission.OrderPiiRead);
    if (write)
      authorize(context, kind === "order_review" ? Permission.OrderWrite : Permission.DesignWrite);
    if (kind === "artwork_preflight") authorize(context, Permission.DesignRead);
  }
}

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
    const allowed = [Permission.DesignRead, Permission.OrderRead, Permission.FinanceRead, Permission.ProcurementRead];
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

  async create(context: TenantContext, raw: unknown): Promise<AssistView> {
    const input = CreateAssistSchema.parse(raw);
    authorizeAssist(context, input.kind, true);
    const requestFingerprint = assistFingerprint(input);
    const [prior] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(runs)
        .where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, input.requestId))),
    );
    if (prior) {
      if (prior.requestFingerprint !== requestFingerprint)
        throw new ConflictException("同一请求不能更换分析参数");
      if (prior.status === "queued" && prior.expiresAt > new Date())
        await this.queue.enqueue({
          id: prior.id,
          tenantId: context.tenantId,
          userId: context.userId,
          expiresAt: prior.expiresAt,
        });
      return this.get(context, prior.id);
    }
    const model = (await this.models(context)).find((m) => m.id === input.modelId);
    if (!model)
      throw new BadRequestException("尚未配置可用的文本模型，请先在 AI 模型配置中添加并启用");
    const prepared = await this.contexts.prepare(context, input);
    const estimate = model.inputUsdPerMillion !== null && model.outputUsdPerMillion !== null ? calculateCostUsd(
      (JSON.stringify(prepared.data).length + ASSIST_INSTRUCTIONS.length + 8000) * 3 +
        prepared.images.length * 4096,
      ASSIST_MAX_OUTPUT_TOKENS,
      model.inputUsdPerMillion,
      model.outputUsdPerMillion,
    ) : null;
    if (estimate !== null && model.maxTaskCostUsd !== null && estimate > model.maxTaskCostUsd)
      throw new BadRequestException("本次资料的预估费用超过模型单次上限，请减少来源或调整配置");
    const row = await withTenant(this.database.db, context, async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`model-configuration:${context.tenantId}`}, 0))`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${context.tenantId}:ai-assist-budget`}, 0))`,
      );
      const [existing] = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.ownerId, context.userId), eq(runs.requestId, input.requestId)));
      if (existing) {
        if (existing.requestFingerprint !== requestFingerprint)
          throw new ConflictException("同一请求不能更换分析参数");
        return existing;
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
        throw new ConflictException("模型配置已变化，请刷新后重试");
      const currentModel = (await configuredAssistModels(tx, context.userId)).find(m => m.id === model.id);
      if (!currentModel || JSON.stringify(currentModel) !== JSON.stringify(model))
        throw new ConflictException("模型计价配置已更新，请刷新后重试");
      const active = await tx
        .select({ id: runs.id })
        .from(runs)
        .where(and(inArray(runs.status, ["queued", "running"]), gte(runs.expiresAt, new Date())))
        .limit(4);
      if (active.length >= 4)
        throw new ConflictException("当前租户已有 4 个分析任务，请等待完成后再发起");
      const [policy] = await tx.select().from(aiBudgetPolicies);
      if (policy && (estimate === null || model.maxTaskCostUsd === null))
        throw new ConflictException("组织已启用 AI 预算，请先为此模型填写渠道单价和单次费用上限");
      const taskCap = model.maxTaskCostUsd === null ? null : Math.min(
        model.maxTaskCostUsd,
        policy
          ? (policy.taskCapsUsd[input.kind] ?? Number(policy.defaultTaskCapUsd))
          : model.maxTaskCostUsd,
      );
      if (estimate !== null && taskCap !== null && estimate > taskCap) throw new ConflictException("本次预估超过组织配置的单次 AI 预算");
      if (policy && taskCap !== null) {
        const monthStart = new Date();
        monthStart.setUTCDate(1);
        monthStart.setUTCHours(0, 0, 0, 0);
        const [unpriced] = await tx.select({ id: runs.id }).from(runs).where(and(
          gte(runs.createdAt, monthStart), sql`${runs.modelSnapshot}->>'maxTaskCostUsd' is null`,
          sql`${runs.startedAt} is not null`, sql`${runs.costUsd} is null`,
        )).limit(1);
        if (unpriced) throw new ConflictException("本月存在未计价的 AI 调用，请先核对账单与预算，避免低估已发生费用");
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
          throw new ConflictException("组织当月 AI 预算不足");
      }
      const id = createEntityId();
      const [created] = await tx
        .insert(runs)
        .values({
          id,
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
          promptVersion: ASSIST_PROMPT_VERSION,
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
      } catch {
        await withTenant(this.database.db, context, async (tx) => {
          const updated = await tx
            .update(runs)
            .set({
              status: "failed",
              completedAt: new Date(),
              errorCode: "assist_queue_unavailable",
            })
            .where(and(eq(runs.id, row.id), eq(runs.status, "queued")))
            .returning({ id: runs.id });
          if (updated.length)
            await tx
              .update(aiBudgetLedger)
              .set({ state: "released" })
              .where(eq(aiBudgetLedger.requestId, row.id));
        });
        throw new ServiceUnavailableException("后台任务暂不可用，请稍后重新分析");
      }
    }
    return this.get(context, row.id);
  }

  async list(context: TenantContext, kind: AssistKind, scope: string) {
    authorizeAssist(context, kind);
    return withTenant(this.database.db, context, (tx) =>
      tx
        .select({
          id: runs.id,
          status: runs.status,
          createdAt: runs.createdAt,
          modelLabel: sql<string>`${runs.modelSnapshot}->>'label'`,
        })
        .from(runs)
        .where(and(eq(runs.ownerId, context.userId), eq(runs.kind, kind), eq(runs.scope, scope)))
        .orderBy(desc(runs.createdAt))
        .limit(20),
    );
  }

  async get(context: TenantContext, id: string): Promise<AssistView> {
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, id), eq(runs.ownerId, context.userId))),
    );
    if (!row) throw new NotFoundException("分析记录不存在");
    authorizeAssist(context, row.kind);
    const expired = row.expiresAt <= new Date();
    if (expired && (row.encryptedInput || row.encryptedOutput))
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
    const stale = !input || (await this.contexts.stale(context, input.request, input));
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
      inputFingerprint: row.inputFingerprint,
      request: stale && row.kind === "after_sales_review" ? null : input?.request ?? null,
      stale,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      costUsd: row.costUsd === null ? null : Number(row.costUsd),
      error: expired
        ? "分析内容保留期已结束，请基于当前资料重新分析"
        : row.errorCode
          ? assistError(row.errorCode)
          : null,
      sources: stale && row.kind !== "creative" ? [] : (input?.sources ?? []),
      checks: stale && row.kind !== "creative" ? [] : (input?.checks ?? []),
      diagnostics: [...(input?.diagnostics ?? []), ...(output?.diagnostics ?? [])],
      result: stale && row.kind !== "creative" ? null : (output?.result ?? null),
      images,
    };
  }

  async image(context: TenantContext, id: string, index: number): Promise<Buffer> {
    const view = await this.get(context, id);
    if (!view.images[index] || view.stale)
      throw new NotFoundException("分析图片已不可读取，请重新分析当前资料");
    const [row] = await withTenant(this.database.db, context, (tx) =>
      tx
        .select({ output: runs.encryptedOutput })
        .from(runs)
        .where(and(eq(runs.id, id), eq(runs.ownerId, context.userId))),
    );
    if (!row?.output) throw new NotFoundException("分析图片已过期");
    const images = this.vault.withSecret(
      row.output,
      (v) => (JSON.parse(v) as { images: Array<{ dataUrl: string }> }).images,
    );
    const dataUrl = images[index]?.dataUrl;
    if (!dataUrl?.startsWith("data:image/jpeg;base64,"))
      throw new NotFoundException("分析图片不可用");
    return Buffer.from(dataUrl.slice("data:image/jpeg;base64,".length), "base64");
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
    assist_interrupted: "上次调用中断，未自动重复计费请求；重试前请核对渠道账单",
    assist_expired: "分析资料已过期，请重新发起",
    assist_invalid_evidence: "模型返回了无法核验的来源，本次结果未采用",
    assist_invalid_match: "模型推荐了候选库之外的匹配，本次结果未采用",
    assist_invalid_result: "模型未返回完整的结构化结果，请检查模型是否支持结构化图文分析",
    assist_missing_evidence: "模型结论缺少依据，本次结果未采用",
  };
  return messages[code] ?? "分析失败，请检查渠道、图文能力和结构化输出支持；重试会发起新的模型调用";
}
