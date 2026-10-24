import { describe, expect, it } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AgentToolKeySchema, AGENT_TOOLS_VERSION } from "./agent-tools.js";
import { AGENT_NATIVE_VERSION } from "./agent-native.js";
import { AGENT_PLAN_VERSION } from "./agent-plan.js";
import { AGENT_MCP_TOOL_NAMES, parseAgentMcpCapabilityKey } from "./agent-mcp.js";
import { agentTransportChecksum, agentTransportTextHash } from "./agent-transport.js";
import { AGENT_RESOURCES_VERSION, AgentResourceKeySchema, AgentResourceCallSchema, AgentResourceCandidatesQuerySchema,
  AgentResourceCandidatesSchema, AgentResourceDefinitionSchema, AgentResourceMcpCandidatesRequestSchema,
  AgentResourceResultSchema, agentResourceDefinitionPayload, agentResourceDataPayload, canonicalAgentResourceInput,
  type AgentResourceDefinition } from "./agent-resources.js";
import { verifyAgentResourceDefinition, verifyAgentResourceCandidates, verifyAgentResourceResult } from "./agent-resource-transport.js";

const hash = "a".repeat(64), time = "2026-10-22T00:00:00.000Z";
const contract = { contractVersion: "native-harness-v1", executorKey: "erp.agent.resources",
  skill: { key: "erp.agent.resources", version: AGENT_RESOURCES_VERSION, checksum: hash },
  tools: [{ key: "research.evidence", version: AGENT_RESOURCES_VERSION, checksum: hash }], checksum: hash };
const keys = ["research.evidence", "catalog.sku", "listing.version", "orders.order", "finance.profit_run", "advertising.analysis"];

async function researchPacket(studyRevisionId: string | null = null) {
  const researchItemId = createEntityId(), snapshotId = createEntityId();
  const call = AgentResourceCallSchema.parse({ version: AGENT_RESOURCES_VERSION, executionContract: contract, definitionChecksum: hash,
    tool: "research.evidence", input: { researchItemId, snapshotId, studyRevisionId } });
  if (call.tool !== "research.evidence") throw new Error("Synthetic research call expected");
  const raw = { version: AGENT_RESOURCES_VERSION, contextAuthority: "synthetic-current-personal-authority", callId: createEntityId(), checkedAt: time,
    definitionChecksum: hash, inputChecksum: await agentTransportTextHash(canonicalAgentResourceInput(call)), dataChecksum: hash,
    tool: "research.evidence", input: call.input, sources: [{ owner: "ResearchStudyService", kind: "research_item", id: researchItemId, versionId: snapshotId, revision: null }],
    coverage: { kind: "single_object_projection", complete: false, limitation: "One explicitly selected immutable original source; not the complete research collection" },
    data: { source: { domain: "research", researchItemId, snapshotId, studyRevisionId, studyVersion: 0, title: "Known synthetic public evidence",
      sourceUrl: "https://www.etsy.com/listing/123456789/synthetic", platform: "etsy", capturedAt: time, mediaCount: 0, content: null },
    snapshot: { platform: "etsy", parserVersion: "etsy@1.0.0", extensionVersion: "0.0.0", marketplace: "www.etsy.com",
      sourceUrl: "https://www.etsy.com/listing/123456789/synthetic", externalId: "123456789", title: "Known synthetic public evidence", domain: "research",
      price: { raw: "$20.00", amount: 20, currency: "USD" }, rating: null, reviewCount: null, taxonomy: [], listingPublishedAt: null,
      favoriteCount: null, bullets: [], missingFields: [], diagnostics: [], captureStatus: "complete", capturedAt: time } } };
  const value = AgentResourceResultSchema.parse(raw);
  value.dataChecksum = await agentTransportChecksum(agentResourceDataPayload(value));
  return { call, value };
}

describe("independent original resource transport and immutable selection", () => {
  it("keeps six resources separate from the five old readers and the original MCP protocol keys", () => {
    expect(AgentResourceKeySchema.options).toEqual(keys);
    expect(AgentToolKeySchema.options).toEqual(["orders.exceptions.page", "inventory.balances.page", "knowledge.search", "creative.history", "factory.capacity"]);
    expect([AGENT_TOOLS_VERSION, AGENT_NATIVE_VERSION, AGENT_PLAN_VERSION]).toEqual(["erp-agent-tools-v1", "erp-agent-native-v1", "erp-agent-plan-v1"]);
    expect(Object.values(AGENT_MCP_TOOL_NAMES)).toEqual(["erp_capabilities_search", "erp_tool_schema", "erp_execute", "erp_saved_result", "erp_usage"]);
    expect(() => parseAgentMcpCapabilityKey("resource/research.evidence")).toThrow();
    expect(AgentToolKeySchema.safeParse("orders.order").success).toBe(false);
  });

  it("requires exact original ids and versions without admitting identities commands or collection claims", () => {
    const id = createEntityId(), other = createEntityId();
    const inputs = [{ tool: "research.evidence", input: { researchItemId: id, snapshotId: other, studyRevisionId: null } },
      { tool: "catalog.sku", input: { skuId: id, recipeId: null } }, { tool: "listing.version", input: { listingId: id, versionId: other } },
      { tool: "orders.order", input: { orderId: id, expectedSequence: 1 } }, { tool: "finance.profit_run", input: { runId: id } },
      { tool: "advertising.analysis", input: { accountId: id, analysisId: other } }];
    for (const selection of inputs) {
      const call = { version: AGENT_RESOURCES_VERSION, executionContract: contract, definitionChecksum: hash, ...selection };
      expect(AgentResourceCallSchema.safeParse(call).success).toBe(true);
      for (const invalid of [{ ...call, tenantId: id }, { ...call, tool: "finance.payment" },
        { ...call, input: { ...selection.input, current: true } }, { ...call, operation: "execute" }])
        expect(AgentResourceCallSchema.safeParse(invalid).success).toBe(false);
    }
    expect(AgentResourceCallSchema.safeParse({ version: AGENT_RESOURCES_VERSION, executionContract: contract, definitionChecksum: hash,
      tool: "orders.order", input: { orderId: id, expectedSequence: 0 } }).success).toBe(false);
    expect(AgentResourceCallSchema.safeParse({ version: AGENT_RESOURCES_VERSION, executionContract: contract, definitionChecksum: hash,
      tool: "listing.version", input: { listingId: id } }).success).toBe(false);
    expect(AgentResourceCandidatesQuerySchema.safeParse({ version: AGENT_RESOURCES_VERSION, tool: "catalog.sku", pageSize: 101 }).success).toBe(false);
    expect(AgentResourceCandidatesQuerySchema.safeParse({ version: AGENT_RESOURCES_VERSION, tool: "research.evidence", page: 2 }).success).toBe(false);
  });

  it("rejects a different pinned source even when a sender recomputes its data hash and never upgrades single-object coverage to complete", async () => {
    const { call, value } = await researchPacket(); await verifyAgentResourceResult(value, call);
    expect(value.coverage.complete).toBe(false);
    const different = structuredClone(value);
    if (different.tool !== "research.evidence") throw new Error("Synthetic research branch expected");
    different.data.source.snapshotId = createEntityId();
    different.dataChecksum = await agentTransportChecksum(agentResourceDataPayload(different));
    await expect(verifyAgentResourceResult(different, call)).rejects.toThrow();
    for (const altered of [{ ...value, inputChecksum: "0".repeat(64) }, { ...value, dataChecksum: "0".repeat(64) },
      { ...value, sources: [{ ...value.sources[0]!, versionId: createEntityId() }] }])
      await expect(verifyAgentResourceResult(altered, call)).rejects.toThrow();
    expect(AgentResourceResultSchema.safeParse({ ...value, coverage: { ...value.coverage, complete: true } }).success).toBe(false);
    expect(AgentResourceResultSchema.safeParse({ ...value, data: { ...value.data, signedUrl: "https://private.invalid" } }).success).toBe(false);
  });

  it("binds the explicitly requested study revision and the entire canonical input independently of property order", async () => {
    const first = await researchPacket(), revision = createEntityId();
    const changed = AgentResourceCallSchema.parse({ ...first.call, input: { ...first.call.input, studyRevisionId: revision } });
    await expect(verifyAgentResourceResult(first.value, changed)).rejects.toThrow();
    const same = AgentResourceCallSchema.parse({ tool: first.call.tool, input: { studyRevisionId: null,
      snapshotId: first.call.input.snapshotId, researchItemId: first.call.input.researchItemId },
      definitionChecksum: first.call.definitionChecksum, executionContract: contract, version: AGENT_RESOURCES_VERSION });
    expect(canonicalAgentResourceInput(same)).toBe(canonicalAgentResourceInput(first.call));
    expect(canonicalAgentResourceInput(first.call)).toBe(canonicalJson({ version: AGENT_RESOURCES_VERSION, tool: first.call.tool, input: first.call.input }));
  });

  it("verifies the selected definition and bounded candidate query without confusing account choices with analyses", async () => {
    const definition: AgentResourceDefinition = AgentResourceDefinitionSchema.parse({ version: AGENT_RESOURCES_VERSION,
      contextAuthority: "synthetic-current-personal-authority", tool: "research.evidence", label: "Original research", owner: "ResearchStudyService", definitionChecksum: hash,
      inputSchema: { type: "object" }, outputSchema: { type: "object" }, available: true, blockReason: null, effect: "read",
      execution: "original_owner_object_projection", limitations: ["One original immutable source"] });
    definition.definitionChecksum = await agentTransportChecksum(agentResourceDefinitionPayload(definition));
    await verifyAgentResourceDefinition(definition, "research.evidence");
    await expect(verifyAgentResourceDefinition({ ...definition, outputSchema: {} }, "research.evidence")).rejects.toThrow();
    await expect(verifyAgentResourceDefinition(definition, "finance.profit_run")).rejects.toThrow();
    const query = AgentResourceCandidatesQuerySchema.parse({ version: AGENT_RESOURCES_VERSION, tool: "advertising.analysis", accountId: null, cursor: null, pageSize: 25 });
    if (query.tool !== "advertising.analysis") throw new Error("Synthetic advertising account query expected");
    const candidates = AgentResourceCandidatesSchema.parse({ version: AGENT_RESOURCES_VERSION, contextAuthority: definition.contextAuthority, query,
      inputChecksum: await agentTransportChecksum(query), items: [{ id: createEntityId(), label: "Synthetic original account", detail: "No connected credential", versionId: null, revision: null, kind: "account" }],
      coverage: { kind: "bounded_candidates", complete: false, total: null, returned: 1, hasMore: null, nextCursor: null, limitation: "Original owner bounded choices" } });
    await verifyAgentResourceCandidates(candidates, query);
    await expect(verifyAgentResourceCandidates(candidates, { ...query, pageSize: 10 })).rejects.toThrow();
    expect(AgentResourceCandidatesSchema.safeParse({ ...candidates, coverage: { ...candidates.coverage, returned: 0 } }).success).toBe(false);
    expect(AgentResourceCandidatesSchema.safeParse({ ...candidates, items: [{ ...candidates.items[0], kind: "object" }] }).success).toBe(false);
    expect(AgentResourceMcpCandidatesRequestSchema.safeParse({ version: AGENT_RESOURCES_VERSION, kind: "candidates", query }).success).toBe(true);
  });
});
