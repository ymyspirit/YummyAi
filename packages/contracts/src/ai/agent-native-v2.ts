import { z } from "zod";
import {
  AgentNativeBindingSchema, AgentNativeDraftSchema, AgentNativeResolvedProposalSchema, AgentNativeIntentSchema,
  AgentNativePreparationIntentSchema, AgentNativeClaimSchema, AgentNativeStepViewSchema, AgentNativeCostSchema,
  AgentNativeTurnInputSchema, AgentNativePinnedInputSchema, AgentNativeReceiptSchema, AgentNativeItemReceiptSchema,
  AgentNativeViewSchema, AgentNativeWorkspaceSchema, agentNativeSourceBasis, agentNativeClaimValue,
} from "@yummyai/contracts/ai/agent-native";
import { AgentToolKeySchema, AgentToolDefinitionSchema, AgentToolResultSchema } from "@yummyai/contracts/ai/agent-tools";
import {
  AgentResourceKeySchema, AgentResourceDefinitionSchema, AgentResourceResultSchema, AgentResourceWorkspaceSchema,
  agentResourceInputSchemas,
} from "@yummyai/contracts/ai/agent-resources";
import { AgentPlanCommandKeySchema, agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import { AgentLoopStatusSchema } from "@yummyai/contracts/ai/agent-loop";
import { HarnessExecutionContractSchema } from "@yummyai/contracts/harness";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

/** Separate ABI. Saved native-v1 requests, limits, fingerprints and sources do not change. */
export const AGENT_NATIVE_V2_VERSION = "erp-agent-native-v2" as const;
export const AGENT_NATIVE_V2_INTENT_PREFIX = "yummyai.agent-native.v2.intent:";
export const AGENT_NATIVE_V2_PREPARATION_INTENT_PREFIX = "yummyai.agent-native.v2.preparation.intent:";
export const AGENT_NATIVE_V2_CLEAR_EVENT = "yummyai.agent-native-v2-intents-cleared";
export const AGENT_NATIVE_V2_MAX_STEPS = 96;
const Version = { version: z.literal(AGENT_NATIVE_V2_VERSION) }, Id = z.uuidv7(), Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const AgentNativeV2ReadKeySchema = z.enum([...AgentToolKeySchema.options, ...AgentResourceKeySchema.options]);
export const AgentNativeV2BindingSchema = z.discriminatedUnion("tool", [
  ...AgentNativeBindingSchema.options,
  z.object({ tool: z.literal("research.evidence"), scope: agentResourceInputSchemas["research.evidence"] }).strict(),
  z.object({ tool: z.literal("catalog.sku"), scope: agentResourceInputSchemas["catalog.sku"] }).strict(),
  z.object({ tool: z.literal("listing.version"), scope: agentResourceInputSchemas["listing.version"] }).strict(),
  z.object({ tool: z.literal("orders.order"), scope: agentResourceInputSchemas["orders.order"] }).strict(),
  z.object({ tool: z.literal("finance.profit_run"), scope: agentResourceInputSchemas["finance.profit_run"] }).strict(),
  z.object({ tool: z.literal("advertising.analysis"), scope: agentResourceInputSchemas["advertising.analysis"] }).strict(),
]);
export const AgentNativeV2LimitsSchema = z.object({
  maxModelTurns: z.int().min(2).max(48), maxToolCalls: z.int().min(2).max(192), maxRows: z.int().min(1).max(10_000),
  maxOutputTokens: z.int().min(128).max(8192), maxPromptBytes: z.int().min(4096).max(1_048_576),
  deadlineSeconds: z.int().min(30).max(1800), maxProposals: z.int().min(1).max(8),
}).strict();
export const defaultAgentNativeV2Limits = () => AgentNativeV2LimitsSchema.parse({ maxModelTurns: 32, maxToolCalls: 128, maxRows: 5000,
  maxOutputTokens: 4096, maxPromptBytes: 1_048_576, deadlineSeconds: 1200, maxProposals: 8 });
export const maximumAgentNativeV2Limits = () => AgentNativeV2LimitsSchema.parse({ ...defaultAgentNativeV2Limits(), maxModelTurns: 48,
  maxToolCalls: 192, maxRows: 10_000, maxOutputTokens: 8192, deadlineSeconds: 1800 });
export const CreateAgentNativeV2Schema = z.object({ ...Version, requestId: z.uuid(), goal: z.string().trim().min(2).max(4000),
  contextText: z.string().max(16_000), modelId: Id, bindings: z.array(AgentNativeV2BindingSchema).min(1).max(16),
  allowedCommands: z.array(AgentPlanCommandKeySchema).max(37), limits: AgentNativeV2LimitsSchema,
  maxCostUsd: z.number().finite().min(0.000001).max(100).multipleOf(0.000001), executionContract: HarnessExecutionContractSchema,
}).strict().superRefine((value, ctx) => {
  if (new Set(value.bindings.map(canonicalJson)).size !== value.bindings.length ||
    new Set(value.allowedCommands.map(agentPlanCommandKey)).size !== value.allowedCommands.length)
    ctx.addIssue({ code: "custom", message: "Each fixed binding and command must be unique" });
});
export const canonicalAgentNativeV2Request = (raw: unknown) => canonicalJson(CreateAgentNativeV2Schema.parse(raw));
export const AgentNativeV2SelectionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), tool: AgentNativeV2ReadKeySchema }).strict(),
  z.object({ kind: z.literal("command"), command: AgentPlanCommandKeySchema }).strict(),
]);
export const AgentNativeV2ReadRequestSchema = z.object({ bindingIndex: z.int().min(0).max(15), keyword: z.string().trim().min(1).max(300).nullable() }).strict();
export const AgentNativeV2DefinitionSchema = z.union([AgentToolDefinitionSchema, AgentResourceDefinitionSchema]);
export const AgentNativeV2DefinitionEvidenceSchema = z.object({ stepId: Id, definition: AgentNativeV2DefinitionSchema }).strict();
export const AgentNativeV2ReadResultSchema = z.union([AgentToolResultSchema, AgentResourceResultSchema]);
export const AgentNativeV2ObservationSchema = z.object({ stepId: Id, tool: AgentNativeV2ReadKeySchema, request: AgentNativeV2ReadRequestSchema,
  results: z.array(AgentNativeV2ReadResultSchema).min(1).max(128), basisChecksum: Hash, observedRows: z.int().min(0).max(10_000),
  collectionComplete: z.boolean().nullable(), truncatedBy: z.enum(["row_limit", "tool_limit"]).nullable(),
}).strict().superRefine((value, ctx) => {
  const paged = value.tool === "orders.exceptions.page" || value.tool === "inventory.balances.page";
  if (value.results.some(result => result.tool !== value.tool) || paged !== (value.collectionComplete !== null) ||
    !paged && (value.results.length !== 1 || value.truncatedBy !== null) || paged && value.collectionComplete !== (value.truncatedBy === null))
    ctx.addIssue({ code: "custom", message: "Coverage must describe the original result kind" });
});
export const AgentNativeV2ClaimSchema = z.object({ ...AgentNativeClaimSchema.shape, resultIndex: z.int().min(0).max(127) }).strict();
export const AgentNativeV2ModelResultSchema = z.object({ summary: z.string().min(1).max(4000), claims: z.array(AgentNativeV2ClaimSchema).max(100),
  missingInformation: z.array(z.string().min(1).max(500)).max(30), proposals: z.array(AgentNativeDraftSchema).max(8) }).strict();
export const AgentNativeV2DecisionSchema = z.object({ action: z.enum(["definition", "read", "finish"]), label: z.string().min(1).max(160),
  definition: AgentNativeV2SelectionSchema.nullable(), read: AgentNativeV2ReadRequestSchema.nullable(), result: AgentNativeV2ModelResultSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.action === "definition" ? value.definition === null || value.read !== null || value.result !== null :
    value.action === "read" ? value.read === null || value.definition !== null || value.result !== null : value.result === null || value.definition !== null || value.read !== null)
    ctx.addIssue({ code: "custom", message: "A decision contains exactly its chosen payload" });
});
export const AgentNativeV2ResultSchema = z.object({ summary: z.string().min(1).max(4000), claims: z.array(AgentNativeV2ClaimSchema).max(100),
  missingInformation: z.array(z.string().min(1).max(500)).max(30), proposals: z.array(AgentNativeResolvedProposalSchema).max(8),
}).strict().superRefine((value, ctx) => {
  if (value.proposals.some((proposal, index) => proposal.position !== index || proposal.claimIndexes.some(index => !value.claims[index])))
    ctx.addIssue({ code: "custom", message: "Resolved proposal order and source claims must be bound" });
});
export const AgentNativeV2PinnedInputSchema = z.object({ ...AgentNativePinnedInputSchema.shape, ...Version, request: CreateAgentNativeV2Schema,
  legacyReadExecutionContract: HarnessExecutionContractSchema, resourceExecutionContract: HarnessExecutionContractSchema }).strict();
export const AgentNativeV2StepViewSchema = z.object({ ...AgentNativeStepViewSchema.shape, sequence: z.int().min(1).max(96), tool: AgentNativeV2ReadKeySchema.nullable() }).strict();
export const AgentNativeV2CostSchema = z.object({ ...AgentNativeCostSchema.shape, modelTurns: z.int().min(0).max(48) }).strict();
export const AgentNativeV2ViewSchema = z.object({ ...AgentNativeViewSchema.shape, ...Version, bindings: z.array(AgentNativeV2BindingSchema).max(16),
  limits: AgentNativeV2LimitsSchema, cost: AgentNativeV2CostSchema, steps: z.array(AgentNativeV2StepViewSchema).max(96),
  readContracts: z.object({ legacy: HarnessExecutionContractSchema, resources: HarnessExecutionContractSchema }).strict().nullable(),
  definitions: z.array(AgentNativeV2DefinitionEvidenceSchema).max(47), observations: z.array(AgentNativeV2ObservationSchema).max(47),
  result: AgentNativeV2ResultSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.privateAvailable !== (value.readContracts !== null) || !value.privateAvailable && (value.goal !== null || value.contextText !== null || value.bindings.length || value.steps.length || value.definitions.length || value.observations.length || value.result !== null))
    ctx.addIssue({ code: "custom", message: "Unavailable private content must be cleared" });
  if (value.result && (value.items.length !== value.result.proposals.length || value.items.some((item, index) => {
    const proposal = value.result!.proposals[index]; return !proposal || item.id !== proposal.id || item.position !== proposal.position ||
      item.proposalChecksum !== proposal.proposalChecksum || item.originalChecksum !== proposal.originalChecksum || item.preparationRequestChecksum !== proposal.preparationRequestChecksum;
  }))) ctx.addIssue({ code: "custom", message: "Items must match immutable proposals" });
});
export const AgentNativeV2WorkspaceSchema = z.object({ ...AgentNativeWorkspaceSchema.shape, ...Version, resourceWorkspace: AgentResourceWorkspaceSchema,
  limits: AgentNativeV2LimitsSchema }).strict();
export const AgentNativeV2ReceiptQuerySchema = z.object({ requestId: z.uuid(), requestChecksum: Hash }).strict();
export const AgentNativeV2ReceiptSchema = z.object({ ...AgentNativeReceiptSchema.shape, ...Version }).strict().superRefine((value, ctx) => {
  if (value.disposition === "known" ? !value.runId || !value.status : value.runId !== null || value.status !== null || value.privateAvailable)
    ctx.addIssue({ code: "custom", message: "Receipt identifies only its original request" });
});
export const StopAgentNativeV2Schema = z.object({ ...Version, requestId: z.uuid() }).strict();
export const PrepareAgentNativeV2ItemSchema = z.object({ ...Version, requestId: z.uuid(), proposalChecksum: Hash }).strict();
export const AgentNativeV2ItemReceiptSchema = z.object({ ...AgentNativeItemReceiptSchema.shape, ...Version }).strict().superRefine((value, ctx) => {
  if (value.disposition === "known" ? !value.agentCommandId || !value.ownerCommandId : value.agentCommandId !== null || value.ownerCommandId !== null)
    ctx.addIssue({ code: "custom", message: "Known receipts retain both original command IDs" });
});
export const AgentNativeV2IntentSchema = AgentNativeIntentSchema;
export const AgentNativeV2PreparationIntentSchema = AgentNativePreparationIntentSchema;
export const AgentNativeV2TurnInputSchema = z.object({ ...AgentNativeTurnInputSchema.shape, ...Version, turn: z.int().min(1).max(48),
  bindings: z.array(AgentNativeV2BindingSchema).min(1).max(16), limits: AgentNativeV2LimitsSchema,
  definitions: z.array(AgentNativeV2DefinitionEvidenceSchema).max(47), observations: z.array(AgentNativeV2ObservationSchema).max(47) }).strict();

export function agentNativeV2DefinitionSelection(value: z.infer<typeof AgentNativeV2DefinitionSchema>): z.infer<typeof AgentNativeV2SelectionSchema> {
  return "selection" in value ? value.selection : { kind: "read", tool: value.tool };
}
export function agentNativeV2SourceBasis(result: z.infer<typeof AgentNativeV2ReadResultSchema>) {
  if (result.version === "erp-agent-tools-v1") return agentNativeSourceBasis(result);
  return { version: result.version, tool: result.tool, definitionChecksum: result.definitionChecksum, input: result.input,
    data: result.data, sources: result.sources, coverage: result.coverage };
}
export function agentNativeV2ObservationRows(result: z.infer<typeof AgentNativeV2ReadResultSchema>): number {
  if (result.version === "erp-agent-resources-v1") return 1;
  switch (result.tool) {
    case "orders.exceptions.page":
    case "inventory.balances.page": return result.data.items.length;
    case "knowledge.search": return result.data.references.length;
    case "creative.history": return result.data.entries.length;
    case "factory.capacity": return result.data.pools.length + result.data.calendar.length;
  }
}
export function agentNativeV2ObservationBasisPayload(value: Pick<AgentNativeV2Observation, "tool" | "request" | "results" | "observedRows" | "collectionComplete" | "truncatedBy">) {
  return { version: AGENT_NATIVE_V2_VERSION, tool: value.tool, request: value.request, results: value.results.map(agentNativeV2SourceBasis),
    observedRows: value.observedRows, collectionComplete: value.collectionComplete, truncatedBy: value.truncatedBy };
}
export function agentNativeV2ProposalChecksumPayload(value: z.infer<typeof AgentNativeResolvedProposalSchema>, claims: readonly AgentNativeV2Claim[]) {
  return { version: AGENT_NATIVE_V2_VERSION, draft: value.draft, claimIndexes: value.claimIndexes, claims: value.claimIndexes.map(index => claims[index]) };
}
export function agentNativeV2ClaimValue(observation: AgentNativeV2Observation, claim: AgentNativeV2Claim): unknown {
  const result = observation.results[claim.resultIndex];
  if (!result || claim.stepId !== observation.stepId || claim.dataChecksum !== result.dataChecksum) throw new Error("agent_native_v2_claim_invalid");
  if (result.version === "erp-agent-tools-v1") {
    return agentNativeClaimValue({ ...observation, tool: result.tool, results: [result] }, { ...claim, resultIndex: 0 });
  }
  // Only business DTO fields are claimable. Envelope authority, hashes, clocks,
  // coverage and aggregate candidate totals never become business facts.
  const excluded = new Set(["packageRead", "dataChecksum", "inputChecksum", "definitionChecksum", "contextAuthority", "checkedAt"]);
  let value: unknown = result.data;
  for (const part of claim.path) {
    if (["__proto__", "constructor", "prototype"].includes(String(part)) || excluded.has(String(part)) || value === null || typeof value !== "object" ||
      Array.isArray(value) !== (typeof part === "number") || !Object.hasOwn(value, part)) throw new Error("agent_native_v2_claim_invalid");
    value = (value as Record<string, unknown>)[part];
  }
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error("agent_native_v2_claim_invalid");
  return value;
}
export type AgentNativeV2Binding = z.infer<typeof AgentNativeV2BindingSchema>;
export type AgentNativeV2ReadKey = z.infer<typeof AgentNativeV2ReadKeySchema>;
export type AgentNativeV2Selection = z.infer<typeof AgentNativeV2SelectionSchema>;
export type AgentNativeV2Claim = z.infer<typeof AgentNativeV2ClaimSchema>;
export type AgentNativeV2Observation = z.infer<typeof AgentNativeV2ObservationSchema>;
export type AgentNativeV2DefinitionEvidence = z.infer<typeof AgentNativeV2DefinitionEvidenceSchema>;
export type AgentNativeV2PinnedInput = z.infer<typeof AgentNativeV2PinnedInputSchema>;
export type AgentNativeV2View = z.infer<typeof AgentNativeV2ViewSchema>;
export type AgentNativeV2Result = z.infer<typeof AgentNativeV2ResultSchema>;
export type AgentNativeV2TurnInput = z.infer<typeof AgentNativeV2TurnInputSchema>;
export type CreateAgentNativeV2 = z.infer<typeof CreateAgentNativeV2Schema>;
export type AgentNativeV2Workspace = z.infer<typeof AgentNativeV2WorkspaceSchema>;
export type AgentNativeV2Receipt = z.infer<typeof AgentNativeV2ReceiptSchema>;
export type AgentNativeV2ItemReceipt = z.infer<typeof AgentNativeV2ItemReceiptSchema>;
export type AgentNativeV2Limits = z.infer<typeof AgentNativeV2LimitsSchema>;
export type AgentNativeV2ReadRequest = z.infer<typeof AgentNativeV2ReadRequestSchema>;
export const AgentNativeV2StatusSchema = AgentLoopStatusSchema;
