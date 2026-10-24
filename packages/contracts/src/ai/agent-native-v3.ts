import { z } from "zod";
import {
  AgentNativeV2BindingSchema, AgentNativeV2ReadKeySchema, AgentNativeV2LimitsSchema, defaultAgentNativeV2Limits, maximumAgentNativeV2Limits,
  CreateAgentNativeV2Schema, AgentNativeV2ReadRequestSchema, AgentNativeV2DefinitionSchema, AgentNativeV2ReadResultSchema,
  AgentNativeV2ObservationSchema, AgentNativeV2ClaimSchema, AgentNativeV2ModelResultSchema, AgentNativeV2DecisionSchema,
  AgentNativeV2ResultSchema, AgentNativeV2PinnedInputSchema, AgentNativeV2StepViewSchema, AgentNativeV2CostSchema,
  AgentNativeV2ViewSchema, AgentNativeV2WorkspaceSchema, AgentNativeV2ReceiptQuerySchema, AgentNativeV2ReceiptSchema,
  StopAgentNativeV2Schema, PrepareAgentNativeV2ItemSchema, AgentNativeV2ItemReceiptSchema, AgentNativeV2IntentSchema,
  AgentNativeV2PreparationIntentSchema, AgentNativeV2TurnInputSchema, agentNativeV2SourceBasis,
} from "@yummyai/contracts/ai/agent-native-v2";
import { AgentNativeDraftSchema, agentNativeClaimValue, type AgentNativeResolvedProposalSchema } from "@yummyai/contracts/ai/agent-native";
import { AgentPlanCommandKeySchema, agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import {
  AGENT_FULFILLMENT_TOOL, AgentFulfillmentInputSchema, AgentFulfillmentDefinitionSchema, AgentFulfillmentResultSchema,
  AgentFulfillmentWorkspaceSchema, agentFulfillmentDataPayload,
} from "@yummyai/contracts/ai/agent-fulfillment";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

/** New immutable task ABI. Historical v1/v2 and fulfillment source envelopes retain their meaning. */
export const AGENT_NATIVE_V3_VERSION = "erp-agent-native-v3" as const;
export const AGENT_NATIVE_V3_INTENT_PREFIX = "yummyai.agent-native.v3.intent:";
export const AGENT_NATIVE_V3_PREPARATION_INTENT_PREFIX = "yummyai.agent-native.v3.preparation.intent:";
export const AGENT_NATIVE_V3_CLEAR_EVENT = "yummyai.agent-native-v3-intents-cleared";
export const AGENT_NATIVE_V3_MAX_STEPS = 96;
const Version = { version: z.literal(AGENT_NATIVE_V3_VERSION) }, Id = z.uuidv7();
export const AgentNativeV3ReadKeySchema = z.enum([...AgentNativeV2ReadKeySchema.options, AGENT_FULFILLMENT_TOOL]);
export const AgentNativeV3BindingSchema = z.discriminatedUnion("tool", [
  ...AgentNativeV2BindingSchema.options,
  z.object({ tool: z.literal(AGENT_FULFILLMENT_TOOL), scope: AgentFulfillmentInputSchema.omit({ cursor: true, pageSize: true }) }).strict(),
]);
export const AgentNativeV3LimitsSchema = AgentNativeV2LimitsSchema;
export const defaultAgentNativeV3Limits = defaultAgentNativeV2Limits;
export const maximumAgentNativeV3Limits = maximumAgentNativeV2Limits;
export const CreateAgentNativeV3Schema = z.object({ ...CreateAgentNativeV2Schema.shape, ...Version,
  bindings: z.array(AgentNativeV3BindingSchema).min(1).max(16),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.bindings.map(canonicalJson)).size !== value.bindings.length ||
    new Set(value.allowedCommands.map(agentPlanCommandKey)).size !== value.allowedCommands.length)
    ctx.addIssue({ code: "custom", message: "Every original binding and command must be unique" });
});
export const canonicalAgentNativeV3Request = (raw: unknown) => canonicalJson(CreateAgentNativeV3Schema.parse(raw));
export const AgentNativeV3SelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), tool: AgentNativeV3ReadKeySchema }).strict(),
  z.object({ kind: z.literal("command"), command: AgentPlanCommandKeySchema }).strict(),
]);
export const AgentNativeV3ReadRequestSchema = AgentNativeV2ReadRequestSchema;
export const AgentNativeV3DefinitionSchema = z.union([AgentNativeV2DefinitionSchema, AgentFulfillmentDefinitionSchema]);
export const AgentNativeV3DefinitionEvidenceSchema = z.object({ stepId: Id, definition: AgentNativeV3DefinitionSchema }).strict();
export const AgentNativeV3ReadResultSchema = z.union([AgentNativeV2ReadResultSchema, AgentFulfillmentResultSchema]);
export const AgentNativeV3ObservationSchema = z.object({ ...AgentNativeV2ObservationSchema.shape,
  tool: AgentNativeV3ReadKeySchema, results: z.array(AgentNativeV3ReadResultSchema).min(1).max(128),
  indexComplete: z.boolean().nullable(),
}).strict().superRefine((value, ctx) => {
  const legacyPage = value.tool === "orders.exceptions.page" || value.tool === "inventory.balances.page";
  const fulfillment = value.tool === AGENT_FULFILLMENT_TOOL;
  if (value.results.some(result => result.tool !== value.tool) ||
    (legacyPage ? value.collectionComplete !== (value.truncatedBy === null) || value.indexComplete !== null :
      fulfillment ? value.collectionComplete !== null || value.indexComplete !== (value.truncatedBy === null) :
        value.collectionComplete !== null || value.indexComplete !== null || value.results.length !== 1 || value.truncatedBy !== null))
    ctx.addIssue({ code: "custom", message: "Fulfillment index exhaustion is distinct from complete business coverage" });
});
export const AgentNativeV3ClaimSchema = AgentNativeV2ClaimSchema;
export const AgentNativeV3ModelResultSchema = AgentNativeV2ModelResultSchema;
export const AgentNativeV3DecisionSchema = z.object({ ...AgentNativeV2DecisionSchema.shape, definition: AgentNativeV3SelectionSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "definition" ? value.definition === null || value.read !== null || value.result !== null :
    value.action === "read" ? value.read === null || value.definition !== null || value.result !== null : value.result === null || value.definition !== null || value.read !== null)
    ctx.addIssue({ code: "custom", message: "A decision contains exactly its selected payload" });
});
export const AgentNativeV3ResultSchema = AgentNativeV2ResultSchema;
export const AgentNativeV3PinnedInputSchema = z.object({ ...AgentNativeV2PinnedInputSchema.shape, ...Version, request: CreateAgentNativeV3Schema,
  fulfillmentExecutionContract: HarnessExecutionContractSchema }).strict();
export const AgentNativeV3StepViewSchema = z.object({ ...AgentNativeV2StepViewSchema.shape, tool: AgentNativeV3ReadKeySchema.nullable() }).strict();
export const AgentNativeV3CostSchema = AgentNativeV2CostSchema;
export const AgentNativeV3ViewSchema = z.object({ ...AgentNativeV2ViewSchema.shape, ...Version, bindings: z.array(AgentNativeV3BindingSchema).max(16),
  steps: z.array(AgentNativeV3StepViewSchema).max(96), definitions: z.array(AgentNativeV3DefinitionEvidenceSchema).max(47),
  observations: z.array(AgentNativeV3ObservationSchema).max(47),
  readContracts: z.object({ legacy: HarnessExecutionContractSchema, resources: HarnessExecutionContractSchema, fulfillment: HarnessExecutionContractSchema }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.privateAvailable !== (value.readContracts !== null) || !value.privateAvailable && (value.goal !== null || value.contextText !== null || value.bindings.length || value.steps.length || value.definitions.length || value.observations.length || value.result !== null))
    ctx.addIssue({ code: "custom", message: "Unavailable private task content must be cleared" });
  if (value.result && (value.items.length !== value.result.proposals.length || value.items.some((item, index) => {
    const proposal = value.result!.proposals[index]; return !proposal || item.id !== proposal.id || item.position !== proposal.position ||
      item.proposalChecksum !== proposal.proposalChecksum || item.originalChecksum !== proposal.originalChecksum || item.preparationRequestChecksum !== proposal.preparationRequestChecksum;
  }))) ctx.addIssue({ code: "custom", message: "Items must match their immutable source proposals" });
});
export const AgentNativeV3WorkspaceSchema = z.object({ ...AgentNativeV2WorkspaceSchema.shape, ...Version, fulfillmentWorkspace: AgentFulfillmentWorkspaceSchema }).strict();
export const AgentNativeV3ReceiptQuerySchema = AgentNativeV2ReceiptQuerySchema;
export const AgentNativeV3ReceiptSchema = z.object({ ...AgentNativeV2ReceiptSchema.shape, ...Version }).strict().superRefine((value, ctx) => {
  if (value.disposition === "known" ? !value.runId || !value.status : value.runId !== null || value.status !== null || value.privateAvailable)
    ctx.addIssue({ code: "custom", message: "A receipt identifies only its original request" });
});
export const StopAgentNativeV3Schema = z.object({ ...StopAgentNativeV2Schema.shape, ...Version }).strict();
export const PrepareAgentNativeV3ItemSchema = z.object({ ...PrepareAgentNativeV2ItemSchema.shape, ...Version }).strict();
export const AgentNativeV3ItemReceiptSchema = z.object({ ...AgentNativeV2ItemReceiptSchema.shape, ...Version }).strict().superRefine((value, ctx) => {
  if (value.disposition === "known" ? !value.agentCommandId || !value.ownerCommandId : value.agentCommandId !== null || value.ownerCommandId !== null)
    ctx.addIssue({ code: "custom", message: "Known receipts retain both original command IDs" });
});
export const AgentNativeV3IntentSchema = AgentNativeV2IntentSchema;
export const AgentNativeV3PreparationIntentSchema = AgentNativeV2PreparationIntentSchema;
export const AgentNativeV3TurnInputSchema = z.object({ ...AgentNativeV2TurnInputSchema.shape, ...Version,
  readContracts: z.object({ legacy: HarnessExecutionContractSchema, resources: HarnessExecutionContractSchema, fulfillment: HarnessExecutionContractSchema }).strict(),
  bindings: z.array(AgentNativeV3BindingSchema).min(1).max(16), definitions: z.array(AgentNativeV3DefinitionEvidenceSchema).max(47), observations: z.array(AgentNativeV3ObservationSchema).max(47) }).strict();

export function agentNativeV3DefinitionSelection(value: z.infer<typeof AgentNativeV3DefinitionSchema>): z.infer<typeof AgentNativeV3SelectionSchema> {
  return "selection" in value ? value.selection : { kind: "read", tool: value.tool };
}
export function agentNativeV3SourceBasis(result: z.infer<typeof AgentNativeV3ReadResultSchema>) {
  return result.version === "erp-agent-fulfillment-v1" ? { ...agentFulfillmentDataPayload(result), definitionChecksum: result.definitionChecksum } : agentNativeV2SourceBasis(result);
}
export function agentNativeV3ObservationRows(result: z.infer<typeof AgentNativeV3ReadResultSchema>): number {
  if (result.version === "erp-agent-fulfillment-v1") return result.data.rows.length;
  if (result.version === "erp-agent-resources-v1") return 1;
  switch (result.tool) {
    case "orders.exceptions.page": case "inventory.balances.page": return result.data.items.length;
    case "knowledge.search": return result.data.references.length;
    case "creative.history": return result.data.entries.length;
    case "factory.capacity": return result.data.pools.length + result.data.calendar.length;
  }
}
export function agentNativeV3ObservationBasisPayload(value: Pick<AgentNativeV3Observation, "tool" | "request" | "results" | "observedRows" | "collectionComplete" | "indexComplete" | "truncatedBy">) {
  return { version: AGENT_NATIVE_V3_VERSION, tool: value.tool, request: value.request, results: value.results.map(agentNativeV3SourceBasis),
    observedRows: value.observedRows, collectionComplete: value.collectionComplete, indexComplete: value.indexComplete, truncatedBy: value.truncatedBy };
}
export function agentNativeV3ProposalChecksumPayload(value: z.infer<typeof AgentNativeResolvedProposalSchema>, claims: readonly AgentNativeV3Claim[]) {
  return { version: AGENT_NATIVE_V3_VERSION, draft: value.draft, claimIndexes: value.claimIndexes, claims: value.claimIndexes.map(index => claims[index]) };
}
export function agentNativeV3ClaimValue(observation: AgentNativeV3Observation, claim: AgentNativeV3Claim): unknown {
  const result = observation.results[claim.resultIndex];
  if (!result || claim.stepId !== observation.stepId || claim.dataChecksum !== result.dataChecksum) throw new Error("agent_native_v3_claim_invalid");
  if (result.version === "erp-agent-tools-v1") return agentNativeClaimValue({ ...observation, tool: result.tool, results: [result] }, { ...claim, resultIndex: 0 });
  const excluded = new Set(["packageRead", "coverage", "dataChecksum", "inputChecksum", "definitionChecksum", "contextAuthority", "checkedAt", "readStartedAt", "limitation"]);
  let value: unknown = result.data;
  for (const part of claim.path) {
    if (["__proto__", "constructor", "prototype"].includes(String(part)) || excluded.has(String(part)) || value === null || typeof value !== "object" ||
      Array.isArray(value) !== (typeof part === "number") || !Object.hasOwn(value, part)) throw new Error("agent_native_v3_claim_invalid");
    value = (value as Record<string, unknown>)[part];
  }
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("agent_native_v3_claim_invalid");
  return value;
}
export type AgentNativeV3Binding = z.infer<typeof AgentNativeV3BindingSchema>;
export type AgentNativeV3ReadKey = z.infer<typeof AgentNativeV3ReadKeySchema>;
export type AgentNativeV3Selection = z.infer<typeof AgentNativeV3SelectionSchema>;
export type AgentNativeV3Claim = z.infer<typeof AgentNativeV3ClaimSchema>;
export type AgentNativeV3Observation = z.infer<typeof AgentNativeV3ObservationSchema>;
export type AgentNativeV3DefinitionEvidence = z.infer<typeof AgentNativeV3DefinitionEvidenceSchema>;
export type AgentNativeV3PinnedInput = z.infer<typeof AgentNativeV3PinnedInputSchema>;
export type AgentNativeV3View = z.infer<typeof AgentNativeV3ViewSchema>;
export type AgentNativeV3Result = z.infer<typeof AgentNativeV3ResultSchema>;
export type AgentNativeV3TurnInput = z.infer<typeof AgentNativeV3TurnInputSchema>;
export type CreateAgentNativeV3 = z.infer<typeof CreateAgentNativeV3Schema>;
export type AgentNativeV3Workspace = z.infer<typeof AgentNativeV3WorkspaceSchema>;
export type AgentNativeV3Receipt = z.infer<typeof AgentNativeV3ReceiptSchema>;
export type AgentNativeV3ItemReceipt = z.infer<typeof AgentNativeV3ItemReceiptSchema>;
export type AgentNativeV3Limits = z.infer<typeof AgentNativeV3LimitsSchema>;
export type AgentNativeV3ReadRequest = z.infer<typeof AgentNativeV3ReadRequestSchema>;
export const AgentNativeV3DraftSchema = AgentNativeDraftSchema;
