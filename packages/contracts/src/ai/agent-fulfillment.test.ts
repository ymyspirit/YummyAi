import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentToolKeySchema } from "./agent-tools.js";
import { AgentResourceKeySchema } from "./agent-resources.js";
import { AgentNativeV2BindingSchema } from "./agent-native-v2.js";
import { agentTransportChecksum, agentTransportTextHash } from "./agent-transport.js";
import { AGENT_FULFILLMENT_TOOL, AGENT_FULFILLMENT_VERSION, AgentFulfillmentCallSchema,
  AgentFulfillmentCandidatesQuerySchema, AgentFulfillmentCandidatesSchema, AgentFulfillmentDefinitionSchema,
  AgentFulfillmentFactorySchema, AgentFulfillmentInputSchema, AgentFulfillmentLogisticsSchema, AgentFulfillmentResultSchema,
  agentFulfillmentDataPayload, agentFulfillmentDefinitionPayload, canonicalAgentFulfillmentCall, fulfillmentSection } from "./agent-fulfillment.js";
import { verifyAgentFulfillmentCandidates, verifyAgentFulfillmentDefinition, verifyAgentFulfillmentResult } from "./agent-fulfillment-transport.js";

const hash = "a".repeat(64), time = "2026-10-22T00:00:00.000Z";
const contract = { contractVersion: "native-harness-v1", executorKey: "erp.agent.fulfillment",
  skill: { key: "erp.agent.fulfillment", version: AGENT_FULFILLMENT_VERSION, checksum: hash },
  tools: [{ key: AGENT_FULFILLMENT_TOOL, version: AGENT_FULFILLMENT_VERSION, checksum: hash }], checksum: hash };

async function packet() {
  const orderId = createEntityId(), lineId = createEntityId(), productionId = createEntityId(), versionId = createEntityId();
  const call = AgentFulfillmentCallSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL,
    executionContract: contract, definitionChecksum: hash, input: { orderId, expectedSequence: 4, kind: "production", cursor: null, pageSize: 1 } });
  const value = AgentFulfillmentResultSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL,
    contextAuthority: "synthetic-current-personal-authority", callId: createEntityId(), checkedAt: time, readStartedAt: time,
    input: call.input, definitionChecksum: hash, inputChecksum: await agentTransportTextHash(canonicalAgentFulfillmentCall(call)), dataChecksum: hash,
    sources: [{ owner: "orders", kind: "order", id: orderId, versionId: null, revision: 4, checksum: null },
      { owner: "production", kind: "production_order", id: productionId, versionId, revision: 2, checksum: null }],
    data: { kind: "production", order: { id: orderId, number: "SYNTHETIC-ORIGINAL-ORDER", sequence: 4,
      mainState: "in_production", sideState: null, lines: [{ id: lineId, quantity: 5, sku: null }] },
      coverage: { complete: false, kind: "original_owner_page_projection", returned: 1, indexedTotal: 1,
        hasMore: false, nextCursor: null, collectionChecksum: hash, limitation: "One original owner projection does not establish complete physical fulfillment" },
      rows: [{ id: productionId, orderId, orderLineId: lineId, status: "submitted", projectionVersion: 2,
        currentVersionNumber: 1, currentVersionId: versionId, quantity: 5, expectedCompletionAt: time, updatedAt: time,
        manufacturing: null, milestones: [], milestoneCoverage: { returned: 0, originalCount: 0, truncated: false },
        quantityBasis: { state: "unavailable", reason: "legacy_unknown", data: null },
        quality: { state: "read", reason: null, data: { productionOrderId: productionId, orderId, productionVersionId: versionId,
          projectionVersion: 2, rootInspectionId: null, groups: [], coverage: { returned: 0, originalCount: 0, truncated: false } } },
        delivery: { state: "read", reason: null, data: { packageId: createEntityId(), itemId: createEntityId(), status: "submitted", sequence: 1,
          productionVersionId: versionId, fileChecksum: hash, manufacturingContentChecksum: hash, manufacturingPlanChecksum: hash, packageChecksum: hash, fileSourceAvailable: true } },
        factory: { state: "not_present", reason: null, data: null } }] },
    consistency: "owner_reads_fenced_not_single_transaction_snapshot", modelCalled: false, businessExecuted: false });
  value.dataChecksum = await agentTransportChecksum(agentFulfillmentDataPayload(value));
  return { call, value };
}

describe("independent same-order fulfillment read transport", () => {
  it("keeps fulfillment outside the old five readers six resources and eleven-reader paid protocol", () => {
    expect(AGENT_FULFILLMENT_VERSION).toBe("erp-agent-fulfillment-v1");
    expect(AgentToolKeySchema.safeParse(AGENT_FULFILLMENT_TOOL).success).toBe(false);
    expect(AgentResourceKeySchema.safeParse(AGENT_FULFILLMENT_TOOL).success).toBe(false);
    expect(AgentNativeV2BindingSchema.safeParse({ tool: AGENT_FULFILLMENT_TOOL, scope: { orderId: createEntityId(), expectedSequence: 1 } }).success).toBe(false);
    const input = { orderId: createEntityId(), expectedSequence: 1, kind: "production", cursor: null };
    const base = { version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL, executionContract: contract, definitionChecksum: hash, input };
    for (const altered of [{ ...base, operation: "execute" }, { ...base, input: { ...input, sql: "select synthetic" } },
      { ...base, input: { ...input, url: "https://synthetic.invalid" } }, { ...base, tenantId: createEntityId() },
      { ...base, input: { ...input, confirmed: true } }]) expect(AgentFulfillmentCallSchema.safeParse(altered).success).toBe(false);
  });

  it("requires a fixed positive order revision and bounded strict pagination for all three sections", () => {
    const orderId = createEntityId();
    for (const kind of ["production", "shipments", "logistics"] as const) {
      expect(AgentFulfillmentInputSchema.parse({ orderId, expectedSequence: 1, kind, cursor: null }).pageSize).toBe(5);
      for (const invalid of [{ expectedSequence: 0 }, { expectedSequence: 1.1 }, { pageSize: 11 }, { pageSize: 0 }, { cursor: "" }, { kind: "approve" }])
        expect(AgentFulfillmentInputSchema.safeParse({ orderId, expectedSequence: 1, kind, cursor: null, ...invalid }).success).toBe(false);
    }
    expect(AgentFulfillmentCandidatesQuerySchema.safeParse({ version: AGENT_FULFILLMENT_VERSION, filters: { limit: 101 } }).success).toBe(false);
    expect(AgentFulfillmentCandidatesQuerySchema.safeParse({ version: AGENT_FULFILLMENT_VERSION, filters: { ownerId: createEntityId() } }).success).toBe(false);
  });

  it("preserves unknown and unavailable facts without inventing shipped quantities or expired private counts", () => {
    const section = fulfillmentSection(AgentFulfillmentFactorySchema);
    expect(section.parse({ state: "unavailable", reason: "permission_required", data: null }).data).toBeNull();
    expect(section.safeParse({ state: "read", reason: null, data: null }).success).toBe(false);
    expect(section.safeParse({ state: "unavailable", reason: null, data: null }).success).toBe(false);
    const observed = { bindingId: createEntityId(), status: "shipped", exception: "voided_requires_review", observationId: createEntityId(),
      importId: createEntityId(), rawStatus: "已出库", updatedAtLocal: "2026-10-21 10:11:12", recordedAt: time, shippedQuantity: null };
    expect(AgentFulfillmentFactorySchema.parse(observed).shippedQuantity).toBeNull();
    expect(AgentFulfillmentFactorySchema.safeParse({ ...observed, shippedQuantity: 5 }).success).toBe(false);
    expect(section.safeParse({ state: "unavailable", reason: "source_expired", data: observed }).success).toBe(false);
    const logistics = { id: createEntityId(), orderId: createEntityId(), factoryId: createEntityId(), status: "reconciliation_required", privateAvailable: false,
      createdAt: time, updatedAt: time, expiresAt: time, connectionVersionId: createEntityId(), ruleVersionId: createEntityId(), productionVersionIds: [],
      snapshotChecksum: hash, quotedCostMinor: 500, actualCostMinor: null, quotedCurrency: "USD", actualCurrency: null, minorUnitDigits: 2,
      trackingCount: null, labelCount: null };
    expect(AgentFulfillmentLogisticsSchema.parse(logistics).actualCostMinor).toBeNull();
    expect(AgentFulfillmentLogisticsSchema.safeParse({ ...logistics, trackingCount: 0 }).success).toBe(false);
  });

  it("binds definitions candidates and the full normalized request without substituting another selected order", async () => {
    const { call } = await packet();
    const reordered = { ...call, input: { pageSize: 1, cursor: null, kind: "production", expectedSequence: 4, orderId: call.input.orderId.toUpperCase() } };
    expect(canonicalAgentFulfillmentCall(reordered)).toBe(canonicalAgentFulfillmentCall(call));
    const definition = AgentFulfillmentDefinitionSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL,
      contextAuthority: "synthetic-authority", label: "Original fulfillment", available: true, blockReason: null,
      inputSchema: {}, outputSchema: {}, definitionChecksum: hash, effect: "read", execution: "original_owner_fulfillment_projection", limitations: ["Original observations only"] });
    definition.definitionChecksum = await agentTransportChecksum(agentFulfillmentDefinitionPayload(definition));
    await verifyAgentFulfillmentDefinition(definition);
    await expect(verifyAgentFulfillmentDefinition({ ...definition, label: "Altered original definition" })).rejects.toThrow();
    const query = AgentFulfillmentCandidatesQuerySchema.parse({ version: AGENT_FULFILLMENT_VERSION, filters: { limit: 1 } });
    const candidates = AgentFulfillmentCandidatesSchema.parse({ version: AGENT_FULFILLMENT_VERSION, contextAuthority: "synthetic-authority", query,
      inputChecksum: await agentTransportChecksum(query), items: [{ id: call.input.orderId, label: "Original business order number", expectedSequence: 4, lineId: null }],
      coverage: { complete: false, total: null, returned: 1, hasMore: true, limitation: "Bounded original order candidates" } });
    await verifyAgentFulfillmentCandidates(candidates, query);
    await expect(verifyAgentFulfillmentCandidates(candidates, { ...query, filters: { ...query.filters, limit: 2 } })).rejects.toThrow();
    expect(AgentFulfillmentCandidatesSchema.safeParse({ ...candidates, coverage: { ...candidates.coverage, returned: 0 } }).success).toBe(false);
    expect(canonicalJson(call.input)).toContain(call.input.orderId);
  });

  it("rejects rehashed foreign order line production version and source claims and never promotes page coverage to complete", async () => {
    const { call, value } = await packet(); await verifyAgentFulfillmentResult(value, call);
    if (value.data.kind !== "production") throw new Error("Synthetic production packet expected");
    for (const mutate of [
      (altered: typeof value) => { altered.data.order.id = createEntityId(); },
      (altered: typeof value) => { if (altered.data.kind === "production") altered.data.rows[0]!.orderLineId = createEntityId(); },
      (altered: typeof value) => { if (altered.data.kind === "production") altered.data.rows[0]!.delivery.data!.productionVersionId = createEntityId(); },
      (altered: typeof value) => { altered.sources[1]!.versionId = createEntityId(); },
    ]) {
      const altered = structuredClone(value); mutate(altered); altered.dataChecksum = await agentTransportChecksum(agentFulfillmentDataPayload(altered));
      await expect(verifyAgentFulfillmentResult(altered, call)).rejects.toThrow();
    }
    for (const altered of [{ ...value, inputChecksum: "0".repeat(64) }, { ...value, dataChecksum: "0".repeat(64) }])
      await expect(verifyAgentFulfillmentResult(altered, call)).rejects.toThrow();
    expect(AgentFulfillmentResultSchema.safeParse({ ...value, data: { ...value.data, coverage: { ...value.data.coverage, complete: true } } }).success).toBe(false);
    expect(AgentFulfillmentResultSchema.safeParse({ ...value, data: { ...value.data, signedUrl: "https://synthetic.invalid" } }).success).toBe(false);
    expect(AgentFulfillmentResultSchema.safeParse({ ...value, modelCalled: true }).success).toBe(false);
    expect(AgentFulfillmentResultSchema.safeParse({ ...value, businessExecuted: true }).success).toBe(false);
  });
});
