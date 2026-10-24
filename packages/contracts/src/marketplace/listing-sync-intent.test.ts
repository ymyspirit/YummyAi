import { describe, expect, it } from "vitest";
import { createEntityId } from "../common/ids.js";
import { listingSyncIntentRequestText, ListingSyncIntentLookupSchema, ListingSyncIntentReceiptSchema } from "./listing-sync-intent.js";

const target = () => ({ accountId: createEntityId(), listingId: createEntityId(), listingVersionId: createEntityId(), sourcePublicationRequestId: createEntityId(), action: "read" as const });
describe("original Listing sync intent identity", () => {
  it("binds every original target even when desired price and inventory would be identical", () => {
    const original = target(), text = listingSyncIntentRequestText(original);
    for (const field of ["accountId", "listingId", "listingVersionId", "sourcePublicationRequestId"] as const)
      expect(listingSyncIntentRequestText({ ...original, [field]: createEntityId() })).not.toBe(text);
    expect(listingSyncIntentRequestText({ ...original, action: "read_full_content" })).not.toBe(text);
    expect(listingSyncIntentRequestText({ ...original, requestKey: createEntityId() })).toBe(text);
  });
  it("canonicalizes database UUID casing and ignores object property order", () => {
    const original = target();
    expect(listingSyncIntentRequestText({ action: original.action, sourcePublicationRequestId: original.sourcePublicationRequestId.toUpperCase(),
      listingVersionId: original.listingVersionId.toUpperCase(), listingId: original.listingId.toUpperCase(), accountId: original.accountId.toUpperCase() })).toBe(listingSyncIntentRequestText(original));
  });
  it("rejects caller-selected tenant, missing exact lookup and invented found receipts", () => {
    expect(() => listingSyncIntentRequestText({ ...target(), tenantId: createEntityId() } as never)).toThrow();
    expect(ListingSyncIntentLookupSchema.safeParse({ requestKey: createEntityId() }).success).toBe(false);
    expect(ListingSyncIntentReceiptSchema.safeParse({ protocol: "erp-listing-sync-intent-v1", requestKey: createEntityId(), requestChecksum: "a".repeat(64),
      found: true, request: null, observedAt: new Date().toISOString() }).success).toBe(false);
  });
});
