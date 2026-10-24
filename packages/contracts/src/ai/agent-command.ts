import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { EntityIdSchema } from "@yummyai/contracts/common/ids";
import { PrepareProcurementCommandSchema, ProcurementCommandViewSchema } from "@yummyai/contracts/procurement/procurement-command";
import { PrepareIncomingCommandSchema, IncomingCommandViewSchema } from "@yummyai/contracts/procurement/incoming-command";
import { PrepareFinanceCommandSchema, FinanceCommandDetailSchema } from "@yummyai/contracts/finance/finance-command";
import { PrepareAdCommandSchema, AdCommandDetailSchema } from "@yummyai/contracts/advertising/command";
import { PrepareProductionCommandSchema, ProductionCommandViewSchema, normalizeProductionCommand } from "@yummyai/contracts/order/production-command";

export const AGENT_COMMAND_VERSION = "erp-agent-command-v1" as const;
export const AGENT_COMMAND_MAX_BYTES = 36 * 1024 * 1024;
const Id = EntityIdSchema.transform(value => value.toLowerCase()), Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Version = { version: z.literal(AGENT_COMMAND_VERSION) };
export const AgentCommandDomainSchema = z.enum(["procurement", "incoming", "production", "finance", "advertising"]);
export const AgentCommandOriginalSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("procurement"), command: PrepareProcurementCommandSchema }).strict(),
  z.object({ domain: z.literal("incoming"), command: PrepareIncomingCommandSchema }).strict(),
  z.object({ domain: z.literal("production"), command: PrepareProductionCommandSchema }).strict(),
  z.object({ domain: z.literal("finance"), command: PrepareFinanceCommandSchema }).strict(),
  z.object({ domain: z.literal("advertising"), command: PrepareAdCommandSchema }).strict(),
]);
export type AgentCommandOriginal = z.infer<typeof AgentCommandOriginalSchema>;
/** Normalize exactly as the original owner, without changing authored keys or notes. */
export function normalizeAgentCommandOriginal(raw: unknown): AgentCommandOriginal {
  const value = AgentCommandOriginalSchema.parse(raw);
  return value.domain === "production" ? { ...value, command: normalizeProductionCommand(value.command) } : value;
}
export const canonicalAgentCommandOriginal = (raw: unknown) => canonicalJson(normalizeAgentCommandOriginal(raw));

/** A non-private exact lookup descriptor. No body, raw key, authority selected by a caller, or current basis. */
export const AgentCommandBindingSchema = z.object({ domain: AgentCommandDomainSchema, kind: z.string().min(1).max(80),
  targetId: Id.nullable(), accountId: Id.nullable(), requestKeyHash: Hash, ownerRequestChecksum: Hash }).strict();
export type AgentCommandBinding = z.infer<typeof AgentCommandBindingSchema>;
export const AgentCommandOwnerReferenceSchema = z.object({ domain: AgentCommandDomainSchema, commandId: Id,
  accountId: Id.nullable() }).strict();
export type AgentCommandOwnerReference = z.infer<typeof AgentCommandOwnerReferenceSchema>;
export const AgentCommandNativeViewSchema = z.discriminatedUnion("domain", [
  z.object({ domain: z.literal("procurement"), view: ProcurementCommandViewSchema }).strict(),
  z.object({ domain: z.literal("incoming"), view: IncomingCommandViewSchema }).strict(),
  z.object({ domain: z.literal("production"), view: ProductionCommandViewSchema }).strict(),
  z.object({ domain: z.literal("finance"), view: FinanceCommandDetailSchema }).strict(),
  z.object({ domain: z.literal("advertising"), view: AdCommandDetailSchema }).strict(),
]);
export type AgentCommandNativeView = z.infer<typeof AgentCommandNativeViewSchema>;
export const AgentCommandOwnerSnapshotSchema = z.object({ reference: AgentCommandOwnerReferenceSchema,
  native: AgentCommandNativeViewSchema, original: AgentCommandOriginalSchema.nullable() }).strict().superRefine((value, ctx) => {
  if (value.reference.domain !== value.native.domain || value.reference.commandId !== value.native.view.id ||
    value.original && value.original.domain !== value.reference.domain)
    ctx.addIssue({ code: "custom", message: "The original owner reference and snapshot disagree" });
  if (value.native.domain === "advertising" ? value.reference.accountId !== value.native.view.accountId : value.reference.accountId !== null)
    ctx.addIssue({ code: "custom", message: "The original account must match its native owner" });
  if (value.original && (value.original.command.kind !== value.native.view.kind ||
    value.original.domain !== "production" && "targetId" in value.native.view && value.original.command.targetId !== value.native.view.targetId))
    ctx.addIssue({ code: "custom", message: "The original kind and target must match the native command" });
});
export type AgentCommandOwnerSnapshot = z.infer<typeof AgentCommandOwnerSnapshotSchema>;

export const PrepareAgentCommandSchema = z.object({ ...Version, requestId: z.uuid(),
  original: AgentCommandOriginalSchema }).strict();
export type PrepareAgentCommand = z.infer<typeof PrepareAgentCommandSchema>;
export const AdoptAgentCommandSchema = z.object({ ...Version, requestId: z.uuid(), reference: AgentCommandOwnerReferenceSchema }).strict();
export type AdoptAgentCommand = z.infer<typeof AdoptAgentCommandSchema>;
export function canonicalAgentCommandRequest(operation: "prepare" | "adopt", raw: unknown) {
  const parsed = operation === "adopt" ? AdoptAgentCommandSchema.parse(raw) : PrepareAgentCommandSchema.parse(raw);
  const request = "original" in parsed ? { ...parsed, original: normalizeAgentCommandOriginal(parsed.original) } : parsed;
  return canonicalJson({ operation, request });
}
export const AgentCommandReceiptQuerySchema = z.object({ requestId: z.uuid(), requestChecksum: Hash }).strict();
export const AgentCommandReceiptSchema = z.object({ ...Version, requestId: z.uuid(), requestChecksum: Hash,
  disposition: z.enum(["known", "not_found"]), id: Id.nullable(), ownerCommandId: Id.nullable(),
  contextAuthority: z.string().min(1).max(65536), privateAvailable: z.boolean() }).strict().superRefine((value, ctx) => {
  if (value.disposition === "known" ? value.id === null : value.id !== null || value.ownerCommandId !== null || value.privateAvailable)
    ctx.addIssue({ code: "custom", message: "The original command receipt identity disagrees" });
});
export type AgentCommandReceipt = z.infer<typeof AgentCommandReceiptSchema>;
export const AgentCommandViewSchema = z.object({ ...Version, id: Id, requestId: z.uuid(), requestChecksum: Hash,
  contextAuthority: z.string().min(1).max(65536), domain: AgentCommandDomainSchema, kind: z.string().min(1).max(80),
  ownerCommandId: Id.nullable(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  executeRequestedAt: z.iso.datetime().nullable(), cancelledAt: z.iso.datetime().nullable(),
  state: z.enum(["preparing", "prepared", "executing", "succeeded", "cancelled", "expired", "rejected", "unknown", "unavailable"]),
  privateAvailable: z.boolean(), snapshot: AgentCommandOwnerSnapshotSchema.nullable(),
  originalChecksum: Hash.nullable(), confirmationToken: z.string().min(1).max(16384).nullable(),
  confirmationExpiresAt: z.iso.datetime().nullable(), canConfirm: z.boolean(), canCancel: z.boolean(),
  errorCode: z.string().min(1).max(100).nullable() }).strict().superRefine((value, ctx) => {
  if (value.privateAvailable !== (value.snapshot !== null) || value.snapshot && (value.domain !== value.snapshot.reference.domain || value.ownerCommandId !== value.snapshot.reference.commandId) ||
    value.canConfirm && (value.state !== "prepared" || !value.snapshot?.original || !value.snapshot.native.view.canExecute || !value.confirmationToken || !value.originalChecksum || !value.confirmationExpiresAt) ||
    (value.confirmationToken !== null) !== value.canConfirm || (value.confirmationExpiresAt !== null) !== value.canConfirm)
    ctx.addIssue({ code: "custom", message: "Review and confirmation must retain the exact original command" });
});
export type AgentCommandView = z.infer<typeof AgentCommandViewSchema>;
export const ConfirmAgentCommandSchema = z.object({ ...Version, requestId: z.uuid(), ownerCommandId: Id,
  originalChecksum: Hash, confirmationToken: z.string().min(1).max(16384), decision: z.literal("execute_original") }).strict();
export const CancelAgentCommandSchema = z.object({ ...Version, requestId: z.uuid(), ownerCommandId: Id }).strict();
export const AgentCommandConfirmationSchema = z.object({ ...Version, id: Id, requestId: z.uuid(), tenantId: Id, userId: Id,
  ownerCommandId: Id, originalChecksum: Hash, ceilingChecksum: Hash, currentAuthority: Hash,
  issuedAt: z.iso.datetime(), expiresAt: z.iso.datetime() }).strict();
export const AgentCommandCapabilitySchema = z.object({ domain: AgentCommandDomainSchema, kind: z.string().min(1).max(80),
  label: z.string().min(1).max(160), effect: z.literal("prepare_original_command"),
  preparation: z.literal("registered_original_owner"), execution: z.literal("exact_operator_confirmation"),
  externalEffect: z.enum(["internal_record_only", "original_production_release"]),
  available: z.boolean(), blockReason: z.string().max(120).nullable() }).strict();
export type AgentCommandCapability = z.infer<typeof AgentCommandCapabilitySchema>;
export const AgentCommandWorkspaceSchema = z.object({ ...Version, contextAuthority: z.string().min(1).max(65536),
  capabilities: z.array(AgentCommandCapabilitySchema).max(100),
  recent: z.array(z.object({ id: Id, requestId: z.uuid(), domain: AgentCommandDomainSchema, kind: z.string().max(80),
    createdAt: z.iso.datetime(), ownerCommandId: Id.nullable() }).strict()).max(20),
  recentLimit: z.literal(20), recentHasMore: z.boolean(), readLoopVersion: z.literal("erp-agent-loop-v1"),
  autonomousModelWrites: z.literal(false), mcpState: z.literal("not_connected") }).strict();
export type AgentCommandWorkspace = z.infer<typeof AgentCommandWorkspaceSchema>;
/** Pure identifiers and digests only, saved/read back before preparing. No command body or confirmation token. */
export const AgentCommandIntentSchema = z.object({ version: z.literal(1), ownerScope: Hash, requestId: z.uuid(),
  requestChecksum: Hash, id: Id.nullable(), state: z.enum(["prepared", "unknown", "known"]), createdAt: z.iso.datetime() }).strict();
export type AgentCommandIntent = z.infer<typeof AgentCommandIntentSchema>;
