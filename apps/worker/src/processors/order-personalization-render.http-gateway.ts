import { z } from "zod";

import type { PodArtworkExecutionResult } from "./pod-artwork.processor.js";
import type {
  OrderPersonalizationRenderExecutionRecord,
  OrderPersonalizationRenderGateway,
} from "./order-personalization-render.processor.js";

const ResponseSchema = z.object({
  outputs: z.array(z.object({
    dataBase64: z.string().min(1),
    mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/tiff", "image/svg+xml"]),
    role: z.enum(["effect", "production"]),
    fileName: z.string().trim().min(1).max(180),
    metadata: z.object({
      width: z.number().positive().finite(),
      height: z.number().positive().finite(),
      unit: z.enum(["px", "mm", "in"]),
      dpi: z.number().positive().finite().max(2_400).optional(),
      colorMode: z.enum(["rgb", "cmyk", "grayscale", "spot"]),
      transparent: z.boolean(),
      aiInference: z.enum(["none", "partial", "full"]),
      inferenceRegions: z.array(z.object({
        x: z.number().finite(),
        y: z.number().finite(),
        width: z.number().positive().finite(),
        height: z.number().positive().finite(),
      }).strict()).max(1_000).optional(),
    }).strict().superRefine((metadata, context) => {
      if (metadata.aiInference === "partial" && !metadata.inferenceRegions?.length) {
        context.addIssue({ code: "custom", path: ["inferenceRegions"], message: "Partial AI inference requires machine-readable regions" });
      }
    }),
  }).strict()).min(1).max(20),
  modelKey: z.string().trim().min(1).max(160),
  modelVersion: z.string().trim().min(1).max(160),
  seed: z.string().trim().min(1).max(160).optional(),
  qualityCheckSnapshot: z.record(z.string(), z.unknown()),
  partial: z.boolean().default(false),
}).strict();

export class HttpOrderPersonalizationRenderGateway implements OrderPersonalizationRenderGateway {
  private readonly endpoint: URL;

  constructor(
    endpoint: string,
    private readonly apiKey: string,
    private readonly deploymentId: string,
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
    private readonly maxOutputBytes = 50 * 1024 * 1024,
  ) {
    this.endpoint = secureUrl(endpoint);
    if (!apiKey.trim()) throw new Error("POD_ORDER_PROCESSOR_API_KEY is required");
    if (!deploymentId.trim()) throw new Error("POD_ORDER_PROCESSOR_DEPLOYMENT_ID is required");
  }

  static fromEnvironment() {
    return new HttpOrderPersonalizationRenderGateway(
      required("POD_ORDER_PROCESSOR_URL"),
      required("POD_ORDER_PROCESSOR_API_KEY"),
      required("POD_ORDER_PROCESSOR_DEPLOYMENT_ID"),
      globalThis.fetch,
      positiveInteger(process.env.POD_ORDER_PROCESSOR_MAX_OUTPUT_BYTES, 50 * 1024 * 1024),
    );
  }

  async execute(input: OrderPersonalizationRenderExecutionRecord, signal: AbortSignal): Promise<PodArtworkExecutionResult> {
    const response = await this.request(this.endpoint, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "x-yummyai-correlation-id": input.id,
        "x-yummyai-processor-deployment": this.deploymentId,
      },
      body: JSON.stringify({
        taskId: input.id,
        toolKey: input.toolKey,
        parameterSnapshot: input.parameterSnapshot,
        template: {
          versionId: input.resolution.templateVersionId,
          canvas: input.canvas,
          slots: input.slots,
          source: input.templateSource ? encodeAsset(input.templateSource) : undefined,
        },
        resolvedSlots: input.resolution.slots.map((slot) => slot.kind === "text" ? slot : {
          slotId: slot.slotId,
          stableKey: slot.stableKey,
          kind: slot.kind,
          assetId: slot.assetId,
        }),
        customerAssets: input.customerAssets.map(encodeAsset),
      }),
    });
    if (!response.ok) throw new Error(`Order personalization processor request failed (${response.status})`);
    const payload = ResponseSchema.parse(await response.json());
    const outputs = payload.outputs.map((output) => {
      const estimatedBytes = Math.floor(output.dataBase64.length * 0.75);
      if (estimatedBytes > this.maxOutputBytes) throw new Error("Order personalization processor output exceeds the configured byte limit");
      const bytes = Uint8Array.from(Buffer.from(output.dataBase64, "base64"));
      if (!bytes.byteLength || bytes.byteLength > this.maxOutputBytes) throw new Error("Order personalization processor output has an invalid byte size");
      return {
        bytes,
        mediaType: output.mediaType,
        role: output.role,
        fileName: output.fileName,
        metadata: output.metadata,
      };
    });
    return {
      outputs,
      modelKey: payload.modelKey,
      modelVersion: payload.modelVersion,
      seed: payload.seed,
      qualityCheckSnapshot: {
        ...payload.qualityCheckSnapshot,
        processorDeploymentId: this.deploymentId,
      },
      partial: payload.partial,
    };
  }
}

function encodeAsset(asset: OrderPersonalizationRenderExecutionRecord["customerAssets"][number]) {
  return {
    assetId: asset.id,
    version: asset.version,
    checksumSha256: asset.checksumSha256,
    mediaType: asset.mediaType,
    dataBase64: Buffer.from(asset.bytes).toString("base64"),
  };
}

function secureUrl(value: string) {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Order personalization processor URL must use HTTPS unless it is loopback-only");
  }
  if (url.username || url.password) throw new Error("Order personalization processor URL must not contain credentials");
  return url;
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("POD_ORDER_PROCESSOR_MAX_OUTPUT_BYTES must be a positive integer");
  return parsed;
}
