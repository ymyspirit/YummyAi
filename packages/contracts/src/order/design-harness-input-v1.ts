import { z } from "zod";
import {
  DesignAutomationRecipeSchema, DesignAutomationBudgetSchema, DesignAutomationBlockerCodeSchema,
  PillowSubjectSchema, PILLOW_HALF_BODY_PROMPT_VERSION,
} from "@yummyai/contracts/pod/design-automation";

/** The original V1/V2 Harness schema is part of immutable execution contracts.
 * Keep its original step variants and plan shape instead of deriving them from
 * the expanding automation union. Unchanged recipe/budget dependencies are
 * guarded by the complete pre-revision contract checksum regression fixtures. */
const StepId = z.uuidv7();
const Key = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/);
const StepBase = { id: Key, dependsOn: z.array(Key).max(100) };
const StepV1Schema = z.discriminatedUnion("tool", [
  z.object({ ...StepBase, tool: z.literal("validate_inputs"), outputRole: z.literal("input_validation") }).strict(),
  z.object({ ...StepBase, tool: z.literal("compose_template"), outputRole: z.literal("layout") }).strict(),
  z.object({ ...StepBase, tool: z.literal("enhance_image"), outputRole: z.literal("enhanced_image"), sourceImageId: StepId }).strict(),
  z.object({ ...StepBase, tool: z.literal("cutout_subject"), outputRole: z.literal("subject_image"), sourceImageId: StepId, enhancedStepId: Key.nullable(), subject: PillowSubjectSchema,
    subjectPromptVersion: z.literal(PILLOW_HALF_BODY_PROMPT_VERSION).optional(),
  }).strict().refine(step => (step.subject === "half_body") === (step.subjectPromptVersion !== undefined), "Half-body steps require their own pinned subject prompt; legacy subjects remain unchanged"),
  z.object({ ...StepBase, tool: z.literal("measure_subject"), outputRole: z.literal("subject_measurement"), sourceStepId: Key }).strict(),
  z.object({ ...StepBase, tool: z.literal("ensure_resolution"), outputRole: z.literal("resolution_image"), sourceStepId: Key, measurementStepId: Key }).strict(),
  z.object({ ...StepBase, tool: z.literal("optimize_contour"), outputRole: z.literal("cut_contour"), sourceStepId: Key }).strict(),
  z.object({ ...StepBase, tool: z.literal("preflight"), outputRole: z.literal("quality_report") }).strict(),
  z.object({ ...StepBase, tool: z.literal("render_proof"), outputRole: z.literal("proof") }).strict(),
  z.object({ ...StepBase, tool: z.literal("review_required"), outputRole: z.literal("human_review") }).strict(),
]);
const PlanV1Schema = z.object({
  schemaVersion: z.literal(1), recipe: DesignAutomationRecipeSchema,
  status: z.enum(["ready", "blocked"]), blockers: z.array(DesignAutomationBlockerCodeSchema),
  steps: z.array(StepV1Schema).min(1).max(108),
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

const Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const OrderDesignPinnedPlanHarnessInputV1Schema = z.object({
  workItemId: Id, workRevisionId: Id, sourceVersionId: Id.nullable(),
  templateVersionId: Id, templateChecksum: Hash, businessSnapshotChecksum: Hash,
  workflow: z.enum(["template", "pillow_photo"]), recipe: DesignAutomationRecipeSchema, plan: PlanV1Schema,
}).strict().superRefine((value, context) => {
  if (value.workflow !== value.recipe.workflow || JSON.stringify(value.recipe) !== JSON.stringify(value.plan.recipe))
    context.addIssue({ code: "custom", message: "Order design recipe and original plan must agree" });
});
