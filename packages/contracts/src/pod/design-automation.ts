import { z } from "zod";

const Id = z.uuidv7();
const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const Money = z.number().finite().nonnegative().max(1_000_000);
const NullableMoney = Money.nullable();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/** Explicitly reviewed opt-in; absent on every historical contour recipe. */
export const PILLOW_CONTOUR_GRAPH_VERSION = "langgraph-contour-v1-2026-09-20" as const;

export const PillowSubjectSchema = z.enum(["head", "body", "half_body"]);
export type PillowSubject = z.infer<typeof PillowSubjectSchema>;
export const PILLOW_HALF_BODY_PROMPT_VERSION = "pillow-half-body-v1" as const;
export const PILLOW_HALF_BODY_CUTOUT_INSTRUCTION = "仅保留顾客指定主体的半身，包含原图已有的完整头部、双耳、下巴及躯干上半部，按半身范围去掉下半身与背景。若原图为多人或人宠合影，必须保留所有前景合影人物和动物，人物数量、动物数量、相对位置、比例及遮挡关系保持不变，不能只选择单一主角。人物按半身保留；怀中宠物保留原图已有的全部可见部分，不得因人物的半身裁切而删除宠物或裁掉宠物的可见部位。若原图已经拼合并含透明区域，保持整体构图和已有透明区域，不拆分、不重新排列、不填充透明区域。仅保留原图真实可见的部位，不补画被遮挡或原图之外的身体、手脚、尾巴或毛发，不扩展画面，不把半身改成全身。";

/** Versioned, reviewed opt-in. Never default this object onto an older recipe. */
export const PillowUpscalePolicySchema = z.object({
  engine: z.literal("realesrgan-ncnn-vulkan"), release: z.literal("20220424"),
  model: z.literal("realesrgan-x4plus"), scale: z.literal(4), tileSize: z.literal(256), threads: z.literal("1:1:1"),
  alphaStrategy: z.literal("source-alpha-lanczos3-rgb-nearest-fill-v1"),
  binarySha256: Sha256, modelBinSha256: Sha256, modelParamSha256: Sha256,
}).strict();
export type PillowUpscalePolicy = z.infer<typeof PillowUpscalePolicySchema>;
export const PillowPipelineSchema = z.object({
  version: z.literal("pillow-subject-v1-2026-09-19"), factoryStandard: z.literal("ps-pillow-2026-09-17"),
  requiredModel: z.literal("gpt-image-2.5"), cutoutPromptVersion: z.literal("pillow-cutout-whiskers-v1"),
  whiskerPolicy: z.literal("remove-protruding-long-whiskers"),
  subjectAlphaThreshold: z.literal(32), subjectMeasurement: z.literal("alpha-inclusive-bounds-v1"),
  contour: z.object({ baseBorderPx: z.literal(200), maxExtraPx: z.literal(30), roundingPx: z.literal(20), fineDetailPx: z.literal(0),
    workflow: z.literal(PILLOW_CONTOUR_GRAPH_VERSION).optional(),
  }).strict(),
  upscale: PillowUpscalePolicySchema,
}).strict();
export type PillowPipeline = z.infer<typeof PillowPipelineSchema>;

/** Public, bounded technical evidence. No document, private path or model output. */
export const PillowContourEvidenceSchema = z.object({
  workflowVersion: z.literal(PILLOW_CONTOUR_GRAPH_VERSION), engine: z.literal("langgraph"),
  status: z.enum(["passed", "needs_attention"]), sourceAssetId: Id,
  sourceChecksum: Sha256, outputChecksum: Sha256, artworkUnchanged: z.literal(true), manualReviewRequired: z.literal(true),
  attempts: z.array(z.object({
    roundingPx: z.union([z.literal(20), z.literal(25), z.literal(30)]), technicalPassed: z.boolean(),
    checks: z.array(z.object({ code: Key, status: z.enum(["passed", "failed", "manual"]) }).strict()).max(100),
  }).strict()).min(1).max(3),
}).strict().superRefine((evidence, ctx) => {
  if (evidence.sourceChecksum !== evidence.outputChecksum) ctx.addIssue({ code: "custom", path: ["outputChecksum"], message: "Contour processing must preserve artwork bytes" });
  const rounds = [20, 25, 30];
  if (evidence.attempts.some((attempt, index) => attempt.roundingPx !== rounds[index] || (index < evidence.attempts.length - 1 && attempt.technicalPassed))) {
    ctx.addIssue({ code: "custom", path: ["attempts"], message: "Contour corrections must follow the fixed bounded sequence and stop on success" });
  }
  if ((evidence.status === "passed") !== evidence.attempts.at(-1)?.technicalPassed || (evidence.status === "needs_attention" && evidence.attempts.length !== 3)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "The final technical check determines the outcome" });
  }
});
export type PillowContourEvidence = z.infer<typeof PillowContourEvidenceSchema>;

/** Call only after an operator explicitly selects this version for a new template. */
export function createPillowPipeline(upscale: PillowUpscalePolicy): PillowPipeline {
  return PillowPipelineSchema.parse({ version: "pillow-subject-v1-2026-09-19", factoryStandard: "ps-pillow-2026-09-17",
    requiredModel: "gpt-image-2.5", cutoutPromptVersion: "pillow-cutout-whiskers-v1", whiskerPolicy: "remove-protruding-long-whiskers",
    subjectAlphaThreshold: 32, subjectMeasurement: "alpha-inclusive-bounds-v1",
    contour: { baseBorderPx: 200, maxExtraPx: 30, roundingPx: 20, fineDetailPx: 0 }, upscale });
}

/** Safe capability response: no credentials or executable filesystem paths. */
export const PillowRuntimeCapabilitySchema = z.object({
  available: z.boolean(), upscale: PillowUpscalePolicySchema.nullable(), reason: z.string().max(500).optional(),
}).strict().refine(value => value.available === (value.upscale !== null), "Runtime availability requires a verified policy");
export type PillowRuntimeCapability = z.infer<typeof PillowRuntimeCapabilitySchema>;

/** An approved recipe is data, never an executable prompt. Absence on a legacy
 * document is intentionally different from an explicit preserve policy. */
export const DesignAutomationRecipeSchema = z.object({
  schemaVersion: z.literal(1),
  workflow: z.enum(["template", "pillow_photo"]),
  imagePolicy: z.enum(["preserve", "faithful_enhancement"]),
  modelRouteId: Id.nullable(),
  allowOrderImageTransfer: z.boolean().default(false),
  modelCallLimit: z.int().min(0).max(100),
  /** Approved per-call estimate, not a provider bill or token price. */
  estimatedCostPerCallUsd: NullableMoney,
  maxEstimatedCostUsd: NullableMoney,
  pillowPipeline: PillowPipelineSchema.optional(),
}).strict().superRefine((recipe, ctx) => {
  if (recipe.pillowPipeline && (recipe.workflow !== "pillow_photo" || recipe.imagePolicy !== "faithful_enhancement")) {
    ctx.addIssue({ code: "custom", path: ["pillowPipeline"], message: "The versioned pillow pipeline requires faithful enhancement and the pillow workflow" });
  }
});
export type DesignAutomationRecipe = z.infer<typeof DesignAutomationRecipeSchema>;

export const DesignAutomationBlockerCodeSchema = z.enum([
  "order_image_transfer_not_allowed", "model_route_missing", "model_call_limit_exceeded",
  "model_price_missing", "model_budget_missing", "model_budget_exceeded",
  "pillow_image_count_invalid", "pillow_subject_missing", "unexpected_pillow_subject",
  "pillow_model_unverified", "pillow_model_mismatch", "pillow_runtime_unavailable", "pillow_runtime_mismatch",
]);
export type DesignAutomationBlockerCode = z.infer<typeof DesignAutomationBlockerCodeSchema>;
export const DesignAutomationBudgetSchema = z.object({
  allowed: z.boolean(), blockers: z.array(DesignAutomationBlockerCodeSchema),
  plannedModelCalls: z.int().nonnegative().max(200),
  estimatedCostPerCallUsd: NullableMoney,
  estimatedCostUsd: z.number().finite().nonnegative().nullable(),
  maxEstimatedCostUsd: NullableMoney,
  priceSource: z.enum(["configured", "recipe", "none"]),
  costBasis: z.enum(["estimated", "not_applicable"]),
  /** A plan has no provider billing evidence. Zero is only valid with no calls. */
  actualCostUsd: z.literal(0).nullable(),
}).strict().superRefine((budget, ctx) => {
  if (budget.allowed !== (budget.blockers.length === 0)) ctx.addIssue({ code: "custom", path: ["allowed"], message: "Budget blockers must determine readiness" });
  if (budget.plannedModelCalls > 0 && (budget.actualCostUsd !== null || budget.costBasis !== "estimated")) ctx.addIssue({ code: "custom", path: ["actualCostUsd"], message: "A planned model request has no actual billing evidence" });
  if (budget.plannedModelCalls === 0 && (budget.estimatedCostUsd !== 0 || budget.actualCostUsd !== 0 || budget.costBasis !== "not_applicable")) ctx.addIssue({ code: "custom", path: ["estimatedCostUsd"], message: "A plan with no model calls cannot incur model cost" });
});
export type DesignAutomationBudget = z.infer<typeof DesignAutomationBudgetSchema>;

const StepBase = { id: Key, dependsOn: z.array(Key).max(100) };
export const DesignAutomationStepSchema = z.discriminatedUnion("tool", [
  z.object({ ...StepBase, tool: z.literal("validate_inputs"), outputRole: z.literal("input_validation") }).strict(),
  z.object({ ...StepBase, tool: z.literal("compose_template"), outputRole: z.literal("layout") }).strict(),
  z.object({ ...StepBase, tool: z.literal("enhance_image"), outputRole: z.literal("enhanced_image"), sourceImageId: Id }).strict(),
  z.object({ ...StepBase, tool: z.literal("cutout_subject"), outputRole: z.literal("subject_image"), sourceImageId: Id, enhancedStepId: Key.nullable(), subject: PillowSubjectSchema,
    subjectPromptVersion: z.literal(PILLOW_HALF_BODY_PROMPT_VERSION).optional(),
  }).strict().refine(step => (step.subject === "half_body") === (step.subjectPromptVersion !== undefined), "Half-body steps require their own pinned subject prompt; legacy subjects remain unchanged"),
  z.object({ ...StepBase, tool: z.literal("measure_subject"), outputRole: z.literal("subject_measurement"), sourceStepId: Key }).strict(),
  z.object({ ...StepBase, tool: z.literal("ensure_resolution"), outputRole: z.literal("resolution_image"), sourceStepId: Key, measurementStepId: Key }).strict(),
  z.object({ ...StepBase, tool: z.literal("optimize_contour"), outputRole: z.literal("cut_contour"), sourceStepId: Key }).strict(),
  z.object({ ...StepBase, tool: z.literal("preflight"), outputRole: z.literal("quality_report") }).strict(),
  z.object({ ...StepBase, tool: z.literal("render_proof"), outputRole: z.literal("proof") }).strict(),
  z.object({ ...StepBase, tool: z.literal("review_required"), outputRole: z.literal("human_review") }).strict(),
]);
export type DesignAutomationStep = z.infer<typeof DesignAutomationStepSchema>;
export const DesignAutomationPlanSchema = z.object({
  schemaVersion: z.literal(1), recipe: DesignAutomationRecipeSchema,
  status: z.enum(["ready", "blocked"]), blockers: z.array(DesignAutomationBlockerCodeSchema),
  steps: z.array(DesignAutomationStepSchema).min(1).max(108),
  plannedModelCalls: z.int().nonnegative().max(200), budget: DesignAutomationBudgetSchema,
  automaticProductionApproval: z.literal(false),
}).strict().superRefine((plan, ctx) => {
  const known = new Set<string>();
  for (const [index, step] of plan.steps.entries()) {
    if (known.has(step.id) || step.dependsOn.some(id => !known.has(id))) ctx.addIssue({ code: "custom", path: ["steps", index], message: "Steps require unique IDs and preceding dependencies" });
    known.add(step.id);
  }
  if (plan.plannedModelCalls !== plan.budget.plannedModelCalls) ctx.addIssue({ code: "custom", path: ["plannedModelCalls"], message: "Plan and budget call counts must agree" });
  if ((plan.status === "ready") !== (plan.blockers.length === 0 && plan.budget.allowed)) ctx.addIssue({ code: "custom", path: ["status"], message: "Plan blockers and budget determine readiness" });
  if (plan.status === "ready" && plan.plannedModelCalls !== plan.steps.filter(step => step.tool === "enhance_image" || step.tool === "cutout_subject").length) ctx.addIssue({ code: "custom", path: ["plannedModelCalls"], message: "Every model step must be budgeted" });
  const newStages = plan.steps.filter(step => step.tool === "measure_subject" || step.tool === "ensure_resolution");
  if (!plan.recipe.pillowPipeline && newStages.length) ctx.addIssue({ code: "custom", path: ["steps"], message: "Legacy recipes cannot silently acquire new pillow stages" });
  if (plan.recipe.pillowPipeline && plan.status === "ready") {
    const expected = ["validate_inputs", "compose_template", "enhance_image", "cutout_subject", "measure_subject", "ensure_resolution", "optimize_contour", "preflight", "render_proof", "review_required"];
    if (plan.steps.length !== expected.length || plan.steps.some((step, index) => step.tool !== expected[index])) ctx.addIssue({ code: "custom", path: ["steps"], message: "The versioned pillow pipeline has a fixed ordered tool chain" });
  }
  if (plan.steps.at(-1)?.tool !== "review_required") ctx.addIssue({ code: "custom", path: ["steps"], message: "The plan must end in review" });
});
export type DesignAutomationPlan = z.infer<typeof DesignAutomationPlanSchema>;
export const BuildDesignAutomationPlanInputSchema = z.object({
  recipe: DesignAutomationRecipeSchema,
  imageIds: z.array(Id).max(100).refine(ids => new Set(ids).size === ids.length, "Image IDs must be unique"),
  pillowSubject: PillowSubjectSchema.optional(),
  /** Trusted route configuration only. Never derive a per-image price from token pricing. */
  configuredEstimatedCostPerCallUsd: NullableMoney.optional(),
  /** Verified route/provider and local runtime metadata from trusted configuration. */
  configuredModel: z.string().min(1).max(200).nullable().optional(),
  pillowRuntime: PillowUpscalePolicySchema.nullable().optional(),
}).strict();
export type BuildDesignAutomationPlanInput = z.input<typeof BuildDesignAutomationPlanInputSchema>;
export const EvaluateDesignAutomationBudgetInputSchema = z.object({
  recipe: DesignAutomationRecipeSchema, plannedModelCalls: z.int().nonnegative().max(200),
  configuredEstimatedCostPerCallUsd: NullableMoney.optional(),
}).strict();
export type EvaluateDesignAutomationBudgetInput = z.input<typeof EvaluateDesignAutomationBudgetInputSchema>;

const Pixels = z.int().positive().max(100_000);
const Millimetres = z.number().finite().positive().max(5_000);
const Checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const DesignQualityImageInputSchema = z.object({
  sourceImageId: Id, sourceChecksum: Checksum, expectedSourceChecksum: Checksum, outputChecksum: Checksum,
  /** Effective source pixels used by this placement, before upscaling; unknown
   * crop provenance must remain null rather than borrowing output dimensions. */
  sourceWidthPx: Pixels.nullable(), sourceHeightPx: Pixels.nullable(),
  outputWidthPx: Pixels, outputHeightPx: Pixels,
  placedWidthMm: Millimetres, placedHeightMm: Millimetres,
  minimumPpi: z.number().finite().min(1).max(1_200),
  sourceHasAlpha: z.boolean(), outputHasAlpha: z.boolean(), requiresAlpha: z.boolean(),
  scan: z.enum(["clean", "infected", "unavailable"]), modelEdited: z.boolean(),
}).strict().refine(image => (image.sourceWidthPx === null) === (image.sourceHeightPx === null), "Source dimensions must be known together");
export const BuildDesignQualityReportInputSchema = z.object({
  images: z.array(DesignQualityImageInputSchema).max(100),
  /** Raw text is compared in memory and is never included in the report. */
  texts: z.array(z.object({ fieldId: Key, expected: z.string().max(10_000), actual: z.string().max(10_000) }).strict()).max(100),
  preflight: z.object({
    productionReady: z.boolean(),
    issues: z.array(z.object({ code: Key, severity: z.enum(["error", "warning", "manual"]) }).strict()).max(500),
  }).strict(),
}).strict();
export type BuildDesignQualityReportInput = z.infer<typeof BuildDesignQualityReportInputSchema>;
export const DesignQualityStatusSchema = z.enum(["passed", "failed", "needs_review"]);
export const DesignQualityCheckSchema = z.object({
  code: z.enum(["source_provenance", "source_resolution", "output_resolution", "alpha_preservation", "file_scan", "identity_and_content", "text_exact", "production_preflight", "production_review"]),
  status: DesignQualityStatusSchema,
  sourceImageId: Id.optional(), fieldId: Key.optional(),
  sourceChecksum: Checksum.optional(), expectedSourceChecksum: Checksum.optional(), outputChecksum: Checksum.optional(),
  sourcePpi: z.number().finite().nonnegative().nullable().optional(), outputPpi: z.number().finite().nonnegative().optional(),
  minimumPpi: z.number().finite().positive().optional(),
  expectedCharacterCount: z.int().nonnegative().optional(), actualCharacterCount: z.int().nonnegative().optional(),
  preflightCode: Key.optional(),
}).strict();
export type DesignQualityCheck = z.infer<typeof DesignQualityCheckSchema>;
export const DesignQualityReportSchema = z.object({
  schemaVersion: z.literal(1), status: DesignQualityStatusSchema,
  checks: z.array(DesignQualityCheckSchema).min(1).max(1_300),
  automaticProductionApproval: z.literal(false),
  identityVerification: z.literal("not_automatically_verified"),
}).strict();
export type DesignQualityReport = z.infer<typeof DesignQualityReportSchema>;

export const DesignModelAttemptInputSchema = z.object({
  submissionState: z.enum(["not_submitted", "submitted", "succeeded", "failed", "unknown"]),
  actualCostUsd: NullableMoney,
}).strict().refine(input => input.submissionState !== "not_submitted" || input.actualCostUsd === null || input.actualCostUsd === 0, "An unsubmitted request cannot have a charge");
export type DesignModelAttemptInput = z.infer<typeof DesignModelAttemptInputSchema>;
export const DesignModelAttemptAssessmentSchema = z.object({
  safeToResubmit: z.boolean(), retainEstimatedReservation: z.boolean(),
  actualCostUsd: NullableMoney,
  billingStatus: z.enum(["not_incurred", "unknown", "actual_known"]),
}).strict();
export type DesignModelAttemptAssessment = z.infer<typeof DesignModelAttemptAssessmentSchema>;
