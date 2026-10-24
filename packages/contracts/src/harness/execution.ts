import { z } from "zod";
import { TenantContextSchema } from "@yummyai/contracts/tenant/tenant-context";

const Key = z.string().regex(/^[a-z][a-z0-9_.-]{2,159}$/);
const Version = z.string().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/);
const Checksum = z.string().regex(/^[a-f0-9]{64}$/);
export const HarnessReferenceSchema = z.object({ key: Key, version: Version, checksum: Checksum }).strict();
export const HarnessExecutionContractSchema = z.object({
  contractVersion: z.literal("native-harness-v1"),
  executorKey: Key,
  skill: HarnessReferenceSchema,
  tools: z.array(HarnessReferenceSchema).min(1).max(32),
  checksum: Checksum,
}).strict();
export const HarnessToolDescriptorSchema = z.object({
  key: Key,
  version: Version,
  label: z.string().min(1).max(160),
  owner: Key,
  effect: z.enum(["read", "internal_write", "external_request", "delegated_job"]),
  inputSchemaKey: Key,
  outputSchemaKey: Key,
  inputSchemaChecksum: Checksum,
  outputSchemaChecksum: Checksum,
  permissionPolicyVersion: Version,
  requiredPermissions: z.array(z.string().min(1).max(100)).min(1).max(32),
  resourcePolicy: Key,
  dataDomains: z.array(z.enum(["research", "authorized_asset", "order_private", "knowledge", "business"])).min(1).max(5),
  // result_deadline rejects a late completed read; it never claims to cancel its native query.
  timeout: z.object({ mode: z.enum(["abort_signal", "fenced_lease", "result_deadline"]), milliseconds: z.int().positive().max(86_400_000) }).strict(),
  maxInputBytes: z.int().positive().max(8 * 1024 * 1024),
  maxOutputBytes: z.int().positive().max(8 * 1024 * 1024),
  recovery: z.enum(["owner_receipt", "response_or_reconcile", "original_child_task"]),
  approval: z.literal("owning_business_flow"),
}).strict();
export const HarnessArtifactOutcomeSchema = z.object({
  artifactId: z.uuidv7(),
  artifactType: z.enum(["product_facts", "product_package", "design_version"]),
  checksum: Checksum,
  label: z.string().min(1).max(160),
}).strict();
export const HarnessDelegatedOutcomeSchema = z.union([
  HarnessArtifactOutcomeSchema,
  z.object({ delegatedTaskId: z.uuidv7(), state: z.literal("waiting") }).strict(),
]);
export type HarnessReference = z.infer<typeof HarnessReferenceSchema>;
export type HarnessExecutionContract = z.infer<typeof HarnessExecutionContractSchema>;
export type HarnessToolDescriptor = z.infer<typeof HarnessToolDescriptorSchema>;

export const HarnessUsdSchema = z.string().regex(/^(0|[1-9]\d{0,11})\.\d{8}$/);
export const ModelBillingAcknowledgmentSchema=z.object({
  id:z.uuidv7(),sequence:z.int().positive(),amountUsd:HarnessUsdSchema,
  proofChecksum:z.string().regex(/^[a-f0-9]{64}$/),verification:z.literal("operator_attested"),
  checkedAt:z.iso.datetime(),checkedBy:z.uuidv7(),
}).strict();
export type ModelBillingAcknowledgment=z.infer<typeof ModelBillingAcknowledgmentSchema>;
export const HarnessInvocationViewSchema = z
  .object({
    version: z.literal("harness-invocation-v1"),
    owner: z.enum(["assist", "workflow", "pod"]),
    id: z.uuidv7(),
    requestId: z.uuid().nullable(),
    parentId: z.uuidv7().nullable(),
    method: HarnessReferenceSchema.nullable(),
    tool: HarnessReferenceSchema.nullable(),
    state: z.enum([
      "queued",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
      "uncertain",
    ]),
    boundary: z.enum([
      "legacy_missing",
      "not_submitted",
      "submitted",
      "received",
      "owner_receipt",
      "delegated_task",
    ]),
    dispatches: z.int().nonnegative().nullable(),
    processingAttempts: z.int().nonnegative().nullable(),
    submittedAt: z.iso.datetime().nullable(),
    receivedAt: z.iso.datetime().nullable(),
    startedAt: z.iso.datetime().nullable(),
    finishedAt: z.iso.datetime().nullable(),
    providerRequestId: z.string().max(512).nullable(),
    responseChecksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    model: z
      .object({ key: z.string().min(1).max(512), version: z.string().min(1).max(512).nullable() })
      .strict()
      .nullable(),
    artifact: z
      .object({
        kind: z.enum(["owner_receipt", "design_version"]),
        id: z.uuidv7(),
        checksum: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable(),
      })
      .strict()
      .nullable(),
    usage: z
      .object({
        inputTokens: z.int().nonnegative().nullable(),
        outputTokens: z.int().nonnegative().nullable(),
      })
      .strict(),
    billing: z
      .object({
        basis: z.enum([
          "configured_rate",
          "processor_reported",
          "unknown",
          "not_submitted",
          "not_applicable",
        ]),
        amountUsd: HarnessUsdSchema.nullable(),
        budgetState: z.enum(["reserved", "committed", "released"]).nullable(),
        budgetAmountUsd: HarnessUsdSchema.nullable(),
        needsProviderEvidence: z.boolean(),
        reconciliation:ModelBillingAcknowledgmentSchema.nullable().optional(),
      })
      .strict(),
    issues: z
      .array(
        z.enum([
          "legacy_execution_missing",
          "execution_contract_unavailable",
          "receipt_unavailable",
          "submission_unknown",
          "cost_unknown",
          "linked_owner_unavailable",
          "response_metadata_invalid",
          "ambiguous_budget",
        ]),
      )
      .max(8),
  })
  .strict()
  .superRefine((value, context) => {
    const priced = ["configured_rate", "processor_reported"].includes(value.billing.basis);
    if (priced !== (value.billing.amountUsd !== null))
      context.addIssue({
        code: "custom",
        path: ["billing", "amountUsd"],
        message: "Only a recorded pricing basis can carry an amount",
      });
    if (priced && !value.billing.needsProviderEvidence && !value.billing.reconciliation)
      context.addIssue({
        code: "custom",
        path: ["billing", "needsProviderEvidence"],
        message: "Calculated or processor-reported costs are not reconciled provider invoices",
      });
    if (value.boundary === "legacy_missing" && (value.submittedAt || value.receivedAt))
      context.addIssue({
        code: "custom",
        path: ["boundary"],
        message: "Do not manufacture legacy submission evidence",
      });
  });
export type HarnessInvocationView = z.infer<typeof HarnessInvocationViewSchema>;

/** Bounded response metadata only. Original prompts, bytes and URLs are not trace fields. */
export const PodInvocationReceiptSchema = z
  .object({
    version: z.literal("pod-response-v1"),
    responseChecksum: z.string().regex(/^[a-f0-9]{64}$/),
    providerRequestId: z.string().min(1).max(512).nullable(),
    modelKey: z.string().min(1).max(160).nullable(),
    modelVersion: z.string().min(1).max(160).nullable(),
    costUsd: HarnessUsdSchema.nullable(),
    metadataValid: z.boolean(),
    receivedAt: z.iso.datetime(),
  })
  .strict();
export type PodInvocationReceipt = z.infer<typeof PodInvocationReceiptSchema>;

/** Server-owned ceilings. Job envelopes carry only execution/owner references. */
const CreativeAuthorityContextSchema = TenantContextSchema.safeExtend({
  permissions: z.array(z.string().min(1).max(128)).min(1).max(256).readonly(),
}).strict();
export const CreativeExecutionAuthoritySchema = z.object({
  version: z.literal("creative-authority-v1"),
  mode: z.enum(["membership", "server_adapter"]),
  context: CreativeAuthorityContextSchema,
}).strict().superRefine((value, ctx) => {
  if (value.mode === "membership" && value.context.permissionScopes === undefined)
    ctx.addIssue({ code: "custom", message: "Authority mode must match its original permission scope", path: ["mode"] });
});
export const CreativeExecutionKindSchema = z.enum([
  "creative_candidate", "creative_adaptation", "template_compile", "mockup_render", "studio_generation",
]);
export const CreativeExecutionCompletionSchema = z.object({
  version: z.literal("creative-completion-v1"),
  executionId: z.uuidv7(),
  inputFingerprint: Checksum,
  responseChecksum: Checksum.nullable(),
  artifacts: z.array(z.object({ assetId: z.uuidv7(), version: z.int().positive(), checksumSha256: Checksum }).strict()).max(100),
  ownerResultChecksum: Checksum,
}).strict();
export type CreativeExecutionAuthority = z.infer<typeof CreativeExecutionAuthoritySchema>;
export type CreativeExecutionKind = z.infer<typeof CreativeExecutionKindSchema>;
export type CreativeExecutionCompletion = z.infer<typeof CreativeExecutionCompletionSchema>;
