import { createHash } from "node:crypto";
import type { PodInvocationReceipt } from "@yummyai/contracts/harness";
import { podInvocationReceipt } from "./pod-invocation-receipt.js";
import { decodePodResponse, readBoundedPodResponse, type PodArtworkResponseCheckpoint } from "./pod-artwork-response.js";

import type {
  PodArtworkExecutionRecord,
  PodArtworkExecutionResult,
  PodArtworkGateway,
} from "./pod-artwork.processor.js";

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
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 50 * 1024 * 1024) throw new Error("POD output limit must be between 1 byte and 50 MiB");
    if (!deploymentId.trim() || deploymentId.length > 160) throw new Error("POD processor deployment identity is invalid");
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
    onReceipt?: (receipt: PodInvocationReceipt, checkpoint?: PodArtworkResponseCheckpoint) => Promise<void>,
  ): Promise<PodArtworkExecutionResult> {
    const response = await this.request(this.endpoint, {
      method: "POST",
      signal: AbortSignal.any([signal, AbortSignal.timeout(240_000)]),
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
    const raw = await readBoundedPodResponse(response);
    let data: unknown;
    try { data = JSON.parse(raw); } catch { data = null; }
    const receipt = podInvocationReceipt(data, createHash("sha256").update(raw).digest("hex"), response.headers.get("x-request-id"));
    const checkpoint: PodArtworkResponseCheckpoint = {
      version: "pod-response-checkpoint-v1", kind: "http", rawBody: raw,
      status: response.status, deploymentId: this.deploymentId, maxOutputBytes: this.maxOutputBytes, receipt,
    };
    if (onReceipt) await onReceipt(receipt, checkpoint);
    return decodePodResponse(checkpoint);
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
