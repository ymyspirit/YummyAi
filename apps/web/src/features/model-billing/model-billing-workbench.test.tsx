import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  OfficialApiPriceCatalogSchema,
  OfficialApiPriceCheckSchema,
} from "@yummyai/contracts/ai/official-model-pricing";
import { OfficialPriceCatalogPanel, OfficialPriceCheckPanel } from "./model-billing-workbench";

const sourceUrl = "https://developers.openai.com/api/docs/models/gpt-6.1-sol";
const catalog = OfficialApiPriceCatalogSchema.parse({
  version: "synthetic-price-snapshot",
  checkedAt: "2026-10-29T00:00:00.000Z",
  currency: "USD",
  unitTokens: 1_000_000,
  basis: "official_standard_list_price",
  rates: [{
    modelId: "gpt-6.1-sol", category: "text", sourceUrl,
    inputUsdPerMillion: "2.00000000", cachedInputUsdPerMillion: "0.10000000",
    outputUsdPerMillion: "10.00000000", imageInputUsdPerMillion: null,
    cachedImageInputUsdPerMillion: null, cacheWrite30mUsdPerMillion: "2.50000000",
    cacheWrite12hUsdPerMillion: null, longContextAfterInputTokens: 272_000,
    notes: ["Synthetic long-context pricing rule"],
  }, {
    modelId: "gpt-image-2.5-flare", category: "image",
    sourceUrl: "https://developers.openai.com/api/docs/models/gpt-image-2.5-flare",
    inputUsdPerMillion: "5.00000000", cachedInputUsdPerMillion: "1.25000000",
    outputUsdPerMillion: "30.00000000", imageInputUsdPerMillion: "8.00000000",
    cachedImageInputUsdPerMillion: "2.00000000", cacheWrite30mUsdPerMillion: null,
    cacheWrite12hUsdPerMillion: null, longContextAfterInputTokens: null,
    notes: ["Direct Images API requests do not receive cached input pricing"],
  }],
  notes: ["Synthetic shared catalog response"],
});
const complete = OfficialApiPriceCheckSchema.parse({
  modelId: "gpt-6.1-sol", priceVersion: catalog.version, status: "calculated",
  amountUsd: "0.00969000", knownSubtotalUsd: "0.00969000",
  sourceUrl, endpointKind: "responses",
  usage: { version: "model-token-usage-v1", inputTokens: 1200, outputTokens: 800, cachedInputTokens: 400,
    totalTokens: 2000, totalTokensBasis: "provider", cacheWriteInputTokens: 100,
    cacheWrite30mTokens: 100, cacheWrite12hTokens: 0 },
  components: [
    { kind: "input", label: "未缓存输入", tokenCount: 700, usdPerMillion: "2.00000000", amountUsd: "0.00140000" },
    { kind: "cached_input", label: "缓存读取", tokenCount: 400, usdPerMillion: "0.10000000", amountUsd: "0.00004000" },
    { kind: "cache_write_30m", label: "30 分钟缓存写入", tokenCount: 100, usdPerMillion: "2.50000000", amountUsd: "0.00025000" },
    { kind: "output", label: "输出", tokenCount: 800, usdPerMillion: "10.00000000", amountUsd: "0.00800000" },
  ],
  issues: [],
});

describe("official standard API price catalog display", () => {
  it("keeps missing historical catalogs explicit without injecting a fallback price", () => {
    const html = renderToStaticMarkup(<OfficialPriceCatalogPanel />);
    expect(html).toContain("价格暂未读取");
    expect(html).not.toContain("$");
    expect(html).not.toContain("<table");
    expect(renderToStaticMarkup(<OfficialPriceCatalogPanel loading />))
      .toContain("正在读取官方标准 API 价格");
  });

  it("renders the shared price snapshot, exact decimal rates, modality columns and official sources", () => {
    const html = renderToStaticMarkup(<OfficialPriceCatalogPanel catalog={catalog} />);
    expect(html).toContain("USD / 1,000,000 token");
    expect(html).toContain("2026-10-29");
    expect(html).toContain(catalog.version);
    for (const amount of ["2.00000000", "0.10000000", "2.50000000", "30.00000000", "8.00000000", "1.25000000"])
      expect(html).toContain("$" + amount);
    expect(html).toContain('href="' + sourceUrl + '"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("图像缓存输入");
    expect(html).toContain("272,000");
    expect(html).toContain("Synthetic long-context pricing rule");
    expect(html).toContain("Direct Images API requests do not receive cached input pricing");
  });
});

describe("original-call official price check display", () => {
  it("shows the server formulas and preserves all eight decimal places", () => {
    const html = renderToStaticMarkup(<OfficialPriceCheckPanel check={complete} />);
    expect(html).toContain("官方核价已完成");
    expect(html).toContain("700 token × $2.00000000 ÷ 1,000,000 = $0.00140000");
    expect(html).toContain("100 token × $2.50000000 ÷ 1,000,000 = $0.00025000");
    expect(html).toContain("$0.00969000");
    expect(html).toContain("Responses API");
    expect(html).toContain("渠道实际费用仍以原账单和凭证核对为准");
  });

  it("retains the original total and never adds cache reads or writes again", () => {
    const html = renderToStaticMarkup(<OfficialPriceCheckPanel check={complete} />);
    expect(html).toContain("输入 <strong>1,200</strong>");
    expect(html).toContain("缓存输入 <strong>400</strong>");
    expect(html).toContain("合计 <strong>2,000</strong>");
    expect(html).not.toContain("2,400");
    expect(html).not.toContain("2,500");
    expect(html).toContain('data-kind="cache_write_30m"');
  });

  it("labels a partial amount as a known subtotal and retains missing modality evidence", () => {
    const check = OfficialApiPriceCheckSchema.parse({ ...complete, status: "partial", amountUsd: null,
      knownSubtotalUsd: "0.00800000", endpointKind: "images",
      components: [complete.components.at(-1)], issues: ["缺少文本与图像输入拆分 无法核算总价"] });
    const html = renderToStaticMarkup(<OfficialPriceCheckPanel check={check} />);
    expect(html).toContain("已知小计");
    expect(html).toContain("$0.00800000");
    expect(html).toContain("暂无法核算总额");
    expect(html).toContain("缺少文本与图像输入拆分");
    expect(html).toContain("Images API");
    expect(html).not.toContain("官方核价已完成");
  });

  it.each(["usage_missing", "model_unsupported"] as const)("keeps %s costs unknown", status => {
    const check = OfficialApiPriceCheckSchema.parse({ ...complete, status, sourceUrl: null,
      usage: null, amountUsd: null, knownSubtotalUsd: null, components: [],
      issues: ["原始核价依据未返回"] });
    const html = renderToStaticMarkup(<OfficialPriceCheckPanel check={check} />);
    expect(html).toContain("暂无法核算总额");
    expect(html).toContain("原始核价依据未返回");
    expect(html.match(/<strong>未返回<\/strong>/g)).toHaveLength(4);
    expect(html).not.toContain("已知小计");
    expect(html).not.toContain("$0");
  });

  it("does not present an absent price check or an absent reported amount as a completed total", () => {
    const historical = renderToStaticMarkup(<OfficialPriceCheckPanel />);
    expect(historical).toContain("价格暂未读取");
    expect(historical).not.toContain("$");
    const absentAmount = renderToStaticMarkup(<OfficialPriceCheckPanel check={{ ...complete, amountUsd: null }} />);
    expect(absentAmount).toContain("暂无法核算总额");
    expect(absentAmount).not.toContain("官方核价已完成");
  });
});
