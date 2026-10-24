import {
  AgentNativeV2ViewSchema, agentNativeV2DefinitionSelection, agentNativeV2ObservationBasisPayload,
  agentNativeV2ProposalChecksumPayload, agentNativeV2ClaimValue, agentNativeV2ObservationRows,
  type AgentNativeV2View, type AgentNativeV2Observation,
} from "@yummyai/contracts/ai/agent-native-v2";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, agentToolInputSchemas } from "@yummyai/contracts/ai/agent-tools";
import { AGENT_RESOURCES_VERSION, AgentResourceCallSchema } from "@yummyai/contracts/ai/agent-resources";
import {
  agentTransportChecksum, agentTransportTextHash, AgentTransportIntegrityError,
  verifyAgentToolTransport, verifyAgentToolDefinitionTransport,
} from "@yummyai/contracts/ai/agent-transport";
import { verifyAgentResourceDefinition, verifyAgentResourceResult } from "@yummyai/contracts/ai/agent-resource-transport";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

function invalid(): never { throw new AgentTransportIntegrityError("native_v2_evidence"); }
/** Strict original-envelope verification shared by browser, BFF and MCP.
 * It establishes source/value integrity, not commercial correctness or approval. */
export async function verifyAgentNativeV2Transport(raw: AgentNativeV2View): Promise<void> {
  const value = AgentNativeV2ViewSchema.parse(raw);
  if (new Set(value.steps.map(row => row.id)).size !== value.steps.length || value.steps.some((step, index) => step.sequence !== index + 1) ||
    new Set(value.items.map(row => row.id)).size !== value.items.length || new Set(value.items.map(row => row.position)).size !== value.items.length ||
    new Set(value.definitions.map(row => row.stepId)).size !== value.definitions.length || new Set(value.observations.map(row => row.stepId)).size !== value.observations.length) invalid();
  if (!value.privateAvailable) return;
  const readContracts = value.readContracts;
  if (!readContracts || value.cost.modelTurns !== value.steps.filter(row => row.kind === "model").length) invalid();
  const definitions = new Set<string>();
  for (const evidence of value.definitions) {
    const definition = evidence.definition, selection = agentNativeV2DefinitionSelection(definition), key = canonicalJson(selection);
    const step = value.steps.find(row => row.id === evidence.stepId);
    if (definitions.has(key) || !step || step.kind !== "definition" || step.phase !== "completed" || !definition.available ||
      step.tool !== (selection.kind === "read" ? selection.tool : null) ||
      (selection.kind === "read" ? !value.bindings.some(binding => binding.tool === selection.tool) :
        !value.allowedCommands.some(command => command.domain === selection.command.domain && command.kind === selection.command.kind))) invalid();
    definitions.add(key);
    if (definition.version === AGENT_RESOURCES_VERSION) await verifyAgentResourceDefinition(definition, definition.tool);
    else await verifyAgentToolDefinitionTransport(definition, definition.selection);
  }
  let observedRows = 0, minimumCalls = value.definitions.length;
  for (const observation of value.observations) {
    const binding = value.bindings[observation.request.bindingIndex], step = value.steps.find(row => row.id === observation.stepId);
    if (!binding || binding.tool !== observation.tool || !step || step.kind !== "read" || step.phase !== "completed" || step.tool !== observation.tool ||
      (binding.tool === "knowledge.search" ? observation.request.keyword === null : observation.request.keyword !== null)) invalid();
    for (const result of observation.results) {
      const definition = value.definitions.find(row => {
        const selection = agentNativeV2DefinitionSelection(row.definition);
        return selection.kind === "read" && selection.tool === result.tool && row.definition.definitionChecksum === result.definitionChecksum;
      });
      if (!definition || value.steps.find(row => row.id === definition.stepId)!.sequence >= step.sequence || result.tool !== binding.tool) invalid();
      if (result.version === AGENT_RESOURCES_VERSION) {
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
    if (await agentTransportChecksum(agentNativeV2ObservationBasisPayload(observation)) !== observation.basisChecksum ||
      observation.observedRows !== observation.results.reduce((sum, result) => sum + agentNativeV2ObservationRows(result), 0)) invalid();
    if (observation.tool === "orders.exceptions.page" || observation.tool === "inventory.balances.page") verifyPageChain(observation);
    observedRows += observation.observedRows; minimumCalls += observation.results.length;
  }
  if (value.observedRows < observedRows || value.toolCalls < minimumCalls) invalid();
  if (value.result) {
    for (const claim of value.result.claims) {
      const observation = value.observations.find(row => row.stepId === claim.stepId);
      try { if (!observation || agentNativeV2ClaimValue(observation, claim) !== claim.value) invalid(); } catch { invalid(); }
    }
    for (const proposal of value.result.proposals) {
      const selected = value.definitions.find(row => {
        const selection = agentNativeV2DefinitionSelection(row.definition);
        return selection.kind === "command" && selection.command.domain === proposal.draft.capability.domain && selection.command.kind === proposal.draft.capability.kind;
      });
      if (!selected || !value.allowedCommands.some(command => command.domain === proposal.draft.capability.domain && command.kind === proposal.draft.capability.kind) ||
        await agentTransportChecksum(agentNativeV2ProposalChecksumPayload(proposal, value.result.claims)) !== proposal.proposalChecksum) invalid();
      const original = proposal.draft.original;
      if (original && (await agentTransportTextHash(canonicalAgentCommandOriginal(original)) !== proposal.originalChecksum ||
        await agentTransportTextHash(canonicalAgentCommandRequest("prepare", { version: AGENT_COMMAND_VERSION, requestId: proposal.id, original })) !== proposal.preparationRequestChecksum)) invalid();
    }
  }
}
function verifyPageChain(observation: AgentNativeV2Observation) {
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
  if (last.coverage.kind !== "paged_collection" || last.coverage.complete !== observation.collectionComplete || readCount !== observation.observedRows) invalid();
}
