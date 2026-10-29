import {
  BuildDesignAutomationPlanInputSchema, BuildDesignQualityReportInputSchema,
  DesignAutomationBudgetSchema, DesignAutomationPlanSchema, DesignModelAttemptAssessmentSchema,
  DesignModelAttemptInputSchema, DesignQualityReportSchema, EvaluateDesignAutomationBudgetInputSchema,
  PILLOW_HALF_BODY_PROMPT_VERSION,
  type BuildDesignAutomationPlanInput, type BuildDesignQualityReportInput,
  type DesignAutomationBlockerCode, type DesignAutomationBudget, type DesignAutomationPlan,
  type DesignAutomationStep, type DesignModelAttemptAssessment, type DesignModelAttemptInput,
  type DesignQualityCheck, type DesignQualityReport, type EvaluateDesignAutomationBudgetInput,
} from "@yummyai/contracts/pod/design-automation";

/** Round estimates upward to microdollars. This is a reservation estimate, not
 * the actual charge. The small relative tolerance removes binary float noise. */
function estimatedMoney(value: number) {
  if (value === 0) return 0;
  const scaled = value * 1_000_000;
  return Math.max(1, Math.ceil(scaled - Number.EPSILON * Math.max(1, Math.abs(scaled)) * 2)) / 1_000_000;
}

export function evaluateDesignAutomationBudget(raw: EvaluateDesignAutomationBudgetInput): DesignAutomationBudget {
  const input = EvaluateDesignAutomationBudgetInputSchema.parse(raw);
  const { recipe, plannedModelCalls } = input;
  const configured = input.configuredEstimatedCostPerCallUsd;
  const unitPrice = configured ?? recipe.estimatedCostPerCallUsd;
  const priceSource = configured !== null && configured !== undefined ? "configured" : unitPrice !== null ? "recipe" : "none";
  const blockers: DesignAutomationBlockerCode[] = [];
  const estimatedCostUsd = plannedModelCalls === 0 ? 0 : unitPrice === null ? null : estimatedMoney(unitPrice * plannedModelCalls);
  if (plannedModelCalls > 0) {
    if (!recipe.allowOrderImageTransfer) blockers.push("order_image_transfer_not_allowed");
    if (!recipe.modelRouteId) blockers.push("model_route_missing");
    if (plannedModelCalls > recipe.modelCallLimit) blockers.push("model_call_limit_exceeded");
    if (unitPrice === null && recipe.costPolicy !== "unlimited") blockers.push("model_price_missing");
    if (recipe.maxEstimatedCostUsd === null && recipe.costPolicy !== "unlimited") blockers.push("model_budget_missing");
    if (estimatedCostUsd !== null && recipe.maxEstimatedCostUsd !== null && estimatedCostUsd > recipe.maxEstimatedCostUsd) blockers.push("model_budget_exceeded");
  }
  return DesignAutomationBudgetSchema.parse({
    allowed: blockers.length === 0, blockers, plannedModelCalls,
    estimatedCostPerCallUsd: unitPrice, estimatedCostUsd, maxEstimatedCostUsd: recipe.maxEstimatedCostUsd,
    priceSource, costBasis: plannedModelCalls > 0 ? "estimated" : "not_applicable",
    actualCostUsd: plannedModelCalls > 0 ? null : 0,
  });
}

/** Planning is deterministic and has no IO. Execution must refuse a blocked
 * plan, freeze the route/provider snapshot, and never grant review permission. */
export function buildDesignAutomationPlan(raw: BuildDesignAutomationPlanInput): DesignAutomationPlan {
  const input = BuildDesignAutomationPlanInputSchema.parse(raw);
  const { recipe, imageIds, pillowSubject } = input;
  const enhancementCount = recipe.imagePolicy === "faithful_enhancement" ? imageIds.length : 0;
  const plannedModelCalls = enhancementCount + (recipe.workflow === "pillow_photo" ? 1 : 0);
  const budget = evaluateDesignAutomationBudget({ recipe, plannedModelCalls, configuredEstimatedCostPerCallUsd: input.configuredEstimatedCostPerCallUsd });
  const blockers = [...budget.blockers];
  if (recipe.workflow === "pillow_photo") {
    if (imageIds.length !== 1) blockers.push("pillow_image_count_invalid");
    if (!pillowSubject) blockers.push("pillow_subject_missing");
  } else if (pillowSubject !== undefined) blockers.push("unexpected_pillow_subject");
  if (recipe.pillowPipeline) {
    if (!input.configuredModel) blockers.push("pillow_model_unverified");
    else if (input.configuredModel !== recipe.pillowPipeline.requiredModel) blockers.push("pillow_model_mismatch");
    const runtime = input.pillowRuntime;
    if (!runtime) blockers.push("pillow_runtime_unavailable");
    else if (Object.entries(recipe.pillowPipeline.upscale).some(([key, value]) => runtime[key as keyof typeof runtime] !== value)) blockers.push("pillow_runtime_mismatch");
  }
  const steps: DesignAutomationStep[] = [
    { id: "validate_inputs", tool: "validate_inputs", outputRole: "input_validation", dependsOn: [] },
    { id: "compose_template", tool: "compose_template", outputRole: "layout", dependsOn: ["validate_inputs"] },
  ];
  const enhancedIds: string[] = [];
  if (recipe.imagePolicy === "faithful_enhancement") {
    for (const [index, sourceImageId] of imageIds.entries()) {
      const id = `enhance_image_${index + 1}`;
      steps.push({ id, tool: "enhance_image", outputRole: "enhanced_image", dependsOn: ["compose_template"], sourceImageId });
      enhancedIds.push(id);
    }
  }
  let finalInputs = enhancedIds.length ? enhancedIds : ["compose_template"];
  if (recipe.workflow === "pillow_photo" && imageIds.length === 1 && pillowSubject) {
    const enhancedStepId = enhancedIds[0] ?? null;
    steps.push({ id: "cutout_subject", tool: "cutout_subject", outputRole: "subject_image", dependsOn: finalInputs,
      sourceImageId: imageIds[0]!, enhancedStepId, subject: pillowSubject,
      ...(pillowSubject === "half_body" ? { subjectPromptVersion: PILLOW_HALF_BODY_PROMPT_VERSION } : {}) });
    let contourSource = "cutout_subject";
    if (recipe.pillowPipeline) {
      steps.push({ id: "measure_subject", tool: "measure_subject", outputRole: "subject_measurement", dependsOn: ["cutout_subject"], sourceStepId: "cutout_subject" });
      steps.push({ id: "ensure_resolution", tool: "ensure_resolution", outputRole: "resolution_image", dependsOn: ["measure_subject"], sourceStepId: "cutout_subject", measurementStepId: "measure_subject" });
      contourSource = "ensure_resolution";
    }
    steps.push({ id: "optimize_contour", tool: "optimize_contour", outputRole: "cut_contour", dependsOn: [contourSource], sourceStepId: contourSource });
    finalInputs = ["optimize_contour"];
  }
  steps.push({ id: "preflight", tool: "preflight", outputRole: "quality_report", dependsOn: finalInputs });
  steps.push({ id: "render_proof", tool: "render_proof", outputRole: "proof", dependsOn: ["preflight"] });
  steps.push({ id: "review_required", tool: "review_required", outputRole: "human_review", dependsOn: ["render_proof"] });
  return DesignAutomationPlanSchema.parse({ schemaVersion: 1, recipe, status: blockers.length ? "blocked" : "ready", blockers,
    steps, plannedModelCalls, budget, automaticProductionApproval: false });
}

/** A timeout, provider failure, or process loss after submission is not proof
 * of a zero bill. A retry must be a new explicitly budgeted action. */
export function assessDesignModelAttempt(raw: DesignModelAttemptInput): DesignModelAttemptAssessment {
  const input = DesignModelAttemptInputSchema.parse(raw);
  const notSubmitted = input.submissionState === "not_submitted";
  return DesignModelAttemptAssessmentSchema.parse({
    safeToResubmit: notSubmitted,
    retainEstimatedReservation: !notSubmitted && input.actualCostUsd === null,
    actualCostUsd: notSubmitted ? 0 : input.actualCostUsd,
    billingStatus: notSubmitted ? "not_incurred" : input.actualCostUsd === null ? "unknown" : "actual_known",
  });
}

/** Technical checks do not prove identity or authorize production. No customer
 * text, prompts, URLs or model claims are copied into this evidence report. */
export function buildDesignQualityReport(raw: BuildDesignQualityReportInput): DesignQualityReport {
  const input = BuildDesignQualityReportInputSchema.parse(raw);
  const checks: DesignQualityCheck[] = [];
  for (const image of input.images) {
    const outputPpi = Math.min(image.outputWidthPx * 25.4 / image.placedWidthMm, image.outputHeightPx * 25.4 / image.placedHeightMm);
    const sourcePpi = image.sourceWidthPx !== null && image.sourceHeightPx !== null
      ? Math.min(image.sourceWidthPx * 25.4 / image.placedWidthMm, image.sourceHeightPx * 25.4 / image.placedHeightMm) : null;
    const common = { sourceImageId: image.sourceImageId };
    checks.push({ ...common, code: "source_provenance", status: image.sourceChecksum === image.expectedSourceChecksum ? "passed" : "failed",
      sourceChecksum: image.sourceChecksum, expectedSourceChecksum: image.expectedSourceChecksum, outputChecksum: image.outputChecksum });
    // Unit conversion can produce 149.99999999999997 for an exact 150 PPI
    // placement. This only absorbs floating-point noise, never a one-PPI gap.
    checks.push({ ...common, code: "source_resolution", status: sourcePpi !== null && sourcePpi + 1e-7 >= image.minimumPpi ? "passed" : "needs_review", sourcePpi, minimumPpi: image.minimumPpi });
    checks.push({ ...common, code: "output_resolution", status: outputPpi + 1e-7 >= image.minimumPpi ? "passed" : "failed", outputPpi, minimumPpi: image.minimumPpi });
    checks.push({ ...common, code: "alpha_preservation", status: (!image.sourceHasAlpha && !image.requiresAlpha) || image.outputHasAlpha ? "passed" : "failed" });
    checks.push({ ...common, code: "file_scan", status: image.scan === "clean" ? "passed" : "failed" });
    // Equal bytes prove preservation only when no model editing is claimed.
    // Different bytes and any model-edited output always need independent review.
    checks.push({ ...common, code: "identity_and_content", status: !image.modelEdited && image.sourceChecksum === image.outputChecksum ? "passed" : "needs_review" });
  }
  for (const text of input.texts) {
    checks.push({ code: "text_exact", fieldId: text.fieldId, status: text.expected === text.actual ? "passed" : "failed",
      expectedCharacterCount: Array.from(text.expected).length, actualCharacterCount: Array.from(text.actual).length });
  }
  if (input.preflight.issues.length) {
    for (const issue of input.preflight.issues) checks.push({ code: "production_preflight", preflightCode: issue.code,
      status: issue.severity === "error" ? "failed" : "needs_review" });
  } else checks.push({ code: "production_preflight", status: input.preflight.productionReady ? "passed" : "needs_review" });
  checks.push({ code: "production_review", status: "needs_review" });
  const status = checks.some(check => check.status === "failed") ? "failed" : "needs_review";
  return DesignQualityReportSchema.parse({ schemaVersion: 1, status, checks, automaticProductionApproval: false,
    identityVerification: "not_automatically_verified" });
}
