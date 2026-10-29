import { normalizeModelTokenUsage } from "../model-usage.js";
import { calculateCostUsd } from "../provider.js";
import type { ModelResponseCheckpoint } from "../response-checkpoint.js";
import type { ProviderPricing } from "./shared.js";

/** Preserve reported consumption before interpreting or rejecting model content. */
export function modelReceipt(input: {
  providerId: string; modelKey: string; requestId: string | null;
  payload: Record<string, unknown>; pricing: ProviderPricing | null;
}): ModelResponseCheckpoint {
  const tokenUsage = normalizeModelTokenUsage(input.payload.usage);
  const inputTokens = tokenUsage?.inputTokens ?? null;
  const outputTokens = tokenUsage?.outputTokens ?? null;
  return {
    version: "model-response-v1", providerId: input.providerId, modelKey: input.modelKey,
    providerRequestId: input.requestId ?? (typeof input.payload.id === "string" ? input.payload.id : null),
    payload: input.payload, inputTokens, outputTokens, tokenUsage,
    costUsd: input.pricing && inputTokens !== null && outputTokens !== null
      ? calculateCostUsd(inputTokens, outputTokens, input.pricing.inputUsdPerMillion, input.pricing.outputUsdPerMillion) : null,
    receivedAt: new Date().toISOString(),
  };
}
