import { z } from "zod";
import { EntityIdSchema as Id } from "@yummyai/contracts/common/ids";
import { OrderRuleSnapshotSchema } from "@yummyai/contracts/rules";
import { OrderDesignMethodSnapshotSchema, OrderDesignCompletionRecordSchema, OrderDesignModelCallViewSchema } from "@yummyai/contracts/order/design-harness";
import { PillowContourEvidenceSchema } from "@yummyai/contracts/pod/design-automation";
import { ModelUsageSummarySchema } from "@yummyai/contracts/ai/model-usage";

export const OrderDesignAgentStatusSchema = z.enum(["queued", "running", "awaiting_review", "needs_attention", "cancelled"]);
export const OrderDesignAgentStepStatusSchema = z.enum(["pending", "running", "completed", "failed", "uncertain", "skipped"]);
export const OrderDesignAgentReadQuerySchema=z.object({view:z.enum(["full","financial"]).default("full")}).strict();
export const OrderDesignResponseRecoveryEvidenceSchema = z.object({
  kind: z.literal("operator_verified_provider_result"),
  providerReference: z.string().min(1).max(160), verificationNote: z.string().min(10).max(1000),
  verifiedBy: Id, verifiedAt: z.iso.datetime(), checksum: z.string().regex(/^[a-f0-9]{64}$/),
  previousErrorCode: z.string().nullable(),
});
export const OrderDesignResponseRecoveryTargetSchema = z.object({
  stepId: Id, requestId: Id, stepLabel: z.string(), model: z.string(), sourceAssetId: Id,
  knownResponseChecksum: z.string().nullable(),
});
export const OrderDesignAgentActionSchema = z.object({ runId: Id, expectedRevision: z.int().positive(), idempotencyKey: z.uuid() }).strict();
export const ORDER_DESIGN_RECOVERY_MAX_BYTES = 20 * 1024 * 1024;
export const OrderDesignRestoreResponseSchema = OrderDesignAgentActionSchema.extend({
  stepId: Id, requestId: Id,
  contentBase64: z.string().min(4).max(4 * Math.ceil(ORDER_DESIGN_RECOVERY_MAX_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]+={0,2}$/).refine(value => value.length % 4 === 0, "Invalid base64 length"),
  providerReference: z.string().trim().min(1).max(160), verificationNote: z.string().trim().min(10).max(1000),
  verifiedOriginalResult: z.literal(true),
}).strict();
export type OrderDesignResponseRecoveryEvidence = z.infer<typeof OrderDesignResponseRecoveryEvidenceSchema>;
export type OrderDesignRestoreResponse = z.infer<typeof OrderDesignRestoreResponseSchema>;
export const OrderDesignAgentStepViewSchema = z.object({
  id: Id, key: z.string(), label: z.string(), status: OrderDesignAgentStepStatusSchema,
  attempt: z.int().nonnegative(), errorCode: z.string().nullable(),
  outputAssetId: Id.nullable(), outputVersionId: Id.nullable(),
  startedAt: z.iso.datetime().nullable(), completedAt: z.iso.datetime().nullable(),
  contourEvidence: PillowContourEvidenceSchema.nullable().optional(),
  responseRecovery: OrderDesignResponseRecoveryEvidenceSchema.nullable().optional(),
});
export const OrderDesignAgentRunViewSchema = z.object({
  ruleSnapshot: OrderRuleSnapshotSchema.nullable().optional(),
  methodSnapshot: OrderDesignMethodSnapshotSchema.nullable().optional(),
  completion: OrderDesignCompletionRecordSchema.nullable().optional(),
  privateEvidenceState: z.enum(["available","expired"]).optional(),
  privateEvidenceOmitted:z.boolean().optional(),
  modelCalls:z.array(OrderDesignModelCallViewSchema).max(1000).optional(),
  modelCallsTruncated:z.boolean().optional(),
  usageSummary:ModelUsageSummarySchema.optional(),
  id: Id, workItemId: Id, workRevisionId: Id, revision: z.int().positive(), status: OrderDesignAgentStatusSchema,
  executorKey: z.string(), recipeVersion: z.string(), policyVersion: z.string(), modelRouteId: Id.nullable(),
  projectId: Id.nullable(), currentEditorVersionId: Id.nullable(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  errorCode: z.string().nullable(), canResume: z.boolean(), canTakeOver: z.boolean(),
  responseRecoveryTarget: OrderDesignResponseRecoveryTargetSchema.nullable().optional(),
  responseRecoveryBlockedCode: z.string().nullable().optional(),
  estimatedCostUsd: z.number().nonnegative().nullable(), actualCostUsd: z.number().nonnegative().nullable(),
  costStatus: z.enum(["not_required", "estimated", "unknown", "reported"]),
  qualityDiagnostics: z.array(z.object({ code: z.string(), severity: z.enum(["error", "warning", "manual"]), message: z.string() })),
  steps: z.array(OrderDesignAgentStepViewSchema),
});
export const OrderDesignAgentViewSchema = z.object({ run: OrderDesignAgentRunViewSchema.nullable(), usageSummary:ModelUsageSummarySchema.optional() });
export type OrderDesignAgentView = z.infer<typeof OrderDesignAgentViewSchema>;
export type OrderDesignAgentRunView = z.infer<typeof OrderDesignAgentRunViewSchema>;
export const DesignAgentViewSchema = OrderDesignAgentViewSchema;
export type DesignAgentRunView = OrderDesignAgentRunView;
