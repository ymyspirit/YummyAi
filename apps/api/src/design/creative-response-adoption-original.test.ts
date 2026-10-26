import { createHash } from "node:crypto";
import { SecretVault } from "@yummyai/ai-core";
import type { PodInvocationReceipt } from "@yummyai/contracts/harness";
import { POD_MAX_RESPONSE_BYTES, type PodArtworkResponseCheckpoint } from "@yummyai/contracts/harness/creative-response";
import { podResultCheckpoint, type PodArtworkExecutionResult } from "@yummyai/pod-core";
import type { ClamAvScanner } from "@yummyai/storage";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { inspectOriginalCandidateResponse, type CreativeCandidateOriginalArchivePin } from "./creative-response-adoption-original.js";

const tenantId = "019f0000-0000-7000-8000-000000000001";
const executionId = "019f0000-0000-7000-8000-000000000002";
const otherId = "019f0000-0000-7000-8000-000000000003";
const fingerprint = "a".repeat(64);
const sha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const clean = () => ({ result: "clean" as const, engine: "synthetic-test-scanner", signatureVersion: "fixture", scannedAt: "2026-10-24T00:00:00.000Z" });
const scanner = () => ({ scan: vi.fn<ClamAvScanner["scan"]>().mockResolvedValue(clean()) });
const mediaFormats = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp", "image/tiff": "tiff" } as const;
type RasterType = keyof typeof mediaFormats;
const imageCache = new Map<RasterType, Promise<Buffer>>();
function image(mediaType: RasterType) {
  let value = imageCache.get(mediaType);
  if (!value) {
    const encoder = sharp({ create: { width: 7, height: 5, channels: 4, background: { r: 21, g: 94, b: 183, alpha: 0.8 } } });
    value = (mediaType === "image/tiff" ? encoder.tiff({ compression: "lzw" }) : encoder.toFormat(mediaFormats[mediaType])).toBuffer();
    imageCache.set(mediaType, value);
  }
  return value;
}

function encoded(archive: unknown, receipt: PodInvocationReceipt, vault: SecretVault) {
  const encryptedBytes = Buffer.from(vault.encrypt(JSON.stringify(archive)));
  const encryptedChecksum = sha(encryptedBytes);
  const pin: CreativeCandidateOriginalArchivePin = { tenantId, executionId, inputFingerprint: fingerprint,
    responseObjectKey: `tenants/${tenantId}/quarantine/${encryptedChecksum}/${executionId}-pod-response.pe`,
    encryptedChecksum, responseChecksum: receipt.responseChecksum, receipt: structuredClone(receipt) };
  return { encryptedBytes, pin };
}

async function fixture(options: { kind?: "http" | "result"; mediaType?: RasterType; bytes?: Uint8Array; omitPartial?: boolean } = {}) {
  const mediaType = options.mediaType ?? "image/png", bytes = options.bytes ?? await image(mediaType);
  const metadata = { width: 700, height: 500, unit: "px" as const, colorMode: "rgb" as const, transparent: true, aiInference: "full" as const };
  const qualityCheckSnapshot = { providerCheck: "not an approval", marker: { z: 2, a: 1 } };
  // Intentionally differ from schema declaration order. These are real original
  // JSON properties, not the order/defaults introduced by decodePodResponse.
  const output = { metadata, fileName: "original-raster", role: "effect" as const, mediaType, bytes };
  const result = { modelVersion: "original-v3", outputs: [output], modelKey: "original-image-model", qualityCheckSnapshot,
    ...(options.omitPartial ? {} : { partial: false }), seed: "seed-17", costUsd: 0.01234567 };
  const structuredSummary = { modelVersion: "original-v3", outputs: [{ metadata, fileName: "original-raster", role: "effect", mediaType,
    byteSize: bytes.byteLength, sha256: sha(bytes) }], modelKey: "original-image-model", qualityCheckSnapshot,
    ...(options.omitPartial ? {} : { partial: false }), seed: "seed-17", costUsd: 0.01234567 };
  const rawBody = JSON.stringify({ ...result, outputs: [{ ...output, bytes: undefined, dataBase64: Buffer.from(bytes).toString("base64") }] });
  const kind = options.kind ?? "http";
  const receipt: PodInvocationReceipt = { version: "pod-response-v1", responseChecksum: kind === "http" ? sha(rawBody) : sha(JSON.stringify(structuredSummary)),
    providerRequestId: "original-request", modelKey: result.modelKey, modelVersion: result.modelVersion, costUsd: "0.01234567",
    metadataValid: true, receivedAt: "2026-10-24T00:00:00.000Z" };
  const checkpoint: PodArtworkResponseCheckpoint = kind === "result"
    ? podResultCheckpoint(result as PodArtworkExecutionResult, receipt)
    : { version: "pod-response-checkpoint-v1", kind, rawBody, status: 201, deploymentId: "original-deployment",
      maxOutputBytes: 50 * 1024 * 1024, receipt };
  const archive = { version: 1 as const, tenantId, executionId, inputFingerprint: fingerprint,
    response: { version: "creative-response-v1" as const, kind: "pod" as const, checkpoint } };
  const vault = new SecretVault(Buffer.alloc(32, 59));
  return { archive, vault, bytes, ...encoded(archive, receipt, vault) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function rebuild(value: Fixture, archive: unknown) { return { ...value, ...encoded(archive, value.pin.receipt, value.vault) }; }
function rewriteHttp(value: Fixture, change: (payload: Record<string, unknown>) => void, receiptPatch: Partial<PodInvocationReceipt> = {}) {
  const payload = JSON.parse(value.archive.response.checkpoint.rawBody) as Record<string, unknown>;
  change(payload);
  const rawBody = JSON.stringify(payload), receipt = { ...value.pin.receipt, responseChecksum: sha(rawBody), ...receiptPatch };
  const archive = { ...value.archive, response: { ...value.archive.response,
    checkpoint: { ...value.archive.response.checkpoint, rawBody, receipt } } };
  return { ...value, archive, ...encoded(archive, receipt, value.vault) };
}

describe("original creative candidate response inspection", () => {
  it.each(Object.keys(mediaFormats) as RasterType[])("decodes and scans the exact %s original without trusting declared dimensions", async mediaType => {
    const value = await fixture({ mediaType }), scan = scanner();
    const before = Buffer.from(value.encryptedBytes), pin = structuredClone(value.pin);
    Object.freeze(value.pin.receipt); Object.freeze(value.pin);
    const result = await inspectOriginalCandidateResponse({ ...value, scanner: scan });
    expect(result).toEqual({ bytes: Uint8Array.from(value.bytes), mediaType, checksumSha256: sha(value.bytes), width: 7, height: 5,
      modelKey: "original-image-model", modelVersion: "original-v3", seed: "seed-17",
      qualityCheckSnapshot: { ...JSON.parse(value.archive.response.checkpoint.rawBody).qualityCheckSnapshot,
        processorDeploymentId: "original-deployment" },
      outputMetadata: JSON.parse(value.archive.response.checkpoint.rawBody).outputs[0].metadata });
    expect(Buffer.from(result.bytes).equals(Buffer.from(value.bytes))).toBe(true);
    expect(value.encryptedBytes).toEqual(before); expect(value.pin).toEqual(pin);
    expect(scan.scan).toHaveBeenCalledOnce();
    const scanned = scan.scan.mock.calls[0]![0];
    expect(scanned.mediaType).toBe(mediaType);
    expect(Buffer.from(scanned.body)).toEqual(value.bytes);
  });

  it.each([false, true])("validates original structured-result ordering and omitted defaults (omitPartial=%s)", async omitPartial => {
    const value = await fixture({ kind: "result", omitPartial }), scan = scanner();
    const result = await inspectOriginalCandidateResponse({ ...value, scanner: scan });
    expect(result.checksumSha256).toBe(sha(value.bytes)); expect(result.modelKey).toBe(value.pin.receipt.modelKey);
    expect(result.qualityCheckSnapshot).toEqual(JSON.parse(value.archive.response.checkpoint.rawBody).qualityCheckSnapshot);
    expect(result.qualityCheckSnapshot).not.toHaveProperty("processorDeploymentId");
  });

  it("retains encoded EXIF dimensions and the full JPEG original", async () => {
    const bytes = await sharp(await image("image/png")).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const value = await fixture({ mediaType: "image/jpeg", bytes });
    const result = await inspectOriginalCandidateResponse({ ...value, scanner: scanner() });
    expect(result).toMatchObject({ width: 7, height: 5, mediaType: "image/jpeg", checksumSha256: sha(bytes) });
    expect(Buffer.from(result.bytes).equals(bytes)).toBe(true);
  });

  it("selects the same first supported raster as the original candidate owner", async () => {
    const value = rewriteHttp(await fixture(), payload => {
      const outputs = payload.outputs as unknown[];
      payload.outputs = [{ dataBase64: Buffer.from("original note").toString("base64"), mediaType: "text/plain", role: "effect", fileName: "note.txt", metadata: { aiInference: "none" } }, ...outputs];
    });
    const scan = scanner(), result = await inspectOriginalCandidateResponse({ ...value, scanner: scan });
    expect(result.checksumSha256).toBe(sha(value.bytes)); expect(scan.scan).toHaveBeenCalledOnce();
  });

  it("uses explicit receipt model evidence even when metadataValid is false", async () => {
    const value = rewriteHttp(await fixture(), () => {}, { metadataValid: false });
    expect(await inspectOriginalCandidateResponse({ ...value, scanner: scanner() })).toMatchObject({ modelKey: "original-image-model" });
  });

  it.each(["modelKey", "modelVersion"] as const)("rejects a receipt with a different %s even when metadataValid is true", async key => {
    const value = rewriteHttp(await fixture(), () => {}, { [key]: "a-different-original", metadataValid: true }), scan = scanner();
    await expect(inspectOriginalCandidateResponse({ ...value, scanner: scan })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
    expect(scan.scan).not.toHaveBeenCalled();
  });

  it.each(["modelKey", "modelVersion"] as const)("rejects missing receipt %s rather than treating metadataValid as proof", async key => {
    const value = rewriteHttp(await fixture(), () => {}, { [key]: null, metadataValid: false });
    await expect(inspectOriginalCandidateResponse({ ...value, scanner: scanner() })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
  });

  it("returns a missing seed as null without changing the original receipt", async () => {
    const value = rewriteHttp(await fixture(), payload => { delete payload.seed; }), before = structuredClone(value.pin.receipt);
    expect((await inspectOriginalCandidateResponse({ ...value, scanner: scanner() })).seed).toBeNull();
    expect(value.pin.receipt).toEqual(before);
  });

  it("checks the encrypted byte cap before decrypting or scanning", async () => {
    const value = await fixture(), scan = scanner(), withSecret = vi.spyOn(value.vault, "withSecret");
    const oversized = new Uint8Array(2 * POD_MAX_RESPONSE_BYTES + 1);
    await expect(inspectOriginalCandidateResponse({ ...value, encryptedBytes: oversized, scanner: scan })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_TOO_LARGE");
    expect(withSecret).not.toHaveBeenCalled(); expect(scan.scan).not.toHaveBeenCalled();
  });

  it.each(["empty", "tampered", "wrong-key", "wrong-response-sha"])("rejects %s original bytes/pins before decrypting", async mode => {
    const value = await fixture(), scan = scanner(), withSecret = vi.spyOn(value.vault, "withSecret");
    const input = { ...value, scanner: scan, pin: { ...value.pin } };
    if (mode === "empty") input.encryptedBytes = Buffer.alloc(0);
    if (mode === "tampered") { input.encryptedBytes = Buffer.from(value.encryptedBytes); input.encryptedBytes[5] ^= 1; }
    if (mode === "wrong-key") input.pin.responseObjectKey = input.pin.responseObjectKey.replace("/quarantine/", "/authorized/");
    if (mode === "wrong-response-sha") input.pin.responseChecksum = "b".repeat(64);
    await expect(inspectOriginalCandidateResponse(input)).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
    expect(withSecret).not.toHaveBeenCalled(); expect(scan.scan).not.toHaveBeenCalled();
  });

  it("requires valid authenticated encryption after the ciphertext hash passes", async () => {
    const value = await fixture(), scan = scanner(), wrongVault = new SecretVault(Buffer.alloc(32, 61));
    await expect(inspectOriginalCandidateResponse({ ...value, vault: wrongVault, scanner: scan })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
    expect(scan.scan).not.toHaveBeenCalled();
  });

  it.each(["tenantId", "executionId", "inputFingerprint", "extra-field"])("rejects an archive with changed %s", async field => {
    const value = await fixture(), archive = structuredClone(value.archive) as Record<string, unknown>;
    archive[field] = field === "inputFingerprint" ? "b".repeat(64) : field === "extra-field" ? "untrusted" : otherId;
    const scan = scanner();
    await expect(inspectOriginalCandidateResponse({ ...rebuild(value, archive), scanner: scan })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
    expect(scan.scan).not.toHaveBeenCalled();
  });

  it.each(["providerRequestId", "costUsd", "receivedAt", "metadataValid"] as const)("requires the entire original receipt, including %s", async key => {
    const value = await fixture(), archive = structuredClone(value.archive);
    const receipt = archive.response.checkpoint.receipt;
    if (key === "providerRequestId") receipt.providerRequestId = "another-request";
    if (key === "costUsd") receipt.costUsd = "0.00000000";
    if (key === "receivedAt") receipt.receivedAt = "2026-10-24T00:00:01.000Z";
    if (key === "metadataValid") receipt.metadataValid = false;
    await expect(inspectOriginalCandidateResponse({ ...rebuild(value, archive), scanner: scanner() })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
  });

  it.each(["local", "studio"])("does not adopt the unrelated %s response format", async kind => {
    const value = await fixture();
    const response = kind === "local" ? { version: "creative-response-v1", kind, outputs: [], result: {} }
      : { version: "creative-response-v1", kind, receipt: value.pin.receipt, providerTaskId: null, text: "original text", outputs: [] };
    await expect(inspectOriginalCandidateResponse({ ...rebuild(value, { ...value.archive, response }), scanner: scanner() })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
  });

  it.each([199, 300, 401, 500])("retains HTTP %s as evidence but refuses to adopt it as a successful response", async status => {
    const value = await fixture(), archive = structuredClone(value.archive); archive.response.checkpoint.status = status;
    const scan = scanner();
    await expect(inspectOriginalCandidateResponse({ ...rebuild(value, archive), scanner: scan })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
    expect(scan.scan).not.toHaveBeenCalled();
  });

  it("rejects changed HTTP bytes even when they still parse to the same JSON", async () => {
    const value = await fixture(), archive = structuredClone(value.archive); archive.response.checkpoint.rawBody += "\n";
    await expect(inspectOriginalCandidateResponse({ ...rebuild(value, archive), scanner: scanner() })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
  });

  it("rejects a changed structured result instead of trusting its unchanged receipt checksum", async () => {
    const value = await fixture({ kind: "result" }), archive = structuredClone(value.archive);
    const payload = JSON.parse(archive.response.checkpoint.rawBody); payload.seed = "replaced-seed";
    archive.response.checkpoint.rawBody = JSON.stringify(payload);
    await expect(inspectOriginalCandidateResponse({ ...rebuild(value, archive), scanner: scanner() })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
  });

  it.each(["deploymentId", "maxOutputBytes"] as const)("never fills in missing original checkpoint %s", async key => {
    const value = await fixture(), archive = structuredClone(value.archive);
    delete (archive.response.checkpoint as Partial<PodArtworkResponseCheckpoint>)[key];
    await expect(inspectOriginalCandidateResponse({ ...rebuild(value, archive), scanner: scanner() })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
  });

  it("uses the recorded output byte ceiling", async () => {
    const value = await fixture(), archive = structuredClone(value.archive); archive.response.checkpoint.maxOutputBytes = value.bytes.byteLength - 1;
    await expect(inspectOriginalCandidateResponse({ ...rebuild(value, archive), scanner: scanner() })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
  });

  it("rejects invalid base64 before interpreting image bytes", async () => {
    const value = rewriteHttp(await fixture(), payload => {
      const outputs = payload.outputs as Array<Record<string, unknown>>; outputs[0]!.dataBase64 = "not base64";
    });
    const scan = scanner();
    await expect(inspectOriginalCandidateResponse({ ...value, scanner: scan })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
    expect(scan.scan).not.toHaveBeenCalled();
  });

  it.each(["declared-jpeg", "truncated-png", "header-only", "no-raster"])("rejects %s rather than accepting MIME or metadata as image evidence", async mode => {
    let value = await fixture();
    if (mode === "declared-jpeg") value = await fixture({ mediaType: "image/jpeg", bytes: await image("image/png") });
    if (mode === "truncated-png") value = await fixture({ bytes: (await image("image/png")).subarray(0, 45) });
    if (mode === "header-only") value = await fixture({ bytes: Buffer.from("89504e470d0a1a0a", "hex") });
    if (mode === "no-raster") value = rewriteHttp(value, payload => {
      payload.outputs = [{ dataBase64: Buffer.from("original text").toString("base64"), mediaType: "text/plain", role: "effect", fileName: "original.txt", metadata: { aiInference: "none" } }];
    });
    const scan = scanner();
    await expect(inspectOriginalCandidateResponse({ ...value, scanner: scan })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
    expect(scan.scan).not.toHaveBeenCalled();
  });

  it("refuses a raster header exceeding 64 million pixels before scanning", async () => {
    const bytes = Buffer.from(await image("image/png")); bytes.writeUInt32BE(8_001, 16); bytes.writeUInt32BE(8_000, 20);
    let crc = 0xffff_ffff;
    for (const byte of bytes.subarray(12, 29)) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1; }
    bytes.writeUInt32BE((crc ^ 0xffff_ffff) >>> 0, 29);
    const value = await fixture({ bytes }), scan = scanner();
    await expect(inspectOriginalCandidateResponse({ ...value, scanner: scan })).rejects.toMatchObject({ code: expect.stringMatching(/^CREATIVE_RESPONSE_ADOPTION_(INVALID|TOO_LARGE)$/) });
    expect(scan.scan).not.toHaveBeenCalled();
  });

  it.each(["infected", "failed"] as const)("does not adopt a scan with result %s", async result => {
    const value = await fixture(), scan = { scan: vi.fn(async () => ({ ...clean(), result })) };
    await expect(inspectOriginalCandidateResponse({ ...value, scanner: scan })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_SCAN_FAILED");
  });

  it("does not return image bytes modified by a scanner", async () => {
    const value = await fixture();
    const scan = { async scan({ body }: { body: Uint8Array }) { body[0] ^= 1; return clean(); } };
    await expect(inspectOriginalCandidateResponse({ ...value, scanner: scan })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_INVALID");
  });

  it.each(["vault", "scanner"])("does not expose raw %s exceptions", async stage => {
    const value = await fixture(), privateMessage = "private-provider-body credential=synthetic-secret";
    const vault = stage === "vault" ? { withSecret() { throw new Error(privateMessage); } } : value.vault;
    const scan = stage === "scanner" ? { async scan() { throw new Error(privateMessage); } } : scanner();
    const error: unknown = await inspectOriginalCandidateResponse({ ...value, vault, scanner: scan }).catch(cause => cause);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected the original inspection to fail");
    expect(error.message).not.toContain(privateMessage);
    expect(error.message).toBe(stage === "vault" ? "CREATIVE_RESPONSE_ADOPTION_INVALID" : "CREATIVE_RESPONSE_ADOPTION_SCAN_FAILED");
  });

  it("refuses an already-aborted inspection without decrypting", async () => {
    const value = await fixture(), controller = new AbortController(), scan = scanner(); controller.abort(new Error("private abort reason"));
    const withSecret = vi.spyOn(value.vault, "withSecret");
    await expect(inspectOriginalCandidateResponse({ ...value, scanner: scan, signal: controller.signal })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_ABORTED");
    expect(withSecret).not.toHaveBeenCalled(); expect(scan.scan).not.toHaveBeenCalled();
  });

  it("rechecks cancellation after decrypting and after scanning", async () => {
    for (const stage of ["vault", "scanner"] as const) {
      const value = await fixture(), controller = new AbortController();
      const vault = { withSecret<T>(encrypted: string, callback: (plaintext: string) => T): T {
        return value.vault.withSecret(encrypted, plaintext => { const result = callback(plaintext); if (stage === "vault") controller.abort(); return result; });
      } };
      const scan = { scan: vi.fn(async () => { if (stage === "scanner") controller.abort(); return clean(); }) };
      await expect(inspectOriginalCandidateResponse({ ...value, vault, scanner: scan, signal: controller.signal })).rejects.toThrow("CREATIVE_RESPONSE_ADOPTION_ABORTED");
      if (stage === "vault") expect(scan.scan).not.toHaveBeenCalled(); else expect(scan.scan).toHaveBeenCalledOnce();
    }
  });
});
