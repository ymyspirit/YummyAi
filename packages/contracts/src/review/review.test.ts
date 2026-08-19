import { createEntityId } from "../common/ids.js";
import { describe, expect, it } from "vitest";

import { ExportManifestSchema, ReviewDecisionInputSchema } from "./review.js";

describe("review contracts", () => {
  it("requires a useful rejection reason", () => {
    expect(ReviewDecisionInputSchema.safeParse({ decision: "reject" }).success).toBe(false);
    expect(ReviewDecisionInputSchema.safeParse({ decision: "reject", reason: "no" }).success).toBe(false);
    expect(ReviewDecisionInputSchema.safeParse({ decision: "reject", reason: "Main image crop is unsafe" }).success).toBe(true);
  });

  it("pins listing, rule, asset versions, and checksums", () => {
    const id = createEntityId();
    const result = ExportManifestSchema.parse({
      exportId: id, tenantId: id, platform: "amazon", listingId: id, listingVersionId: id,
      ruleVersion: "amazon-us-2026-07", files: [{ path: "media/main.png", sha256: "a".repeat(64), assetId: id, assetVersion: 4 }],
      createdBy: id, createdAt: new Date().toISOString(),
    });
    expect(result.files[0]).toMatchObject({ assetVersion: 4, sha256: "a".repeat(64) });
  });
});
