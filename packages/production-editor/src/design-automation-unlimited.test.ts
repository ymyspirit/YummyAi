import {
  createPillowPipeline, createPillowPipelineForModel, DesignAutomationPlanSchema,
  DesignAutomationRecipeSchema, PillowPipelineSchema,
  type BuildDesignQualityReportInput, type DesignAutomationRecipe, type PillowUpscalePolicy,
} from "@yummyai/contracts/pod/design-automation";
import { describe, expect, it } from "vitest";

import {
  assessDesignModelAttempt, buildDesignAutomationPlan,
  buildDesignQualityReport, evaluateDesignAutomationBudget,
} from "./design-automation.js";

const imageId = "019f0000-0000-7000-8000-000000000001";
const secondImageId = "019f0000-0000-7000-8000-000000000002";
const routeId = "019f0000-0000-7000-8000-000000000003";
const limited: DesignAutomationRecipe = {
  schemaVersion: 1, workflow: "template", imagePolicy: "faithful_enhancement",
  modelRouteId: routeId, allowOrderImageTransfer: true, modelCallLimit: 3,
  estimatedCostPerCallUsd: 0.1, maxEstimatedCostUsd: 0.3,
};
const unlimited: DesignAutomationRecipe = {
  ...limited, costPolicy: "unlimited", estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null,
};

describe("explicit unlimited design cost policy", () => {
  it("admits an explicitly unlimited unquoted plan without inventing estimates or actual cost", () => {
    const input = { recipe: unlimited, imageIds: [imageId, secondImageId] }, original = structuredClone(input);
    const plan = buildDesignAutomationPlan(input);
    expect(plan).toMatchObject({ status: "ready", blockers: [], plannedModelCalls: 2, automaticProductionApproval: false });
    expect(plan.budget).toEqual({
      allowed: true, blockers: [], plannedModelCalls: 2,
      estimatedCostPerCallUsd: null, estimatedCostUsd: null, maxEstimatedCostUsd: null,
      priceSource: "none", costBasis: "estimated", actualCostUsd: null,
    });
    expect(plan.recipe).toEqual(unlimited); expect(input).toEqual(original);
    expect(DesignAutomationPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it("keeps old absent-policy recipes unchanged and rejects unquoted or uncapped old plans", () => {
    const old = { ...limited, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null };
    expect(DesignAutomationRecipeSchema.parse(old)).toEqual(old);
    expect(Object.hasOwn(DesignAutomationRecipeSchema.parse(old), "costPolicy")).toBe(false);
    expect(evaluateDesignAutomationBudget({ recipe: old, plannedModelCalls: 1 })).toMatchObject({
      allowed: false, blockers: ["model_price_missing", "model_budget_missing"], actualCostUsd: null,
    });
    expect(evaluateDesignAutomationBudget({ recipe: { ...old, maxEstimatedCostUsd: 1 }, plannedModelCalls: 1 }).blockers).toEqual(["model_price_missing"]);
    expect(evaluateDesignAutomationBudget({ recipe: { ...old, estimatedCostPerCallUsd: 0.1 }, plannedModelCalls: 1 }).blockers).toEqual(["model_budget_missing"]);
    expect(evaluateDesignAutomationBudget({ recipe: { ...limited, maxEstimatedCostUsd: 0.09 }, plannedModelCalls: 1 }).blockers).toEqual(["model_budget_exceeded"]);
    expect(evaluateDesignAutomationBudget({ recipe: limited, plannedModelCalls: 1 })).toMatchObject({ allowed: true, estimatedCostUsd: 0.1, actualCostUsd: null });
  });

  it.each([0, 0.1, 1])("requires a null monetary cap when unlimited is explicit, rejecting cap %s", maxEstimatedCostUsd => {
    expect(DesignAutomationRecipeSchema.safeParse({ ...unlimited, maxEstimatedCostUsd }).success).toBe(false);
  });

  it.each([null, false, "bounded"])("rejects unsupported policy values instead of treating %s as unlimited", costPolicy => {
    expect(DesignAutomationRecipeSchema.safeParse({ ...unlimited, costPolicy }).success).toBe(false);
  });

  it("retains trusted pricing when available and keeps the actual charge unknown", () => {
    const budget = evaluateDesignAutomationBudget({
      recipe: { ...unlimited, estimatedCostPerCallUsd: 0.01 }, plannedModelCalls: 2,
      configuredEstimatedCostPerCallUsd: 0.27,
    });
    expect(budget).toMatchObject({
      allowed: true, blockers: [], priceSource: "configured", estimatedCostPerCallUsd: 0.27,
      estimatedCostUsd: 0.54, maxEstimatedCostUsd: null, actualCostUsd: null,
    });
    const quotedFree = evaluateDesignAutomationBudget({ recipe: unlimited, plannedModelCalls: 1, configuredEstimatedCostPerCallUsd: 0 });
    expect(quotedFree).toMatchObject({ allowed: true, priceSource: "configured", estimatedCostUsd: 0, actualCostUsd: null });
  });

  it.each([
    { change: { allowOrderImageTransfer: false }, blocker: "order_image_transfer_not_allowed" },
    { change: { modelRouteId: null }, blocker: "model_route_missing" },
    { change: { modelCallLimit: 0 }, blocker: "model_call_limit_exceeded" },
  ])("still blocks $blocker with no monetary cap", ({ change, blocker }) => {
    const plan = buildDesignAutomationPlan({ recipe: { ...unlimited, ...change }, imageIds: [imageId] });
    expect(plan).toMatchObject({ status: "blocked", blockers: [blocker], plannedModelCalls: 1, automaticProductionApproval: false });
    expect(plan.budget).toMatchObject({ allowed: false, blockers: [blocker], actualCostUsd: null });
  });

  it("retains all independent admission blockers together and enforces the schema's call-count boundary", () => {
    const budget = evaluateDesignAutomationBudget({
      recipe: { ...unlimited, allowOrderImageTransfer: false, modelRouteId: null, modelCallLimit: 0 }, plannedModelCalls: 2,
    });
    expect(budget.blockers).toEqual(["order_image_transfer_not_allowed", "model_route_missing", "model_call_limit_exceeded"]);
    expect(budget.allowed).toBe(false);
    expect(DesignAutomationRecipeSchema.safeParse({ ...unlimited, modelCallLimit: 101 }).success).toBe(false);
    expect(buildDesignAutomationPlan({ recipe: { ...unlimited, modelCallLimit: 1 }, imageIds: [imageId, secondImageId] }).blockers).toEqual(["model_call_limit_exceeded"]);
  });

  it("counts every original image call and still requires proof and independent review", () => {
    const plan = buildDesignAutomationPlan({ recipe: unlimited, imageIds: [imageId, secondImageId] });
    expect(plan.steps.filter(step => step.tool === "enhance_image").map(step => step.sourceImageId)).toEqual([imageId, secondImageId]);
    expect(plan.steps.slice(-3).map(step => step.tool)).toEqual(["preflight", "render_proof", "review_required"]);
    expect(plan.steps.at(-1)).toMatchObject({ outputRole: "human_review", dependsOn: ["render_proof"] });
    expect(DesignAutomationPlanSchema.safeParse({ ...plan, automaticProductionApproval: true }).success).toBe(false);
    expect(DesignAutomationPlanSchema.safeParse({ ...plan, steps: plan.steps.slice(0, -1) }).success).toBe(false);
    expect(DesignAutomationPlanSchema.safeParse({ ...plan, budget: { ...plan.budget, actualCostUsd: 0 } }).success).toBe(false);
  });

  it("keeps model-edited identity and production approval outside a ready unlimited plan", () => {
    const plan = buildDesignAutomationPlan({ recipe: unlimited, imageIds: [imageId] });
    expect(plan.status).toBe("ready");
    const input: BuildDesignQualityReportInput = {
      images: [{
        sourceImageId: imageId, sourceChecksum: "a".repeat(64), expectedSourceChecksum: "a".repeat(64), outputChecksum: "b".repeat(64),
        sourceWidthPx: 300, sourceHeightPx: 300, outputWidthPx: 300, outputHeightPx: 300,
        placedWidthMm: 25.4, placedHeightMm: 25.4, minimumPpi: 150,
        sourceHasAlpha: true, outputHasAlpha: true, requiresAlpha: true, scan: "clean", modelEdited: true,
      }], texts: [], preflight: { productionReady: true, issues: [] },
    };
    const report = buildDesignQualityReport(input);
    expect(report).toMatchObject({ status: "needs_review", automaticProductionApproval: false, identityVerification: "not_automatically_verified" });
    expect(report.checks).toContainEqual({ code: "identity_and_content", sourceImageId: imageId, status: "needs_review" });
    expect(report.checks).toContainEqual({ code: "production_review", status: "needs_review" });
  });

  it.each(["submitted", "succeeded", "failed", "unknown"] as const)("keeps a %s call with no billing receipt unknown and prevents automatic resubmission", submissionState => {
    expect(assessDesignModelAttempt({ submissionState, actualCostUsd: null })).toEqual({
      safeToResubmit: false, retainEstimatedReservation: true, actualCostUsd: null, billingStatus: "unknown",
    });
    expect(assessDesignModelAttempt({ submissionState, actualCostUsd: 0.16 })).toMatchObject({
      safeToResubmit: false, actualCostUsd: 0.16, billingStatus: "actual_known",
    });
  });

  it("keeps no-call preservation explicitly free while retaining the review requirement", () => {
    const plan = buildDesignAutomationPlan({
      recipe: { ...unlimited, imagePolicy: "preserve", modelRouteId: null, allowOrderImageTransfer: false, modelCallLimit: 0 }, imageIds: [imageId],
    });
    expect(plan).toMatchObject({ status: "ready", plannedModelCalls: 0, automaticProductionApproval: false });
    expect(plan.budget).toMatchObject({ estimatedCostUsd: 0, actualCostUsd: 0, costBasis: "not_applicable" });
    expect(plan.steps.at(-1)?.tool).toBe("review_required");
  });
});

describe("versioned pillow model variants", () => {
  const upscale: PillowUpscalePolicy = {
    engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus",
    scale: 4, tileSize: 256, threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1",
    binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64),
  };
  // Fixed historical field order is part of the stored JSON/checksum evidence.
  const historical = {
    version: "pillow-subject-v1-2026-09-19", factoryStandard: "ps-pillow-2026-09-17",
    requiredModel: "gpt-image-2.5", cutoutPromptVersion: "pillow-cutout-whiskers-v1",
    whiskerPolicy: "remove-protruding-long-whiskers", subjectAlphaThreshold: 32,
    subjectMeasurement: "alpha-inclusive-bounds-v1",
    contour: { baseBorderPx: 200, maxExtraPx: 30, roundingPx: 20, fineDetailPx: 0 }, upscale,
  };
  const models = ["gpt-image-2.5", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"] as const;

  it("retains the complete historical v1 JSON bytes and base-model pin", () => {
    const bytes = JSON.stringify(historical), old = createPillowPipeline(upscale);
    expect(JSON.stringify(old)).toBe(bytes);
    expect(JSON.stringify(PillowPipelineSchema.parse(JSON.parse(bytes)))).toBe(bytes);
    const oldRecipe = { ...limited, workflow: "pillow_photo" as const, pillowPipeline: historical };
    const parsed = DesignAutomationRecipeSchema.parse(oldRecipe);
    expect(JSON.stringify(parsed.pillowPipeline)).toBe(bytes);
    expect(Object.hasOwn(parsed, "costPolicy")).toBe(false);
    expect(buildDesignAutomationPlan({ recipe: parsed, imageIds: [imageId], pillowSubject: "head", configuredModel: "gpt-image-2.5", pillowRuntime: upscale }).status).toBe("ready");
  });

  it.each(models)("pins %s exactly in an explicit v2 plan without granting production approval", requiredModel => {
    const original = structuredClone(upscale), pipeline = createPillowPipelineForModel(upscale, requiredModel);
    expect(pipeline).toEqual({ ...historical, version: "pillow-subject-v2-2026-10-29", requiredModel });
    expect(pipeline.requiredModel).toBe(requiredModel); expect(upscale).toEqual(original);
    const plan = buildDesignAutomationPlan({
      recipe: { ...unlimited, workflow: "pillow_photo", pillowPipeline: pipeline }, imageIds: [imageId],
      pillowSubject: "head", configuredModel: requiredModel, pillowRuntime: upscale,
    });
    expect(plan).toMatchObject({ status: "ready", blockers: [], plannedModelCalls: 2, automaticProductionApproval: false });
    expect(plan.recipe.pillowPipeline).toEqual(pipeline);
    expect(plan.budget).toMatchObject({ allowed: true, estimatedCostUsd: null, actualCostUsd: null });
    expect(plan.steps.filter(step => step.tool === "enhance_image" || step.tool === "cutout_subject").map(step => step.tool)).toEqual(["enhance_image", "cutout_subject"]);
    expect(plan.steps.at(-1)?.tool).toBe("review_required");
    expect(DesignAutomationPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });

  it.each(models)("refuses to alias the v2 %s pin to either other supported model", requiredModel => {
    const recipe: DesignAutomationRecipe = { ...unlimited, workflow: "pillow_photo", pillowPipeline: createPillowPipelineForModel(upscale, requiredModel) };
    for (const configuredModel of models.filter(model => model !== requiredModel)) {
      const plan = buildDesignAutomationPlan({ recipe, imageIds: [imageId], pillowSubject: "head", configuredModel, pillowRuntime: upscale });
      expect(plan).toMatchObject({ status: "blocked", blockers: ["pillow_model_mismatch"], automaticProductionApproval: false });
      expect(plan.recipe.pillowPipeline?.requiredModel).toBe(requiredModel);
    }
  });

  it.each(["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"])("rejects a %s model substituted into historical v1 data", requiredModel => {
    const changed = { ...historical, requiredModel };
    expect(PillowPipelineSchema.safeParse(changed).success).toBe(false);
    expect(DesignAutomationRecipeSchema.safeParse({ ...limited, workflow: "pillow_photo", pillowPipeline: changed }).success).toBe(false);
    const old = createPillowPipeline(upscale);
    expect(buildDesignAutomationPlan({ recipe: { ...limited, workflow: "pillow_photo", pillowPipeline: old }, imageIds: [imageId], pillowSubject: "head", configuredModel: requiredModel, pillowRuntime: upscale }).blockers).toEqual(["pillow_model_mismatch"]);
    expect(JSON.stringify(old)).toBe(JSON.stringify(historical));
  });

  it.each(["gpt-image-1", "gpt-image-2.5-other", "GPT-IMAGE-2.5-FLARE", "gpt-image-2.5-flare ", ""])("rejects unlisted model %j without normalization or alias fallback", requiredModel => {
    expect(() => createPillowPipelineForModel(upscale, requiredModel as never)).toThrow();
    expect(PillowPipelineSchema.safeParse({ ...historical, version: "pillow-subject-v2-2026-10-29", requiredModel }).success).toBe(false);
  });

  it("keeps verified model and runtime requirements in an unlimited variant plan", () => {
    const recipe: DesignAutomationRecipe = { ...unlimited, workflow: "pillow_photo", pillowPipeline: createPillowPipelineForModel(upscale, "gpt-image-2.5-flare") };
    const input = { recipe, imageIds: [imageId], pillowSubject: "head" as const };
    expect(buildDesignAutomationPlan({ ...input, pillowRuntime: upscale }).blockers).toEqual(["pillow_model_unverified"]);
    expect(buildDesignAutomationPlan({ ...input, configuredModel: "gpt-image-2.5-flare" }).blockers).toEqual(["pillow_runtime_unavailable"]);
    expect(buildDesignAutomationPlan({ ...input, configuredModel: "gpt-image-2.5-flare", pillowRuntime: { ...upscale, modelBinSha256: "d".repeat(64) } }).blockers).toEqual(["pillow_runtime_mismatch"]);
  });
});
