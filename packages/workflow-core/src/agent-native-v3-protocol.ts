import { AGENT_FULFILLMENT_VERSION, AgentFulfillmentCallSchema, AgentFulfillmentResultSchema } from "@yummyai/contracts/ai/agent-fulfillment";
import { agentFulfillmentHarness, agentFulfillmentSkill } from "./agent-fulfillment-gateway.js";
import { AGENT_NATIVE_V3_VERSION, AgentNativeV3PinnedInputSchema, AgentNativeV3TurnInputSchema, AgentNativeV3DecisionSchema,
  CreateAgentNativeV3Schema, AgentNativeV3SelectionSchema, AgentNativeV3ReadRequestSchema, AgentNativeV3ResultSchema,
  AgentNativeV3WorkspaceSchema, AgentNativeV3ViewSchema, AgentNativeV3ReceiptSchema, AgentNativeV3ReceiptQuerySchema,
  StopAgentNativeV3Schema, PrepareAgentNativeV3ItemSchema, AgentNativeV3ItemReceiptSchema, maximumAgentNativeV3Limits,
  agentNativeV3DefinitionSelection, agentNativeV3ObservationRows,
} from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_RESOURCES_VERSION, AgentResourceCallSchema, AgentResourceKeySchema, AgentResourceResultSchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, AgentToolResultSchema, AgentToolSelectionSchema } from "@yummyai/contracts/ai/agent-tools";
import { AgentNativeError, agentNativeSlots } from "./agent-native-model.js";
import { agentToolsHarness, agentToolsSkill } from "./agent-tools-gateway.js";
import { agentResourcesHarness, agentResourcesSkill } from "./agent-resources-gateway.js";
import { AGENT_NATIVE_V3_MODEL_TOOL, agentNativeV3Harness, agentNativeV3Skill, agentNativeV3ReadSkill, agentNativeV3CheckDomains,
  agentNativeV3ReadKeys, agentNativeV3DecisionWireSchema, agentNativeV3DecisionJsonSchema, resolveAgentNativeV3Result } from "./agent-native-v3-model.js";
import { NativeV3ReadProgressSchema, nativeV3EvidenceChain, nativeV3ReadCall, verifyNativeV3ReadResult, validateNativeV3Definition,
  buildNativeV3Observation, verifyNativeV3Claims, recheckNativeV3Evidence } from "./agent-native-v3-evidence.js";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { erpPermissionContext } from "@yummyai/authz";
import type { NativePorts, NativeProtocol, NativeV3Family } from "./agent-native-protocol.js";

const fulfillment = (ports: NativePorts) => { if (!ports.fulfillment) throw new AgentNativeError("agent_fulfillment_unavailable"); return ports.fulfillment; };
const resources = (ports: NativePorts) => { if (!ports.resources) throw new AgentNativeError("agent_resources_unavailable"); return ports.resources; };
export const agentNativeV3Protocol: NativeProtocol<NativeV3Family> = {
  version: AGENT_NATIVE_V3_VERSION, maxSteps: 96, maxHistoryCalls: 96, outputSchemaName: "erp_agent_native_decision_v3",
  modelTool: AGENT_NATIVE_V3_MODEL_TOOL, harness: agentNativeV3Harness, skill: agentNativeV3Skill,
  decisionWireSchema: agentNativeV3DecisionWireSchema, decisionJsonSchema: agentNativeV3DecisionJsonSchema,
  schemas: { request: CreateAgentNativeV3Schema, pinned: AgentNativeV3PinnedInputSchema, turn: AgentNativeV3TurnInputSchema, decision: AgentNativeV3DecisionSchema,
    readRequest: AgentNativeV3ReadRequestSchema, selection: AgentNativeV3SelectionSchema, result: AgentNativeV3ResultSchema, progress: NativeV3ReadProgressSchema,
    workspace: AgentNativeV3WorkspaceSchema, view: AgentNativeV3ViewSchema, receipt: AgentNativeV3ReceiptSchema, receiptQuery: AgentNativeV3ReceiptQuerySchema,
    stop: StopAgentNativeV3Schema, prepare: PrepareAgentNativeV3ItemSchema, itemReceipt: AgentNativeV3ItemReceiptSchema },
  maximumLimits: maximumAgentNativeV3Limits, checkDomains: agentNativeV3CheckDomains, readKeys: agentNativeV3ReadKeys, slots: agentNativeSlots,
  async workspace(context, ports) {
    const legacy = await ports.tools.workspace(context), resource = await resources(ports).workspace(context), fulfilled = await fulfillment(ports).workspace(context);
    if (legacy.contextAuthority !== fulfilled.contextAuthority || legacy.contextAuthority !== resource.contextAuthority || legacy.contextAuthority !== erpSessionAuthority(erpPermissionContext(context))) throw new AgentNativeError("agent_access_changed");
    return { contextAuthority: legacy.contextAuthority, executionContract: agentNativeV3Harness.pin(agentNativeV3ReadSkill), legacy, resources: resource, fulfillment: fulfilled,
      tools: [...legacy.tools, ...resource.tools, { key: "orders.fulfillment", available: fulfilled.definition.available }] };
  },
  pinReads(workspace) {
    if (!workspace.resources || !workspace.fulfillment) throw new AgentNativeError("agent_resources_unavailable");
    return { readExecutionContract: workspace.executionContract, legacyReadExecutionContract: workspace.legacy.executionContract, resourceExecutionContract: workspace.resources.executionContract, fulfillmentExecutionContract: workspace.fulfillment.executionContract };
  },
  assertReadContract(raw) {
    const input = AgentNativeV3PinnedInputSchema.parse(raw); agentNativeV3Harness.assertCurrent(input.readExecutionContract, agentNativeV3ReadSkill);
    agentToolsHarness.assertCurrent(input.legacyReadExecutionContract, agentToolsSkill); agentResourcesHarness.assertCurrent(input.resourceExecutionContract, agentResourcesSkill);
    agentFulfillmentHarness.assertCurrent(input.fulfillmentExecutionContract, agentFulfillmentSkill);
  },
  viewFields: input => ({ readContracts: input ? { legacy: input.legacyReadExecutionContract, resources: input.resourceExecutionContract, fulfillment: input.fulfillmentExecutionContract } : null }),
  workspaceFields: workspace => ({ toolWorkspace: workspace.legacy, resourceWorkspace: workspace.resources, fulfillmentWorkspace: workspace.fulfillment }),
  readPageState(binding, result) {
    if (binding.tool === "orders.fulfillment") {
      if (result && result.version !== AGENT_FULFILLMENT_VERSION) throw new AgentNativeError("agent_native_evidence_invalid");
      return { paged: true, maxPageSize: 10, hasMore: !!result && result.version === AGENT_FULFILLMENT_VERSION && result.data.coverage.hasMore,
        cursor: result?.version === AGENT_FULFILLMENT_VERSION ? result.data.coverage.nextCursor : null };
    }
    return { paged: binding.tool === "orders.exceptions.page" || binding.tool === "inventory.balances.page", maxPageSize: 100,
      hasMore: !!result && "coverage" in result && result.coverage.kind === "paged_collection" && !result.coverage.complete,
      cursor: result && "coverage" in result && result.coverage.kind === "paged_collection" ? result.coverage.nextCursor : null };
  },
  turnFields(raw) { const input = AgentNativeV3PinnedInputSchema.parse(raw); return { readContracts: {
    legacy: input.legacyReadExecutionContract, resources: input.resourceExecutionContract, fulfillment: input.fulfillmentExecutionContract } }; },
  selectionOf: agentNativeV3DefinitionSelection,
  isPartialObservation: observation => observation.collectionComplete === false || observation.indexComplete === false,
  async definition(context, selection, ports) {
    if (selection.kind === "read" && selection.tool === "orders.fulfillment") return fulfillment(ports).definition(context, { version: AGENT_FULFILLMENT_VERSION, tool: selection.tool });
    return selection.kind === "read" && AgentResourceKeySchema.safeParse(selection.tool).success
      ? resources(ports).definition(context, { version: AGENT_RESOURCES_VERSION, tool: AgentResourceKeySchema.parse(selection.tool) })
      : ports.tools.definition(context, { version: AGENT_TOOLS_VERSION, selection: AgentToolSelectionSchema.parse(selection) });
  },
  validateDefinition: validateNativeV3Definition, readCall: nativeV3ReadCall,
  async call(context, call, ports) {
    if (call.version === AGENT_FULFILLMENT_VERSION) return AgentFulfillmentResultSchema.parse(await fulfillment(ports).call(context, AgentFulfillmentCallSchema.parse(call)));
    return call.version === AGENT_RESOURCES_VERSION ? AgentResourceResultSchema.parse(await resources(ports).call(context, AgentResourceCallSchema.parse(call)))
      : AgentToolResultSchema.parse(await ports.tools.call(context, AgentToolCallSchema.parse(call)));
  },
  verifyReadResult: verifyNativeV3ReadResult, observationRows: agentNativeV3ObservationRows, buildObservation: buildNativeV3Observation,
  evidenceChain: nativeV3EvidenceChain, verifyClaims: verifyNativeV3Claims, resolveResult: resolveAgentNativeV3Result,
  recheck: (input, definitions, observations, ports, take) => recheckNativeV3Evidence(input, definitions, observations, ports, take, agentNativeV3Protocol),
  scopeAvailable: (context,input,evidence,ports) => scopeV3Bindings(context,input,evidence,ports,false),
  async beforeModelSubmit(context,input,evidence,ports,take) {
    if (!await scopeV3Bindings(context,input,evidence,ports,true)) throw new AgentNativeError("agent_access_changed");
    const observed = evidence.observations.filter(value => value.tool === "orders.fulfillment");
    if (observed.length) {
      if (!take) throw new AgentNativeError("agent_fulfillment_recheck_unavailable");
      const definitions = evidence.definitions.filter(value => { const selection = agentNativeV3DefinitionSelection(value.definition); return selection.kind === "read" && selection.tool === "orders.fulfillment"; });
      await recheckNativeV3Evidence(input, definitions, observed, ports, take, agentNativeV3Protocol);
    }
  },
};
async function scopeV3Bindings(context: Parameters<NativeProtocol<NativeV3Family>["scopeAvailable"]>[0], input: Parameters<NativeProtocol<NativeV3Family>["scopeAvailable"]>[1], evidence: Parameters<NativeProtocol<NativeV3Family>["scopeAvailable"]>[2], ports: NativePorts, observedOnly: boolean): Promise<boolean> {
    const pinned = AgentNativeV3PinnedInputSchema.parse(input);
    const observed = new Set(evidence.observations.map(value => value.request.bindingIndex));
    // GET checks current access and keeps the old sealed values. In particular,
    // a normal order revision is not a permission revocation or history rewrite.
    try {
      const legacyBindings = pinned.request.bindings.flatMap((binding, bindingIndex) => AgentResourceKeySchema.safeParse(binding.tool).success || binding.tool === "orders.fulfillment" || observedOnly && !observed.has(bindingIndex) ? [] : [{ binding, bindingIndex }]);
      for (const [bindingIndex, binding] of pinned.request.bindings.entries()) {
        if (observedOnly && !observed.has(bindingIndex)) continue;
        switch (binding.tool) {
          case "orders.fulfillment": {
            const relevant = evidence.observations.filter(value => value.request.bindingIndex === bindingIndex).flatMap(value => value.results).filter(value => value.version === AGENT_FULFILLMENT_VERSION);
            const privateFactory = relevant.some(value => value.data.kind === "production" && value.data.rows.some(row => row.factory.state === "read"));
            await fulfillment(ports).assertBindingAccess(context, binding.scope, privateFactory);
            for (const value of relevant) await fulfillment(ports).assertResultAccess(context, value);
            break;
          }
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
        if (!checksum) { const selected = { kind: "read" as const, tool: binding.tool }; const definition = validateNativeV3Definition(input, await agentNativeV3Protocol.definition(context, selected, ports), selected);
          checksum = definition.definitionChecksum; definitions.set(binding.tool, checksum); }
        const observation = evidence.observations.find(value => value.request.bindingIndex === bindingIndex), factory = observation?.results.find(value => value.tool === "factory.capacity");
        const call = nativeV3ReadCall(input, { bindingIndex, keyword: binding.tool === "knowledge.search" ? observation?.request.keyword ?? "范围权限核对" : null }, checksum,
          { pageSize: 1, cursor: null, ...(factory?.tool === "factory.capacity" ? { factoryFrom: factory.data.from } : {}) });
        await agentNativeV3Protocol.call(context, call, ports);
      }
      return true;
    } catch { return false; }
}
