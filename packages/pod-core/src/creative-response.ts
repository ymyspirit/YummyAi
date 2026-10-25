import type { z } from "zod";
import { createHash } from "node:crypto";
import { PodProcessorResultV1Schema, type PodProcessorResultV1 } from "@yummyai/contracts/pod/processor-result";
import { CreativeResponseSchema, PodArtworkResponseCheckpointSchema, POD_MAX_RESPONSE_BYTES, type CreativeResponse, type PodArtworkResponseCheckpoint } from "@yummyai/contracts/harness/creative-response";
import type { CreativeResponseMediaTypeSchema as MediaType, CreativeLocalOutputSchema } from "@yummyai/contracts/harness/creative-response";
export * from "@yummyai/contracts/harness/creative-response";
export type PodArtworkExecutionResult = Omit<PodProcessorResultV1, "outputs"> & { outputs: Array<Omit<PodProcessorResultV1["outputs"][number], "dataBase64"> & { bytes: Uint8Array }> };

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

export type CreativeLocalOutput = { bytes: Uint8Array; mediaType: z.infer<typeof MediaType>; role: string };

export function creativeLocalResponse(outputs: CreativeLocalOutput[], result: Record<string, unknown>): CreativeResponse {
  return parseCreativeResponse({ version: "creative-response-v1", kind: "local", outputs: outputs.map(({ bytes, ...rest }) => ({ ...rest, dataBase64: Buffer.from(bytes).toString("base64") })), result });
}
export function parseCreativeResponse(raw: unknown) {
  const value = CreativeResponseSchema.parse(raw);
  if (Buffer.byteLength(JSON.stringify(value)) > POD_MAX_RESPONSE_BYTES) throw new Error("CREATIVE_RESPONSE_TOO_LARGE");
  if (value.kind !== "pod") decodeCreativeOutputs(value);
  return value;
}
export function decodeCreativeOutputs(response: { outputs: Array<z.infer<typeof CreativeLocalOutputSchema>> }): CreativeLocalOutput[] {
  let total = 0;
  return response.outputs.map(({ dataBase64, ...rest }) => {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) throw new Error("CREATIVE_RESPONSE_INVALID");
    const bytes = Buffer.from(dataBase64, "base64"); total += bytes.length;
    if (!bytes.length || total > 50 * 1024 * 1024) throw new Error("CREATIVE_RESPONSE_TOO_LARGE");
    return { ...rest, bytes };
  });
}
export function creativeResponseChecksum(response: CreativeResponse) {
  return response.kind === "pod" ? response.checkpoint.receipt.responseChecksum : response.kind === "studio" ? response.receipt.responseChecksum : hashPodResponse(JSON.stringify(response));
}
export const creativeMediaExtension: Record<z.infer<typeof MediaType>, string> = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/tiff": "tiff", "image/svg+xml": "svg",
  "video/mp4": "mp4", "video/webm": "webm", "application/json": "json", "application/zip": "zip", "application/postscript": "ps", "text/plain": "txt", "application/octet-stream": "bin",
};
