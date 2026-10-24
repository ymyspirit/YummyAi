import { AssistModelSchema } from "@yummyai/contracts/ai/assist";
import { modelPreferences, modelProviderConfigs, modelRoutes, type TenantTransaction } from "@yummyai/database";
import { and, eq, inArray, sql } from "drizzle-orm";

/** Business assistants reuse the same enabled text routes and server-side credentials. */
export async function configuredAssistModels(tx: TenantTransaction, userId: string) {
  const rows = await tx.select({ route: modelRoutes, provider: modelProviderConfigs })
    .from(modelRoutes).innerJoin(modelProviderConfigs, eq(modelProviderConfigs.id, sql`(${modelRoutes.targets}->0->>'providerConfigId')::uuid`))
    .where(and(inArray(modelRoutes.taskType, ["studio_text", "studio_analysis"]), eq(modelRoutes.status, "enabled"), eq(modelProviderConfigs.status, "enabled")));
  const [preferences] = await tx.select().from(modelPreferences).where(eq(modelPreferences.userId, userId));
  const usable = rows.filter(({ route, provider }) => route.targets.length === 1 && ["openai", "openai-compatible"].includes(provider.provider));
  return usable.map(({ route, provider }) => {
    const target = route.targets[0]!;
    // A shared route cannot sidestep a separately configured price or task cap.
    const priced = usable.find(row => row.route.taskType === "studio_analysis" && row.provider.id === provider.id && row.route.targets[0]!.providerModel === target.providerModel && row.route.targets[0]!.analysisPricing)?.route.targets[0]!.analysisPricing;
    return AssistModelSchema.parse({ id: route.id, label: route.modelKey, model: target.providerModel, providerLabel: provider.label,
      ...(target.analysisPricing ?? priced ?? { inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null }),
    });
  }).sort((a, b) => {
    const priority = (id: string) => id === preferences?.defaults.analysis ? 2 : id === preferences?.defaults.text ? 1 : 0;
    return priority(b.id) - priority(a.id);
  });
}
