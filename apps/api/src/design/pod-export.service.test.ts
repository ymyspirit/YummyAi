import { describe, expect, it } from "vitest";

import { assertPodTaskQualityAllowsExport } from "./pod-export.service.js";

describe("POD export quality policy", () => {
  it("blocks unresolved UV conflicts even after a design review", () => {
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "uv_layers",
      qualityCheckSnapshot: uvQuality(true),
    })).toThrow("new reviewed version");
  });

  it("allows a strictly validated conflict-free UV layer package", () => {
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "uv_layers",
      qualityCheckSnapshot: uvQuality(false),
    })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({ toolKey: "piece_compose", qualityCheckSnapshot: {} })).not.toThrow();
  });

  it("requires complete product-video playback, input coverage, and rights evidence", () => {
    expect(() => assertPodTaskQualityAllowsExport({ toolKey: "product_video", qualityCheckSnapshot: productVideoQuality() })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "product_video",
      qualityCheckSnapshot: { ...productVideoQuality(), soundtrackLicenseMatched: false },
    })).toThrow("playback and rights evidence");
  });

  it("requires strict crop bounds and marked print-restoration evidence", () => {
    expect(() => assertPodTaskQualityAllowsExport({ toolKey: "pattern_crop", qualityCheckSnapshot: patternCropQuality() })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "pattern_crop", qualityCheckSnapshot: { ...patternCropQuality(), inputCoverageComplete: false },
    })).toThrow("bounds and input coverage");
    expect(() => assertPodTaskQualityAllowsExport({ toolKey: "print_extract", qualityCheckSnapshot: printExtractQuality() })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "print_extract", qualityCheckSnapshot: { ...printExtractQuality(), inferredAreasMarked: false },
    })).toThrow("marked AI-region");
  });

  it("requires strict per-input processing evidence with a matching tool key", () => {
    const missingGeneratedRegion = patternProcessingQuality("outpaint");
    missingGeneratedRegion.outputChecks[0]!.generatedRegions = [];
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "outpaint", qualityCheckSnapshot: patternProcessingQuality("outpaint"),
    })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "vectorize", qualityCheckSnapshot: patternProcessingQuality("outpaint"),
    })).toThrow("per-input file");
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "outpaint", qualityCheckSnapshot: missingGeneratedRegion,
    })).toThrow("marked AI-region");
  });

  it("blocks high, unknown, and expired rights-risk reports at export", () => {
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "rights_risk_scan", qualityCheckSnapshot: rightsRiskQuality("low"),
    })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "rights_risk_scan", qualityCheckSnapshot: rightsRiskQuality("high"),
    })).toThrow("high or unknown risk");
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "rights_risk_scan", qualityCheckSnapshot: rightsRiskQuality("low", "2020-02-01T00:00:00.000Z"),
    })).toThrow("current");
  });

  it("requires strict creative provenance and seamless evidence", () => {
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "design_variation", qualityCheckSnapshot: creativeQuality("design_variation"),
    })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "canvas_extend", qualityCheckSnapshot: creativeQuality("canvas_extend"),
    })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "seamless_stitch", qualityCheckSnapshot: creativeQuality("seamless_stitch"),
    })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "style_transfer", qualityCheckSnapshot: creativeQuality("design_variation"),
    })).toThrow("matching prompt");
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "seamless_stitch",
      qualityCheckSnapshot: {
        ...creativeQuality("seamless_stitch"),
        outputChecks: [{ ...creativeQuality("seamless_stitch").outputChecks[0], tilePreviewValidated: false }],
      },
    })).toThrow("seamless evidence");
  });

  it("requires strict Listing fact, identity, license, and output evidence", () => {
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "product_suite", qualityCheckSnapshot: listingQuality("product_suite"),
    })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "title_draft", qualityCheckSnapshot: listingQuality("title_draft"),
    })).not.toThrow();
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "virtual_try_on", qualityCheckSnapshot: listingQuality("virtual_try_on"),
    })).not.toThrow();
    const tryOn = listingQuality("virtual_try_on");
    (tryOn.outputChecks[0] as Record<string, unknown>).modelLicenseVerified = false;
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "virtual_try_on", qualityCheckSnapshot: tryOn,
    })).toThrow("license");
    expect(() => assertPodTaskQualityAllowsExport({
      toolKey: "background_replace", qualityCheckSnapshot: listingQuality("product_suite"),
    })).toThrow("matching fact");
  });
});

function listingQuality(toolKey: "product_suite" | "title_draft" | "virtual_try_on") {
  const title = "Floral Tee";
  const titleOutput = {
    fileName: "title-1.txt", outputIndex: 0, sourceInputOrdinals: [0], contentKind: "title",
    title, characterCount: [...title].length, byteCount: new TextEncoder().encode(title).byteLength,
    contentHashSha256: "d".repeat(64), factsMatched: true, unsupportedFactKeys: [],
    keywordSources: ["floral shirt"], platformRuleVersionMatched: true, trademarkRiskChecked: true,
    textReviewRequired: true, contentSafetyPassed: true,
  };
  const imageOutput = {
    fileName: `${toolKey}.png`, outputIndex: 0, sourceInputOrdinals: [0], contentKind: "image",
    slotKey: "main", width: 1200, height: 1200, format: "png", transparent: false,
    aiInference: "full", generatedRegions: [], productIdentityPreserved: true,
    categoryIdentityPassed: true, printPlacementPreserved: true, approvedFactsOnly: true,
    contentSafetyPassed: true, textDetected: false, textReviewRequired: false,
    ...(toolKey === "virtual_try_on" ? { modelLicenseVerified: true } : {}),
  };
  return {
    passed: true, toolKey, platform: "amazon", locale: "en-US", requestedOutputCount: 1,
    successfulOutputCount: 1, failedOutputCount: 0, inputCoverageComplete: true,
    duplicateOutputsDetected: false, outputChecks: [toolKey === "title_draft" ? titleOutput : imageOutput],
    failedOutputs: [],
  };
}

function creativeQuality(toolKey: "design_variation" | "canvas_extend" | "seamless_stitch") {
  const canvasExtension = toolKey === "canvas_extend";
  const deterministic = toolKey === "seamless_stitch";
  return {
    passed: true,
    toolKey,
    inputCoverageComplete: true,
    outputCountMatched: true,
    duplicateOutputsDetected: false,
    finalPromptHashSha256: "a".repeat(64),
    outputChecks: [{
      fileName: `${toolKey}.png`, outputIndex: 0, sourceInputOrdinals: [0],
      width: 1200, height: 1200, format: "png", transparent: false,
      aiInference: deterministic ? "none" : canvasExtension ? "partial" : "full",
      generatedRegions: canvasExtension
        ? [{ x: 0, y: 0, width: 1200, height: 200, reason: "crop_loss", confidence: 0.9, marked: true }]
        : [],
      promptSafetyPassed: true, contentSafetyPassed: true,
      textDetected: false, textReviewRequired: false, sourceIdentityPreserved: true,
      ...(deterministic ? { horizontalSeamPassed: true, verticalSeamPassed: true, tilePreviewValidated: true } : {}),
    }],
  };
}

function rightsRiskQuality(legalRisk: "low" | "high", validUntil = "2099-02-01T00:00:00.000Z") {
  const checkedAt = "2026-08-04T00:00:00.000Z";
  const high = legalRisk === "high";
  return {
    passed: true, depth: "deep", disclaimer: "auxiliary_non_legal_opinion",
    checkedAt, validUntil, ruleVersion: "rules-42",
    detectorModelKey: "rights-model", detectorModelVersion: "2026-08-04",
    sourceChecks: [{ sourceKey: "trademark_registry", sourceVersion: "2026-08-03", checkedAt, status: "complete" }],
    missingSourceKeys: [], inputCoverageComplete: true, highRiskDetected: high, unknownRiskDetected: false,
    outputChecks: [{
      fileName: "risk.json", inputOrdinal: 0, legalRisk, confidence: 0.9,
      ruleHits: high ? [{ ruleKey: "trademark-match", category: "trademark", label: "Strong trademark match", severity: "high", evidenceIds: ["registry-hit"] }] : [],
      evidence: [{ evidenceId: "registry-hit", kind: "trademark_registry", reference: "registry://fixture/42", checkedAt, accessible: true }],
      visualSimilarityEvaluated: true, visualSimilarityPermille: high ? 920 : 180,
      visualCandidateCount: 1, manualReviewRequired: true, downstreamBlocked: high,
    }],
  };
}

function patternProcessingQuality(toolKey: "outpaint" | "vectorize") {
  const vector = toolKey === "vectorize";
  return {
    passed: true, toolKey, inputCoverageComplete: true, blankOutputsDetected: false,
    artifactDetected: false, generatedAreasMarked: true,
    outputChecks: [{
      fileName: vector ? "art.svg" : "extended.png", inputOrdinal: 0, operation: toolKey,
      format: vector ? "svg" : "png", width: 1200, height: 1200,
      ...(vector ? {} : { dpi: 300 }), colorMode: "rgb", transparent: vector,
      ...(vector ? { pathCount: 20, pathsClosed: true } : {}),
      generatedRegions: vector ? [] : [{ x: 10, y: 20, width: 100, height: 80, reason: "crop_loss", confidence: 0.9, marked: true }],
      edgeQualityPassed: true, dimensionsMatched: true, formatMatched: true,
    }],
  };
}

function patternCropQuality() {
  return {
    passed: true, mode: "general", inputCoverageComplete: true, cropBoundsValid: true,
    blankOutputsDetected: false, duplicateOutputsDetected: false,
    outputChecks: [{
      fileName: "crop.png", inputOrdinal: 0, cropIndex: 0,
      sourceBounds: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      outputWidth: 2400, outputHeight: 3000, transparent: false,
      perspectiveCorrectionValidated: true, cropComplete: true,
    }],
  };
}

function printExtractQuality() {
  return {
    passed: true, mode: "transparent", inputCoverageComplete: true, aiInferencePresent: true,
    inferredAreasMarked: true, blankOutputsDetected: false, duplicateOutputsDetected: false,
    outputChecks: [{
      fileName: "print.png", inputOrdinal: 0, width: 2400, height: 3000, transparent: true,
      perspectiveCorrectionValidated: true, deformationCorrectionValidated: true,
      cropCoverageComplete: true, completeness: 0.95,
      inferredRegions: [{ x: 10, y: 20, width: 30, height: 40, reason: "occlusion", confidence: 0.8, marked: true }],
    }],
  };
}

function productVideoQuality() {
  return {
    passed: true, durationMatched: true, fpsMatched: true, dimensionsMatched: true,
    inputCoverageComplete: true, playbackValid: true, blankFramesDetected: false,
    corruptFramesDetected: false, safeAreaPassed: true, captionOverflowDetected: false,
    audioClippingDetected: false, soundtrackLicenseMatched: true, aiMotionEvidenceMatched: true,
    outputChecks: [{
      fileName: "product-video.mp4", usedInputOrdinals: [0, 1], durationSeconds: 15,
      fps: 30, width: 1080, height: 1920, videoCodec: "h264", audioCodec: "aac",
    }],
  };
}

function uvQuality(withConflict: boolean) {
  return {
    passed: !withConflict,
    exportReady: !withConflict,
    manualReviewRequired: withConflict,
    separationMode: "automatic",
    canvasMatched: true,
    dpiMatched: true,
    colorModeMatched: true,
    transparencyMatched: true,
    blankLayerKeys: [],
    unexpectedLayerKeys: [],
    layers: [{
      layerKey: "artwork", displayName: "彩墨层", channel: "color", order: 0, opacity: 1,
      sourceInputOrdinal: 0, sourcePixelCount: 100, conflictPixelCount: withConflict ? 10 : 0,
      width: 300, height: 400, unit: "mm", transparent: true, outputFileName: "artwork.png",
    }],
    conflictRegions: withConflict ? [{
      regionKey: "conflict-1", x: 1, y: 1, width: 2, height: 2, unit: "mm",
      reason: "low_confidence", candidateLayerKeys: ["artwork"], confidence: 0.5,
    }] : [],
    outputChecks: [{
      fileName: "artwork.png", kind: "layer", layerKeys: ["artwork"],
      dimensionsValid: true, transparencyValid: true, channelProfileValid: true,
    }],
  };
}
