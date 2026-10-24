import { z } from "zod";
import { createHash } from "node:crypto";
import { PodInvocationReceiptSchema } from "@yummyai/contracts/harness";
import type { PodArtworkExecutionResult } from "./pod-artwork.processor.js";
import { PodProcessorResultV1Schema } from "@yummyai/contracts/pod/processor-result";

// The versioned processor result schema is independent of operator task views.

export const POD_MAX_RESPONSE_BYTES = 72 * 1024 * 1024;
export const PodArtworkResponseCheckpointSchema = z.object({
  version: z.literal("pod-response-checkpoint-v1"),
  kind: z.enum(["http", "result"]),
  rawBody: z.string().max(POD_MAX_RESPONSE_BYTES),
  status: z.int().min(100).max(599),
  deploymentId: z.string().min(1).max(160),
  maxOutputBytes: z.int().positive().max(50 * 1024 * 1024),
  receipt: PodInvocationReceiptSchema,
}).strict();
export type PodArtworkResponseCheckpoint = z.infer<typeof PodArtworkResponseCheckpointSchema>;

export class PodResponseInvalidError extends Error {
  constructor(message = "POD_RESPONSE_INVALID") { super(message); this.name = "PodResponseInvalidError"; }
}

export function decodePodResponse(rawCheckpoint: PodArtworkResponseCheckpoint): PodArtworkExecutionResult {
  try {
    const checkpoint = PodArtworkResponseCheckpointSchema.parse(rawCheckpoint);
    if (Buffer.byteLength(checkpoint.rawBody) > POD_MAX_RESPONSE_BYTES || checkpoint.status < 200 || checkpoint.status >= 300) throw new PodResponseInvalidError();
    if (checkpoint.kind === "http" && hashPodResponse(checkpoint.rawBody) !== checkpoint.receipt.responseChecksum) throw new PodResponseInvalidError();
    const payload = PodProcessorResultV1Schema.parse(JSON.parse(checkpoint.rawBody));
    let total = 0;
    const outputs = payload.outputs.map(output => {
      if (Math.floor(output.dataBase64.length * 0.75) > checkpoint.maxOutputBytes + 2) throw new PodResponseInvalidError("POD processor output exceeds the configured byte limit");
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output.dataBase64)) throw new PodResponseInvalidError();
      const bytes = Buffer.from(output.dataBase64, "base64");
      total += bytes.byteLength;
      if (!bytes.byteLength || total > checkpoint.maxOutputBytes) throw new PodResponseInvalidError("POD processor output exceeds the configured byte limit");
      return { bytes: Uint8Array.from(bytes), mediaType: output.mediaType, role: output.role, fileName: output.fileName, metadata: output.metadata };
    });
    return { ...payload, outputs, qualityCheckSnapshot: {
      ...payload.qualityCheckSnapshot,
      ...(checkpoint.kind === "http" ? { processorDeploymentId: checkpoint.deploymentId } : {}),
    } };
  } catch (error) {
    if (error instanceof Error && error.message.includes("exceeds the configured byte limit")) throw error;
    throw new PodResponseInvalidError();
  }
}

export function podResultCheckpoint(result: PodArtworkExecutionResult, receipt: PodArtworkResponseCheckpoint["receipt"]): PodArtworkResponseCheckpoint {
  const rawBody = JSON.stringify({ ...result, outputs: result.outputs.map(output => ({
    ...output, bytes: undefined, dataBase64: Buffer.from(output.bytes).toString("base64"),
  })) });
  if (Buffer.byteLength(rawBody) > POD_MAX_RESPONSE_BYTES) throw new PodResponseInvalidError();
  return { version: "pod-response-checkpoint-v1", kind: "result", rawBody, status: 200, deploymentId: "structured-result-checkpoint", maxOutputBytes: 50 * 1024 * 1024, receipt };
}

export const hashPodResponse = (raw: string | Uint8Array) => createHash("sha256").update(raw).digest("hex");

export async function readBoundedPodResponse(response: Response, limit = POD_MAX_RESPONSE_BYTES) {
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body?.cancel();
    throw new Error("POD_RESPONSE_TOO_LARGE");
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw new Error("POD_RESPONSE_TOO_LARGE");
      chunks.push(next.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
