import { ModelTokenUsageSchema, type ModelTokenUsage } from "@yummyai/contracts/ai/model-usage";
import {
  OfficialApiPriceCatalogSchema,
  OfficialApiPriceCheckSchema,
  type OfficialApiPriceCheck,
} from "@yummyai/contracts/ai/official-model-pricing";

/** Reviewed public rate card. Updating prices creates a new source-controlled version. */
export const OFFICIAL_API_PRICE_CATALOG = OfficialApiPriceCatalogSchema.parse({
  version: "openai-standard-2026-10-29-v1",
  checkedAt: "2026-10-29T09:10:00.000Z",
  currency: "USD",
  unitTokens: 1_000_000,
  basis: "official_standard_list_price",
  rates: [
    {
      modelId: "gpt-6.1-sol",
      category: "text",
      sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
      inputUsdPerMillion: "2.00000000",
      cachedInputUsdPerMillion: "0.10000000",
      outputUsdPerMillion: "10.00000000",
      imageInputUsdPerMillion: null,
      cachedImageInputUsdPerMillion: null,
      cacheWrite30mUsdPerMillion: "2.50000000",
      cacheWrite12hUsdPerMillion: "5.00000000",
      longContextAfterInputTokens: 272_000,
      notes: [
        "输入超过272000 token时整次请求输入及缓存价格乘2 输出价格乘1.5",
        "缓存读取与30分钟及12小时写入均包含在输入token内 分别计价",
      ],
    },
    ...["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"].map((modelId) => ({
      modelId,
      category: "image",
      sourceUrl: `https://developers.openai.com/api/docs/models/${modelId}`,
      inputUsdPerMillion: "5.00000000",
      cachedInputUsdPerMillion: "1.25000000",
      outputUsdPerMillion: "30.00000000",
      imageInputUsdPerMillion: "8.00000000",
      cachedImageInputUsdPerMillion: "2.00000000",
      cacheWrite30mUsdPerMillion: null,
      cacheWrite12hUsdPerMillion: null,
      longContextAfterInputTokens: null,
      notes: [
        "文字输入与图像输入按各自实际token计费",
        "Direct Images API不适用缓存折扣 Responses图像工具的缓存命中数可能不在usage内",
        "相同token单价不代表每张图片费用相同",
      ],
    })),
  ],
  notes: [
    "按OpenAI官方Standard公开API单价核算美元 不代表自建渠道最终账单",
    "不自动套用Batch Flex Fast Ultrafast或地区附加费",
    "缺少实际用量或计价拆分时保留未知 不按零元结算",
  ],
});

const units = (value: string) => BigInt(value.replace(".", ""));
function usd(value: bigint): string {
  return `${value / 100_000_000n}.${String(value % 100_000_000n).padStart(8, "0")}`;
}

/** No billing or budget mutation. All components come from one original receipt. */
export function checkOfficialApiPrice(input: {
  modelId: string;
  tokenUsage: ModelTokenUsage | null | undefined;
  endpointKind: OfficialApiPriceCheck["endpointKind"];
}): OfficialApiPriceCheck {
  const parsed =
    input.tokenUsage == null ? null : ModelTokenUsageSchema.safeParse(input.tokenUsage);
  const usage = parsed?.success ? parsed.data : null;
  const rate = OFFICIAL_API_PRICE_CATALOG.rates.find((row) => row.modelId === input.modelId);
  const issues: string[] = [],
    components: OfficialApiPriceCheck["components"] = [];
  // Sum exact integer products before rounding once to eight USD decimal places.
  let numerator = 0n;
  const add = (
    kind: OfficialApiPriceCheck["components"][number]["kind"],
    label: string,
    tokens: number,
    price: string,
  ) => {
    const product = BigInt(tokens) * units(price);
    numerator += product;
    components.push({
      kind,
      label,
      tokenCount: tokens,
      usdPerMillion: price,
      amountUsd: usd((product + 500_000n) / 1_000_000n),
    });
  };
  if (!rate) issues.push("没有此精确模型ID的已核实官方价格 不套用相似名称或别名");
  else if (!usage) issues.push("原调用尚无可用token回执 无法计算费用");
  else if (rate.category === "image") {
    const text = usage.inputTextTokens,
      image = usage.inputImageTokens;
    if (input.endpointKind !== "images")
      issues.push("未证实Direct Images计费边界 或Responses未提供图像缓存命中拆分 输入费用未知");
    else if (
      text == null ||
      image == null ||
      (usage.inputTokens !== null && text + image !== usage.inputTokens)
    )
      issues.push("缺少一致的文字和图像输入token拆分");
    else {
      add("input", "文字输入", text, rate.inputUsdPerMillion);
      add("image_input", "图像输入", image, rate.imageInputUsdPerMillion!);
    }
    const output = usage.outputImageTokens ?? usage.outputTokens;
    if (
      output == null ||
      (usage.outputTextTokens ?? 0) !== 0 ||
      (usage.outputTokens !== null && output !== usage.outputTokens)
    )
      issues.push("缺少一致的图像输出token用量");
    else add("image_output", "图像输出", output, rate.outputUsdPerMillion);
  } else {
    if (usage.inputTokens === null) issues.push("缺少整次输入token 无法确定长上下文档位");
    else {
      const long =
        rate.longContextAfterInputTokens !== null &&
        usage.inputTokens > rate.longContextAfterInputTokens;
      const multiply = (price: string, multiplier: bigint, divisor = 1n) =>
        usd((units(price) * multiplier) / divisor);
      const inPrice = multiply(rate.inputUsdPerMillion, long ? 2n : 1n);
      const cachedPrice = multiply(rate.cachedInputUsdPerMillion, long ? 2n : 1n);
      const outPrice = multiply(rate.outputUsdPerMillion, long ? 3n : 2n, 2n);
      const cached = usage.cachedInputTokens,
        writes = usage.cacheWriteInputTokens;
      const write30 = writes === 0 ? 0 : usage.cacheWrite30mTokens;
      const write12 = writes === 0 ? 0 : usage.cacheWrite12hTokens;
      if (
        cached === null ||
        writes == null ||
        write30 == null ||
        write12 == null ||
        write30 + write12 !== writes ||
        cached + writes > usage.inputTokens
      )
        issues.push("缺少一致的缓存读取与缓存写入时长用量 输入费用未知");
      else {
        add("input", "普通输入", usage.inputTokens - cached - writes, inPrice);
        add("cached_input", "缓存读取", cached, cachedPrice);
        add(
          "cache_write_30m",
          "缓存写入30分钟",
          write30,
          multiply(rate.cacheWrite30mUsdPerMillion!, long ? 2n : 1n),
        );
        add(
          "cache_write_12h",
          "缓存写入12小时",
          write12,
          multiply(rate.cacheWrite12hUsdPerMillion!, long ? 2n : 1n),
        );
      }
      if (usage.outputTokens === null) issues.push("缺少输出token用量");
      else add("output", "输出 含推理token", usage.outputTokens, outPrice);
    }
  }
  const subtotal = components.length ? usd((numerator + 500_000n) / 1_000_000n) : null;
  return OfficialApiPriceCheckSchema.parse({
    modelId: input.modelId,
    priceVersion: OFFICIAL_API_PRICE_CATALOG.version,
    status: !rate
      ? "model_unsupported"
      : !usage
        ? "usage_missing"
        : issues.length
          ? "partial"
          : "calculated",
    amountUsd: issues.length ? null : subtotal,
    knownSubtotalUsd: subtotal,
    sourceUrl: rate?.sourceUrl ?? null,
    endpointKind: input.endpointKind,
    usage,
    components,
    issues,
  });
}
