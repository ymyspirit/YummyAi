import {
  ASSIST_INSTRUCTIONS,
  ASSIST_MAX_OUTPUT_TOKENS,
  OpenAiCompatibleProvider,
  OpenAiProvider,
  ProviderError,
  validateAssistResult,
  type AssistContext,
  type ModelProvider,
  type SecretVault,
} from "@yummyai/ai-core";
import { AssistResultSchema } from "@yummyai/contracts/ai/assist";
import type { TenantContext } from "@yummyai/contracts";
import {
  aiAssistRuns as runs,
  aiBudgetLedger,
  aiBudgetPolicies,
  memberships,
  membershipRoles,
  roles,
  modelProviderConfigs,
  modelRoutes,
  withTenant,
  type DatabaseConnection,
} from "@yummyai/database";
import type { JobEnvelope } from "@yummyai/jobs";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { z } from "zod";

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
      const [provider, grants, route, policy] = await withTenant(this.database.db, context, async (tx) => {
        const [provider] = await tx
          .select()
          .from(modelProviderConfigs)
          .where(
            and(
              eq(modelProviderConfigs.id, row.modelSnapshot.providerConfigId),
              eq(modelProviderConfigs.status, "enabled"),
            ),
          );
        const grants = await tx
          .select({ permissions: roles.permissions })
          .from(memberships)
          .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
          .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
          .where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active")));
        const [route] = await tx.select().from(modelRoutes).where(eq(modelRoutes.id, row.modelSnapshot.id));
        const [policy] = await tx.select().from(aiBudgetPolicies);
        return [provider, grants, route, policy] as const;
      });
      const permissions = new Set(grants.flatMap((g) => [...g.permissions]));
      const required =
        row.kind === "business_review" ? ["finance:read", "order:read"]
          : row.kind === "procurement_review" ? ["procurement:read", "inventory:read"]
          : row.kind === "after_sales_review" ? ["order:read", "order:pii:read"]
          : row.kind === "template_config" ? ["design:read", "design:write"]
          : row.kind === "sku_package" ? ["listing:read", "listing:write", "product:read", "design:read"]
          : row.kind === "creative"
          ? ["design:read", "design:write", "research:read"]
          : [
              "order:read",
              "order:pii:read",
              row.kind === "order_review" ? "order:write" : "design:write",
            ];
      if (required.some((p) => !permissions.has(p))) throw new Error("assist_access_changed");
      if (!provider || !["openai", "openai-compatible"].includes(provider.provider))
        throw new Error("assist_provider_unavailable");
      if (!route || route.status !== "enabled" || !["studio_text", "studio_analysis"].includes(route.taskType) || route.targets.length !== 1 || route.targets[0]!.providerConfigId !== provider.id || route.targets[0]!.providerModel !== row.modelSnapshot.model)
        throw new Error("assist_provider_unavailable");
      if (policy && row.modelSnapshot.maxTaskCostUsd === null) throw new Error("assist_pricing_required");
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
      const result = await this.modelVault.withSecret(provider.encryptedApiKey, async (apiKey) => {
        const model = this.providerFactory(provider, apiKey, row);
        if (row.expiresAt <= new Date()) throw new Error("assist_expired");
        submitted = true;
        return model.generate(
          {
            modelKey: row.modelSnapshot.model,
            providerModel: row.modelSnapshot.model,
            taskType: row.kind,
            systemInstructions: ASSIST_INSTRUCTIONS,
            untrustedSourceData: {
              ...input.data,
              sources: availableSources,
              checks: input.checks,
              diagnostics: [...input.diagnostics, ...diagnostics],
              availableImageIds: imageIds,
            },
            images,
            outputSchema: AssistResultSchema,
            outputSchemaName: "erp_assist",
            maxCostUsd: row.modelSnapshot.maxTaskCostUsd,
            maxOutputTokens: ASSIST_MAX_OUTPUT_TOKENS,
          },
          AbortSignal.timeout(120000),
        );
      });
      const validated = validateAssistResult(result.value, input, imageIds);
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
        cause instanceof ProviderError ? ({ 400: "assist_protocol_unsupported", 401: "assist_auth_failed", 403: "assist_auth_failed", 404: "assist_model_unavailable", 429: "assist_rate_limited" } as Record<number, string>)[cause.statusCode ?? 0] ?? "assist_provider_failed"
        : cause instanceof z.ZodError ? "assist_invalid_result"
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
}

export async function readResearchImage(raw: string, request = globalThis.fetch): Promise<string> {
  const url = new URL(raw);
  const hosts = new Set([
    "i.etsystatic.com",
    "m.media-amazon.com",
    "images-na.ssl-images-amazon.com",
    "images-eu.ssl-images-amazon.com",
  ]);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !hosts.has(url.hostname)
  )
    throw new Error("image_source_rejected");
  const response = await request(url, {
    redirect: "error",
    signal: AbortSignal.timeout(12000),
    headers: { accept: "image/jpeg,image/png,image/webp" },
  });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("image/") || !response.body)
    throw new Error("image_unavailable");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > 4 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("image_too_large");
    }
    chunks.push(chunk.value);
  }
  const bytes = await sharp(Buffer.concat(chunks), { limitInputPixels: 32_000_000 })
    .rotate()
    .resize(1024, 1024, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 85 })
    .toBuffer();
  return `data:image/jpeg;base64,${bytes.toString("base64")}`;
}
