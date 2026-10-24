import { z } from "zod";
import { AssistKindSchema, AssistViewSchema, CreateAssistSchema, type CreateAssist } from "@yummyai/contracts/ai/assist";
import { ARTWORK_AUDIT_POLICY } from "@yummyai/contracts/ai/artwork-audit";

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const AssistReceiptQuerySchema = z.object({ requestId: z.uuid(), requestChecksum: Hash }).strict();
export const AssistReceiptViewSchema = z.object({
  version: z.literal("assist-request-receipt-v1"), contextAuthority: z.string().min(1).max(65_536), requestId: z.uuid(), requestChecksum: Hash,
  state: z.enum(["found", "not_found"]), run: AssistViewSchema.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.state === "found") !== (value.run !== null) || value.run?.request && value.run.request.requestId !== value.requestId)
    context.addIssue({ code: "custom", message: "Receipt does not identify the original request" });
});
// Exactly the existing v1 owner fingerprint serialization, including Zod's
// normalized keys/defaults. It remains verifiable after input retention expires.
// Do not replace with sorted-key canonical JSON or rewrite old fingerprints.
export function assistRequestRecoveryText(value: CreateAssist) { return JSON.stringify(CreateAssistSchema.parse(value)); }
export const ASSIST_INTENT_PREFIX = "yummyai.assist-request.intent.v1:";
export const ASSIST_INTENT_CLEAR_EVENT = "yummyai.assist-request-intents-cleared";
export const AssistIntentSchema = z.object({ version: z.literal(1), ownerScope: Hash, taskScope: Hash,
  kind: AssistKindSchema, requestId: z.uuid(), requestChecksum: Hash, runId: z.uuidv7().nullable() }).strict();
export type AssistIntent = z.infer<typeof AssistIntentSchema>;
export type AssistReceiptView = z.infer<typeof AssistReceiptViewSchema>;

/** A native automatic audit may reuse its pinned artwork policy run. This is
 * explicitly not evidence that the newly submitted request ID was persisted. */
export const AssistAutomaticAuditReuseProofSchema = z.object({
  version: z.literal("assist-automatic-audit-reuse-v1"), disposition: z.literal("existing_policy_run"),
  submittedRequestId: z.uuid(), submittedRequestChecksum: Hash, runId: z.uuidv7(),
  originalRequestId: z.uuid(), originalRequestChecksum: Hash, policy: z.literal(ARTWORK_AUDIT_POLICY),
  orderLineId: z.uuidv7(), revision: z.int().positive(), editorVersionId: z.uuidv7(),
}).strict();
