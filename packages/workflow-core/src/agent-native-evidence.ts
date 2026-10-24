import { decodeModelResponse, ModelResponseCheckpointSchema } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import {
  AgentNativeDecisionSchema, AgentNativeDefinitionEvidenceSchema, AgentNativeObservationSchema,
  AgentNativeReadRequestSchema, AgentNativeTurnInputSchema, agentNativeClaimValue,
  agentNativeObservationBasisPayload, agentNativeSourceBasis,
  type AgentNativeDefinitionEvidence, type AgentNativeObservation, type AgentNativePinnedInput,
  type AgentNativeReadRequest, type AgentNativeResult, type AgentNativeTurnInput,
} from "@yummyai/contracts/ai/agent-native";
import { agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import {
  AGENT_TOOLS_VERSION, AgentToolCallSchema, AgentToolDefinitionSchema, AgentToolResultSchema,
  AgentToolSelectionSchema, agentToolDefinitionPayload,
  type AgentToolCall, type AgentToolDefinition, type AgentToolResult, type AgentToolSelection,
} from "@yummyai/contracts/ai/agent-tools";
import { z } from "zod";
import { AgentNativeError, agentNativeChecksum, type AgentNativeToolsPort } from "./agent-native-model.js";

type FixedBindings = Pick<AgentNativePinnedInput["request"], "bindings">;
type ReadScope = { request: FixedBindings };
export type NativeEvidenceOpen = <T>(encrypted: string | null, checksum: string | null, schema: z.ZodType<T>) => T;
export type NativeEvidenceStep = {
  id: string; runId: string; sequence: number; kind: "model" | "read" | "definition"; phase: string;
  tool: string | null; inputChecksum: string; previousChecksum: string; outputChecksum: string | null;
  encryptedInput: string | null; encryptedOutput: string | null;
  encryptedResponse: string | null; responseChecksum: string | null; submissionState: string;
};
export const NativeReadProgressSchema = z.object({ results: z.array(AgentToolResultSchema).max(32) }).strict();

function invalid(): never { throw new AgentNativeError("agent_native_evidence_invalid"); }
const paged = (tool: string) => tool === "orders.exceptions.page" || tool === "inventory.balances.page";
const selectionKey = (selection: AgentToolSelection) => selection.kind === "read"
  ? `read:${selection.tool}` : `command:${agentPlanCommandKey(selection.command)}`;

function bindingFor(input: ReadScope, request: AgentNativeReadRequest) {
  const binding = input.request.bindings[request.bindingIndex];
  if (!binding || (binding.tool === "knowledge.search" ? request.keyword === null : request.keyword !== null)) invalid();
  return binding;
}

function nativeInput(input: ReadScope, request: AgentNativeReadRequest, options: {
  pageSize?: number; cursor?: string | null; factoryFrom?: string;
}) {
  const binding = bindingFor(input, request);
  switch (binding.tool) {
    case "orders.exceptions.page":
    case "inventory.balances.page":
      return { ...binding.scope, pageSize: options.pageSize ?? 100, cursor: options.cursor ?? null };
    case "knowledge.search": return { ...binding.scope, query: request.keyword! };
    case "creative.history": return { ...binding.scope };
    case "factory.capacity": return { ...binding.scope, query: {
      ...binding.scope.query, ...(options.factoryFrom ? { from: options.factoryFrom } : {}),
    } };
  }
}

/** Models choose only a fixed binding and, for knowledge alone, a keyword. */
export function nativeReadCall(input: AgentNativePinnedInput, request: AgentNativeReadRequest,
  definitionChecksum: string, options: { pageSize?: number; cursor?: string | null; factoryFrom?: string } = {}): AgentToolCall {
  return AgentToolCallSchema.parse({ version: AGENT_TOOLS_VERSION, executionContract: input.readExecutionContract,
    tool: bindingFor(input, request).tool, definitionChecksum, input: nativeInput(input, request, options) });
}

export function nativeObservationRows(result: AgentToolResult): number {
  switch (result.tool) {
    case "orders.exceptions.page":
    case "inventory.balances.page": return result.data.items.length;
    case "knowledge.search": return result.data.references.length;
    case "creative.history": return result.data.entries.length;
    case "factory.capacity": return result.data.pools.length + result.data.calendar.length;
  }
}

export function validateNativeDefinition(input: { request: Pick<AgentNativePinnedInput["request"], "bindings" | "allowedCommands"> },
  raw: AgentToolDefinition, selection?: AgentToolSelection): AgentToolDefinition {
  const value = AgentToolDefinitionSchema.parse(raw);
  const selected = value.selection;
  const allowed = selected.kind === "read"
    ? input.request.bindings.some(binding => binding.tool === selected.tool)
    : input.request.allowedCommands.some(command => agentPlanCommandKey(command) === agentPlanCommandKey(selected.command));
  if (!allowed || !value.available || value.definitionChecksum !== agentNativeChecksum(agentToolDefinitionPayload(value))
    || selection && selectionKey(value.selection) !== selectionKey(selection))
    throw new AgentNativeError("agent_tool_definition_changed");
  return value;
}

/** Check every original envelope before it becomes a saved observation. */
export function buildNativeObservation(value: {
  stepId: string; input: ReadScope; request: AgentNativeReadRequest; results: readonly AgentToolResult[];
  truncatedBy: "row_limit" | "tool_limit" | null;
}): AgentNativeObservation {
  const request = AgentNativeReadRequestSchema.parse(value.request), binding = bindingFor(value.input, request);
  const results = value.results.map(result => AgentToolResultSchema.parse(result));
  if (!results.length || results.length > 32 || !paged(binding.tool) && (results.length !== 1 || value.truncatedBy !== null)) invalid();
  const calls = new Set<string>(), ids = new Set<string>(), cursors = new Set<string>();
  let rows = 0;
  for (const [index, result] of results.entries()) {
    const first = results[0]!;
    if (result.tool !== binding.tool || result.definitionChecksum !== first.definitionChecksum
      || result.contextAuthority !== first.contextAuthority || result.dataChecksum !== agentNativeChecksum(result.data)
      || calls.has(result.callId)) invalid();
    calls.add(result.callId);
    if (result.tool === "orders.exceptions.page" || result.tool === "inventory.balances.page") {
      const page = result.data, previous = results[index - 1];
      if (first.tool !== result.tool || first.coverage.kind !== "paged_collection"
        || result.coverage.kind !== "paged_collection" || page.collectionFingerprint !== first.data.collectionFingerprint
        || page.total !== first.data.total || page.contextAuthority !== result.contextAuthority
        || page.query.cursor !== (index === 0 ? null : previous?.coverage.kind === "paged_collection" ? previous.coverage.nextCursor : undefined)
        || index > 0 && previous?.coverage.kind === "paged_collection" && previous.coverage.complete) invalid();
      const expected = nativeInput(value.input, request, { pageSize: page.query.pageSize, cursor: page.query.cursor });
      if (result.inputChecksum !== agentNativeChecksum(expected) || agentNativeChecksum(expected) !== agentNativeChecksum(page.query)) invalid();
      for (const row of page.items) { if (ids.has(row.id)) invalid(); ids.add(row.id); }
      rows += page.items.length;
      if (page.readCount !== rows || rows > page.total || page.items.length > page.query.pageSize
        || !page.complete && !page.items.length || page.complete !== (rows === page.total)
        || page.complete !== (page.nextCursor === null) || page.nextCursor !== null && cursors.has(page.nextCursor)) invalid();
      if (page.nextCursor !== null) cursors.add(page.nextCursor);
    } else {
      const expected = nativeInput(value.input, request, {});
      if (result.inputChecksum !== agentNativeChecksum(expected)) invalid();
      if (result.tool === "creative.history" && (binding.tool !== result.tool || result.data.scope !== binding.scope.scope
        || result.data.ownerId.toLowerCase() !== binding.scope.ownerId.toLowerCase())) invalid();
      if (result.tool === "factory.capacity" && (binding.tool !== result.tool
        || result.data.factoryId.toLowerCase() !== binding.scope.factoryId.toLowerCase()
        || result.data.days !== binding.scope.query.days || binding.scope.query.from && result.data.from !== binding.scope.query.from)) invalid();
      rows += nativeObservationRows(result);
    }
  }
  const last = results.at(-1)!;
  const complete = paged(binding.tool) ? last.coverage.kind === "paged_collection" ? last.coverage.complete : invalid() : null;
  if (complete !== null && complete !== (value.truncatedBy === null)) invalid();
  const observation = { stepId: value.stepId, tool: binding.tool, request, results, observedRows: rows,
    collectionComplete: complete, truncatedBy: value.truncatedBy };
  return AgentNativeObservationSchema.parse({ ...observation,
    basisChecksum: agentNativeChecksum(agentNativeObservationBasisPayload(observation)) });
}

export function verifyNativeClaims(result: Pick<AgentNativeResult, "claims" | "proposals">,
  observations: readonly AgentNativeObservation[]): void {
  for (const observation of observations) {
    if (observation.basisChecksum !== agentNativeChecksum(agentNativeObservationBasisPayload(observation))
      || observation.results.some(value => value.dataChecksum !== agentNativeChecksum(value.data))) invalid();
  }
  for (const claim of result.claims) {
    const observation = observations.find(value => value.stepId === claim.stepId);
    try {
      if (!observation || agentNativeClaimValue(observation, claim) !== claim.value) throw new Error("invalid");
    } catch { throw new AgentNativeError("agent_native_claim_invalid"); }
  }
  for (const proposal of result.proposals) if (new Set(proposal.claimIndexes).size !== proposal.claimIndexes.length
    || proposal.claimIndexes.some(index => !result.claims[index])) throw new AgentNativeError("agent_native_claim_invalid");
}

/** Authenticated checkpoints retain the model/action chain and exact native envelopes. */
export function nativeEvidenceChain(rows: readonly NativeEvidenceStep[], inputChecksum: string, open: NativeEvidenceOpen): {
  definitions: AgentNativeDefinitionEvidence[]; observations: AgentNativeObservation[];
} {
  if (rows.length > 32) invalid();
  let previous = inputChecksum, unfinished = false, turn = 0;
  let packet: AgentNativeTurnInput | undefined;
  let decision: z.infer<typeof AgentNativeDecisionSchema> | undefined;
  const definitions: AgentNativeDefinitionEvidence[] = [], observations: AgentNativeObservation[] = [];
  const selections = new Set<string>(), requests = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.sequence !== index + 1 || row.previousChecksum !== previous || unfinished
      || (index % 2 === 0 ? row.kind !== "model" : row.kind === "model")) invalid();
    if (row.kind === "model") {
      const next = open(row.encryptedInput, row.inputChecksum, AgentNativeTurnInputSchema);
      if (next.runId !== row.runId || next.turn !== ++turn || next.turn > 16
        || agentNativeChecksum(next.definitions) !== agentNativeChecksum(definitions)
        || agentNativeChecksum(next.observations) !== agentNativeChecksum(observations)) invalid();
      if (packet) {
        const fixed = (value: AgentNativeTurnInput) => ({ ...value, turn: 0, definitions: [], observations: [] });
        if (agentNativeChecksum(fixed(next)) !== agentNativeChecksum(fixed(packet))) invalid();
      }
      packet = next;
      if (row.tool !== null) invalid();
    } else {
      if (!packet || !decision || decision.action !== row.kind) invalid();
      if (row.kind === "definition") {
        const selection = open(row.encryptedInput, row.inputChecksum, AgentToolSelectionSchema);
        if (agentNativeChecksum(selection) !== agentNativeChecksum(decision.definition) || selections.has(selectionKey(selection))
          || row.tool !== (selection.kind === "read" ? selection.tool : null)) invalid();
        selections.add(selectionKey(selection));
      } else {
        const request = open(row.encryptedInput, row.inputChecksum, AgentNativeReadRequestSchema);
        if (agentNativeChecksum(request) !== agentNativeChecksum(decision.read) || requests.has(row.inputChecksum)
          || row.tool !== bindingFor({ request: packet }, request).tool) invalid();
        requests.add(row.inputChecksum);
      }
    }
    if (row.phase !== "completed") { unfinished = true; continue; }
    if (!row.outputChecksum) invalid();
    previous = row.outputChecksum;
    if (row.kind === "model") {
      decision = open(row.encryptedOutput, row.outputChecksum, AgentNativeDecisionSchema);
      const response = open(row.encryptedResponse, row.responseChecksum, ModelResponseCheckpointSchema);
      if (row.submissionState !== "received"
        || agentNativeChecksum(decodeModelResponse(response, AgentNativeDecisionSchema).value) !== row.outputChecksum) invalid();
      if (decision.action === "finish" && index !== rows.length - 1) invalid();
    } else if (row.kind === "definition") {
      const evidence = open(row.encryptedOutput, row.outputChecksum, AgentNativeDefinitionEvidenceSchema);
      if (evidence.stepId !== row.id) invalid();
      validateNativeDefinition({ request: packet! }, evidence.definition, decision!.definition!);
      definitions.push(evidence);
    } else {
      const observation = open(row.encryptedOutput, row.outputChecksum, AgentNativeObservationSchema);
      if (observation.stepId !== row.id || agentNativeChecksum(observation.request) !== row.inputChecksum) invalid();
      const definition = definitions.find(value => value.definition.selection.kind === "read" && value.definition.selection.tool === row.tool);
      if (!definition || observation.results.some(value => value.definitionChecksum !== definition.definition.definitionChecksum)) invalid();
      const rebuilt = buildNativeObservation({ ...observation, input: { request: packet! } });
      if (agentNativeChecksum(rebuilt) !== row.outputChecksum) invalid();
      observations.push(observation);
    }
  }
  return { definitions, observations };
}

/** The caller owns call accounting and its final adoption transaction. */
export async function recheckNativeEvidence(input: AgentNativePinnedInput,
  definitions: readonly AgentNativeDefinitionEvidence[], observations: readonly AgentNativeObservation[],
  tools: AgentNativeToolsPort, takeCall: () => Promise<TenantContext>): Promise<void> {
  for (const saved of definitions) {
    const current = await tools.definition(await takeCall(), { version: AGENT_TOOLS_VERSION, selection: saved.definition.selection });
    validateNativeDefinition(input, current, saved.definition.selection);
    if (current.definitionChecksum !== saved.definition.definitionChecksum) throw new AgentNativeError("agent_tool_definition_changed");
  }
  for (const observation of observations) {
    const definition = definitions.find(value => value.definition.selection.kind === "read" && value.definition.selection.tool === observation.tool);
    if (!definition) invalid();
    const first = observation.results[0]!;
    const call = nativeReadCall(input, observation.request, definition.definition.definitionChecksum, {
      pageSize: 1, cursor: null, ...(first.tool === "factory.capacity" ? { factoryFrom: first.data.from } : {}),
    });
    const result = AgentToolResultSchema.parse(await tools.call(await takeCall(), call));
    if (result.tool !== call.tool || result.definitionChecksum !== call.definitionChecksum
      || result.inputChecksum !== agentNativeChecksum(call.input) || result.dataChecksum !== agentNativeChecksum(result.data)) invalid();
    if (result.tool === "orders.exceptions.page" || result.tool === "inventory.balances.page") {
      if (first.tool !== result.tool || result.data.collectionFingerprint !== first.data.collectionFingerprint
        || result.data.total !== first.data.total) throw new AgentNativeError("agent_collection_changed");
    } else if (agentNativeChecksum(agentNativeSourceBasis(result)) !== agentNativeChecksum(agentNativeSourceBasis(first))) {
      throw new AgentNativeError("agent_native_source_changed");
    }
  }
}
