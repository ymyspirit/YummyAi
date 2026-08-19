import { describe, expect, it } from "vitest";

import {
  CreatePodArtworkTaskInputSchema,
  PodArtworkTaskViewSchema,
  PodToolCatalogViewSchema,
} from "./pod.js";

describe("POD contracts", () => {
  const modules = [
    { key: "print_extraction", label: "印花提取", order: 1, phase: "pod_1" },
    { key: "print_design", label: "印花设计", order: 2, phase: "pod_2" },
    { key: "pattern_processing", label: "图案处理", order: 3, phase: "pod_1" },
    { key: "rights_risk", label: "侵权检测", order: 4, phase: "pod_1" },
    { key: "listing_assets", label: "套图&标题", order: 5, phase: "pod_2" },
    { key: "personalization", label: "来图定制", order: 6, phase: "pod_3" },
    { key: "production_artwork", label: "生产图", order: 7, phase: "pod_3" },
  ] as const;

  it("accepts the canonical Amazon and Etsy catalog order", () => {
    expect(PodToolCatalogViewSchema.safeParse({
      supportedMarketplaces: ["amazon", "etsy"],
      modules,
      tools: [{
        key: "pattern_crop",
        module: "print_extraction",
        label: "图案裁剪",
        description: "裁剪已授权图案。",
        phase: "pod_1",
        availability: "implementation_active",
        assetPolicy: "authorized_only",
        inputKinds: ["image"],
        outputKinds: ["image"],
        parameterSummary: ["裁剪模式"],
      }],
      supportCapabilities: [],
    }).success).toBe(true);
  });

  it("rejects reordered modules", () => {
    const reordered = [...modules];
    [reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!];
    const result = PodToolCatalogViewSchema.safeParse({
      supportedMarketplaces: ["amazon", "etsy"],
      modules: reordered,
      tools: [{
        key: "pattern_crop",
        module: "print_extraction",
        label: "图案裁剪",
        description: "裁剪已授权图案。",
        phase: "pod_1",
        availability: "definition_ready",
        assetPolicy: "authorized_only",
        inputKinds: ["image"],
        outputKinds: ["image"],
        parameterSummary: [],
      }],
      supportCapabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate tool keys", () => {
    const result = PodToolCatalogViewSchema.safeParse({
      supportedMarketplaces: ["amazon", "etsy"],
      modules,
      tools: [0, 1].map(() => ({
        key: "pattern_crop",
        module: "print_extraction",
        label: "图案裁剪",
        description: "裁剪已授权图案。",
        phase: "pod_1",
        availability: "definition_ready",
        assetPolicy: "authorized_only",
        inputKinds: ["image"],
        outputKinds: ["image"],
        parameterSummary: [],
      })),
      supportCapabilities: [],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an identifier-only POD-1 task request and immutable input evidence", () => {
    const taskId = "019f0000-0000-7000-8000-000000000001";
    const skuId = "019f0000-0000-7000-8000-000000000002";
    const assetId = "019f0000-0000-7000-8000-000000000003";
    expect(CreatePodArtworkTaskInputSchema.parse({
      idempotencyKey: taskId,
      skuId,
      toolKey: "pattern_crop",
      title: "夏季衬衫印花裁剪",
      inputAssetIds: [assetId],
      parameterSnapshot: patternCropParameters({ multiCrop: true, maximumCropsPerInput: 4 }),
    })).toMatchObject({ toolKey: "pattern_crop", inputAssetIds: [assetId] });

    expect(PodArtworkTaskViewSchema.safeParse({
      id: taskId,
      designTaskId: "019f0000-0000-7000-8000-000000000004",
      skuId,
      title: "夏季衬衫印花裁剪",
      toolKey: "pattern_crop",
      status: "queued",
      parameterSnapshot: patternCropParameters(),
      inputAssets: [{
        assetId,
        ordinal: 0,
        version: 2,
        checksumSha256: "a".repeat(64),
        domain: "authorized",
        rightsStatus: "approved",
      }],
      progressPercent: 0,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-03T06:00:00.000Z",
      updatedAt: "2026-08-03T06:00:00.000Z",
    }).success).toBe(true);
  });

  it("rejects duplicate asset IDs and nested task parameters", () => {
    const id = "019f0000-0000-7000-8000-000000000001";
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      idempotencyKey: id,
      skuId: "019f0000-0000-7000-8000-000000000002",
      toolKey: "pattern_crop",
      title: "重复输入",
      inputAssetIds: [id, id],
      parameterSnapshot: { unsafe: { nested: "value" } },
    }).success).toBe(false);
  });

  it("allows asset-free text-to-image but keeps every other tool pinned to source evidence", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      title: "原创印花概念",
      inputAssetIds: [],
      parameterSnapshot: creativeParameters("text_to_image", { prompt: "original botanical pattern" }),
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, toolKey: "text_to_image" }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, toolKey: "design_variation" }).success).toBe(false);
  });

  it("allows standalone POD-3 tasks while excluding order-scoped personalization", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      title: "生产文件生成",
      inputAssetIds: ["019f0000-0000-7000-8000-000000000003"],
      parameterSnapshot: { width: 300, height: 400, unit: "mm", dpi: 300, colorMode: "cmyk" },
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, toolKey: "product_video", parameterSnapshot: productVideoParameters() }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      toolKey: "piece_compose",
      parameterSnapshot: pieceComposeParameters(),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      toolKey: "piece_extract",
      parameterSnapshot: pieceExtractParameters(),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, toolKey: "uv_layers", parameterSnapshot: uvLayersParameters() }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, toolKey: "image_composite" }).success).toBe(false);
  });

  it("requires one stable key per composed piece and a complete manual layout", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      toolKey: "piece_compose" as const,
      title: "裁片排版",
      inputAssetIds: [
        "019f0000-0000-7000-8000-000000000003",
        "019f0000-0000-7000-8000-000000000004",
      ],
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: pieceComposeParameters({
        layoutMode: "manual",
        pieceKeys: ["front", "back"],
        manualPlacements: ["front,0,0,0,1", "back,160,0,90,1"],
      }),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: pieceComposeParameters({ pieceKeys: ["front"] }),
    }).success).toBe(false);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: pieceComposeParameters({
        layoutMode: "manual",
        pieceKeys: ["front", "back"],
        manualPlacements: ["front,0,0,0,1"],
      }),
    }).success).toBe(false);
  });

  it("locks piece extraction to one source and a valid split or combined template plan", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      toolKey: "piece_extract" as const,
      title: "裁片图提取",
      inputAssetIds: ["019f0000-0000-7000-8000-000000000003"],
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: pieceExtractParameters(),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: pieceExtractParameters({ outputFormat: "jpeg" }),
    }).success).toBe(false);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      inputAssetIds: [...base.inputAssetIds, "019f0000-0000-7000-8000-000000000004"],
      parameterSnapshot: pieceExtractParameters(),
    }).success).toBe(false);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: pieceExtractParameters({
        extractionMode: "combined",
        boundarySource: "dark_line",
        outputFormat: "jpeg",
        preserveTransparency: false,
      }),
    }).success).toBe(true);
  });

  it("locks UV separation to one source and a complete ordered channel plan", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      toolKey: "uv_layers" as const,
      title: "UV 智能分层",
      inputAssetIds: ["019f0000-0000-7000-8000-000000000003"],
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, parameterSnapshot: uvLayersParameters() }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: uvLayersParameters({ whiteInkLayer: false }),
    }).success).toBe(false);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      inputAssetIds: [...base.inputAssetIds, "019f0000-0000-7000-8000-000000000004"],
      parameterSnapshot: uvLayersParameters(),
    }).success).toBe(false);
  });

  it("requires a complete, rights-aware product video plan", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      toolKey: "product_video" as const,
      title: "商品短视频",
      inputAssetIds: ["019f0000-0000-7000-8000-000000000003"],
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, parameterSnapshot: productVideoParameters() }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: productVideoParameters({ captionMode: "custom" }),
    }).success).toBe(false);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: productVideoParameters({
        soundtrackMode: "licensed",
        soundtrackRightsAttested: false,
      }),
    }).success).toBe(false);
  });

  it("pins strict crop and print-extraction correction plans", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      title: "印花提取",
      inputAssetIds: ["019f0000-0000-7000-8000-000000000003"],
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, toolKey: "pattern_crop", parameterSnapshot: patternCropParameters() }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "pattern_crop",
      parameterSnapshot: patternCropParameters({ background: "transparent", outputFormat: "jpeg" }),
    }).success).toBe(false);
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, toolKey: "print_extract", parameterSnapshot: printExtractParameters() }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "print_extract",
      parameterSnapshot: printExtractParameters({ mode: "transparent", outputBackground: "original" }),
    }).success).toBe(false);
  });

  it("pins one strict processing plan per authorized input image", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      title: "图案处理",
      inputAssetIds: ["019f0000-0000-7000-8000-000000000003"],
    };
    const plans = {
      background_remove: { edgeRefinement: true, preserveShadow: false, outputFormat: "png" },
      super_resolution: { scale: 4, dpi: 300, denoise: 20, sharpen: 15, outputFormat: "tiff" },
      outpaint: { aspectRatio: "4:5", direction: "vertical", prompt: "延续原背景纹理", outputFormat: "png", markGeneratedAreas: true },
      crop_compress: { width: 2400, height: 3000, quality: 90, dpi: 300, format: "webp", colorSpace: "rgb", preserveTransparency: true },
      vectorize: { format: "svg", colorCount: 16, smoothing: true, closePaths: true, colorMode: "spot" },
      authorized_watermark_remove: { rightsAttested: true, regionDescription: "右下角授权水印", outputFormat: "png", markInferredAreas: true },
    } as const;
    for (const [toolKey, parameterSnapshot] of Object.entries(plans)) {
      expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, toolKey, parameterSnapshot }).success).toBe(true);
    }
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      toolKey: "crop_compress",
      parameterSnapshot: { ...plans.crop_compress, format: "jpeg" },
    }).success).toBe(false);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      toolKey: "authorized_watermark_remove",
      parameterSnapshot: { ...plans.authorized_watermark_remove, rightsAttested: false },
    }).success).toBe(false);
  });

  it("pins a scoped and expiring rights-risk scan plan", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      toolKey: "rights_risk_scan" as const,
      title: "侵权风险检查",
      inputAssetIds: ["019f0000-0000-7000-8000-000000000003"],
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({ ...base, parameterSnapshot: rightsRiskParameters() }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: rightsRiskParameters({ marketplaces: [] }),
    }).success).toBe(false);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base,
      parameterSnapshot: rightsRiskParameters({ validityDays: 0 }),
    }).success).toBe(false);
  });

  it("pins strict creative, licensed, series, canvas, and seamless plans", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      title: "印花设计",
      inputAssetIds: ["019f0000-0000-7000-8000-000000000003"],
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "design_variation", parameterSnapshot: creativeParameters("design_variation"),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "licensed_brand_fusion",
      parameterSnapshot: creativeParameters("licensed_brand_fusion", { rightsAttested: true, licenseReference: "license://brand/42" }),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "series_design",
      parameterSnapshot: creativeParameters("series_design", { batchPrompts: ["main", "companion"] }),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "canvas_extend", parameterSnapshot: creativeParameters("canvas_extend"),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "seamless_stitch",
      parameterSnapshot: creativeParameters("seamless_stitch", {
        markAiGenerated: false, creativity: 0, repeatType: "four_way", seamCheckRequired: true, tilePreviewRequired: true,
      }),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, inputAssetIds: [], toolKey: "text_to_image", parameterSnapshot: creativeParameters("text_to_image", { prompt: "original floral pattern" }),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "design_variation", parameterSnapshot: creativeParameters("style_transfer"),
    }).success).toBe(false);
  });

  it("pins strict suite, title, try-on, and background listing plans", () => {
    const base = {
      idempotencyKey: "019f0000-0000-7000-8000-000000000001",
      skuId: "019f0000-0000-7000-8000-000000000002",
      title: "Listing 素材",
      inputAssetIds: ["019f0000-0000-7000-8000-000000000003"],
    };
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "product_suite", parameterSnapshot: listingParameters("product_suite"),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "title_draft", parameterSnapshot: listingParameters("title_draft"),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "virtual_try_on", parameterSnapshot: listingParameters("virtual_try_on"),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "background_replace", parameterSnapshot: listingParameters("background_replace"),
    }).success).toBe(true);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "virtual_try_on",
      parameterSnapshot: { ...listingParameters("virtual_try_on"), modelLicenseReference: "" },
    }).success).toBe(false);
    expect(CreatePodArtworkTaskInputSchema.safeParse({
      ...base, toolKey: "product_suite", parameterSnapshot: listingParameters("background_replace"),
    }).success).toBe(false);
  });
});

function patternCropParameters(overrides: Record<string, unknown> = {}) {
  return {
    mode: "general",
    multiCrop: false,
    maximumCropsPerInput: 1,
    outputFormat: "png",
    background: "preserved",
    perspectiveCorrection: true,
    cropPaddingPercent: 2,
    ...overrides,
  };
}

function printExtractParameters(overrides: Record<string, unknown> = {}) {
  return {
    mode: "transparent",
    targetScenario: "auto",
    correctionStrength: "strong",
    restoreOccludedAreas: true,
    markInferredAreas: true,
    outputFormat: "png",
    outputBackground: "transparent",
    minimumCompleteness: 0.9,
    ...overrides,
  };
}

function rightsRiskParameters(overrides: Record<string, unknown> = {}) {
  return {
    depth: "deep",
    visualSimilarity: true,
    marketplaces: ["amazon", "etsy"],
    searchTerms: ["original botanical print"],
    validityDays: 30,
    ...overrides,
  };
}

function creativeParameters(designTool: string, overrides: Record<string, unknown> = {}) {
  return {
    designTool,
    prompt: "",
    referenceStrength: 70,
    creativity: 50,
    aspectRatio: "1:1",
    outputCount: 4,
    outputFormat: "png",
    markAiGenerated: true,
    markGeneratedAreas: true,
    ...overrides,
  };
}

function listingParameters(toolKey: "product_suite" | "title_draft" | "virtual_try_on" | "background_replace") {
  const common = { listingTool: toolKey, platform: "amazon", locale: "en-US", outputCount: 2, markAiGenerated: true };
  if (toolKey === "product_suite") return {
    ...common, productCategory: "apparel", suiteTemplate: "standard", outputFormat: "png",
    preserveProductIdentity: true, factSourcePolicy: "sku_catalog_snapshot",
  };
  if (toolKey === "title_draft") return {
    ...common, outputFormat: "txt", productFacts: "Black cotton T-shirt; floral front print",
    keywordConstraints: ["floral shirt"], platformRuleVersion: "amazon-title-2026-08",
    requireFactAttribution: true,
  };
  if (toolKey === "virtual_try_on") return {
    ...common, prompt: "adult model, neutral studio", aspectRatio: "4:5", outputFormat: "png",
    modelLicenseReference: "license://models/42", preserveGarmentIdentity: true, discloseAi: true,
  };
  return {
    ...common, prompt: "neutral studio background", aspectRatio: "1:1", outputFormat: "png",
    preserveSubject: true, generatedBackground: true,
  };
}

function productVideoParameters(overrides: Record<string, unknown> = {}) {
  return {
    durationSeconds: 15,
    shotTemplate: "product_focus",
    aspectRatio: "9:16",
    resolution: "1080p",
    fps: 30,
    transition: "fade",
    loop: false,
    captionMode: "product_title",
    soundtrackMode: "none",
    soundtrackRightsAttested: false,
    allowAiMotion: true,
    safeArea: true,
    ...overrides,
  };
}

function uvLayersParameters(overrides: Record<string, unknown> = {}) {
  return {
    width: 300,
    height: 400,
    unit: "mm",
    dpi: 300,
    colorMode: "cmyk",
    separationMode: "automatic",
    layerPrefix: "uv",
    supplierChannelProfile: "supplier-uv-v2",
    layerDefinitions: [
      "artwork|彩墨层|color|0|1",
      "white|白墨层|white_ink|1|1",
      "varnish|光油层|varnish|2|1",
    ],
    outputFormat: "png",
    preserveTransparency: true,
    whiteInkLayer: true,
    varnishLayer: true,
    conflictPolicy: "manual_review",
    compositePreview: true,
    ...overrides,
  };
}

function pieceExtractParameters(overrides: Record<string, unknown> = {}) {
  return {
    width: 300,
    height: 400,
    unit: "mm",
    dpi: 300,
    colorMode: "cmyk",
    extractionMode: "separate",
    boundarySource: "alpha",
    pieceDefinitions: ["front|前片|0|none", "back|后片|180|horizontal"],
    printArea: "边界内缩 10mm",
    seamAllowanceMm: 10,
    outputFormat: "png",
    preserveTransparency: true,
    minimumConfidence: 0.9,
    templateDraftName: "双面上衣裁片草稿",
    ...overrides,
  };
}

function pieceComposeParameters(overrides: Record<string, unknown> = {}) {
  return {
    width: 300,
    height: 400,
    unit: "mm",
    dpi: 300,
    colorMode: "cmyk",
    positioningTemplate: "supplier-shirt-v3",
    fitMode: "contain",
    layoutMode: "automatic",
    pieceKeys: ["front"],
    minimumDpi: 300,
    gapMm: 5,
    allowRotation: false,
    manualPlacements: [],
    ...overrides,
  };
}
