import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentTransportIntegrityError, agentTransportChecksum, agentTransportTextHash } from "@yummyai/contracts/ai/agent-transport";
import { agentFulfillmentDataPayload, agentFulfillmentDefinitionPayload, canonicalAgentFulfillmentCall,
  type AgentFulfillmentCall, type AgentFulfillmentCandidates, type AgentFulfillmentDefinitionSchema, type AgentFulfillmentResult,
  type AgentFulfillmentCandidatesQuerySchema } from "@yummyai/contracts/ai/agent-fulfillment";
import type { z } from "zod";

const invalid = () => new AgentTransportIntegrityError("fulfillment_integrity");
export async function verifyAgentFulfillmentDefinition(value: z.infer<typeof AgentFulfillmentDefinitionSchema>) {
  if (await agentTransportChecksum(agentFulfillmentDefinitionPayload(value)) !== value.definitionChecksum) throw invalid();
}
export async function verifyAgentFulfillmentCandidates(value: AgentFulfillmentCandidates, query: z.infer<typeof AgentFulfillmentCandidatesQuerySchema>) {
  if (canonicalJson(value.query) !== canonicalJson(query) || await agentTransportChecksum(query) !== value.inputChecksum) throw invalid();
}
export function assertAgentFulfillmentObject(value: AgentFulfillmentResult, call: AgentFulfillmentCall) {
  if (value.definitionChecksum !== call.definitionChecksum || canonicalJson(value.input) !== canonicalJson(call.input) ||
    value.data.order.id !== call.input.orderId || value.data.order.sequence !== call.input.expectedSequence || value.data.kind !== call.input.kind) throw invalid();
  const lines = new Set(value.data.order.lines.map(row => row.id));
  if (!value.sources.some(source => source.owner === "orders" && source.id === call.input.orderId && source.revision === call.input.expectedSequence)) throw invalid();
  for (const row of value.data.rows) if (row.orderId !== call.input.orderId) throw invalid();
  if (value.data.kind === "production") for (const row of value.data.rows) {
    if (!lines.has(row.orderLineId) || row.manufacturing && (row.manufacturing.productionOrderId !== row.id || row.manufacturing.productionVersionId !== row.currentVersionId || row.manufacturing.quantity !== row.quantity) ||
      row.quantityBasis.data && (row.quantityBasis.data.productionOrderId !== row.id || row.quantityBasis.data.orderId !== call.input.orderId || row.quantityBasis.data.orderLineId !== row.orderLineId || row.quantityBasis.data.productionVersionId !== row.currentVersionId) ||
      row.quality.data && (row.quality.data.productionOrderId !== row.id || row.quality.data.orderId !== call.input.orderId || row.quality.data.productionVersionId !== row.currentVersionId) ||
      row.delivery.data?.productionVersionId && row.delivery.data.productionVersionId !== row.currentVersionId ||
      !value.sources.some(source => source.owner === "production" && source.id === row.id && source.versionId === row.currentVersionId && source.revision === row.projectionVersion)) throw invalid();
    if (row.quality.data?.groups.some(group => group.productionOrderId !== row.id)) throw invalid();
  }
  if (value.data.kind === "shipments") for (const row of value.data.rows) {
    if (row.packageLines.some(line => !lines.has(line.orderLineId)) || row.allocations.some(line => !lines.has(line.orderLineId)) ||
      !value.sources.some(source => source.owner === "shipments" && source.id === row.id && source.revision === row.currentVersionNumber)) throw invalid();
  }
  if (value.data.kind === "logistics") for (const row of value.data.rows)
    if (!value.sources.some(source => source.owner === "logistics" && source.id === row.id && source.versionId === row.connectionVersionId && source.checksum === row.snapshotChecksum)) throw invalid();
}
export async function verifyAgentFulfillmentResult(value: AgentFulfillmentResult, call: AgentFulfillmentCall) {
  assertAgentFulfillmentObject(value, call);
  if (await agentTransportTextHash(canonicalAgentFulfillmentCall(call)) !== value.inputChecksum || await agentTransportChecksum(agentFulfillmentDataPayload(value)) !== value.dataChecksum) throw invalid();
}
