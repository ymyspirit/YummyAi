import {
  ModelTokenUsageSchema,
  ModelUsageSummarySchema,
  type ModelTokenUsage,
  type ModelUsageSummary,
} from "@yummyai/contracts/ai/model-usage";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
/** Normalize OpenAI Responses, Chat Completions and Images usage without inventing absent units. */
export function normalizeModelTokenUsage(rawUsage: unknown): ModelTokenUsage | null {
  const raw = object(rawUsage);
  if (!raw) return null;
  const inputTokens = count(raw.input_tokens ?? raw.prompt_tokens);
  const outputTokens = count(raw.output_tokens ?? raw.completion_tokens);
  const inputDetails = object(raw.input_tokens_details ?? raw.prompt_tokens_details);
  const outputDetails = object(raw.output_tokens_details ?? raw.completion_tokens_details);
  const cached = count(inputDetails?.cached_tokens);
  const cachedInputTokens =
    cached !== null && inputTokens !== null && cached > inputTokens ? null : cached;
  let totalTokens = count(raw.total_tokens);
  let totalTokensBasis: ModelTokenUsage["totalTokensBasis"] =
    totalTokens === null ? "unknown" : "provider";
  if (inputTokens !== null && outputTokens !== null) {
    const sum = inputTokens + outputTokens;
    if (raw.total_tokens == null && Number.isSafeInteger(sum)) {
      totalTokens = sum;
      totalTokensBasis = "reported_components";
    } else if (!Number.isSafeInteger(sum) || totalTokens !== sum) {
      totalTokens = null;
      totalTokensBasis = "unknown";
    }
  }
  const detail = {
    inputTextTokens: count(inputDetails?.text_tokens),
    inputImageTokens: count(inputDetails?.image_tokens),
    outputTextTokens: count(outputDetails?.text_tokens),
    outputImageTokens: count(outputDetails?.image_tokens),
    reasoningTokens: count(outputDetails?.reasoning_tokens),
  };
  const writes = object(inputDetails?.cache_write_tokens_details);
  const cacheWrites =
    inputDetails && ("cache_write_tokens" in inputDetails || writes)
      ? {
          cacheWriteInputTokens: count(inputDetails.cache_write_tokens),
          cacheWrite30mTokens: count(writes?.ttl_30m_tokens),
          cacheWrite12hTokens: count(writes?.ttl_12h_tokens),
        }
      : {};
  if (
    [
      inputTokens,
      outputTokens,
      cachedInputTokens,
      totalTokens,
      ...Object.values(detail),
      ...Object.values(cacheWrites),
    ].every((value) => value === null)
  )
    return null;
  return ModelTokenUsageSchema.parse({
    version: "model-token-usage-v1",
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens,
    totalTokensBasis,
    ...detail,
    ...cacheWrites,
  });
}

/** Callers supply one row per durable original call, including failed/cancelled attempts. Never pass a paginated UI history. */
export function summarizeModelUsage(
  items: readonly (ModelTokenUsage | null | undefined)[],
  scope: ModelUsageSummary["scope"],
): ModelUsageSummary {
  const rows = items.map((value) => (value == null ? null : ModelTokenUsageSchema.parse(value)));
  const sum = (key: "inputTokens" | "outputTokens" | "cachedInputTokens" | "totalTokens") => {
    const known = rows.flatMap((row) => (row?.[key] == null ? [] : [row[key]!]));
    if (!rows.length) return 0;
    if (!known.length) return null;
    const total = known.reduce((n, value) => n + value, 0);
    if (!Number.isSafeInteger(total)) throw new Error("model_usage_total_overflow");
    return total;
  };
  const reportedCalls = rows.filter(
    (row) =>
      row?.inputTokens !== null &&
      row?.inputTokens !== undefined &&
      row.outputTokens !== null &&
      row.totalTokens !== null,
  ).length;
  const totals = {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    totalTokens: sum("totalTokens"),
  };
  return ModelUsageSummarySchema.parse({
    scope,
    state: !rows.length
      ? "empty"
      : reportedCalls === rows.length
        ? "complete"
        : Object.values(totals).every((value) => value === null)
          ? "unreported"
          : "partial",
    callCount: rows.length,
    reportedCalls,
    unknownCalls: rows.length - reportedCalls,
    ...totals,
  });
}
