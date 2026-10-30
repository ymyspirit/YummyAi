import { describe, expect, it } from "vitest";
import { ConfigurationRpcSchema, emptyModelDefaults, type ConfigurationSnapshot, type ConfiguredChannel } from "@yummyai/contracts/ai/model-configuration";
import { OfficialApiPriceCatalogSchema } from "@yummyai/contracts/ai/official-model-pricing";
import { capabilityLabels, channelDraft, channelDraftProblem, channelSaveInput, defaultModelLabel, filterManagedModels, filteredCatalogue, isDefaultModel, managedModels, modelSettingsTab, modelSettingsTabHref, officialTextRate, pricingSummary, suggestedChannelName, suggestedModelLabel } from "./model-settings-presentation";

const id = (suffix: number) => `019f3000-0000-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
function channel(): ConfiguredChannel {
  return { id: id(1), name: "Synthetic provider", baseUrl: "https://synthetic.example.test/v1", provider: "openai-compatible", hasCredential: true,
    revision: "a".repeat(64), status: "enabled", dependentRoutes: [], analysisModels: [{ id: id(4), name: "same-text-name", label: "Historical priced analysis" }],
    models: [{ id: id(2), name: "gpt-image-looking-name", label: "Configured text model", capability: "text" },
      { id: id(3), name: "paused-image", label: "Paused image", capability: "image", status: "disabled" }] };
}
function snapshot(): ConfigurationSnapshot {
  return { channels: [channel()], analysisModels: [{ id: id(2), label: "Configured text model", model: "gpt-image-looking-name", providerLabel: "Synthetic provider", providerConfigId: id(1) }], defaults: emptyModelDefaults(), defaultsRevision: 0 };
}

describe("model settings presentation preserves actual configuration and avoids capability guesses", () => {
  it("edits with a blank secret, stable route IDs and the existing compatible protocol", () => {
    const original = channel(), unchanged = structuredClone(original), draft = channelDraft(original);
    expect(draft.apiKey).toBe("");
    expect(draft.textProtocol).toBe("chat_completions");
    expect(draft.models.map(model => model.id)).toEqual([id(2), id(3)]);
    expect(draft.models.find(model => model.id === id(3))).not.toHaveProperty("status");
    draft.models[0]!.label = "Only the local draft changes";
    expect(original).toEqual(unchanged);
  });

  it("preserves an explicitly saved protocol instead of guessing it again from the endpoint", () => {
    expect(channelDraft({ ...channel(), provider: "openai", textProtocol: "responses", baseUrl: "http://127.0.0.1:8080/v1" }).textProtocol).toBe("responses");
    expect(channelDraft({ ...channel(), textProtocol: "chat_completions", baseUrl: "https://api.openai.com/v1" }).textProtocol).toBe("chat_completions");
  });

  it("suggests readable labels without requesting or storing credentials", () => {
    expect(suggestedChannelName("https://www.synthetic.example.test/v1")).toBe("synthetic.example.test");
    expect(suggestedChannelName("not an endpoint")).toBe("");
    expect(suggestedModelLabel("", "synthetic-model")).toBe("模型渠道 / synthetic-model");
    expect(suggestedModelLabel("A".repeat(120), "B".repeat(240)).length).toBeLessThanOrEqual(100);
  });

  it("makes catalogue search a deduplicated natural ordering without changing the original directory", () => {
    const original = ["model-20", "model-2", "OTHER-1", "model-10", "model-2"], before = [...original];
    expect(filteredCatalogue(original, " MODEL- ")).toEqual(["model-2", "model-10", "model-20"]);
    expect(filteredCatalogue(original, "absent")).toEqual([]);
    expect(original).toEqual(before);
  });

  it("uses configured capabilities even when the provider's model name resembles another modality", () => {
    const models = managedModels(snapshot()), text = models.find(model => model.id === id(2))!;
    expect(text).toMatchObject({ capability: "text", shared: true, status: "enabled" });
    expect(text).not.toHaveProperty("verified");
    expect(text).not.toHaveProperty("vision");
    expect(capabilityLabels[text.capability]).toBe("文本任务");
    expect(filterManagedModels(models, "gpt-image", "image", "")).toEqual([]);
  });

  it("retains the legacy analysis route and paused model by their own identity", () => {
    const original = snapshot(), before = structuredClone(original), models = managedModels(original);
    expect(models.map(model => model.id)).toEqual(expect.arrayContaining([id(2), id(3), id(4)]));
    expect(models).toHaveLength(3);
    expect(models.find(model => model.id === id(4))).toMatchObject({ capability: "analysis", shared: false });
    expect(models.find(model => model.id === id(3))).toMatchObject({ status: "disabled" });
    expect(original).toEqual(before);
  });

  it("combines model, capability and channel filters without mutating the source list", () => {
    const first = snapshot(), other = { ...channel(), id: id(8), name: "Different provider", models: [{ id: id(9), name: "other-text", label: "A second model", capability: "text" as const }], analysisModels: [] };
    const models = managedModels({ ...first, channels: [...first.channels, other] }), before = [...models];
    expect(filterManagedModels(models, "synthetic PROVIDER", "text", id(1)).map(model => model.id)).toEqual([id(2)]);
    expect(filterManagedModels(models, "", "text", id(8)).map(model => model.id)).toEqual([id(9)]);
    expect(filterManagedModels(models, "not present", "", "")).toEqual([]);
    expect(models).toEqual(before);
  });

  it("marks both traditional and purpose-specific defaults as defaults", () => {
    expect(isDefaultModel({ ...emptyModelDefaults(), image: id(3) }, id(3))).toBe(true);
    expect(isDefaultModel({ ...emptyModelDefaults(), purposeDefaults: { order_review: id(2), agent_chat: id(4) } }, id(2))).toBe(true);
    expect(isDefaultModel({ ...emptyModelDefaults(), purposeDefaults: { order_review: null } }, id(2))).toBe(false);
  });

  it("makes an unavailable or disabled saved default explicit instead of presenting it as ready", () => {
    expect(defaultModelLabel(snapshot(), id(2))).toBe("Configured text model");
    expect(defaultModelLabel(snapshot(), id(88))).toContain("不可选");
    expect(defaultModelLabel(snapshot(), id(3))).toMatch(/已停用|不可选/);
    const disabledProvider = snapshot(); disabledProvider.channels[0]!.status = "disabled";
    expect(defaultModelLabel(disabledProvider, id(2))).toMatch(/已停用|不可选/);
    expect(defaultModelLabel(snapshot(), null)).toContain("沿用");
  });

  it("builds the strict shared-channel command without an empty key or read-only paused metadata", () => {
    const original = channel(), draft = channelDraft(original), input = channelSaveInput(draft);
    expect(ConfigurationRpcSchema.safeParse(input).success).toBe(true);
    expect(input).not.toHaveProperty("apiKey");
    expect(input.models).toEqual(original.models.map(({ id, name, label, capability }) => ({ id, name, label, capability })));
    expect(input.models.every(model => !("status" in model) && !("analysisPricing" in model) && !("imagePricing" in model))).toBe(true);
    expect(input).not.toHaveProperty("maxTaskCostUsd");
    expect(input).not.toHaveProperty("inputUsdPerMillion");
    draft.apiKey = "  synthetic-ephemeral-draft  ";
    expect(channelSaveInput(draft).apiKey).toBe("synthetic-ephemeral-draft");
  });

  it("gives a concrete reason for an incomplete new connection while allowing a saved-key edit", () => {
    const empty = channelDraft();
    expect(channelDraftProblem(empty)).toContain("渠道名称");
    const draft = { ...empty, name: "Synthetic", baseUrl: "https://synthetic.example.test/v1" };
    expect(channelDraftProblem(draft)).toContain("API Key");
    expect(channelDraftProblem(channelDraft(channel()))).toBeNull();
    expect(channelDraftProblem({ ...draft, apiKey: "synthetic-ephemeral", baseUrl: "javascript:invalid" })).toContain("HTTP");
  });

  it("rejects duplicates and oversized selections before a channel mutation", () => {
    const saved = channelDraft(channel()), first = saved.models[0]!;
    expect(channelDraftProblem({ ...saved, models: [first, { ...first, label: "Duplicate by model ID" }] })).toContain("重复");
    expect(channelDraftProblem({ ...saved, models: [first, { ...saved.models[1]!, label: " " }] })).toContain("显示名称");
    expect(channelDraftProblem({ ...saved, models: Array.from({ length: 201 }, (_, index) => ({ name: `synthetic-${index}`, label: `Synthetic ${index}`, capability: "text" as const })) })).toContain("200");
  });
});

describe("settings continuation and pricing", () => {
  it("uses an explicit supported section before a legacy fragment", () => {
    expect(modelSettingsTab("?settingsTab=defaults", "#analysis-model-settings")).toBe("defaults");
    expect(modelSettingsTab("", "#analysis-model-settings")).toBe("models");
    expect(modelSettingsTab("?settingsTab=usage", "#models")).toBe("usage");
  });

  it("does not turn an unknown query value or fragment into an arbitrary settings section", () => {
    expect(modelSettingsTab("?settingsTab=__proto__", "#usage")).toBe("usage");
    expect(modelSettingsTab("?settingsTab=%3Cscript%3E", "#unknown")).toBe("channels");
    expect(modelSettingsTab("", "#channels")).toBe("channels");
  });

  it("retains the original return target, billing identity and other query values when switching sections", () => {
    const current = "/settings/ai?returnTo=%2Forders%3Fline%3Dsynthetic&owner=assist&id=" + id(99) + "&settingsTab=models&settingsTab=channels#analysis-model-settings";
    const result = new URL(modelSettingsTabHref(current, "usage"), "http://localhost");
    expect(result.pathname).toBe("/settings/ai");
    expect(result.searchParams.get("returnTo")).toBe("/orders?line=synthetic");
    expect(result.searchParams.get("owner")).toBe("assist");
    expect(result.searchParams.get("id")).toBe(id(99));
    expect(result.searchParams.getAll("settingsTab")).toEqual(["usage"]);
    expect(result.hash).toBe("");
  });

  it("distinguishes an unknown quote from a confirmed zero-price quote under unlimited usage", () => {
    expect(pricingSummary(undefined)).toContain("报价待核对");
    expect(pricingSummary({ inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null })).toContain("报价待核对");
    expect(pricingSummary({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxTaskCostUsd: null })).toBe("不限额 · 已配置估算报价");
    expect(pricingSummary({ inputUsdPerMillion: null, outputUsdPerMillion: 0, maxTaskCostUsd: null })).toContain("报价待核对");
  });

  it("keeps an existing explicit cap visible even above the removed twenty-dollar form limit", () => {
    expect(pricingSummary({ inputUsdPerMillion: 2, outputUsdPerMillion: 7, maxTaskCostUsd: 25.5 })).toBe("单次费用上限 $25.5");
    expect(pricingSummary({ inputUsdPerMillion: 2, outputUsdPerMillion: 7, maxTaskCostUsd: 4 })).toBe("单次费用上限 $4");
  });

  it("uses only an exact official text-model price match and never prices an unsupported alias as free", () => {
    const catalog = OfficialApiPriceCatalogSchema.parse({ version: "synthetic-price-version", checkedAt: "2026-10-30T00:00:00.000Z", currency: "USD", unitTokens: 1_000_000,
      basis: "official_standard_list_price", notes: [], rates: [{ modelId: "synthetic-priced-model", category: "text", sourceUrl: "https://pricing.example.test/models/synthetic-priced-model",
        inputUsdPerMillion: "2.00000000", cachedInputUsdPerMillion: "0.10000000", outputUsdPerMillion: "7.00000000", imageInputUsdPerMillion: null,
        cachedImageInputUsdPerMillion: null, cacheWrite30mUsdPerMillion: null, cacheWrite12hUsdPerMillion: null, longContextAfterInputTokens: null, notes: [] }] });
    expect(officialTextRate(catalog, "synthetic-priced-model")).toEqual(catalog.rates[0]);
    expect(officialTextRate(catalog, "proxy/synthetic-priced-model")).toBeUndefined();
    expect(officialTextRate(undefined, "synthetic-priced-model")).toBeUndefined();
    expect(officialTextRate({ ...catalog, rates: [{ ...catalog.rates[0]!, category: "image" }] }, "synthetic-priced-model")).toBeUndefined();
  });
});
