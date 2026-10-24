import { decodeModelResponse, ModelResponseCheckpointSchema } from "@yummyai/ai-core";
import type { TenantContext } from "@yummyai/contracts";
import {
  AGENT_COMMAND_V2_DEFINITION_VERSION, agentCommandV2DefinitionPayload, agentCommandV2Key,
} from "@yummyai/contracts/ai/agent-command-v2-discovery";
import {
  AGENT_FULFILLMENT_VERSION, AgentFulfillmentCallSchema, agentFulfillmentDataPayload,
  agentFulfillmentDefinitionPayload, type AgentFulfillmentProduction, type AgentFulfillmentShipment,
} from "@yummyai/contracts/ai/agent-fulfillment";
import {
  bindAgentFulfillmentCompletion, parseAgentFulfillmentSuggestion, type AgentFulfillmentSuggestion,
} from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import {
  AGENT_NATIVE_V4_MAX_STEPS, AgentNativeV4DecisionSchema, AgentNativeV4PinnedInputSchema,
  AgentNativeV4ReadRequestSchema, AgentNativeV4SelectionSchema, AgentNativeV4TurnInputSchema,
  AgentNativeV4DefinitionSchema, AgentNativeV4DefinitionEvidenceSchema, AgentNativeV4ObservationSchema,
  agentNativeV4DefinitionSelection, agentNativeV4ObservationBasisPayload,
  type AgentNativeV4DefinitionEvidence, type AgentNativeV4Observation, type AgentNativeV4Result,
  type AgentNativeV4Selection, type AgentNativeV4TurnInput,
} from "@yummyai/contracts/ai/agent-native-v4";
import { agentNativeV3ClaimValue, agentNativeV3SourceBasis } from "@yummyai/contracts/ai/agent-native-v3";
import {
  AGENT_RESOURCES_VERSION, AgentResourceCallSchema, agentResourceDataPayload, agentResourceDefinitionPayload,
} from "@yummyai/contracts/ai/agent-resources";
import { AGENT_TOOLS_VERSION, AgentToolCallSchema, agentToolDefinitionPayload } from "@yummyai/contracts/ai/agent-tools";
import { z } from "zod";
import { AgentNativeError, agentNativeChecksum } from "./agent-native-model.js";
import type { NativeEvidenceOpen, NativeEvidenceStep } from "./agent-native-evidence.js";
import type { NativeEvidence, NativePinned, NativePorts, NativeProtocol, NativeV4Family } from "./agent-native-protocol.js";
import { NativeV3ReadProgressSchema, buildNativeV3Observation, verifyNativeV3ReadResult } from "./agent-native-v3-evidence.js";

function invalid(): never { throw new AgentNativeError("agent_native_evidence_invalid"); }
function sourceInvalid(): never { throw new AgentNativeError("agent_native_fulfillment_source_invalid"); }
function sourceUnavailable(): never { throw new AgentNativeError("agent_native_fulfillment_source_unavailable"); }
function completionInvalid(): never { throw new AgentNativeError("agent_native_fulfillment_completion_invalid"); }
const selectionKey = (selection: AgentNativeV4Selection) => selection.kind === "read"
  ? `read:${selection.tool}` : `command:${agentCommandV2Key(selection.command)}`;

// These are the unchanged original reader envelopes, not V3 task/turn/decision packets.
export const NativeV4ReadProgressSchema = NativeV3ReadProgressSchema;
export const verifyNativeV4ReadResult = verifyNativeV3ReadResult;
export const nativeV4ReadCall: NativeProtocol<NativeV4Family>["readCall"] = (raw, request, checksum, options = {}) => {
  const input = AgentNativeV4PinnedInputSchema.parse(raw), parsed = AgentNativeV4ReadRequestSchema.parse(request);
  const binding = input.request.bindings[parsed.bindingIndex];
  if (!binding || (binding.tool === "knowledge.search" ? parsed.keyword === null : parsed.keyword !== null)) invalid();
  let data: unknown;
  switch (binding.tool) {
    case "orders.fulfillment": data = { ...binding.scope, pageSize: Math.min(10, options.pageSize ?? 10), cursor: options.cursor ?? null }; break;
    case "orders.exceptions.page": case "inventory.balances.page": data = { ...binding.scope, pageSize: options.pageSize ?? 100, cursor: options.cursor ?? null }; break;
    case "knowledge.search": data = { ...binding.scope, query: parsed.keyword }; break;
    case "factory.capacity": data = { ...binding.scope, query: { ...binding.scope.query, ...(options.factoryFrom ? { from: options.factoryFrom } : {}) } }; break;
    default: data = { ...binding.scope };
  }
  if (binding.tool === "orders.fulfillment") return AgentFulfillmentCallSchema.parse({ version: AGENT_FULFILLMENT_VERSION,
    tool: binding.tool, executionContract: input.fulfillmentExecutionContract, definitionChecksum: checksum, input: data });
  return ["orders.exceptions.page", "inventory.balances.page", "knowledge.search", "creative.history", "factory.capacity"].includes(binding.tool)
    ? AgentToolCallSchema.parse({ version: AGENT_TOOLS_VERSION, tool: binding.tool, executionContract: input.legacyReadExecutionContract,
      definitionChecksum: checksum, input: data })
    : AgentResourceCallSchema.parse({ version: AGENT_RESOURCES_VERSION, tool: binding.tool, executionContract: input.resourceExecutionContract,
      definitionChecksum: checksum, input: data });
};

export const validateNativeV4Definition: NativeProtocol<NativeV4Family>["validateDefinition"] = (input, raw, selection) => {
  const value = AgentNativeV4DefinitionSchema.parse(raw), selected = agentNativeV4DefinitionSelection(value);
  const payload = value.version === AGENT_COMMAND_V2_DEFINITION_VERSION ? agentCommandV2DefinitionPayload(value)
    : "selection" in value ? agentToolDefinitionPayload(value)
      : value.version === AGENT_FULFILLMENT_VERSION ? agentFulfillmentDefinitionPayload(value) : agentResourceDefinitionPayload(value);
  const allowed = selected.kind === "read" ? input.request.bindings.some(binding => binding.tool === selected.tool)
    : input.request.allowedCommands.some(command => agentCommandV2Key(command) === agentCommandV2Key(selected.command));
  if (!allowed || !value.available || value.definitionChecksum !== agentNativeChecksum(payload) ||
    selection && selectionKey(selection) !== selectionKey(selected)) throw new AgentNativeError("agent_tool_definition_changed");
  return value;
};

export const buildNativeV4Observation: NativeProtocol<NativeV4Family>["buildObservation"] = input => {
  // The existing structural validator owns pagination, exact native inputs,
  // duplicate IDs/cursors and original envelope hashes. It accepts bindings,
  // never a V3 version substitution. Only the new V4 basis is sealed here.
  const value = buildNativeV3Observation(input);
  return AgentNativeV4ObservationSchema.parse({ ...value,
    basisChecksum: agentNativeChecksum(agentNativeV4ObservationBasisPayload(value)) });
};

type SourceFrame = {
  orderId: string; sequence: number; lineIds: Set<string>;
  productions: AgentFulfillmentProduction[]; shipments: AgentFulfillmentShipment[];
};
function sourceFrame(suggestion: AgentFulfillmentSuggestion, observations: readonly AgentNativeV4Observation[]): SourceFrame {
  const source = suggestion.source, observation = observations.find(value => value.stepId === source.stepId);
  const result = observation?.results[source.resultIndex];
  if (!observation || !result || result.dataChecksum !== source.dataChecksum) sourceInvalid();
  if (result.version === AGENT_FULFILLMENT_VERSION) {
    if (observation.tool !== "orders.fulfillment" || result.input.orderId !== source.orderId || result.input.expectedSequence !== source.expectedSequence ||
      result.data.order.id !== source.orderId || result.data.order.sequence !== source.expectedSequence) sourceInvalid();
    return { orderId: source.orderId, sequence: source.expectedSequence, lineIds: new Set(result.data.order.lines.map(value => value.id)),
      productions: result.data.kind === "production" ? result.data.rows : [], shipments: result.data.kind === "shipments" ? result.data.rows : [] };
  }
  if (result.version === AGENT_RESOURCES_VERSION && result.tool === "orders.order" && observation.tool === result.tool &&
    result.input.orderId === source.orderId && result.input.expectedSequence === source.expectedSequence &&
    result.data.id === source.orderId && result.data.latestEventSequence === source.expectedSequence)
    return { orderId: source.orderId, sequence: source.expectedSequence, lineIds: new Set(result.data.lines.map(value => value.id)), productions: [], shipments: [] };
  return sourceInvalid();
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return sourceInvalid();
  return value as Record<string, unknown>;
}
const present = (value: Record<string, unknown>, key: string) => Object.hasOwn(value, key) && value[key] !== undefined;
function match(value: Record<string, unknown>, key: string, expected: unknown): void {
  if (present(value, key) && value[key] !== expected) sourceInvalid();
}
function production(frame: SourceFrame, id: unknown): AgentFulfillmentProduction {
  const value = frame.productions.find(row => row.id === id && row.orderId === frame.orderId);
  return value ?? sourceInvalid();
}
function shipment(frame: SourceFrame, id: unknown): AgentFulfillmentShipment {
  const value = frame.shipments.find(row => row.id === id && row.orderId === frame.orderId);
  return value ?? sourceInvalid();
}

type ValidationMode = "model" | "completion";
function checkProductionPin(frame: SourceFrame, raw: Record<string, unknown>, lineId?: unknown): void {
  const row = production(frame, raw.productionOrderId);
  if (lineId !== undefined && row.orderLineId !== lineId) sourceInvalid();
  match(raw, "productionVersionId", row.currentVersionId);
  // Delivery selections use the production projection. Whole-line pins use
  // this same field name for work; only the original form/owner knows it.
  if (lineId === undefined) match(raw, "expectedProjectionVersion", row.projectionVersion);
  match(raw, "expectedProductionProjectionVersion", row.projectionVersion);
}

/** Only model-provided references need old read evidence. Operator-added evidence is checked independently by the original form/owner. */
function checkModelReferences(frame: SourceFrame, raw: unknown, kind: string): void {
  const groups = frame.productions.flatMap(row => row.quality.state === "read" && row.quality.data ? row.quality.data.groups : []);
  const allocations = frame.shipments.flatMap(row => row.allocations);
  const rootIds = frame.productions.flatMap(row => row.quality.state === "read" && row.quality.data?.rootInspectionId ? [row.quality.data.rootInspectionId] : []);
  const references: Record<string, Set<string>> = {
    productionOrderId: new Set([...frame.productions.map(row => row.id), ...allocations.map(row => row.productionOrderId)]),
    originalProductionOrderId: new Set(frame.productions.map(row => row.id)),
    replacementProductionOrderId: new Set(frame.productions.map(row => row.id)),
    productionVersionId: new Set([...frame.productions.map(row => row.currentVersionId), ...allocations.map(row => row.productionVersionId)]),
    orderLineId: frame.lineIds, lineId: frame.lineIds,
    qualityGroupId: new Set([...groups.map(row => row.id), ...allocations.flatMap(row => row.qualityGroupId ? [row.qualityGroupId] : [])]),
    parentGroupId: new Set(groups.map(row => row.id)),
    qualityInspectionId: new Set([...groups.map(row => row.inspectionId), ...rootIds, ...allocations.map(row => row.qualityInspectionId)]),
    expectedRootInspectionId: new Set(rootIds), qualityStandardVersionId: new Set(groups.map(row => row.qualityStandardVersionId)),
    factoryId: new Set(frame.productions.flatMap(row => row.quantityBasis.state === "read" && row.quantityBasis.data?.factoryId ? [row.quantityBasis.data.factoryId] : [])),
    poolId: new Set(frame.productions.flatMap(row => row.quantityBasis.state === "read" && row.quantityBasis.data ? row.quantityBasis.data.reservations.map(item => item.poolId) : [])),
    poolVersionId: new Set(frame.productions.flatMap(row => row.quantityBasis.state === "read" && row.quantityBasis.data ? row.quantityBasis.data.reservations.map(item => item.poolVersionId) : [])),
    versionId: new Set(frame.productions.flatMap(row => row.manufacturing ? [row.manufacturing.versionId] : [])),
  };
  function visit(value: unknown, parent = "") {
    if (Array.isArray(value)) { value.forEach(child => visit(child, parent)); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      // A new package's reference is an operator-facing label, not an existing
      // ERP entity. Keep actual asset/production/quality identity gates strict.
      const newPackageLabel = parent === "packages" && key === "packageReferenceId";
      if (!newPackageLabel && child !== null && child !== undefined && (/Ids?$/.test(key) || key === "expectedRevision")) {
        const allowed = references[key];
        const values = Array.isArray(child) ? child : [child];
        if (values.length && (!allowed || values.some(id => typeof id !== "string" || !allowed.has(id)))) sourceUnavailable();
      }
      // These are work/editor pins, absent from the saved twelve reader DTOs.
      if (key === "expectedProjectionVersion" && (parent === "reviewedArtwork" || parent === "items" && kind.startsWith("whole_")) || key === "expectedRevision") sourceUnavailable();
      visit(child, key);
    }
  }
  visit(raw);
}

function checkAllocation(frame: SourceFrame, raw: unknown, lineId: unknown, mode: ValidationMode): void {
  const value = object(raw);
  if (!present(value, "productionOrderId")) return mode === "model" ? sourceUnavailable() : sourceInvalid();
  const row = frame.productions.find(item => item.id === value.productionOrderId && item.orderLineId === lineId);
  if (row) {
    match(value, "productionVersionId", row.currentVersionId);
    const quality = row.quality.state === "read" ? row.quality.data : null;
    const groups = quality?.groups ?? [];
    const group = value.qualityGroupId === null || value.qualityGroupId === undefined ? null : groups.find(item => item.id === value.qualityGroupId);
    if (value.qualityGroupId !== null && value.qualityGroupId !== undefined && !group) sourceInvalid();
    // A physical group's source pin is the projection inspected by its owner.
    // Recording that inspection advances the production projection afterwards.
    match(value, "expectedProductionProjectionVersion", group ? group.productionProjectionVersion : row.projectionVersion);
    if (present(value, "qualityInspectionId") && (group ? value.qualityInspectionId !== group.inspectionId :
      !quality || value.qualityInspectionId !== quality.rootInspectionId && !groups.some(item => item.inspectionId === value.qualityInspectionId))) sourceInvalid();
    return;
  }
  const available = frame.shipments.flatMap(item => item.allocations).filter(item => item.orderLineId === lineId && item.productionOrderId === value.productionOrderId);
  if (!available.some(item => (!present(value, "productionVersionId") || value.productionVersionId === item.productionVersionId) &&
    (!present(value, "qualityInspectionId") || value.qualityInspectionId === item.qualityInspectionId) &&
    (!present(value, "qualityGroupId") || value.qualityGroupId === item.qualityGroupId))) sourceInvalid();
  if (mode === "model" && present(value, "expectedProductionProjectionVersion")) sourceUnavailable();
}

function checkSourceInput(suggestion: AgentFulfillmentSuggestion, original: { kind: string; targetId: string; input: unknown; packageId?: string; versionId?: string },
  frame: SourceFrame, mode: ValidationMode): void {
  const input = object(original.input);
  const orderTarget = ["delivery_create", "whole_production_milestone", "whole_quality_inspection", "shipment_create", "whole_shipment_create"].includes(original.kind);
  if (orderTarget && original.targetId !== frame.orderId) sourceInvalid();
  if (mode === "model") checkModelReferences(frame, input, original.kind);
  switch (original.kind) {
    case "delivery_create":
      if (present(input, "items")) for (const value of z.array(z.unknown()).parse(input.items)) checkProductionPin(frame, object(value));
      break;
    case "delivery_feedback": {
      const selected = frame.productions.find(row => row.delivery.state === "read" && row.delivery.data?.itemId === original.targetId && row.delivery.data.packageId === original.packageId);
      if (!selected?.delivery.data) sourceInvalid();
      const delivery = selected.delivery.data;
      match(input, "expectedSequence", delivery.sequence);
      if (present(input, "fileChecksum") && (!delivery.fileChecksum || input.fileChecksum !== delivery.fileChecksum)) sourceInvalid();
      if (present(input, "manufacturingChecksum") && (!delivery.manufacturingPlanChecksum || input.manufacturingChecksum !== delivery.manufacturingPlanChecksum)) sourceInvalid();
      if (input.replacementProductionOrderId !== undefined && input.replacementProductionOrderId !== null) production(frame, input.replacementProductionOrderId);
      break;
    }
    case "production_milestone": match(input, "expectedProjectionVersion", production(frame, original.targetId).projectionVersion); break;
    case "quality_inspection": {
      const row = production(frame, original.targetId);
      match(input, "expectedProductionProjectionVersion", row.projectionVersion);
      if (mode === "model" && present(input, "qualityStandardVersionId") && !(row.quality.state === "read" &&
        row.quality.data?.groups.some(group => group.qualityStandardVersionId === input.qualityStandardVersionId))) sourceUnavailable();
      break;
    }
    case "quality_group_inspection": {
      const row = production(frame, original.targetId);
      match(input, "productionVersionId", row.currentVersionId); match(input, "expectedProductionProjectionVersion", row.projectionVersion);
      if (row.quality.state === "read" && row.quality.data) {
        match(input, "expectedRootInspectionId", row.quality.data.rootInspectionId);
        if (input.parentGroupId !== undefined && input.parentGroupId !== null && !row.quality.data.groups.some(group => group.id === input.parentGroupId && group.productionVersionId === row.currentVersionId)) sourceInvalid();
        if (mode === "model" && present(input, "qualityStandardVersionId") && !row.quality.data.groups.some(group => group.qualityStandardVersionId === input.qualityStandardVersionId)) sourceUnavailable();
      } else if (mode === "model" && (present(input, "expectedRootInspectionId") || present(input, "parentGroupId"))) sourceUnavailable();
      break;
    }
    case "production_recovery": {
      const row = production(frame, original.targetId);
      match(input, "originalProductionOrderId", row.id); match(input, "expectedProductionProjectionVersion", row.projectionVersion);
      if (input.qualityGroupId !== undefined && input.qualityGroupId !== null && !(row.quality.state === "read" && row.quality.data?.groups.some(group => group.id === input.qualityGroupId && group.productionVersionId === row.currentVersionId))) sourceInvalid();
      break;
    }
    case "whole_production_milestone": case "whole_quality_inspection": case "whole_shipment_create":
      if (present(input, "items")) for (const raw of z.array(z.unknown()).parse(input.items)) {
        const item = object(raw);
        if (typeof item.lineId !== "string" || !frame.lineIds.has(item.lineId)) sourceInvalid();
        if (original.kind !== "whole_shipment_create") checkProductionPin(frame, item, item.lineId);
        if (present(item, "productionAllocations")) for (const allocation of z.array(z.unknown()).parse(item.productionAllocations)) checkAllocation(frame, allocation, item.lineId, mode);
      }
      break;
    case "shipment_create": case "shipment_version":
      if (original.kind === "shipment_version") match(input, "expectedCurrentVersion", shipment(frame, original.targetId).currentVersionNumber);
      if (present(input, "packages")) for (const raw of z.array(z.unknown()).parse(input.packages)) {
        const pkg = object(raw);
        if (!present(pkg, "lines")) continue;
        for (const rawLine of z.array(z.unknown()).parse(pkg.lines)) {
          const line = object(rawLine);
          if (typeof line.orderLineId !== "string" || !frame.lineIds.has(line.orderLineId)) sourceInvalid();
          if (present(line, "productionAllocations")) for (const allocation of z.array(z.unknown()).parse(line.productionAllocations)) checkAllocation(frame, allocation, line.orderLineId, mode);
        }
      }
      break;
    case "shipment_review": {
      const row = shipment(frame, original.targetId);
      if (!row.versions.some(version => version.id === original.versionId && version.versionNumber === row.currentVersionNumber)) sourceInvalid();
      match(input, "expectedCurrentVersion", row.currentVersionNumber); break;
    }
    case "shipment_dispatch": case "shipment_platform_confirmation": match(input, "expectedVersion", shipment(frame, original.targetId).currentVersionNumber); break;
    default: return sourceInvalid();
  }
  if (suggestion.source.orderId !== frame.orderId || suggestion.source.expectedSequence !== frame.sequence) sourceInvalid();
}

const sourcePinKeys = new Set(["targetId", "packageId", "versionId", "productionOrderId", "originalProductionOrderId", "replacementProductionOrderId",
  "productionVersionId", "orderLineId", "lineId", "qualityGroupId", "parentGroupId", "qualityInspectionId", "qualityStandardVersionId", "expectedRootInspectionId",
  "factoryId", "supplierId", "poolId", "poolVersionId", "expectedRevision", "expectedProjectionVersion", "expectedProductionProjectionVersion",
  "expectedSequence", "expectedCurrentVersion", "expectedVersion", "fileChecksum", "manufacturingChecksum", "defectId", "renderId"]);
function hasSourcePins(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSourcePins);
  return !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => sourcePinKeys.has(key) || hasSourcePins(child));
}
function preserveSuggestedPins(suggested: unknown, completed: unknown): void {
  if (!hasSourcePins(suggested)) return;
  if (Array.isArray(suggested)) {
    if (!Array.isArray(completed)) return completionInvalid();
    for (const [index, value] of suggested.entries()) {
      const item = value && typeof value === "object" && !Array.isArray(value) ? object(value) : null;
      const key = item && ["productionOrderId", "lineId", "orderLineId", "packageReferenceId", "poolId"].find(name => typeof item[name] === "string");
      const matches = key ? completed.filter(raw => raw && typeof raw === "object" && !Array.isArray(raw) && object(raw)[key] === item![key]) : [completed[index]];
      if (matches.length !== 1 || matches[0] === undefined) return completionInvalid();
      preserveSuggestedPins(value, matches[0]);
    }
    // Selected item identities cannot be silently replaced or expanded.
    if (suggested.length && suggested.every(raw => raw && typeof raw === "object" && !Array.isArray(raw) &&
      ["productionOrderId", "lineId", "orderLineId"].some(key => typeof object(raw)[key] === "string")) && suggested.length !== completed.length) completionInvalid();
    return;
  }
  if (!suggested || typeof suggested !== "object") return;
  const actual = object(completed);
  for (const [key, value] of Object.entries(suggested)) {
    if (sourcePinKeys.has(key) && (!Object.hasOwn(actual, key) || agentNativeChecksum(value) !== agentNativeChecksum(actual[key]))) return completionInvalid();
    if (value && typeof value === "object") preserveSuggestedPins(value, actual[key]);
  }
}

function verifyObservations(observations: readonly AgentNativeV4Observation[]): void {
  for (const value of observations) {
    const observation = AgentNativeV4ObservationSchema.parse(value);
    if (observation.basisChecksum !== agentNativeChecksum(agentNativeV4ObservationBasisPayload(observation)) || observation.results.some(result =>
      result.dataChecksum !== agentNativeChecksum(result.version === AGENT_RESOURCES_VERSION ? agentResourceDataPayload(result)
        : result.version === AGENT_FULFILLMENT_VERSION ? agentFulfillmentDataPayload(result) : result.data))) invalid();
  }
}
export function verifyNativeV4Claims(result: Pick<AgentNativeV4Result, "claims" | "proposals">, observations: readonly AgentNativeV4Observation[]): void {
  verifyObservations(observations);
  for (const claim of result.claims) {
    const observation = observations.find(value => value.stepId === claim.stepId);
    try { if (!observation || agentNativeV3ClaimValue(observation, claim) !== claim.value) invalid(); }
    catch { throw new AgentNativeError("agent_native_claim_invalid"); }
  }
  for (const proposal of result.proposals) {
    if (proposal.draft.claims.length || new Set(proposal.claimIndexes).size !== proposal.claimIndexes.length || proposal.claimIndexes.some(index => !result.claims[index]))
      throw new AgentNativeError("agent_native_claim_invalid");
    if (!proposal.draft.fulfillment) continue;
    const suggestion = parseAgentFulfillmentSuggestion(proposal.draft.fulfillment);
    checkSourceInput(suggestion, suggestion.original, sourceFrame(suggestion, observations), "model");
  }
}

/** Pure validation only. The original service still authorizes and validates the completed owner request. */
export const validateNativeV4Completion: NonNullable<NativeProtocol<NativeV4Family>["validateCompletion"]> = (proposal, raw, observations) => {
  if (proposal.draft.capability.domain !== "fulfillment") {
    if (raw !== null && raw !== undefined) completionInvalid();
    return;
  }
  if (!proposal.draft.fulfillment) return completionInvalid();
  verifyObservations(observations);
  const suggestion = parseAgentFulfillmentSuggestion(proposal.draft.fulfillment), frame = sourceFrame(suggestion, observations);
  checkSourceInput(suggestion, suggestion.original, frame, "model");
  let completion: ReturnType<typeof bindAgentFulfillmentCompletion>;
  try { completion = bindAgentFulfillmentCompletion(suggestion, proposal.id, raw); }
  catch { return completionInvalid(); }
  checkSourceInput(suggestion, completion.original, frame, "completion");
  preserveSuggestedPins(suggestion.original, completion.original);
};

export function nativeV4EvidenceChain(rows: readonly NativeEvidenceStep[], inputChecksum: string, open: NativeEvidenceOpen): NativeEvidence<NativeV4Family> {
  if (rows.length > AGENT_NATIVE_V4_MAX_STEPS) invalid();
  let previous = inputChecksum, unfinished = false, turn = 0, packet: AgentNativeV4TurnInput | undefined;
  let decision: z.infer<typeof AgentNativeV4DecisionSchema> | undefined;
  const definitions: AgentNativeV4DefinitionEvidence[] = [], observations: AgentNativeV4Observation[] = [], selections = new Set<string>(), requests = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (row.sequence !== index + 1 || row.previousChecksum !== previous || unfinished || (index % 2 === 0 ? row.kind !== "model" : row.kind === "model")) invalid();
    if (row.kind === "model") {
      const next = open(row.encryptedInput, row.inputChecksum, AgentNativeV4TurnInputSchema);
      if (next.runId !== row.runId || next.turn !== ++turn || next.turn > 48 || agentNativeChecksum(next.definitions) !== agentNativeChecksum(definitions) ||
        agentNativeChecksum(next.observations) !== agentNativeChecksum(observations)) invalid();
      if (packet) { const fixed = (value: AgentNativeV4TurnInput) => ({ ...value, turn: 0, definitions: [], observations: [] });
        if (agentNativeChecksum(fixed(next)) !== agentNativeChecksum(fixed(packet))) invalid(); }
      packet = next;
      if (row.tool !== null) invalid();
    } else {
      if (!packet || !decision || decision.action !== row.kind) invalid();
      if (row.kind === "definition") {
        const selection = open(row.encryptedInput, row.inputChecksum, AgentNativeV4SelectionSchema);
        if (agentNativeChecksum(selection) !== agentNativeChecksum(decision.definition) || selections.has(selectionKey(selection)) || row.tool !== (selection.kind === "read" ? selection.tool : null)) invalid();
        selections.add(selectionKey(selection));
      } else {
        const request = open(row.encryptedInput, row.inputChecksum, AgentNativeV4ReadRequestSchema);
        if (agentNativeChecksum(request) !== agentNativeChecksum(decision.read) || requests.has(row.inputChecksum) || row.tool !== packet.bindings[request.bindingIndex]?.tool) invalid();
        requests.add(row.inputChecksum);
      }
    }
    if (row.phase !== "completed") { unfinished = true; continue; }
    if (!row.outputChecksum) invalid(); previous = row.outputChecksum;
    if (row.kind === "model") {
      decision = open(row.encryptedOutput, row.outputChecksum, AgentNativeV4DecisionSchema);
      const response = open(row.encryptedResponse, row.responseChecksum, ModelResponseCheckpointSchema);
      if (row.submissionState !== "received" || agentNativeChecksum(decodeModelResponse(response, AgentNativeV4DecisionSchema).value) !== row.outputChecksum) invalid();
      if (decision.action === "finish" && index !== rows.length - 1) invalid();
    } else if (row.kind === "definition") {
      const evidence = open(row.encryptedOutput, row.outputChecksum, AgentNativeV4DefinitionEvidenceSchema);
      if (evidence.stepId !== row.id) invalid(); validateNativeV4Definition({ request: packet! }, evidence.definition, decision!.definition!); definitions.push(evidence);
    } else {
      const observation = open(row.encryptedOutput, row.outputChecksum, AgentNativeV4ObservationSchema);
      if (observation.stepId !== row.id || agentNativeChecksum(observation.request) !== row.inputChecksum) invalid();
      const definition = definitions.find(value => { const selected = agentNativeV4DefinitionSelection(value.definition); return selected.kind === "read" && selected.tool === row.tool; });
      if (!definition || observation.results.some(value => value.definitionChecksum !== definition.definition.definitionChecksum)) invalid();
      if (agentNativeChecksum(buildNativeV4Observation({ ...observation, input: { request: packet!, fulfillmentExecutionContract: packet!.readContracts.fulfillment } })) !== row.outputChecksum) invalid();
      observations.push(observation);
    }
  }
  return { definitions, observations };
}

export async function recheckNativeV4Evidence(input: NativePinned<NativeV4Family>, definitions: readonly AgentNativeV4DefinitionEvidence[], observations: readonly AgentNativeV4Observation[],
  ports: NativePorts, take: () => Promise<TenantContext>, protocol: Pick<NativeProtocol<NativeV4Family>, "definition" | "call">): Promise<void> {
  for (const saved of definitions) {
    const selection = agentNativeV4DefinitionSelection(saved.definition), current = await protocol.definition(await take(), selection, ports);
    validateNativeV4Definition(input, current, selection);
    if (current.definitionChecksum !== saved.definition.definitionChecksum) throw new AgentNativeError("agent_tool_definition_changed");
  }
  for (const observation of observations) {
    const definition = definitions.find(value => { const selected = agentNativeV4DefinitionSelection(value.definition); return selected.kind === "read" && selected.tool === observation.tool; });
    if (!definition) invalid(); const first = observation.results[0]!;
    if (observation.tool === "orders.fulfillment") {
      for (const saved of observation.results) {
        if (saved.version !== AGENT_FULFILLMENT_VERSION) invalid();
        const call = nativeV4ReadCall(input, observation.request, definition.definition.definitionChecksum, { pageSize: saved.input.pageSize, cursor: saved.input.cursor });
        const fresh = await protocol.call(await take(), call, ports); verifyNativeV4ReadResult(fresh, call);
        if (agentNativeChecksum(agentNativeV3SourceBasis(fresh)) !== agentNativeChecksum(agentNativeV3SourceBasis(saved))) throw new AgentNativeError("agent_native_source_changed");
      }
      continue;
    }
    const call = nativeV4ReadCall(input, observation.request, definition.definition.definitionChecksum, { pageSize: 1, cursor: null,
      ...(first.tool === "factory.capacity" ? { factoryFrom: first.data.from } : {}) });
    const fresh = await protocol.call(await take(), call, ports); verifyNativeV4ReadResult(fresh, call);
    if (fresh.tool === "orders.exceptions.page" || fresh.tool === "inventory.balances.page") {
      if (first.tool !== fresh.tool || fresh.data.collectionFingerprint !== first.data.collectionFingerprint || fresh.data.total !== first.data.total)
        throw new AgentNativeError("agent_collection_changed");
    } else if (agentNativeChecksum(agentNativeV3SourceBasis(fresh)) !== agentNativeChecksum(agentNativeV3SourceBasis(first))) throw new AgentNativeError("agent_native_source_changed");
  }
}
