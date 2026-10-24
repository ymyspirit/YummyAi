import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createEntityId } from "../common/ids.js";
import { canonicalJson } from "../common/canonical-json.js";
import { AGENT_LOOP_VERSION, AgentLoopDecisionSchema } from "./agent-loop.js";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandRequest } from "./agent-command.js";
import { AGENT_PLAN_VERSION, AgentPlanCommandKeySchema, AgentPlanDecisionSchema, AgentPlanDraftSchema,
  AgentPlanModelResultSchema, AgentPlanResolvedProposalSchema, AgentPlanIntentSchema, AgentPlanPreparationIntentSchema, AgentPlanReceiptSchema,
  AgentPlanItemReceiptSchema, CreateAgentPlanSchema, PrepareAgentPlanItemSchema, defaultAgentPlanLimits,
  maximumAgentPlanLimits } from "./agent-plan.js";
import { ProcurementCommandKindSchema } from "../procurement/procurement-command.js";
import { IncomingCommandKindSchema } from "../procurement/incoming-command.js";
import { ProductionCommandKindSchema } from "../order/production-command.js";
import { FinanceCommandKindSchema } from "../finance/finance-command.js";
import { AdCommandKindSchema } from "../customer-intelligence/advertising-command.js";

const hash = "a".repeat(64), time = "2026-10-22T00:00:00.000Z";
const contract = { contractVersion: "native-harness-v1", executorKey: "erp.agent.plan",
  skill: { key: "erp.agent.plan", version: AGENT_PLAN_VERSION, checksum: hash },
  tools: [{ key: "erp.agent.plan", version: AGENT_PLAN_VERSION, checksum: hash }], checksum: hash };
const request = () => ({ version: AGENT_PLAN_VERSION, requestId: randomUUID(), modelId: createEntityId(),
  goal: "  Synthetic original command planning  ", contextText: "Synthetic operator facts require individual original confirmation",
  allowedReads: ["inventory.balances.page"], allowedCommands: [{ domain: "procurement", kind: "requisition_create" }],
  maxCostUsd: 0.1, limits: defaultAgentPlanLimits(), executionContract: contract });
const original = (key = createEntityId()) => ({ domain: "procurement" as const, command: { kind: "requisition_create" as const, targetId: null,
  input: { code: "SYNTHETIC-PLAN", reasonCode: "SYNTHETIC", lines: [{ lineKey: "L1", stockItemId: createEntityId(),
    destinationLocationId: createEntityId(), quantity: "2.5", unit: "gram" as const }], idempotencyKey: key } } });
const draft = () => ({ position: 0, capability: { domain: "procurement", kind: "requisition_create" }, label: "Synthetic requisition draft",
  reason: "Requires original input review", original: original(), claims: [], missingInformation: [] });
const modelResult = () => ({ summary: "Unapproved synthetic proposals", claims: [], missingInformation: [], proposals: [draft()] });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describe("independent Agent planning and explicit original preparation contract", () => {
  it("pins37 original capabilities and bounded read selections without changing the old read-only v1 or accepting caller authority", () => {
    const families = [ProcurementCommandKindSchema, IncomingCommandKindSchema, ProductionCommandKindSchema, FinanceCommandKindSchema, AdCommandKindSchema];
    expect(families.map(value => value.options.length)).toEqual([9, 6, 3, 12, 7]);
    const domains = ["procurement", "incoming", "production", "finance", "advertising"];
    for (const [index, family] of families.entries()) for (const kind of family.options)
      expect(AgentPlanCommandKeySchema.safeParse({ domain: domains[index], kind }).success).toBe(true);
    const raw = request(); expect(CreateAgentPlanSchema.parse(raw).goal).toBe("Synthetic original command planning");
    expect(CreateAgentPlanSchema.parse({ ...raw, allowedReads: [], limits: maximumAgentPlanLimits() }).limits.maxProposals).toBe(8);
    for (const invalid of [{ ...raw, version: AGENT_LOOP_VERSION }, { ...raw, allowedCommands: [] },
      { ...raw, allowedCommands: [...raw.allowedCommands, ...raw.allowedCommands] }, { ...raw, allowedReads: ["inventory.recordMovement"] },
      { ...raw, tenantId: createEntityId() }, { ...raw, originCeiling: {} }, { ...raw, autoConfirm: true },
      { ...raw, maxCostUsd: 0.1234567 }, { ...raw, limits: { ...raw.limits, maxProposals: 9 } }])
      expect(CreateAgentPlanSchema.safeParse(invalid).success).toBe(false);
    expect(AgentLoopDecisionSchema.safeParse({ action: "finish", label: "old v1 must not gain planning",
      read: null, result: modelResult() }).success).toBe(false);
  });

  it("requires either an exact typed original draft or explicit missing information and rejects mismatched domain kind and business quantities", () => {
    const value = draft(); expect(AgentPlanDraftSchema.safeParse(value).success).toBe(true);
    expect(AgentPlanDraftSchema.parse({ ...value, original: null, missingInformation: ["No authorized supplier basis"] }).original).toBeNull();
    for (const invalid of [{ ...value, original: null }, { ...value, missingInformation: ["Missing but executable"] },
      { ...value, capability: { domain: "finance", kind: "bill_record" } }, { ...value, confirmed: true },
      { ...value, original: { ...value.original, command: { ...value.original.command, input: { ...value.original.command.input,
        lines: [{ ...value.original.command.input.lines[0]!, quantity: "2.0000000001" }] } } } },
      { ...value, original: { ...value.original, command: { ...value.original.command, input: { ...value.original.command.input,
        lines: [{ ...value.original.command.input.lines[0]!, unit: "each", quantity: "2.5" }] } } } }])
      expect(AgentPlanDraftSchema.safeParse(invalid).success).toBe(false);
  });

  it("retains a contiguous server slot prefix and binds every preparable original key and checksum presence to its resolved item", () => {
    const value = draft(), id = value.original.command.input.idempotencyKey;
    const resolved = { id, position: 0, proposalChecksum: hash, originalChecksum: hash, preparationRequestChecksum: hash, draft: value };
    expect(AgentPlanResolvedProposalSchema.parse(resolved).id).toBe(id);
    for (const invalid of [{ ...resolved, id: createEntityId() }, { ...resolved, position: 1 }, { ...resolved, originalChecksum: null },
      { ...resolved, preparationRequestChecksum: null }, { ...resolved, draft: { ...value, original: null, missingInformation: ["Unknown source"] } }])
      expect(AgentPlanResolvedProposalSchema.safeParse(invalid).success).toBe(false);
    expect(AgentPlanResolvedProposalSchema.safeParse({ ...resolved, originalChecksum: null, preparationRequestChecksum: null,
      draft: { ...value, original: null, missingInformation: ["Unknown source"] } }).success).toBe(true);
    for (const proposals of [[{ ...value, position: 1 }], [value, value], Array.from({ length: 9 }, (_, position) => ({ ...value, position }))])
      expect(AgentPlanModelResultSchema.safeParse({ ...modelResult(), proposals }).success).toBe(false);
  });

  it("accepts read or unapproved finish only and never treats model output as prepare confirm SQL or a dynamic network action", () => {
    const read = { action: "read", label: "Read original inventory", read: { tool: "inventory.balances.page", query: { stockItemId: null, locationId: null } }, result: null };
    expect(AgentPlanDecisionSchema.parse(read)).toEqual(read);
    expect(AgentPlanDecisionSchema.parse({ action: "finish", label: "Offer drafts", read: null, result: modelResult() }).result?.proposals).toHaveLength(1);
    for (const action of ["prepare", "confirm", "execute", "sql", "http"])
      expect(AgentPlanDecisionSchema.safeParse({ ...read, action }).success).toBe(false);
    expect(AgentPlanDecisionSchema.safeParse({ ...read, result: modelResult() }).success).toBe(false);
    expect(AgentPlanDecisionSchema.safeParse({ ...read, read: { ...read.read, query: { ...read.read.query, cursor: "model-selected" } } }).success).toBe(false);
  });

  it("keeps model-result proposal and original preparation hashes separate while preserving authored fields in the real command canonical body", () => {
    const value = original(), body = { version: AGENT_COMMAND_VERSION, requestId: value.command.input.idempotencyKey, original: value };
    const canonical = canonicalAgentCommandRequest("prepare", body), decision = { action: "finish", label: "Offer draft", read: null, result: modelResult() };
    const parsedDecision = AgentPlanDecisionSchema.parse(decision);
    expect(sha(canonical)).not.toBe(sha(canonicalJson(parsedDecision)));
    expect(canonicalAgentCommandRequest("prepare", { original: value, version: AGENT_COMMAND_VERSION, requestId: body.requestId })).toBe(canonical);
    expect(canonical).toContain(value.command.input.idempotencyKey);
    expect(sha(canonicalAgentCommandRequest("prepare", { ...body, original: { ...value,
      command: { ...value.command, input: { ...value.command.input, reasonCode: "DIFFERENT" } } } }))).not.toBe(sha(canonical));
    const preparation = { version: AGENT_PLAN_VERSION, requestId: randomUUID(), proposalChecksum: hash };
    expect(PrepareAgentPlanItemSchema.parse(preparation)).toEqual(preparation);
    expect(PrepareAgentPlanItemSchema.safeParse({ ...preparation, original: value }).success).toBe(false);
  });

  it("retains only seven recovery scalars and never turns not-found or an unknown item into an executable command receipt", () => {
    const requestId = randomUUID(), id = createEntityId(), value = { version: 1, ownerScope: hash, requestId, requestChecksum: hash, runId: null, state: "unknown", createdAt: time };
    expect(Object.keys(AgentPlanIntentSchema.parse(value))).toHaveLength(7);
    for (const key of ["goal", "contextText", "original", "confirmationToken", "cursor", "authority"])
      expect(AgentPlanIntentSchema.safeParse({ ...value, [key]: "synthetic-private" }).success).toBe(false);
    const receipt = { version: AGENT_PLAN_VERSION, requestId, requestChecksum: hash, disposition: "not_found", runId: null, status: null, contextAuthority: "synthetic", privateAvailable: false };
    expect(AgentPlanReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(AgentPlanReceiptSchema.safeParse({ ...receipt, runId: id }).success).toBe(false);
    const item = { version: AGENT_PLAN_VERSION, runId: id, itemId: createEntityId(), proposalChecksum: hash, preparationRequestChecksum: hash,
      disposition: "unknown", agentCommandId: null, ownerCommandId: null, contextAuthority: "synthetic" };
    expect(AgentPlanItemReceiptSchema.parse(item)).toEqual(item);
    expect(AgentPlanItemReceiptSchema.safeParse({ ...item, agentCommandId: createEntityId() }).success).toBe(false);
    expect(AgentPlanItemReceiptSchema.safeParse({ ...item, disposition: "known" }).success).toBe(false);
  });

  it("exports the complete transformed native wire schema while final decoding still enforces the original proposal refinements", () => {
    const inputSide = z.toJSONSchema(AgentPlanDecisionSchema, { io: "input" });
    const wire = z.fromJSONSchema(inputSide), transmitted = z.toJSONSchema(wire);
    expect(JSON.stringify(transmitted)).toContain("bill_record");
    expect(JSON.stringify(transmitted)).toContain("requisition_create");
    expect(JSON.stringify(transmitted)).toContain("idempotencyKey");
    const decision = { action: "finish", label: "Unapproved typed draft", read: null, result: modelResult() };
    expect(AgentPlanDecisionSchema.parse(wire.parse(decision))).toEqual(AgentPlanDecisionSchema.parse(decision));
    const invalid = { ...decision, result: { ...modelResult(), proposals: [{ ...draft(), original: null, missingInformation: [] }] } };
    // JSON-schema transmission cannot replace the authoritative superRefine.
    expect(AgentPlanDecisionSchema.safeParse(wire.parse(invalid)).success).toBe(false);
    expect(wire.safeParse({ ...decision, action: "execute" }).success).toBe(false);
  });

  it("keeps a separate preparation recovery marker to seven public scalars and never stores the original draft token or owner result", () => {
    const intent = { version: 1, ownerScope: hash, runId: createEntityId(), itemId: createEntityId(), proposalChecksum: hash, state: "unknown", createdAt: time };
    expect(Object.keys(AgentPlanPreparationIntentSchema.parse(intent))).toHaveLength(7);
    for (const key of ["original", "confirmationToken", "result", "authority", "nativeInput"])
      expect(AgentPlanPreparationIntentSchema.safeParse({ ...intent, [key]: "synthetic-private" }).success).toBe(false);
    expect(AgentPlanPreparationIntentSchema.safeParse({ ...intent, proposalChecksum: "short" }).success).toBe(false);
  });
});
