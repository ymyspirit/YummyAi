import type { z } from "zod";

export interface ModelRequest<T> {
  modelKey: string;
  taskType: string;
  systemInstructions: string;
  untrustedSourceData: unknown;
  outputSchema: z.ZodType<T>;
  outputSchemaName?: string;
  maxCostUsd: number;
  maxOutputTokens?: number;
}

export interface ResolvedModelRequest<T> extends ModelRequest<T> {
  providerModel: string;
}

export interface ModelResult<T> {
  providerId: string;
  modelKey: string;
  value: T;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  providerRequestId?: string;
  completedAt: Date;
}

export interface CostEstimate {
  costUsd: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export interface ProviderHealth {
  available: boolean;
  checkedAt: Date;
  message?: string;
}

export interface ModelProvider {
  readonly providerId: string;
  generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal): Promise<ModelResult<T>>;
  estimate<T>(request: ResolvedModelRequest<T>): Promise<CostEstimate>;
  healthCheck(): Promise<ProviderHealth>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    readonly providerRequestId?: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class ProviderTimeoutError extends ProviderError {
  constructor(providerId: string, timeoutMs: number) {
    super(`Provider ${providerId} timed out after ${timeoutMs}ms`, providerId, true, 408);
    this.name = "ProviderTimeoutError";
  }
}

export class ModelExecutionCancelledError extends Error {
  constructor() {
    super("Model execution was cancelled");
    this.name = "ModelExecutionCancelledError";
  }
}

export function isRetryableProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError && error.retryable;
}

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.max(1, Math.ceil((text?.length ?? 0) / 4));
}

export function calculateCostUsd(
  inputTokens: number,
  outputTokens: number,
  inputUsdPerMillion: number,
  outputUsdPerMillion: number,
): number {
  return (inputTokens * inputUsdPerMillion + outputTokens * outputUsdPerMillion) / 1_000_000;
}
