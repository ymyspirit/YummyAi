import { describe, expect, it } from "vitest";
import { ModelTokenUsageSchema, ModelUsageScopeSchema, ModelUsageSummarySchema } from "./model-usage.js";

const usage = () => ({ version: "model-token-usage-v1" as const, inputTokens: 120, outputTokens: 80,
  cachedInputTokens: 30, totalTokens: 200, totalTokensBasis: "provider" as const });
const summary = () => ({ scope: "assist_scope" as const, state: "complete" as const,
  callCount: 2, reportedCalls: 2, unknownCalls: 0, inputTokens: 240, outputTokens: 160, cachedInputTokens: 60, totalTokens: 400 });

describe("reported model token usage contract", () => {
  it("preserves genuine zero and absent optional breakdowns without backfilling historical bytes", () => {
    const original = { ...usage(), inputTokens: 0, outputTokens: 0, cachedInputTokens: null, totalTokens: 0 };
    expect(ModelTokenUsageSchema.parse(original)).toEqual(original);
    expect(ModelTokenUsageSchema.parse(original)).not.toHaveProperty("inputImageTokens");
    expect(ModelTokenUsageSchema.parse({ ...usage(), inputTokens: null, outputTokens: null,
      cachedInputTokens: null, totalTokens: null, totalTokensBasis: "unknown" })).toMatchObject({ inputTokens: null, totalTokens: null });
  });

  it("accepts provider totals with missing components and explicit reported-component totals", () => {
    expect(ModelTokenUsageSchema.safeParse({ ...usage(), inputTokens: null, outputTokens: null, cachedInputTokens: null }).success).toBe(true);
    expect(ModelTokenUsageSchema.safeParse({ ...usage(), totalTokensBasis: "reported_components" }).success).toBe(true);
  });

  it("requires both actual components when a total claims to be derived from them", () => {
    for (const components of [{ inputTokens: null }, { outputTokens: null }])
      expect(ModelTokenUsageSchema.safeParse({ ...usage(), cachedInputTokens: null,
        totalTokensBasis: "reported_components", ...components }).success).toBe(false);
  });

  it("rejects contradictory totals, impossible cached subsets and false evidence bases", () => {
    for (const change of [{ totalTokens: 201 }, { cachedInputTokens: 121 },
      { totalTokens: null }, { totalTokensBasis: "unknown" }, { totalTokensBasis: "estimated" }])
      expect(ModelTokenUsageSchema.safeParse({ ...usage(), ...change }).success).toBe(false);
  });

  it("retains bounded provider breakdowns while keeping cached and reasoning units as subsets", () => {
    const detailed = { ...usage(), inputTextTokens: 100, inputImageTokens: 20,
      outputTextTokens: 60, outputImageTokens: 20, reasoningTokens: 15 };
    expect(ModelTokenUsageSchema.parse(detailed)).toEqual(detailed);
    expect(ModelTokenUsageSchema.parse(detailed).totalTokens).toBe(200);
  });

  it("rejects unsafe, negative, fractional and string counts in every unit field", () => {
    for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "totalTokens", "inputTextTokens",
      "inputImageTokens", "outputTextTokens", "outputImageTokens", "reasoningTokens"])
      for (const invalid of [-1, 0.5, "1", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        expect(ModelTokenUsageSchema.safeParse({ ...usage(), [key]: invalid }).success, `${key} rejects ${String(invalid)}`).toBe(false);
    expect(ModelTokenUsageSchema.safeParse({ ...usage(), inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 0, cachedInputTokens: null, totalTokens: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  });

  it("does not accept price estimates, identities or raw provider payloads as token evidence", () => {
    for (const extra of [{ costUsd: 0 }, { estimatedTokens: 200 }, { tenantId: "synthetic" }, { rawUsage: {} }])
      expect(ModelTokenUsageSchema.safeParse({ ...usage(), ...extra }).success).toBe(false);
  });
});

describe("original-ledger model usage summary contract", () => {
  it.each(["assist_scope", "order_design_run", "order_design_work_item"])("accepts the original %s owner scope", scope => {
    expect(ModelUsageScopeSchema.parse(scope)).toBe(scope);
    expect(ModelUsageSummarySchema.safeParse({ ...summary(), scope }).success).toBe(true);
  });

  it("distinguishes complete, partial, empty and wholly unreported original ledgers", () => {
    const values = [summary(),
      { ...summary(), state: "partial", callCount: 3, reportedCalls: 2, unknownCalls: 1 },
      { ...summary(), state: "empty", callCount: 0, reportedCalls: 0, unknownCalls: 0,
        inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 },
      { ...summary(), state: "unreported", reportedCalls: 0, unknownCalls: 2,
        inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null }];
    for (const value of values) expect(ModelUsageSummarySchema.parse(value)).toEqual(value);
    expect(ModelUsageSummarySchema.safeParse({ ...summary(), state: "partial", reportedCalls: 0, unknownCalls: 2,
      inputTokens: 0, outputTokens: null, cachedInputTokens: null, totalTokens: null }).success).toBe(true);
  });

  it("rejects missing original calls and an empty label on a nonempty ledger", () => {
    for (const change of [{ reportedCalls: 1 }, { unknownCalls: 1 }, { state: "empty" },
      { callCount: 0, reportedCalls: 0, state: "complete" }])
      expect(ModelUsageSummarySchema.safeParse({ ...summary(), ...change }).success).toBe(false);
  });

  it("does not label unknown calls complete or known units wholly unreported", () => {
    const invalid = [
      { ...summary(), state: "complete", reportedCalls: 0, unknownCalls: 2,
        inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null },
      { ...summary(), state: "complete", inputTokens: null, totalTokens: null },
      { ...summary(), state: "partial" },
      { ...summary(), state: "unreported", reportedCalls: 0, unknownCalls: 2,
        inputTokens: 0, outputTokens: null, cachedInputTokens: null, totalTokens: null },
      { ...summary(), state: "empty", callCount: 0, reportedCalls: 0, unknownCalls: 0,
        inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null },
    ];
    for (const value of invalid) expect(ModelUsageSummarySchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });

  it("keeps partial subtotals independent instead of inventing missing components", () => {
    const partial = { ...summary(), state: "partial", callCount: 3, reportedCalls: 1, unknownCalls: 2,
      inputTokens: 150, outputTokens: 80, cachedInputTokens: null, totalTokens: 200 };
    expect(ModelUsageSummarySchema.parse(partial)).toEqual(partial);
  });

  it("requires complete totals to agree with their reported components and cached subset", () => {
    for (const change of [{ totalTokens: 401 }, { cachedInputTokens: 241 }])
      expect(ModelUsageSummarySchema.safeParse({ ...summary(), ...change }).success).toBe(false);
  });

  it("bounds cumulative units and call counts to safe integers and rejects foreign metadata", () => {
    for (const key of ["callCount", "reportedCalls", "unknownCalls", "inputTokens", "outputTokens", "cachedInputTokens", "totalTokens"])
      for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
        expect(ModelUsageSummarySchema.safeParse({ ...summary(), [key]: invalid }).success).toBe(false);
    for (const change of [{ scope: "recent_history" }, { state: "estimated" }, { pageSize: 20 }, { tenantId: "synthetic" }])
      expect(ModelUsageSummarySchema.safeParse({ ...summary(), ...change }).success).toBe(false);
  });
});
