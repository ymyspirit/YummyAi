import { agentNativeObservationBasisPayload, agentNativeProposalChecksumPayload, agentNativeClaimValue, type AgentNativeView } from "@yummyai/contracts/ai/agent-native";
import { agentToolDefinitionPayload, agentToolInputSchemas, type AgentToolDefinition, type AgentToolSelection, type AgentToolResult, type AgentToolCall } from "@yummyai/contracts/ai/agent-tools";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";

/** Pure transport integrity shared by browser, BFF and MCP. Original digests stay unchanged. */
export class AgentTransportIntegrityError extends Error {
  constructor(readonly code: string) { super("agent_transport_" + code); }
}
export async function agentTransportTextHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export const agentTransportChecksum = (value: unknown) => agentTransportTextHash(canonicalJson(value));
const hash=agentTransportChecksum, textHash=agentTransportTextHash;
const invalid=()=>new AgentTransportIntegrityError("native_integrity");
export const agentTransportErrorMessages = {
  "definition_selection": "所选工具与返回定义不一致 未采用其他定义",
  "definition_checksum": "所选工具的完整定义校验值不一致 未采用替代定义",
  "tool_definition": "原读取结果没有绑定本次工具定义",
  "collection_scope": "原集合筛选或完整性计数无法核对",
  "creative_scope": "原执行历史没有绑定所选对象或原分页范围",
  "factory_scope": "原产能窗口没有绑定所选工厂或当地日期",
  "knowledge_coverage": "原检索候选的扫描范围无法核对",
  "input_checksum": "原读取结果没有绑定本次完整输入 未采用其他搜索或对象结果",
  "data_checksum": "原读取结果的完整校验值不一致 未采用替代结果"
} as const;

export async function verifyAgentNativeTransport(value: AgentNativeView) {
  if (new Set(value.steps.map(step => step.id)).size !== value.steps.length || value.steps.some((step, index) => index > 0 && step.sequence <= value.steps[index - 1]!.sequence) ||
    new Set(value.items.map(item => item.id)).size !== value.items.length || new Set(value.items.map(item => item.position)).size !== value.items.length ||
    new Set(value.definitions.map(item => item.stepId)).size !== value.definitions.length || new Set(value.observations.map(item => item.stepId)).size !== value.observations.length) throw invalid();
  await Promise.all(value.definitions.map(async evidence => {
    const definition = evidence.definition, selection = definition.selection;
    if (!value.steps.some(step => step.id === evidence.stepId && step.kind === "definition") ||
      (selection.kind === "read" ? !value.bindings.some(binding => binding.tool === selection.tool) : !value.allowedCommands.some(command => command.domain === selection.command.domain && command.kind === selection.command.kind)) ||
      await hash(agentToolDefinitionPayload(definition)) !== definition.definitionChecksum) throw invalid();
  }));
  await Promise.all(value.observations.map(async observation => {
    const binding = value.bindings[observation.request.bindingIndex];
    if (!binding || binding.tool !== observation.tool || !value.steps.some(step => step.id === observation.stepId && step.kind === "read" && step.tool === observation.tool)) throw invalid();
    if (binding.tool === "knowledge.search" ? observation.request.keyword === null : observation.request.keyword !== null) throw invalid();
    // Stored results retain their original authority, not today's view stamp.
    for (const result of observation.results) {
      if (!value.definitions.some(evidence => evidence.definition.selection.kind === "read" && evidence.definition.selection.tool === result.tool && evidence.definition.definitionChecksum === result.definitionChecksum) || await hash(result.data) !== result.dataChecksum) throw invalid();
      let input: unknown;
      if (binding.tool === "orders.exceptions.page" && result.tool === binding.tool || binding.tool === "inventory.balances.page" && result.tool === binding.tool) {
        const { pageSize, cursor, ...scope } = result.data.query;
        if (canonicalJson(scope) !== canonicalJson(binding.scope)) throw invalid();
        input = { ...binding.scope, pageSize, cursor };
      } else if (binding.tool === "knowledge.search") input = { ...binding.scope, query: observation.request.keyword };
      else input = binding.scope;
      const parsed = agentToolInputSchemas[result.tool].safeParse(input); if (!parsed.success || await hash(parsed.data) !== result.inputChecksum) throw invalid();
      if (binding.tool === "creative.history" && result.tool === binding.tool && (binding.scope.scope !== result.data.scope || binding.scope.ownerId.toLowerCase() !== result.data.ownerId.toLowerCase()) ||
        binding.tool === "factory.capacity" && result.tool === binding.tool && (binding.scope.factoryId.toLowerCase() !== result.data.factoryId.toLowerCase() || binding.scope.query.days !== result.data.days || binding.scope.query.from && binding.scope.query.from !== result.data.from)) throw invalid();
    }
    if (await hash(agentNativeObservationBasisPayload(observation)) !== observation.basisChecksum) throw invalid();
    if (observation.tool === "orders.exceptions.page" || observation.tool === "inventory.balances.page") {
      let cursor: string | null = null, count = 0, fingerprint: string | null = null, total: number | null = null;
      const ids = new Set<string>();
      for (const result of observation.results) {
        if (result.tool !== "orders.exceptions.page" && result.tool !== "inventory.balances.page") throw invalid();
        const data = result.data;
        if (data.query.cursor !== cursor || data.readCount !== count + data.items.length || fingerprint !== null && fingerprint !== data.collectionFingerprint || total !== null && total !== data.total || data.items.some(item => ids.has(item.id)) || new Set(data.items.map(item => item.id)).size !== data.items.length) throw invalid();
        data.items.forEach(item => ids.add(item.id)); count = data.readCount; fingerprint = data.collectionFingerprint; total = data.total; cursor = data.nextCursor;
      }
      const last = observation.results.at(-1)!;
      if (last.coverage.kind !== "paged_collection" || observation.collectionComplete !== last.coverage.complete || observation.observedRows !== count) throw invalid();
    }
  }));
  if (value.result) {
    for (const claim of value.result.claims) {
      const observation = value.observations.find(item => item.stepId === claim.stepId);
      try { if (!observation || agentNativeClaimValue(observation, claim) !== claim.value) throw invalid(); } catch { throw invalid(); }
    }
    await Promise.all(value.result.proposals.map(async proposal => {
      if (!value.allowedCommands.some(command => command.domain === proposal.draft.capability.domain && command.kind === proposal.draft.capability.kind) || await hash(agentNativeProposalChecksumPayload(proposal, value.result!.claims)) !== proposal.proposalChecksum) throw invalid();
      const original = proposal.draft.original;
      if (original && (await textHash(canonicalAgentCommandOriginal(original)) !== proposal.originalChecksum || await textHash(canonicalAgentCommandRequest("prepare", { version: AGENT_COMMAND_VERSION, requestId: proposal.id, original })) !== proposal.preparationRequestChecksum)) throw invalid();
    }));
  }
}

export function assertAgentToolTransport(value: AgentToolResult, call: AgentToolCall) {
  if (value.tool !== call.tool || value.definitionChecksum !== call.definitionChecksum)
    throw new AgentTransportIntegrityError("tool_definition");
  if ((value.tool === "orders.exceptions.page" || value.tool === "inventory.balances.page") &&
    (value.data.contextAuthority !== value.contextAuthority || canonicalJson(value.data.query) !== canonicalJson(call.input) ||
      value.coverage.kind !== "paged_collection" || value.coverage.total !== value.data.total ||
      value.coverage.readCount !== value.data.readCount || value.coverage.nextCursor !== value.data.nextCursor || value.coverage.complete !== value.data.complete))
    throw new AgentTransportIntegrityError("collection_scope");
  if (call.tool === "creative.history" && value.tool === "creative.history" &&
    (value.data.scope !== call.input.scope || value.data.ownerId.toLowerCase() !== call.input.ownerId.toLowerCase() || value.coverage.kind !== "bounded_history" ||
      value.coverage.returned !== value.data.entries.length || value.coverage.nextCursor !== value.data.nextCursor ||
      value.coverage.eventsMayBeTruncated !== value.data.entries.some(entry => entry.hasMoreEvents)))
    throw new AgentTransportIntegrityError("creative_scope");
  if (call.tool === "factory.capacity" && value.tool === "factory.capacity" &&
    (value.data.factoryId.toLowerCase() !== call.input.factoryId.toLowerCase() || value.data.contextAuthority !== value.contextAuthority ||
      call.input.query.from !== undefined && value.data.from !== call.input.query.from || value.data.days !== call.input.query.days ||
      value.coverage.kind !== "bounded_snapshot" || value.coverage.from !== value.data.from || value.coverage.days !== value.data.days || value.coverage.pools !== value.data.pools.length))
    throw new AgentTransportIntegrityError("factory_scope");
  if (value.tool === "knowledge.search" && (value.coverage.kind !== "ranked_subset" || value.coverage.scanned !== value.data.scanned || value.coverage.returned !== value.data.references.length))
    throw new AgentTransportIntegrityError("knowledge_coverage");
}

export async function verifyAgentToolTransport(value: AgentToolResult, call: AgentToolCall) {
  assertAgentToolTransport(value,call);
  if(await hash(call.input)!==value.inputChecksum)throw new AgentTransportIntegrityError("input_checksum");
  if(await hash(value.data)!==value.dataChecksum)throw new AgentTransportIntegrityError("data_checksum");
}
export async function verifyAgentToolDefinitionTransport(result: AgentToolDefinition, selection: AgentToolSelection) {
  const key=(value:AgentToolSelection)=>value.kind==="read"?"read/"+value.tool:"command/"+value.command.domain+"/"+value.command.kind;
  if(key(result.selection)!==key(selection)||result.effect!==(selection.kind==="read"?"read":"prepare_original_command")||
    result.execution!==(selection.kind==="read"?"registered_native_reader":"separate_original_preparation_and_confirmation"))throw new AgentTransportIntegrityError("definition_selection");
  if(await hash(agentToolDefinitionPayload(result))!==result.definitionChecksum)throw new AgentTransportIntegrityError("definition_checksum");
}
