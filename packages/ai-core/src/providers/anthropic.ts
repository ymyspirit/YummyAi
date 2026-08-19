import { z } from "zod";

import {
  calculateCostUsd,
  estimateTokens,
  type CostEstimate,
  type ModelProvider,
  type ModelResult,
  type ProviderHealth,
  type ResolvedModelRequest,
} from "../provider.js";
import {
  extractJsonText,
  normalizeEndpoint,
  throwProviderResponseError,
  type ProviderPricing,
  untrustedUserMessage,
} from "./shared.js";

export interface AnthropicProviderConfig {
  apiKey: string;
  endpoint?: string;
  pricing: ProviderPricing;
  fetch?: typeof globalThis.fetch;
}

export class AnthropicProvider implements ModelProvider {
  readonly providerId = "anthropic";
  private readonly endpoint: string;
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly config: AnthropicProviderConfig) {
    this.endpoint = config.endpoint ?? "https://api.anthropic.com";
    this.request = config.fetch ?? globalThis.fetch;
  }

  async generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal): Promise<ModelResult<T>> {
    const response = await this.request(normalizeEndpoint(this.endpoint, "/v1/messages"), {
      method: "POST",
      signal,
      headers: {
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        "x-api-key": this.config.apiKey,
      },
      body: JSON.stringify({
        model: request.providerModel,
        max_tokens: request.maxOutputTokens ?? 1_024,
        system: request.systemInstructions,
        messages: [{ role: "user", content: untrustedUserMessage(request.untrustedSourceData) }],
        output_config: { format: { type: "json_schema", schema: z.toJSONSchema(request.outputSchema) } },
      }),
    });
    if (!response.ok) await throwProviderResponseError(response, this.providerId);
    const payload = (await response.json()) as {
      id?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const value = request.outputSchema.parse(JSON.parse(extractJsonText(payload)));
    const inputTokens = payload.usage?.input_tokens ?? 0;
    const outputTokens = payload.usage?.output_tokens ?? 0;
    return {
      providerId: this.providerId,
      modelKey: request.modelKey,
      value,
      inputTokens,
      outputTokens,
      costUsd: calculateCostUsd(
        inputTokens,
        outputTokens,
        this.config.pricing.inputUsdPerMillion,
        this.config.pricing.outputUsdPerMillion,
      ),
      providerRequestId: response.headers.get("request-id") ?? payload.id,
      completedAt: new Date(),
    };
  }

  async estimate<T>(request: ResolvedModelRequest<T>): Promise<CostEstimate> {
    const estimatedInputTokens = estimateTokens(request.systemInstructions) + estimateTokens(request.untrustedSourceData);
    const maxOutputTokens = request.maxOutputTokens ?? 1_024;
    return {
      estimatedInputTokens,
      maxOutputTokens,
      costUsd: calculateCostUsd(
        estimatedInputTokens,
        maxOutputTokens,
        this.config.pricing.inputUsdPerMillion,
        this.config.pricing.outputUsdPerMillion,
      ),
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return { available: this.config.apiKey.length > 0, checkedAt: new Date() };
  }
}
