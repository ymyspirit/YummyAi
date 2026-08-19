import { createEntityId } from "@yummyai/contracts/common/ids";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock, revalidatePathMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn<typeof fetch>(),
  revalidatePathMock: vi.fn(),
}));
vi.mock("../../server-api", () => ({ apiFetch: apiFetchMock }));
vi.mock("next/cache", () => ({ revalidatePath: revalidatePathMock }));

import { createPodArtworkTask } from "./pod-actions";

const idle = { message: "", status: "idle" as const };

beforeEach(() => {
  apiFetchMock.mockReset();
  revalidatePathMock.mockReset();
  process.env.API_BASE_URL = "http://api.test";
});

describe("POD artwork actions", () => {
  it("creates a versioned multi-crop plan with fixed perspective and file rules", async () => {
    const skuId = createEntityId();
    const assetId = createEntityId();
    const parameters = patternCropParameters();
    apiFetchMock.mockResolvedValueOnce(json(taskResponse({ skuId, assetIds: [assetId], toolKey: "pattern_crop", title: "图案裁剪", parameters }), 201));

    const result = await createPodArtworkTask(idle, patternCropForm(skuId, [assetId]));

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(parameters);
  });

  it("rejects transparent crop output when the requested file format cannot preserve alpha", async () => {
    const form = patternCropForm(createEntityId(), [createEntityId()]);
    form.set("outputFormat", "jpeg");

    const result = await createPodArtworkTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("透明底必须使用 PNG");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("creates a strong transparent print-extraction plan with mandatory AI-region marking", async () => {
    const skuId = createEntityId();
    const assetId = createEntityId();
    const parameters = printExtractParameters();
    apiFetchMock.mockResolvedValueOnce(json(taskResponse({ skuId, assetIds: [assetId], toolKey: "print_extract", title: "印花图提取", parameters }), 201));

    const result = await createPodArtworkTask(idle, printExtractForm(skuId, [assetId]));

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(parameters);
    expect(body.parameterSnapshot.markInferredAreas).toBe(true);
  });

  it.each([
    "background_remove",
    "super_resolution",
    "outpaint",
    "crop_compress",
    "vectorize",
    "authorized_watermark_remove",
  ] as const)("creates a strict %s processing plan", async (toolKey) => {
    const skuId = createEntityId();
    const assetId = createEntityId();
    const expected = patternProcessingParameters(toolKey);
    apiFetchMock.mockResolvedValueOnce(json(taskResponse({
      skuId, assetIds: [assetId], toolKey, title: "图案处理", parameters: expected,
    }), 201));

    const result = await createPodArtworkTask(idle, patternProcessingForm(toolKey, skuId, [assetId]));

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(expected);
  });

  it("rejects transparent crop compression to JPEG before calling the API", async () => {
    const form = patternProcessingForm("crop_compress", createEntityId(), [createEntityId()]);
    form.set("format", "jpeg");

    const result = await createPodArtworkTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("透明通道");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("creates a scoped rights-risk scan with a fixed validity window", async () => {
    const skuId = createEntityId();
    const assetId = createEntityId();
    const expected = rightsRiskParameters();
    apiFetchMock.mockResolvedValueOnce(json(taskResponse({
      skuId, assetIds: [assetId], toolKey: "rights_risk_scan", title: "侵权风险检查", parameters: expected,
    }), 201));

    const result = await createPodArtworkTask(idle, rightsRiskForm(skuId, [assetId]));

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(expected);
  });

  it.each([
    ["text_to_image", []],
    ["series_design", [createEntityId()]],
    ["seamless_stitch", [createEntityId()]],
  ] as const)("creates a strict %s creative-design plan", async (toolKey, inputAssetIds) => {
    const skuId = createEntityId();
    const form = creativeDesignForm(toolKey, skuId, [...inputAssetIds]);
    const expected = creativeDesignParameters(toolKey);
    apiFetchMock.mockResolvedValueOnce(json(taskResponse({
      skuId, assetIds: [...inputAssetIds], toolKey, title: "印花设计", parameters: expected,
    }), 201));

    const result = await createPodArtworkTask(idle, form);

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(expected);
  });

  it("rejects an empty series prompt batch before calling the API", async () => {
    const form = creativeDesignForm("series_design", createEntityId(), [createEntityId()]);
    form.delete("batchPrompts");

    const result = await createPodArtworkTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("至少需要一条");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "product_suite",
    "title_draft",
    "virtual_try_on",
    "background_replace",
  ] as const)("creates a strict %s Listing candidate plan", async (toolKey) => {
    const skuId = createEntityId();
    const assetId = createEntityId();
    const expected = listingAssetParameters(toolKey);
    apiFetchMock.mockResolvedValueOnce(json(taskResponse({
      skuId, assetIds: [assetId], toolKey, title: "Listing 候选", parameters: expected,
    }), 201));

    const result = await createPodArtworkTask(idle, listingAssetForm(toolKey, skuId, [assetId]));

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(expected);
  });

  it("rejects background replacement when strict subject preservation is disabled", async () => {
    const form = listingAssetForm("background_replace", createEntityId(), [createEntityId()]);
    form.delete("preserveSubject");

    const result = await createPodArtworkTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("严格商品主体保持");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("creates a piece layout task with stable keys and production constraints", async () => {
    const skuId = createEntityId();
    const inputAssetIds = [createEntityId(), createEntityId()];
    const taskId = createEntityId();
    const designTaskId = createEntityId();
    apiFetchMock.mockResolvedValueOnce(json({
      id: taskId,
      designTaskId,
      skuId,
      title: "双面裁片排版",
      toolKey: "piece_compose",
      status: "queued",
      parameterSnapshot: pieceParameters(),
      inputAssets: inputAssetIds.map((assetId, ordinal) => ({
        assetId,
        ordinal,
        version: 1,
        checksumSha256: "a".repeat(64),
        domain: "authorized",
        rightsStatus: "approved",
      })),
      progressPercent: 0,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }, 201));
    const form = formData(skuId, inputAssetIds);

    const result = await createPodArtworkTask(idle, form);

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(pieceParameters());
    expect(revalidatePathMock).toHaveBeenCalledWith("/pod-workbench");
  });

  it("rejects a piece layout when stable keys do not match selected inputs", async () => {
    const form = formData(createEntityId(), [createEntityId(), createEntityId()]);
    form.set("pieceKeys", "front");

    const result = await createPodArtworkTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("每个已选素材");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("creates a split piece extraction task with a pinned template-draft plan", async () => {
    const skuId = createEntityId();
    const inputAssetId = createEntityId();
    const parameters = pieceExtractParameters();
    apiFetchMock.mockResolvedValueOnce(json({
      id: createEntityId(),
      designTaskId: createEntityId(),
      skuId,
      title: "裁片图提取",
      toolKey: "piece_extract",
      status: "queued",
      parameterSnapshot: parameters,
      inputAssets: [{
        assetId: inputAssetId,
        ordinal: 0,
        version: 1,
        checksumSha256: "b".repeat(64),
        domain: "authorized",
        rightsStatus: "approved",
      }],
      progressPercent: 0,
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: "2026-08-04T00:00:00.000Z",
      updatedAt: "2026-08-04T00:00:00.000Z",
    }, 201));

    const result = await createPodArtworkTask(idle, pieceExtractForm(skuId, [inputAssetId]));

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(parameters);
  });

  it("rejects piece extraction with more than one source without calling the API", async () => {
    const form = pieceExtractForm(createEntityId(), [createEntityId(), createEntityId()]);

    const result = await createPodArtworkTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("只能选择一份");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("explains incompatible split and combined extraction settings in Chinese", async () => {
    const form = pieceExtractForm(createEntityId(), [createEntityId()]);
    form.set("extractionMode", "combined");

    const result = await createPodArtworkTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("合版必须使用深色裁片线");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("creates a UV separation task with an ordered supplier channel plan", async () => {
    const skuId = createEntityId();
    const inputAssetId = createEntityId();
    const parameters = uvLayersParameters();
    apiFetchMock.mockResolvedValueOnce(json({
      id: createEntityId(), designTaskId: createEntityId(), skuId,
      title: "UV 智能分层", toolKey: "uv_layers", status: "queued",
      parameterSnapshot: parameters,
      inputAssets: [{ assetId: inputAssetId, ordinal: 0, version: 1, checksumSha256: "c".repeat(64), domain: "authorized", rightsStatus: "approved" }],
      progressPercent: 0, attemptCount: 0, maxAttempts: 3,
      createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
    }, 201));

    const result = await createPodArtworkTask(idle, uvLayersForm(skuId, [inputAssetId]));

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(parameters);
  });

  it("rejects a UV plan when channel toggles drift from the layer definitions", async () => {
    const form = uvLayersForm(createEntityId(), [createEntityId()]);
    form.delete("whiteInkLayer");

    const result = await createPodArtworkTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("白墨/光油开关必须与定义一致");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("creates a rights-aware product video plan without leaking irrelevant form fields", async () => {
    const skuId = createEntityId();
    const inputAssetIds = [createEntityId(), createEntityId()];
    const parameters = productVideoParameters();
    apiFetchMock.mockResolvedValueOnce(json({
      id: createEntityId(), designTaskId: createEntityId(), skuId,
      title: "商品短视频", toolKey: "product_video", status: "queued",
      parameterSnapshot: parameters,
      inputAssets: inputAssetIds.map((assetId, ordinal) => ({
        assetId, ordinal, version: 1, checksumSha256: "d".repeat(64), domain: "authorized", rightsStatus: "approved",
      })),
      progressPercent: 0, attemptCount: 0, maxAttempts: 3,
      createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
    }, 201));
    const form = productVideoForm(skuId, inputAssetIds);
    form.set("unusedProviderOption", "must-not-cross-the-boundary");

    const result = await createPodArtworkTask(idle, form);

    expect(result.status).toBe("success");
    const body = JSON.parse(String(apiFetchMock.mock.calls[0]?.[1]?.body)) as { parameterSnapshot: Record<string, unknown> };
    expect(body.parameterSnapshot).toEqual(parameters);
    expect(body.parameterSnapshot).not.toHaveProperty("unusedProviderOption");
  });

  it("rejects a licensed soundtrack without proof and attestation", async () => {
    const form = productVideoForm(createEntityId(), [createEntityId()]);
    form.delete("soundtrackLicenseReference");

    const result = await createPodArtworkTask(idle, form);

    expect(result).toMatchObject({ status: "error" });
    expect(result.message).toContain("许可证明");
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});

function taskResponse(input: {
  skuId: string;
  assetIds: string[];
  toolKey: "pattern_crop" | "print_extract" | "rights_risk_scan" | PatternProcessingTool | CreativeDesignTool | ListingAssetTool;
  title: string;
  parameters: Record<string, unknown>;
}) {
  return {
    id: createEntityId(), designTaskId: createEntityId(), skuId: input.skuId,
    title: input.title, toolKey: input.toolKey, status: "queued", parameterSnapshot: input.parameters,
    inputAssets: input.assetIds.map((assetId, ordinal) => ({
      assetId, ordinal, version: 1, checksumSha256: "7".repeat(64), domain: "authorized", rightsStatus: "approved",
    })),
    progressPercent: 0, attemptCount: 0, maxAttempts: 3,
    createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z",
  };
}

function patternCropForm(skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", "pattern_crop");
  form.set("skuId", skuId);
  form.set("title", "图案裁剪");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  form.set("mode", "decorative_art");
  form.set("multiCrop", "on");
  form.set("maximumCropsPerInput", "4");
  form.set("outputFormat", "png");
  form.set("background", "transparent");
  form.set("cropPaddingPercent", "3");
  form.set("resultLabel", "wall-art");
  return form;
}

function patternCropParameters() {
  return {
    mode: "decorative_art", multiCrop: true, maximumCropsPerInput: 4,
    outputFormat: "png", background: "transparent", perspectiveCorrection: true,
    cropPaddingPercent: 3, resultLabel: "wall-art",
  };
}

function printExtractForm(skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", "print_extract");
  form.set("skuId", skuId);
  form.set("title", "印花图提取");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  form.set("mode", "transparent");
  form.set("targetScenario", "apparel");
  form.set("correctionStrength", "strong");
  form.set("restoreOccludedAreas", "on");
  form.set("outputFormat", "png");
  form.set("outputBackground", "transparent");
  form.set("minimumCompleteness", "92");
  return form;
}

function printExtractParameters() {
  return {
    mode: "transparent", targetScenario: "apparel", correctionStrength: "strong",
    restoreOccludedAreas: true, markInferredAreas: true, outputFormat: "png",
    outputBackground: "transparent", minimumCompleteness: 0.92,
  };
}

function rightsRiskForm(skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", "rights_risk_scan");
  form.set("skuId", skuId);
  form.set("title", "侵权风险检查");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  form.set("depth", "deep");
  form.set("marketplaceScope", "amazon_etsy");
  form.set("validityDays", "30");
  form.set("visualSimilarity", "on");
  form.set("searchTerms", "original botanical print\nflower badge");
  return form;
}

function rightsRiskParameters() {
  return {
    depth: "deep",
    visualSimilarity: true,
    marketplaces: ["amazon", "etsy"],
    searchTerms: ["original botanical print", "flower badge"],
    validityDays: 30,
  };
}

type PatternProcessingTool = "background_remove" | "super_resolution" | "outpaint" | "crop_compress" | "vectorize" | "authorized_watermark_remove";

type CreativeDesignTool = "text_to_image" | "series_design" | "seamless_stitch";
type ListingAssetTool = "product_suite" | "title_draft" | "virtual_try_on" | "background_replace";

function creativeDesignForm(toolKey: CreativeDesignTool, skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", toolKey);
  form.set("skuId", skuId);
  form.set("title", "印花设计");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  form.set("referenceStrength", "72");
  form.set("creativity", "48");
  form.set("aspectRatio", "1:1");
  form.set("outputCount", toolKey === "series_design" ? "2" : "1");
  if (toolKey === "text_to_image") form.set("prompt", "original botanical pattern");
  if (toolKey === "series_design") form.set("batchPrompts", "main floral tile\ncompanion floral tile");
  if (toolKey === "seamless_stitch") form.set("repeatType", "four_way");
  return form;
}

function creativeDesignParameters(toolKey: CreativeDesignTool) {
  if (toolKey === "seamless_stitch") return {
    designTool: toolKey, prompt: "", repeatType: "four_way", referenceStrength: 72,
    creativity: 0, aspectRatio: "1:1", outputCount: 1, outputFormat: "png",
    markAiGenerated: false, markGeneratedAreas: true, seamCheckRequired: true, tilePreviewRequired: true,
  };
  return {
    designTool: toolKey,
    prompt: toolKey === "text_to_image" ? "original botanical pattern" : "",
    referenceStrength: 72, creativity: 48, aspectRatio: "1:1",
    outputCount: toolKey === "series_design" ? 2 : 1,
    outputFormat: "png", markAiGenerated: true, markGeneratedAreas: true,
    ...(toolKey === "series_design" ? { batchPrompts: ["main floral tile", "companion floral tile"] } : {}),
  };
}

function listingAssetForm(toolKey: ListingAssetTool, skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", toolKey);
  form.set("skuId", skuId);
  form.set("title", "Listing 候选");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  form.set("platform", "amazon");
  form.set("locale", "en-US");
  form.set("outputCount", "2");
  if (toolKey === "product_suite") {
    form.set("productCategory", "apparel");
    form.set("suiteTemplate", "standard");
  } else if (toolKey === "title_draft") {
    form.set("productFacts", "Black cotton T-shirt; floral front print");
    form.set("keywordConstraints", "floral shirt\nblack tee");
    form.set("platformRuleVersion", "amazon-title-2026-08");
  } else if (toolKey === "virtual_try_on") {
    form.set("prompt", "adult model, neutral studio");
    form.set("aspectRatio", "4:5");
    form.set("modelLicenseReference", "license://models/42");
  } else {
    form.set("prompt", "neutral studio background");
    form.set("aspectRatio", "1:1");
    form.set("preserveSubject", "on");
  }
  return form;
}

function listingAssetParameters(toolKey: ListingAssetTool) {
  const common = { listingTool: toolKey, platform: "amazon", locale: "en-US", outputCount: 2, markAiGenerated: true };
  if (toolKey === "product_suite") return {
    ...common, productCategory: "apparel", suiteTemplate: "standard", outputFormat: "png",
    preserveProductIdentity: true, factSourcePolicy: "sku_catalog_snapshot",
  };
  if (toolKey === "title_draft") return {
    ...common, outputFormat: "txt", productFacts: "Black cotton T-shirt; floral front print",
    keywordConstraints: ["floral shirt", "black tee"], platformRuleVersion: "amazon-title-2026-08",
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

function patternProcessingForm(toolKey: PatternProcessingTool, skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", toolKey);
  form.set("skuId", skuId);
  form.set("title", "图案处理");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  if (toolKey === "background_remove") {
    form.set("edgeRefinement", "on");
    form.set("outputFormat", "png");
  } else if (toolKey === "super_resolution") {
    form.set("scale", "4");
    form.set("dpi", "300");
    form.set("denoise", "20");
    form.set("sharpen", "15");
    form.set("outputFormat", "tiff");
  } else if (toolKey === "outpaint") {
    form.set("aspectRatio", "4:5");
    form.set("direction", "vertical");
    form.set("prompt", "延续原背景纹理");
    form.set("outputFormat", "png");
    form.set("markGeneratedAreas", "on");
  } else if (toolKey === "crop_compress") {
    form.set("width", "2400");
    form.set("height", "3000");
    form.set("quality", "90");
    form.set("dpi", "300");
    form.set("format", "webp");
    form.set("colorSpace", "rgb");
    form.set("preserveTransparency", "on");
  } else if (toolKey === "vectorize") {
    form.set("format", "svg");
    form.set("colorCount", "16");
    form.set("smoothing", "on");
    form.set("closePaths", "on");
    form.set("colorMode", "spot");
  } else {
    form.set("rightsAttested", "on");
    form.set("regionDescription", "右下角授权水印");
    form.set("outputFormat", "png");
    form.set("markInferredAreas", "on");
  }
  return form;
}

function patternProcessingParameters(toolKey: PatternProcessingTool): Record<string, string | number | boolean | string[]> {
  if (toolKey === "background_remove") return { edgeRefinement: true, preserveShadow: false, outputFormat: "png" };
  if (toolKey === "super_resolution") return { scale: 4, dpi: 300, denoise: 20, sharpen: 15, outputFormat: "tiff" };
  if (toolKey === "outpaint") return { aspectRatio: "4:5", direction: "vertical", prompt: "延续原背景纹理", outputFormat: "png", markGeneratedAreas: true };
  if (toolKey === "crop_compress") return { width: 2400, height: 3000, quality: 90, dpi: 300, format: "webp", colorSpace: "rgb", preserveTransparency: true };
  if (toolKey === "vectorize") return { format: "svg", colorCount: 16, smoothing: true, closePaths: true, colorMode: "spot" };
  return { rightsAttested: true, regionDescription: "右下角授权水印", outputFormat: "png", markInferredAreas: true };
}

function productVideoForm(skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", "product_video");
  form.set("skuId", skuId);
  form.set("title", "商品短视频");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  form.set("durationSeconds", "15");
  form.set("shotTemplate", "product_focus");
  form.set("aspectRatio", "9:16");
  form.set("resolution", "1080p");
  form.set("fps", "30");
  form.set("transition", "fade");
  form.set("captionMode", "custom");
  form.set("captionText", "新品细节展示");
  form.set("soundtrackMode", "licensed");
  form.set("soundtrackLicenseReference", "license://audio/catalog-42");
  form.set("soundtrackRightsAttested", "on");
  form.set("allowAiMotion", "on");
  form.set("safeArea", "on");
  return form;
}

function productVideoParameters() {
  return {
    durationSeconds: 15,
    shotTemplate: "product_focus",
    aspectRatio: "9:16",
    resolution: "1080p",
    fps: 30,
    transition: "fade",
    loop: false,
    captionMode: "custom",
    captionText: "新品细节展示",
    soundtrackMode: "licensed",
    soundtrackLicenseReference: "license://audio/catalog-42",
    soundtrackRightsAttested: true,
    allowAiMotion: true,
    safeArea: true,
  };
}

function uvLayersForm(skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", "uv_layers");
  form.set("skuId", skuId);
  form.set("title", "UV 智能分层");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  form.set("separationMode", "automatic");
  form.set("layerPrefix", "uv");
  form.set("supplierChannelProfile", "supplier-uv-v1");
  form.set("layerDefinitions", "artwork|彩墨层|color|0|1\nwhite|白墨层|white_ink|1|1\nvarnish|光油层|varnish|2|1");
  form.set("outputFormat", "png");
  form.set("whiteInkLayer", "on");
  form.set("varnishLayer", "on");
  form.set("width", "300");
  form.set("height", "400");
  form.set("unit", "mm");
  form.set("dpi", "300");
  form.set("colorMode", "cmyk");
  return form;
}

function uvLayersParameters() {
  return {
    width: 300, height: 400, unit: "mm", dpi: 300, colorMode: "cmyk",
    separationMode: "automatic", layerPrefix: "uv", supplierChannelProfile: "supplier-uv-v1",
    layerDefinitions: [
      "artwork|彩墨层|color|0|1",
      "white|白墨层|white_ink|1|1",
      "varnish|光油层|varnish|2|1",
    ],
    outputFormat: "png", preserveTransparency: true,
    whiteInkLayer: true, varnishLayer: true,
    conflictPolicy: "manual_review", compositePreview: true,
  };
}

function pieceExtractForm(skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", "piece_extract");
  form.set("skuId", skuId);
  form.set("title", "裁片图提取");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  form.set("extractionMode", "separate");
  form.set("boundarySource", "alpha");
  form.set("pieceDefinitions", "front|前片|0|none\nback|后片|0|none");
  form.set("printArea", "裁片边界内缩缝份后为印刷区域");
  form.set("seamAllowanceMm", "10");
  form.set("outputFormat", "png");
  form.set("preserveTransparency", "on");
  form.set("minimumConfidence", "90");
  form.set("templateDraftName", "双面上衣裁片草稿");
  form.set("width", "300");
  form.set("height", "400");
  form.set("unit", "mm");
  form.set("dpi", "300");
  form.set("colorMode", "cmyk");
  return form;
}

function pieceExtractParameters() {
  return {
    width: 300,
    height: 400,
    unit: "mm",
    dpi: 300,
    colorMode: "cmyk",
    extractionMode: "separate",
    boundarySource: "alpha",
    pieceDefinitions: ["front|前片|0|none", "back|后片|0|none"],
    printArea: "裁片边界内缩缝份后为印刷区域",
    seamAllowanceMm: 10,
    outputFormat: "png",
    preserveTransparency: true,
    minimumConfidence: 0.9,
    templateDraftName: "双面上衣裁片草稿",
  };
}

function formData(skuId: string, inputAssetIds: string[]) {
  const form = new FormData();
  form.set("toolKey", "piece_compose");
  form.set("skuId", skuId);
  form.set("title", "双面裁片排版");
  inputAssetIds.forEach((id) => form.append("inputAssetIds", id));
  form.set("positioningTemplate", "supplier-shirt-v3");
  form.set("pieceKeys", "front,back");
  form.set("fitMode", "contain");
  form.set("layoutMode", "automatic");
  form.set("minimumDpi", "300");
  form.set("gapMm", "5");
  form.set("allowRotation", "on");
  form.set("width", "300");
  form.set("height", "400");
  form.set("unit", "mm");
  form.set("dpi", "300");
  form.set("colorMode", "cmyk");
  return form;
}

function pieceParameters() {
  return {
    width: 300,
    height: 400,
    dpi: 300,
    unit: "mm",
    colorMode: "cmyk",
    positioningTemplate: "supplier-shirt-v3",
    fitMode: "contain",
    layoutMode: "automatic",
    pieceKeys: ["front", "back"],
    minimumDpi: 300,
    gapMm: 5,
    allowRotation: true,
    manualPlacements: [],
  };
}

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}
