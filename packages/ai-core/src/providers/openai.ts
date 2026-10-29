import { z } from "zod";
import { readResponsesPayload } from "./responses-payload.js";
import { modelReceipt } from "./model-receipt.js";
import type { ModelResponseCheckpoint } from "../response-checkpoint.js";

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
  parseStructuredOutput,
  normalizeEndpoint,
  schemaName,
  throwProviderResponseError,
  type ProviderPricing,
  untrustedUserMessage,
} from "./shared.js";

export interface OpenAiProviderConfig {
  apiKey: string;
  endpoint?: string;
  pricing: ProviderPricing | null;
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
      redirect: "error",
      signal,
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        model: request.providerModel,
        instructions: request.systemInstructions,
        input: [{ role: "user", content: request.images?.length ? [
          { type: "input_text", text: untrustedUserMessage(request.untrustedSourceData) },
          ...request.images.flatMap(image => [{ type: "input_text", text: `Evidence image: ${image.sourceId}` }, { type: "input_image", image_url: image.dataUrl, detail: "auto" }]),
        ] : untrustedUserMessage(request.untrustedSourceData) }],
        ...(request.maxOutputTokens === null ? {} : { max_output_tokens: request.maxOutputTokens ?? 1_024 }),
        store: false,
        stream: false,
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
    let receipt: ModelResponseCheckpoint | undefined;
    const payload = await readResponsesPayload(response, undefined, async received => {
      receipt = modelReceipt({ providerId: this.providerId, modelKey: request.modelKey,
        requestId: response.headers.get("x-request-id"), payload: received, pricing: this.config.pricing });
      await request.onResponseCheckpoint?.(receipt);
    });
    if (!receipt) throw new Error("model_response_invalid");
    const value = parseStructuredOutput(payload, request.outputSchema);
    return {
      providerId: this.providerId,
      modelKey: request.modelKey,
      value,
      inputTokens: receipt.inputTokens ?? 0,
      outputTokens: receipt.outputTokens ?? 0,
      usageReported: receipt.inputTokens !== null && receipt.outputTokens !== null,
      tokenUsage: receipt.tokenUsage,
      costUsd: receipt.costUsd,
      providerRequestId: receipt.providerRequestId ?? undefined,
      completedAt: new Date(),
    };
  }

  async estimate<T>(request: ResolvedModelRequest<T>): Promise<CostEstimate> {
    const estimatedInputTokens = estimateTokens(request.systemInstructions) + estimateTokens(request.untrustedSourceData) + (request.images?.length ?? 0) * 4096;
    const maxOutputTokens = request.maxOutputTokens === null ? null : request.maxOutputTokens ?? 1_024;
    return {
      estimatedInputTokens,
      maxOutputTokens,
      costUsd: this.config.pricing && maxOutputTokens !== null ? calculateCostUsd(
        estimatedInputTokens,
        maxOutputTokens,
        this.config.pricing.inputUsdPerMillion,
        this.config.pricing.outputUsdPerMillion,
      ) : null,
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
