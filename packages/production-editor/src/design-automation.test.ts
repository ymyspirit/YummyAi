import { describe, expect, it } from "vitest";
import type { BuildDesignQualityReportInput, DesignAutomationRecipe } from "@yummyai/contracts/pod/design-automation";
import { createPillowPipeline, DesignAutomationPlanSchema, type PillowUpscalePolicy } from "@yummyai/contracts/pod/design-automation";
import { assessDesignModelAttempt, buildDesignAutomationPlan, buildDesignQualityReport, evaluateDesignAutomationBudget } from "./design-automation.js";

const imageId = "019f7600-0000-7000-8000-000000000001";
const secondImageId = "019f7600-0000-7000-8000-000000000002";
const routeId = "019f7600-0000-7000-8000-000000000003";
const preserve: DesignAutomationRecipe = { schemaVersion: 1, workflow: "template", imagePolicy: "preserve", modelRouteId: null,
  allowOrderImageTransfer: false, modelCallLimit: 0, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: null };
const enhanced: DesignAutomationRecipe = { ...preserve, imagePolicy: "faithful_enhancement", modelRouteId: routeId,
  allowOrderImageTransfer: true, modelCallLimit: 3, estimatedCostPerCallUsd: 0.1, maxEstimatedCostUsd: 0.3 };
const upscale: PillowUpscalePolicy = { engine: "realesrgan-ncnn-vulkan", release: "20220424", model: "realesrgan-x4plus", scale: 4,
  tileSize: 256, threads: "1:1:1", alphaStrategy: "source-alpha-lanczos3-rgb-nearest-fill-v1", binarySha256: "a".repeat(64), modelBinSha256: "b".repeat(64), modelParamSha256: "c".repeat(64) };

describe("deterministic design execution plans", () => {
  it("preserves originals without model permission or pricing and always ends in review", () => {
    const plan = buildDesignAutomationPlan({ recipe: preserve, imageIds: [imageId] });
    expect(plan.status).toBe("ready");
    expect(plan.steps.map(step => step.tool)).toEqual(["validate_inputs", "compose_template", "preflight", "render_proof", "review_required"]);
    expect(plan).toMatchObject({ plannedModelCalls: 0, automaticProductionApproval: false, budget: { estimatedCostUsd: 0, actualCostUsd: 0, costBasis: "not_applicable" } });
  });
  it("enhances each selected original exactly once with stable dependencies", () => {
    const input = { recipe: enhanced, imageIds: [imageId, secondImageId] };
    const before = structuredClone(input);
    const plan = buildDesignAutomationPlan(input);
    expect(plan).toEqual(buildDesignAutomationPlan(input));
    expect(input).toEqual(before);
    expect(plan.steps.filter(step => step.tool === "enhance_image").map(step => step.sourceImageId)).toEqual([imageId, secondImageId]);
    expect(plan.steps.find(step => step.tool === "preflight")?.dependsOn).toEqual(["enhance_image_1", "enhance_image_2"]);
    expect(plan.budget).toMatchObject({ allowed: true, plannedModelCalls: 2, estimatedCostUsd: 0.2, actualCostUsd: null });
  });
  it("plans pillow cutout and contour explicitly from the enhanced source", () => {
    const plan = buildDesignAutomationPlan({ recipe: { ...enhanced, workflow: "pillow_photo" }, imageIds: [imageId], pillowSubject: "head" });
    expect(plan.status).toBe("ready");
    expect(plan.plannedModelCalls).toBe(2);
    expect(plan.steps.find(step => step.tool === "cutout_subject")).toMatchObject({ sourceImageId: imageId, enhancedStepId: "enhance_image_1", subject: "head", dependsOn: ["enhance_image_1"] });
    expect(plan.steps.find(step => step.tool === "optimize_contour")).toMatchObject({ sourceStepId: "cutout_subject", dependsOn: ["cutout_subject"] });
  });
  it("still budgets cutout when pillow images are preserved", () => {
    const recipe = { ...enhanced, workflow: "pillow_photo" as const, imagePolicy: "preserve" as const };
    const plan = buildDesignAutomationPlan({ recipe, imageIds: [imageId], pillowSubject: "body" });
    expect(plan.plannedModelCalls).toBe(1);
    expect(plan.steps.some(step => step.tool === "enhance_image")).toBe(false);
    expect(plan.steps.find(step => step.tool === "cutout_subject")).toMatchObject({ enhancedStepId: null, subject: "body" });
  });
  it("pins half-body cutout separately with the same paid-call count and human review boundary", () => {
    const plan = buildDesignAutomationPlan({ recipe: { ...enhanced, workflow: "pillow_photo" }, imageIds: [imageId], pillowSubject: "half_body" });
    expect(plan).toMatchObject({ status: "ready", plannedModelCalls: 2, automaticProductionApproval: false });
    expect(plan.steps.find(step => step.tool === "cutout_subject")).toMatchObject({ subject: "half_body", subjectPromptVersion: "pillow-half-body-v1", enhancedStepId: "enhance_image_1" });
    expect(plan.steps.at(-1)?.tool).toBe("review_required");
    expect(DesignAutomationPlanSchema.parse(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
  });
  it("plans the reviewed new pipeline in order and charges only enhancement and cutout", () => {
    const recipe: DesignAutomationRecipe = { ...enhanced, workflow: "pillow_photo", pillowPipeline: createPillowPipeline(upscale) };
    const plan = buildDesignAutomationPlan({ recipe, imageIds: [imageId], pillowSubject: "head", configuredModel: "gpt-image-2.5", pillowRuntime: upscale });
    expect(plan.status).toBe("ready");
    expect(plan.steps.map(step => step.tool)).toEqual(["validate_inputs", "compose_template", "enhance_image", "cutout_subject", "measure_subject", "ensure_resolution", "optimize_contour", "preflight", "render_proof", "review_required"]);
    expect(plan.steps.find(step => step.tool === "ensure_resolution")).toMatchObject({ sourceStepId: "cutout_subject", measurementStepId: "measure_subject", dependsOn: ["measure_subject"] });
    expect(plan.steps.find(step => step.tool === "optimize_contour")).toMatchObject({ sourceStepId: "ensure_resolution", dependsOn: ["ensure_resolution"] });
    expect(plan.budget).toMatchObject({ allowed: true, plannedModelCalls: 2, estimatedCostUsd: 0.2, actualCostUsd: null });
  });
  it("blocks unverified or changed model/runtime pins without weakening budget checks", () => {
    const recipe: DesignAutomationRecipe = { ...enhanced, workflow: "pillow_photo", pillowPipeline: createPillowPipeline(upscale) };
    const input = { recipe, imageIds: [imageId], pillowSubject: "head" as const };
    expect(buildDesignAutomationPlan(input).blockers).toEqual(["pillow_model_unverified", "pillow_runtime_unavailable"]);
    expect(buildDesignAutomationPlan({ ...input, configuredModel: "gpt-image-1", pillowRuntime: { ...upscale, modelBinSha256: "d".repeat(64) } }).blockers).toEqual(["pillow_model_mismatch", "pillow_runtime_mismatch"]);
    expect(buildDesignAutomationPlan({ ...input, recipe: { ...recipe, modelCallLimit: 1 }, configuredModel: "gpt-image-2.5", pillowRuntime: upscale }).blockers).toContain("model_call_limit_exceeded");
  });
  it.each([{ imageIds: [] }, { imageIds: [imageId, secondImageId] }])("blocks ambiguous pillow input %j", ({ imageIds }) => {
    const plan = buildDesignAutomationPlan({ recipe: { ...enhanced, workflow: "pillow_photo" }, imageIds });
    expect(plan.status).toBe("blocked");
    expect(plan.blockers).toEqual(expect.arrayContaining(["pillow_image_count_invalid", "pillow_subject_missing"]));
    expect(plan.steps.some(step => step.tool === "cutout_subject")).toBe(false);
  });
  it("rejects a pillow subject on a generic template and never invents a legacy recipe", () => {
    expect(buildDesignAutomationPlan({ recipe: preserve, imageIds: [], pillowSubject: "head" }).blockers).toContain("unexpected_pillow_subject");
    expect(() => buildDesignAutomationPlan({ recipe: undefined, imageIds: [] } as never)).toThrow();
  });
  it("rejects plans with unbudgeted steps, forward dependencies or missing review", () => {
    const plan = buildDesignAutomationPlan({ recipe: enhanced, imageIds: [imageId] });
    expect(DesignAutomationPlanSchema.safeParse({ ...plan, plannedModelCalls: 0 }).success).toBe(false);
    expect(DesignAutomationPlanSchema.safeParse({ ...plan, steps: plan.steps.slice(0, -1) }).success).toBe(false);
    const mutated = structuredClone(plan); mutated.steps[0]!.dependsOn = ["review_required"];
    expect(DesignAutomationPlanSchema.safeParse(mutated).success).toBe(false);
    expect(DesignAutomationPlanSchema.safeParse({ ...plan, budget: { ...plan.budget, actualCostUsd: 0 } }).success).toBe(false);
  });
});

describe("design model budget and unknown billing", () => {
  it("fails closed with a complete actionable blocker set", () => {
    expect(evaluateDesignAutomationBudget({ recipe: preserve, plannedModelCalls: 1 })).toMatchObject({ allowed: false,
      blockers: ["order_image_transfer_not_allowed", "model_route_missing", "model_call_limit_exceeded", "model_price_missing", "model_budget_missing"],
      estimatedCostUsd: null, actualCostUsd: null });
  });
  it("never runs an unpriced model even with a monetary cap", () => {
    const recipe = { ...enhanced, estimatedCostPerCallUsd: null };
    expect(evaluateDesignAutomationBudget({ recipe, plannedModelCalls: 1 }).blockers).toContain("model_price_missing");
  });
  it("uses trusted configured per-call pricing ahead of a lower recipe estimate", () => {
    const budget = evaluateDesignAutomationBudget({ recipe: enhanced, plannedModelCalls: 2, configuredEstimatedCostPerCallUsd: 0.2 });
    expect(budget).toMatchObject({ allowed: false, priceSource: "configured", estimatedCostUsd: 0.4, actualCostUsd: null });
    expect(budget.blockers).toContain("model_budget_exceeded");
  });
  it("allows an explicitly priced free model but not a missing price", () => {
    const budget = evaluateDesignAutomationBudget({ recipe: { ...enhanced, estimatedCostPerCallUsd: null, maxEstimatedCostUsd: 0 }, plannedModelCalls: 1, configuredEstimatedCostPerCallUsd: 0 });
    expect(budget).toMatchObject({ allowed: true, estimatedCostUsd: 0, actualCostUsd: null, priceSource: "configured" });
  });
  it("handles exact decimal caps and rounds small estimates conservatively", () => {
    expect(evaluateDesignAutomationBudget({ recipe: enhanced, plannedModelCalls: 3 }).allowed).toBe(true);
    const tiny = evaluateDesignAutomationBudget({ recipe: { ...enhanced, estimatedCostPerCallUsd: 0.0000001, maxEstimatedCostUsd: 0 }, plannedModelCalls: 1 });
    expect(tiny).toMatchObject({ allowed: false, estimatedCostUsd: 0.000001 });
  });
  it("counts every planned model call even when within the monetary cap", () => {
    expect(evaluateDesignAutomationBudget({ recipe: { ...enhanced, modelCallLimit: 1 }, plannedModelCalls: 2 }).blockers).toContain("model_call_limit_exceeded");
  });
  it.each(["submitted", "succeeded", "failed", "unknown"] as const)("does not turn %s into zero billed or an automatic retry", submissionState => {
    expect(assessDesignModelAttempt({ submissionState, actualCostUsd: null })).toEqual({ safeToResubmit: false, retainEstimatedReservation: true, actualCostUsd: null, billingStatus: "unknown" });
  });
  it("releases an unsubmitted reservation and preserves separately supplied actual evidence", () => {
    expect(assessDesignModelAttempt({ submissionState: "not_submitted", actualCostUsd: null })).toEqual({ safeToResubmit: true, retainEstimatedReservation: false, actualCostUsd: 0, billingStatus: "not_incurred" });
    expect(assessDesignModelAttempt({ submissionState: "succeeded", actualCostUsd: 0.16 })).toEqual({ safeToResubmit: false, retainEstimatedReservation: false, actualCostUsd: 0.16, billingStatus: "actual_known" });
  });
});

function qualityInput(): BuildDesignQualityReportInput {
  return { images: [{ sourceImageId: imageId, sourceChecksum: "a".repeat(64), expectedSourceChecksum: "a".repeat(64), outputChecksum: "a".repeat(64),
    sourceWidthPx: 300, sourceHeightPx: 300, outputWidthPx: 300, outputHeightPx: 300, placedWidthMm: 25.4, placedHeightMm: 25.4, minimumPpi: 150,
    sourceHasAlpha: false, outputHasAlpha: false, requiresAlpha: false, scan: "clean", modelEdited: false }],
    texts: [{ fieldId: "name", expected: " Zoë 🐶 ", actual: " Zoë 🐶 " }], preflight: { productionReady: true, issues: [] } };
}
describe("design quality evidence", () => {
  it("passes exact byte and text preservation while keeping production review mandatory", () => {
    const report = buildDesignQualityReport(qualityInput());
    expect(report).toMatchObject({ status: "needs_review", automaticProductionApproval: false, identityVerification: "not_automatically_verified" });
    expect(report.checks.filter(check => check.code !== "production_review").every(check => check.status === "passed")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("Zoë");
    expect(JSON.stringify(report)).not.toContain("🐶");
  });
  it("checks immutable source evidence rather than trusting a supplied checksum shape", () => {
    const input = qualityInput(); input.images[0]!.expectedSourceChecksum = "b".repeat(64);
    expect(buildDesignQualityReport(input).checks).toContainEqual(expect.objectContaining({ code: "source_provenance", status: "failed" }));
  });
  it("does not let upscaled output PPI hide missing original detail or identity review", () => {
    const input = qualityInput(); Object.assign(input.images[0]!, { sourceWidthPx: 100, sourceHeightPx: 100, outputWidthPx: 600, outputHeightPx: 600, modelEdited: true, outputChecksum: "b".repeat(64) });
    const report = buildDesignQualityReport(input);
    expect(report.checks).toContainEqual(expect.objectContaining({ code: "source_resolution", status: "needs_review", sourcePpi: 100 }));
    expect(report.checks).toContainEqual(expect.objectContaining({ code: "output_resolution", status: "passed", outputPpi: 600 }));
    expect(report.checks).toContainEqual(expect.objectContaining({ code: "identity_and_content", status: "needs_review" }));
  });
  it("keeps unknown crop provenance unknown and never borrows output pixels", () => {
    const input = qualityInput(); Object.assign(input.images[0]!, { sourceWidthPx: null, sourceHeightPx: null });
    expect(buildDesignQualityReport(input).checks).toContainEqual(expect.objectContaining({ code: "source_resolution", status: "needs_review", sourcePpi: null }));
  });
  it("fails actual placement resolution regardless of exported DPI metadata", () => {
    const input = qualityInput(); input.images[0]!.placedWidthMm = 254;
    const report = buildDesignQualityReport(input);
    expect(report.status).toBe("failed");
    expect(report.checks).toContainEqual(expect.objectContaining({ code: "output_resolution", status: "failed", outputPpi: 30 }));
  });
  it("absorbs machine precision at exactly 150 PPI but still fails a real resolution deficit", () => {
    const input = qualityInput();
    Object.assign(input.images[0]!, { sourceWidthPx: 3013, sourceHeightPx: 3013, outputWidthPx: 3013, outputHeightPx: 3013,
      placedWidthMm: 3013 * (20 * 25.4 / 3000), placedHeightMm: 3013 * (20 * 25.4 / 3000) });
    expect(buildDesignQualityReport(input).checks).toContainEqual(expect.objectContaining({ code: "output_resolution", status: "passed" }));
    for (const ppi of [150 - 1e-8, 149.99]) {
      input.images[0]!.placedWidthMm = 3013 * 25.4 / ppi;
      expect(buildDesignQualityReport(input).checks).toContainEqual(expect.objectContaining({ code: "output_resolution", status: ppi > 149.9999999 ? "passed" : "failed" }));
    }
  });
  it.each([{ sourceHasAlpha: true }, { requiresAlpha: true }])("fails missing required alpha: %j", alpha => {
    const input = qualityInput(); Object.assign(input.images[0]!, alpha);
    expect(buildDesignQualityReport(input).checks).toContainEqual(expect.objectContaining({ code: "alpha_preservation", status: "failed" }));
  });
  it.each(["infected", "unavailable"] as const)("blocks unsafe or unavailable scan %s", scan => {
    const input = qualityInput(); input.images[0]!.scan = scan;
    expect(buildDesignQualityReport(input).status).toBe("failed");
  });
  it.each(["Zoë 🐶", " Zoë 🐱 ", " Zoe\u0308 🐶 "])("compares every buyer character without silent normalization: %s", actual => {
    const input = qualityInput(); input.texts[0]!.actual = actual;
    expect(buildDesignQualityReport(input).checks).toContainEqual(expect.objectContaining({ code: "text_exact", status: "failed" }));
  });
  it("keeps manual preflight separate from failures and never trusts a contradictory ready flag", () => {
    const input = qualityInput(); input.preflight.issues = [{ code: "visual_review_required", severity: "manual" }];
    expect(buildDesignQualityReport(input).status).toBe("needs_review");
    input.preflight.issues.push({ code: "effective_dpi_low", severity: "error" });
    expect(buildDesignQualityReport(input).status).toBe("failed");
  });
});
