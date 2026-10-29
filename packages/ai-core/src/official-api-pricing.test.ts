import { describe, expect, it } from "vitest";
import type { ModelTokenUsage } from "@yummyai/contracts/ai/model-usage";
import { OfficialApiPriceCatalogSchema } from "@yummyai/contracts/ai/official-model-pricing";
import { checkOfficialApiPrice, OFFICIAL_API_PRICE_CATALOG } from "./official-api-pricing.js";
import { normalizeModelTokenUsage } from "./model-usage.js";

function textUsage(change: Partial<ModelTokenUsage> = {}): ModelTokenUsage {
  const inputTokens = change.inputTokens === undefined ? 1_000 : change.inputTokens;
  const outputTokens = change.outputTokens === undefined ? 100 : change.outputTokens;
  const totalTokens =
    inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens;
  return {
    version: "model-token-usage-v1",
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens,
    totalTokensBasis: totalTokens === null ? "unknown" : "provider",
    ...change,
  };
}
function imageUsage(change: Partial<ModelTokenUsage> = {}): ModelTokenUsage {
  return textUsage({
    inputTokens: 300,
    outputTokens: 300,
    cachedInputTokens: 70,
    inputTextTokens: 100,
    inputImageTokens: 200,
    outputTextTokens: 0,
    outputImageTokens: 300,
    ...change,
  });
}
const sol = (tokenUsage: ModelTokenUsage | null | undefined) =>
  checkOfficialApiPrice({ modelId: "gpt-6.1-sol", tokenUsage, endpointKind: "responses" });

describe("official standard API reference prices from original usage", () => {
  it("pins the reviewed exact model IDs and distinct cache-write durations", () => {
    const catalog = OfficialApiPriceCatalogSchema.parse(OFFICIAL_API_PRICE_CATALOG);
    expect(catalog).toMatchObject({
      currency: "USD",
      unitTokens: 1_000_000,
      basis: "official_standard_list_price",
    });
    expect(catalog.rates.map((row) => row.modelId)).toEqual([
      "gpt-6.1-sol",
      "gpt-image-2",
      "gpt-image-2.5-flare",
      "gpt-image-2.5-sunburst",
    ]);
    expect(catalog.rates[0]).toMatchObject({
      inputUsdPerMillion: "2.00000000",
      cachedInputUsdPerMillion: "0.10000000",
      outputUsdPerMillion: "10.00000000",
      cacheWrite30mUsdPerMillion: "2.50000000",
      cacheWrite12hUsdPerMillion: "5.00000000",
      longContextAfterInputTokens: 272_000,
    });
    for (const row of catalog.rates) {
      expect(row.sourceUrl).toBe("https://developers.openai.com/api/docs/models/" + row.modelId);
    }
  });

  it.each([
    ["ordinary input", {}, "0.00300000"],
    ["cached input subset", { cachedInputTokens: 400 }, "0.00224000"],
    [
      "both write durations",
      {
        cachedInputTokens: 200,
        cacheWriteInputTokens: 300,
        cacheWrite30mTokens: 100,
        cacheWrite12hTokens: 200,
      },
      "0.00327000",
    ],
    [
      "30 minute writes",
      {
        cachedInputTokens: 200,
        cacheWriteInputTokens: 300,
        cacheWrite30mTokens: 300,
        cacheWrite12hTokens: 0,
      },
      "0.00277000",
    ],
    ["short threshold", { inputTokens: 272_000, outputTokens: 1_000 }, "0.55400000"],
    ["entire long request", { inputTokens: 272_001, outputTokens: 1_000 }, "1.10300400"],
    [
      "cached tokens included in long threshold",
      { inputTokens: 272_001, outputTokens: 1_000, cachedInputTokens: 100_000 },
      "0.72300400",
    ],
    [
      "long cache writes",
      {
        inputTokens: 272_001,
        outputTokens: 1_000,
        cachedInputTokens: 100_000,
        cacheWriteInputTokens: 30_000,
        cacheWrite30mTokens: 10_000,
        cacheWrite12hTokens: 20_000,
      },
      "0.85300400",
    ],
  ] satisfies [string, Partial<ModelTokenUsage>, string][])(
    "calculates %s without counting input subsets twice",
    (_name, change, expected) => {
      const usage = textUsage(change),
        original = structuredClone(usage),
        result = sol(usage);
      expect(result).toMatchObject({
        status: "calculated",
        amountUsd: expected,
        knownSubtotalUsd: expected,
        issues: [],
      });
      expect(
        result.components
          .filter((row) => row.kind !== "output")
          .reduce((sum, row) => sum + row.tokenCount, 0),
      ).toBe(usage.inputTokens);
      expect(usage).toEqual(original);
    },
  );

  it("uses the long rates for each original component and does not add reasoning twice", () => {
    const result = sol(textUsage({ inputTokens: 272_001, reasoningTokens: 90 }));
    expect(result.components.find((row) => row.kind === "input")?.usdPerMillion).toBe("4.00000000");
    expect(result.components.find((row) => row.kind === "cached_input")?.usdPerMillion).toBe(
      "0.20000000",
    );
    expect(result.components.find((row) => row.kind === "cache_write_30m")?.usdPerMillion).toBe(
      "5.00000000",
    );
    expect(result.components.find((row) => row.kind === "cache_write_12h")?.usdPerMillion).toBe(
      "10.00000000",
    );
    expect(result.components.find((row) => row.kind === "output")).toMatchObject({
      tokenCount: 100,
      usdPerMillion: "15.00000000",
    });
    expect(sol(textUsage({ reasoningTokens: 90 })).amountUsd).toBe("0.00300000");
  });

  it("accepts a reported zero write total with absent duration fields", () => {
    const usage = textUsage();
    expect(usage).not.toHaveProperty("cacheWrite30mTokens");
    expect(usage).not.toHaveProperty("cacheWrite12hTokens");
    expect(sol(usage).status).toBe("calculated");
  });

  it.each([
    ["unreported cached reads", { cachedInputTokens: null }],
    ["unreported write total", { cacheWriteInputTokens: undefined }],
    ["unreported write durations", { cacheWriteInputTokens: 100 }],
    [
      "inconsistent write durations",
      { cacheWriteInputTokens: 100, cacheWrite30mTokens: 20, cacheWrite12hTokens: 30 },
    ],
    [
      "overlapping cached and written input",
      {
        cachedInputTokens: 800,
        cacheWriteInputTokens: 300,
        cacheWrite30mTokens: 300,
        cacheWrite12hTokens: 0,
      },
    ],
  ] satisfies [string, Partial<ModelTokenUsage>][])(
    "retains unknown input for %s",
    (_name, change) => {
      const result = sol(textUsage(change));
      expect(result).toMatchObject({
        status: "partial",
        amountUsd: null,
        knownSubtotalUsd: "0.00100000",
      });
      expect(result.components.map((row) => row.kind)).toEqual(["output"]);
      expect(result.issues.length).toBeGreaterThan(0);
    },
  );

  it("distinguishes a fully reported zero from no receipt or an unknown component", () => {
    expect(sol(textUsage({ inputTokens: 0, outputTokens: 0 }))).toMatchObject({
      status: "calculated",
      amountUsd: "0.00000000",
    });
    for (const usage of [null, undefined]) {
      expect(sol(usage)).toMatchObject({
        status: "usage_missing",
        amountUsd: null,
        knownSubtotalUsd: null,
        components: [],
      });
    }
    expect(sol(textUsage({ outputTokens: null }))).toMatchObject({
      status: "partial",
      amountUsd: null,
      knownSubtotalUsd: "0.00200000",
    });
    expect(sol(textUsage({ inputTokens: null }))).toMatchObject({
      status: "partial",
      amountUsd: null,
      knownSubtotalUsd: null,
    });
  });

  it.each([
    { totalTokens: 999 },
    { cachedInputTokens: 1_001 },
    { inputTokens: -1 },
    {
      inputTokens: Number.MAX_SAFE_INTEGER + 1,
      totalTokens: null,
      totalTokensBasis: "unknown" as const,
    },
  ])("does not price invalid native units %j", (change) => {
    expect(sol(textUsage(change))).toMatchObject({
      status: "usage_missing",
      amountUsd: null,
      knownSubtotalUsd: null,
    });
  });

  it("preserves exact large-integer products and sub-microdollar cache charges", () => {
    expect(
      sol(textUsage({ inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0 })).amountUsd,
    ).toBe("36028797018.96396400");
    expect(
      sol(textUsage({ inputTokens: 1, outputTokens: 0, cachedInputTokens: 1 })).amountUsd,
    ).toBe("0.00000010");
  });

  it.each(["sol", "gpt-6.1-sol-latest", "gpt-image-2.5", "gpt-image-2.5-flare-alias"])(
    "does not borrow a price for unverified model ID %s",
    (modelId) => {
      expect(
        checkOfficialApiPrice({ modelId, tokenUsage: textUsage(), endpointKind: "responses" }),
      ).toMatchObject({
        status: "model_unsupported",
        amountUsd: null,
        knownSubtotalUsd: null,
        sourceUrl: null,
        components: [],
      });
    },
  );

  it.each(["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"])(
    "prices direct Images %s by modality without cache discounts",
    (modelId) => {
      const result = checkOfficialApiPrice({
        modelId,
        tokenUsage: imageUsage(),
        endpointKind: "images",
      });
      expect(result).toMatchObject({
        status: "calculated",
        amountUsd: "0.01110000",
        knownSubtotalUsd: "0.01110000",
        issues: [],
      });
      expect(result.components.map((row) => [row.kind, row.tokenCount, row.usdPerMillion])).toEqual(
        [
          ["input", 100, "5.00000000"],
          ["image_input", 200, "8.00000000"],
          ["image_output", 300, "30.00000000"],
        ],
      );
    },
  );

  it.each(["responses", "unknown", "chat_completions"] as const)(
    "keeps unverified image cache hits unknown on %s",
    (endpointKind) => {
      expect(
        checkOfficialApiPrice({
          modelId: "gpt-image-2.5-flare",
          tokenUsage: imageUsage({ cachedInputTokens: null }),
          endpointKind,
        }),
      ).toMatchObject({
        status: "partial",
        amountUsd: null,
        knownSubtotalUsd: "0.00900000",
        components: [{ kind: "image_output", tokenCount: 300 }],
      });
    },
  );

  it.each([{ inputTextTokens: null }, { inputImageTokens: 201 }])(
    "keeps missing or inconsistent image input unknown %j",
    (change) => {
      expect(
        checkOfficialApiPrice({
          modelId: "gpt-image-2.5-flare",
          tokenUsage: imageUsage(change),
          endpointKind: "images",
        }),
      ).toMatchObject({
        status: "partial",
        amountUsd: null,
        knownSubtotalUsd: "0.00900000",
      });
    },
  );

  it("does not assign image-output rates to unsupported text output", () => {
    expect(
      checkOfficialApiPrice({
        modelId: "gpt-image-2.5-flare",
        tokenUsage: imageUsage({ outputTextTokens: 1 }),
        endpointKind: "images",
      }),
    ).toMatchObject({
      status: "partial",
      amountUsd: null,
      knownSubtotalUsd: "0.00210000",
    });
  });
});

describe("original cache-write usage normalization", () => {
  it("does not invent cache-write metadata absent from the original response", () => {
    const usage = normalizeModelTokenUsage({
      input_tokens: 1_000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 0 },
    });
    expect(usage).not.toHaveProperty("cacheWriteInputTokens");
    expect(usage).not.toHaveProperty("cacheWrite30mTokens");
    expect(usage).not.toHaveProperty("cacheWrite12hTokens");
    expect(sol(usage)).toMatchObject({
      status: "partial",
      amountUsd: null,
      knownSubtotalUsd: "0.00100000",
    });
  });

  it("retains reported zero writes while leaving absent duration fields unknown", () => {
    const usage = normalizeModelTokenUsage({
      input_tokens: 1_000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    });
    expect(usage).toMatchObject({
      cacheWriteInputTokens: 0,
      cacheWrite30mTokens: null,
      cacheWrite12hTokens: null,
    });
    expect(sol(usage).amountUsd).toBe("0.00300000");
  });

  it("retains both actual write durations as input subsets", () => {
    const usage = normalizeModelTokenUsage({
      input_tokens: 1_000,
      output_tokens: 100,
      input_tokens_details: {
        cached_tokens: 200,
        cache_write_tokens: 300,
        cache_write_tokens_details: { ttl_30m_tokens: 100, ttl_12h_tokens: 200 },
      },
    });
    expect(usage).toMatchObject({
      inputTokens: 1_000,
      totalTokens: 1_100,
      cacheWriteInputTokens: 300,
      cacheWrite30mTokens: 100,
      cacheWrite12hTokens: 200,
    });
    expect(sol(usage).amountUsd).toBe("0.00327000");
  });

  it("preserves invalid write counters as unknown rather than zero", () => {
    const usage = normalizeModelTokenUsage({
      input_tokens: 1_000,
      output_tokens: 100,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: -1 },
    });
    expect(usage).toMatchObject({ cacheWriteInputTokens: null });
    expect(sol(usage)).toMatchObject({ status: "partial", amountUsd: null });
  });
});
