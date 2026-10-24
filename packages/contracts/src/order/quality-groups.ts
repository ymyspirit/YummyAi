import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { QualityCriterionResultsSchema, evaluateQualityAssessment, type QualityStandardBasis } from "@yummyai/contracts/order/quality-assessment";
import { RecordQualityInspectionInputSchema } from "@yummyai/contracts/order/production";
import { ErpContextAuthoritySchema } from "@yummyai/contracts/auth/session";

const Defects = RecordQualityInspectionInputSchema.shape.defects;
export const QualityPhysicalGroupInputSchema = z.object({
  key: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  label: z.string().trim().min(1).max(160),
  quantity: z.int().positive().max(100_000),
  criterionResults: QualityCriterionResultsSchema,
  defects: Defects,
}).strict().superRefine((group, context) => {
  if (new Set(group.defects.map(defect => defect.code)).size !== group.defects.length)
    context.addIssue({ code: "custom", path: ["defects"], message: "同一实物组内每个缺陷代码只能记录一次" });
});
export const RecordQualityGroupsInputSchema = z.object({
  formatVersion: z.literal(3),
  productionVersionId: EntityIdSchema,
  expectedProductionProjectionVersion: z.int().positive(),
  expectedRootInspectionId: EntityIdSchema.nullable(),
  parentGroupId: EntityIdSchema.nullable().default(null),
  qualityStandardVersionId: EntityIdSchema,
  inspectedAt: z.iso.datetime(),
  evidenceAssetIds: z.array(EntityIdSchema).max(100).default([]),
  segregationConfirmed: z.literal(true),
  groups: z.array(QualityPhysicalGroupInputSchema).min(1).max(100),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict().superRefine((input, context) => {
  if (new Set(input.groups.map(group => group.key)).size !== input.groups.length)
    context.addIssue({ code: "custom", path: ["groups"], message: "每个实物组必须使用独立标识" });
  if (new Set(input.groups.map(group => group.label.normalize("NFKC").toLowerCase())).size !== input.groups.length)
    context.addIssue({ code: "custom", path: ["groups"], message: "隔离位置标识不能重复 请先核对实际实物组" });
  if (input.groups.reduce((total, group) => total + group.quantity, 0) > 100_000)
    context.addIssue({ code: "custom", path: ["groups"], message: "本次分组数量超出支持范围" });
});
export type QualityPhysicalGroupInput = z.infer<typeof QualityPhysicalGroupInputSchema>;
export type RecordQualityGroupsInput = z.infer<typeof RecordQualityGroupsInputSchema>;

/** Groups are disjoint physical sets; defects overlap only by sharing a group. */
export function evaluateQualityGroups(standard: QualityStandardBasis, groups: QualityPhysicalGroupInput[], expectedQuantity: number) {
  const problems: string[] = [];
  const quantity = groups.reduce((total, group) => total + group.quantity, 0);
  if (!Number.isInteger(expectedQuantity) || expectedQuantity < 1 || quantity !== expectedQuantity)
    problems.push("分组数量之和必须完整覆盖原生产数量或所选原组数量");
  const evaluated = groups.map(group => {
    const result = evaluateQualityAssessment(standard, group.criterionResults, group.defects);
    problems.push(...result.problems.map(problem => group.label + "：" + problem));
    if ((result.result === "failed" || group.criterionResults.some(criterion => !criterion.passed)) && !group.defects.length)
      problems.push(group.label + "：未通过的实物组必须登记实际缺陷与处理");
    return { key: group.key, quantity: group.quantity, scoreBps: result.scoreBps, result: result.result };
  });
  const defectQuantities = new Map<string, number>();
  for (const group of groups) for (const code of new Set(group.defects.map(defect => defect.code)))
    defectQuantities.set(code, (defectQuantities.get(code) ?? 0) + group.quantity);
  return {
    problems, groups: evaluated,
    scoreBps: problems.length || !quantity ? null : Math.round(evaluated.reduce((sum, group) => sum + group.quantity * (group.scoreBps ?? 0), 0) / quantity),
    result: problems.length ? null : evaluated.every(group => group.result === "passed") ? "passed" as const : "failed" as const,
    passedQuantity: evaluated.filter(group => group.result === "passed").reduce((sum, group) => sum + group.quantity, 0),
    heldQuantity: evaluated.filter(group => group.result === "failed").reduce((sum, group) => sum + group.quantity, 0),
    defectQuantities: [...defectQuantities].map(([code, affectedQuantity]) => ({ code, affectedQuantity })),
  };
}

export const QualityPhysicalGroupViewSchema = z.object({
  id: EntityIdSchema, inspectionId: EntityIdSchema, productionOrderId: EntityIdSchema, productionVersionId: EntityIdSchema,
  parentGroupId: EntityIdSchema.nullable(), rootInspectionId: EntityIdSchema,
  key: z.string(), label: z.string(), quantity: z.int().positive(), result: z.enum(["passed", "failed"]), scoreBps: z.int(),
  quantityBlockers: z.array(z.string()).optional(),
  scrappedQuantity: z.int().nonnegative().optional(), reinspectableQuantity: z.int().nonnegative().optional(),
  remakeEligible: z.boolean().optional(), remainingScrapRemakeQuantity: z.int().nonnegative().optional(),
  scrapBasisFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  qualityStandardVersionId: EntityIdSchema, criterionResults: QualityCriterionResultsSchema, inspectedAt: z.iso.datetime(),
  productionProjectionVersion: z.int().positive(), active: z.boolean(), shippedQuantity: z.int().nonnegative(),
  remakeQuantity: z.int().nonnegative(), remainingRemakeQuantity: z.int().nonnegative(),
  replacements: z.array(z.object({ recoveryId: EntityIdSchema, productionOrderId: EntityIdSchema, quantity: z.int().positive(),
    caseStatus: z.string(), status: z.string(), reserved: z.boolean() }).strict()),
  defects: z.array(z.object({ id: EntityIdSchema, code: z.string(), severity: z.string(), responsibility: z.string(), disposition: z.string(),
    note: z.string(), affectedQuantity: z.int().positive() })),
}).strict();
export const QualityGroupsWorkspaceSchema = z.object({
  productionOrderId: EntityIdSchema, orderId: EntityIdSchema, productionVersionId: EntityIdSchema,
  projectionVersion: z.int().positive(), quantity: z.int().nonnegative(), rootInspectionId: EntityIdSchema.nullable(),
  groups: z.array(QualityPhysicalGroupViewSchema), blockers: z.array(z.string()),
  contextAuthority: ErpContextAuthoritySchema.optional(),
  access: z.object({ canRead: z.literal(true), canWrite: z.boolean() }).strict().optional(),
}).strict();
export type QualityPhysicalGroupView = z.infer<typeof QualityPhysicalGroupViewSchema>;
export type QualityGroupsWorkspace = z.infer<typeof QualityGroupsWorkspaceSchema>;
export const QualityGroupsMutationResultSchema = z.object({
  inspectionId: EntityIdSchema, replayed: z.boolean(), workspace: QualityGroupsWorkspaceSchema,
}).strict();
