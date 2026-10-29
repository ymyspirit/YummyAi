import { z } from "zod";

const Count = z.int().nonnegative().nullable();
/** Provider-reported units only. Cached and reasoning tokens are subsets, never extra totals. */
export const ModelTokenUsageSchema = z.object({
  version: z.literal("model-token-usage-v1"),
  inputTokens: Count, outputTokens: Count, cachedInputTokens: Count, totalTokens: Count,
  totalTokensBasis: z.enum(["provider", "reported_components", "unknown"]),
  inputTextTokens: Count.optional(), inputImageTokens: Count.optional(),
  outputTextTokens: Count.optional(), outputImageTokens: Count.optional(), reasoningTokens: Count.optional(),
}).strict().superRefine((value, context) => {
  if ((value.totalTokens === null) !== (value.totalTokensBasis === "unknown"))
    context.addIssue({ code: "custom", message: "A token total must retain its evidence basis" });
  if (value.totalTokensBasis === "reported_components" && (value.inputTokens === null || value.outputTokens === null))
    context.addIssue({ code: "custom", message: "A component sum requires both reported components" });
  if (value.inputTokens !== null && value.outputTokens !== null && value.totalTokens !== null &&
      value.totalTokens !== value.inputTokens + value.outputTokens)
    context.addIssue({ code: "custom", message: "Token components and total disagree" });
  if (value.cachedInputTokens !== null && value.inputTokens !== null && value.cachedInputTokens > value.inputTokens)
    context.addIssue({ code: "custom", message: "Cached input tokens are part of input tokens" });
});
export type ModelTokenUsage = z.infer<typeof ModelTokenUsageSchema>;

export const ModelUsageScopeSchema = z.enum(["assist_scope", "order_design_run", "order_design_work_item"]);
export const ModelUsageSummarySchema = z.object({
  scope: ModelUsageScopeSchema,
  state: z.enum(["empty", "complete", "partial", "unreported"]),
  callCount: z.int().nonnegative(), reportedCalls: z.int().nonnegative(), unknownCalls: z.int().nonnegative(),
  inputTokens: Count, outputTokens: Count, cachedInputTokens: Count, totalTokens: Count,
}).strict().superRefine((value, context) => {
  if (value.reportedCalls + value.unknownCalls !== value.callCount)
    context.addIssue({ code: "custom", message: "Usage call counts must cover the original ledger" });
  if ((value.state === "empty") !== (value.callCount === 0))
    context.addIssue({ code: "custom", message: "Empty usage means no calls were submitted" });
  const units = [value.inputTokens, value.outputTokens, value.cachedInputTokens, value.totalTokens];
  if (value.state === "empty" && units.some(unit => unit !== 0))
    context.addIssue({ code: "custom", message: "No submitted calls have an empty sum of zero" });
  if (value.state === "complete" && (value.unknownCalls !== 0 || value.reportedCalls !== value.callCount ||
      value.inputTokens === null || value.outputTokens === null || value.totalTokens === null || value.totalTokens !== value.inputTokens + value.outputTokens))
    context.addIssue({ code: "custom", message: "Complete usage requires all original calls and components" });
  if (value.state === "complete" && value.cachedInputTokens !== null && value.inputTokens !== null && value.cachedInputTokens > value.inputTokens)
    context.addIssue({ code: "custom", message: "Cached input tokens are part of input tokens" });
  if (value.state === "unreported" && (value.reportedCalls !== 0 || units.some(unit => unit !== null)))
    context.addIssue({ code: "custom", message: "Unreported usage cannot contain known units" });
  if (value.state === "partial" && (value.unknownCalls === 0 || units.every(unit => unit === null)))
    context.addIssue({ code: "custom", message: "A known subtotal must retain incomplete original calls" });
});
export type ModelUsageSummary = z.infer<typeof ModelUsageSummarySchema>;
