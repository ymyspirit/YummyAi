import { z } from "zod";
import { KnowledgeSearchSchema } from "@yummyai/contracts/knowledge";

export const KnowledgeEvaluationCaseSchema = z.object({
  label: z.string().trim().min(1).max(180), search: KnowledgeSearchSchema,
  expectedFacts: z.array(z.string().trim().min(1).max(300)).max(20),
  forbiddenClaims: z.array(z.string().trim().min(1).max(300)).max(20),
  requiredEntryIds: z.array(z.uuidv7()).max(12), expectRefusal: z.boolean(),
}).strict();
export type KnowledgeEvaluationCase = z.infer<typeof KnowledgeEvaluationCaseSchema>;
