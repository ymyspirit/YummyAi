import type { SecretVault } from "@yummyai/ai-core";
import { PodInvocationReceiptSchema, type PodInvocationReceipt } from "@yummyai/contracts/harness";
import { CreativeResponseArchiveSchema, POD_MAX_RESPONSE_BYTES } from "@yummyai/contracts/harness/creative-response";
import { decodePodResponse, hashPodResponse, parseCreativeResponse, type PodArtworkExecutionResult } from "@yummyai/pod-core";
import type { ClamAvScanner } from "@yummyai/storage";
import { isDeepStrictEqual } from "node:util";
import sharp from "sharp";

type CandidateRasterMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/tiff";

export type CreativeCandidateOriginalArchivePin = {
  tenantId: string;
  executionId: string;
  inputFingerprint: string;
  responseObjectKey: string;
  encryptedChecksum: string;
  responseChecksum: string;
  receipt: PodInvocationReceipt;
};

export type InspectedOriginalCandidateResponse = {
  bytes: Uint8Array;
  mediaType: CandidateRasterMediaType;
  checksumSha256: string;
  /** Encoded dimensions of one page/frame; the original is never auto-oriented. */
  width: number;
  height: number;
  modelKey: string;
  modelVersion: string;
  seed: string | null;
  qualityCheckSnapshot: Record<string, unknown>;
  outputMetadata: Record<string, unknown>;
};

const MAX_ENCRYPTED_BYTES = 2 * POD_MAX_RESPONSE_BYTES;
const MAX_PIXELS = 64_000_000;
const formats = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/tiff": "tiff" } as const;
const extensions = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/tiff": "tiff" } as const;
type FailureCode = "CREATIVE_RESPONSE_ADOPTION_INVALID" | "CREATIVE_RESPONSE_ADOPTION_TOO_LARGE"
  | "CREATIVE_RESPONSE_ADOPTION_SCAN_FAILED" | "CREATIVE_RESPONSE_ADOPTION_ABORTED";

class OriginalResponseError extends Error {
  constructor(readonly code: FailureCode) { super(code); this.name = "CreativeCandidateOriginalResponseError"; }
}

function active(signal?: AbortSignal) {
  if (signal?.aborted) throw new OriginalResponseError("CREATIVE_RESPONSE_ADOPTION_ABORTED");
}
function invalid(): never { throw new OriginalResponseError("CREATIVE_RESPONSE_ADOPTION_INVALID"); }
function isRaster(value: string): value is CandidateRasterMediaType { return Object.hasOwn(formats, value); }

/** The original structured-result receipt hashes JSON property order, before
 * schema defaults or parsing reorder the object. Decode has already validated
 * every output; retain the original JSON representation for that exact hash. */
export function structuredResultChecksum(rawBody: string, decoded: PodArtworkExecutionResult) {
  const original = JSON.parse(rawBody) as { outputs: Array<Record<string, unknown>> } & Record<string, unknown>;
  const summary = { ...original, outputs: original.outputs.map((output, index) => {
    const metadata = Object.fromEntries(Object.entries(output).filter(([key]) => key !== "dataBase64"));
    const bytes = decoded.outputs[index]!.bytes;
    return { ...metadata, byteSize: bytes.byteLength, sha256: hashPodResponse(bytes) };
  }) };
  return hashPodResponse(JSON.stringify(summary));
}

/** Inspects bytes supplied by the authorized owner. Authorization, expiry,
 * immutable source rechecks and every database/storage write stay with it. */
export async function inspectOriginalCandidateResponse(input: {
  pin: CreativeCandidateOriginalArchivePin;
  encryptedBytes: Uint8Array;
  vault: Pick<SecretVault, "withSecret">;
  scanner: Pick<ClamAvScanner, "scan">;
  signal?: AbortSignal;
}): Promise<InspectedOriginalCandidateResponse> {
  const { encryptedBytes, vault, scanner, signal } = input;
  active(signal);
  try {
    // Reject an oversized read before hashing or allocating a decoded string.
    if (encryptedBytes.byteLength > MAX_ENCRYPTED_BYTES)
      throw new OriginalResponseError("CREATIVE_RESPONSE_ADOPTION_TOO_LARGE");
    if (!encryptedBytes.byteLength) invalid();
    const pin = { ...input.pin, receipt: PodInvocationReceiptSchema.parse(input.pin.receipt) };
    if (!/^[a-f0-9]{64}$/.test(pin.encryptedChecksum) || !/^[a-f0-9]{64}$/.test(pin.responseChecksum)
      || pin.receipt.responseChecksum !== pin.responseChecksum
      || pin.responseObjectKey !== `tenants/${pin.tenantId}/quarantine/${pin.encryptedChecksum}/${pin.executionId}-pod-response.pe`
      || hashPodResponse(encryptedBytes) !== pin.encryptedChecksum) invalid();
    active(signal);
    const encrypted = new TextDecoder("utf-8", { fatal: true }).decode(encryptedBytes);
    const raw: unknown = vault.withSecret(encrypted, plaintext => {
      active(signal);
      if (Buffer.byteLength(plaintext) > MAX_ENCRYPTED_BYTES)
        throw new OriginalResponseError("CREATIVE_RESPONSE_ADOPTION_TOO_LARGE");
      return JSON.parse(plaintext) as unknown;
    });
    active(signal);
    const archive = CreativeResponseArchiveSchema.parse(raw);
    if (archive.tenantId !== pin.tenantId || archive.executionId !== pin.executionId || archive.inputFingerprint !== pin.inputFingerprint) invalid();
    const response = parseCreativeResponse(archive.response);
    if (response.kind !== "pod" || !isDeepStrictEqual(response.checkpoint.receipt, pin.receipt)) invalid();
    const checkpoint = response.checkpoint;
    const decoded = decodePodResponse(checkpoint);
    if (checkpoint.kind === "result" && structuredResultChecksum(checkpoint.rawBody, decoded) !== pin.responseChecksum) invalid();
    if (decoded.modelKey !== pin.receipt.modelKey || decoded.modelVersion !== pin.receipt.modelVersion) invalid();
    active(signal);

    // Match the existing candidate owner's first-supported-raster selection.
    const output = decoded.outputs.find(item => isRaster(item.mediaType));
    if (!output || !isRaster(output.mediaType)) invalid();
    const mediaType = output.mediaType, bytes = output.bytes;
    const raster = sharp(bytes, { limitInputPixels: MAX_PIXELS, failOn: "error", pages: -1 });
    let width: number, height: number;
    try {
      const metadata = await raster.metadata();
      active(signal);
      const pages = metadata.pages ?? 1;
      width = metadata.width!;
      height = pages > 1 ? metadata.pageHeight! : metadata.height!;
      if (metadata.format !== formats[mediaType] || !Number.isSafeInteger(width) || width < 1
        || !Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(pages) || pages < 1) invalid();
      const pixels = width * height * pages;
      if (!Number.isSafeInteger(pixels) || pixels > MAX_PIXELS)
        throw new OriginalResponseError("CREATIVE_RESPONSE_ADOPTION_TOO_LARGE");
      // Metadata alone cannot prove that compressed pixels actually decode.
      await raster.stats();
      active(signal);
    } finally { raster.destroy(); }
    const checksumSha256 = hashPodResponse(bytes);
    active(signal);
    try {
      const scan = await scanner.scan({ body: bytes, fileName: `${pin.executionId}-pod-response-original.${extensions[mediaType]}`, mediaType });
      active(signal);
      if (scan.result !== "clean") throw new OriginalResponseError("CREATIVE_RESPONSE_ADOPTION_SCAN_FAILED");
    } catch (cause) {
      active(signal);
      if (cause instanceof OriginalResponseError) throw cause;
      throw new OriginalResponseError("CREATIVE_RESPONSE_ADOPTION_SCAN_FAILED");
    }
    if (hashPodResponse(bytes) !== checksumSha256) invalid();
    active(signal);
    return { bytes, mediaType, checksumSha256, width, height, modelKey: decoded.modelKey, modelVersion: decoded.modelVersion,
      seed: decoded.seed ?? null, qualityCheckSnapshot: structuredClone(decoded.qualityCheckSnapshot), outputMetadata: structuredClone(output.metadata) };
  } catch (cause) {
    active(signal);
    if (cause instanceof OriginalResponseError) throw cause;
    throw new OriginalResponseError("CREATIVE_RESPONSE_ADOPTION_INVALID");
  }
}
