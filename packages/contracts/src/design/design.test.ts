import { describe, expect, it } from "vitest";

import { ReviewDesignVersionInputSchema, RightsSourceSchema, UploadDesignVersionInputSchema } from "./design.js";

describe("design contracts", () => {
  it("requires a rejection reason", () => {
    expect(ReviewDesignVersionInputSchema.safeParse({ decision: "reject" }).success).toBe(false);
    expect(ReviewDesignVersionInputSchema.safeParse({ decision: "approve" }).success).toBe(true);
  });

  it("models auditable rights sources", () => {
    expect(RightsSourceSchema.parse({ kind: "licensed", reference: "license-2026-41" })).toMatchObject({ kind: "licensed" });
  });

  it("rejects duplicate role and asset pairs", () => {
    const assetId = "0198fbef-4a10-7000-8000-000000000081";
    expect(UploadDesignVersionInputSchema.safeParse({ files: [{ assetId, role: "source" }, { assetId, role: "source" }] }).success).toBe(false);
  });
});
