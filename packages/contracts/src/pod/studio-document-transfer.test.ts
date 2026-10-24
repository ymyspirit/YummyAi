import { describe, expect, it } from "vitest";
import { StudioRpcSchema } from "./creative-studio.js";
import { StudioPersonalReplySchema } from "./studio-personal.js";
import { StudioTransferLookupSchema, StudioTransferPageSchema, StudioTransferRequestSchema } from "./studio-document-transfer.js";

const request = { scope: "unassigned", targetScope: "019a0000-0000-7000-8000-000000000003",
  requestId: "7ce993bc-a83b-4679-b63e-9cbf3392c172", manifestHash: "a".repeat(64) };
describe("original Studio document transfer contract", () => {
  it("bounds server recovery pages and preserves only validated original requests", () => {
    expect(StudioRpcSchema.parse({ operation: "document.requests", scope: request.scope })).toEqual({ operation: "document.requests", scope: request.scope, limit: 25 });
    expect(StudioRpcSchema.safeParse({ operation: "document.requests", scope: request.scope, limit: 51 }).success).toBe(false);
    expect(StudioRpcSchema.safeParse({ operation: "document.requests", scope: request.scope, cursor: request.requestId }).success).toBe(false);
    const page = { items: [{ status: "prepared", request, receipt: null }], nextCursor: request.targetScope, unavailableOnPage: 1 };
    expect(StudioTransferPageSchema.parse(page)).toEqual(page);
    expect(StudioTransferPageSchema.safeParse({ ...page, unavailableOnPage: 51 }).success).toBe(false);
    expect(StudioTransferPageSchema.safeParse({ ...page, items: Array.from({ length: 51 }, () => page.items[0]) }).success).toBe(false);
    expect(StudioTransferPageSchema.safeParse({ ...page, items: [{ status: "committed", request, receipt: null }] }).success).toBe(false);
    expect(StudioTransferPageSchema.safeParse({ ...page, targetOwner: "private" }).success).toBe(false);
  });
  it("binds every mutating and recovery operation to the exact original request", () => {
    for (const operation of ["document.prepare", "document.commit", "document.lookup", "document.cancel"])
      expect(StudioRpcSchema.parse({ operation, ...request })).toEqual({ operation, ...request });
    expect(StudioTransferRequestSchema.safeParse({ ...request, accessToken: "hidden" }).success).toBe(false);
    expect(StudioTransferRequestSchema.safeParse({ ...request, targetScope: "unassigned" }).success).toBe(false);
    expect(StudioTransferRequestSchema.safeParse({ ...request, manifestHash: "arbitrary" }).success).toBe(false);
    expect(StudioRpcSchema.safeParse({ operation: "document.commit", scope: request.scope, requestId: request.requestId }).success).toBe(false);
  });
  it("does not manufacture a committed result without a complete receipt", () => {
    expect(StudioTransferLookupSchema.parse({ status: "prepared", request, receipt: null }).status).toBe("prepared");
    expect(StudioTransferLookupSchema.parse({ status: "missing", request, receipt: null }).status).toBe("missing");
    expect(StudioTransferLookupSchema.parse({ status: "cancelled", request, receipt: null }).status).toBe("cancelled");
    expect(StudioTransferLookupSchema.safeParse({ status: "committed", request, receipt: null }).success).toBe(false);
    expect(StudioTransferLookupSchema.safeParse({ status: "prepared", request, receipt: { ok: true } }).success).toBe(false);
    expect(StudioPersonalReplySchema.safeParse({ operation: "document.lookup", version: 1, scope: "unassigned", data: { status: "missing", request, receipt: null } }).success).toBe(false);
  });
  it("rejects a structurally valid receipt belonging to a different original request", () => {
    const receipt = { id: request.targetScope, sourceScope: request.scope, targetScope: request.targetScope,
      requestId: request.requestId, manifestHash: request.manifestHash, copiedAt: "2026-10-24T00:00:00.000Z",
      counts: { canvases: 0, prompts: 0, assets: 0, imageDrafts: 0, videoDrafts: 0, history: 0, media: 1 },
      entries: [{ sourceEntryIds: [request.targetScope], targetEntryId: request.targetScope, revision: 1, namespace: "image_files", key: "copy:example" }] };
    expect(StudioTransferLookupSchema.safeParse({ status: "committed", request, receipt }).success).toBe(true);
    expect(StudioTransferLookupSchema.safeParse({ status: "committed", request, receipt: { ...receipt, manifestHash: "b".repeat(64) } }).success).toBe(false);
  });
});
