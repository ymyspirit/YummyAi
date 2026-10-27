import { z } from "zod";
import { KnowledgeReferenceSchema, KnowledgeSearchSchema } from "@yummyai/contracts/knowledge";
import { ArtworkAuditReportSchema, ArtworkVisualCheckSchema } from "@yummyai/contracts/ai/artwork-audit";
import { CreativeRequirementsSchema } from "@yummyai/contracts/catalog/artwork";
import { ResearchSourceSelectionSchema } from "@yummyai/contracts/research/creative";
import { TenantContextSchema } from "@yummyai/contracts/tenant/tenant-context";
import { HarnessExecutionContractSchema, HarnessInvocationViewSchema } from "@yummyai/contracts/harness";
import { AgentMethodSelectionSchema } from "@yummyai/contracts/harness/methods";
import { BenchmarkTypedAnswerSchema } from "@yummyai/contracts/knowledge/benchmark-values";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { OrderRequirementRoleSchema } from "@yummyai/contracts/order/requirement-interpretation";

export const AssistKindSchema = z.enum([
  "creative",
  "order_review",
  "artwork_preflight",
  "template_config",
  "sku_package",
  "business_review",
  "procurement_review",
  "after_sales_review",
  "knowledge_answer",
]);
const Id = z.uuidv7();
export const AssistInputAuthorityAuditSchema = z.object({
  version: z.literal("assist-input-authority-v1"),
  capturedAt: z.iso.datetime(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const AssistInputAuthoritySchema = AssistInputAuthorityAuditSchema.extend({
  resources: z.array(z.object({ key: z.string().min(1).max(100), required: z.boolean(), count: z.int().nonnegative(), checksum: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(64),
}).strict();
export type AssistInputAuthority = z.infer<typeof AssistInputAuthoritySchema>;
const Text = z.string().trim().max(2000);
export const AssistEvidenceSchema = z
  .object({ sourceId: z.string().min(1).max(180), detail: z.string().min(1).max(500) })
  .strict();
export const AssistFindingSchema = z
  .object({
    title: z.string().min(1).max(160),
    detail: Text,
    kind: z.enum(["fact", "inference", "recommendation"]),
    severity: z.enum(["info", "warning", "error"]),
    evidence: z.array(AssistEvidenceSchema).max(12),
    location: z.string().max(180).nullable(),
  })
  .strict();
export const AssistDirectionSchema = z
  .object({
    title: z.string().min(1).max(160),
    rationale: Text,
    prompt: z.string().min(1).max(8000),
    negativePrompt: z.string().max(4000),
    requirements: z
      .object(CreativeRequirementsSchema.shape)
      .pick({
        mode: true,
        audience: true,
        occasion: true,
        style: true,
        fixedElements: true,
        imageInstructions: true,
        acceptance: true,
      })
      .strict(),
    fields: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
            label: z.string().min(1).max(120),
            type: z.enum(["short_text", "long_text", "image"]),
            required: z.boolean(),
            maxLength: z.int().positive().max(10000).nullable(),
            helpText: z.string().max(500),
          })
          .strict(),
      )
      .max(30),
    evidence: z.array(AssistEvidenceSchema).max(12),
  })
  .strict();
export const AssistMatchSchema = z
  .object({
    artworkVersionId: Id,
    specificationVersionId: Id,
    reason: z.string().min(1).max(2000),
    evidence: z.array(AssistEvidenceSchema).max(12),
  })
  .strict();
export const AssistTemplateSlotSchema = z
  .object({
    stableKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/),
    name: z.string().min(1).max(200),
    kind: z.enum(["image", "text", "decoration", "background"]),
    fillMode: z.enum(["contain", "cover", "stretch", "tile", "none"]),
    replaceable: z.boolean(),
    fieldKey: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,79}$/)
      .nullable(),
    reuseLabel: z.string().min(1).max(120).nullable(),
    reason: Text,
    evidence: z.array(AssistEvidenceSchema).min(1).max(12),
  })
  .strict();
export const AssistListingCopySchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().min(1).max(10000),
    bullets: z.array(z.string().min(1).max(500)).max(5),
    tags: z.array(z.string().min(1).max(20)).max(13),
    personalizationInstructions: z.string().max(1024),
    imageDescriptions: z
      .array(
        z
          .object({
            assetId: Id,
            text: z.string().min(1).max(500),
            evidence: z.array(AssistEvidenceSchema).min(1).max(6),
          })
          .strict(),
      )
      .max(16),
    evidence: z.array(AssistEvidenceSchema).min(1).max(30),
  })
  .strict();
export const AssistOrderFieldBindingSchema = z.object({
  sourceFieldKey: z.string().min(1).max(1000),
  targetFieldKey: z.string().min(1).max(100).nullable(),
  role: OrderRequirementRoleSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(2000),
  evidence: z.array(AssistEvidenceSchema).min(1).max(12),
}).strict();
export type AssistOrderFieldBinding = z.infer<typeof AssistOrderFieldBindingSchema>;
export const AssistResultSchema = z
  .object({
    summary: z.string().min(1).max(4000),
    // No default: old sealed outputs and their checksums must remain byte-compatible.
    typedAnswers: z.array(BenchmarkTypedAnswerSchema).max(20).optional(),
    artworkChecks: z.array(ArtworkVisualCheckSchema).max(3).default([]),
    findings: z.array(AssistFindingSchema).max(50),
    directions: z.array(AssistDirectionSchema).max(3),
    matches: z.array(AssistMatchSchema).max(3),
    // Optional, without a default, so previously sealed result bytes do not change.
    orderFieldBindings: z.array(AssistOrderFieldBindingSchema).max(500).optional(),
    missingInformation: z.array(z.string().min(1).max(500)).max(25),
    templateSlots: z.array(AssistTemplateSlotSchema).max(60).default([]),
    listingCopy: AssistListingCopySchema.nullable().default(null),
    actions: z
      .array(
        z
          .object({
            title: z.string().min(1).max(160),
            detail: Text,
            priority: z.enum(["high", "normal", "low"]),
            sourceId: z.string().min(1).max(160),
            evidence: z.array(AssistEvidenceSchema).min(1).max(12),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    replyDraft: z
      .object({
        locale: z.enum(["en-US", "zh-CN"]),
        body: z.string().min(1).max(4000),
        evidence: z.array(AssistEvidenceSchema).min(1).max(12),
      })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
/** Exact v1 registered output. Adding optional fields must not change old tool pins. */
export const LegacyAssistResultSchema = AssistResultSchema.omit({ typedAnswers: true, orderFieldBindings: true });
/** The existing benchmark keeps its original schema and method checksum. */
export const BenchmarkAssistResultSchema = AssistResultSchema.omit({ orderFieldBindings: true });
/** Fresh order analysis has a strict provider schema; old sealed wire results have no new default. */
export const OrderReviewAssistResultSchema = LegacyAssistResultSchema.extend({
  orderFieldBindings: z.array(AssistOrderFieldBindingSchema).max(500).default([]),
});
const Request = z.object({
  requestId: z.uuid(),
  modelId: Id,
  salesPlan: z.object({ id: Id, revision: z.int().positive() }).strict().optional(),
  taskGoal: z.string().trim().max(2000).optional(),
  expectedTaskFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
});
const BusinessSelection = z.object({
  kind: z.literal("business_review"),
  runId: Id,
  comparisonRunId: Id.nullable(),
});
const ProcurementSelection = z.object({
  kind: z.literal("procurement_review"),
  stockItemId: Id,
  locationId: Id,
});
const AfterSalesSelection = z.object({
  kind: z.literal("after_sales_review"),
  caseId: Id,
  locale: z.enum(["en-US", "zh-CN"]),
  contextNotes: z.string().max(4000),
});
export const AssistBusinessSelectionSchema = z.discriminatedUnion("kind", [
  BusinessSelection.strict(),
  ProcurementSelection.strict(),
  AfterSalesSelection.strict(),
]);
const BusinessRequest = Request.extend({ expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/) });
export const CreateAssistSchema = z.discriminatedUnion("kind", [
  Request.extend({
    kind: z.literal("knowledge_answer"), scopeId: z.uuid(), search: KnowledgeSearchSchema,
    purpose: z.enum(["dialogue","evaluation"]).default("dialogue"),
    evidenceStoreId: Id.nullable().default(null), previousRunId: Id.nullable().default(null),
  }).strict(),
  Request.extend({
    kind: z.literal("creative"),
    scopeId: z.uuid(),
    projectId: Id.optional(),
    sources: z.array(ResearchSourceSelectionSchema).min(1).max(8),
    prompt: z.string().max(8000),
    requirements: CreativeRequirementsSchema,
  }).strict(),
  Request.extend({
    kind: z.literal("order_review"),
    orderLineId: Id,
    expectedRevision: z.int().nonnegative(),
    expectedSourceVersionId: Id.nullable(),
    // Explicit analysis of the current editor draft; it never saves or approves it.
    draft: OrderWorkDraftSchema.optional(),
  }).strict(),
  Request.extend({
    kind: z.literal("artwork_preflight"),
    orderLineId: Id,
    expectedRevision: z.int().positive(),
    expectedEditorVersionId: Id,
    automaticAudit: z.literal(true).optional(),
    retryAudit: z.literal(true).optional(),
  }).strict(),
  Request.extend({ kind: z.literal("template_config"), inspectionId: Id }).strict(),
  Request.extend({ kind: z.literal("sku_package"), listingId: Id, expectedVersionId: Id }).strict(),
  BusinessRequest.extend(BusinessSelection.shape).strict(),
  BusinessRequest.extend(ProcurementSelection.shape).strict(),
  BusinessRequest.extend(AfterSalesSelection.shape).strict(),
]);
export const AssistModelInputSchema = z
  .object({
    providerConfigId: Id,
    model: z.string().trim().min(1).max(120),
    label: z.string().trim().min(1).max(100),
    inputUsdPerMillion: z.number().nonnegative().max(1000),
    outputUsdPerMillion: z.number().nonnegative().max(5000),
    maxTaskCostUsd: z.number().positive().max(20).default(1),
  })
  .strict();
export const AssistModelSchema = AssistModelInputSchema.omit({ providerConfigId: true }).extend({
  id: Id,
  label: z.string(),
  providerLabel: z.string(),
  inputUsdPerMillion: z.number().nonnegative().nullable(),
  outputUsdPerMillion: z.number().nonnegative().nullable(),
  maxTaskCostUsd: z.number().positive().nullable(),
});
export const AssistCheckSchema = z
  .object({
    code: z.string(),
    severity: z.enum(["info", "warning", "error", "manual"]),
    message: z.string(),
    location: z.string().nullable(),
  })
  .strict();
export const AssistSourceSchema = z
  .object({ id: z.string(), label: z.string(), href: z.string().nullable() })
  .strict();
export const AssistBasisViewSchema = z
  .object({
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    rows: z.array(z.object({ label: z.string(), value: z.string() }).strict()).max(80),
    sources: z.array(AssistSourceSchema),
    checks: z.array(AssistCheckSchema),
    diagnostics: z.array(z.string()),
  })
  .strict();
export const AssistAccessPolicySnapshotSchema = z.object({
  version: z.string().min(1).max(100),
  requiredPermissions: z.array(z.string().min(1).max(100)).max(30),
  dataScope: TenantContextSchema.shape.dataScope.optional(),
}).strict();
export type AssistAccessPolicySnapshot = z.infer<typeof AssistAccessPolicySnapshotSchema>;

export const AssistBudgetStateSchema = z.enum(["reserved", "committed", "released"]);
export const AssistViewSchema = z
  .object({
    id: Id,
    kind: AssistKindSchema,
    scope: z.string(),
    status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
    createdAt: z.iso.datetime(),
    completedAt: z.iso.datetime().nullable(),
    modelLabel: z.string(),
    model: z.string(),
    promptVersion: z.string(),
    accessPolicy: AssistAccessPolicySnapshotSchema.nullable().optional(),
    inputAuthority: AssistInputAuthorityAuditSchema.nullable().optional(),
    executionContract: HarnessExecutionContractSchema.nullable().optional(),
    methodSelection: AgentMethodSelectionSchema.nullable().optional(),
    invocations: z.array(HarnessInvocationViewSchema).max(1).optional(),
    inputFingerprint: z.string(),
    stale: z.boolean(),
    maxTaskCostUsd: z.number().nullable(),
    request: CreateAssistSchema.nullable(),
    inputTokens: z.int().nonnegative().nullable(),
    outputTokens: z.int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
    budgetState: AssistBudgetStateSchema.nullable().optional(),
    error: z.string().nullable(),
    diagnostics: z.array(z.string()),
    sources: z.array(AssistSourceSchema),
    knowledge: z.array(KnowledgeReferenceSchema).default([]),
    checks: z.array(AssistCheckSchema),
    result: AssistResultSchema.nullable(),
    artworkAudit: ArtworkAuditReportSchema.nullable().optional(),
    images: z
      .array(z.object({ sourceId: z.string(), label: z.string(), path: z.string() }).strict())
      .default([]),
  })
  .strict();
export type AssistKind = z.infer<typeof AssistKindSchema>;
export type CreateAssist = z.infer<typeof CreateAssistSchema>;
export type AssistResult = z.infer<typeof AssistResultSchema>;
export type AssistDirection = z.infer<typeof AssistDirectionSchema>;
export type AssistMatch = z.infer<typeof AssistMatchSchema>;
export type AssistTemplateSlot = z.infer<typeof AssistTemplateSlotSchema>;
export type AssistListingCopy = z.infer<typeof AssistListingCopySchema>;
export type AssistCheck = z.infer<typeof AssistCheckSchema>;
export type AssistSource = z.infer<typeof AssistSourceSchema>;
export type AssistView = z.infer<typeof AssistViewSchema>;
export type AssistModel = z.infer<typeof AssistModelSchema>;
export type AssistBusinessSelection = z.infer<typeof AssistBusinessSelectionSchema>;
export type AssistBasisView = z.infer<typeof AssistBasisViewSchema>;
export function businessAssistSelection(input: AssistBusinessSelection): AssistBusinessSelection {
  if (input.kind === "business_review")
    return { kind: input.kind, runId: input.runId, comparisonRunId: input.comparisonRunId };
  if (input.kind === "procurement_review")
    return { kind: input.kind, stockItemId: input.stockItemId, locationId: input.locationId };
  return {
    kind: input.kind,
    caseId: input.caseId,
    locale: input.locale,
    contextNotes: input.contextNotes,
  };
}
