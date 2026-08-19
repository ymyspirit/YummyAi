import { createHash } from "node:crypto";

import type { JobEnvelope } from "@yummyai/jobs";
import { RightsRiskQualityCheckSnapshotSchema } from "@yummyai/contracts";
import { describe, expect, it } from "vitest";

import {
  PodArtworkInputPolicyError,
  PodArtworkProcessor,
  type PodArtworkExecutionRecord,
  type PodArtworkExecutionRepository,
  type PodArtworkExecutionResult,
  type PodArtworkGateway,
} from "./pod-artwork.processor.js";

const ids = {
  task: "019f0000-0000-7000-8000-000000000001",
  designTask: "019f0000-0000-7000-8000-000000000002",
  tenant: "019f0000-0000-7000-8000-000000000003",
  user: "019f0000-0000-7000-8000-000000000004",
  asset: "019f0000-0000-7000-8000-000000000005",
};

describe("PodArtworkProcessor", () => {
  it("blocks research assets from every creative and production transform", async () => {
    const repository = memoryRepository(task({ domain: "research", rightsStatus: "unverified" }));
    const gateway = memoryGateway();
    const processor = new PodArtworkProcessor(repository, gateway);

    await expect(processor.process(envelope())).rejects.toBeInstanceOf(PodArtworkInputPolicyError);
    expect(gateway.called).toBe(false);
    expect(repository.claimed).toBe(true);
    expect(repository.failure).toEqual({
      attempt: 0,
      terminal: true,
      code: "INPUT_POLICY_BLOCKED",
      message: "POD tool pattern_crop requires rights-approved authorized assets",
    });
  });

  it("allows research evidence only for the risk scan", async () => {
    const repository = memoryRepository(task({
      domain: "research",
      rightsStatus: "unverified",
      toolKey: "rights_risk_scan",
    }));
    const gateway = memoryGateway(rightsRiskResult());
    const quality = RightsRiskQualityCheckSnapshotSchema.safeParse(rightsRiskResult().qualityCheckSnapshot);
    expect(quality.success, quality.success ? undefined : JSON.stringify(quality.error.issues)).toBe(true);
    const result = await new PodArtworkProcessor(repository, gateway).process(envelope());

    expect(result).toMatchObject({ disposition: "awaiting_review", outputCount: 1 });
    expect(repository.completed).toBe(true);
  });

  it("blocks risk reports that mix visual similarity with the legal conclusion", async () => {
    const repository = memoryRepository(task({ toolKey: "rights_risk_scan" }));
    const result = rightsRiskResult();
    const quality = result.qualityCheckSnapshot as {
      outputChecks: Array<{ visualSimilarityEvaluated: boolean; visualSimilarityPermille?: number; visualCandidateCount: number }>;
    };
    const check = quality.outputChecks[0]!;
    check.visualSimilarityEvaluated = false;
    delete check.visualSimilarityPermille;
    check.visualCandidateCount = 0;
    result.outputs[0]!.bytes = new TextEncoder().encode(JSON.stringify({
      inputOrdinal: 0,
      legalRisk: "low",
      checkedAt: "2026-08-04T06:00:00.000Z",
      disclaimer: "auxiliary_non_legal_opinion",
      evidenceCount: 1,
    }));

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("Visual similarity");
    expect(repository.failure).toMatchObject({ terminal: true, code: "RIGHTS_RISK_VISUAL_EVIDENCE_INVALID" });
  });

  it("requires an explicit rights attestation for watermark removal", async () => {
    const repository = memoryRepository(task({ toolKey: "authorized_watermark_remove" }));
    await expect(new PodArtworkProcessor(repository, memoryGateway()).process(envelope()))
      .rejects.toThrow("explicit rights attestation");
    expect(repository.failure).toMatchObject({ terminal: true, code: "INPUT_POLICY_BLOCKED" });
  });

  it("blocks licensed brand fusion without a license reference and permits asset-free text generation", async () => {
    const licensed = memoryRepository(task({ toolKey: "licensed_brand_fusion" }));
    await expect(new PodArtworkProcessor(licensed, memoryGateway()).process(envelope()))
      .rejects.toThrow("license reference");
    expect(licensed.failure).toMatchObject({ terminal: true, code: "INPUT_POLICY_BLOCKED" });

    const generated = memoryRepository({ ...task({ toolKey: "text_to_image" }), inputAssets: [] });
    await expect(new PodArtworkProcessor(generated, memoryGateway(creativeDesignResult("text_to_image", 0))).process(envelope()))
      .resolves.toMatchObject({ disposition: "awaiting_review" });
  });

  it("validates creative AI, canvas-extension, and deterministic seamless evidence", async () => {
    for (const toolKey of ["design_variation", "canvas_extend", "seamless_stitch"] as const) {
      const repository = memoryRepository(task({ toolKey }));
      await expect(new PodArtworkProcessor(repository, memoryGateway(creativeDesignResult(toolKey, 1))).process(envelope()))
        .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 1 });
      expect(repository.completed).toBe(true);
    }
  });

  it("blocks creative output when the final prompt hash drifts", async () => {
    const repository = memoryRepository(task({ toolKey: "design_variation" }));
    const result = creativeDesignResult("design_variation", 1);
    (result.qualityCheckSnapshot as { finalPromptHashSha256: string }).finalPromptHashSha256 = "f".repeat(64);

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("strict prompt");
    expect(repository.failure).toMatchObject({ terminal: true, code: "CREATIVE_DESIGN_QUALITY_INVALID" });
  });

  it("validates suite, title, try-on, and background listing evidence", async () => {
    for (const toolKey of ["product_suite", "title_draft", "virtual_try_on", "background_replace"] as const) {
      const repository = memoryRepository(task({ toolKey }));
      await expect(new PodArtworkProcessor(repository, memoryGateway(listingAssetResult(toolKey, 1))).process(envelope()))
        .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 1 });
      expect(repository.completed).toBe(true);
    }
  });

  it("isolates a failed product-suite slot without accepting partial output for other listing tools", async () => {
    const suiteTask = task({ toolKey: "product_suite" });
    suiteTask.parameterSnapshot = { ...listingAssetParameters("product_suite"), outputCount: 2 };
    await expect(new PodArtworkProcessor(memoryRepository(suiteTask), memoryGateway(listingAssetResult("product_suite", 1, true))).process(envelope()))
      .resolves.toMatchObject({ disposition: "partially_succeeded", outputCount: 1 });

    const titleTask = task({ toolKey: "title_draft" });
    titleTask.parameterSnapshot = { ...listingAssetParameters("title_draft"), outputCount: 2 };
    await expect(new PodArtworkProcessor(memoryRepository(titleTask), memoryGateway(listingAssetResult("title_draft", 1, true))).process(envelope()))
      .rejects.toThrow("strict fact");
  });

  it("blocks a title draft whose bytes drift from its fact-review evidence", async () => {
    const repository = memoryRepository(task({ toolKey: "title_draft" }));
    const result = listingAssetResult("title_draft", 1);
    result.outputs[0]!.bytes = new TextEncoder().encode("Unreviewed replacement title");

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("Title draft text");
    expect(repository.failure).toMatchObject({ terminal: true, code: "TITLE_DRAFT_OUTPUT_INVALID" });
  });

  it("blocks customer-order assets from the generic creative worker", async () => {
    const repository = memoryRepository({
      ...task({ toolKey: "design_variation" }),
      inputAssets: [{ ...task().inputAssets[0]!, rightsSourceKind: "customer_provided" }],
    });
    await expect(new PodArtworkProcessor(repository, memoryGateway()).process(envelope()))
      .rejects.toThrow("order-scoped personalization workflow");
    expect(repository.failure).toMatchObject({ terminal: true, code: "INPUT_POLICY_BLOCKED" });
  });

  it("accepts complete multi-crop bounds and uniquely mapped output evidence", async () => {
    const record = task({ toolKey: "pattern_crop" });
    record.parameterSnapshot = patternCropParameters({ multiCrop: true, maximumCropsPerInput: 2 });
    const repository = memoryRepository(record);

    await expect(new PodArtworkProcessor(repository, memoryGateway(patternCropResult(true))).process(envelope()))
      .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 2 });
    expect(repository.completed).toBe(true);
  });

  it("fails pattern crop when crop indices are not contiguous", async () => {
    const record = task({ toolKey: "pattern_crop" });
    record.parameterSnapshot = patternCropParameters({ multiCrop: true, maximumCropsPerInput: 2 });
    const result = patternCropResult(true);
    const quality = result.qualityCheckSnapshot as { outputChecks: Array<{ cropIndex: number }> };
    quality.outputChecks[1]!.cropIndex = 2;
    const repository = memoryRepository(record);

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("contiguous");
    expect(repository.failure).toMatchObject({ terminal: true, code: "PATTERN_CROP_INDEX_INVALID" });
  });

  it("accepts corrected print extraction only when AI-restored regions remain explicitly marked", async () => {
    const repository = memoryRepository(task({ toolKey: "print_extract" }));

    await expect(new PodArtworkProcessor(repository, memoryGateway(printExtractResult())).process(envelope()))
      .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 1 });
    expect(repository.completed).toBe(true);
  });

  it("fails print extraction when provider region metadata drifts from the review evidence", async () => {
    const result = printExtractResult();
    result.outputs[0]!.metadata.inferenceRegions![0]!.width = 201;
    const repository = memoryRepository(task({ toolKey: "print_extract" }));

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("marked AI regions");
    expect(repository.failure).toMatchObject({ terminal: true, code: "PRINT_EXTRACT_OUTPUT_INVALID" });
  });

  it("validates strict output evidence for every pattern-processing operation", async () => {
    const tools = ["background_remove", "super_resolution", "outpaint", "crop_compress", "vectorize"] as const;
    for (const toolKey of tools) {
      const repository = memoryRepository(task({ toolKey }));
      await expect(new PodArtworkProcessor(repository, memoryGateway(patternProcessingResult(toolKey))).process(envelope()))
        .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 1 });
      expect(repository.completed).toBe(true);
    }
    const watermarkRecord = task({ toolKey: "authorized_watermark_remove" });
    watermarkRecord.parameterSnapshot = patternProcessingParameters("authorized_watermark_remove");
    await expect(new PodArtworkProcessor(memoryRepository(watermarkRecord), memoryGateway(patternProcessingResult("authorized_watermark_remove"))).process(envelope()))
      .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 1 });
  });

  it("blocks unsafe external references in vectorized SVG output", async () => {
    const repository = memoryRepository(task({ toolKey: "vectorize" }));
    const result = patternProcessingResult("vectorize");
    result.outputs[0]!.bytes = new TextEncoder().encode('<svg><image href="https://untrusted.example/a.png"/></svg>');

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("unsafe");
    expect(repository.failure).toMatchObject({ terminal: true, code: "VECTORIZE_OUTPUT_INVALID" });
  });

  it("requires full-image AI enhancement evidence for super resolution", async () => {
    const repository = memoryRepository(task({ toolKey: "super_resolution" }));
    const result = patternProcessingResult("super_resolution");
    result.outputs[0]!.metadata.aiInference = "none";

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("AI enhancement evidence");
    expect(repository.failure).toMatchObject({ terminal: true, code: "SUPER_RESOLUTION_OUTPUT_INVALID" });
  });

  it("permits standalone POD-3 production transforms for approved authorized assets", async () => {
    const repository = memoryRepository(task({ toolKey: "piece_compose" }));
    const gateway = memoryGateway(pieceComposeResult());

    await expect(new PodArtworkProcessor(repository, gateway).process(envelope()))
      .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 1 });
    expect(gateway.called).toBe(true);
    expect(repository.completed).toBe(true);
  });

  it("accepts a complete piece extraction template draft with explicit low-confidence review", async () => {
    const repository = memoryRepository(task({ toolKey: "piece_extract" }));

    await expect(new PodArtworkProcessor(repository, memoryGateway(pieceExtractResult())).process(envelope()))
      .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 4 });
    expect(repository.completed).toBe(true);
  });

  it("fails piece extraction terminally when a pinned region is missing", async () => {
    const repository = memoryRepository(task({ toolKey: "piece_extract" }));
    const result = pieceExtractResult();
    const quality = result.qualityCheckSnapshot as { regions: Array<Record<string, unknown>> };
    quality.regions.pop();

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("every pinned piece definition");
    expect(repository.failure).toMatchObject({ terminal: true, code: "PIECE_EXTRACT_REGION_MISMATCH" });
  });

  it("recomputes low-confidence confirmation instead of trusting provider flags", async () => {
    const repository = memoryRepository(task({ toolKey: "piece_extract" }));
    const result = pieceExtractResult();
    const quality = result.qualityCheckSnapshot as { regions: Array<{ manualConfirmationRequired: boolean }> };
    quality.regions[1]!.manualConfirmationRequired = false;

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("manual confirmation");
    expect(repository.failure).toMatchObject({ terminal: true, code: "PIECE_EXTRACT_CONFIDENCE_INVALID" });
  });

  it("accepts a complete UV channel package with one file per ordered layer", async () => {
    const repository = memoryRepository(task({ toolKey: "uv_layers" }));

    await expect(new PodArtworkProcessor(repository, memoryGateway(uvLayersResult())).process(envelope()))
      .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 5 });
    expect(repository.completed).toBe(true);
  });

  it("preserves machine-readable UV conflicts for manual review without marking export ready", async () => {
    const repository = memoryRepository(task({ toolKey: "uv_layers" }));

    await expect(new PodArtworkProcessor(repository, memoryGateway(uvLayersResult(true))).process(envelope()))
      .resolves.toMatchObject({ disposition: "awaiting_review" });
    expect(repository.completed).toBe(true);
  });

  it("fails UV separation when a conflict region exceeds the pinned canvas", async () => {
    const repository = memoryRepository(task({ toolKey: "uv_layers" }));
    const result = uvLayersResult(true);
    const quality = result.qualityCheckSnapshot as { conflictRegions: Array<{ x: number }> };
    quality.conflictRegions[0]!.x = 299;

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("inside the pinned canvas");
    expect(repository.failure).toMatchObject({ terminal: true, code: "UV_LAYERS_CONFLICT_INVALID" });
  });

  it("fails a piece layout terminally when strict placement evidence is incomplete", async () => {
    const repository = memoryRepository(task({ toolKey: "piece_compose" }));
    const result = pieceComposeResult();
    result.qualityCheckSnapshot = { ...result.qualityCheckSnapshot, placements: [] };

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("strict quality evidence");
    expect(repository.failure).toMatchObject({ terminal: true, code: "PIECE_LAYOUT_QUALITY_INVALID" });
  });

  it("fails a piece layout when manual output drifts from the pinned plan", async () => {
    const record = task({ toolKey: "piece_compose" });
    record.parameterSnapshot = {
      ...record.parameterSnapshot,
      layoutMode: "manual",
      manualPlacements: ["front,25,30,0,1"],
    };
    const result = pieceComposeResult();
    result.qualityCheckSnapshot = { ...result.qualityCheckSnapshot, layoutMode: "manual" };
    const repository = memoryRepository(record);

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("manual placement plan");
    expect(repository.failure).toMatchObject({ terminal: true, code: "PIECE_LAYOUT_MANUAL_MISMATCH" });
  });

  it("recomputes the minimum gap instead of trusting provider pass flags", async () => {
    const record = task({ toolKey: "piece_compose" });
    record.inputAssets.push({ ...record.inputAssets[0]!, id: "019f0000-0000-7000-8000-000000000008" });
    record.parameterSnapshot = { ...record.parameterSnapshot, width: 600, pieceKeys: ["front", "back"] };
    const result = pieceComposeResult();
    result.outputs[0]!.metadata.width = 600;
    const quality = result.qualityCheckSnapshot as {
      placements: Array<Record<string, unknown>>;
      outputChecks: Array<{ pieceKeys: string[] }>;
    };
    quality.placements.push({
      ...quality.placements[0],
      pieceKey: "back",
      inputOrdinal: 1,
      x: 282,
    });
    quality.outputChecks[0]!.pieceKeys.push("back");
    const repository = memoryRepository(record);

    await expect(new PodArtworkProcessor(repository, memoryGateway(result)).process(envelope()))
      .rejects.toThrow("minimum gap");
    expect(repository.failure).toMatchObject({ terminal: true, code: "PIECE_LAYOUT_GAP_INVALID" });
  });

  it("accepts one complete MP4 only when every pinned image and playback check is evidenced", async () => {
    const repository = memoryRepository(task({ toolKey: "product_video" }));

    await expect(new PodArtworkProcessor(repository, memoryGateway(productVideoResult())).process(envelope()))
      .resolves.toMatchObject({ disposition: "awaiting_review", outputCount: 1 });
    expect(repository.completed).toBe(true);
  });

  it("fails a product video when the processor omits a pinned input from its quality evidence", async () => {
    const record = task({ toolKey: "product_video" });
    record.inputAssets.push({ ...record.inputAssets[0]!, id: "019f0000-0000-7000-8000-000000000008" });
    const repository = memoryRepository(record);

    await expect(new PodArtworkProcessor(repository, memoryGateway(productVideoResult())).process(envelope()))
      .rejects.toThrow("all pinned inputs");
    expect(repository.failure).toMatchObject({ terminal: true, code: "PRODUCT_VIDEO_EVIDENCE_MISMATCH" });
  });

  it("stores model and quality provenance and records retryable failure", async () => {
    const repository = memoryRepository(task());
    const gateway: PodArtworkGateway = { execute: async () => { throw new Error("provider unavailable"); } };
    await expect(new PodArtworkProcessor(repository, gateway).process(envelope())).rejects.toThrow("provider unavailable");
    expect(repository.failure).toEqual({
      attempt: 0,
      terminal: false,
      code: "ERROR",
      message: "provider unavailable",
    });
  });
});

function task(overrides: Partial<PodArtworkExecutionRecord["inputAssets"][number]> & { toolKey?: PodArtworkExecutionRecord["toolKey"] } = {}): PodArtworkExecutionRecord {
  return {
    id: ids.task,
    designTaskId: ids.designTask,
    toolKey: overrides.toolKey ?? "pattern_crop",
    parameterSnapshot: overrides.toolKey === "authorized_watermark_remove"
      ? {}
      : overrides.toolKey === "rights_risk_scan"
        ? rightsRiskParameters()
      : overrides.toolKey && creativeDesignTools.includes(overrides.toolKey as CreativeDesignTool)
        ? creativeDesignParameters(overrides.toolKey as CreativeDesignTool)
      : overrides.toolKey && listingAssetTools.includes(overrides.toolKey as ListingAssetTool)
        ? listingAssetParameters(overrides.toolKey as ListingAssetTool)
      : overrides.toolKey === "piece_compose"
        ? pieceComposeParameters()
        : overrides.toolKey === "piece_extract"
          ? pieceExtractParameters()
          : overrides.toolKey === "uv_layers"
            ? uvLayersParameters()
            : overrides.toolKey === "product_video"
              ? productVideoParameters()
              : overrides.toolKey === "print_extract"
                ? printExtractParameters()
                : overrides.toolKey && ["background_remove", "super_resolution", "outpaint", "crop_compress", "vectorize"].includes(overrides.toolKey)
                  ? patternProcessingParameters(overrides.toolKey as "background_remove" | "super_resolution" | "outpaint" | "crop_compress" | "vectorize")
                  : patternCropParameters(),
    inputAssets: [{
      id: ids.asset,
      version: 1,
      checksumSha256: "a".repeat(64),
      domain: overrides.domain ?? "authorized",
      rightsStatus: overrides.rightsStatus ?? "approved",
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: "image/png",
    }],
    modelKey: "pod.crop.v1",
    maxAttempts: 3,
  };
}

function memoryGateway(result = successResult()): PodArtworkGateway & { called: boolean } {
  const gateway: PodArtworkGateway & { called: boolean } = {
    called: false,
    execute: async () => {
      gateway.called = true;
      return result;
    },
  };
  return gateway;
}

function patternCropParameters(overrides: Record<string, unknown> = {}) {
  return {
    mode: "general",
    multiCrop: false,
    maximumCropsPerInput: 1,
    outputFormat: "png",
    background: "preserved",
    perspectiveCorrection: true,
    cropPaddingPercent: 2,
    resultLabel: "front-print",
    ...overrides,
  };
}

function patternCropResult(multiCrop = false): PodArtworkExecutionResult {
  const checks = [{
    fileName: "crop-1.png", inputOrdinal: 0, cropIndex: 0,
    sourceBounds: { x: 0.1, y: 0.1, width: 0.35, height: 0.6 },
    outputWidth: 1200, outputHeight: 1800, transparent: false,
    perspectiveCorrectionValidated: true, cropComplete: true, resultLabel: "front-print",
  }, ...(multiCrop ? [{
    fileName: "crop-2.png", inputOrdinal: 0, cropIndex: 1,
    sourceBounds: { x: 0.55, y: 0.12, width: 0.35, height: 0.55 },
    outputWidth: 1200, outputHeight: 1650, transparent: false,
    perspectiveCorrectionValidated: true, cropComplete: true, resultLabel: "front-print",
  }] : [])];
  return {
    outputs: checks.map((check, index) => ({
      bytes: Uint8Array.from([index + 1, 2, 3]),
      mediaType: "image/png" as const,
      role: "effect" as const,
      fileName: check.fileName,
      metadata: {
        width: check.outputWidth, height: check.outputHeight, unit: "px" as const,
        colorMode: "rgb" as const, transparent: false, aiInference: "none" as const,
      },
    })),
    modelKey: "pod.pattern-crop.v1",
    modelVersion: "2026-08-04",
    qualityCheckSnapshot: {
      passed: true, mode: "general", inputCoverageComplete: true, cropBoundsValid: true,
      blankOutputsDetected: false, duplicateOutputsDetected: false, outputChecks: checks,
    },
    partial: false,
  };
}

function printExtractParameters() {
  return {
    mode: "transparent",
    targetScenario: "apparel",
    correctionStrength: "strong",
    restoreOccludedAreas: true,
    markInferredAreas: true,
    outputFormat: "png",
    outputBackground: "transparent",
    minimumCompleteness: 0.9,
  };
}

function printExtractResult(): PodArtworkExecutionResult {
  const inferenceRegion = { x: 300, y: 420, width: 200, height: 160 };
  return {
    outputs: [{
      bytes: Uint8Array.from([1, 2, 3]), mediaType: "image/png", role: "effect", fileName: "extracted-print.png",
      metadata: {
        width: 2400, height: 3000, unit: "px", colorMode: "rgb", transparent: true,
        aiInference: "partial", inferenceRegions: [inferenceRegion],
      },
    }],
    modelKey: "pod.print-extract.v1",
    modelVersion: "2026-08-04",
    qualityCheckSnapshot: {
      passed: true, mode: "transparent", inputCoverageComplete: true, aiInferencePresent: true,
      inferredAreasMarked: true, blankOutputsDetected: false, duplicateOutputsDetected: false,
      outputChecks: [{
        fileName: "extracted-print.png", inputOrdinal: 0, width: 2400, height: 3000, transparent: true,
        perspectiveCorrectionValidated: true, deformationCorrectionValidated: true,
        cropCoverageComplete: true, completeness: 0.96,
        inferredRegions: [{ ...inferenceRegion, reason: "occlusion", confidence: 0.82, marked: true }],
      }],
    },
    partial: false,
  };
}

function rightsRiskParameters() {
  return {
    depth: "deep",
    visualSimilarity: true,
    marketplaces: ["amazon", "etsy"],
    searchTerms: ["original botanical print"],
    validityDays: 30,
  };
}

function rightsRiskResult(): PodArtworkExecutionResult {
  const checkedAt = "2026-08-04T06:00:00.000Z";
  const fileName = "rights-risk-1.json";
  const report = {
    inputOrdinal: 0,
    legalRisk: "low",
    checkedAt,
    disclaimer: "auxiliary_non_legal_opinion",
    evidenceCount: 1,
    visualSimilarityPermille: 180,
  };
  return {
    outputs: [{
      bytes: new TextEncoder().encode(JSON.stringify(report)),
      mediaType: "text/plain",
      role: "effect",
      fileName,
      metadata: { aiInference: "none" },
    }],
    modelKey: "pod.rights-risk.v1",
    modelVersion: "2026-08-04",
    qualityCheckSnapshot: {
      passed: true,
      depth: "deep",
      disclaimer: "auxiliary_non_legal_opinion",
      checkedAt,
      validUntil: "2026-09-03T06:00:00.000Z",
      ruleVersion: "rights-rules-2026-08-04",
      detectorModelKey: "pod.rights-risk.v1",
      detectorModelVersion: "2026-08-04",
      sourceChecks: [
        { sourceKey: "trademark_registry", sourceVersion: "2026-08-03", checkedAt, status: "complete" },
        { sourceKey: "tro_records", sourceVersion: "2026-08-04", checkedAt, status: "complete" },
        { sourceKey: "copyright_registry", sourceVersion: "2026-08-01", checkedAt, status: "complete" },
        { sourceKey: "web_evidence", sourceVersion: "crawler-12", checkedAt, status: "complete" },
      ],
      missingSourceKeys: [],
      inputCoverageComplete: true,
      highRiskDetected: false,
      unknownRiskDetected: false,
      outputChecks: [{
        fileName,
        inputOrdinal: 0,
        legalRisk: "low",
        confidence: 0.88,
        ruleHits: [],
        evidence: [{
          evidenceId: "registry-clearance",
          kind: "trademark_registry",
          reference: "registry://fixture/search-42",
          title: "Trademark registry search snapshot",
          checkedAt,
          accessible: true,
          contentHashSha256: "b".repeat(64),
        }],
        visualSimilarityEvaluated: true,
        visualSimilarityPermille: 180,
        visualCandidateCount: 3,
        manualReviewRequired: true,
        downstreamBlocked: false,
      }],
      processorDeploymentId: "fixture-rights-risk-v1",
    },
    partial: false,
  };
}

type CreativeDesignTool =
  | "design_variation"
  | "product_print_variation"
  | "instruction_edit"
  | "text_to_image"
  | "element_fusion"
  | "licensed_brand_fusion"
  | "series_design"
  | "style_reference"
  | "style_transfer"
  | "canvas_extend"
  | "seamless_pattern"
  | "seamless_stitch"
  | "print_composite"
  | "meme_print";

const creativeDesignTools: CreativeDesignTool[] = [
  "design_variation",
  "product_print_variation",
  "instruction_edit",
  "text_to_image",
  "element_fusion",
  "licensed_brand_fusion",
  "series_design",
  "style_reference",
  "style_transfer",
  "canvas_extend",
  "seamless_pattern",
  "seamless_stitch",
  "print_composite",
  "meme_print",
];

function creativeDesignParameters(toolKey: CreativeDesignTool) {
  const prompt = toolKey === "text_to_image" ? "original floral pattern" : "";
  return {
    designTool: toolKey,
    prompt,
    referenceStrength: 70,
    creativity: toolKey === "seamless_stitch" ? 0 : 50,
    aspectRatio: "1:1",
    outputCount: 1,
    outputFormat: "png",
    markAiGenerated: toolKey !== "seamless_stitch",
    markGeneratedAreas: true,
    ...(toolKey === "series_design" ? { batchPrompts: ["main", "companion"] } : {}),
    ...(toolKey === "seamless_pattern" || toolKey === "seamless_stitch"
      ? { repeatType: "four_way", seamCheckRequired: true, tilePreviewRequired: true }
      : {}),
  };
}

function creativeDesignResult(toolKey: CreativeDesignTool, inputCount: number): PodArtworkExecutionResult {
  const parameters = creativeDesignParameters(toolKey);
  const batchPrompts = "batchPrompts" in parameters && Array.isArray(parameters.batchPrompts) ? parameters.batchPrompts : [];
  const promptMaterial = [parameters.prompt, ...batchPrompts].join("\n");
  const canvasExtension = toolKey === "canvas_extend";
  const deterministic = toolKey === "seamless_stitch";
  const seamless = toolKey === "seamless_pattern" || deterministic;
  const aiInference = deterministic ? "none" : canvasExtension ? "partial" : "full";
  const generatedRegions = canvasExtension
    ? [{ x: 0, y: 0, width: 1_200, height: 200, reason: "crop_loss" as const, confidence: 0.94, marked: true }]
    : [];
  const fileName = `${toolKey}.png`;
  const sourceInputOrdinals = Array.from({ length: inputCount }, (_, index) => index);
  return {
    outputs: [{
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: "image/png",
      role: "effect",
      fileName,
      metadata: {
        width: 1_200,
        height: 1_200,
        unit: "px",
        colorMode: "rgb",
        transparent: false,
        aiInference,
        ...(generatedRegions.length ? { inferenceRegions: generatedRegions } : {}),
      },
    }],
    modelKey: `pod.${toolKey}.v1`,
    modelVersion: "2026-08-04",
    ...(deterministic ? {} : { seed: "42" }),
    qualityCheckSnapshot: {
      passed: true,
      toolKey,
      inputCoverageComplete: true,
      outputCountMatched: true,
      duplicateOutputsDetected: false,
      finalPromptHashSha256: createHash("sha256").update(promptMaterial, "utf8").digest("hex"),
      outputChecks: [{
        fileName,
        outputIndex: 0,
        sourceInputOrdinals,
        width: 1_200,
        height: 1_200,
        format: "png",
        transparent: false,
        aiInference,
        generatedRegions,
        promptSafetyPassed: true,
        contentSafetyPassed: true,
        textDetected: false,
        textReviewRequired: false,
        sourceIdentityPreserved: true,
        ...(seamless ? { horizontalSeamPassed: true, verticalSeamPassed: true, tilePreviewValidated: true } : {}),
      }],
      processorDeploymentId: "fixture-creative-design-v1",
    },
    partial: false,
  };
}

type ListingAssetTool = "product_suite" | "title_draft" | "virtual_try_on" | "background_replace";

const listingAssetTools: ListingAssetTool[] = ["product_suite", "title_draft", "virtual_try_on", "background_replace"];

function listingAssetParameters(toolKey: ListingAssetTool) {
  const common = { listingTool: toolKey, platform: "amazon", locale: "en-US", outputCount: 1, markAiGenerated: true };
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

function listingAssetResult(toolKey: ListingAssetTool, inputCount: number, partial = false): PodArtworkExecutionResult {
  const sourceInputOrdinals = Array.from({ length: inputCount }, (_, index) => index);
  const title = "Floral Print Black Cotton T-Shirt";
  const titleBytes = new TextEncoder().encode(title);
  const titleOutput = toolKey === "title_draft";
  const background = toolKey === "background_replace";
  const generatedRegions = background
    ? [{ x: 0, y: 0, width: 1_200, height: 1_200, reason: "background" as const, confidence: 0.96, marked: true }]
    : [];
  const fileName = titleOutput ? "title-1.txt" : `${toolKey}-1.png`;
  const outputCheck = titleOutput ? {
    fileName, outputIndex: 0, sourceInputOrdinals, contentKind: "title" as const,
    title, characterCount: [...title].length, byteCount: titleBytes.byteLength,
    contentHashSha256: createHash("sha256").update(titleBytes).digest("hex"),
    factsMatched: true, unsupportedFactKeys: [], keywordSources: ["floral shirt"],
    platformRuleVersionMatched: true, trademarkRiskChecked: true,
    textReviewRequired: true, contentSafetyPassed: true,
  } : {
    fileName, outputIndex: 0, sourceInputOrdinals, contentKind: "image" as const,
    slotKey: "main", width: 1_200, height: 1_200, format: "png" as const, transparent: false,
    aiInference: background ? "partial" as const : "full" as const, generatedRegions,
    productIdentityPreserved: true, categoryIdentityPassed: true, printPlacementPreserved: true,
    approvedFactsOnly: true, contentSafetyPassed: true, textDetected: false, textReviewRequired: false,
    ...(toolKey === "virtual_try_on" ? { modelLicenseVerified: true as const } : {}),
    ...(background ? { backgroundOnlyChanged: true as const } : {}),
  };
  return {
    outputs: [{
      bytes: titleOutput ? titleBytes : Uint8Array.from([1, 2, 3]),
      mediaType: titleOutput ? "text/plain" : "image/png",
      role: "effect",
      fileName,
      metadata: titleOutput ? { aiInference: "full" } : {
        width: 1_200, height: 1_200, unit: "px", colorMode: "rgb", transparent: false,
        aiInference: background ? "partial" : "full",
        ...(generatedRegions.length ? { inferenceRegions: generatedRegions } : {}),
      },
    }],
    modelKey: `pod.${toolKey}.v1`, modelVersion: "2026-08-04", seed: "73",
    qualityCheckSnapshot: {
      passed: true, toolKey, platform: "amazon", locale: "en-US",
      requestedOutputCount: partial ? 2 : 1, successfulOutputCount: 1, failedOutputCount: partial ? 1 : 0,
      inputCoverageComplete: true, duplicateOutputsDetected: false, outputChecks: [outputCheck],
      failedOutputs: partial ? [{ outputIndex: 1, slotKey: "alternate", errorCode: "PROCESSOR_SLOT_FAILED", safeMessage: "候选槽位生成失败" }] : [],
      processorDeploymentId: "fixture-listing-assets-v1",
    },
    partial,
  };
}

type PatternProcessingTool = "background_remove" | "super_resolution" | "outpaint" | "crop_compress" | "vectorize" | "authorized_watermark_remove";

function patternProcessingParameters(toolKey: PatternProcessingTool): Record<string, string | number | boolean | string[]> {
  if (toolKey === "background_remove") return { edgeRefinement: true, preserveShadow: false, outputFormat: "png" };
  if (toolKey === "super_resolution") return { scale: 2, dpi: 300, denoise: 20, sharpen: 15, outputFormat: "png" };
  if (toolKey === "outpaint") return { aspectRatio: "1:1", direction: "all", outputFormat: "png", markGeneratedAreas: true };
  if (toolKey === "crop_compress") return { width: 800, height: 1000, quality: 90, dpi: 300, format: "png", colorSpace: "rgb", preserveTransparency: true };
  if (toolKey === "vectorize") return { format: "svg", colorCount: 16, smoothing: true, closePaths: true, colorMode: "rgb" };
  return { rightsAttested: true, regionDescription: "右下角授权水印", outputFormat: "png", markInferredAreas: true };
}

function patternProcessingResult(toolKey: PatternProcessingTool): PodArtworkExecutionResult {
  const vector = toolKey === "vectorize";
  const superResolution = toolKey === "super_resolution";
  const generated = superResolution || toolKey === "outpaint" || toolKey === "authorized_watermark_remove";
  const crop = toolKey === "crop_compress";
  const width = crop ? 800 : superResolution ? 1000 : toolKey === "outpaint" ? 1200 : 1000;
  const height = crop ? 1000 : superResolution ? 1200 : toolKey === "outpaint" ? 1200 : 1200;
  const format = vector ? "svg" : "png";
  const generatedRegion = superResolution
    ? { x: 0, y: 0, width, height }
    : { x: 50, y: 60, width: 120, height: 100 };
  const transparent = toolKey === "background_remove" || crop || vector;
  const sourceWidth = superResolution ? 500 : toolKey === "background_remove" ? width : undefined;
  const sourceHeight = superResolution ? 600 : toolKey === "background_remove" ? height : undefined;
  const fileName = vector ? "vectorized.svg" : `${toolKey}.png`;
  return {
    outputs: [{
      bytes: vector ? new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0Z"/></svg>') : Uint8Array.from([1, 2, 3]),
      mediaType: vector ? "image/svg+xml" : "image/png",
      role: "effect",
      fileName,
      metadata: {
        width, height, unit: "px", ...(vector ? {} : { dpi: 300 }),
        colorMode: "rgb", transparent,
        aiInference: superResolution ? "full" : generated ? "partial" : "none",
        ...(generated ? { inferenceRegions: [generatedRegion] } : {}),
      },
    }],
    modelKey: `pod.${toolKey}.v1`,
    modelVersion: "2026-08-04",
    qualityCheckSnapshot: {
      passed: true, toolKey, inputCoverageComplete: true, blankOutputsDetected: false,
      artifactDetected: false, generatedAreasMarked: true,
      outputChecks: [{
        fileName, inputOrdinal: 0, operation: toolKey, format,
        width, height, ...(vector ? {} : { dpi: 300 }), colorMode: "rgb", transparent,
        ...(sourceWidth ? { sourceWidth } : {}), ...(sourceHeight ? { sourceHeight } : {}),
        ...(vector ? { pathCount: 12, pathsClosed: true } : {}),
        generatedRegions: generated ? [{
          ...generatedRegion,
          reason: superResolution ? "enhancement" : toolKey === "outpaint" ? "crop_loss" : "occlusion",
          confidence: 0.9,
          marked: true,
        }] : [],
        edgeQualityPassed: true, dimensionsMatched: true, formatMatched: true,
      }],
    },
    partial: false,
  };
}

function pieceComposeParameters() {
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
  };
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
    pieceDefinitions: ["front|前片|0|none", "back|后片|180|horizontal"],
    printArea: "裁片边界内缩 10mm",
    seamAllowanceMm: 10,
    outputFormat: "png",
    preserveTransparency: true,
    minimumConfidence: 0.9,
    templateDraftName: "双面上衣裁片草稿",
  };
}

function pieceExtractResult(): PodArtworkExecutionResult {
  const imageMetadata = {
    unit: "mm" as const,
    dpi: 300,
    colorMode: "cmyk" as const,
    transparent: true,
    aiInference: "none" as const,
  };
  return {
    outputs: [
      { bytes: Uint8Array.from([1]), mediaType: "image/png", role: "production", fileName: "full-canvas.png", metadata: { ...imageMetadata, width: 300, height: 400 } },
      { bytes: Uint8Array.from([2]), mediaType: "image/png", role: "production", fileName: "front.png", metadata: { ...imageMetadata, width: 140, height: 300 } },
      { bytes: Uint8Array.from([3]), mediaType: "image/png", role: "production", fileName: "back.png", metadata: { ...imageMetadata, width: 140, height: 300 } },
      { bytes: Uint8Array.from([4]), mediaType: "application/zip", role: "production", fileName: "template-draft.zip", metadata: { aiInference: "none" } },
    ],
    modelKey: "pod.piece-extract.v1",
    modelVersion: "2026-08-04",
    qualityCheckSnapshot: {
      passed: true,
      extractionMode: "separate",
      canvasMatched: true,
      dpiMatched: true,
      colorModeMatched: true,
      blankPieceKeys: [],
      duplicatePieceKeys: [],
      unexpectedPieceKeys: [],
      lowConfidencePieceKeys: ["back"],
      regions: [
        {
          pieceKey: "front", displayName: "前片", inputOrdinal: 0,
          x: 0, y: 0, width: 140, height: 300, unit: "mm",
          rotationDegrees: 0, flipMode: "none", boundaryClosed: true,
          printAreaDetected: true, seamLineRecorded: true, confidence: 0.98,
          manualConfirmationRequired: false, outputFileName: "front.png",
        },
        {
          pieceKey: "back", displayName: "后片", inputOrdinal: 0,
          x: 160, y: 0, width: 140, height: 300, unit: "mm",
          rotationDegrees: 180, flipMode: "horizontal", boundaryClosed: true,
          printAreaDetected: true, seamLineRecorded: true, confidence: 0.85,
          manualConfirmationRequired: true, outputFileName: "back.png",
        },
      ],
      templateDraft: {
        name: "双面上衣裁片草稿", fileName: "template-draft.zip",
        status: "awaiting_confirmation", stableKeysComplete: true,
      },
      outputChecks: [
        { fileName: "full-canvas.png", kind: "full_canvas", pieceKeys: ["front", "back"], dimensionsValid: true, colorModeValid: true, formatValid: true },
        { fileName: "front.png", kind: "piece", pieceKeys: ["front"], dimensionsValid: true, colorModeValid: true, formatValid: true },
        { fileName: "back.png", kind: "piece", pieceKeys: ["back"], dimensionsValid: true, colorModeValid: true, formatValid: true },
        { fileName: "template-draft.zip", kind: "template_package", pieceKeys: ["front", "back"], dimensionsValid: true, colorModeValid: true, formatValid: true },
      ],
    },
    partial: false,
  };
}

function uvLayersParameters() {
  return {
    width: 300,
    height: 400,
    unit: "mm",
    dpi: 300,
    colorMode: "cmyk",
    separationMode: "automatic",
    layerPrefix: "uv",
    supplierChannelProfile: "supplier-uv-v1",
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
  };
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
    captionMode: "product_title",
    soundtrackMode: "none",
    soundtrackRightsAttested: false,
    allowAiMotion: true,
    safeArea: true,
  };
}

function productVideoResult(): PodArtworkExecutionResult {
  return {
    outputs: [{
      bytes: Uint8Array.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]),
      mediaType: "video/mp4",
      role: "effect",
      fileName: "product-video.mp4",
      metadata: {
        width: 1080,
        height: 1920,
        unit: "px",
        colorMode: "rgb",
        transparent: false,
        durationSeconds: 15,
        fps: 30,
        videoCodec: "h264",
        audioCodec: "none",
        aiInference: "full",
      },
    }],
    modelKey: "pod.product-video.v1",
    modelVersion: "2026-08-04",
    qualityCheckSnapshot: {
      passed: true,
      durationMatched: true,
      fpsMatched: true,
      dimensionsMatched: true,
      inputCoverageComplete: true,
      playbackValid: true,
      blankFramesDetected: false,
      corruptFramesDetected: false,
      safeAreaPassed: true,
      captionOverflowDetected: false,
      audioClippingDetected: false,
      soundtrackLicenseMatched: true,
      aiMotionEvidenceMatched: true,
      outputChecks: [{
        fileName: "product-video.mp4",
        usedInputOrdinals: [0],
        durationSeconds: 15,
        fps: 30,
        width: 1080,
        height: 1920,
        videoCodec: "h264",
        audioCodec: "none",
      }],
    },
    partial: false,
  };
}

function uvLayersResult(withConflict = false): PodArtworkExecutionResult {
  const metadata = {
    width: 300, height: 400, unit: "mm" as const, dpi: 300,
    colorMode: "cmyk" as const, transparent: true, aiInference: "none" as const,
  };
  const layerDefinitions = [
    { layerKey: "artwork", displayName: "彩墨层", channel: "color", order: 0, outputFileName: "uv-artwork.png" },
    { layerKey: "white", displayName: "白墨层", channel: "white_ink", order: 1, outputFileName: "uv-white.png" },
    { layerKey: "varnish", displayName: "光油层", channel: "varnish", order: 2, outputFileName: "uv-varnish.png" },
  ] as const;
  return {
    outputs: [
      ...layerDefinitions.map((layer, index) => ({
        bytes: Uint8Array.from([index + 1]), mediaType: "image/png" as const,
        role: "production" as const, fileName: layer.outputFileName, metadata,
      })),
      { bytes: Uint8Array.from([4]), mediaType: "image/png", role: "production", fileName: "uv-preview.png", metadata },
      { bytes: Uint8Array.from([5]), mediaType: "application/zip", role: "production", fileName: "uv-layers.zip", metadata: { aiInference: "none" } },
    ],
    modelKey: "pod.uv-layers.v1",
    modelVersion: "2026-08-04",
    qualityCheckSnapshot: {
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
      layers: layerDefinitions.map((layer) => ({
        ...layer,
        opacity: 1,
        sourceInputOrdinal: 0,
        sourcePixelCount: 50_000,
        conflictPixelCount: withConflict && layer.layerKey !== "varnish" ? 120 : 0,
        width: 300,
        height: 400,
        unit: "mm",
        transparent: true,
      })),
      conflictRegions: withConflict ? [{
        regionKey: "conflict-1", x: 20, y: 30, width: 10, height: 12, unit: "mm",
        reason: "ambiguous_overlap", candidateLayerKeys: ["artwork", "white"], confidence: 0.62,
      }] : [],
      outputChecks: [
        ...layerDefinitions.map((layer) => ({ fileName: layer.outputFileName, kind: "layer", layerKeys: [layer.layerKey], dimensionsValid: true, transparencyValid: true, channelProfileValid: true })),
        { fileName: "uv-preview.png", kind: "composite_preview", layerKeys: ["artwork", "white", "varnish"], dimensionsValid: true, transparencyValid: true, channelProfileValid: true },
        { fileName: "uv-layers.zip", kind: "layer_package", layerKeys: ["artwork", "white", "varnish"], dimensionsValid: true, transparencyValid: true, channelProfileValid: true },
      ],
    },
    partial: false,
  };
}

function pieceComposeResult(): PodArtworkExecutionResult {
  return {
    outputs: [{
      bytes: Uint8Array.from([4, 5, 6]),
      mediaType: "image/tiff",
      role: "production",
      fileName: "front-layout.tiff",
      metadata: {
        width: 300,
        height: 400,
        unit: "mm",
        dpi: 300,
        colorMode: "cmyk",
        transparent: false,
        aiInference: "none",
      },
    }],
    modelKey: "pod.piece-layout.v1",
    modelVersion: "2026-08-04",
    qualityCheckSnapshot: {
      passed: true,
      layoutMode: "automatic",
      positioningTemplateMatched: true,
      dimensionsMatched: true,
      colorModeMatched: true,
      minimumDpiPassed: true,
      overlapDetected: false,
      outOfBoundsDetected: false,
      blankPieceKeys: [],
      placements: [{
        pieceKey: "front",
        inputOrdinal: 0,
        x: 20,
        y: 30,
        width: 260,
        height: 340,
        unit: "mm",
        rotationDegrees: 0,
        scaleX: 1,
        scaleY: 1,
        effectiveDpi: 300,
        insidePrintArea: true,
        seamLinePreserved: true,
      }],
      outputChecks: [{
        fileName: "front-layout.tiff",
        pieceKeys: ["front"],
        dimensionsValid: true,
        colorModeValid: true,
      }],
    },
    partial: false,
  };
}

function successResult(): PodArtworkExecutionResult {
  return patternCropResult();
}

function memoryRepository(record: PodArtworkExecutionRecord): PodArtworkExecutionRepository & {
  claimed: boolean;
  completed: boolean;
  failure?: { attempt: number; terminal: boolean; code: string; message: string };
} {
  const repository: PodArtworkExecutionRepository & {
    claimed: boolean;
    completed: boolean;
    failure?: { attempt: number; terminal: boolean; code: string; message: string };
  } = {
    claimed: false,
    completed: false,
    load: async () => record,
    claim: async () => { repository.claimed = true; return true; },
    complete: async (_context, _task, result) => {
      repository.completed = true;
      if (record.toolKey === "piece_compose") {
        expect(result).toMatchObject({
          modelKey: "pod.piece-layout.v1",
          modelVersion: "2026-08-04",
          qualityCheckSnapshot: { passed: true, overlapDetected: false, outOfBoundsDetected: false },
        });
      } else if (record.toolKey === "piece_extract") {
        expect(result).toMatchObject({
          modelKey: "pod.piece-extract.v1",
          qualityCheckSnapshot: {
            passed: true,
            lowConfidencePieceKeys: ["back"],
            templateDraft: { status: "awaiting_confirmation" },
          },
        });
      } else if (record.toolKey === "uv_layers") {
        expect(result).toMatchObject({
          modelKey: "pod.uv-layers.v1",
          qualityCheckSnapshot: { separationMode: "automatic" },
        });
      } else if (record.toolKey === "product_video") {
        expect(result).toMatchObject({
          modelKey: "pod.product-video.v1",
          qualityCheckSnapshot: { passed: true, inputCoverageComplete: true, blankFramesDetected: false },
        });
      } else if (record.toolKey === "pattern_crop") {
        expect(result).toMatchObject({
          modelKey: "pod.pattern-crop.v1",
          qualityCheckSnapshot: { passed: true, inputCoverageComplete: true, cropBoundsValid: true },
        });
      } else if (record.toolKey === "print_extract") {
        expect(result).toMatchObject({
          modelKey: "pod.print-extract.v1",
          qualityCheckSnapshot: { passed: true, aiInferencePresent: true, inferredAreasMarked: true },
        });
      } else {
        expect(result).toMatchObject({ qualityCheckSnapshot: { passed: true } });
      }
    },
    fail: async (_context, _taskId, input) => { repository.failure = input; },
  };
  return repository;
}

function envelope(): JobEnvelope {
  return {
    jobId: "019f0000-0000-7000-8000-000000000006",
    tenantId: ids.tenant,
    requestedBy: ids.user,
    traceId: "0123456789abcdef0123456789abcdef",
    correlationId: ids.task,
    idempotencyKey: "019f0000-0000-7000-8000-000000000007",
    requestedAt: "2026-08-03T06:00:00.000Z",
    attempt: 0,
    maxAttempts: 3,
    payload: { taskId: ids.task },
  };
}
