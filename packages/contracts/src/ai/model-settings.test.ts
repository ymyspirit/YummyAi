import { describe, expect, it } from "vitest";
import { AssistModelInputSchema, AssistModelSchema, assistModelExecutionSnapshot } from "./assist.js";
import { ConfigurationRpcSchema, emptyModelDefaults } from "./model-configuration.js";
import { AnalysisModelPricingSchema } from "./model-pricing-policy.js";
import { ModelPurposeDefaultsSchema, preferredModelId } from "./model-purpose.js";

const first = "01900000-0000-7000-8000-000000000001";
const second = "01900000-0000-7000-8000-000000000002";
const provider = "01900000-0000-7000-8000-000000000003";

describe("optional AI pricing and personal business defaults", () => {
  it("defaults a newly registered analysis route to unknown prices and no task cap", () => {
    expect(AssistModelInputSchema.parse({ providerConfigId: provider, model: "synthetic-model", label: "Synthetic" }))
      .toMatchObject({ inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null });
  });
  it("preserves an explicit free quote independently from an unknown quote", () => {
    expect(AnalysisModelPricingSchema.parse({ inputUsdPerMillion: 0, outputUsdPerMillion: 0 }).inputUsdPerMillion).toBe(0);
    expect(AnalysisModelPricingSchema.parse({}).inputUsdPerMillion).toBeNull();
  });
  it("allows an optional cap above the removed twenty-dollar form limit", () => {
    expect(AnalysisModelPricingSchema.parse({ inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 125 }).maxTaskCostUsd).toBe(125);
  });
  it.each([{}, { inputUsdPerMillion: 1 }, { outputUsdPerMillion: 2 }])("requires a complete quote for a hard cap: %j", quote => {
    expect(AnalysisModelPricingSchema.safeParse({ ...quote, maxTaskCostUsd: 3 }).success).toBe(false);
    expect(AssistModelInputSchema.safeParse({ providerConfigId: provider, model: "synthetic", label: "Synthetic", ...quote, maxTaskCostUsd: 3 }).success).toBe(false);
  });
  it.each([0, -1, Number.POSITIVE_INFINITY, Number.NaN])("rejects an invalid hard cap %s", maxTaskCostUsd => {
    expect(AnalysisModelPricingSchema.safeParse({ inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd }).success).toBe(false);
  });
  it("retains the legacy four-default transport without manufacturing purpose choices", () => {
    const request = ConfigurationRpcSchema.parse({ operation: "defaults.save", revision: 2, defaults: emptyModelDefaults() });
    expect(request).toEqual({ operation: "defaults.save", revision: 2, defaults: { image: null, video: null, text: null, analysis: null } });
  });
  it("accepts a separately versioned personal purpose change", () => {
    expect(ConfigurationRpcSchema.parse({ operation: "purpose-defaults.save", revision: 2, defaults: { order_review: first, artwork_preflight: second, agent_chat: null } }))
      .toMatchObject({ defaults: { order_review: first, artwork_preflight: second, agent_chat: null } });
  });
  it("rejects arbitrary purpose keys and non-model identifiers", () => {
    expect(ModelPurposeDefaultsSchema.safeParse({ permissions: first }).success).toBe(false);
    expect(ModelPurposeDefaultsSchema.safeParse({ order_review: "untrusted-model-id" }).success).toBe(false);
  });
  it("uses the purpose preference while keeping a current valid operator selection", () => {
    const models = [{ id: first }, { id: second, defaultFor: ["order_review" as const] }];
    expect(preferredModelId(models, "order_review")).toBe(second);
    expect(preferredModelId(models, "order_review", first)).toBe(first);
    expect(preferredModelId(models, "order_review", "removed")).toBe(second);
    expect(preferredModelId(models, "agent_chat")).toBe(first);
    expect(preferredModelId([], "agent_chat")).toBe("");
  });
  it("does not make a preference change into an execution-pricing change", () => {
    const model = AssistModelSchema.parse({ id: first, model: "synthetic", label: "Synthetic", providerLabel: "Synthetic provider", inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null });
    expect(assistModelExecutionSnapshot({ ...model, defaultFor: ["order_review"] }))
      .toEqual(assistModelExecutionSnapshot({ ...model, defaultFor: ["agent_chat"] }));
    expect(assistModelExecutionSnapshot(model)).not.toHaveProperty("defaultFor");
    expect(assistModelExecutionSnapshot({ ...model, inputUsdPerMillion: 1 })).not.toEqual(assistModelExecutionSnapshot(model));
  });
  it("keeps configuration pauses separate from destructive removal requests", () => {
    expect(ConfigurationRpcSchema.safeParse({ operation: "model.status", channelId: provider, modelId: first, revision: "r1", status: "disabled" }).success).toBe(true);
    expect(ConfigurationRpcSchema.safeParse({ operation: "model.status", channelId: provider, modelId: first, revision: "r1", status: "deleted" }).success).toBe(false);
  });
});
