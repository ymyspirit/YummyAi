import { describe, expect, it } from "vitest";
import { StudioRpcSchema } from "./creative-studio.js";
import { StudioOriginalInspectionSchema, StudioOriginalPinSchema, StudioPinnedResultRequestSchema,
  StudioResultIntentSchema, StudioResultLookupSchema, studioResultIntentKey } from "./studio-original.js";

const id = (suffix: string) => `019a0000-0000-7000-8000-${suffix.padStart(12, "0")}`;
const source = { entryId: id("1"), revision: 3, namespace: "image_files", assetId: id("2"), assetVersion: 1,
  checksumSha256: "a".repeat(64), mediaType: "image/jpeg", byteSize: 250_000, sourceKind: "owned" };
const request = { operation: "result.submit.pinned", scope: id("3"), key: "original-image", title: "Synthetic original",
  submissionId: id("4"), sourceReference: "Synthetic owned image", rightsAttested: true, source };

describe("original Studio handoff contract", () => {
  it("pins an exact original entry version for submit and the same read-only lookup", () => {
    expect(StudioRpcSchema.safeParse(request).success).toBe(true);
    expect(StudioRpcSchema.safeParse({ ...request, operation: "result.lookup" }).success).toBe(true);
    for (const original of [{ ...source, entryId: undefined }, { ...source, assetVersion: 0 },
      { ...source, revision: 0 }, { ...source, checksumSha256: "abc" }, { ...source, namespace: "app_state" },
      { ...source, width: 800 }, { ...source, objectKey: "private/secret" }]) {
      expect(StudioOriginalPinSchema.safeParse(original).success).toBe(false);
    }
    expect(StudioPinnedResultRequestSchema.safeParse({ ...request, scope: "unassigned" }).success).toBe(false);
    expect(StudioRpcSchema.safeParse({ ...request, operation: "result.lookup", tenantId: id("5") }).success).toBe(false);
  });

  it("keeps coded dimensions, display orientation and media validation semantics distinct", () => {
    const technical = { status: "verified", kind: "image", encodedWidth: 1200, encodedHeight: 800,
      displayWidth: 800, displayHeight: 1200, orientation: 6, validation: "full_static_decode" };
    expect(StudioOriginalInspectionSchema.safeParse({ source, technical }).success).toBe(true);
    for (const changed of [{ ...technical, encodedWidth: 0 }, { ...technical, displayHeight: Infinity },
      { ...technical, orientation: 9 }, { ...technical, validation: "thumbnail" },
      { status: "unknown", code: "unavailable", displayWidth: 320 },
      { status: "verified", kind: "video", encodedWidth: 1200, encodedHeight: 800,
        displayWidth: 1200, displayHeight: 800, rotation: 0, durationSeconds: 2, validation: "full_static_decode" }]) {
      expect(StudioOriginalInspectionSchema.safeParse({ source, technical: changed }).success).toBe(false);
    }
    expect(StudioOriginalInspectionSchema.safeParse({ source, technical: { status: "failed", code: "invalid_media" } }).success).toBe(true);
  });

  it("retains the complete frozen request for prepared or unknown receipt recovery", () => {
    expect(studioResultIntentKey(StudioOriginalPinSchema.parse(source))).toBe(`erp-result-v1:${source.entryId}:3`);
    for (const status of ["prepared", "unknown"]) {
      expect(StudioResultIntentSchema.safeParse({ version: 1, status, request }).success).toBe(true);
    }
    for (const intent of [{ version: 1, status: "unknown", submissionId: request.submissionId },
      { version: 1, status: "confirmed", request }, { version: 1, status: "prepared", request, autoRetry: true }]) {
      expect(StudioResultIntentSchema.safeParse(intent).success).toBe(false);
    }
    expect(StudioResultLookupSchema.safeParse({ status: "missing" }).success).toBe(true);
    expect(StudioResultLookupSchema.safeParse({ status: "missing", definitelyNeverSubmitted: true }).success).toBe(false);
    expect(StudioResultLookupSchema.safeParse({ status: "found" }).success).toBe(false);
  });
});
