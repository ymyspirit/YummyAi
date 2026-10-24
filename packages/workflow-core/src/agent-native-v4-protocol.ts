import {
  AGENT_COMMAND_V2_DEFINITION_VERSION, AgentCommandV2DefinitionRequestSchema,
} from "@yummyai/contracts/ai/agent-command-v2-discovery";
import { AGENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-command";
import { AGENT_FULFILLMENT_COMMAND_VERSION } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { AGENT_FULFILLMENT_VERSION, AgentFulfillmentCallSchema, AgentFulfillmentResultSchema } from "@yummyai/contracts/ai/agent-fulfillment";
import {
  AGENT_NATIVE_V4_VERSION, AGENT_NATIVE_V4_MAX_STEPS, AgentNativeV4PinnedInputSchema,
  AgentNativeV4TurnInputSchema, AgentNativeV4DecisionSchema, CreateAgentNativeV4Schema,
  AgentNativeV4SelectionSchema, AgentNativeV4ReadRequestSchema, AgentNativeV4ResultSchema,
  AgentNativeV4WorkspaceSchema, AgentNativeV4ViewSchema, AgentNativeV4ReceiptSchema,
  AgentNativeV4ReceiptQuerySchema, StopAgentNativeV4Schema, PrepareAgentNativeV4ItemSchema,
  AgentNativeV4ItemReceiptSchema, AgentNativeV4ItemReceiptQuerySchema,
  maximumAgentNativeV4Limits, agentNativeV4DefinitionSelection,
} from "@yummyai/contracts/ai/agent-native-v4";
import { agentNativeV3ObservationRows } from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_RESOURCES_VERSION, AgentResourceCallSchema, AgentResourceKeySchema, AgentResourceResultSchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, AgentToolResultSchema, AgentToolSelectionSchema } from "@yummyai/contracts/ai/agent-tools";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { erpPermissionContext } from "@yummyai/authz";
import { AgentNativeError, agentNativeSlots } from "./agent-native-model.js";
import { agentFulfillmentHarness, agentFulfillmentSkill } from "./agent-fulfillment-gateway.js";
import { agentToolsHarness, agentToolsSkill } from "./agent-tools-gateway.js";
import { agentResourcesHarness, agentResourcesSkill } from "./agent-resources-gateway.js";
import {
  AGENT_NATIVE_V4_MODEL_TOOL, agentNativeV4Harness, agentNativeV4Skill, agentNativeV4ReadSkill,
  agentNativeV4CheckDomains, agentNativeV4ReadKeys, agentNativeV4DecisionWireSchema,
  agentNativeV4DecisionJsonSchema, resolveAgentNativeV4Result,
} from "./agent-native-v4-model.js";
import {
  NativeV4ReadProgressSchema, nativeV4EvidenceChain, nativeV4ReadCall, verifyNativeV4ReadResult,
  validateNativeV4Definition, buildNativeV4Observation, verifyNativeV4Claims, validateNativeV4Completion,
  recheckNativeV4Evidence,
} from "./agent-native-v4-evidence.js";
import type { NativePorts, NativeProtocol, NativeV4Family } from "./agent-native-protocol.js";

const fulfillment = (ports: NativePorts) => { if (!ports.fulfillment) throw new AgentNativeError("agent_fulfillment_unavailable"); return ports.fulfillment; };
const resources = (ports: NativePorts) => { if (!ports.resources) throw new AgentNativeError("agent_resources_unavailable"); return ports.resources; };
const commands = (ports: NativePorts) => { if (!ports.commandDefinitions) throw new AgentNativeError("agent_command_v2_unavailable"); return ports.commandDefinitions; };

export const agentNativeV4Protocol: NativeProtocol<NativeV4Family> = {
  version: AGENT_NATIVE_V4_VERSION, maxSteps: AGENT_NATIVE_V4_MAX_STEPS, maxHistoryCalls: AGENT_NATIVE_V4_MAX_STEPS,
  outputSchemaName: "erp_agent_native_decision_v4", modelTool: AGENT_NATIVE_V4_MODEL_TOOL,
  harness: agentNativeV4Harness, skill: agentNativeV4Skill,
  decisionWireSchema: agentNativeV4DecisionWireSchema, decisionJsonSchema: agentNativeV4DecisionJsonSchema,
  schemas: { request: CreateAgentNativeV4Schema, pinned: AgentNativeV4PinnedInputSchema, turn: AgentNativeV4TurnInputSchema,
    decision: AgentNativeV4DecisionSchema, readRequest: AgentNativeV4ReadRequestSchema, selection: AgentNativeV4SelectionSchema,
    result: AgentNativeV4ResultSchema, progress: NativeV4ReadProgressSchema, workspace: AgentNativeV4WorkspaceSchema,
    view: AgentNativeV4ViewSchema, receipt: AgentNativeV4ReceiptSchema, receiptQuery: AgentNativeV4ReceiptQuerySchema,
    stop: StopAgentNativeV4Schema, prepare: PrepareAgentNativeV4ItemSchema, itemReceiptQuery: AgentNativeV4ItemReceiptQuerySchema,
    itemReceipt: AgentNativeV4ItemReceiptSchema },
  maximumLimits: maximumAgentNativeV4Limits, checkDomains: agentNativeV4CheckDomains, readKeys: agentNativeV4ReadKeys, slots: agentNativeSlots,
  itemBirthFields: proposal => proposal.draft.capability.domain === "fulfillment"
    ? { originalProtocol: AGENT_FULFILLMENT_COMMAND_VERSION, originalOrderId: proposal.draft.fulfillment?.source.orderId ?? null }
    : { originalProtocol: AGENT_COMMAND_VERSION, originalOrderId: null },
  async workspace(context, ports) {
    const legacy = await ports.tools.workspace(context), resource = await resources(ports).workspace(context), fulfilled = await fulfillment(ports).workspace(context),
      commandWorkspace = await commands(ports).workspace(context);
    const authority = erpSessionAuthority(erpPermissionContext(context));
    if ([legacy.contextAuthority, resource.contextAuthority, fulfilled.contextAuthority, commandWorkspace.contextAuthority].some(value => value !== authority))
      throw new AgentNativeError("agent_access_changed");
    return { contextAuthority: authority, executionContract: agentNativeV4Harness.pin(agentNativeV4ReadSkill), legacy,
      resources: resource, fulfillment: fulfilled, commandWorkspace,
      tools: [...legacy.tools, ...resource.tools, { key: "orders.fulfillment", available: fulfilled.definition.available }] };
  },
  pinReads(workspace) {
    if (!workspace.resources || !workspace.fulfillment || !workspace.commandWorkspace) throw new AgentNativeError("agent_resources_unavailable");
    return { readExecutionContract: workspace.executionContract, legacyReadExecutionContract: workspace.legacy.executionContract,
      resourceExecutionContract: workspace.resources.executionContract, fulfillmentExecutionContract: workspace.fulfillment.executionContract };
  },
  assertReadContract(raw) {
    const input = AgentNativeV4PinnedInputSchema.parse(raw);
    agentNativeV4Harness.assertCurrent(input.readExecutionContract, agentNativeV4ReadSkill);
    agentToolsHarness.assertCurrent(input.legacyReadExecutionContract, agentToolsSkill);
    agentResourcesHarness.assertCurrent(input.resourceExecutionContract, agentResourcesSkill);
    agentFulfillmentHarness.assertCurrent(input.fulfillmentExecutionContract, agentFulfillmentSkill);
  },
  viewFields: input => ({ readContracts: input ? { legacy: input.legacyReadExecutionContract,
    resources: input.resourceExecutionContract, fulfillment: input.fulfillmentExecutionContract } : null }),
  workspaceFields: workspace => ({ toolWorkspace: workspace.legacy, resourceWorkspace: workspace.resources,
    fulfillmentWorkspace: workspace.fulfillment, commandWorkspace: workspace.commandWorkspace }),
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
  turnFields(raw) { const input = AgentNativeV4PinnedInputSchema.parse(raw); return { readContracts: {
    legacy: input.legacyReadExecutionContract, resources: input.resourceExecutionContract, fulfillment: input.fulfillmentExecutionContract } }; },
  selectionOf: agentNativeV4DefinitionSelection,
  isPartialObservation: observation => observation.collectionComplete === false || observation.indexComplete === false,
  async definition(context, selection, ports) {
    if (selection.kind === "command") return commands(ports).definition(context, AgentCommandV2DefinitionRequestSchema.parse({
      version: AGENT_COMMAND_V2_DEFINITION_VERSION, selection,
    }));
    if (selection.tool === "orders.fulfillment") return fulfillment(ports).definition(context, { version: AGENT_FULFILLMENT_VERSION, tool: selection.tool });
    return AgentResourceKeySchema.safeParse(selection.tool).success
      ? resources(ports).definition(context, { version: AGENT_RESOURCES_VERSION, tool: AgentResourceKeySchema.parse(selection.tool) })
      : ports.tools.definition(context, { version: AGENT_TOOLS_VERSION, selection: AgentToolSelectionSchema.parse(selection) });
  },
  validateDefinition: validateNativeV4Definition, readCall: nativeV4ReadCall,
  async call(context, call, ports) {
    if (call.version === AGENT_FULFILLMENT_VERSION) return AgentFulfillmentResultSchema.parse(await fulfillment(ports).call(context, AgentFulfillmentCallSchema.parse(call)));
    return call.version === AGENT_RESOURCES_VERSION ? AgentResourceResultSchema.parse(await resources(ports).call(context, AgentResourceCallSchema.parse(call)))
      : AgentToolResultSchema.parse(await ports.tools.call(context, AgentToolCallSchema.parse(call)));
  },
  verifyReadResult: verifyNativeV4ReadResult, observationRows: agentNativeV3ObservationRows, buildObservation: buildNativeV4Observation,
  evidenceChain: nativeV4EvidenceChain, verifyClaims: verifyNativeV4Claims, validateCompletion: validateNativeV4Completion,
  resolveResult: resolveAgentNativeV4Result,
  recheck: (input, definitions, observations, ports, take) => recheckNativeV4Evidence(input, definitions, observations, ports, take, agentNativeV4Protocol),
  scopeAvailable: (context, input, evidence, ports) => scopeV4Bindings(context, input, evidence, ports, false),
  async beforeModelSubmit(context, input, evidence, ports, take) {
    if (!await scopeV4Bindings(context, input, evidence, ports, true)) throw new AgentNativeError("agent_access_changed");
    const observations = evidence.observations.filter(value => value.tool === "orders.fulfillment");
    if (observations.length) {
      if (!take) throw new AgentNativeError("agent_fulfillment_recheck_unavailable");
      const definitions = evidence.definitions.filter(value => { const selected = agentNativeV4DefinitionSelection(value.definition); return selected.kind === "read" && selected.tool === "orders.fulfillment"; });
      await recheckNativeV4Evidence(input, definitions, observations, ports, take, agentNativeV4Protocol);
    }
  },
};

async function scopeV4Bindings(context: Parameters<NativeProtocol<NativeV4Family>["scopeAvailable"]>[0], input: Parameters<NativeProtocol<NativeV4Family>["scopeAvailable"]>[1],
  evidence: Parameters<NativeProtocol<NativeV4Family>["scopeAvailable"]>[2], ports: NativePorts, observedOnly: boolean): Promise<boolean> {
  const pinned = AgentNativeV4PinnedInputSchema.parse(input), observed = new Set(evidence.observations.map(value => value.request.bindingIndex));
  try {
    for (const [bindingIndex, binding] of pinned.request.bindings.entries()) {
      if (observedOnly && !observed.has(bindingIndex)) continue;
      switch (binding.tool) {
        case "orders.fulfillment": {
          const relevant = evidence.observations.filter(value => value.request.bindingIndex === bindingIndex).flatMap(value => value.results)
            .filter(value => value.version === AGENT_FULFILLMENT_VERSION);
          const privateFactory = relevant.some(value => value.data.kind === "production" && value.data.rows.some(row => row.factory.state === "read"));
          await fulfillment(ports).assertBindingAccess(context, binding.scope, privateFactory);
          for (const value of relevant) await fulfillment(ports).assertResultAccess(context, value);
          break;
        }
        case "research.evidence": await resources(ports).assertBindingAccess(context, { tool: binding.tool, input: binding.scope }); break;
        case "catalog.sku": await resources(ports).assertBindingAccess(context, { tool: binding.tool, input: binding.scope }); break;
        case "listing.version": await resources(ports).assertBindingAccess(context, { tool: binding.tool, input: binding.scope }); break;
        case "orders.order": await resources(ports).assertBindingAccess(context, { tool: binding.tool, input: binding.scope }); break;
        case "finance.profit_run": await resources(ports).assertBindingAccess(context, { tool: binding.tool, input: binding.scope }); break;
        case "advertising.analysis": await resources(ports).assertBindingAccess(context, { tool: binding.tool, input: binding.scope }); break;
        default: {
          const selection = { kind: "read" as const, tool: binding.tool }, definition = validateNativeV4Definition(input,
            await agentNativeV4Protocol.definition(context, selection, ports), selection);
          const observation = evidence.observations.find(value => value.request.bindingIndex === bindingIndex), factory = observation?.results.find(value => value.tool === "factory.capacity");
          const call = nativeV4ReadCall(input, { bindingIndex, keyword: binding.tool === "knowledge.search" ? observation?.request.keyword ?? "范围权限核对" : null },
            definition.definitionChecksum, { pageSize: 1, cursor: null, ...(factory?.tool === "factory.capacity" ? { factoryFrom: factory.data.from } : {}) });
          await agentNativeV4Protocol.call(context, call, ports);
        }
      }
    }
    return true;
  } catch { return false; }
}
