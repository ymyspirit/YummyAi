import { HarnessRegistry } from "@yummyai/ai-core";
import { authorize, Permission, permissionScope } from "@yummyai/authz";
import {
  AGENT_COMMAND_VERSION, AgentCommandOriginalSchema, canonicalAgentCommandOriginal,
  canonicalAgentCommandRequest, normalizeAgentCommandOriginal,
} from "@yummyai/contracts/ai/agent-command";
import {
  AgentCommandV2KeySchema, agentCommandV2Key, agentCommandV2DefinitionPayload,
} from "@yummyai/contracts/ai/agent-command-v2-discovery";
import {
  agentFulfillmentOperatorChecks, assertAgentModelOperatorFields, parseAgentFulfillmentSuggestion,
} from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import {
  AGENT_NATIVE_V4_VERSION, AgentNativeV4DecisionSchema, AgentNativeV4DefinitionSchema,
  AgentNativeV4ModelResultSchema, AgentNativeV4ResolvedDraftSchema, AgentNativeV4ResultSchema,
  AgentNativeV4TurnInputSchema, AgentNativeV4ReadRequestSchema, AgentNativeV4ReadResultSchema,
  AgentNativeV4ReadKeySchema, agentNativeV4DefinitionSelection, agentNativeV4ProposalChecksumPayload,
  type AgentNativeV4DefinitionEvidence, type AgentNativeV4ResolvedProposal,
} from "@yummyai/contracts/ai/agent-native-v4";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentNativeError, agentNativeChecksum, agentNativeSlots } from "./agent-native-model.js";
import { agentNativeV3CheckDomains, agentNativeV3Harness, agentNativeV3Skill } from "./agent-native-v3-model.js";
import type { NativeProtocol, NativeV4Family } from "./agent-native-protocol.js";

export { agentNativeChecksum as agentNativeV4Checksum, agentNativeSlots as agentNativeV4Slots } from "./agent-native-model.js";

export const agentNativeV4ReadKeys: NativeProtocol<NativeV4Family>["readKeys"] = selection => [...new Set(
  selection.bindings?.map(value => value.tool) ?? z.array(AgentNativeV4ReadKeySchema).parse(selection.allowedReads ?? []),
)];

/** These are read/admission gates. Original input-dependent write gates stay at preparation and execution. */
export const agentNativeV4CheckDomains: NativeProtocol<NativeV4Family>["checkDomains"] = (context, selection, requireRun = true) => {
  agentNativeV3CheckDomains(context, { ...selection,
    allowedCommands: selection.allowedCommands.filter(command => command.domain !== "fulfillment"),
  }, requireRun);
  for (const command of selection.allowedCommands) {
    if (command.domain !== "fulfillment") continue;
    const bits = [Permission.OrderRead, Permission.OrderPiiRead,
      ...(["delivery_create", "delivery_feedback"].includes(command.kind) ? [Permission.DesignRead, Permission.AssetRead] : [])];
    for (const bit of bits) {
      authorize(context, bit, { ownerId: context.userId });
      if (permissionScope(context, bit) !== "tenant") throw new AgentNativeError("agent_access_changed");
    }
  }
};

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
function modelJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new AgentNativeError("agent_proposal_invalid"); }
}

/** The raw provider checkpoint is untouched. Only a distinct, server-normalized result is returned. */
export const resolveAgentNativeV4Result: NativeProtocol<NativeV4Family>["resolveResult"] = (
  runId, raw, allowedCommands, limit, definitions: readonly AgentNativeV4DefinitionEvidence[],
) => {
  const model = AgentNativeV4ModelResultSchema.parse(raw), slots = agentNativeSlots(runId, limit);
  const selected = z.array(AgentCommandV2KeySchema).max(51).parse(allowedCommands);
  const allowed = new Set(selected.map(agentCommandV2Key));
  if (allowed.size !== selected.length || model.proposals.length > slots.length) throw new AgentNativeError("agent_proposal_limit");
  const loaded = new Set(definitions.flatMap(row => {
    const definition = AgentNativeV4DefinitionSchema.parse(row.definition), selection = agentNativeV4DefinitionSelection(definition);
    return selection.kind === "command" && "protocol" in definition && definition.available &&
      definition.definitionChecksum === agentNativeChecksum(agentCommandV2DefinitionPayload(definition))
      ? [agentCommandV2Key(selection.command)] : [];
  }));
  const proposals = model.proposals.map((candidate, position): AgentNativeV4ResolvedProposal => {
    const slot = slots[position], key = agentCommandV2Key(candidate.capability);
    if (!slot || candidate.position !== position || !allowed.has(key) || !loaded.has(key) ||
      candidate.claimIndexes.some(index => !model.claims[index]) || new Set(candidate.claimIndexes).size !== candidate.claimIndexes.length)
      throw new AgentNativeError("agent_proposal_not_allowed");
    const parsed = candidate.draftJson === null ? null : modelJson(candidate.draftJson);
    let original: z.infer<typeof AgentCommandOriginalSchema> | null = null;
    let fulfillment: ReturnType<typeof parseAgentFulfillmentSuggestion> | null = null;
    if (candidate.capability.domain === "fulfillment") {
      if (parsed !== null) {
        try { fulfillment = parseAgentFulfillmentSuggestion(parsed); }
        catch (error) {
          if (error instanceof Error && error.message === "agent_proposal_operator_field_forbidden")
            throw new AgentNativeError("agent_proposal_operator_field_forbidden");
          throw new AgentNativeError("agent_proposal_invalid");
        }
        if (fulfillment.original.kind !== candidate.capability.kind) throw new AgentNativeError("agent_proposal_not_allowed");
      }
    } else if (parsed !== null) {
      try { assertAgentModelOperatorFields(parsed); }
      catch { throw new AgentNativeError("agent_proposal_operator_field_forbidden"); }
      original = normalizeAgentCommandOriginal(AgentCommandOriginalSchema.parse(parsed));
      if (original.domain !== candidate.capability.domain || original.command.kind !== candidate.capability.kind)
        throw new AgentNativeError("agent_proposal_not_allowed");
      if (original.command.input.idempotencyKey !== slot.id) throw new AgentNativeError("agent_proposal_key_invalid");
    }
    const draft = AgentNativeV4ResolvedDraftSchema.parse({ position, capability: candidate.capability, label: candidate.label,
      reason: candidate.reason, original, fulfillment, claims: [], missingInformation: candidate.missingInformation });
    const originalChecksum = original ? sha(canonicalAgentCommandOriginal(original)) : null;
    const preparationRequestChecksum = original ? sha(canonicalAgentCommandRequest("prepare", {
      version: AGENT_COMMAND_VERSION, requestId: slot.id, original,
    })) : null;
    const value = { id: slot.id, position, proposalChecksum: "0".repeat(64), originalChecksum, preparationRequestChecksum,
      draft, claimIndexes: candidate.claimIndexes, operatorChecks: fulfillment ? agentFulfillmentOperatorChecks(fulfillment.original.kind) : [] };
    return { ...value, proposalChecksum: agentNativeChecksum(agentNativeV4ProposalChecksumPayload(value, model.claims)) };
  });
  return AgentNativeV4ResultSchema.parse({ summary: model.summary, claims: model.claims, missingInformation: model.missingInformation, proposals });
};

export const agentNativeV4Skill = { key: "erp.agent.native.v4", version: AGENT_NATIVE_V4_VERSION } as const;
export const agentNativeV4ReadSkill = { key: "erp.agent.native.v4.read", version: AGENT_NATIVE_V4_VERSION } as const;
export const AGENT_NATIVE_V4_MODEL_TOOL = "agent.native.v4.decide";
export const agentNativeV4DecisionWireSchema = z.fromJSONSchema(z.toJSONSchema(AgentNativeV4DecisionSchema, { io: "input" }));
export const agentNativeV4DecisionJsonSchema = z.toJSONSchema(agentNativeV4DecisionWireSchema);
export const agentNativeV4Harness = new HarnessRegistry("erp.agent.native.v4", [{
  descriptor: { key: AGENT_NATIVE_V4_MODEL_TOOL, version: AGENT_NATIVE_V4_VERSION, owner: "workflow", label: "原读取与51项未批准建议",
    effect: "external_request", inputSchemaKey: "agent.native.v4.turn.input", outputSchemaKey: "agent.native.v4.decision.output",
    permissionPolicyVersion: AGENT_NATIVE_V4_VERSION, requiredPermissions: [Permission.WorkflowRead, Permission.WorkflowRun],
    resourcePolicy: "active-member.original-ceiling.fixed-native-v4-bindings",
    dataDomains: ["business"], timeout: { mode: "fenced_lease", milliseconds: 120_000 }, maxInputBytes: 1_048_576, maxOutputBytes: 1_048_576,
    recovery: "response_or_reconcile", approval: "owning_business_flow" }, inputSchema: AgentNativeV4TurnInputSchema, outputSchema: agentNativeV4DecisionWireSchema,
}, {
  descriptor: { key: "agent.native.v4.read", version: AGENT_NATIVE_V4_VERSION, owner: "workflow", label: "固定原owner读取委派v4",
    effect: "read", inputSchemaKey: "agent.native.v4.read.input", outputSchemaKey: "agent.native.v4.read.output",
    permissionPolicyVersion: AGENT_NATIVE_V4_VERSION, requiredPermissions: [Permission.WorkflowRead],
    resourcePolicy: "fixed-binding.original-owner.current-membership-and-object-scope",
    dataDomains: ["business"], timeout: { mode: "result_deadline", milliseconds: 30_000 }, maxInputBytes: 32768, maxOutputBytes: 8_388_608,
    recovery: "owner_receipt", approval: "owning_business_flow" }, inputSchema: AgentNativeV4ReadRequestSchema, outputSchema: AgentNativeV4ReadResultSchema,
}], [{ ...agentNativeV4Skill, label: "ERP原业务建议v4", tools: [{ key: AGENT_NATIVE_V4_MODEL_TOOL, version: AGENT_NATIVE_V4_VERSION }],
  steps: ["按需读取所选独立定义", "读取固定原对象和来源", "封存未批准建议并结算已发生模型费"],
  instructions: agentNativeV3Harness.instructions(agentNativeV3Harness.pin(agentNativeV3Skill), agentNativeV3Skill) + " " + [
    "This is exclusively native-v4, with independent command-definition-v2 and proposal checksums. Never emit a v1/v2/v3 task or silently fall back to them.",
    "All 51 commands require their exact loaded v2 definition. Old 37 draftJson values remain the strict original command and copy the server slot idempotencyKey.",
    "For the fourteen fulfillment commands, draftJson is ONLY the loaded AgentFulfillmentSuggestion: proposal version, domain, exact source and suggested original. It is never a complete Prepare request.",
    "Fulfillment suggestions must never contain requestId, idempotencyKey, externalEventId, confirmation tokens, operatorChecks or any human/physical attestation, including verifiedByOperator, segregationConfirmed, physicalSelectionConfirmed and orderUnitConfirmed anywhere recursively. Omit these keys even when false or null.",
    "A fulfillment source copies a saved observation stepId, resultIndex, exact dataChecksum, orderId and expectedSequence. Targets, existing items, packages, production versions/projections and shipment versions must come from that saved read scope. Never substitute another same-order source or manufacture unseen versions.",
    "Only include source identity or version fields that the saved reader actually exposes. Whole-order work revision/projection fields are not production projection versions. Omit unseen fields and list missingInformation; an operator may independently complete them using the original form.",
    "A fulfillment suggestion may be partial and have nonempty missingInformation. The server derives pending operatorChecks. The two full preparation hashes are null at proposal birth; you must not generate or claim them.",
    "Human completion and physical verification occur later in original controls, with a separate immutable full request and checksum. User-added or edited values do not inherit model claims. Neither suggestions, schema acceptance nor cited scalars authorize a business fact or physical approval.",
    "All proposals keep draft claims empty and reference only top-level claimIndexes. A finish seals the model phase; it never prepares, confirms or executes an original command, and human waiting does not retain a model lease.",
  ].join(" "),
}, { ...agentNativeV4ReadSkill, label: "固定原owner读取v4", tools: [{ key: "agent.native.v4.read", version: AGENT_NATIVE_V4_VERSION }],
  steps: ["固定原绑定", "校验独立v4及原reader的pin", "调用原owner并核验原封套"],
  instructions: "Delegate only to the saved original tools-v1/resources-v1/fulfillment-v1 contracts. Preserve original reader versions and use native-v4 observation basis. Current membership intersects the original ceiling; original owners check object access and selected versions. Never expand bindings or write facts.",
}]);
