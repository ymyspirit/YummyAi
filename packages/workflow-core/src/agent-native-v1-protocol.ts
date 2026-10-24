import {
  AGENT_NATIVE_VERSION, AgentNativeDecisionSchema, AgentNativePinnedInputSchema, AgentNativeReadRequestSchema,
  AgentNativeTurnInputSchema, AgentNativeDefinitionEvidenceSchema, AgentNativeObservationSchema, AgentNativeResultSchema,
  AgentNativeViewSchema, AgentNativeWorkspaceSchema, AgentNativeReceiptSchema, AgentNativeReceiptQuerySchema,
  CreateAgentNativeSchema, StopAgentNativeSchema, PrepareAgentNativeItemSchema, AgentNativeItemReceiptSchema, maximumAgentNativeLimits,
} from "@yummyai/contracts/ai/agent-native";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, AgentToolDefinitionSchema, AgentToolSelectionSchema, AgentToolKeySchema, AgentToolResultSchema } from "@yummyai/contracts/ai/agent-tools";
import { z } from "zod";
import { AgentNativeError, agentNativeChecksum, agentNativeCheckDomains, agentNativeReadKeys, agentNativeSlots,
  agentNativeHarness, agentNativeSkill, AGENT_NATIVE_MODEL_TOOL, agentNativeDecisionWireSchema, agentNativeDecisionJsonSchema, resolveAgentNativeResult,
} from "./agent-native-model.js";
import { agentToolsHarness, agentToolsSkill } from "./agent-tools-gateway.js";
import { NativeReadProgressSchema, nativeEvidenceChain, nativeReadCall, nativeObservationRows, buildNativeObservation,
  validateNativeDefinition, verifyNativeClaims, recheckNativeEvidence } from "./agent-native-evidence.js";
import type { NativeProtocol } from "./agent-native-protocol.js";

export const agentNativeV1Protocol: NativeProtocol = {
  version: AGENT_NATIVE_VERSION, maxSteps: 32, maxHistoryCalls: 32, outputSchemaName: "erp_agent_native_decision_v1",
  modelTool: AGENT_NATIVE_MODEL_TOOL, harness: agentNativeHarness, skill: agentNativeSkill,
  decisionWireSchema: agentNativeDecisionWireSchema, decisionJsonSchema: agentNativeDecisionJsonSchema,
  schemas: { request: CreateAgentNativeSchema, pinned: AgentNativePinnedInputSchema, turn: AgentNativeTurnInputSchema,
    decision: AgentNativeDecisionSchema, readRequest: AgentNativeReadRequestSchema, selection: AgentToolSelectionSchema,
    result: AgentNativeResultSchema, progress: NativeReadProgressSchema, workspace: AgentNativeWorkspaceSchema, view: AgentNativeViewSchema,
    receipt: AgentNativeReceiptSchema, receiptQuery: AgentNativeReceiptQuerySchema, stop: StopAgentNativeSchema,
    prepare: PrepareAgentNativeItemSchema, itemReceipt: AgentNativeItemReceiptSchema },
  maximumLimits: maximumAgentNativeLimits,
  checkDomains: (context, selection, requireRun) => agentNativeCheckDomains(context, {
    ...(selection.bindings ? { bindings: z.array(AgentNativePinnedInputSchema.shape.request.shape.bindings.element).parse(selection.bindings) } : {}),
    ...(selection.allowedReads ? { allowedReads: z.array(AgentToolKeySchema).parse(selection.allowedReads) } : {}), allowedCommands: selection.allowedCommands,
  }, requireRun),
  readKeys: selection => agentNativeReadKeys({ allowedCommands: [],
    ...(selection.bindings ? { bindings: z.array(AgentNativePinnedInputSchema.shape.request.shape.bindings.element).parse(selection.bindings) } : {}),
    ...(selection.allowedReads ? { allowedReads: z.array(AgentToolKeySchema).parse(selection.allowedReads) } : {}),
  }),
  slots: agentNativeSlots,
  async workspace(context, ports) { const legacy = await ports.tools.workspace(context); return { ...legacy, legacy }; },
  pinReads: workspace => ({ readExecutionContract: workspace.executionContract }),
  assertReadContract: input => agentToolsHarness.assertCurrent(input.readExecutionContract, agentToolsSkill),
  viewFields: () => ({}), workspaceFields: workspace => ({ toolWorkspace: workspace.legacy }),
  selectionOf: definition => AgentToolDefinitionSchema.parse(definition).selection,
  definition: (context, selection, ports) => ports.tools.definition(context, { version: AGENT_TOOLS_VERSION, selection: AgentToolSelectionSchema.parse(selection) }),
  validateDefinition: (input, definition, selection) => validateNativeDefinition({ request: {
    bindings: AgentNativePinnedInputSchema.shape.request.shape.bindings.parse(input.request.bindings), allowedCommands: input.request.allowedCommands,
  } }, AgentToolDefinitionSchema.parse(definition), selection ? AgentToolSelectionSchema.parse(selection) : undefined),
  readCall: (input, request, checksum, options) => nativeReadCall(AgentNativePinnedInputSchema.parse(input), request, checksum, options),
  call: (context, call, ports) => ports.tools.call(context, AgentToolCallSchema.parse(call)),
  verifyReadResult(result, call) {
    const parsed = AgentToolResultSchema.parse(result), request = AgentToolCallSchema.parse(call);
    if (parsed.tool !== request.tool || parsed.definitionChecksum !== request.definitionChecksum || parsed.inputChecksum !== agentNativeChecksum(request.input)
      || parsed.dataChecksum !== agentNativeChecksum(parsed.data)) throw new AgentNativeError("agent_native_evidence_invalid");
  },
  observationRows: result => nativeObservationRows(AgentToolResultSchema.parse(result)),
  buildObservation: value => buildNativeObservation({ ...value, input: { request: { bindings: AgentNativePinnedInputSchema.shape.request.shape.bindings.parse(value.input.request.bindings) } },
    results: value.results.map(result => AgentToolResultSchema.parse(result)) }),
  evidenceChain: nativeEvidenceChain,
  verifyClaims: (result, observations) => verifyNativeClaims(result, observations.map(value => AgentNativeObservationSchema.parse(value))),
  resolveResult: (runId, raw, allowed, limit, definitions) => resolveAgentNativeResult(runId, raw, allowed, limit, definitions.map(value => AgentNativeDefinitionEvidenceSchema.parse(value))),
  recheck: (input, definitions, observations, ports, take) => recheckNativeEvidence(AgentNativePinnedInputSchema.parse(input), definitions.map(value => AgentNativeDefinitionEvidenceSchema.parse(value)), observations.map(value => AgentNativeObservationSchema.parse(value)), ports.tools, take),
  async beforeModelSubmit() { /* The original v1 submission policy stays unchanged. */ },
  async scopeAvailable(context, raw, evidence, ports) {
    const input = AgentNativePinnedInputSchema.parse(raw); let calls = 0;
    const take = () => { if (++calls > 32) throw new AgentNativeError("agent_tool_limit"); };
    try {
      const definitions = new Map<string, string>();
      for (const [bindingIndex, binding] of input.request.bindings.entries()) {
        let checksum = definitions.get(binding.tool);
        if (!checksum) { take(); const definition = validateNativeDefinition(input, await ports.tools.definition(context,
          { version: AGENT_TOOLS_VERSION, selection: { kind: "read", tool: binding.tool } })); checksum = definition.definitionChecksum; definitions.set(binding.tool, checksum); }
        const original = evidence.observations.find(value => value.request.bindingIndex === bindingIndex);
        const request = { bindingIndex, keyword: binding.tool === "knowledge.search" ? original?.request.keyword ?? "范围权限核对" : null };
        const factory = original?.results.find(value => value.tool === "factory.capacity");
        const call = nativeReadCall(input, request, checksum, { pageSize: 1, cursor: null, ...(factory?.tool === "factory.capacity" ? { factoryFrom: factory.data.from } : {}) });
        take(); await ports.tools.call(context, call);
      }
      return true;
    } catch { return false; }
  },
};
