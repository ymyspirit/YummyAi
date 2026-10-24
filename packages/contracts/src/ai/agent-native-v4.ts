import { z } from "zod";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_COMMAND_VERSION, AgentCommandOriginalSchema } from "@yummyai/contracts/ai/agent-command";
import { AGENT_FULFILLMENT_COMMAND_VERSION, PrepareAgentFulfillmentCommandSchema } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { AgentCommandV2KeySchema, AgentCommandV2DefinitionSchema, AgentCommandV2DefinitionWorkspaceSchema,
  agentCommandV2Key } from "@yummyai/contracts/ai/agent-command-v2-discovery";
import { AgentFulfillmentSuggestionSchema, AgentFulfillmentOperatorCheckSchema, agentFulfillmentOperatorChecks } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { AgentNativeDraftSchema } from "@yummyai/contracts/ai/agent-native";
import { AgentPlanDraftSchema, AgentPlanItemViewSchema } from "@yummyai/contracts/ai/agent-plan";
import { AgentNativeV3BindingSchema, AgentNativeV3ReadKeySchema, AgentNativeV3LimitsSchema,
  defaultAgentNativeV3Limits, maximumAgentNativeV3Limits, CreateAgentNativeV3Schema,
  AgentNativeV3ReadRequestSchema, AgentNativeV3DefinitionSchema, AgentNativeV3ObservationSchema,
  AgentNativeV3ClaimSchema, AgentNativeV3ModelResultSchema, AgentNativeV3DecisionSchema,
  AgentNativeV3PinnedInputSchema, AgentNativeV3ViewSchema, AgentNativeV3WorkspaceSchema,
  AgentNativeV3ReceiptQuerySchema, AgentNativeV3ReceiptSchema, StopAgentNativeV3Schema,
  AgentNativeV3ItemReceiptSchema, AgentNativeV3IntentSchema, AgentNativeV3PreparationIntentSchema,
  AgentNativeV3TurnInputSchema, AgentNativeV3ReadResultSchema, agentNativeV3ObservationBasisPayload,
  agentNativeV3ClaimValue, agentNativeV3ObservationRows,
  type AgentNativeV3Observation, type AgentNativeV3Claim } from "@yummyai/contracts/ai/agent-native-v3";

/** Independent ABI. A proposal is not an operator-completed original request. */
export const AGENT_NATIVE_V4_VERSION = "erp-agent-native-v4" as const;
export const AGENT_NATIVE_V4_INTENT_PREFIX = "yummyai.agent-native.v4.intent:";
export const AGENT_NATIVE_V4_PREPARATION_INTENT_PREFIX = "yummyai.agent-native.v4.preparation.intent:";
export const AGENT_NATIVE_V4_CLEAR_EVENT = "yummyai.agent-native-v4-intents-cleared";
export const AGENT_NATIVE_V4_MAX_STEPS = 96;
const Version = { version: z.literal(AGENT_NATIVE_V4_VERSION) }, Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const AgentNativeV4BindingSchema = AgentNativeV3BindingSchema;
export const AgentNativeV4ReadKeySchema = AgentNativeV3ReadKeySchema;
export const AgentNativeV4LimitsSchema = AgentNativeV3LimitsSchema;
export const defaultAgentNativeV4Limits = defaultAgentNativeV3Limits;
export const maximumAgentNativeV4Limits = maximumAgentNativeV3Limits;
export const CreateAgentNativeV4Schema = z.object({ ...CreateAgentNativeV3Schema.shape, ...Version,
  allowedCommands: z.array(AgentCommandV2KeySchema).max(51),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.bindings.map(canonicalJson)).size !== value.bindings.length ||
    new Set(value.allowedCommands.map(agentCommandV2Key)).size !== value.allowedCommands.length)
    ctx.addIssue({ code: "custom", message: "Every original binding and command must be unique" });
});
export const canonicalAgentNativeV4Request = (raw: unknown) => canonicalJson(CreateAgentNativeV4Schema.parse(raw));
export const AgentNativeV4SelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), tool: AgentNativeV4ReadKeySchema }).strict(),
  z.object({ kind: z.literal("command"), command: AgentCommandV2KeySchema }).strict(),
]);
export const AgentNativeV4ReadRequestSchema = AgentNativeV3ReadRequestSchema;
// Read envelopes retain their original reader version. All command definitions use v2.
export const AgentNativeV4DefinitionSchema = z.union([AgentNativeV3DefinitionSchema, AgentCommandV2DefinitionSchema]).superRefine((value, ctx) => {
  if ("selection" in value && value.selection.kind === "command" && value.version !== "erp-agent-command-definition-v2")
    ctx.addIssue({ code: "custom", message: "V4 commands require the independent 51-command definition ABI" });
});
export const AgentNativeV4DefinitionEvidenceSchema = z.object({ stepId: Id, definition: AgentNativeV4DefinitionSchema }).strict();
export const AgentNativeV4ReadResultSchema = AgentNativeV3ReadResultSchema;
export const AgentNativeV4ObservationSchema = AgentNativeV3ObservationSchema;
export const AgentNativeV4ClaimSchema = AgentNativeV3ClaimSchema;
export const AgentNativeV4ModelDraftSchema = z.object({ ...AgentNativeDraftSchema.shape, capability: AgentCommandV2KeySchema }).strict().superRefine((value, ctx) => {
  if (value.draftJson === null && value.missingInformation.length === 0 ||
    value.capability.domain !== "fulfillment" && (value.draftJson === null) !== (value.missingInformation.length > 0))
    ctx.addIssue({ code: "custom", message: "Unavailable original suggestions require explicit missing information" });
});
export const AgentNativeV4ModelResultSchema = z.object({ ...AgentNativeV3ModelResultSchema.shape,
  proposals: z.array(AgentNativeV4ModelDraftSchema).max(8),
}).strict().superRefine((value, ctx) => {
  if (value.proposals.some((proposal, index) => proposal.position !== index))
    ctx.addIssue({ code: "custom", message: "Proposal positions must remain a contiguous server slot prefix" });
});
export const AgentNativeV4DecisionSchema = z.object({ ...AgentNativeV3DecisionSchema.shape,
  definition: AgentNativeV4SelectionSchema.nullable(), result: AgentNativeV4ModelResultSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "definition" ? value.definition === null || value.read !== null || value.result !== null :
    value.action === "read" ? value.read === null || value.definition !== null || value.result !== null :
      value.result === null || value.definition !== null || value.read !== null)
    ctx.addIssue({ code: "custom", message: "A decision contains exactly its selected payload" });
});
export const AgentNativeV4ResolvedDraftSchema = z.object({ ...AgentPlanDraftSchema.shape, capability: AgentCommandV2KeySchema,
  original: AgentCommandOriginalSchema.nullable(), fulfillment: AgentFulfillmentSuggestionSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  const fulfillment = value.capability.domain === "fulfillment";
  if (fulfillment ? value.original !== null || value.fulfillment !== null && value.fulfillment.original.kind !== value.capability.kind :
    value.fulfillment !== null || value.original !== null && (value.original.domain !== value.capability.domain || value.original.command.kind !== value.capability.kind))
    ctx.addIssue({ code: "custom", message: "A proposal retains exactly its own original command family" });
  if (!value.original && !value.fulfillment && value.missingInformation.length === 0 ||
    !fulfillment && (value.original === null) !== (value.missingInformation.length > 0))
    ctx.addIssue({ code: "custom", message: "Missing original suggestions require explicit missing information" });
  if (value.claims.length !== 0) ctx.addIssue({ code: "custom", message: "V4 source claims are referenced only by immutable claim indexes" });
});
export const AgentNativeV4ResolvedProposalSchema = z.object({ id: Id, position: z.int().min(0).max(7), proposalChecksum: Hash,
  originalChecksum: Hash.nullable(), preparationRequestChecksum: Hash.nullable(), draft: AgentNativeV4ResolvedDraftSchema,
  claimIndexes: z.array(z.int().min(0).max(99)).max(20), operatorChecks: z.array(AgentFulfillmentOperatorCheckSchema).max(3),
}).strict().superRefine((value, ctx) => {
  const original = value.draft.original, fulfillment = value.draft.capability.domain === "fulfillment";
  const checks = value.draft.fulfillment ? agentFulfillmentOperatorChecks(value.draft.fulfillment.original.kind) : [];
  if (value.position !== value.draft.position || (original === null) !== (value.originalChecksum === null) ||
    (value.originalChecksum === null) !== (value.preparationRequestChecksum === null) ||
    original && original.command.input.idempotencyKey !== value.id || fulfillment && (value.originalChecksum !== null || value.preparationRequestChecksum !== null) ||
    canonicalJson(checks) !== canonicalJson(value.operatorChecks))
    ctx.addIssue({ code: "custom", message: "Birth proposals cannot carry completed operator inputs or preparation hashes" });
});
export const AgentNativeV4ResultSchema = z.object({ ...AgentNativeV3ModelResultSchema.shape,
  proposals: z.array(AgentNativeV4ResolvedProposalSchema).max(8),
}).strict().superRefine((value, ctx) => {
  if (value.proposals.some((proposal, index) => proposal.position !== index || proposal.claimIndexes.some(claim => !value.claims[claim])))
    ctx.addIssue({ code: "custom", message: "Resolved proposals retain their original positions and claim indexes" });
});
export const AgentNativeV4PinnedInputSchema = z.object({ ...AgentNativeV3PinnedInputSchema.shape, ...Version, request: CreateAgentNativeV4Schema }).strict();
export const AgentNativeV4ItemViewSchema = z.object({ ...AgentPlanItemViewSchema.shape,
  originalProtocol: z.enum([AGENT_COMMAND_VERSION, AGENT_FULFILLMENT_COMMAND_VERSION]).nullable(),
  fulfillmentIntentId: Id.nullable(), completionChecksum: Hash.nullable(),
  completionState: z.enum(["not_required", "operator_required", "bound", "unavailable"]),
  blockReason: z.enum([...AgentPlanItemViewSchema.shape.blockReason.unwrap().options, "operator_completion_required", "original_form_unavailable"]).nullable(),
}).strict().superRefine((value, ctx) => {
  const fulfillment = value.originalProtocol === AGENT_FULFILLMENT_COMMAND_VERSION;
  const known = value.preparationState === "known";
  if (value.agentCommandId !== null && value.fulfillmentIntentId !== null ||
    (fulfillment ? value.agentCommandId !== null || value.ownerCommandId !== null ||
      (value.completionChecksum !== null) !== (value.originalChecksum !== null) ||
      (value.completionState === "bound") !== (value.completionChecksum !== null) || value.fulfillmentIntentId !== null && value.completionChecksum === null :
      value.fulfillmentIntentId !== null || value.completionChecksum !== null || !["not_required", "unavailable"].includes(value.completionState)))
    ctx.addIssue({ code: "custom", message: "Item projections must retain one original preparation family and immutable completion identity" });
  if (known ? value.originalProtocol === null || !value.preparationRequestedAt ||
      (fulfillment ? value.fulfillmentIntentId === null : value.agentCommandId === null || value.ownerCommandId === null) :
      value.agentCommandId !== null || value.ownerCommandId !== null || value.fulfillmentIntentId !== null)
    ctx.addIssue({ code: "custom", message: "Known preparations require the complete original receipt coordinates" });
  if ((value.originalChecksum === null) !== (value.preparationRequestChecksum === null) ||
    fulfillment && value.completionChecksum !== null && value.preparationRequestedAt === null ||
    value.canPrepare && (value.preparationRequestedAt !== null || value.preparationState !== "not_requested"))
    ctx.addIssue({ code: "custom", message: "Completed or unknown preparations can only recover their original receipt" });
});
export const AgentNativeV4ViewSchema = z.object({ ...AgentNativeV3ViewSchema.shape, ...Version,
  allowedCommands: z.array(AgentCommandV2KeySchema).max(51), definitions: z.array(AgentNativeV4DefinitionEvidenceSchema).max(47),
  result: AgentNativeV4ResultSchema.nullable(), items: z.array(AgentNativeV4ItemViewSchema).max(8),
}).strict().superRefine((value, ctx) => {
  if (value.privateAvailable !== (value.readContracts !== null) || !value.privateAvailable &&
    (value.goal !== null || value.contextText !== null || value.bindings.length || value.allowedCommands.length || value.steps.length || value.definitions.length || value.observations.length || value.result !== null))
    ctx.addIssue({ code: "custom", message: "Unavailable private task content must be cleared" });
  if (value.result && (value.items.length !== value.result.proposals.length || value.items.some((item, index) => {
    const proposal = value.result!.proposals[index];
    if (!proposal || item.id !== proposal.id || item.position !== proposal.position || item.proposalChecksum !== proposal.proposalChecksum) return true;
    if (proposal.draft.capability.domain !== "fulfillment") return item.originalProtocol !== AGENT_COMMAND_VERSION ||
      item.originalChecksum !== proposal.originalChecksum || item.preparationRequestChecksum !== proposal.preparationRequestChecksum;
    return item.originalProtocol !== AGENT_FULFILLMENT_COMMAND_VERSION ||
      (item.originalChecksum === null) !== (item.preparationRequestChecksum === null) ||
      (item.completionState === "bound") !== (item.completionChecksum !== null);
  }))) ctx.addIssue({ code: "custom", message: "Item completions remain separate from the immutable model proposals" });
});
export const AgentNativeV4WorkspaceSchema = z.object({ ...AgentNativeV3WorkspaceSchema.shape, ...Version,
  commandWorkspace: AgentCommandV2DefinitionWorkspaceSchema,
}).strict();
export const AgentNativeV4ReceiptQuerySchema = AgentNativeV3ReceiptQuerySchema;
export const AgentNativeV4ReceiptSchema = z.object({ ...AgentNativeV3ReceiptSchema.shape, ...Version }).strict().superRefine((value, ctx) => {
  if (value.disposition === "known" ? !value.runId || !value.status : value.runId !== null || value.status !== null || value.privateAvailable)
    ctx.addIssue({ code: "custom", message: "A receipt identifies only its original parent request" });
});
export const StopAgentNativeV4Schema = z.object({ ...StopAgentNativeV3Schema.shape, ...Version }).strict();
/** GET recovery uses this small identity only. Operator body and tokens never enter a URL. */
export const AgentNativeV4ItemReceiptQuerySchema = z.object({ ...Version, requestId: z.uuid(), proposalChecksum: Hash }).strict();
export const PrepareAgentNativeV4ItemSchema = AgentNativeV4ItemReceiptQuerySchema.extend({ completion: PrepareAgentFulfillmentCommandSchema.nullable() }).strict();
export const AgentNativeV4ItemReceiptSchema = z.object({ ...AgentNativeV3ItemReceiptSchema.shape, ...Version,
  originalProtocol: z.enum([AGENT_COMMAND_VERSION, AGENT_FULFILLMENT_COMMAND_VERSION]).nullable(),
  fulfillmentIntentId: Id.nullable(), completionChecksum: Hash.nullable(),
}).strict().superRefine((value, ctx) => {
  const known = value.disposition === "known", fulfillment = value.originalProtocol === AGENT_FULFILLMENT_COMMAND_VERSION;
  if (known && value.originalProtocol === null || (fulfillment ? value.agentCommandId !== null || value.ownerCommandId !== null || known !== (value.fulfillmentIntentId !== null) || known && value.completionChecksum === null :
    value.fulfillmentIntentId !== null || value.completionChecksum !== null || (known ? !value.agentCommandId || !value.ownerCommandId : value.agentCommandId !== null || value.ownerCommandId !== null))
  )
    ctx.addIssue({ code: "custom", message: "Known item receipts identify one exact original preparation without projecting business success" });
});
export const AgentNativeV4IntentSchema = AgentNativeV3IntentSchema;
export const AgentNativeV4PreparationIntentSchema = AgentNativeV3PreparationIntentSchema;
export const AgentNativeV4TurnInputSchema = z.object({ ...AgentNativeV3TurnInputSchema.shape, ...Version,
  allowedCommands: z.array(AgentCommandV2KeySchema).max(51), definitions: z.array(AgentNativeV4DefinitionEvidenceSchema).max(47),
}).strict();
export function agentNativeV4DefinitionSelection(value: AgentNativeV4Definition): AgentNativeV4Selection {
  return "selection" in value ? value.selection : { kind: "read", tool: value.tool };
}
export function agentNativeV4ObservationBasisPayload(value: AgentNativeV3Observation) {
  return { ...agentNativeV3ObservationBasisPayload(value), version: AGENT_NATIVE_V4_VERSION };
}
// Value extraction and row counts belong to the unchanged original read envelopes.
export const agentNativeV4ClaimValue = agentNativeV3ClaimValue;
export const agentNativeV4ObservationRows = agentNativeV3ObservationRows;
export function agentNativeV4ProposalChecksumPayload(value: AgentNativeV4ResolvedProposal, claims: readonly AgentNativeV3Claim[]) {
  return { version: AGENT_NATIVE_V4_VERSION, draft: value.draft, claimIndexes: value.claimIndexes,
    claims: value.claimIndexes.map(index => claims[index]), operatorChecks: value.operatorChecks };
}
export type AgentNativeV4Binding = z.infer<typeof AgentNativeV4BindingSchema>;
export type CreateAgentNativeV4 = z.infer<typeof CreateAgentNativeV4Schema>;
export type AgentNativeV4ReadKey = z.infer<typeof AgentNativeV4ReadKeySchema>;
export type AgentNativeV4Selection = z.infer<typeof AgentNativeV4SelectionSchema>;
export type AgentNativeV4Definition = z.infer<typeof AgentNativeV4DefinitionSchema>;
export type AgentNativeV4DefinitionEvidence = z.infer<typeof AgentNativeV4DefinitionEvidenceSchema>;
export type AgentNativeV4Observation = z.infer<typeof AgentNativeV4ObservationSchema>;
export type AgentNativeV4ModelResult = z.infer<typeof AgentNativeV4ModelResultSchema>;
export type AgentNativeV4ResolvedProposal = z.infer<typeof AgentNativeV4ResolvedProposalSchema>;
export type AgentNativeV4Result = z.infer<typeof AgentNativeV4ResultSchema>;
export type AgentNativeV4PinnedInput = z.infer<typeof AgentNativeV4PinnedInputSchema>;
export type AgentNativeV4TurnInput = z.infer<typeof AgentNativeV4TurnInputSchema>;
export type AgentNativeV4View = z.infer<typeof AgentNativeV4ViewSchema>;
export type AgentNativeV4Workspace = z.infer<typeof AgentNativeV4WorkspaceSchema>;
export type AgentNativeV4Receipt = z.infer<typeof AgentNativeV4ReceiptSchema>;
export type AgentNativeV4ItemReceipt = z.infer<typeof AgentNativeV4ItemReceiptSchema>;
export type AgentNativeV4Intent = z.infer<typeof AgentNativeV4IntentSchema>;
export type AgentNativeV4PreparationIntent = z.infer<typeof AgentNativeV4PreparationIntentSchema>;
export type PrepareAgentNativeV4Item = z.infer<typeof PrepareAgentNativeV4ItemSchema>;
