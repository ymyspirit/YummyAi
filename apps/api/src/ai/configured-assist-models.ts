import { AssistModelSchema } from "@yummyai/contracts/ai/assist";
import { ModelPurposeSchema } from "@yummyai/contracts/ai/model-purpose";
import { modelPreferences, modelProviderConfigs, modelRoutes, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, sql } from "drizzle-orm";

/** Business assistants reuse the same enabled text routes and server-side credentials. */
export async function configuredAssistModels(tx: TenantTransaction, userId: string) {
  const rows = await tx.select({ route: modelRoutes, provider: modelProviderConfigs })
    .from(modelRoutes).innerJoin(modelProviderConfigs, eq(modelProviderConfigs.id, sql`(${modelRoutes.targets}->0->>'providerConfigId')::uuid`))
    .where(and(inArray(modelRoutes.taskType, ["studio_text", "studio_analysis"]), eq(modelProviderConfigs.status, "enabled")))
    .orderBy(modelRoutes.createdAt, modelRoutes.id);
  const [preferences] = await tx.select().from(modelPreferences).where(eq(modelPreferences.userId, userId));
  const owned = rows.filter(({ route, provider }) => route.targets.length === 1 && ["openai", "openai-compatible"].includes(provider.provider));
  const usable = owned.filter(({ route }) => route.status === "enabled");
  // Pausing selectability does not cancel an existing quote inherited by a shared
  // text model. Historical removals have no marker and remain excluded.
  const quoteSources = owned.filter(({ route }) => route.taskType === "studio_analysis"
    && (route.status === "enabled" || (route.status === "disabled" && route.targets[0]!.configurationDisabled === true)))
    .sort((left, right) => Number(right.route.status === "enabled") - Number(left.route.status === "enabled"));
  return usable.map(({ route, provider }) => {
    const target = route.targets[0]!;
    // A shared route cannot sidestep a separately configured price or task cap.
    const priced = quoteSources.find(row => row.provider.id === provider.id && row.route.targets[0]!.providerModel === target.providerModel && row.route.targets[0]!.analysisPricing)?.route.targets[0]!.analysisPricing;
    const defaultFor = ModelPurposeSchema.options.filter(purpose => preferences?.defaults.purposeDefaults?.[purpose] === route.id);
    return AssistModelSchema.parse({ id: route.id, label: route.modelKey, model: target.providerModel, providerLabel: provider.label,
      ...(target.analysisPricing ?? priced ?? { inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null }),
      ...(defaultFor.length ? { defaultFor } : {}),
    });
  }).sort((a, b) => {
    const priority = (id: string) => id === preferences?.defaults.analysis ? 2 : id === preferences?.defaults.text ? 1 : 0;
    return priority(b.id) - priority(a.id);
  });
}
