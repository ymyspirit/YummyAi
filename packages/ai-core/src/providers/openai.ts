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

export interface OpenAiProviderConfig {
  apiKey: string;
  endpoint?: string;
  pricing: ProviderPricing;
  fetch?: typeof globalThis.fetch;
}

export class OpenAiProvider implements ModelProvider {
  readonly providerId = "openai";
  private readonly endpoint: string;
  private readonly request: typeof globalThis.fetch;

  constructor(private readonly config: OpenAiProviderConfig) {
    this.endpoint = config.endpoint ?? "https://api.openai.com";
    this.request = config.fetch ?? globalThis.fetch;
  }

  async generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal): Promise<ModelResult<T>> {
    const response = await this.request(normalizeEndpoint(this.endpoint, "/v1/responses"), {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.providerModel,
        instructions: request.systemInstructions,
        input: [{ role: "user", content: untrustedUserMessage(request.untrustedSourceData) }],
        max_output_tokens: request.maxOutputTokens ?? 1_024,
        store: false,
        text: {
          format: {
            type: "json_schema",
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
      const response = await this.request(normalizeEndpoint(this.endpoint, "/v1/models"), {
        headers: { authorization: `Bearer ${this.config.apiKey}` },
      });
      return { available: response.ok, checkedAt: new Date(), message: response.ok ? undefined : `HTTP ${response.status}` };
    } catch (error) {
      return { available: false, checkedAt: new Date(), message: error instanceof Error ? error.message : "Network error" };
    }
  }
}
