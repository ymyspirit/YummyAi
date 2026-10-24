import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Permission, erpPermissionContext } from "@yummyai/authz";
import { createEntityId, TenantContextSchema } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_FULFILLMENT_TOOL, AGENT_FULFILLMENT_VERSION, AgentFulfillmentCallSchema, AgentFulfillmentDefinitionSchema,
  AgentFulfillmentResultSchema, agentFulfillmentDataPayload, agentFulfillmentDefinitionPayload, canonicalAgentFulfillmentCall, type AgentFulfillmentResult } from "@yummyai/contracts/ai/agent-fulfillment";
import { AGENT_NATIVE_V3_VERSION, AgentNativeV3PinnedInputSchema, defaultAgentNativeV3Limits, agentNativeV3SourceBasis,
  agentNativeV3ClaimValue, agentNativeV3ProposalChecksumPayload, type AgentNativeV3Claim, type AgentNativeV3Observation } from "@yummyai/contracts/ai/agent-native-v3";
import { agentNativeChecksum } from "./agent-native-model.js";
import { agentToolsHarness, agentToolsSkill } from "./agent-tools-gateway.js";
import { agentResourcesHarness, agentResourcesSkill } from "./agent-resources-gateway.js";
import { agentFulfillmentHarness, agentFulfillmentSkill } from "./agent-fulfillment-gateway.js";
import { agentNativeV3Harness, agentNativeV3Skill, agentNativeV3ReadSkill, agentNativeV3DecisionJsonSchema, agentNativeV3DecisionWireSchema } from "./agent-native-v3-model.js";
import { buildNativeV3Observation, verifyNativeV3Claims, recheckNativeV3Evidence } from "./agent-native-v3-evidence.js";
import type { NativePorts } from "./agent-native-protocol.js";

const time = "2026-10-22T00:00:00.000Z", hash = "a".repeat(64), checksum = agentNativeChecksum;
const context = TenantContextSchema.parse({ tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" });
const authority = erpSessionAuthority(erpPermissionContext(context)), orderId = createEntityId(), lineId = createEntityId();
const pin = agentFulfillmentHarness.pin(agentFulfillmentSkill), binding = { tool: AGENT_FULFILLMENT_TOOL, scope: { orderId, expectedSequence: 3, kind: "logistics" as const } };
const definition = AgentFulfillmentDefinitionSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL, contextAuthority: authority,
  label: "Original logistics evidence", available: true, blockReason: null, definitionChecksum: hash, inputSchema: { type: "object" }, outputSchema: { type: "object" },
  effect: "read", execution: "original_owner_fulfillment_projection", limitations: ["One original order index is not complete business coverage"] });
definition.definitionChecksum = checksum(agentFulfillmentDefinitionPayload(definition));
const pinned = () => AgentNativeV3PinnedInputSchema.parse({ version: AGENT_NATIVE_V3_VERSION,
  request: { version: AGENT_NATIVE_V3_VERSION, requestId: randomUUID(), goal: "Read one fixed original logistics index", contextText: "Unverified notes", modelId: createEntityId(),
    bindings: [binding], allowedCommands: [], limits: defaultAgentNativeV3Limits(), maxCostUsd: 1, executionContract: agentNativeV3Harness.pin(agentNativeV3Skill) },
  ceiling: context, model: { id: createEntityId(), model: "synthetic", label: "Synthetic", providerLabel: "Synthetic", providerConfigId: createEntityId(),
    routeFingerprint: hash, inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 },
  readExecutionContract: agentNativeV3Harness.pin(agentNativeV3ReadSkill), legacyReadExecutionContract: agentToolsHarness.pin(agentToolsSkill),
  resourceExecutionContract: agentResourcesHarness.pin(agentResourcesSkill), fulfillmentExecutionContract: pin });
function page(cursor: string | null, last: boolean, savedPin = pin): AgentFulfillmentResult {
  const id = createEntityId(), connectionVersionId = createEntityId();
  const call = AgentFulfillmentCallSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL,
    executionContract: savedPin, definitionChecksum: definition.definitionChecksum, input: { ...binding.scope, cursor, pageSize: 1 } });
  const value = AgentFulfillmentResultSchema.parse({ version: AGENT_FULFILLMENT_VERSION, tool: AGENT_FULFILLMENT_TOOL, callId: createEntityId(),
    contextAuthority: authority, checkedAt: time, readStartedAt: time, input: call.input, definitionChecksum: definition.definitionChecksum,
    inputChecksum: checksum(JSON.parse(canonicalAgentFulfillmentCall(call))), dataChecksum: hash,
    sources: [{ owner: "orders", kind: "order", id: orderId, versionId: null, revision: 3, checksum: null },
      { owner: "logistics", kind: "logistics_task", id, versionId: connectionVersionId, revision: null, checksum: hash }],
    data: { kind: "logistics", order: { id: orderId, number: "SYNTHETIC-ORIGINAL", sequence: 3, mainState: "in_production", sideState: null,
      lines: [{ id: lineId, quantity: 5, sku: null }] },
      rows: [{ id, orderId, factoryId: createEntityId(), status: "completed", privateAvailable: true, createdAt: time, updatedAt: time, expiresAt: time,
        connectionVersionId, ruleVersionId: createEntityId(), productionVersionIds: [], snapshotChecksum: hash, quotedCostMinor: 500,
        actualCostMinor: 600, quotedCurrency: "USD", actualCurrency: "USD", minorUnitDigits: 2, trackingCount: 1, labelCount: 0 }],
      coverage: { complete: false, kind: "original_owner_page_projection", returned: 1, indexedTotal: 2, hasMore: !last, nextCursor: last ? null : "original-second-page",
        collectionChecksum: hash, limitation: "An exhausted original index is not an assertion of complete physical business facts" } },
    consistency: "owner_reads_fenced_not_single_transaction_snapshot", modelCalled: false, businessExecuted: false });
  value.dataChecksum = checksum(agentFulfillmentDataPayload(value)); return value;
}
function observed(results = [page(null, false), page("original-second-page", true)], savedPin = pin): AgentNativeV3Observation {
  return buildNativeV3Observation({ stepId: createEntityId(), input: { request: { bindings: [binding] }, fulfillmentExecutionContract: savedPin },
    request: { bindingIndex: 0, keyword: null }, results, truncatedBy: null });
}
const claim = (observation: AgentNativeV3Observation, path: AgentNativeV3Claim["path"], value: AgentNativeV3Claim["value"]): AgentNativeV3Claim =>
  ({ stepId: observation.stepId, resultIndex: 1, dataChecksum: observation.results[1]!.dataChecksum, path, value });

describe("native v3 sealed fulfillment evidence boundaries", () => {
  it("checks every fixed page and original cursor row identity total kind checksum and saved execution pin", () => {
    const first = page(null, false), second = page("original-second-page", true), value = observed([first, second]);
    expect(value).toMatchObject({ observedRows: 2, collectionComplete: null, indexComplete: true, truncatedBy: null });
    expect(value.results.every(result => result.version === AGENT_FULFILLMENT_VERSION && result.data.coverage.complete === false)).toBe(true);
    for (const altered of [[first, first], [second, first], [first, { ...second, inputChecksum: "f".repeat(64) }],
      [first, { ...second, input: { ...second.input, kind: "production" } }], [first, { ...second, data: { ...second.data, order: { ...second.data.order, sequence: 4 } } }]])
      expect(() => observed(altered as AgentFulfillmentResult[])).toThrow();
    const savedPin = { ...pin, checksum: "b".repeat(64) }, savedPages = [page(null, false, savedPin), page("original-second-page", true, savedPin)];
    expect(() => observed(savedPages, savedPin)).not.toThrow();
    expect(() => observed(savedPages, pin)).toThrow();
    const prefix = buildNativeV3Observation({ stepId: createEntityId(), input: { request: { bindings: [binding] }, fulfillmentExecutionContract: pin },
      request: { bindingIndex: 0, keyword: null }, results: [first], truncatedBy: "row_limit" });
    expect(prefix).toMatchObject({ collectionComplete: null, indexComplete: false, truncatedBy: "row_limit" });
  });

  it("retains exact quoted actual money currencies and nulls and refuses borrowed envelope totals objects and mismatched source scalars", () => {
    const value = observed(), valid = claim(value, ["rows", 0, "actualCostMinor"], 600);
    expect(agentNativeV3ClaimValue(value, valid)).toBe(600); expect(() => verifyNativeV3Claims({ claims: [valid], proposals: [] }, [value])).not.toThrow();
    for (const invalid of [{ ...valid, value: 6 }, claim(value, ["rows", 0, "actualCurrency"], "EUR"), claim(value, ["rows", 0, "minorUnitDigits"], 3),
      { ...valid, resultIndex: 0 }, { ...valid, dataChecksum: hash }, claim(value, ["coverage", "indexedTotal"], 2), claim(value, ["rows", 0], null)])
      expect(() => verifyNativeV3Claims({ claims: [invalid], proposals: [] }, [value])).toThrow();
    const before = value.results[1]!, altered = structuredClone(before);
    if (altered.version !== AGENT_FULFILLMENT_VERSION || altered.data.kind !== "logistics") throw new Error("Synthetic original logistics expected");
    altered.callId = createEntityId(); altered.contextAuthority = "another-current-authority"; altered.checkedAt = "2026-10-23T00:00:00.000Z";
    altered.readStartedAt = altered.checkedAt; expect(checksum(agentNativeV3SourceBasis(altered))).toBe(checksum(agentNativeV3SourceBasis(before)));
    altered.data.rows[0]!.actualCostMinor = null; expect(checksum(agentNativeV3SourceBasis(altered))).not.toBe(checksum(agentNativeV3SourceBasis(before)));
    const draft = { draft: { original: "unapproved" }, claimIndexes: [0] } as unknown as Parameters<typeof agentNativeV3ProposalChecksumPayload>[0];
    expect(checksum(agentNativeV3ProposalChecksumPayload(draft, [valid]))).not.toBe(checksum(agentNativeV3ProposalChecksumPayload(draft, [{ ...valid, value: 6 }])));
  });

  it("rechecks the full second sealed page even when first-page facts order sequence and index checksum remain unchanged", async () => {
    const input = pinned(), value = observed(), definitions = [{ stepId: createEntityId(), definition }], calls: Array<string | null> = [];
    const unused = async (): Promise<never> => { throw new Error("Unselected pure port was unexpectedly used"); };
    const ports: NativePorts = { tools: { workspace: unused, definition: unused, call: unused } };
    const second = structuredClone(value.results[1]!);
    if (second.version !== AGENT_FULFILLMENT_VERSION || second.data.kind !== "logistics") throw new Error("Synthetic original logistics expected");
    second.data.rows[0]!.actualCostMinor = 601; second.dataChecksum = checksum(agentFulfillmentDataPayload(second));
    await expect(recheckNativeV3Evidence(input, definitions, [value], ports, async () => context, {
      definition: async () => definition, call: async (_context, call) => {
        if (call.version !== AGENT_FULFILLMENT_VERSION) throw new Error("Wrong delegated pure protocol");
        calls.push(call.input.cursor); return call.input.cursor === null ? value.results[0]! : second;
      },
    })).rejects.toThrow("agent_native_source_changed");
    expect(calls).toEqual([null, "original-second-page"]);
    expect(second.data.coverage.collectionChecksum).toBe(AgentFulfillmentResultSchema.parse(value.results[1]).data.coverage.collectionChecksum);
  });

  it("advertises on-demand strict decisions without business execution or silently embedding all thirty-seven original schemas", () => {
    const wire = JSON.stringify(agentNativeV3DecisionJsonSchema); expect(Buffer.byteLength(wire)).toBeLessThan(50_000);
    expect(wire).toContain("draftJson"); expect(wire.includes("expectedPurchaseOrderVersionId")).toBe(false);
    for (const action of ["prepare", "execute", "confirm"])
      expect(agentNativeV3DecisionWireSchema.safeParse({ action, label: "A model cannot directly write business state", definition: null, read: null, result: null }).success).toBe(false);
    expect(agentNativeV3DecisionWireSchema.safeParse({ action: "definition", label: "Discover original fulfillment schema", definition: { kind: "read", tool: AGENT_FULFILLMENT_TOOL }, read: null, result: null }).success).toBe(true);
  });
});
