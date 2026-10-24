import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { type StudioPinnedResultRequest, type StudioResultIntent } from "@yummyai/contracts/pod/studio-original";
import { inspectStudioOriginalBytes } from "./studio-media-inspection.js";
import { assertStudioIntentTransition, parseStudioIntent } from "./studio-media-inspection-owner.js";
import { studioOriginalMedia } from "./studio-original-media.test-fixture.js";

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const request = (): StudioPinnedResultRequest => ({ operation: "result.submit.pinned", scope: createEntityId(), key: "image:synthetic-original",
  title: "Synthetic immutable source", submissionId: randomUUID(), sourceReference: "Synthetic original rights", rightsAttested: true,
  source: { entryId: createEntityId(), revision: 2, namespace: "image_files", assetId: createEntityId(), assetVersion: 1,
    checksumSha256: "a".repeat(64), mediaType: "image/png", byteSize: 500, sourceKind: "owned" } });
const prepared = (): StudioResultIntent => ({ version: 1, status: "prepared", request: request() });

describe("Studio original media facts", () => {
  it("fully decodes static originals and distinguishes encoded and EXIF display dimensions without rewriting bytes", async () => {
    const media = await studioOriginalMedia();
    for (const [bytes, type, orientation] of [[media.png, "image/png", 1], [media.jpeg, "image/jpeg", 6], [media.imageWebp, "image/webp", 1]] as const) {
      const original = sha(bytes), rotated = orientation === 6;
      expect(await inspectStudioOriginalBytes(bytes, type)).toEqual({ status: "verified", kind: "image", validation: "full_static_decode",
        encodedWidth: media.width, encodedHeight: media.height, displayWidth: rotated ? media.height : media.width,
        displayHeight: rotated ? media.width : media.height, orientation });
      expect(sha(bytes)).toBe(original);
    }
  });
  it("reads complete video and audio containers and packets with exact rotation and duration facts", async () => {
    const media = await studioOriginalMedia();
    for (const [bytes, type, kind, duration] of [[media.webm, "video/webm", "video", media.videoDuration],
      [media.mp4, "video/mp4", "video", media.videoDuration], [media.wav, "audio/wav", "audio", media.audioDuration],
      [media.mp3, "audio/mpeg", "audio", media.mp3Duration]] as const) {
      const original = sha(bytes), result = await inspectStudioOriginalBytes(bytes, type);
      expect(result).toMatchObject({ status: "verified", kind, validation: "container_and_packets", durationSeconds: duration });
      if (kind === "video") expect(result).toMatchObject({ encodedWidth: 64, encodedHeight: 48, rotation: type === "video/mp4" ? 90 : 0,
        displayWidth: type === "video/mp4" ? 48 : 64, displayHeight: type === "video/mp4" ? 64 : 48 });
      expect(sha(bytes)).toBe(original);
    }
  }, 15_000);
  it("rejects magic-only media rather than trusting declarations", async () => {
    for (const [type, signature, offset] of [["video/mp4", "ftyp", 4], ["video/webm", Buffer.from("1a45dfa3", "hex"), 0],
      ["audio/wav", "RIFF", 0], ["audio/mpeg", "ID3", 0]] as const) {
      const bytes = Buffer.alloc(64); Buffer.from(signature).copy(bytes, offset);
      expect((await inspectStudioOriginalBytes(bytes, type)).status).not.toBe("verified");
    }
  }, 15_000);
  it("rejects truncated originals even when a playback demuxer can recover their valid prefix", async () => {
    const media = await studioOriginalMedia();
    for (const [bytes, type, length] of [[media.png, "image/png", Math.floor(media.png.length / 2)], [media.jpeg, "image/jpeg", Math.floor(media.jpeg.length / 2)],
      [media.imageWebp, "image/webp", Math.floor(media.imageWebp.length / 2)], [media.webm, "video/webm", media.webm.length - 1],
      [media.mp4, "video/mp4", media.mp4.length - 1], [media.wav, "audio/wav", media.wav.length - 1], [media.mp3, "audio/mpeg", media.mp3.length - 1]] as const)
      expect((await inspectStudioOriginalBytes(bytes.subarray(0, length), type)).status).not.toBe("verified");
  }, 15_000);
  it("keeps unsupported, mismatched and oversized sources explicit", async () => {
    const media = await studioOriginalMedia();
    expect(await inspectStudioOriginalBytes(media.png, "image/jpeg")).toEqual({ status: "failed", code: "media_type_mismatch" });
    expect(await inspectStudioOriginalBytes(media.png, "image/gif")).toEqual({ status: "unsupported", code: "unsupported_media" });
    expect(await inspectStudioOriginalBytes(new Uint8Array(20 * 1024 * 1024 + 1), "video/mp4")).toEqual({ status: "failed", code: "size_limit" });
    expect(await inspectStudioOriginalBytes(new Uint8Array(), "image/png")).toEqual({ status: "failed", code: "invalid_media" });
  });
});

describe("Studio original request intent identity", () => {
  it("requires an original prepared request and exact person-scope storage address", () => {
    const next = prepared(), key = `erp-result-v1:${next.request.source.entryId}:${next.request.source.revision}`;
    expect(() => assertStudioIntentTransition(undefined, next)).not.toThrow();
    expect(parseStudioIntent(next, next.request.scope, key)).toEqual(next);
    expect(() => parseStudioIntent(next, createEntityId(), key)).toThrow();
    expect(() => parseStudioIntent(next, next.request.scope, `${key}1`)).toThrow();
    expect(() => parseStudioIntent({ ...next, arbitrary: true }, next.request.scope, key)).toThrow();
    expect(() => assertStudioIntentTransition(undefined, { ...next, status: "unknown" })).toThrow();
  });
  it("does not delete, replace or downgrade a request with an uncertain result", () => {
    const original = prepared(), unknown: StudioResultIntent = { ...original, status: "unknown" };
    for (const previous of [original, unknown]) {
      expect(() => assertStudioIntentTransition(previous, undefined)).toThrow();
      expect(() => assertStudioIntentTransition(previous, { ...unknown, request: { ...unknown.request, submissionId: randomUUID() } })).toThrow();
      expect(() => assertStudioIntentTransition(previous, { ...unknown, request: { ...unknown.request, sourceReference: "Changed rights" } })).toThrow();
      expect(() => assertStudioIntentTransition(previous, unknown)).not.toThrow();
    }
    expect(() => assertStudioIntentTransition(unknown, original)).toThrow();
  });
  it("preserves a confirmed receipt and requires a distinct explicit request before reopening", () => {
    const original = prepared(), confirmed: StudioResultIntent = { ...original, status: "confirmed", receipt: {
      batchId: original.request.scope, candidateId: createEntityId(), versionId: createEntityId(), assetId: original.request.source.assetId, replayed: false } };
    expect(() => assertStudioIntentTransition(confirmed, confirmed)).not.toThrow();
    expect(() => assertStudioIntentTransition(confirmed, original)).toThrow();
    expect(() => assertStudioIntentTransition(confirmed, { ...original, request: { ...original.request, title: "Changed title" } })).toThrow();
    expect(() => assertStudioIntentTransition(confirmed, { ...original, request: { ...original.request, submissionId: randomUUID() } })).not.toThrow();
    expect(() => assertStudioIntentTransition(confirmed, undefined)).not.toThrow();
  });
});
