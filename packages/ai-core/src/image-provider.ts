import type { CostEstimate, ProviderHealth } from "./provider.js";

export interface ImageModelRequest {
  modelKey: string;
  providerModel: string;
  prompt: string;
  referenceImages?: Array<{ bytes: Uint8Array; mimeType: string }>;
  maxCostUsd: number;
}

export interface GeneratedImageResult {
  providerId: string;
  modelKey: string;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  revisedPrompt?: string;
  providerRequestId?: string;
  costUsd: number;
}

export interface ImageModelProvider {
  readonly providerId: string;
  generateImage(request: ImageModelRequest, signal: AbortSignal): Promise<GeneratedImageResult>;
  estimateImage(request: ImageModelRequest): Promise<CostEstimate>;
  healthCheck(): Promise<ProviderHealth>;
}
