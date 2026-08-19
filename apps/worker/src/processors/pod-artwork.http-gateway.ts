import { z } from "zod";

import type {
  PodArtworkExecutionRecord,
  PodArtworkExecutionResult,
  PodArtworkGateway,
} from "./pod-artwork.processor.js";

const ProcessorResponseSchema = z.object({
  outputs: z.array(z.object({
    dataBase64: z.string().min(1),
    mediaType: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/tiff",
      "image/svg+xml",
      "video/mp4",
      "application/zip",
      "application/postscript",
      "text/plain",
    ]),
    role: z.enum(["effect", "production"]),
    fileName: z.string().min(1).max(180),
    metadata: z.object({
      width: z.number().positive().finite().optional(),
      height: z.number().positive().finite().optional(),
      unit: z.enum(["px", "mm", "in"]).optional(),
      dpi: z.number().positive().finite().max(2_400).optional(),
      colorMode: z.enum(["rgb", "cmyk", "grayscale", "spot"]).optional(),
      transparent: z.boolean().optional(),
      durationSeconds: z.number().positive().max(60).optional(),
      fps: z.union([z.literal(24), z.literal(25), z.literal(30)]).optional(),
      videoCodec: z.literal("h264").optional(),
      audioCodec: z.enum(["none", "aac"]).optional(),
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
      if ([metadata.width, metadata.height, metadata.unit].filter((value) => value !== undefined).length % 3 !== 0) {
        context.addIssue({ code: "custom", path: ["width"], message: "Output dimensions require width, height, and unit together" });
      }
    }),
  }).strict().superRefine((output, context) => {
    const packaged = output.mediaType === "text/plain" || output.mediaType === "application/zip";
    if (!packaged && !output.metadata.width) {
      context.addIssue({ code: "custom", path: ["metadata", "width"], message: "Visual outputs require dimensions" });
    }
    if (!packaged && output.metadata.colorMode === undefined) {
      context.addIssue({ code: "custom", path: ["metadata", "colorMode"], message: "Visual outputs require a color mode" });
    }
    if (!packaged && output.metadata.transparent === undefined) {
      context.addIssue({ code: "custom", path: ["metadata", "transparent"], message: "Visual outputs require transparency metadata" });
    }
  })).min(1).max(100),
  modelKey: z.string().min(1).max(160),
  modelVersion: z.string().min(1).max(160),
  seed: z.string().min(1).max(160).optional(),
  costUsd: z.number().nonnegative().finite().optional(),
  qualityCheckSnapshot: z.record(z.string(), z.unknown()),
  partial: z.boolean().default(false),
}).strict();

export class HttpPodArtworkGateway implements PodArtworkGateway {
  private readonly endpoint: URL;

  constructor(
    endpoint: string,
    private readonly apiKey: string,
    private readonly request: typeof globalThis.fetch = globalThis.fetch,
    private readonly maxOutputBytes = 50 * 1024 * 1024,
    private readonly deploymentId = "untracked-local-processor",
  ) {
    this.endpoint = secureProcessorUrl(endpoint);
    if (!apiKey.trim()) throw new Error("POD_PROCESSOR_API_KEY is required");
  }

  static fromEnvironment() {
    return new HttpPodArtworkGateway(
      required("POD_PROCESSOR_URL"),
      required("POD_PROCESSOR_API_KEY"),
      globalThis.fetch,
      positiveInteger(process.env.POD_PROCESSOR_MAX_OUTPUT_BYTES, 50 * 1024 * 1024),
      required("POD_PROCESSOR_DEPLOYMENT_ID"),
    );
  }

  async execute(
    _context: { tenantId: string; userId: string },
    input: PodArtworkExecutionRecord,
    signal: AbortSignal,
  ): Promise<PodArtworkExecutionResult> {
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
        expectedModelKey: input.modelKey,
        inputs: input.inputAssets.map((asset) => ({
          assetId: asset.id,
          version: asset.version,
          checksumSha256: asset.checksumSha256,
          mediaType: asset.mediaType,
          dataBase64: Buffer.from(asset.bytes).toString("base64"),
        })),
      }),
    });
    if (!response.ok) throw new Error(`POD processor request failed (${response.status})`);
    const payload = ProcessorResponseSchema.parse(await response.json());
    const outputs = payload.outputs.map((output) => {
      const estimatedBytes = Math.floor(output.dataBase64.length * 0.75);
      if (estimatedBytes > this.maxOutputBytes) throw new Error("POD processor output exceeds the configured byte limit");
      const bytes = Uint8Array.from(Buffer.from(output.dataBase64, "base64"));
      if (!bytes.byteLength || bytes.byteLength > this.maxOutputBytes) throw new Error("POD processor output has an invalid byte size");
      return { ...output, bytes };
    });
    return {
      outputs: outputs.map((output) => ({
        bytes: output.bytes,
        mediaType: output.mediaType,
        role: output.role,
        fileName: output.fileName,
        metadata: output.metadata,
      })),
      modelKey: payload.modelKey,
      modelVersion: payload.modelVersion,
      seed: payload.seed,
      costUsd: payload.costUsd,
      qualityCheckSnapshot: {
        ...payload.qualityCheckSnapshot,
        processorDeploymentId: this.deploymentId,
      },
      partial: payload.partial,
    };
  }
}

function secureProcessorUrl(value: string) {
  const url = new URL(value);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("POD processor URL must use HTTPS unless it is loopback-only");
  }
  if (url.username || url.password) throw new Error("POD processor URL must not contain credentials");
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
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("POD_PROCESSOR_MAX_OUTPUT_BYTES must be a positive integer");
  return parsed;
}
