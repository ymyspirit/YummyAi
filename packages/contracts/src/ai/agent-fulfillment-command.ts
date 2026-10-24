import { z } from "zod";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { AGENT_COMMAND_VERSION, AgentCommandCapabilitySchema, AgentCommandDomainSchema } from "@yummyai/contracts/ai/agent-command";
import { AgentPlanCommandKeySchema } from "@yummyai/contracts/ai/agent-plan";
import { FulfillmentCommandKindSchema, FulfillmentCommandViewSchema, PrepareFulfillmentCommandSchema,
  fulfillmentCommandCanonicalJson } from "@yummyai/contracts/order/fulfillment-command";

export const AGENT_FULFILLMENT_COMMAND_VERSION = "erp-agent-fulfillment-command-v1" as const;
export const AGENT_COMMAND_CATALOG_V2_VERSION = "erp-agent-command-catalog-v2" as const;
export const AGENT_FULFILLMENT_COMMAND_CLEAR_EVENT = "yummyai.agent-fulfillment-command-cleared";
export const AGENT_FULFILLMENT_COMMAND_INTENT_PREFIX = "yummyai.agent-fulfillment-command.intent.v1:";
export const AGENT_FULFILLMENT_CONFIRMATION_SECONDS = 300;
const Version = { version: z.literal(AGENT_FULFILLMENT_COMMAND_VERSION) };
const Id = EntityIdSchema.refine(value => value === value.toLowerCase(), "原履约引用须为规范编号");
const Request = z.uuid().refine(value => value === value.toLowerCase(), "原请求编号须为规范编号");
const Hash = z.string().regex(/^[a-f0-9]{64}$/), Authority = z.string().min(1).max(65536);
export const AgentCommandV2CapabilitySchema = AgentCommandCapabilitySchema.omit({ domain: true }).extend({
  domain: z.enum([...AgentCommandDomainSchema.options, "fulfillment"]),
  protocol: z.enum([AGENT_COMMAND_VERSION, AGENT_FULFILLMENT_COMMAND_VERSION]),
}).strict().superRefine((value, ctx) => {
  const fulfillment = value.domain === "fulfillment";
  if (fulfillment ? value.protocol !== AGENT_FULFILLMENT_COMMAND_VERSION || !FulfillmentCommandKindSchema.safeParse(value.kind).success
    : value.protocol !== AGENT_COMMAND_VERSION || !AgentPlanCommandKeySchema.safeParse({ domain: value.domain, kind: value.kind }).success)
    ctx.addIssue({ code: "custom", message: "命令类型及协议必须保留原版本" });
  if (fulfillment && value.externalEffect !== "internal_record_only") ctx.addIssue({ code: "custom", message: "履约登记不证明外部生产或平台发送" });
});
export type AgentCommandV2Capability = z.infer<typeof AgentCommandV2CapabilitySchema>;
export const AgentCommandV2CatalogSchema = z.array(AgentCommandV2CapabilitySchema).length(51).superRefine((items, ctx) => {
  if (new Set(items.map(item => item.domain + ":" + item.kind)).size !== 51 || items.filter(item => item.domain === "fulfillment").length !== 14)
    ctx.addIssue({ code: "custom", message: "新版目录须完整保留旧37项及14项原履约" });
});
export const AgentFulfillmentCommandWorkspaceSchema = z.object({ ...Version,
  catalogVersion: z.literal(AGENT_COMMAND_CATALOG_V2_VERSION), contextAuthority: Authority,
  capabilities: AgentCommandV2CatalogSchema, modelProposalState: z.literal("not_integrated"), autonomousWrites: z.literal(false),
  confirmationTtlSeconds: z.int().min(1).max(AGENT_FULFILLMENT_CONFIRMATION_SECONDS),
}).strict();
export type AgentFulfillmentCommandWorkspace = z.infer<typeof AgentFulfillmentCommandWorkspaceSchema>;

export const PrepareAgentFulfillmentCommandSchema = z.object({ ...Version, orderId: Id, original: PrepareFulfillmentCommandSchema }).strict();
export type PrepareAgentFulfillmentCommand = z.infer<typeof PrepareAgentFulfillmentCommandSchema>;
/** The durable identity remains the original intent's canonical request, not an invented Agent business command. */
export const canonicalAgentFulfillmentOriginal = fulfillmentCommandCanonicalJson;
export const AgentFulfillmentCommandGetQuerySchema = z.object({ ...Version, orderId: Id }).strict();
export const AgentFulfillmentCommandListQuerySchema = AgentFulfillmentCommandGetQuerySchema.extend({ lineId: Id.optional() }).strict();
export const AgentFulfillmentCommandReceiptQuerySchema = AgentFulfillmentCommandGetQuerySchema.extend({ requestId: Request, requestChecksum: Hash }).strict();
export const AgentFulfillmentCommandReceiptSchema = AgentFulfillmentCommandReceiptQuerySchema.extend({ contextAuthority: Authority,
  disposition: z.enum(["known", "not_found"]), id: Id.nullable(), privateAvailable: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if ((value.disposition === "known") !== (value.id !== null)) ctx.addIssue({ code: "custom", message: "原请求回执身份不一致" });
});
export type AgentFulfillmentCommandReceipt = z.infer<typeof AgentFulfillmentCommandReceiptSchema>;
export const AgentFulfillmentDecisionSchema = z.enum(["execute_original", "resume_original"]);
export const AgentFulfillmentCommandViewSchema = z.object({ ...Version, contextAuthority: Authority,
  native: FulfillmentCommandViewSchema, original: PrepareFulfillmentCommandSchema.nullable(), privateAvailable: z.boolean(),
  originalChecksum: Hash.nullable(), confirmationToken: z.string().min(1).max(16384).nullable(),
  confirmationExpiresAt: z.iso.datetime().nullable(), confirmationDecision: AgentFulfillmentDecisionSchema.nullable(),
  canConfirm: z.boolean(), canCancel: z.boolean(), canAcknowledge: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const native = value.native, original = value.original;
  if (value.privateAvailable !== (original !== null) || original && (original.requestId !== native.requestId || original.kind !== native.kind || original.targetId !== native.targetId)
    || (value.originalChecksum !== null) !== (original !== null) || value.originalChecksum !== null && value.originalChecksum !== native.requestChecksum)
    ctx.addIssue({ code: "custom", message: "核对内容须为原拥有者保存的同一请求" });
  if (!original && (native.summary !== null || native.receipt !== null)) ctx.addIssue({ code: "custom", message: "原文不可读时不得携带旧私有摘要或回执" });
  const decision = native.status === "prepared" ? "execute_original" : native.status === "uncertain" ? "resume_original" : null;
  if (value.canConfirm ? !original || !native.canExecute || !decision || value.confirmationDecision !== decision || !value.confirmationToken || !value.confirmationExpiresAt
    || Date.parse(value.confirmationExpiresAt) > Date.parse(native.expiresAt)
    : value.confirmationToken !== null || value.confirmationExpiresAt !== null || value.confirmationDecision !== null)
    ctx.addIssue({ code: "custom", message: "确认必须绑定原状态及当前有效原文" });
  if (value.canCancel && (!original || !native.canCancel) || value.canAcknowledge && (native.acknowledged || !["succeeded", "rejected", "cancelled", "expired"].includes(native.status)))
    ctx.addIssue({ code: "custom", message: "原操作控制与实际原状态不一致" });
});
export type AgentFulfillmentCommandView = z.infer<typeof AgentFulfillmentCommandViewSchema>;
export const AgentFulfillmentCommandListSchema = z.object({ ...Version, contextAuthority: Authority,
  items: z.array(AgentFulfillmentCommandViewSchema).max(100), truncated: z.boolean(),
}).strict();
export type AgentFulfillmentCommandList = z.infer<typeof AgentFulfillmentCommandListSchema>;
const Control = { ...Version, orderId: Id, requestId: Request, requestChecksum: Hash };
export const ConfirmAgentFulfillmentCommandSchema = z.object({ ...Control, originalChecksum: Hash,
  confirmationToken: z.string().min(1).max(16384), decision: AgentFulfillmentDecisionSchema,
}).strict();
export type ConfirmAgentFulfillmentCommand = z.infer<typeof ConfirmAgentFulfillmentCommandSchema>;
export const CancelAgentFulfillmentCommandSchema = z.object({ ...Control, decision: z.literal("cancel_original") }).strict();
export const AcknowledgeAgentFulfillmentCommandSchema = z.object({ ...Control, decision: z.literal("acknowledge_original") }).strict();

/** Server-only encrypted approval payload. It never authorizes an arbitrary URL or a replacement request. */
export const AgentFulfillmentConfirmationSchema = z.object({ ...Version, purpose: z.literal("agent_fulfillment_confirm"),
  intentId: Id, requestId: Request, requestChecksum: Hash, originalChecksum: Hash,
  kind: FulfillmentCommandKindSchema, targetId: Id, orderId: Id, lineIds: z.array(Id).min(1).max(100),
  tenantId: Id, userId: Id, ceilingChecksum: Hash, currentAuthority: Hash, generation: z.int().nonnegative(),
  expectedStatus: z.enum(["prepared", "uncertain"]), decision: AgentFulfillmentDecisionSchema,
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
}).strict().superRefine((value, ctx) => {
  if (value.decision !== (value.expectedStatus === "prepared" ? "execute_original" : "resume_original")
    || new Set(value.lineIds).size !== value.lineIds.length || Date.parse(value.expiresAt) <= Date.parse(value.issuedAt)
    || Date.parse(value.expiresAt) - Date.parse(value.issuedAt) > AGENT_FULFILLMENT_CONFIRMATION_SECONDS * 1000)
    ctx.addIssue({ code: "custom", message: "原确认状态 身份或有效期不一致" });
});
export type AgentFulfillmentConfirmation = z.infer<typeof AgentFulfillmentConfirmationSchema>;
/** Persist non-private exact recovery coordinates before sending prepare. Never store body, raw keys or tokens. */
export const AgentFulfillmentCommandIntentSchema = z.object({ ...Version, ownerScope: Hash, orderId: Id,
  requestId: Request, requestChecksum: Hash, id: Id.nullable(), state: z.enum(["unknown", "known"]), createdAt: z.iso.datetime(),
}).strict();
export type AgentFulfillmentCommandIntent = z.infer<typeof AgentFulfillmentCommandIntentSchema>;
