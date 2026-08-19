import { createEntityId } from "../common/ids.js";
import { describe, expect, it } from "vitest";

import {
  AssignResearchProductTypeInputSchema,
  ResearchListResponseSchema,
} from "./research.js";

describe("research product type contracts", () => {
  it("accepts a nested classification and total count", () => {
    expect(
      ResearchListResponseSchema.parse({
        items: [
          {
            id: createEntityId(),
            platform: "etsy",
            marketplace: "www.etsy.com",
            normalizedUrl: "https://www.etsy.com/listing/123/sample",
            latestTitle: "Sample Pillow",
            shopName: "Sample Studio",
            latestStatus: "complete",
            lastCapturedAt: "2026-07-31T00:00:00.000Z",
            classification: {
              productType: { key: "throw pillows", name: "Throw Pillows" },
              status: "suggested",
              source: "marketplace_taxonomy",
              evidenceSource: "marketplace_taxonomy",
              evidenceLabel: "Throw Pillows",
              updatedAt: "2026-07-31T00:00:00.000Z",
            },
          },
        ],
        nextCursor: null,
        total: 1,
      }).total,
    ).toBe(1);
  });

  it("requires 1–100 unique explicit item ids and supports clearing", () => {
    const id = createEntityId();
    expect(
      AssignResearchProductTypeInputSchema.parse({
        itemIds: [id],
        productTypeName: null,
      }),
    ).toEqual({ itemIds: [id], productTypeName: null });
    expect(() =>
      AssignResearchProductTypeInputSchema.parse({
        itemIds: [id, id],
        productTypeName: "Mugs",
      }),
    ).toThrow(/unique/);
  });
});
