import { describe, expect, it } from "vitest";

import { createEntityId } from "../common/ids.js";
import {
  CreateCanvasPrintSpecVersionInputSchema,
  CreateCreativeDesignBatchInputSchema,
  CreateMockupBatchInputSchema,
  CreateMockupTemplatePackVersionInputSchema,
  ReviewMockupBatchInputSchema,
} from "./batch-workflows.js";

describe("POD batch workflow contracts", () => {
  it("accepts a 50-row creative batch and rejects duplicate row keys", () => {
    const specId = createEntityId();
    const items = Array.from({ length: 50 }, (_, index) => ({
      rowKey: `canvas-${index}`,
      name: `Canvas ${index}`,
      prompt: `Original botanical canvas design ${index}`,
      candidateCount: 4,
      printSpecVersionIds: [specId],
    }));
    expect(CreateCreativeDesignBatchInputSchema.safeParse({ name: "August canvas launch", items }).success).toBe(true);
    expect(CreateCreativeDesignBatchInputSchema.safeParse({ name: "Duplicate", items: [items[0], items[0]] }).success).toBe(false);
  });

  it("requires physical canvas sizes to match the declared aspect", () => {
    const input = {
      name: "2:3 gallery wrap",
      aspectWidth: 2,
      aspectHeight: 3,
      targetDpi: 300,
      bleedMm: 20,
      safeZoneMm: 15,
      wrapMode: "mirror" as const,
      physicalSizes: [{ key: "12x18", label: "12 × 18 in", widthMm: 304.8, heightMm: 457.2 }],
    };
    expect(CreateCanvasPrintSpecVersionInputSchema.safeParse(input).success).toBe(true);
    expect(CreateCanvasPrintSpecVersionInputSchema.safeParse({
      ...input,
      physicalSizes: [{ key: "bad", label: "Bad", widthMm: 300, heightMm: 300 }],
    }).success).toBe(false);
  });

  it("keeps template slots unique and bounded", () => {
    const inspectionId = createEntityId();
    const specId = createEntityId();
    const base = {
      name: "Amazon US canvas suite",
      platform: "amazon" as const,
      locale: "en-US",
      productCategory: "canvas_art" as const,
      slots: [{ slotKey: "main", label: "Main", ordinal: 0, required: true, inspectionId, acceptedPrintSpecVersionIds: [specId] }],
    };
    expect(CreateMockupTemplatePackVersionInputSchema.safeParse(base).success).toBe(true);
    expect(CreateMockupTemplatePackVersionInputSchema.safeParse({ ...base, slots: [base.slots[0], base.slots[0]] }).success).toBe(false);
  });

  it("requires unique design and SKU pairs in mockup batches", () => {
    const designVersionId = createEntityId();
    const skuId = createEntityId();
    const input = {
      name: "Canvas mockups",
      templatePackVersionId: createEntityId(),
      platform: "etsy" as const,
      locale: "en-US",
      items: [{ designVersionId, skuId }],
    };
    expect(CreateMockupBatchInputSchema.safeParse(input).success).toBe(true);
    expect(CreateMockupBatchInputSchema.safeParse({ ...input, items: [input.items[0], input.items[0]] }).success).toBe(false);
  });

  it("requires a reason when rejecting a mockup item", () => {
    const itemId = createEntityId();
    expect(ReviewMockupBatchInputSchema.safeParse({ decisions: [{ itemId, decision: "reject" }] }).success).toBe(false);
    expect(ReviewMockupBatchInputSchema.safeParse({ decisions: [{ itemId, decision: "reject", rejectionReason: "Frame perspective changed the artwork." }] }).success).toBe(true);
  });
});
