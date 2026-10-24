import { AGENT_NATIVE_V2_VERSION, AgentNativeV2PinnedInputSchema, AgentNativeV2TurnInputSchema, AgentNativeV2DecisionSchema,
  CreateAgentNativeV2Schema, AgentNativeV2SelectionSchema, AgentNativeV2ReadRequestSchema, AgentNativeV2ResultSchema,
  AgentNativeV2WorkspaceSchema, AgentNativeV2ViewSchema, AgentNativeV2ReceiptSchema, AgentNativeV2ReceiptQuerySchema,
  StopAgentNativeV2Schema, PrepareAgentNativeV2ItemSchema, AgentNativeV2ItemReceiptSchema, maximumAgentNativeV2Limits,
  agentNativeV2DefinitionSelection, agentNativeV2ObservationRows,
} from "@yummyai/contracts/ai/agent-native-v2";
import { AGENT_RESOURCES_VERSION, AgentResourceCallSchema, AgentResourceKeySchema, AgentResourceResultSchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, AgentToolResultSchema, AgentToolSelectionSchema } from "@yummyai/contracts/ai/agent-tools";
import { AgentNativeError, agentNativeSlots } from "./agent-native-model.js";
import { agentToolsHarness, agentToolsSkill } from "./agent-tools-gateway.js";
import { agentResourcesHarness, agentResourcesSkill } from "./agent-resources-gateway.js";
import { AGENT_NATIVE_V2_MODEL_TOOL, agentNativeV2Harness, agentNativeV2Skill, agentNativeV2ReadSkill, agentNativeV2CheckDomains,
  agentNativeV2ReadKeys, agentNativeV2DecisionWireSchema, agentNativeV2DecisionJsonSchema, resolveAgentNativeV2Result } from "./agent-native-v2-model.js";
import { NativeV2ReadProgressSchema, nativeV2EvidenceChain, nativeV2ReadCall, verifyNativeV2ReadResult, validateNativeV2Definition,
  buildNativeV2Observation, verifyNativeV2Claims, recheckNativeV2Evidence } from "./agent-native-v2-evidence.js";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { erpPermissionContext } from "@yummyai/authz";
import type { NativePorts, NativeProtocol } from "./agent-native-protocol.js";

const resources = (ports: NativePorts) => { if (!ports.resources) throw new AgentNativeError("agent_resources_unavailable"); return ports.resources; };
export const agentNativeV2Protocol: NativeProtocol = {
  version: AGENT_NATIVE_V2_VERSION, maxSteps: 96, maxHistoryCalls: 96, outputSchemaName: "erp_agent_native_decision_v2",
  modelTool: AGENT_NATIVE_V2_MODEL_TOOL, harness: agentNativeV2Harness, skill: agentNativeV2Skill,
  decisionWireSchema: agentNativeV2DecisionWireSchema, decisionJsonSchema: agentNativeV2DecisionJsonSchema,
  schemas: { request: CreateAgentNativeV2Schema, pinned: AgentNativeV2PinnedInputSchema, turn: AgentNativeV2TurnInputSchema, decision: AgentNativeV2DecisionSchema,
    readRequest: AgentNativeV2ReadRequestSchema, selection: AgentNativeV2SelectionSchema, result: AgentNativeV2ResultSchema, progress: NativeV2ReadProgressSchema,
    workspace: AgentNativeV2WorkspaceSchema, view: AgentNativeV2ViewSchema, receipt: AgentNativeV2ReceiptSchema, receiptQuery: AgentNativeV2ReceiptQuerySchema,
    stop: StopAgentNativeV2Schema, prepare: PrepareAgentNativeV2ItemSchema, itemReceipt: AgentNativeV2ItemReceiptSchema },
  maximumLimits: maximumAgentNativeV2Limits, checkDomains: agentNativeV2CheckDomains, readKeys: agentNativeV2ReadKeys, slots: agentNativeSlots,
  async workspace(context, ports) {
    const legacy = await ports.tools.workspace(context), resource = await resources(ports).workspace(context);
    if (legacy.contextAuthority !== resource.contextAuthority || legacy.contextAuthority !== erpSessionAuthority(erpPermissionContext(context))) throw new AgentNativeError("agent_access_changed");
    return { contextAuthority: legacy.contextAuthority, executionContract: agentNativeV2Harness.pin(agentNativeV2ReadSkill), legacy, resources: resource,
      tools: [...legacy.tools, ...resource.tools] };
  },
  pinReads(workspace) {
    if (!workspace.resources) throw new AgentNativeError("agent_resources_unavailable");
    return { readExecutionContract: workspace.executionContract, legacyReadExecutionContract: workspace.legacy.executionContract, resourceExecutionContract: workspace.resources.executionContract };
  },
  assertReadContract(raw) {
    const input = AgentNativeV2PinnedInputSchema.parse(raw); agentNativeV2Harness.assertCurrent(input.readExecutionContract, agentNativeV2ReadSkill);
    agentToolsHarness.assertCurrent(input.legacyReadExecutionContract, agentToolsSkill); agentResourcesHarness.assertCurrent(input.resourceExecutionContract, agentResourcesSkill);
  },
  viewFields: input => ({ readContracts: input ? { legacy: input.legacyReadExecutionContract, resources: input.resourceExecutionContract } : null }),
  workspaceFields: workspace => ({ toolWorkspace: workspace.legacy, resourceWorkspace: workspace.resources }),
  selectionOf: agentNativeV2DefinitionSelection,
  async definition(context, selection, ports) {
    return selection.kind === "read" && AgentResourceKeySchema.safeParse(selection.tool).success
      ? resources(ports).definition(context, { version: AGENT_RESOURCES_VERSION, tool: AgentResourceKeySchema.parse(selection.tool) })
      : ports.tools.definition(context, { version: AGENT_TOOLS_VERSION, selection: AgentToolSelectionSchema.parse(selection) });
  },
  validateDefinition: validateNativeV2Definition, readCall: nativeV2ReadCall,
  async call(context, call, ports) {
    return call.version === AGENT_RESOURCES_VERSION ? AgentResourceResultSchema.parse(await resources(ports).call(context, AgentResourceCallSchema.parse(call)))
      : AgentToolResultSchema.parse(await ports.tools.call(context, AgentToolCallSchema.parse(call)));
  },
  verifyReadResult: verifyNativeV2ReadResult, observationRows: agentNativeV2ObservationRows, buildObservation: buildNativeV2Observation,
  evidenceChain: nativeV2EvidenceChain, verifyClaims: verifyNativeV2Claims, resolveResult: resolveAgentNativeV2Result,
  recheck: (input, definitions, observations, ports, take) => recheckNativeV2Evidence(input, definitions, observations, ports, take, agentNativeV2Protocol),
  scopeAvailable: (context,input,evidence,ports) => scopeV2Bindings(context,input,evidence,ports,false),
  async beforeModelSubmit(context,input,evidence,ports) {
    if (!await scopeV2Bindings(context,input,evidence,ports,true)) throw new AgentNativeError("agent_access_changed");
  },
};
async function scopeV2Bindings(context: Parameters<NativeProtocol["scopeAvailable"]>[0], input: Parameters<NativeProtocol["scopeAvailable"]>[1], evidence: Parameters<NativeProtocol["scopeAvailable"]>[2], ports: NativePorts, observedOnly: boolean): Promise<boolean> {
    const pinned = AgentNativeV2PinnedInputSchema.parse(input);
    const observed = new Set(evidence.observations.map(value => value.request.bindingIndex));
    // GET checks current access and keeps the old sealed values. In particular,
    // a normal order revision is not a permission revocation or history rewrite.
    try {
      const legacyBindings = pinned.request.bindings.flatMap((binding, bindingIndex) => AgentResourceKeySchema.safeParse(binding.tool).success || observedOnly && !observed.has(bindingIndex) ? [] : [{ binding, bindingIndex }]);
      for (const [bindingIndex, binding] of pinned.request.bindings.entries()) {
        if (observedOnly && !observed.has(bindingIndex)) continue;
        switch (binding.tool) {
          case "research.evidence": await resources(ports).assertBindingAccess(context, {tool: binding.tool, input: binding.scope}); break;
          case "catalog.sku": await resources(ports).assertBindingAccess(context, {tool: binding.tool, input: binding.scope}); break;
          case "listing.version": await resources(ports).assertBindingAccess(context, {tool: binding.tool, input: binding.scope}); break;
          case "orders.order": await resources(ports).assertBindingAccess(context, {tool: binding.tool, input: binding.scope}); break;
          case "finance.profit_run": await resources(ports).assertBindingAccess(context, {tool: binding.tool, input: binding.scope}); break;
          case "advertising.analysis": await resources(ports).assertBindingAccess(context, {tool: binding.tool, input: binding.scope}); break;
        }
      }
      const definitions = new Map<string, string>();
      for (const { binding, bindingIndex } of legacyBindings) {
        let checksum = definitions.get(binding.tool);
        if (!checksum) { const selected = { kind: "read" as const, tool: binding.tool }; const definition = validateNativeV2Definition(input, await agentNativeV2Protocol.definition(context, selected, ports), selected);
          checksum = definition.definitionChecksum; definitions.set(binding.tool, checksum); }
        const observation = evidence.observations.find(value => value.request.bindingIndex === bindingIndex), factory = observation?.results.find(value => value.tool === "factory.capacity");
        const call = nativeV2ReadCall(input, { bindingIndex, keyword: binding.tool === "knowledge.search" ? observation?.request.keyword ?? "范围权限核对" : null }, checksum,
          { pageSize: 1, cursor: null, ...(factory?.tool === "factory.capacity" ? { factoryFrom: factory.data.from } : {}) });
        await agentNativeV2Protocol.call(context, call, ports);
      }
      return true;
    } catch { return false; }
}
