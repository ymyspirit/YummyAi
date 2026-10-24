import { z } from "zod";
const Hash = z.string().regex(/^[a-f0-9]{64}$/), Id = z.uuidv7();
export const KNOWLEDGE_EVALUATION_ASSERTIONS = "knowledge-answer-assertions-v1" as const;
export const KnowledgeEvaluationCheckSchema = z.object({
  key: z.string().min(1), label: z.string(), status: z.enum(["pass", "fail", "pending"]), detail: z.string().max(6500),
}).strict();
export const KnowledgeEvaluationProtocolSchema = z.object({
  version: z.literal("knowledge-evaluation-v1"), runId: Id,
  caseRevision: z.int().positive(), caseChecksum: Hash, requestChecksum: Hash, basisFingerprint: Hash,
  inputFingerprint: Hash, modelId: Id, dataScope: z.enum(["self", "team", "tenant"]), promptVersion: z.string().min(1).max(200),
  assertionVersion: z.literal(KNOWLEDGE_EVALUATION_ASSERTIONS), createdAt: z.iso.datetime(),
}).strict();
export const KnowledgeEvaluationAssessmentSchema = z.object({
  id: Id, runId: Id, basisFingerprint: Hash, outputChecksum: Hash,
  assertionVersion: z.literal(KNOWLEDGE_EVALUATION_ASSERTIONS), retrievalRecall: z.number().min(0).max(1).nullable(),
  citedRecall: z.number().min(0).max(1).nullable(), checks: z.array(KnowledgeEvaluationCheckSchema).length(7), createdAt: z.iso.datetime(),
}).strict().superRefine((value, ctx) => {
  const keys = ["answer_completed", "retrieval", "citation", "expected_facts", "forbidden", "refusal", "evidence"];
  if (value.checks.some((check, index) => check.key !== keys[index] || check.status === "pending"))
    ctx.addIssue({ code: "custom", message: "封存评分须保留完整确定性检查及终态" });
});
export const KnowledgeEvaluationAssessmentStateSchema = z.enum(["recorded", "awaiting_result", "unrecorded", "unavailable"]);
export type KnowledgeEvaluationProtocol = z.infer<typeof KnowledgeEvaluationProtocolSchema>;
export type KnowledgeEvaluationAssessment = z.infer<typeof KnowledgeEvaluationAssessmentSchema>;
export type KnowledgeEvaluationCheck = z.infer<typeof KnowledgeEvaluationCheckSchema>;
