import { z } from "zod";
import { ModelTokenUsageSchema } from "@yummyai/contracts/ai/model-usage";

const Usd = z.string().regex(/^\d+\.\d{8}$/);
export const OfficialApiRateSchema = z
  .object({
    modelId: z.string().min(1),
    category: z.enum(["text", "image"]),
    sourceUrl: z.url(),
    inputUsdPerMillion: Usd,
    cachedInputUsdPerMillion: Usd,
    outputUsdPerMillion: Usd,
    imageInputUsdPerMillion: Usd.nullable(),
    cachedImageInputUsdPerMillion: Usd.nullable(),
    cacheWrite30mUsdPerMillion: Usd.nullable(),
    cacheWrite12hUsdPerMillion: Usd.nullable(),
    longContextAfterInputTokens: z.int().positive().nullable(),
    notes: z.array(z.string()).max(8),
  })
  .strict();
export const OfficialApiPriceCatalogSchema = z
  .object({
    version: z.string(),
    checkedAt: z.iso.datetime(),
    currency: z.literal("USD"),
    unitTokens: z.literal(1_000_000),
    basis: z.literal("official_standard_list_price"),
    rates: z.array(OfficialApiRateSchema).max(100),
    notes: z.array(z.string()).max(8),
  })
  .strict();
export const OfficialApiPriceCheckSchema = z
  .object({
    modelId: z.string(),
    priceVersion: z.string(),
    status: z.enum(["calculated", "partial", "usage_missing", "model_unsupported"]),
    amountUsd: Usd.nullable(),
    knownSubtotalUsd: Usd.nullable(),
    sourceUrl: z.url().nullable(),
    endpointKind: z.enum(["images", "responses", "chat_completions", "unknown"]),
    usage: ModelTokenUsageSchema.nullable(),
    components: z
      .array(
        z
          .object({
            kind: z.enum([
              "input",
              "cached_input",
              "cache_write_30m",
              "cache_write_12h",
              "image_input",
              "image_output",
              "output",
            ]),
            label: z.string(),
            tokenCount: z.int().nonnegative(),
            usdPerMillion: Usd,
            amountUsd: Usd,
          })
          .strict(),
      )
      .max(8),
    issues: z.array(z.string()).max(12),
  })
  .strict();
export type OfficialApiRate = z.infer<typeof OfficialApiRateSchema>;
export type OfficialApiPriceCatalog = z.infer<typeof OfficialApiPriceCatalogSchema>;
export type OfficialApiPriceCheck = z.infer<typeof OfficialApiPriceCheckSchema>;
