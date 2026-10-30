import { z } from "zod";

export const AnalysisModelPricingFields = {
  inputUsdPerMillion: z.number().nonnegative().max(1000).nullable().default(null),
  outputUsdPerMillion: z.number().nonnegative().max(5000).nullable().default(null),
  maxTaskCostUsd: z.number().positive().nullable().default(null),
};

export function analysisQuoteSupportsCap(value: {
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  maxTaskCostUsd: number | null;
}) {
  return value.maxTaskCostUsd === null || (value.inputUsdPerMillion !== null && value.outputUsdPerMillion !== null);
}

/** Unknown prices stay unknown; an optional hard cap requires a complete quote. */
export const AnalysisModelPricingSchema = z.object(AnalysisModelPricingFields).strict()
  .refine(analysisQuoteSupportsCap, { message: "设置费用上限前需要完整的输入和输出报价" });
export type AnalysisModelPricing = z.infer<typeof AnalysisModelPricingSchema>;
