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
  schemaName,
  throwProviderResponseError,
  type ProviderPricing,
  untrustedUserMessage,
} from "./shared.js";

export interface OpenAiCompatibleProviderConfig {
  providerId: string;
  apiKey: string;
  endpoint: string;
  pricing: ProviderPricing;
  fetch?: typeof globalThis.fetch;
}

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly providerId: string;
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly config: OpenAiCompatibleProviderConfig) {
    this.providerId = config.providerId;
    this.request = config.fetch ?? globalThis.fetch;
  }

  async generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal): Promise<ModelResult<T>> {
    const response = await this.request(normalizeEndpoint(this.config.endpoint, "/v1/chat/completions"), {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.providerModel,
        max_tokens: request.maxOutputTokens ?? 1_024,
        messages: [
          { role: "system", content: request.systemInstructions },
          { role: "user", content: untrustedUserMessage(request.untrustedSourceData) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: schemaName(request.outputSchemaName ?? request.taskType),
            schema: z.toJSONSchema(request.outputSchema),
            strict: true,
          },
        },
      }),
    });
    if (!response.ok) await throwProviderResponseError(response, this.providerId);
    const payload = (await response.json()) as {
      id?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const value = request.outputSchema.parse(JSON.parse(extractJsonText(payload)));
    const inputTokens = payload.usage?.prompt_tokens ?? 0;
    const outputTokens = payload.usage?.completion_tokens ?? 0;
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
      providerRequestId: response.headers.get("x-request-id") ?? payload.id,
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
    try {
      const response = await this.request(normalizeEndpoint(this.config.endpoint, "/v1/models"), {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      });
      return { available: response.ok, checkedAt: new Date(), message: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return { available: false, checkedAt: new Date(), message: error instanceof Error ? error.message : "Network error" };
    }
  }
}
