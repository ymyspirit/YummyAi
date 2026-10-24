import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentCommandViewSchema } from "@yummyai/contracts/ai/agent-command";
import { RecordFinanceBillInputSchema } from "@yummyai/contracts/finance/payables";

export const AGENT_DEPENDENCY_PLAN_VERSION = "erp-agent-dependency-plan-v1" as const;
export const AGENT_DEPENDENCY_PLAN_KIND = "procurement_invoice_to_finance_bill" as const;
export const AGENT_DEPENDENCY_PLAN_INTENT_PREFIX = "yummyai.agent-dependency-plan.intent.v1:";
export const AGENT_DEPENDENCY_PLAN_CLEAR_EVENT = "yummyai.agent-dependency-plan-intents-cleared";
export const AGENT_DEPENDENCY_PLAN_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const Id = z.uuidv7().transform(value => value.toLowerCase()), RequestId = z.uuid().transform(value => value.toLowerCase()), Hash = z.string().regex(/^[a-f0-9]{64}$/), Time = z.iso.datetime();
const Authority = z.string().min(1).max(65_536), Version = { version: z.literal(AGENT_DEPENDENCY_PLAN_VERSION) };
const DueAt = z.iso.datetime().refine(value => !value.startsWith("0000-"), "A PostgreSQL calendar year is required").transform(value => new Date(value).toISOString()).nullable();

/** A fixed two-step dependency; it cannot change old sealed proposal semantics. */
export const CreateAgentDependencyPlanSchema = z.object({ ...Version, requestId: RequestId,
  kind: z.literal(AGENT_DEPENDENCY_PLAN_KIND), parentAgentCommandId: Id, dueAt: DueAt }).strict();
export const canonicalAgentDependencyPlanRequest = (raw: unknown) => canonicalJson(CreateAgentDependencyPlanSchema.parse(raw));
export const PrepareAgentDependencyPlanSchema = z.object({ ...Version, requestId: RequestId, sourceChecksum: Hash }).strict();
export const CancelAgentDependencyPlanSchema = z.object({ ...Version, requestId: RequestId }).strict();
export const AgentDependencyPlanReceiptQuerySchema = z.object({ requestId: RequestId, requestChecksum: Hash }).strict();

export const AgentDependencyPlanSourceSchema = z.object({
  invoiceId: Id, purchaseOrderId: Id, purchaseOrderVersionId: Id, procurementProofId: Id, supplierId: Id,
  invoiceNumber: z.string().min(1).max(200), currency: z.string().regex(/^[A-Z]{3}$/),
  totalMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), issuedAt: Time, sourceChecksum: Hash,
}).strict();
export const agentDependencyPlanSourcePayload = (source: z.infer<typeof AgentDependencyPlanSourceSchema>) => {
  const { sourceChecksum, ...fields } = AgentDependencyPlanSourceSchema.parse(source); void sourceChecksum;
  return { version: AGENT_DEPENDENCY_PLAN_VERSION, ...fields };
};
export const AgentDependencyPlanBillDraftSchema = z.object({ domain: z.literal("finance"), command: z.object({
  kind: z.literal("bill_record"), targetId: z.null(), input: RecordFinanceBillInputSchema,
}).strict() }).strict().superRefine((value, context) => {
  if (value.command.input.kind !== "procurement_invoice" || value.command.input.procurementInvoiceId === null)
    context.addIssue({ code: "custom", message: "A dependent bill must retain its real procurement invoice" });
});
export const AgentDependencyPlanCommandSchema = z.object({
  agentCommandId: Id, requestId: RequestId, requestChecksum: Hash, ownerCommandId: Id.nullable(),
  domain: z.enum(["procurement", "finance"]), kind: z.enum(["invoice_record", "bill_record"]),
  state: AgentCommandViewSchema.shape.state, resultId: Id.nullable(),
}).strict().superRefine((value, context) => {
  if (value.domain === "procurement" ? value.kind !== "invoice_record" : value.kind !== "bill_record")
    context.addIssue({ code: "custom", message: "A step must retain its exact registered native command" });
  if (value.resultId !== null && (value.state !== "succeeded" || value.ownerCommandId === null))
    context.addIssue({ code: "custom", message: "A result requires actual native success" });
});
export const AgentDependencyPlanBlockReasonSchema = z.enum([
  "parent_not_succeeded", "parent_unavailable", "parent_terminal", "permission_denied", "source_unavailable", "source_changed", "finance_input_invalid",
  "preparation_unresolved", "child_unavailable", "cancelled", "expired",
]);
export const AgentDependencyPlanStateSchema = z.enum([
  "waiting_predecessor", "predecessor_blocked", "ready_to_prepare", "preparation_unknown", "child_prepared", "child_unknown", "succeeded", "blocked", "cancelled", "expired",
]);
const PlanIdentity = z.object({ ...Version, id: Id, requestId: RequestId, requestChecksum: Hash,
  kind: z.literal(AGENT_DEPENDENCY_PLAN_KIND), parentAgentCommandId: Id, childRequestId: RequestId, childAgentCommandId: Id.nullable(), childOwnerCommandId: Id.nullable(),
  childPreparationRequestChecksum: Hash.nullable(), childOriginalChecksum: Hash.nullable(), preparationRequestedAt: Time.nullable(),
  dueAt: DueAt, createdAt: Time, updatedAt: Time, expiresAt: Time, cancelledAt: Time.nullable(),
});
export const AgentDependencyPlanSummarySchema = PlanIdentity.strict().superRefine((value, context) => {
  if ((value.childPreparationRequestChecksum === null) !== (value.preparationRequestedAt === null)
    || (value.childOriginalChecksum === null) !== (value.preparationRequestedAt === null)
    || value.childAgentCommandId !== null && value.childPreparationRequestChecksum === null
    || value.childOwnerCommandId !== null && value.childAgentCommandId === null)
    context.addIssue({ code: "custom", message: "Child references require the original fixed preparation identity" });
});
export const AgentDependencyPlanViewSchema = z.object({ ...PlanIdentity.shape,
  contextAuthority: Authority, state: AgentDependencyPlanStateSchema,
  parent: AgentDependencyPlanCommandSchema, child: AgentDependencyPlanCommandSchema.nullable(),
  dependency: z.object({ from: z.literal("procurement_invoice"), to: z.literal("finance_bill"), requires: z.literal("original_owner_succeeded") }).strict(),
  source: AgentDependencyPlanSourceSchema.nullable(), childDraft: AgentDependencyPlanBillDraftSchema.nullable(),
  privateAvailable: z.boolean(), canPrepare: z.boolean(), canCancel: z.boolean(), blockReason: AgentDependencyPlanBlockReasonSchema.nullable(),
  businessExecution: z.literal("separate_original_confirmation"), modelCalls: z.literal(0), queueDispatches: z.literal(0),
}).strict().superRefine((value, context) => {
  if (!AgentDependencyPlanSummarySchema.safeParse(Object.fromEntries(Object.keys(PlanIdentity.shape).map(key => [key, value[key as keyof typeof value]]))).success)
    context.addIssue({ code: "custom", message: "The original child preparation identity is incomplete" });
  if (value.parent.agentCommandId !== value.parentAgentCommandId || value.parent.domain !== "procurement"
    || value.child && (value.child.agentCommandId !== value.childAgentCommandId || value.child.domain !== "finance" || value.child.requestId !== value.childRequestId
      || value.child.requestChecksum !== value.childPreparationRequestChecksum || value.child.ownerCommandId !== value.childOwnerCommandId))
    context.addIssue({ code: "custom", message: "Dependency steps must retain their exact original command references" });
  if (value.source && (value.parent.state !== "succeeded" || value.parent.resultId !== value.source.invoiceId))
    context.addIssue({ code: "custom", message: "A future invoice identity requires the real predecessor result" });
  if (value.childDraft) {
    const input = value.childDraft.command.input, source = value.source;
    if (!source || input.procurementInvoiceId !== source.invoiceId || input.supplierId !== source.supplierId || input.currency !== source.currency
      || input.externalBillId !== source.invoiceNumber || input.amountMinor !== source.totalMinor || input.issuedAt !== source.issuedAt || input.dueAt !== value.dueAt)
      context.addIssue({ code: "custom", message: "The child draft must use the exact native source fields and explicit due date" });
  }
  if (!value.privateAvailable && (value.source !== null || value.childDraft !== null)
    || value.canPrepare && (!value.source || !value.childDraft || value.cancelledAt !== null || value.childOwnerCommandId !== null
      || !["ready_to_prepare", "preparation_unknown"].includes(value.state) || value.blockReason !== null && value.blockReason !== "preparation_unresolved")
    || value.state === "succeeded" && (value.child?.state !== "succeeded" || !value.child.resultId))
    context.addIssue({ code: "custom", message: "Only a current source can authorize explicit original preparation; native success stays separate" });
});
export const AgentDependencyPlanListQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20), before: Id.optional(), upperId: Id.optional() }).strict();
export const AgentDependencyPlanPageSchema = z.object({ ...Version, contextAuthority: Authority,
  items: z.array(AgentDependencyPlanSummarySchema).max(50), limit: z.int().min(1).max(50), upperId: Id.nullable(),
  nextBefore: Id.nullable(), hasMore: z.boolean(), scope: z.literal("personal"), coverage: z.literal("bounded_original_id_range"),
}).strict().superRefine((value, context) => {
  if (value.items.length > value.limit || value.hasMore !== (value.nextBefore !== null) || value.items.length > 0 && value.upperId === null)
    context.addIssue({ code: "custom", message: "Recovery pagination must retain its exact bounded original range" });
});
export const AgentDependencyPlanReceiptSchema = z.object({ ...Version, ...AgentDependencyPlanReceiptQuerySchema.shape,
  contextAuthority: Authority, disposition: z.enum(["known", "not_found"]), id: Id.nullable(),
}).strict().superRefine((value, context) => {
  if ((value.disposition === "known") !== (value.id !== null)) context.addIssue({ code: "custom", message: "Only the original known request can identify a plan" });
});
export const AgentDependencyPlanWorkspaceSchema = z.object({ ...Version, contextAuthority: Authority, canCreate: z.boolean(),
  kind: z.literal(AGENT_DEPENDENCY_PLAN_KIND), parents: z.array(z.object({ id: Id, requestId: RequestId, createdAt: Time }).strict()).max(20),
  parentLimit: z.literal(20), parentHasMore: z.boolean(), newPreparationIsExecution: z.literal(false),
}).strict();
/** Minimum scalar navigation only; no invoice number, source fields, original body or confirmation token. */
export const AgentDependencyPlanIntentSchema = z.object({ version: z.literal(1), ownerScope: Hash, requestId: RequestId, requestChecksum: Hash,
  planId: Id.nullable(), state: z.enum(["prepared", "unknown", "prepare_unknown", "cancel_unknown", "known"]), createdAt: Time }).strict();

export type CreateAgentDependencyPlan = z.infer<typeof CreateAgentDependencyPlanSchema>;
export type PrepareAgentDependencyPlan = z.infer<typeof PrepareAgentDependencyPlanSchema>;
export type AgentDependencyPlanSource = z.infer<typeof AgentDependencyPlanSourceSchema>;
export type AgentDependencyPlanBillDraft = z.infer<typeof AgentDependencyPlanBillDraftSchema>;
export type AgentDependencyPlanCommand = z.infer<typeof AgentDependencyPlanCommandSchema>;
export type AgentDependencyPlanBlockReason = z.infer<typeof AgentDependencyPlanBlockReasonSchema>;
export type AgentDependencyPlanView = z.infer<typeof AgentDependencyPlanViewSchema>;
export type AgentDependencyPlanSummary = z.infer<typeof AgentDependencyPlanSummarySchema>;
export type AgentDependencyPlanPage = z.infer<typeof AgentDependencyPlanPageSchema>;
export type AgentDependencyPlanReceipt = z.infer<typeof AgentDependencyPlanReceiptSchema>;
export type AgentDependencyPlanWorkspace = z.infer<typeof AgentDependencyPlanWorkspaceSchema>;
export type AgentDependencyPlanIntent = z.infer<typeof AgentDependencyPlanIntentSchema>;
