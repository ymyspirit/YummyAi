import { AGENT_FULFILLMENT_VERSION, AgentFulfillmentCallSchema, AgentFulfillmentResultSchema, AgentFulfillmentDefinitionSchema, agentFulfillmentDefinitionPayload, agentFulfillmentDataPayload, canonicalAgentFulfillmentCall } from "@yummyai/contracts/ai/agent-fulfillment";
import { assertAgentFulfillmentObject } from "@yummyai/contracts/ai/agent-fulfillment-transport";
import { decodeModelResponse, ModelResponseCheckpointSchema } from "@yummyai/ai-core";
import { AgentToolCallSchema, AgentToolDefinitionSchema, AgentToolResultSchema, agentToolDefinitionPayload, AGENT_TOOLS_VERSION } from "@yummyai/contracts/ai/agent-tools";
import { AGENT_RESOURCES_VERSION, AgentResourceCallSchema, AgentResourceDefinitionSchema, AgentResourceResultSchema,
  agentResourceDataPayload, agentResourceDefinitionPayload, canonicalAgentResourceInput } from "@yummyai/contracts/ai/agent-resources";
import { assertAgentResourceObject } from "@yummyai/contracts/ai/agent-resource-transport";
import { agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import {
  AgentNativeV3DecisionSchema, AgentNativeV3PinnedInputSchema, AgentNativeV3ReadRequestSchema, AgentNativeV3SelectionSchema,
  AgentNativeV3TurnInputSchema, AgentNativeV3DefinitionEvidenceSchema, AgentNativeV3ObservationSchema,
  agentNativeV3ClaimValue, agentNativeV3DefinitionSelection, agentNativeV3ObservationBasisPayload, agentNativeV3ObservationRows,
  agentNativeV3SourceBasis, type AgentNativeV3Selection, type AgentNativeV3ReadRequest, type AgentNativeV3DefinitionEvidence,
  type AgentNativeV3Observation, type AgentNativeV3Result, type AgentNativeV3TurnInput,
} from "@yummyai/contracts/ai/agent-native-v3";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AgentNativeError, agentNativeChecksum } from "./agent-native-model.js";
import { agentResourcesHarness, agentResourcesSkill } from "./agent-resources-gateway.js";
import type { NativeCall, NativePinned, NativeReadResult, NativePorts, NativeProtocol, NativeEvidence, NativeV3Family } from "./agent-native-protocol.js";
import type { NativeEvidenceOpen, NativeEvidenceStep } from "./agent-native-evidence.js";
import type { TenantContext } from "@yummyai/contracts";

function invalid(): never { throw new AgentNativeError("agent_native_evidence_invalid"); }
const paged = (tool: string) => tool === "orders.exceptions.page" || tool === "inventory.balances.page" || tool === "orders.fulfillment";
const selectionKey = (selection: AgentNativeV3Selection) => selection.kind === "read" ? `read:${selection.tool}` : `command:${agentPlanCommandKey(selection.command)}`;
type ReadScope = { request: Pick<NativePinned<NativeV3Family>["request"], "bindings"> };
export const NativeV3ReadProgressSchema = z.object({ results: z.array(z.union([AgentToolResultSchema, AgentResourceResultSchema, AgentFulfillmentResultSchema])).max(128) }).strict();
function bindingFor(input: ReadScope, request: AgentNativeV3ReadRequest) {
  const binding = input.request.bindings[request.bindingIndex];
  if (!binding || (binding.tool === "knowledge.search" ? request.keyword === null : request.keyword !== null)) invalid();
  return binding;
}
function nativeInput(input: ReadScope, request: AgentNativeV3ReadRequest, options: { pageSize?: number; cursor?: string | null; factoryFrom?: string }) {
  const binding = bindingFor(input, request);
  switch (binding.tool) {
    case "orders.fulfillment": return { ...binding.scope, pageSize: Math.min(10, options.pageSize ?? 10), cursor: options.cursor ?? null };
    case "orders.exceptions.page": case "inventory.balances.page": return { ...binding.scope, pageSize: options.pageSize ?? 100, cursor: options.cursor ?? null };
    case "knowledge.search": return { ...binding.scope, query: request.keyword! };
    case "factory.capacity": return { ...binding.scope, query: { ...binding.scope.query, ...(options.factoryFrom ? { from: options.factoryFrom } : {}) } };
    default: return { ...binding.scope };
  }
}
export const nativeV3ReadCall: NativeProtocol<NativeV3Family>["readCall"] = (raw, request, checksum, options = {}) => {
  const input = AgentNativeV3PinnedInputSchema.parse(raw), binding = bindingFor(input, request), data = nativeInput(input, request, options);
  if (binding.tool === "orders.fulfillment") return AgentFulfillmentCallSchema.parse({ version: AGENT_FULFILLMENT_VERSION, executionContract: input.fulfillmentExecutionContract,
    tool: binding.tool, definitionChecksum: checksum, input: data });
  return ["orders.exceptions.page", "inventory.balances.page", "knowledge.search", "creative.history", "factory.capacity"].includes(binding.tool)
    ? AgentToolCallSchema.parse({ version: AGENT_TOOLS_VERSION, executionContract: input.legacyReadExecutionContract, tool: binding.tool, definitionChecksum: checksum, input: data })
    : AgentResourceCallSchema.parse({ version: AGENT_RESOURCES_VERSION, executionContract: input.resourceExecutionContract, tool: binding.tool, definitionChecksum: checksum, input: data });
};
export function verifyNativeV3ReadResult(result: NativeReadResult<NativeV3Family>, call: NativeCall): void {
  if (result.version !== call.version || result.tool !== call.tool || result.definitionChecksum !== call.definitionChecksum) invalid();
  if (result.version === AGENT_FULFILLMENT_VERSION) {
    const request = AgentFulfillmentCallSchema.parse(call); assertAgentFulfillmentObject(result, request);
    if (result.inputChecksum !== createHash("sha256").update(canonicalAgentFulfillmentCall(request)).digest("hex") || result.dataChecksum !== agentNativeChecksum(agentFulfillmentDataPayload(result))) invalid();
  } else if (result.version === AGENT_RESOURCES_VERSION) {
    const resource = AgentResourceCallSchema.parse(call); assertAgentResourceObject(result, resource);
    if (result.inputChecksum !== createHash("sha256").update(canonicalAgentResourceInput(resource)).digest("hex") || result.dataChecksum !== agentNativeChecksum(agentResourceDataPayload(result))) invalid();
  } else if (result.inputChecksum !== agentNativeChecksum(call.input) || result.dataChecksum !== agentNativeChecksum(result.data)) invalid();
}
export const validateNativeV3Definition: NativeProtocol<NativeV3Family>["validateDefinition"] = (input, raw, selection) => {
  const old = AgentToolDefinitionSchema.safeParse(raw), resource = AgentResourceDefinitionSchema.safeParse(raw), value = old.success ? old.data : resource.success ? resource.data : AgentFulfillmentDefinitionSchema.parse(raw);
  const selected = agentNativeV3DefinitionSelection(value), checksum = agentNativeChecksum("selection" in value ? agentToolDefinitionPayload(value) : value.version === AGENT_FULFILLMENT_VERSION ? agentFulfillmentDefinitionPayload(value) : agentResourceDefinitionPayload(value));
  const allowed = selected.kind === "read" ? input.request.bindings.some(binding => binding.tool === selected.tool)
    : input.request.allowedCommands.some(command => agentPlanCommandKey(command) === agentPlanCommandKey(selected.command));
  if (!allowed || !value.available || value.definitionChecksum !== checksum || selection && selectionKey(selection) !== selectionKey(selected))
    throw new AgentNativeError("agent_tool_definition_changed");
  return value;
};
export const buildNativeV3Observation: NativeProtocol<NativeV3Family>["buildObservation"] = value => {
  const request = AgentNativeV3ReadRequestSchema.parse(value.request), binding = bindingFor(value.input, request);
  const results = value.results.map(result => z.union([AgentToolResultSchema, AgentResourceResultSchema, AgentFulfillmentResultSchema]).parse(result));
  if (!results.length || results.length > 128 || !paged(binding.tool) && (results.length !== 1 || value.truncatedBy !== null)) invalid();
  const calls = new Set<string>(), ids = new Set<string>(), cursors = new Set<string>(); let rows = 0;
  for (const [index, result] of results.entries()) {
    const first = results[0]!;
    if (result.tool !== binding.tool || result.definitionChecksum !== first.definitionChecksum || result.contextAuthority !== first.contextAuthority || calls.has(result.callId)) invalid();
    calls.add(result.callId);
    if (result.version === AGENT_FULFILLMENT_VERSION) {
      if (binding.tool !== "orders.fulfillment" || first.version !== AGENT_FULFILLMENT_VERSION) invalid();
      const expected = { ...binding.scope, pageSize: result.input.pageSize, cursor: result.input.cursor };
      const call = AgentFulfillmentCallSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: binding.tool, executionContract: value.input.fulfillmentExecutionContract,
        definitionChecksum: result.definitionChecksum, input: expected });
      verifyNativeV3ReadResult(result, call);
      const previous = results[index - 1];
      if (result.input.cursor !== (index === 0 ? null : previous?.version === AGENT_FULFILLMENT_VERSION ? previous.data.coverage.nextCursor : undefined) ||
        result.input.pageSize !== first.input.pageSize || result.data.coverage.collectionChecksum !== first.data.coverage.collectionChecksum ||
        result.data.coverage.indexedTotal !== first.data.coverage.indexedTotal || index > 0 && previous?.version === AGENT_FULFILLMENT_VERSION && !previous.data.coverage.hasMore ||
        result.data.coverage.hasMore && result.data.rows.length !== result.input.pageSize) invalid();
      for (const row of result.data.rows) { if (ids.has(row.id)) invalid(); ids.add(row.id); } rows += result.data.rows.length;
      const cursor = result.data.coverage.nextCursor;
      if (rows > result.data.coverage.indexedTotal || (cursor === null) !== (rows === result.data.coverage.indexedTotal) || cursor !== null && cursors.has(cursor)) invalid();
      if (cursor !== null) cursors.add(cursor); continue;
    }
    if (result.version === AGENT_RESOURCES_VERSION) {
      const call = AgentResourceCallSchema.parse({ version: AGENT_RESOURCES_VERSION, executionContract: {
        // Only reconstructs the strict structural call for object verification.
        // This function never executes it. Live dispatch uses the saved pin.
        ...agentResourcesHarness.pin(agentResourcesSkill),
      }, tool: binding.tool, definitionChecksum: result.definitionChecksum, input: nativeInput(value.input, request, {}) });
      verifyNativeV3ReadResult(result, call); rows++; continue;
    }
    if (result.dataChecksum !== agentNativeChecksum(result.data)) invalid();
    if (result.tool === "orders.exceptions.page" || result.tool === "inventory.balances.page") {
      const page = result.data, previous = results[index - 1];
      if (first.tool !== result.tool || first.version !== AGENT_TOOLS_VERSION || first.coverage.kind !== "paged_collection" || result.coverage.kind !== "paged_collection"
        || page.collectionFingerprint !== first.data.collectionFingerprint || page.total !== first.data.total || page.contextAuthority !== result.contextAuthority
        || page.query.cursor !== (index === 0 ? null : previous && "coverage" in previous && previous.coverage.kind === "paged_collection" ? previous.coverage.nextCursor : undefined)
        || index > 0 && previous && "coverage" in previous && previous.coverage.kind === "paged_collection" && previous.coverage.complete) invalid();
      const expected = nativeInput(value.input, request, { pageSize: page.query.pageSize, cursor: page.query.cursor });
      if (result.inputChecksum !== agentNativeChecksum(expected) || agentNativeChecksum(expected) !== agentNativeChecksum(page.query)) invalid();
      for (const row of page.items) { if (ids.has(row.id)) invalid(); ids.add(row.id); } rows += page.items.length;
      if (page.readCount !== rows || rows > page.total || page.items.length > page.query.pageSize || !page.complete && !page.items.length
        || page.complete !== (rows === page.total) || page.complete !== (page.nextCursor === null) || page.nextCursor !== null && cursors.has(page.nextCursor)) invalid();
      if (page.nextCursor !== null) cursors.add(page.nextCursor);
    } else {
      if (result.inputChecksum !== agentNativeChecksum(nativeInput(value.input, request, {}))) invalid();
      if (result.tool === "creative.history" && (binding.tool !== result.tool || result.data.scope !== binding.scope.scope || result.data.ownerId.toLowerCase() !== binding.scope.ownerId.toLowerCase())) invalid();
      if (result.tool === "factory.capacity" && (binding.tool !== result.tool || result.data.factoryId.toLowerCase() !== binding.scope.factoryId.toLowerCase()
        || result.data.days !== binding.scope.query.days || binding.scope.query.from && result.data.from !== binding.scope.query.from)) invalid();
      rows += agentNativeV3ObservationRows(result);
    }
  }
  const last = results.at(-1)!, fulfillment = binding.tool === "orders.fulfillment";
  const complete = paged(binding.tool) && !fulfillment ? "coverage" in last && last.coverage.kind === "paged_collection" ? last.coverage.complete : invalid() : null;
  const indexComplete = fulfillment ? last.version === AGENT_FULFILLMENT_VERSION ? !last.data.coverage.hasMore : invalid() : null;
  if (complete !== null && complete !== (value.truncatedBy === null)) invalid();
  const observation = { stepId: value.stepId, tool: binding.tool, request, results, observedRows: rows, collectionComplete: complete, indexComplete, truncatedBy: value.truncatedBy };
  return AgentNativeV3ObservationSchema.parse({ ...observation, basisChecksum: agentNativeChecksum(agentNativeV3ObservationBasisPayload(observation)) });
};

export function verifyNativeV3Claims(result: Pick<AgentNativeV3Result, "claims" | "proposals">, observations: readonly AgentNativeV3Observation[]) {
  for (const observation of observations) if (observation.basisChecksum !== agentNativeChecksum(agentNativeV3ObservationBasisPayload(observation)) || observation.results.some(value =>
    value.dataChecksum !== agentNativeChecksum(value.version === AGENT_RESOURCES_VERSION ? agentResourceDataPayload(value) : value.version === AGENT_FULFILLMENT_VERSION ? agentFulfillmentDataPayload(value) : value.data))) invalid();
  for (const claim of result.claims) { const observation = observations.find(value => value.stepId === claim.stepId);
    try { if (!observation || agentNativeV3ClaimValue(observation, claim) !== claim.value) invalid(); } catch { throw new AgentNativeError("agent_native_claim_invalid"); } }
  for (const proposal of result.proposals) if (new Set(proposal.claimIndexes).size !== proposal.claimIndexes.length || proposal.claimIndexes.some(index => !result.claims[index]))
    throw new AgentNativeError("agent_native_claim_invalid");
}

export function nativeV3EvidenceChain(rows: readonly NativeEvidenceStep[], inputChecksum: string, open: NativeEvidenceOpen): NativeEvidence<NativeV3Family> {
  if (rows.length > 96) invalid();
  let previous = inputChecksum, unfinished = false, turn = 0, packet: AgentNativeV3TurnInput | undefined;
  let decision: z.infer<typeof AgentNativeV3DecisionSchema> | undefined;
  const definitions: AgentNativeV3DefinitionEvidence[] = [], observations: AgentNativeV3Observation[] = [], selections = new Set<string>(), requests = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.sequence !== index + 1 || row.previousChecksum !== previous || unfinished || (index % 2 === 0 ? row.kind !== "model" : row.kind === "model")) invalid();
    if (row.kind === "model") {
      const next = open(row.encryptedInput, row.inputChecksum, AgentNativeV3TurnInputSchema);
      if (next.runId !== row.runId || next.turn !== ++turn || next.turn > 48 || agentNativeChecksum(next.definitions) !== agentNativeChecksum(definitions)
        || agentNativeChecksum(next.observations) !== agentNativeChecksum(observations)) invalid();
      if (packet) { const fixed = (value: AgentNativeV3TurnInput) => ({ ...value, turn: 0, definitions: [], observations: [] }); if (agentNativeChecksum(fixed(next)) !== agentNativeChecksum(fixed(packet))) invalid(); }
      packet = next; if (row.tool !== null) invalid();
    } else {
      if (!packet || !decision || decision.action !== row.kind) invalid();
      if (row.kind === "definition") {
        const selection = open(row.encryptedInput, row.inputChecksum, AgentNativeV3SelectionSchema);
        if (agentNativeChecksum(selection) !== agentNativeChecksum(decision.definition) || selections.has(selectionKey(selection)) || row.tool !== (selection.kind === "read" ? selection.tool : null)) invalid();
        selections.add(selectionKey(selection));
      } else {
        const request = open(row.encryptedInput, row.inputChecksum, AgentNativeV3ReadRequestSchema);
        if (agentNativeChecksum(request) !== agentNativeChecksum(decision.read) || requests.has(row.inputChecksum) || row.tool !== bindingFor({ request: packet }, request).tool) invalid();
        requests.add(row.inputChecksum);
      }
    }
    if (row.phase !== "completed") { unfinished = true; continue; }
    if (!row.outputChecksum) invalid(); previous = row.outputChecksum;
    if (row.kind === "model") {
      decision = open(row.encryptedOutput, row.outputChecksum, AgentNativeV3DecisionSchema);
      const response = open(row.encryptedResponse, row.responseChecksum, ModelResponseCheckpointSchema);
      if (row.submissionState !== "received" || agentNativeChecksum(decodeModelResponse(response, AgentNativeV3DecisionSchema).value) !== row.outputChecksum) invalid();
      if (decision.action === "finish" && index !== rows.length - 1) invalid();
    } else if (row.kind === "definition") {
      const evidence = open(row.encryptedOutput, row.outputChecksum, AgentNativeV3DefinitionEvidenceSchema);
      if (evidence.stepId !== row.id) invalid(); validateNativeV3Definition({ request: packet! }, evidence.definition, decision!.definition!); definitions.push(evidence);
    } else {
      const observation = open(row.encryptedOutput, row.outputChecksum, AgentNativeV3ObservationSchema);
      if (observation.stepId !== row.id || agentNativeChecksum(observation.request) !== row.inputChecksum) invalid();
      const definition = definitions.find(value => { const selection = agentNativeV3DefinitionSelection(value.definition); return selection.kind === "read" && selection.tool === row.tool; });
      if (!definition || observation.results.some(value => value.definitionChecksum !== definition.definition.definitionChecksum)) invalid();
      if (agentNativeChecksum(buildNativeV3Observation({ ...observation, input: { request: packet!, fulfillmentExecutionContract: packet!.readContracts.fulfillment } })) !== row.outputChecksum) invalid(); observations.push(observation);
    }
  }
  return { definitions, observations };
}
export async function recheckNativeV3Evidence(input: NativePinned<NativeV3Family>, definitions: readonly AgentNativeV3DefinitionEvidence[], observations: readonly AgentNativeV3Observation[],
  ports: NativePorts, take: () => Promise<TenantContext>, protocol: Pick<NativeProtocol<NativeV3Family>, "definition" | "call">) {
  for (const saved of definitions) {
    const selection = agentNativeV3DefinitionSelection(saved.definition), current = await protocol.definition(await take(), selection, ports);
    validateNativeV3Definition(input, current, selection);
    if (current.definitionChecksum !== saved.definition.definitionChecksum) throw new AgentNativeError("agent_tool_definition_changed");
  }
  for (const observation of observations) {
    const definition = definitions.find(value => { const selection = agentNativeV3DefinitionSelection(value.definition); return selection.kind === "read" && selection.tool === observation.tool; });
    if (!definition) invalid(); const first = observation.results[0]!;
    if (observation.tool === "orders.fulfillment") {
      for (const saved of observation.results) {
        if (saved.version !== AGENT_FULFILLMENT_VERSION) invalid();
        const call = nativeV3ReadCall(input, observation.request, definition.definition.definitionChecksum, { pageSize: saved.input.pageSize, cursor: saved.input.cursor });
        const fresh = await protocol.call(await take(), call, ports); verifyNativeV3ReadResult(fresh, call);
        if (agentNativeChecksum(agentNativeV3SourceBasis(fresh)) !== agentNativeChecksum(agentNativeV3SourceBasis(saved))) throw new AgentNativeError("agent_native_source_changed");
      }
      continue;
    }
    const call = nativeV3ReadCall(input, observation.request, definition.definition.definitionChecksum, { pageSize: 1, cursor: null, ...(first.tool === "factory.capacity" ? { factoryFrom: first.data.from } : {}) });
    const result = await protocol.call(await take(), call, ports); verifyNativeV3ReadResult(result, call);
    if (result.tool === "orders.exceptions.page" || result.tool === "inventory.balances.page") {
      if (first.tool !== result.tool || result.data.collectionFingerprint !== first.data.collectionFingerprint || result.data.total !== first.data.total) throw new AgentNativeError("agent_collection_changed");
    } else if (agentNativeChecksum(agentNativeV3SourceBasis(result)) !== agentNativeChecksum(agentNativeV3SourceBasis(first))) throw new AgentNativeError("agent_native_source_changed");
  }
}
