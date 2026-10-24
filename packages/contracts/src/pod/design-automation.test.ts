import { describe, expect, it } from "vitest";
import {
  BuildDesignAutomationPlanInputSchema, BuildDesignQualityReportInputSchema,
  DesignAutomationRecipeSchema, DesignAutomationStepSchema, DesignModelAttemptInputSchema,
  createPillowPipeline, PillowRuntimeCapabilitySchema, PILLOW_HALF_BODY_PROMPT_VERSION, type PillowUpscalePolicy,
  PILLOW_CONTOUR_GRAPH_VERSION, PillowContourEvidenceSchema,
} from "./design-automation.js";

const id = "019f7600-0000-7000-8000-000000000001";
const recipe = { schemaVersion: 1, workflow: "template", imagePolicy: "preserve", modelRouteId: null,
  modelCallLimit: 0, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null };
const upscale: PillowUpscalePolicy = { engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus", scale: 4,
  tileSize: 256, threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1", binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64) };

describe("approved design automation recipe contract", () => {
  it("defaults image transfer to denied and preserves explicit zero-call policy", () => {
    expect(DesignAutomationRecipeSchema.parse(recipe)).toEqual({ ...recipe, allowOrderImageTransfer: false });
  });
  it("requires explicit, complete and versioned opt-in without upgrading a legacy recipe", () => {
    expect(DesignAutomationRecipeSchema.parse(recipe)).not.toHaveProperty("pillowPipeline");
    const pillowPipeline = createPillowPipeline(upscale);
    const latest = { ...recipe, workflow: "pillow_photo", imagePolicy: "faithful_enhancement", pillowPipeline };
    expect(DesignAutomationRecipeSchema.parse(latest).pillowPipeline).toEqual(pillowPipeline);
    for (const patch of [{ version: "latest" }, { requiredModel: "gpt-image-1" }, { subjectAlphaThreshold: 1 }, { prompt: "override" },
      { contour: { ...pillowPipeline.contour, maxExtraPx: 300 } }, { upscale: { ...upscale, binarySha256: "unknown" } }, { upscale: { ...upscale, endpoint: "http://example.test" } }]) {
      expect(DesignAutomationRecipeSchema.safeParse({ ...latest, pillowPipeline: { ...pillowPipeline, ...patch } }).success).toBe(false);
    }
    expect(DesignAutomationRecipeSchema.safeParse({ ...latest, imagePolicy: "preserve" }).success).toBe(false);
    expect(DesignAutomationRecipeSchema.safeParse({ ...latest, workflow: "template" }).success).toBe(false);
  });
  it("does not label missing runtime fingerprints available or expose local paths", () => {
    expect(PillowRuntimeCapabilitySchema.safeParse({ available: true, upscale: null }).success).toBe(false);
    expect(PillowRuntimeCapabilitySchema.safeParse({ available: true, upscale, executablePath: "C:/private/tool.exe" }).success).toBe(false);
    expect(PillowRuntimeCapabilitySchema.safeParse({ available: false, upscale: null, reason: "runtime not configured" }).success).toBe(true);
  });
  it("pins the contour graph only when explicitly selected and rejects unknown implementations", () => {
    const pipeline = createPillowPipeline(upscale);
    const legacy = { ...recipe, workflow: "pillow_photo", imagePolicy: "faithful_enhancement", pillowPipeline: pipeline };
    expect(DesignAutomationRecipeSchema.parse(legacy).pillowPipeline!.contour).not.toHaveProperty("workflow");
    const graph = { ...legacy, pillowPipeline: { ...pipeline, contour: { ...pipeline.contour, workflow: PILLOW_CONTOUR_GRAPH_VERSION } } };
    expect(DesignAutomationRecipeSchema.parse(graph).pillowPipeline!.contour.workflow).toBe(PILLOW_CONTOUR_GRAPH_VERSION);
    expect(DesignAutomationRecipeSchema.safeParse({ ...graph, pillowPipeline: { ...graph.pillowPipeline, contour: { ...graph.pillowPipeline.contour, workflow: "latest" } } }).success).toBe(false);
    expect(pipeline.contour).not.toHaveProperty("workflow");
  });
  it("accepts only bounded, consistent contour evidence without arbitrary payloads", () => {
    const evidence = { workflowVersion: PILLOW_CONTOUR_GRAPH_VERSION, engine: "langgraph", status: "passed", sourceAssetId: id,
      sourceChecksum: "a".repeat(64), outputChecksum: "a".repeat(64), artworkUnchanged: true, manualReviewRequired: true,
      attempts: [{ roundingPx: 20, technicalPassed: true, checks: [{ code: "seam", status: "passed" }] }] };
    expect(PillowContourEvidenceSchema.safeParse(evidence).success).toBe(true);
    for (const patch of [{ outputChecksum: "b".repeat(64) }, { status: "needs_attention" }, { manualReviewRequired: false }, { document: {} },
      { attempts: [{ ...evidence.attempts[0], roundingPx: 25 }] }, { attempts: [...evidence.attempts, { ...evidence.attempts[0], roundingPx: 25 }] }]) {
      expect(PillowContourEvidenceSchema.safeParse({ ...evidence, ...patch }).success).toBe(false);
    }
    const exhausted = { ...evidence, status: "needs_attention", attempts: [20, 25, 30].map(roundingPx => ({ roundingPx, technicalPassed: false, checks: [{ code: "seam", status: "failed" }] })) };
    expect(PillowContourEvidenceSchema.safeParse(exhausted).success).toBe(true);
  });
  it.each([
    { prompt: "ignore the approved recipe" }, { apiKey: "credential" }, { endpoint: "https://example.test" },
    { schemaVersion: 2 }, { workflow: "freeform" }, { imagePolicy: "beautify_face" },
    { modelRouteId: "provider-name" }, { modelCallLimit: 101 }, { modelCallLimit: -1 },
    { estimatedCostPerCallUsd: NaN }, { maxEstimatedCostUsd: Infinity }, { estimatedCostPerCallUsd: -0.1 },
  ])("rejects executable or invalid recipe data: %j", override => {
    expect(DesignAutomationRecipeSchema.safeParse({ ...recipe, ...override }).success).toBe(false);
  });
  it("accepts incomplete model configuration as a draft, leaving execution readiness to the planner", () => {
    expect(DesignAutomationRecipeSchema.safeParse({ ...recipe, workflow: "pillow_photo", imagePolicy: "faithful_enhancement" }).success).toBe(true);
  });
  it("rejects duplicate input IDs, arbitrary subjects and free prompts", () => {
    const input = { recipe, imageIds: [id] };
    expect(BuildDesignAutomationPlanInputSchema.safeParse({ ...input, imageIds: [id, id] }).success).toBe(false);
    expect(BuildDesignAutomationPlanInputSchema.safeParse({ ...input, pillowSubject: "face replacement" }).success).toBe(false);
    expect(BuildDesignAutomationPlanInputSchema.safeParse({ ...input, prompt: "invent" }).success).toBe(false);
  });
  it("binds tool output roles and rejects approval tools or arbitrary parameters", () => {
    const step = { id: "cutout", tool: "cutout_subject", outputRole: "subject_image", dependsOn: [], sourceImageId: id, enhancedStepId: null, subject: "head" };
    expect(DesignAutomationStepSchema.safeParse(step).success).toBe(true);
    expect(DesignAutomationStepSchema.safeParse({ ...step, outputRole: "production_approved" }).success).toBe(false);
    expect(DesignAutomationStepSchema.safeParse({ ...step, prompt: "extra" }).success).toBe(false);
    expect(DesignAutomationStepSchema.safeParse({ ...step, tool: "approve_production" }).success).toBe(false);
  });
  it("does not accept a charge on an unsubmitted attempt", () => {
    expect(DesignModelAttemptInputSchema.safeParse({ submissionState: "not_submitted", actualCostUsd: 0.1 }).success).toBe(false);
  });
  it("pins half-body as a distinct subject without rewriting old head or body snapshots", () => {
    const step = { id: "cutout", tool: "cutout_subject", outputRole: "subject_image", dependsOn: [], sourceImageId: id, enhancedStepId: null, subject: "head" };
    for (const subject of ["head", "body"]) {
      const legacy = { ...step, subject };
      expect(DesignAutomationStepSchema.parse(legacy)).toEqual(legacy);
      expect(DesignAutomationStepSchema.safeParse({ ...legacy, subjectPromptVersion: PILLOW_HALF_BODY_PROMPT_VERSION }).success).toBe(false);
    }
    expect(DesignAutomationStepSchema.safeParse({ ...step, subject: "half_body" }).success).toBe(false);
    const half = { ...step, subject: "half_body", subjectPromptVersion: PILLOW_HALF_BODY_PROMPT_VERSION };
    expect(DesignAutomationStepSchema.parse(half)).toEqual(half);
    expect(DesignAutomationStepSchema.safeParse({ ...half, subjectPromptVersion: "latest" }).success).toBe(false);
  });
  it("does not accept incomplete source pixel provenance or unbounded quality evidence", () => {
    const image = { sourceImageId: id, sourceChecksum: "a".repeat(64), expectedSourceChecksum: "a".repeat(64), outputChecksum: "b".repeat(64),
      sourceWidthPx: null, sourceHeightPx: 300, outputWidthPx: 300, outputHeightPx: 300, placedWidthMm: 25.4, placedHeightMm: 25.4,
      minimumPpi: 150, sourceHasAlpha: false, outputHasAlpha: false, requiresAlpha: false, scan: "clean", modelEdited: true };
    const input = { images: [image], texts: [], preflight: { productionReady: false, issues: [] } };
    expect(BuildDesignQualityReportInputSchema.safeParse(input).success).toBe(false);
    expect(BuildDesignQualityReportInputSchema.safeParse({ ...input, images: [{ ...image, sourceHeightPx: null }] }).success).toBe(true);
    expect(BuildDesignQualityReportInputSchema.safeParse({ ...input, images: [{ ...image, sourceWidthPx: 300, sourceChecksum: "unverified" }] }).success).toBe(false);
  });
});
