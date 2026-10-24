import { z } from "zod";
import { KnowledgeFieldsSchema, KnowledgeSearchSchema } from "@yummyai/contracts/knowledge";
import { AssistViewSchema } from "@yummyai/contracts/ai/assist";
import { KnowledgeEvaluationCaseSchema } from "@yummyai/contracts/knowledge/evaluation-case";
import { KnowledgeEvaluationProtocolSchema, KnowledgeEvaluationAssessmentSchema, KnowledgeEvaluationAssessmentStateSchema } from "@yummyai/contracts/knowledge/evaluation-protocol";
export { KnowledgeEvaluationCaseSchema } from "@yummyai/contracts/knowledge/evaluation-case";

const Id = z.uuidv7();
const Reason = z.string().trim().min(1).max(1000);
export const KnowledgeSavedRecordSchema = z.object({ id: Id });
export const KnowledgeOriginalDownloadSchema = z.object({
  base64: z.string(),
  fileName: z.string(),
  mediaType: z.string(),
});
export const KnowledgeAccountSchema = z
  .object({
    storeId: Id,
    currency: z.string().regex(/^[A-Z]{3}$/),
    periodFrom: z.iso.date(),
    periodUntil: z.iso.date(),
    attribution: z.string().trim().min(1).max(300),
  })
  .strict()
  .refine((a) => a.periodUntil >= a.periodFrom, "报告期间不正确");
export const ImportKnowledgeSchema = z
  .object({
    requestId: z.uuid(),
    fileName: z.string().trim().min(1).max(180),
    base64: z.string().min(1).max(7_000_000),
    fields: KnowledgeFieldsSchema,
    account: KnowledgeAccountSchema.nullable(),
    retentionDays: z.int().min(1).max(30).default(7),
  })
  .strict();
export const ConfirmKnowledgeRedactionSchema = z
  .object({
    expectedRevision: z.int().positive(),
    text: z.string().trim().min(1).max(200_000),
    identitiesRemoved: z.literal(true),
    credentialsRemoved: z.literal(true),
    minimumNecessary: z.literal(true),
    reason: Reason,
  })
  .strict();
export const DecideKnowledgeCandidateSchema = z
  .object({
    expectedRevision: z.int().positive(),
    decision: z.enum(["accept", "reject"]),
    fields: KnowledgeFieldsSchema,
    targetEntryId: Id.nullable().default(null),
    targetRevision: z.int().nonnegative().default(0),
    reason: Reason,
    requestId: z.uuid(),
  })
  .strict();
export const SaveKnowledgeSourceSchema = z
  .object({
    label: z.string().trim().min(1).max(240),
    url: z
      .url()
      .max(2000)
      .refine((v) => /^https:\/\//i.test(v), "来源需要公开 HTTPS 地址"),
    owner: z.string().trim().min(1).max(100),
    checkEveryHours: z.int().min(6).max(720),
    freshnessDays: z.int().min(1).max(365),
    monitoring: z.boolean(),
    requestId: z.uuid(),
  })
  .strict();
export const ReviewKnowledgeSourceSchema = z
  .object({
    expectedRevision: z.int().positive(),
    decision: z.enum(["no_business_change", "revision_required", "needs_evidence", "completed"]),
    entryIds: z.array(Id).max(30),
    reason: Reason,
  })
  .strict();
export const SaveKnowledgeNeedSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    owner: z.string().trim().min(1).max(100),
    scope: KnowledgeSearchSchema,
    entryIds: z.array(Id).max(30),
    confirmed: z.literal(true),
    expectedRevision: z.int().nonnegative(),
    requestId: z.uuid(),
  })
  .strict();
export const SaveKnowledgeEvaluationSchema = z
  .object({
    fields: KnowledgeEvaluationCaseSchema,
    expectedRevision: z.int().nonnegative(),
    requestId: z.uuid(),
  })
  .strict();
export const ArchiveKnowledgeEvaluationSchema = z.object({ expectedRevision: z.int().positive(), reason: z.string().trim().min(1).max(1000) }).strict();
export const StartKnowledgeEvaluationSchema = z
  .object({ modelId: Id, requestId: z.uuid() })
  .strict();
export const ReviewKnowledgeEvaluationSchema = z
  .object({
    result: z.enum(["pass", "fail", "needs_review"]),
    reason: Reason,
  })
  .strict();
export const ResolveKnowledgeConflictSchema = z
  .object({
    expectedRevision: z.int().positive(),
    decision: z.enum(["conditional", "superseded", "needs_evidence"]),
    reason: Reason,
  })
  .strict();
export type KnowledgeAccount = z.infer<typeof KnowledgeAccountSchema>;
export type KnowledgeEvaluationCase = z.infer<typeof KnowledgeEvaluationCaseSchema>;

const Stamp = z.iso.datetime();
export const KnowledgeDocumentViewSchema = z.object({
  id: Id,
  revision: z.int(),
  fileName: z.string(),
  checksum: z.string(),
  kind: z.enum(["reference", "account"]),
  state: z.enum(["preview", "confirmed", "failed", "archived"]),
  safeText: z.string(),
  diagnostics: z.array(z.string()),
  account: KnowledgeAccountSchema.nullable(),
  fields: KnowledgeFieldsSchema,
  rawExpiresAt: Stamp,
  hasOriginal: z.boolean(),
  createdAt: Stamp,
  candidates: z.array(
    z.object({
      id: Id,
      revision: z.int(),
      locator: z.string(),
      excerpt: z.string(),
      fields: KnowledgeFieldsSchema,
      decision: z.enum(["pending", "accepted", "rejected"]),
      entryId: Id.nullable(),
      duplicateIds: z.array(Id),
    }),
  ),
});
export type KnowledgeDocumentView = z.infer<typeof KnowledgeDocumentViewSchema>;
export const KnowledgeGovernanceViewSchema = z.object({
  canManage: z.boolean(),
  canPublish: z.boolean(),
  canReadAccount: z.boolean(),
  stores: z.array(z.object({ id: Id, name: z.string(), platform: z.string() })),
  documents: z.array(KnowledgeDocumentViewSchema.omit({ safeText: true, candidates: true })),
  sources: z.array(
    z.object({
      id: Id,
      revision: z.int(),
      label: z.string(),
      url: z.string(),
      owner: z.string(),
      monitoring: z.boolean(),
      checkEveryHours: z.int(),
      freshnessDays: z.int(),
      lastCheckedAt: Stamp.nullable(),
      lastSuccessAt: Stamp.nullable(),
      lastError: z.string().nullable(),
      latestSnapshotId: Id.nullable(),
      dueAt: Stamp.nullable(),
    }),
  ),
  sourceReviews: z.array(
    z.object({
      id: Id,
      revision: z.int(),
      sourceId: Id,
      sourceLabel: z.string(),
      beforeSnapshotId: Id.nullable(),
      afterSnapshotId: Id,
      beforeText: z.string(),
      afterText: z.string(),
      createdAt: Stamp,
      state: z.enum([
        "pending",
        "no_business_change",
        "revision_required",
        "needs_evidence",
        "completed",
      ]),
      reason: z.string(),
      entryIds: z.array(Id),
    }),
  ),
  coverage: z.array(
    z.object({
      id: Id,
      revision: z.int(),
      question: z.string(),
      owner: z.string(),
      scope: KnowledgeSearchSchema,
      entryIds: z.array(Id),
      status: z.enum(["covered", "missing", "expired", "in_review", "scope_mismatch", "conflict"]),
      reasons: z.array(z.string()),
    }),
  ),
  freshness: z.array(
    z.object({
      id: Id,
      kind: z.enum(["card", "source", "document"]),
      label: z.string(),
      status: z.string(),
      due: z.string(),
      reason: z.string(),
    }),
  ),
  conflicts: z.array(
    z.object({
      id: Id,
      revision: z.int(),
      key: z.string(),
      leftVersionId: Id,
      rightVersionId: Id,
      leftEntryId: Id,
      rightEntryId: Id,
      leftTitle: z.string(),
      rightTitle: z.string(),
      leftValue: z.string(),
      rightValue: z.string(),
      leftCondition: z.string(),
      rightCondition: z.string(),
      leftSource: z.string(),
      rightSource: z.string(),
      severity: z.enum(["warning", "blocking"]),
      state: z.enum(["open", "conditional", "superseded", "needs_evidence"]),
      reason: z.string(),
    }),
  ),
  evaluations: z.array(
    z.object({ id: Id, revision: z.int(), fields: KnowledgeEvaluationCaseSchema }),
  ),
});
export type KnowledgeGovernanceView = z.infer<typeof KnowledgeGovernanceViewSchema>;
export const KnowledgeEvaluationReportSchema = z.object({
  id: Id,
  caseId: Id,
  createdAt: Stamp,
  caseSnapshot: KnowledgeEvaluationCaseSchema,
  protocol: KnowledgeEvaluationProtocolSchema.nullable().optional(),
  assessment: KnowledgeEvaluationAssessmentSchema.nullable().optional(),
  assessmentState: KnowledgeEvaluationAssessmentStateSchema.optional(),
  answer: AssistViewSchema,
  retrievalRecall: z.number().nullable(),
  citedRecall: z.number().nullable(),
  checks: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      status: z.enum(["pass", "fail", "pending"]),
      detail: z.string(),
    }),
  ),
  manualReviews: z.array(
    z.object({
      result: z.enum(["pass", "fail", "needs_review"]),
      reason: z.string(),
      createdAt: Stamp,
    }),
  ),
  assertionVersion: z.literal("knowledge-answer-assertions-v1"),
});
export type KnowledgeEvaluationReport = z.infer<typeof KnowledgeEvaluationReportSchema>;
export const KnowledgeConversationSchema = z.object({
  scopeId: z.uuid(),
  question: z.string(),
  updatedAt: Stamp,
  modelLabel: z.string(),
});
export type KnowledgeConversation = z.infer<typeof KnowledgeConversationSchema>;
