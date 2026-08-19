import { describe, expect, it } from "vitest";

import {
  CreatePersonalizationTemplateVersionInputSchema,
  ClonePersonalizationTemplateInputSchema,
  CreateOrderPersonalizationBatchInputSchema,
  OrderPersonalizationBatchSchema,
  OrderPersonalizationOptionsViewSchema,
  CreateOrderPersonalizationRenderTaskInputSchema,
  OrderPersonalizationRenderTaskSchema,
  OrderPersonalizationResolutionSnapshotSchema,
  CreateProductionManifestInputSchema,
  PersonalizationTemplateSourceInspectionSchema,
  PodListingArtifactOptionsViewSchema,
  CreateRightsAssessmentInputSchema,
  VisualSearchInputSchema,
} from "./governance.js";

const id = "019f0000-0000-7000-8000-000000000001";
const asset = "019f0000-0000-7000-8000-000000000002";
const inspection = "019f0000-0000-7000-8000-000000000003";

describe("POD governance contracts", () => {
  it("pins copied organization templates to one immutable approved source version", () => {
    expect(ClonePersonalizationTemplateInputSchema.parse({ name: "Pet tag copy" })).toEqual({ name: "Pet tag copy" });
    const base = {
      name: "Pet tag copy",
      source: "popular_template",
      canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
      slots: [],
    };
    expect(CreatePersonalizationTemplateVersionInputSchema.safeParse(base).success).toBe(false);
    expect(CreatePersonalizationTemplateVersionInputSchema.safeParse({
      ...base,
      sourceTemplateVersionId: id,
    }).success).toBe(true);
  });

  it("keeps legal risk separate from visual similarity and blocks high risk", () => {
    const base = {
      assetId: asset,
      assetVersion: 1,
      scopeSnapshot: { marketplace: "amazon" },
      legalRisk: "high" as const,
      visualSimilarityPermille: 120,
      evidence: [],
    };
    expect(CreateRightsAssessmentInputSchema.safeParse({ ...base, status: "approved" }).success).toBe(false);
    expect(CreateRightsAssessmentInputSchema.parse({ ...base, status: "blocked" })).toMatchObject({ legalRisk: "high", visualSimilarityPermille: 120 });
  });

  it("requires imported PSD templates to pin their source and preserves reuse labels", () => {
    const parsed = CreatePersonalizationTemplateVersionInputSchema.parse({
      name: "Pet portrait",
      source: "psd",
      sourceAssetId: asset,
      sourceAssetVersion: 2,
      sourceInspectionId: inspection,
      canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
      slots: [{
        stableKey: "portrait.primary",
        name: "宠物照片",
        kind: "image",
        psdGroup: "image",
        geometry: { x: 0, y: 0, width: 1000, height: 1000 },
        fillMode: "cover",
        validationSnapshot: { required: true },
        replaceable: true,
        reuseLabel: "pet-photo",
      }],
    });
    expect(parsed.slots[0]?.reuseLabel).toBe("pet-photo");
  });

  it("requires completed template source inspections to preserve parser, source, canvas, and slot evidence", () => {
    const parsed = PersonalizationTemplateSourceInspectionSchema.parse({
      id: inspection,
      sourceAssetId: asset,
      sourceAssetVersion: 2,
      checksumSha256: "a".repeat(64),
      source: "psd",
      status: "completed",
      parserKey: "yummyai-template-source",
      parserVersion: "1.0.0",
      canvas: { width: 3000, height: 3000, dpi: 300, colorMode: "rgb" },
      slots: [{
        stableKey: "portrait.primary",
        name: "宠物照片",
        kind: "image",
        psdGroup: "image",
        geometry: { x: 0, y: 0, width: 1000, height: 1000 },
        fillMode: "cover",
        validationSnapshot: { sourceLayerIndex: 3 },
        replaceable: true,
        sourceLayerPath: ["image", "宠物照片"],
        confidencePermille: 950,
      }],
      warnings: [],
      requestedBy: id,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:01:00.000Z",
      completedAt: "2026-08-04T00:01:00.000Z",
    });
    expect(parsed.slots[0]?.sourceLayerPath).toEqual(["image", "宠物照片"]);
    expect(PersonalizationTemplateSourceInspectionSchema.safeParse({ ...parsed, canvas: undefined }).success).toBe(false);
  });

  it("requires a production source and immutable file checksums", () => {
    const result = CreateProductionManifestInputSchema.safeParse({
      inputSnapshot: [{ assetId: asset, assetVersion: 1, checksumSha256: "a".repeat(64) }],
      files: [{
        assetId: id,
        assetVersion: 1,
        checksumSha256: "b".repeat(64),
        fileName: "piece-01.tiff",
        mediaType: "image/tiff",
        width: 300,
        height: 400,
        unit: "mm",
        dpi: 300,
        colorMode: "cmyk",
      }],
      qualityCheckSnapshot: { passed: true },
    });
    expect(result.success).toBe(false);
  });

  it("bounds visual search to tenant-local result limits", () => {
    expect(VisualSearchInputSchema.parse({ assetId: asset })).toMatchObject({ domain: "all", limit: 20 });
    expect(VisualSearchInputSchema.safeParse({ assetId: asset, limit: 101 }).success).toBe(false);
  });

  it("pins Listing bindings to explicit asset and Listing versions", () => {
    const parsed = PodListingArtifactOptionsViewSchema.parse({
      listingVersions: [{ id, listingId: asset, versionNumber: 2, platform: "amazon", locale: "en-US", status: "draft" }],
      assets: [{ id: asset, version: 3, fileName: "approved-main.png", mediaType: "image/png" }],
      bindings: [],
    });
    expect(parsed.listingVersions[0]?.versionNumber).toBe(2);
    expect(parsed.assets[0]?.version).toBe(3);
  });

  it("keeps order personalization batches identifier-only and rejects duplicate order lines", () => {
    const item = {
      orderId: id,
      orderLineId: asset,
      customizationVersionId: inspection,
      bindingId: "019f0000-0000-7000-8000-000000000004",
    };
    expect(CreateOrderPersonalizationBatchInputSchema.safeParse({
      idempotencyKey: "019f0000-0000-7000-8000-000000000005",
      items: [item, item],
    }).success).toBe(false);
    expect(OrderPersonalizationBatchSchema.safeParse({
      id: "019f0000-0000-7000-8000-000000000006",
      idempotencyKey: "019f0000-0000-7000-8000-000000000005",
      status: "queued",
      itemCount: 1,
      preparedCount: 0,
      failedCount: 0,
      items: [{
        id: "019f0000-0000-7000-8000-000000000007",
        ordinal: 0,
        ...item,
        status: "queued",
        resolvedSlotCount: 0,
        encryptedResolution: "private payload",
      }],
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }).success).toBe(false);
  });

  it("exposes only safe order preparation candidates with stable blockers", () => {
    const candidate = {
      orderId: id,
      externalOrderId: "ETSY-1001",
      platform: "etsy",
      placedAt: "2026-08-04T00:00:00.000Z",
      orderLineId: asset,
      externalLineId: "LINE-1",
      lineTitle: "Custom pet tag",
      quantity: 1,
      skuId: inspection,
      skuCode: "PET-TAG-M",
      customizationVersionId: "019f0000-0000-7000-8000-000000000004",
      customizationVersionNumber: 2,
      completeness: 100,
      requirementStatus: "ready",
      bindingId: "019f0000-0000-7000-8000-000000000005",
      templateVersionId: "019f0000-0000-7000-8000-000000000006",
      templateName: "Pet tag M",
      sizeLabel: "M",
      eligible: true,
      blockers: [],
    };
    expect(OrderPersonalizationOptionsViewSchema.parse({ items: [candidate] }).items[0]).toMatchObject({
      externalOrderId: "ETSY-1001",
      eligible: true,
    });
    expect(OrderPersonalizationOptionsViewSchema.safeParse({
      items: [{ ...candidate, eligible: false }],
    }).success).toBe(false);
    expect(OrderPersonalizationOptionsViewSchema.safeParse({
      items: [{ ...candidate, eligible: true, encryptedValues: "private" }],
    }).success).toBe(false);
  });

  it("pins render-ready customer files and rejects PII in render parameters", () => {
    const batchItemId = "019f0000-0000-7000-8000-000000000008";
    expect(OrderPersonalizationResolutionSnapshotSchema.parse({
      version: 2,
      orderId: id,
      orderLineId: asset,
      customizationVersionId: inspection,
      templateVersionId: "019f0000-0000-7000-8000-000000000004",
      slots: [{
        slotId: "019f0000-0000-7000-8000-000000000007",
        stableKey: "customer.photo",
        kind: "image",
        assetId: "019f0000-0000-7000-8000-000000000009",
        assetVersion: 2,
        checksumSha256: "c".repeat(64),
        mediaType: "image/png",
      }],
    }).slots[0]).toMatchObject({ assetVersion: 2, checksumSha256: "c".repeat(64) });
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000005",
      batchItemId,
      toolKey: "image_composite",
      parameterSnapshot: { outputFormat: "png" },
    };
    expect(CreateOrderPersonalizationRenderTaskInputSchema.parse(base).parameterSnapshot).toMatchObject({
      fitMode: "template",
      autoComposition: "off",
      allowAiEnhancement: false,
    });
    expect(CreateOrderPersonalizationRenderTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: { outputFormat: "png", customerName: "private value" },
    }).success).toBe(false);
    expect(OrderPersonalizationRenderTaskSchema.safeParse({
      id: "019f0000-0000-7000-8000-000000000010",
      idempotencyKey: base.idempotencyKey,
      batchItemId,
      designTaskId: "019f0000-0000-7000-8000-000000000011",
      toolKey: "image_composite",
      status: "queued",
      parameterSnapshot: { outputFormat: "tiff" },
      progressPercent: 0,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }).success).toBe(false);
  });

  it("requires explicit identity and AI policies for creative order rendering", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000005",
      batchItemId: "019f0000-0000-7000-8000-000000000008",
      parameterSnapshot: {
        outputFormat: "png",
        autoComposition: "subject_focus",
        allowAiEnhancement: true,
        identityMode: "strict",
        customerAssetUsage: "all",
      },
    };
    expect(CreateOrderPersonalizationRenderTaskInputSchema.parse({
      ...base,
      toolKey: "group_photo",
    }).parameterSnapshot.referenceIdentityTransfer).toBe("not_applicable");
    expect(CreateOrderPersonalizationRenderTaskInputSchema.parse({
      ...base,
      toolKey: "pet_outfit",
      parameterSnapshot: { ...base.parameterSnapshot, referenceIdentityTransfer: "forbid" },
    }).toolKey).toBe("pet_outfit");
    expect(CreateOrderPersonalizationRenderTaskInputSchema.safeParse({
      ...base,
      toolKey: "group_photo",
      parameterSnapshot: { ...base.parameterSnapshot, allowAiEnhancement: false },
    }).success).toBe(false);
    expect(CreateOrderPersonalizationRenderTaskInputSchema.safeParse({
      ...base,
      toolKey: "pet_outfit",
    }).success).toBe(false);
  });

  it("requires a complete non-generative SVG plan for vector fulfillment", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000005",
      batchItemId: "019f0000-0000-7000-8000-000000000008",
      toolKey: "vector_fulfillment" as const,
      parameterSnapshot: vectorParameters(),
    };
    expect(CreateOrderPersonalizationRenderTaskInputSchema.parse(base).toolKey).toBe("vector_fulfillment");
    expect(CreateOrderPersonalizationRenderTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: { ...vectorParameters(), textToPath: false },
    }).success).toBe(false);
    expect(CreateOrderPersonalizationRenderTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: { ...vectorParameters(), outputFormat: "png" },
    }).success).toBe(false);
  });
});

function vectorParameters() {
  return {
    outputFormat: "svg",
    fitMode: "template",
    autoComposition: "off",
    allowAiEnhancement: false,
    identityMode: "standard",
    customerAssetUsage: "mapped",
    referenceIdentityTransfer: "not_applicable",
    colorMode: "spot",
    transparent: true,
    vectorTemplateProfile: "laser-cut-v1",
    vectorWidth: 300,
    vectorHeight: 400,
    vectorUnit: "mm",
    vectorLayoutMode: "template",
    textToPath: true,
    hollowMode: true,
    bridgeWidthMm: 1.5,
    minimumLineWidthMm: 0.3,
    pathRepair: "safe",
  };
}
