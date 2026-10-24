import { AGENT_FULFILLMENT_VERSION, AgentFulfillmentCallSchema } from "@yummyai/contracts/ai/agent-fulfillment";
import { verifyAgentFulfillmentDefinition, verifyAgentFulfillmentResult } from "@yummyai/contracts/ai/agent-fulfillment-transport";
import {
  AgentNativeV3ViewSchema, agentNativeV3DefinitionSelection, agentNativeV3ObservationBasisPayload,
  agentNativeV3ProposalChecksumPayload, agentNativeV3ClaimValue, agentNativeV3ObservationRows,
  type AgentNativeV3View, type AgentNativeV3Observation,
} from "@yummyai/contracts/ai/agent-native-v3";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, agentToolInputSchemas } from "@yummyai/contracts/ai/agent-tools";
import { AGENT_RESOURCES_VERSION, AgentResourceCallSchema } from "@yummyai/contracts/ai/agent-resources";
import {
  agentTransportChecksum, agentTransportTextHash, AgentTransportIntegrityError,
  verifyAgentToolTransport, verifyAgentToolDefinitionTransport,
} from "@yummyai/contracts/ai/agent-transport";
import { verifyAgentResourceDefinition, verifyAgentResourceResult } from "@yummyai/contracts/ai/agent-resource-transport";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

function invalid(): never { throw new AgentTransportIntegrityError("native_v3_evidence"); }
/** Strict original-envelope verification shared by browser, BFF and MCP.
 * It establishes source/value integrity, not commercial correctness or approval. */
export async function verifyAgentNativeV3Transport(raw: AgentNativeV3View): Promise<void> {
  const value = AgentNativeV3ViewSchema.parse(raw);
  if (new Set(value.steps.map(row => row.id)).size !== value.steps.length || value.steps.some((step, index) => step.sequence !== index + 1) ||
    new Set(value.items.map(row => row.id)).size !== value.items.length || new Set(value.items.map(row => row.position)).size !== value.items.length ||
    new Set(value.definitions.map(row => row.stepId)).size !== value.definitions.length || new Set(value.observations.map(row => row.stepId)).size !== value.observations.length) invalid();
  if (!value.privateAvailable) return;
  const readContracts = value.readContracts;
  if (!readContracts || value.cost.modelTurns !== value.steps.filter(row => row.kind === "model").length) invalid();
  const definitions = new Set<string>();
  for (const evidence of value.definitions) {
    const definition = evidence.definition, selection = agentNativeV3DefinitionSelection(definition), key = canonicalJson(selection);
    const step = value.steps.find(row => row.id === evidence.stepId);
    if (definitions.has(key) || !step || step.kind !== "definition" || step.phase !== "completed" || !definition.available ||
      step.tool !== (selection.kind === "read" ? selection.tool : null) ||
      (selection.kind === "read" ? !value.bindings.some(binding => binding.tool === selection.tool) :
        !value.allowedCommands.some(command => command.domain === selection.command.domain && command.kind === selection.command.kind))) invalid();
    definitions.add(key);
    if (definition.version === AGENT_RESOURCES_VERSION) await verifyAgentResourceDefinition(definition, definition.tool);
    else if (definition.version === AGENT_FULFILLMENT_VERSION) await verifyAgentFulfillmentDefinition(definition);
    else await verifyAgentToolDefinitionTransport(definition, definition.selection);
  }
  let observedRows = 0, minimumCalls = value.definitions.length;
  for (const observation of value.observations) {
    const binding = value.bindings[observation.request.bindingIndex], step = value.steps.find(row => row.id === observation.stepId);
    if (!binding || binding.tool !== observation.tool || !step || step.kind !== "read" || step.phase !== "completed" || step.tool !== observation.tool ||
      (binding.tool === "knowledge.search" ? observation.request.keyword === null : observation.request.keyword !== null)) invalid();
    for (const result of observation.results) {
      const definition = value.definitions.find(row => {
        const selection = agentNativeV3DefinitionSelection(row.definition);
        return selection.kind === "read" && selection.tool === result.tool && row.definition.definitionChecksum === result.definitionChecksum;
      });
      if (!definition || value.steps.find(row => row.id === definition.stepId)!.sequence >= step.sequence || result.tool !== binding.tool) invalid();
      if (result.version === AGENT_FULFILLMENT_VERSION) {
        if (binding.tool !== "orders.fulfillment") invalid();
        const call = AgentFulfillmentCallSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: binding.tool, executionContract: readContracts.fulfillment,
          definitionChecksum: result.definitionChecksum, input: { ...binding.scope, pageSize: result.input.pageSize, cursor: result.input.cursor } });
        await verifyAgentFulfillmentResult(result, call);
      } else if (result.version === AGENT_RESOURCES_VERSION) {
        const call = AgentResourceCallSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: result.tool, input: binding.scope,
          executionContract: readContracts.resources, definitionChecksum: result.definitionChecksum });
        await verifyAgentResourceResult(result, call);
      } else {
        let input: unknown;
        if (binding.tool === "orders.exceptions.page" && result.tool === binding.tool || binding.tool === "inventory.balances.page" && result.tool === binding.tool) {
          const { pageSize, cursor, ...scope } = result.data.query;
          if (canonicalJson(scope) !== canonicalJson(binding.scope)) invalid();
          input = { ...binding.scope, pageSize, cursor };
        } else if (binding.tool === "knowledge.search") input = { ...binding.scope, query: observation.request.keyword };
        else input = binding.scope;
        const call = AgentToolCallSchema.parse({ version: AGENT_TOOLS_VERSION, tool: result.tool,
          input: agentToolInputSchemas[result.tool].parse(input), executionContract: readContracts.legacy, definitionChecksum: result.definitionChecksum });
        await verifyAgentToolTransport(result, call);
      }
    }
    if (await agentTransportChecksum(agentNativeV3ObservationBasisPayload(observation)) !== observation.basisChecksum ||
      observation.observedRows !== observation.results.reduce((sum, result) => sum + agentNativeV3ObservationRows(result), 0)) invalid();
    if (observation.tool === "orders.exceptions.page" || observation.tool === "inventory.balances.page") verifyPageChain(observation);
    if (observation.tool === "orders.fulfillment") verifyFulfillmentPageChain(observation);
    observedRows += observation.observedRows; minimumCalls += observation.results.length;
  }
  if (value.observedRows < observedRows || value.toolCalls < minimumCalls) invalid();
  if (value.result) {
    for (const claim of value.result.claims) {
      const observation = value.observations.find(row => row.stepId === claim.stepId);
      try { if (!observation || agentNativeV3ClaimValue(observation, claim) !== claim.value) invalid(); } catch { invalid(); }
    }
    for (const proposal of value.result.proposals) {
      const selected = value.definitions.find(row => {
        const selection = agentNativeV3DefinitionSelection(row.definition);
        return selection.kind === "command" && selection.command.domain === proposal.draft.capability.domain && selection.command.kind === proposal.draft.capability.kind;
      });
      if (!selected || !value.allowedCommands.some(command => command.domain === proposal.draft.capability.domain && command.kind === proposal.draft.capability.kind) ||
        await agentTransportChecksum(agentNativeV3ProposalChecksumPayload(proposal, value.result.claims)) !== proposal.proposalChecksum) invalid();
      const original = proposal.draft.original;
      if (original && (await agentTransportTextHash(canonicalAgentCommandOriginal(original)) !== proposal.originalChecksum ||
        await agentTransportTextHash(canonicalAgentCommandRequest("prepare", { version: AGENT_COMMAND_VERSION, requestId: proposal.id, original })) !== proposal.preparationRequestChecksum)) invalid();
    }
  }
}
function verifyPageChain(observation: AgentNativeV3Observation) {
  let cursor: string | null = null, readCount = 0, fingerprint: string | null = null, total: number | null = null;
  const ids = new Set<string>();
  for (const result of observation.results) {
    if (result.tool !== "orders.exceptions.page" && result.tool !== "inventory.balances.page") invalid();
    const data = result.data;
    if (data.query.cursor !== cursor || data.readCount !== readCount + data.items.length || fingerprint !== null && fingerprint !== data.collectionFingerprint ||
      total !== null && total !== data.total || data.items.some(item => ids.has(item.id)) || new Set(data.items.map(item => item.id)).size !== data.items.length) invalid();
    for (const item of data.items) ids.add(item.id);
    readCount = data.readCount; fingerprint = data.collectionFingerprint; total = data.total; cursor = data.nextCursor;
  }
  const last = observation.results.at(-1)!;
  if (!("coverage" in last) || last.coverage.kind !== "paged_collection" || last.coverage.complete !== observation.collectionComplete || readCount !== observation.observedRows) invalid();
}

function verifyFulfillmentPageChain(observation: AgentNativeV3Observation) {
  let cursor: string | null = null, collection: string | null = null, total: number | null = null, pageSize: number | null = null, count = 0;
  let authority: string | null = null, definition: string | null = null;
  const ids = new Set<string>(), cursors = new Set<string>(), calls = new Set<string>();
  for (const [index, result] of observation.results.entries()) {
    if (result.version !== AGENT_FULFILLMENT_VERSION || calls.has(result.callId) || result.input.cursor !== cursor ||
      authority !== null && authority !== result.contextAuthority || definition !== null && definition !== result.definitionChecksum ||
      collection !== null && collection !== result.data.coverage.collectionChecksum || total !== null && total !== result.data.coverage.indexedTotal ||
      pageSize !== null && pageSize !== result.input.pageSize || index > 0 && cursor === null || result.data.rows.some(row => ids.has(row.id)) ||
      result.data.coverage.hasMore && result.data.rows.length !== result.input.pageSize) invalid();
    calls.add(result.callId); for (const row of result.data.rows) ids.add(row.id);
    authority = result.contextAuthority; definition = result.definitionChecksum;
    count += result.data.rows.length; total = result.data.coverage.indexedTotal; collection = result.data.coverage.collectionChecksum; pageSize = result.input.pageSize;
    cursor = result.data.coverage.nextCursor;
    if (cursor !== null && cursors.has(cursor)) invalid(); if (cursor !== null) cursors.add(cursor);
    if (count > total || (cursor === null) !== (count === total)) invalid();
  }
  if (observation.collectionComplete !== null || observation.indexComplete !== (cursor === null) || observation.indexComplete !== (observation.truncatedBy === null) || count !== observation.observedRows) invalid();
}
