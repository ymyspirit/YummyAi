import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";

export const QualityCriterionResultSchema = z.object({
  code: z.string().regex(/^[A-Z0-9_:-]{1,160}$/),
  scoreBps: z.int().min(0).max(10_000),
  passed: z.boolean(),
  evidenceAssetIds: z.array(EntityIdSchema).max(100).default([]),
}).strict();
export const QualityCriterionResultsSchema = z.array(QualityCriterionResultSchema).min(1).max(200)
  .superRefine((results, context) => {
    if (new Set(results.map(result => result.code)).size !== results.length)
      context.addIssue({ code: "custom", message: "每个质检项目只能核验一次" });
  });
export const QualityAssessmentSchema = z.object({
  formatVersion: z.literal(2),
  criterionResults: QualityCriterionResultsSchema,
}).strict();
export type QualityAssessment = z.infer<typeof QualityAssessmentSchema>;
export type QualityCriterionResult = z.infer<typeof QualityCriterionResultSchema>;
export type QualityStandardBasis = {
  minimumScoreBps: number;
  criteria: Array<{ code: string; label: string; weightBps: number; blocking: boolean }>;
};
type Defect = { severity: string; disposition: string };

/** Scores use positive integer basis points. Failed blocking checks cannot be offset. */
export function evaluateQualityAssessment(
  standard: QualityStandardBasis,
  rawResults: unknown,
  defects: readonly Defect[] = [],
): { problems: string[]; scoreBps: number | null; result: "passed" | "failed" | null; failedBlockingCodes: string[] } {
  const parsed = QualityCriterionResultsSchema.safeParse(rawResults);
  const problems: string[] = [];
  if (!standard.criteria.length || standard.criteria.length > 200 ||
      new Set(standard.criteria.map(criterion => criterion.code)).size !== standard.criteria.length ||
      standard.criteria.some(criterion => !Number.isInteger(criterion.weightBps) || criterion.weightBps < 0) ||
      standard.criteria.reduce((sum, criterion) => sum + criterion.weightBps, 0) !== 10_000)
    problems.push("质检标准项目或权重无效 请保存正确的新标准版本");
  if (!parsed.success) problems.push("请逐项填写质检分数和明确的核验结果 每项只能出现一次");
  if (problems.length || !parsed.success) return { problems, scoreBps: null, result: null, failedBlockingCodes: [] };
  const known = new Set(standard.criteria.map(criterion => criterion.code));
  const results = new Map(parsed.data.map(result => [result.code, result]));
  for (const criterion of standard.criteria) if (!results.has(criterion.code)) problems.push("尚未核验：" + criterion.label);
  for (const code of results.keys()) if (!known.has(code)) problems.push("项目不属于所选标准：" + code);
  if (problems.length) return { problems, scoreBps: null, result: null, failedBlockingCodes: [] };
  const scoreBps = Math.round(standard.criteria.reduce((sum, criterion) =>
    sum + criterion.weightBps * results.get(criterion.code)!.scoreBps, 0) / 10_000);
  const failedBlockingCodes = standard.criteria.filter(criterion =>
    criterion.blocking && !results.get(criterion.code)!.passed).map(criterion => criterion.code);
  const requiresDisposition = defects.some(defect => defect.severity === "critical" || defect.disposition !== "accept");
  return {
    problems, scoreBps, failedBlockingCodes,
    result: scoreBps >= standard.minimumScoreBps && !failedBlockingCodes.length && !requiresDisposition ? "passed" : "failed",
  };
}
