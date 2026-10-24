import { HarnessRegistry } from "@yummyai/ai-core";
import { Permission, authorize, permissionScope } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { AgentCommandOriginalSchema } from "@yummyai/contracts/ai/agent-command";
import { agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_NATIVE_V2_VERSION, AgentNativeV2DecisionSchema, AgentNativeV2ModelResultSchema, AgentNativeV2ResultSchema,
  AgentNativeV2TurnInputSchema, AgentNativeV2ReadRequestSchema, AgentNativeV2ReadResultSchema, AgentNativeV2ReadKeySchema,
  agentNativeV2DefinitionSelection, agentNativeV2ProposalChecksumPayload, type AgentNativeV2DefinitionEvidence,
} from "@yummyai/contracts/ai/agent-native-v2";
import { z } from "zod";
import { AgentNativeError, agentNativeChecksum, agentNativeHarness, agentNativeSkill } from "./agent-native-model.js";
import { agentPlanCheckDomains, resolveAgentPlanResult } from "./agent-plan-model.js";
import type { NativeProtocol } from "./agent-native-protocol.js";

export { agentNativeChecksum as agentNativeV2Checksum, agentNativeSlots as agentNativeV2Slots } from "./agent-native-model.js";
export const agentNativeV2ReadKeys: NativeProtocol["readKeys"] = selection => [...new Set(selection.bindings?.map(value => value.tool)
  ?? z.array(AgentNativeV2ReadKeySchema).parse(selection.allowedReads ?? []))];
export const agentNativeV2CheckDomains: NativeProtocol["checkDomains"] = (context: TenantContext, selection, requireRun = true) => {
  agentPlanCheckDomains(context, { allowedReads: [], allowedCommands: selection.allowedCommands }, requireRun);
  for (const key of agentNativeV2ReadKeys(selection)) {
    const bits = key === "creative.history" ? [Permission.DesignRead, Permission.AssetRead] : key === "inventory.balances.page" ? [Permission.InventoryRead]
      : ["orders.exceptions.page", "factory.capacity", "orders.order"].includes(key) ? [Permission.OrderRead] : key === "research.evidence" ? [Permission.ResearchRead]
      : key === "catalog.sku" ? [Permission.ProductRead] : key === "listing.version" ? [Permission.ListingRead] : key === "finance.profit_run" ? [Permission.FinanceRead]
      : key === "advertising.analysis" ? [Permission.CustomerIntelligenceRead] : [Permission.WorkflowRead];
    for (const bit of bits) {
      authorize(context, bit, { ownerId: context.userId });
      if (["orders.exceptions.page", "inventory.balances.page", "factory.capacity", "orders.order", "finance.profit_run"].includes(key) && permissionScope(context, bit) !== "tenant")
        throw new AgentNativeError("agent_access_changed");
    }
  }
  for (const binding of selection.bindings ?? []) if (binding.tool === "knowledge.search" && binding.scope.spuIds.length)
    authorize(context, Permission.ProductRead, { ownerId: context.userId });
};
export function resolveAgentNativeV2Result(runId: string, raw: unknown, allowedCommands: Parameters<typeof resolveAgentPlanResult>[2], limit: number,
  definitions: readonly AgentNativeV2DefinitionEvidence[]) {
  const model = AgentNativeV2ModelResultSchema.parse(raw);
  if (model.proposals.length > limit || !allowedCommands.length && model.proposals.length) throw new AgentNativeError("agent_proposal_not_allowed");
  const loaded = new Set(definitions.flatMap(row => { const selection = agentNativeV2DefinitionSelection(row.definition);
    return row.definition.available && selection.kind === "command" ? [agentPlanCommandKey(selection.command)] : []; }));
  for (const proposal of model.proposals) if (!loaded.has(agentPlanCommandKey(proposal.capability)) || proposal.claimIndexes.some(index => !model.claims[index])
    || new Set(proposal.claimIndexes).size !== proposal.claimIndexes.length) throw new AgentNativeError("agent_proposal_not_allowed");
  const normalized = allowedCommands.length ? resolveAgentPlanResult(runId, { summary: model.summary, claims: [], missingInformation: model.missingInformation,
    proposals: model.proposals.map(proposal => ({ position: proposal.position, capability: proposal.capability, label: proposal.label, reason: proposal.reason,
      original: proposal.draftJson === null ? null : AgentCommandOriginalSchema.parse(JSON.parse(proposal.draftJson)), claims: [], missingInformation: proposal.missingInformation })) }, allowedCommands, limit) : { proposals: [] };
  const proposals = normalized.proposals.map((proposal, index) => { const value = { ...proposal, claimIndexes: model.proposals[index]!.claimIndexes };
    return { ...value, proposalChecksum: agentNativeChecksum(agentNativeV2ProposalChecksumPayload(value, model.claims)) }; });
  return AgentNativeV2ResultSchema.parse({ summary: model.summary, claims: model.claims, missingInformation: model.missingInformation, proposals });
}
export const agentNativeV2Skill = { key: "erp.agent.native.v2", version: AGENT_NATIVE_V2_VERSION } as const;
export const agentNativeV2ReadSkill = { key: "erp.agent.native.v2.read", version: AGENT_NATIVE_V2_VERSION } as const;
export const AGENT_NATIVE_V2_MODEL_TOOL = "agent.native.v2.decide";
export const agentNativeV2DecisionWireSchema = z.fromJSONSchema(z.toJSONSchema(AgentNativeV2DecisionSchema, { io: "input" }));
export const agentNativeV2DecisionJsonSchema = z.toJSONSchema(agentNativeV2DecisionWireSchema);
export const agentNativeV2Harness = new HarnessRegistry("erp.agent.native.v2", [{
  descriptor: { key: AGENT_NATIVE_V2_MODEL_TOOL, version: AGENT_NATIVE_V2_VERSION, owner: "workflow", label: "十一类原业务读取 Agent",
    effect: "external_request", inputSchemaKey: "agent.native.v2.turn.input", outputSchemaKey: "agent.native.v2.decision.output",
    permissionPolicyVersion: AGENT_NATIVE_V2_VERSION, requiredPermissions: [Permission.WorkflowRead, Permission.WorkflowRun], resourcePolicy: "active-member.original-ceiling.fixed-native-v2-bindings",
    dataDomains: ["business"], timeout: { mode: "fenced_lease", milliseconds: 120_000 }, maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576,
    recovery: "response_or_reconcile", approval: "owning_business_flow" }, inputSchema: AgentNativeV2TurnInputSchema, outputSchema: agentNativeV2DecisionWireSchema,
}, {
  descriptor: { key: "agent.native.v2.read", version: AGENT_NATIVE_V2_VERSION, owner: "workflow", label: "固定原owner读取委派",
    effect: "read", inputSchemaKey: "agent.native.v2.read.input", outputSchemaKey: "agent.native.v2.read.output",
    permissionPolicyVersion: AGENT_NATIVE_V2_VERSION, requiredPermissions: [Permission.WorkflowRead], resourcePolicy: "fixed-binding.original-owner.current-membership-and-object-scope",
    dataDomains: ["business"], timeout: { mode: "result_deadline", milliseconds: 30_000 }, maxInputBytes: 32768, maxOutputBytes: 8_388_608,
    recovery: "owner_receipt", approval: "owning_business_flow" }, inputSchema: AgentNativeV2ReadRequestSchema, outputSchema: AgentNativeV2ReadResultSchema,
}], [{ ...agentNativeV2Skill, label: "ERP原业务 Agent v2", tools: [{ key: AGENT_NATIVE_V2_MODEL_TOOL, version: AGENT_NATIVE_V2_VERSION }],
  steps: ["按需加载所选定义", "读取固定的原owner对象", "复查来源并形成未批准提案"],
  instructions: agentNativeHarness.instructions(agentNativeHarness.pin(agentNativeSkill), agentNativeSkill) +
    " This is a separate native-v2 run with eleven allowed read kinds and independent bounded limits. Resource envelopes remain their original resources-v1 protocol. " +
    "Six resources are single_object_projection complete=false, never a whole-domain total. An order binding pins expectedSequence and may become stale. " +
    "Profit and advertising use saved original records. Preserve exact money strings, currency, units, nulls and missing diagnostics. " +
    "Normal source progress does not rewrite saved history. Only the server rechecks current source basis before adopting a finish or staging a proposal.",
}, { ...agentNativeV2ReadSkill, label: "固定原owner读取v2", tools: [{ key: "agent.native.v2.read", version: AGENT_NATIVE_V2_VERSION }],
  steps: ["固定原绑定", "校验委派pin", "调用原owner并验证原封套"],
  instructions: "Delegate only to the saved original tools-v1/resources-v1 execution contracts. Current membership intersects the original ceiling; each owner checks object access and exact requested version. Never expand bindings or write facts.",
}]);
