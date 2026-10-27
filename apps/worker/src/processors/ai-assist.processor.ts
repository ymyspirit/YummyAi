import {
  assistHarness,
  isBenchmarkAssist,
  assistUsesReviewedGuidance,
  HarnessContractError,
  ASSIST_MAX_OUTPUT_TOKENS,
  assistPromptVersion,
  assistResultSchema,
  OpenAiCompatibleProvider,
  OpenAiProvider,
  ProviderError,
  validateAssistResult,
  readAssistResearchImageBytes,
  type AssistContext,
  type ModelProvider,
  type SecretVault,
} from "@yummyai/ai-core";
import { CreateAssistSchema, AssistInputAuthoritySchema } from "@yummyai/contracts/ai/assist";
import { authorizeAssistRequest, ForbiddenError, requiredAssistPermissions, ASSIST_ACCESS_POLICY_VERSION } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import {
  aiAssistRuns as runs,
  aiAssistExecutions,
  aiBudgetLedger,
  aiBudgetPolicies,
  memberships,
  membershipRoles,
  roles,
  modelProviderConfigs,
  modelRoutes,
  withTenant,
  captureAssistInputAuthority,
  assertAssistInputAuthority,
  assertAgentMethodSelection,
  type DatabaseConnection,
} from "@yummyai/database";
import type { JobEnvelope } from "@yummyai/jobs";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";
import { DurableAssistExecution } from "./ai-assist-execution.js";
import { knowledgeExecutionAuthority, assertMethodKnowledge } from "@yummyai/knowledge-core";

type ProviderRow = typeof modelProviderConfigs.$inferSelect;
type Run = typeof runs.$inferSelect;
export const assistPricing = (model: Run["modelSnapshot"]) => model.inputUsdPerMillion !== null && model.outputUsdPerMillion !== null
  ? { inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion } : null;
export type AssistProviderFactory = (
  provider: ProviderRow,
  apiKey: string,
  run: Run,
) => ModelProvider;
export class AiAssistProcessor {
  constructor(
    private readonly database: DatabaseConnection,
    private readonly modelVault: SecretVault,
    private readonly contentVault: SecretVault,
    private readonly providerFactory: AssistProviderFactory = (provider, apiKey, run) =>
      provider.provider === "openai"
        ? new OpenAiProvider({
            apiKey,
            endpoint: provider.endpoint ?? undefined,
            pricing: assistPricing(run.modelSnapshot),
          })
        : new OpenAiCompatibleProvider({
            providerId: provider.id,
            apiKey,
            endpoint: provider.endpoint!,
            pricing: assistPricing(run.modelSnapshot),
          }),
    private readonly fetchImage: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async process(envelope: JobEnvelope) {
    const { runId: id, operation } = z
      .object({ runId: z.uuidv7(), operation: z.enum(["analyze", "expire"]) })
      .parse(envelope.payload);
    const context: TenantContext = {
      tenantId: envelope.tenantId,
      userId: envelope.requestedBy,
      permissions: [],
      dataScope: "tenant",
    };
    const [execution] = await withTenant(this.database.db, context, tx => tx.select().from(aiAssistExecutions).where(eq(aiAssistExecutions.runId, id)));
    if (execution) return new DurableAssistExecution({
      database: this.database, contentVault: this.contentVault,
      provider: async (ctx, run, input) => {
        const provider = await this.providerForExecution(ctx, run, input);
        return this.modelVault.withSecret(provider.encryptedApiKey, async key => this.providerFactory(provider, key, run));
      },
      readImage: url => readResearchImage(url, this.fetchImage),
    }).process(context, id, operation);
    const row = await withTenant(this.database.db, context, async (tx) => {
      const [current] = await tx
        .select()
        .from(runs)
        .where(and(eq(runs.id, id), eq(runs.ownerId, context.userId)))
        .for("update");
      if (!current) return null;
      if (operation === "expire" || current.expiresAt <= new Date()) {
        if (current.expiresAt > new Date()) return null;
        await tx
          .update(runs)
          .set({
            encryptedInput: null,
            encryptedOutput: null,
            ...(["queued", "running"].includes(current.status)
              ? { status: "failed" as const, errorCode: "assist_expired", completedAt: new Date() }
              : {}),
          })
          .where(eq(runs.id, id));
        if (current.status === "queued")
          await tx
            .update(aiBudgetLedger)
            .set({ state: "released" })
            .where(eq(aiBudgetLedger.requestId, id));
        return null;
      }
      if (["completed", "failed", "cancelled"].includes(current.status)) return null;
      if (current.status === "running") {
        // A stalled job may already have reached the provider. Never repeat it automatically.
        await tx
          .update(runs)
          .set({ status: "failed", errorCode: "assist_interrupted", completedAt: new Date() })
          .where(eq(runs.id, id));
        return null;
      }
      await tx
        .update(runs)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(runs.id, id));
      return current;
    });
    if (!row) return { id, disposition: "skipped" };
    let submitted = false;
    try {
      if (!row.encryptedInput) throw new Error("assist_expired");
      const input = await this.contentVault.withSecret(
        row.encryptedInput,
        async (data) => JSON.parse(data) as AssistContext,
      );
      input.request = CreateAssistSchema.parse(input.request);
      if (input.request.kind !== row.kind) throw new Error("assist_input_changed");
      await this.providerForExecution(context, row, input);
      const images: Array<{ sourceId: string; dataUrl: string }> = [],
        diagnostics: string[] = [];
      for (const image of input.images) {
        try {
          const dataUrl = image.dataUrl ?? (await readResearchImage(image.url!, this.fetchImage));
          images.push({ sourceId: image.sourceId, dataUrl });
        } catch {
          diagnostics.push(
            `未读到图片“${input.sources.find((s) => s.id === image.sourceId)?.label ?? image.sourceId}”，相关视觉内容未经检查`,
          );
        }
      }
      const imageIds = images.map((i) => i.sourceId);
      const availableSources = input.sources.filter(
        (s) => !input.images.some((i) => i.sourceId === s.id) || imageIds.includes(s.id),
      );
      // Image downloads may take seconds. Re-read current grants and route just before external submission.
      const provider = await this.providerForExecution(context, row, input);
      const harness = assistHarness(row.kind, !!input.artworkAudit, requiredAssistPermissions(row.kind, "run"), ASSIST_ACCESS_POLICY_VERSION, isBenchmarkAssist(input));
      const result = await this.modelVault.withSecret(provider.encryptedApiKey, async (apiKey) => {
        const model = this.providerFactory(provider, apiKey, row);
        if (row.expiresAt <= new Date()) throw new Error("assist_expired");
        submitted = true;
        return model.generate(
          {
            modelKey: row.modelSnapshot.model,
            providerModel: row.modelSnapshot.model,
            taskType: row.kind,
            systemInstructions: harness.registry.instructions(input.executionContract, harness.skill),
            untrustedSourceData: {
              ...input.data,
              sources: availableSources,
              checks: input.checks,
              diagnostics: [...input.diagnostics, ...diagnostics],
              availableImageIds: imageIds,
            },
            images,
            outputSchema: assistResultSchema(isBenchmarkAssist(input), row.kind === "order_review"),
            outputSchemaName: "erp_assist",
            maxCostUsd: row.modelSnapshot.maxTaskCostUsd,
            maxOutputTokens: ASSIST_MAX_OUTPUT_TOKENS,
          },
          AbortSignal.timeout(harness.registry.descriptor(input.executionContract, harness.skill, harness.toolKey).timeout.milliseconds),
        );
      });
      const validated = validateAssistResult(result.value, input, imageIds);
      harness.registry.checkOutput(input.executionContract, harness.skill, harness.toolKey, validated);
      const usageKnown =
        result.usageReported === true &&
        Number.isSafeInteger(result.inputTokens) &&
        result.inputTokens >= 0 &&
        Number.isSafeInteger(result.outputTokens) &&
        result.outputTokens >= 0;
      const costKnown = usageKnown && assistPricing(row.modelSnapshot) !== null && result.costUsd !== null && Number.isFinite(result.costUsd) && result.costUsd >= 0;
      if (!usageKnown)
        diagnostics.push("渠道未返回完整用量；费用未知，预算预留保留，实际费用请查看渠道账单");
      else if (!costKnown) diagnostics.push("未配置渠道单价，已记录实际 tokens，费用以渠道账单为准");
      else if (row.modelSnapshot.maxTaskCostUsd !== null && result.costUsd! > row.modelSnapshot.maxTaskCostUsd)
        diagnostics.push("渠道报告的费用超过预估上限，请核对配置的单价和渠道账单");
      await withTenant(this.database.db, context, async (tx) => {
        const updated = await tx
          .update(runs)
          .set({
            status: "completed",
            completedAt: new Date(),
            encryptedOutput: this.contentVault.encrypt(
              JSON.stringify({ result: validated, diagnostics, images }),
            ),
            inputTokens: usageKnown ? result.inputTokens : null,
            outputTokens: usageKnown ? result.outputTokens : null,
            costUsd: costKnown ? result.costUsd!.toFixed(6) : null,
          })
          .where(and(eq(runs.id, id), eq(runs.status, "running")))
          .returning({ id: runs.id });
        if (updated.length && costKnown)
          await tx
            .update(aiBudgetLedger)
            .set({ state: "committed", amountUsd: result.costUsd!.toFixed(6) })
            .where(eq(aiBudgetLedger.requestId, id));
      });
      return { id, disposition: "completed" };
    } catch (cause) {
      const code =
        cause instanceof HarnessContractError ? `assist_${cause.code}` :
        cause instanceof ProviderError ? ({ 400: "assist_protocol_unsupported", 401: "assist_auth_failed", 403: "assist_auth_failed", 404: "assist_model_unavailable", 429: "assist_rate_limited" } as Record<number, string>)[cause.statusCode ?? 0] ?? "assist_provider_failed"
        : cause instanceof z.ZodError || cause instanceof SyntaxError ? "assist_invalid_result"
        : cause instanceof Error && ["model_output_truncated", "model_output_missing", "model_output_invalid_json"].includes(cause.message) ? `assist_${cause.message}`
        : cause instanceof TypeError && cause.message === "fetch failed" ? "assist_network_failed"
        : cause instanceof Error && /^assist_[a-z_]+$/.test(cause.message)
          ? cause.message
          : "assist_failed";
      await withTenant(this.database.db, context, async (tx) => {
        await tx
          .update(runs)
          .set({ status: "failed", errorCode: code, completedAt: new Date() })
          .where(and(eq(runs.id, id), eq(runs.status, "running")));
        if (!submitted)
          await tx
            .update(aiBudgetLedger)
            .set({ state: "released" })
            .where(eq(aiBudgetLedger.requestId, id));
      });
      // Logs and queue errors never contain provider bodies, buyer data, images, or credentials.
      return { id, disposition: "failed", code };
    }
  }

  private async providerForExecution(context: TenantContext, row: Run, input: AssistContext): Promise<ProviderRow> {
    if (row.promptVersion !== assistPromptVersion(isBenchmarkAssist(input), row.kind === "order_review"))
      throw new Error("assist_execution_version_unsupported");
    const { current, grants, provider, route, policy } = await withTenant(this.database.db, context, async tx => {
      const [current] = await tx.select({ status: runs.status, expiresAt: runs.expiresAt }).from(runs)
        .where(and(eq(runs.id, row.id), eq(runs.ownerId, context.userId)));
      const grants = await tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(memberships)
        .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
        .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
        .where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active")));
      const [provider] = await tx.select().from(modelProviderConfigs)
        .where(and(eq(modelProviderConfigs.id, row.modelSnapshot.providerConfigId), eq(modelProviderConfigs.status, "enabled")));
      const [route] = await tx.select().from(modelRoutes).where(eq(modelRoutes.id, row.modelSnapshot.id));
      const [policy] = await tx.select().from(aiBudgetPolicies);
      return { current, grants, provider, route, policy };
    });
    if (!current || current.status !== "running") throw new Error("assist_interrupted");
    if (current.expiresAt <= new Date()) throw new Error("assist_expired");
    const dataScope = grants.some(grant => grant.dataScope === "tenant") ? "tenant"
      : grants.some(grant => grant.dataScope === "team") ? "team" : "self";
    try {
      authorizeAssistRequest({ ...context, dataScope, permissions: [...new Set(grants.flatMap(grant => [...grant.permissions]))] },
        input.request, "run", { hasKnowledge: assistUsesReviewedGuidance(input), pinnedDataScope: input.accessPolicy?.dataScope ?? "tenant" });
    } catch (error) {
      if (error instanceof ForbiddenError) throw new Error("assist_access_changed");
      throw error;
    }
    if (!provider || !["openai", "openai-compatible"].includes(provider.provider)) throw new Error("assist_provider_unavailable");
    if (!route || route.status !== "enabled" || !["studio_text", "studio_analysis"].includes(route.taskType)
      || route.targets.length !== 1 || route.targets[0]!.providerConfigId !== provider.id
      || route.targets[0]!.providerModel !== row.modelSnapshot.model) throw new Error("assist_provider_unavailable");
    if (policy && row.modelSnapshot.maxTaskCostUsd === null) throw new Error("assist_pricing_required");
    if (!input.inputAuthority) throw new Error("assist_authority_snapshot_missing");
    try { AssistInputAuthoritySchema.parse(input.inputAuthority); }
    catch { throw new Error("assist_authority_snapshot_invalid"); }
    const authorizedContext: TenantContext = { ...context, dataScope, permissions: [...new Set(grants.flatMap(grant => [...grant.permissions]))] };
    await withTenant(this.database.db, authorizedContext, async tx => {
      const binding=assistHarness(row.kind,!!input.artworkAudit,requiredAssistPermissions(row.kind,"run"),ASSIST_ACCESS_POLICY_VERSION,isBenchmarkAssist(input));
      const method=await assertAgentMethodSelection(tx,binding.registry.describeSkill(binding.skill),input.methodSelection);
      await assertMethodKnowledge(tx,authorizedContext,method.definition);
      const currentBasis = await captureAssistInputAuthority(tx, authorizedContext, input.request,
        await knowledgeExecutionAuthority(tx, authorizedContext, input.knowledge, input.request.kind === "knowledge_answer" ? input.request.evidenceStoreId : null));
      assertAssistInputAuthority(input.inputAuthority!, currentBasis);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    const harness = assistHarness(row.kind, !!input.artworkAudit, requiredAssistPermissions(row.kind, "run"), ASSIST_ACCESS_POLICY_VERSION, isBenchmarkAssist(input));
    try { harness.registry.checkInput(input.executionContract, harness.skill, harness.toolKey, input.request); }
    catch (error) { if (error instanceof HarnessContractError) throw new Error("assist_" + error.code); throw error; }
    return provider;
  }
}

export async function readResearchImage(raw: string, request = globalThis.fetch): Promise<string> {
  const bytes = await sharp(Buffer.from(await readAssistResearchImageBytes(raw,request)), { limitInputPixels: 32_000_000 })
    .rotate()
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}
