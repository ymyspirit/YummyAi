import { z } from "zod";
import { KnowledgeEvaluationReportSchema } from "@yummyai/contracts/knowledge/governance";
export const KnowledgeEvaluationRunPageQuerySchema = z.object({ cursor: z.uuidv7().optional(), limit: z.coerce.number().int().min(1).max(20).default(20) }).strict();
export const KnowledgeEvaluationRunPageSchema = z.object({ items: z.array(KnowledgeEvaluationReportSchema).max(20), nextCursor: z.uuidv7().nullable() }).strict();
export const KnowledgeEvaluationComparisonQuerySchema = z.object({ baselineRunId: z.uuidv7(), candidateRunId: z.uuidv7() }).strict();
export const KnowledgeEvaluationComparisonSchema = z.object({
  baseline: KnowledgeEvaluationReportSchema, candidate: KnowledgeEvaluationReportSchema,
  comparable: z.boolean(), reasons: z.array(z.string().min(1).max(300)).max(12),
}).strict().superRefine((value, ctx) => {
  if (value.comparable !== (value.reasons.length === 0)) ctx.addIssue({ code: "custom", message: "可比状态须与依据诊断一致" });
  if (value.comparable && (value.baseline.id === value.candidate.id || !value.baseline.protocol || !value.candidate.protocol ||
    !value.baseline.assessment || !value.candidate.assessment || value.baseline.caseId !== value.candidate.caseId ||
    value.baseline.protocol.basisFingerprint !== value.candidate.protocol.basisFingerprint || value.baseline.answer.stale || value.candidate.answer.stale ||
    !value.baseline.answer.result || !value.candidate.answer.result))
    ctx.addIssue({ code: "custom", message: "缺少同样本封存依据不能比较" });
});
export type KnowledgeEvaluationRunPage = z.infer<typeof KnowledgeEvaluationRunPageSchema>;
export type KnowledgeEvaluationComparison = z.infer<typeof KnowledgeEvaluationComparisonSchema>;
