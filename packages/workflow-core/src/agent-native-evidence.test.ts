import { describe, expect, it } from "vitest";
import { Permission, erpPermissionContext } from "@yummyai/authz";
import { harnessChecksum } from "@yummyai/ai-core";
import { createEntityId, TenantContextSchema } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AGENT_READ_VERSION } from "@yummyai/contracts/ai/agent-read";
import { AGENT_TOOLS_VERSION, AgentToolDefinitionSchema, AgentToolResultSchema } from "@yummyai/contracts/ai/agent-tools";
import { AGENT_NATIVE_VERSION, AgentNativeObservationSchema, agentNativeSourceBasis, agentNativeObservationBasisPayload,
  agentNativeProposalChecksumPayload, agentNativeClaimValue, type AgentNativeClaim, type AgentNativeObservation } from "@yummyai/contracts/ai/agent-native";
import { agentNativeDecisionJsonSchema, agentNativeDecisionWireSchema, agentNativeSlots, resolveAgentNativeResult } from "./agent-native-model.js";
import { agentPlanSlots } from "./agent-plan-model.js";
import { buildNativeObservation, verifyNativeClaims } from "./agent-native-evidence.js";

const time = "2026-10-22T00:00:00.000Z", later = "2026-10-22T00:00:01.000Z", hash = "a".repeat(64);
const identity = TenantContextSchema.parse({ tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" });
const stamp = erpSessionAuthority(erpPermissionContext(identity));
const meta = () => ({ version: AGENT_TOOLS_VERSION, callId: createEntityId(), contextAuthority: stamp,
  checkedAt: time, definitionChecksum: hash, inputChecksum: hash, dataChecksum: hash });
function inventory(complete = true) {
  const id = createEntityId(), item = { id, dimensionKey: "actual-dimension", stockItemId: createEntityId(), locationId: createEntityId(), lotId: null, unit: "meter",
    physicalQuantity: "1.000000001", reservedQuantity: 0, availableQuantity: "1.000000001", inTransitQuantity: 0, providerQuantity: 0, virtualQuantity: 0, projectionVersion: 1, updatedAt: time };
  const data = { version: AGENT_READ_VERSION, effect: "read", tool: "inventory.balances.page", contextAuthority: stamp, checkedAt: time,
    collectionFingerprint: hash, total: complete ? 1 : 501, readCount: 1, consistency: "unchanged_collection", complete,
    nextCursor: complete ? null : "opaque-native-cursor", query: { stockItemId: item.stockItemId, pageSize: 1, cursor: null }, items: [item] };
  return AgentToolResultSchema.parse({ ...meta(), tool: "inventory.balances.page", data, dataChecksum: harnessChecksum(data),
    coverage: { kind: "paged_collection", complete, total: data.total, readCount: 1, nextCursor: data.nextCursor } });
}
function knowledge() {
  const entryId = createEntityId(), versionId = createEntityId(), data = { retrievedAt: time, mode: "keyword", scanned: 80, diagnostics: ["Original ranked subset"], references: [{
    sourceId: entryId, entryId, versionId, version: 2, title: "Synthetic published source", excerpt: "Quoted original evidence", sourceLabel: "Reviewed team source", sourceUrl: "",
    verifiedOn: "2026-01-01", reviewDueOn: "2099-12-31", checksum: hash, href: "/knowledge/" + entryId, score: 0.75 }] };
  return AgentToolResultSchema.parse({ ...meta(), tool: "knowledge.search", data, dataChecksum: harnessChecksum(data), coverage: { kind: "ranked_subset", complete: false, scanned: 80, returned: 1 } });
}
function capacity() {
  const id = createEntityId(), poolId = createEntityId(), versionId = createEntityId(), data = { contextAuthority: stamp, access: { canRead: true, canWrite: true },
    factoryId: id, from: "2026-10-22", days: 1, recordedAt: time, pools: [{ id: poolId, factoryId: id, code: "PURE", timeZone: "UTC", unit: "each",
      factoryVersionId: createEntityId(), versionId, versionNumber: 1, createdAt: time, profile: { name: "Synthetic unconfirmed pool", status: "draft", dailyCapacityUnits: null,
        weekly: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, intervals: [] })), exceptions: [], cutoffTime: null, bindings: [], evidenceReference: "", notes: "" } }],
    calendar: [{ poolId, poolVersionId: versionId, localDate: "2026-10-22", timeZone: "UTC", unit: "each", intervals: [], cutoffAt: null,
      capacityUnits: null, allocatedUnits: 0, committedUnits: 0, releasedUnits: 0, availableUnits: 0, blockers: ["Original capacity is unknown"] }] };
  return AgentToolResultSchema.parse({ ...meta(), tool: "factory.capacity", data, dataChecksum: harnessChecksum(data), coverage: { kind: "bounded_snapshot", complete: false, from: data.from, days: 1, pools: 1 } });
}
function observation(result = inventory(), complete = true): AgentNativeObservation {
  return AgentNativeObservationSchema.parse({ stepId: createEntityId(), tool: result.tool, request: { bindingIndex: 0, keyword: result.tool === "knowledge.search" ? "Evidence" : null },
    results: [result], basisChecksum: hash, observedRows: 1, collectionComplete: result.tool === "inventory.balances.page" ? complete : null, truncatedBy: complete ? null : "row_limit" });
}
const claim = (obs: AgentNativeObservation, path: AgentNativeClaim["path"], value: AgentNativeClaim["value"]): AgentNativeClaim => ({ stepId: obs.stepId, resultIndex: 0, dataChecksum: obs.results[0]!.dataChecksum, path, value });
const digest = (value: unknown) => harnessChecksum(value);
function authenticatedObservation(complete = true) {
  const result = inventory(complete); if (result.tool !== "inventory.balances.page") throw new Error("Wrong pure inventory fixture");
  result.inputChecksum = digest(result.data.query);
  return buildNativeObservation({ stepId: createEntityId(), input: { request: { bindings: [{ tool: result.tool, scope: { stockItemId: result.data.query.stockItemId } }] } },
    request: { bindingIndex: 0, keyword: null }, results: [result], truncatedBy: complete ? null : "row_limit" });
}

describe("native evidence bindings preserve original values without claiming commercial semantic correctness", () => {
  it("excludes only volatile native clock authority and cursor fields while retaining every original business source and exact quantity", () => {
    const result = inventory(); if (result.tool !== "inventory.balances.page") throw new Error("Wrong pure fixture");
    const refreshed = structuredClone(result); refreshed.callId = createEntityId(); refreshed.checkedAt = later; refreshed.data.checkedAt = later;
    refreshed.contextAuthority = "another current transport"; refreshed.data.contextAuthority = "another current transport";
    refreshed.data.query.cursor = "fresh opaque cursor"; refreshed.inputChecksum = "b".repeat(64); refreshed.dataChecksum = "c".repeat(64);
    expect(digest(agentNativeSourceBasis(refreshed))).toBe(digest(agentNativeSourceBasis(result)));
    for (const update of [() => { refreshed.data.items[0]!.physicalQuantity = "1.000000002"; }, () => { refreshed.data.items[0]!.unit = "each"; },
      () => { refreshed.data.collectionFingerprint = "d".repeat(64); }, () => { refreshed.data.total = 2; }]) {
      const before = digest(agentNativeSourceBasis(refreshed)); update(); expect(digest(agentNativeSourceBasis(refreshed))).not.toBe(before);
    }
    expect((agentNativeSourceBasis(result) as { data: { items: unknown[] } }).data.items).toHaveLength(1);
  });

  it("does not reinterpret ranked topK or fixed capacity as a complete corpus and binds nested source hashes and null capacity exactly", () => {
    const kb = knowledge(), factory = capacity(); if (kb.tool !== "knowledge.search" || factory.tool !== "factory.capacity") throw new Error("Wrong pure fixture");
    const nextKb = structuredClone(kb); nextKb.data.retrievedAt = later;
    expect(digest(agentNativeSourceBasis(nextKb))).toBe(digest(agentNativeSourceBasis(kb)));
    nextKb.data.references[0]!.checksum = "b".repeat(64); expect(digest(agentNativeSourceBasis(nextKb))).not.toBe(digest(agentNativeSourceBasis(kb)));
    const nextFactory = structuredClone(factory); nextFactory.data.recordedAt = later; nextFactory.data.access.canWrite = false;
    expect(digest(agentNativeSourceBasis(nextFactory))).toBe(digest(agentNativeSourceBasis(factory)));
    nextFactory.data.calendar[0]!.capacityUnits = 0; expect(digest(agentNativeSourceBasis(nextFactory))).not.toBe(digest(agentNativeSourceBasis(factory)));
    const factoryObservation = observation(factory);
    expect(agentNativeClaimValue(factoryObservation, claim(factoryObservation, ["calendar", 0, "capacityUnits"], null))).toBeNull();
    expect((agentNativeSourceBasis(kb) as { coverage: unknown }).coverage).toMatchObject({ complete: false, kind: "ranked_subset" });
  });

  it("resolves only an own scalar path at its exact observation and result checksum and rejects authority prototype object and incomplete-total claims", () => {
    const full = authenticatedObservation(), partial = authenticatedObservation(false);
    expect(agentNativeClaimValue(full, claim(full, ["items", 0, "physicalQuantity"], "1.000000001"))).toBe("1.000000001");
    expect(agentNativeClaimValue(full, claim(full, ["total"], 1))).toBe(1);
    for (const invalid of [{ ...claim(full, ["total"], 1), stepId: createEntityId() }, { ...claim(full, ["total"], 1), resultIndex: 1 },
      { ...claim(full, ["total"], 1), dataChecksum: "f".repeat(64) }, claim(full, ["items", 0], null), claim(full, ["items", "0", "unit"], "meter"),
      claim(full, ["contextAuthority"], stamp), claim(full, ["items", 0, "constructor"], null)]) expect(() => agentNativeClaimValue(full, invalid)).toThrow("agent_native_claim_invalid");
    expect(() => agentNativeClaimValue(partial, claim(partial, ["total"], 501))).toThrow("agent_native_claim_invalid");
    // The lookup returns the real scalar; runtime adoption must compare it with
    // the claimed value. A claimed different unit never changes original data.
    expect(agentNativeClaimValue(full, claim(full, ["items", 0, "unit"], "USD")) === "USD").toBe(false);
    expect(() => verifyNativeClaims({ claims: [claim(full, ["items", 0, "unit"], "meter")], proposals: [] }, [full])).not.toThrow();
    for (const invalid of [claim(full, ["items", 0, "unit"], "USD"), claim(full, ["items", 0, "physicalQuantity"], 1), claim(full, ["total"], 999)])
      expect(() => verifyNativeClaims({ claims: [invalid], proposals: [] }, [full])).toThrow("agent_native_claim_invalid");
    expect(() => verifyNativeClaims({ claims: [], proposals: [] }, [{ ...full, basisChecksum: "f".repeat(64) }])).toThrow("agent_native_evidence_invalid");
  });

  it("binds collection basis to the fixed binding keyword full result and explicit truncation rather than an unrelated matching answer", () => {
    const value = observation(knowledge()), base = digest(agentNativeObservationBasisPayload(value));
    expect(digest(agentNativeObservationBasisPayload({ ...value, request: { ...value.request, bindingIndex: 1 } }))).not.toBe(base);
    expect(digest(agentNativeObservationBasisPayload({ ...value, request: { ...value.request, keyword: "Different original question" } }))).not.toBe(base);
    expect(digest(agentNativeObservationBasisPayload({ ...value, observedRows: 0 }))).not.toBe(base);
    const full = observation(), prefix = { ...full, collectionComplete: false, truncatedBy: "row_limit" as const };
    expect(digest(agentNativeObservationBasisPayload(prefix))).not.toBe(digest(agentNativeObservationBasisPayload(full)));
    const original = authenticatedObservation(), page = original.results[0]!;
    if (page.tool !== "inventory.balances.page") throw new Error("Wrong pure fixture");
    const args = { stepId: original.stepId, input: { request: { bindings: [{ tool: page.tool, scope: { stockItemId: page.data.query.stockItemId } }] } }, request: original.request,
      results: [page], truncatedBy: null };
    expect(() => buildNativeObservation({ ...args, results: [{ ...page, inputChecksum: "f".repeat(64) }] })).toThrow("agent_native_evidence_invalid");
    expect(() => buildNativeObservation({ ...args, results: [page, page] })).toThrow("agent_native_evidence_invalid");
  });

  it("normalizes only a previously loaded selected original branch with the existing server slot and binds proposal hashes to the actual cited claims", () => {
    const runId = createEntityId(), slot = agentNativeSlots(runId, 2)[0]!; expect(agentNativeSlots(runId, 2)).toEqual(agentPlanSlots(runId, 2));
    const original = { domain: "finance", command: { kind: "bill_record", targetId: null, input: { supplierId: createEntityId(), kind: "supplier_invoice", externalBillId: "PURE-NATIVE",
      currency: "USD", amountMinor: 12345, issuedAt: time, dueAt: null, procurementInvoiceId: null, idempotencyKey: slot.idempotencyKey } } };
    const observed = observation(), claims = [claim(observed, ["items", 0, "physicalQuantity"], "1.000000001"), claim(observed, ["items", 0, "unit"], "meter")];
    const raw = { summary: "Unapproved operator-supplied amount is not established by source quantity", claims, missingInformation: [], proposals: [{ position: 0,
      capability: { domain: "finance", kind: "bill_record" }, label: "Review original bill", reason: "Requires separate original review", draftJson: JSON.stringify(original), claimIndexes: [0, 1], missingInformation: [] }] };
    const definition = AgentToolDefinitionSchema.parse({ version: AGENT_TOOLS_VERSION, contextAuthority: stamp, selection: { kind: "command", command: raw.proposals[0]!.capability },
      definitionChecksum: hash, inputSchema: { type: "object" }, outputSchema: { type: "object" }, effect: "prepare_original_command", available: true, blockReason: null,
      execution: "separate_original_preparation_and_confirmation", limitations: [] });
    const definitions = [{ stepId: createEntityId(), definition }], allowed = [{ domain: "finance" as const, kind: "bill_record" as const }];
    expect(() => resolveAgentNativeResult(runId, raw, allowed, 2, [])).toThrow("agent_proposal_not_allowed");
    const result = resolveAgentNativeResult(runId, raw, allowed, 2, definitions), proposal = result.proposals[0]!;
    expect(proposal.id).toBe(slot.id); expect(proposal.proposalChecksum).toBe(digest(agentNativeProposalChecksumPayload(proposal, claims)));
    const changed = structuredClone(claims); changed[0]!.value = "999";
    expect(digest(agentNativeProposalChecksumPayload(proposal, changed))).not.toBe(proposal.proposalChecksum);
    expect(digest(agentNativeProposalChecksumPayload({ ...proposal, claimIndexes: [1, 0] }, claims))).not.toBe(proposal.proposalChecksum);
    expect(resolveAgentNativeResult(runId, { ...raw, claims: [...claims, claim(observed, ["total"], 1)] }, allowed, 2, definitions).proposals[0]!.proposalChecksum).toBe(proposal.proposalChecksum);
    for (const invalid of [{ ...raw, proposals: [{ ...raw.proposals[0], claimIndexes: [0, 0] }] }, { ...raw, proposals: [{ ...raw.proposals[0], draftJson: JSON.stringify({ ...original,
      command: { ...original.command, input: { ...original.command.input, idempotencyKey: createEntityId() } } }) }] }]) expect(() => resolveAgentNativeResult(runId, invalid, allowed, 2, definitions)).toThrow();
  });

  it("keeps the paid decision wire limited to on-demand draft text and still rejects execution decisions when decoding strict native protocol", () => {
    const wire = JSON.stringify(agentNativeDecisionJsonSchema); expect(Buffer.byteLength(wire)).toBeLessThan(40_000);
    expect(wire).toContain("draftJson"); expect(wire.includes("expectedPurchaseOrderVersionId")).toBe(false); expect(wire.includes("procurementInvoiceId")).toBe(false);
    expect(agentNativeDecisionWireSchema.safeParse({ action: "finish", label: "No business command is executed", definition: null, read: null,
      result: { summary: "Native bounded evidence only", claims: [], proposals: [], missingInformation: [] } }).success).toBe(true);
    expect(agentNativeDecisionWireSchema.safeParse({ action: "execute", label: "Forbidden", definition: null, read: null, result: null }).success).toBe(false);
    expect(AGENT_NATIVE_VERSION).toBe("erp-agent-native-v1");
  });
});
