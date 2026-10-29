import { describe, expect, it } from "vitest";
import type { ModelTokenUsage } from "@yummyai/contracts/ai/model-usage";
import { normalizeModelTokenUsage, summarizeModelUsage } from "./model-usage.js";

function reported(raw: unknown): ModelTokenUsage {
  const value = normalizeModelTokenUsage(raw);
  expect(value).not.toBeNull();
  if (!value) throw new Error("Synthetic provider usage must be present");
  return value;
}

describe("provider-reported token units", () => {
  it("keeps an actual zero distinct from an absent report", () => {
    expect(reported({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })).toMatchObject({
      inputTokens: 0, outputTokens: 0, totalTokens: 0, totalTokensBasis: "provider", cachedInputTokens: null,
    });
    for (const absent of [undefined, null, {}, [], "", 0, { cost_usd: 0 }])
      expect(normalizeModelTokenUsage(absent)).toBeNull();
  });

  it("reads Chat Completions details while keeping cached and reasoning units inside their parents", () => {
    expect(reported({ prompt_tokens: 120, completion_tokens: 80, total_tokens: 200,
      prompt_tokens_details: { cached_tokens: 30, text_tokens: 100, image_tokens: 20 },
      completion_tokens_details: { text_tokens: 60, image_tokens: 20, reasoning_tokens: 15 },
    })).toEqual({ version: "model-token-usage-v1", inputTokens: 120, outputTokens: 80, cachedInputTokens: 30,
      totalTokens: 200, totalTokensBasis: "provider", inputTextTokens: 100, inputImageTokens: 20,
      outputTextTokens: 60, outputImageTokens: 20, reasoningTokens: 15 });
  });

  it("reads Responses input/output units without a provider price or an application output ceiling", () => {
    const response = { id: "synthetic-response-without-pricing", usage: { input_tokens: 120, output_tokens: 7200,
      total_tokens: 7320, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 200 } } };
    expect(reported(response.usage)).toMatchObject({ inputTokens: 120, outputTokens: 7200, totalTokens: 7320,
      totalTokensBasis: "provider", cachedInputTokens: 20, reasoningTokens: 200 });
  });

  it("preserves Images text/image breakdown and derives a total only from reported input and output", () => {
    expect(reported({ input_tokens: 250, output_tokens: 800,
      input_tokens_details: { text_tokens: 50, image_tokens: 200 },
      output_tokens_details: { image_tokens: 800 },
    })).toEqual({ version: "model-token-usage-v1", inputTokens: 250, outputTokens: 800, cachedInputTokens: null,
      totalTokens: 1050, totalTokensBasis: "reported_components", inputTextTokens: 50, inputImageTokens: 200,
      outputTextTokens: null, outputImageTokens: 800, reasoningTokens: null });
  });

  it("retains partial units without fabricating a missing parent or output", () => {
    expect(reported({ input_tokens: 12 })).toMatchObject({ inputTokens: 12, outputTokens: null,
      totalTokens: null, totalTokensBasis: "unknown" });
    expect(reported({ total_tokens: 55 })).toMatchObject({ inputTokens: null, outputTokens: null,
      totalTokens: 55, totalTokensBasis: "provider" });
    expect(reported({ input_tokens_details: { image_tokens: 31 } })).toMatchObject({ inputTokens: null,
      inputImageTokens: 31, outputTokens: null, totalTokens: null, totalTokensBasis: "unknown" });
  });

  it("leaves a conflicting provider total unknown instead of correcting or counting it", () => {
    for (const total_tokens of [29, 31, "30", -1]) {
      expect(reported({ input_tokens: 10, output_tokens: 20, total_tokens })).toMatchObject({
        inputTokens: 10, outputTokens: 20, totalTokens: null, totalTokensBasis: "unknown",
      });
    }
    expect(reported({ input_tokens: 10, output_tokens: 20 })).toMatchObject({
      totalTokens: 30, totalTokensBasis: "reported_components",
    });
  });

  it("does not clamp an impossible cached subset or add it to total usage", () => {
    expect(reported({ input_tokens: 10, output_tokens: 20, total_tokens: 30,
      input_tokens_details: { cached_tokens: 11 } })).toMatchObject({ cachedInputTokens: null, totalTokens: 30 });
    expect(reported({ input_tokens: 10, output_tokens: 20, total_tokens: 30,
      input_tokens_details: { cached_tokens: 10 } })).toMatchObject({ cachedInputTokens: 10, totalTokens: 30 });
  });

  it("rejects invalid units without coercing them to numeric zero", () => {
    for (const invalid of [-1, 1.5, "12", NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
      expect(normalizeModelTokenUsage({ input_tokens: invalid, output_tokens: invalid, total_tokens: invalid })).toBeNull();
  });

  it("keeps safe large units and marks an overflowing component total unknown", () => {
    expect(reported({ input_tokens: Number.MAX_SAFE_INTEGER - 10, output_tokens: 10 })).toMatchObject({
      totalTokens: Number.MAX_SAFE_INTEGER, totalTokensBasis: "reported_components",
    });
    expect(reported({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 })).toMatchObject({
      inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: null, totalTokensBasis: "unknown",
    });
  });
});

describe("usage from the complete original-call ledger", () => {
  it("sums complete reported components without double counting cached or reasoning subsets", () => {
    const rows = [reported({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 5 } }),
    reported({ input_tokens: 50, output_tokens: 30, total_tokens: 80,
      input_tokens_details: { cached_tokens: 10 }, output_tokens_details: { reasoning_tokens: 7 } })];
    expect(summarizeModelUsage(rows, "assist_scope")).toEqual({ scope: "assist_scope", state: "complete",
      callCount: 2, reportedCalls: 2, unknownCalls: 0, inputTokens: 150, outputTokens: 50, cachedInputTokens: 50, totalTokens: 200 });
  });

  it("distinguishes no submitted calls, unknown reports and an actual zero report", () => {
    expect(summarizeModelUsage([], "order_design_run")).toEqual({ scope: "order_design_run", state: "empty",
      callCount: 0, reportedCalls: 0, unknownCalls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 });
    expect(summarizeModelUsage([null, undefined], "order_design_run")).toEqual({ scope: "order_design_run", state: "unreported",
      callCount: 2, reportedCalls: 0, unknownCalls: 2, inputTokens: null, outputTokens: null, cachedInputTokens: null, totalTokens: null });
    expect(summarizeModelUsage([reported({ input_tokens: 0, output_tokens: 0 })], "order_design_run")).toMatchObject({
      state: "complete", callCount: 1, reportedCalls: 1, unknownCalls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0,
    });
  });

  it("shows known subtotals and the full unknown-call count for a partial ledger", () => {
    const rows = [reported({ input_tokens: 100, output_tokens: 200 }), null,
      reported({ input_tokens: 7 }), undefined];
    expect(summarizeModelUsage(rows, "order_design_work_item")).toEqual({ scope: "order_design_work_item", state: "partial",
      callCount: 4, reportedCalls: 1, unknownCalls: 3, inputTokens: 107, outputTokens: 200, cachedInputTokens: null, totalTokens: 300 });
    expect(summarizeModelUsage([reported({ input_tokens: 0 })], "assist_scope")).toMatchObject({
      state: "partial", reportedCalls: 0, unknownCalls: 1, inputTokens: 0, outputTokens: null, totalTokens: null,
    });
  });

  it("includes every supplied original row beyond the recent-history display limit", () => {
    const rows = Array.from({ length: 1001 }, () => reported({ input_tokens: 1, output_tokens: 2, total_tokens: 3 }));
    expect(summarizeModelUsage(rows, "order_design_work_item")).toMatchObject({ state: "complete",
      callCount: 1001, reportedCalls: 1001, unknownCalls: 0, inputTokens: 1001, outputTokens: 2002, totalTokens: 3003 });
  });

  it("fails closed when safe individual reports overflow a cumulative count", () => {
    const rows = [reported({ input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 }),
      reported({ input_tokens: 1, output_tokens: 0 })];
    expect(() => summarizeModelUsage(rows, "assist_scope")).toThrow("model_usage_total_overflow");
  });

  it("rejects contradictory persisted usage rather than silently dropping the bad row", () => {
    const original = reported({ input_tokens: 10, output_tokens: 20 });
    expect(() => summarizeModelUsage([{ ...original, totalTokens: 999 }], "assist_scope")).toThrow();
  });
});
