import { describe, expect, it } from "vitest";
import { ProcurementCommandKindSchema } from "../procurement/procurement-command.js";
import { IncomingCommandKindSchema } from "../procurement/incoming-command.js";
import { FinanceCommandKindSchema } from "../finance/finance-command.js";
import { AdCommandKindSchema } from "../customer-intelligence/advertising-command.js";
import { ProductionCommandKindSchema } from "../order/production-command.js";
import { FulfillmentCommandKindSchema, PrepareFulfillmentCommandSchema, fulfillmentCommandCanonicalJson } from "../order/fulfillment-command.js";
import { AGENT_COMMAND_VERSION, AgentCommandConfirmationSchema, PrepareAgentCommandSchema } from "./agent-command.js";
import { AgentNativeV3DraftSchema } from "./agent-native-v3.js";
import {
  AGENT_COMMAND_CATALOG_V2_VERSION, AGENT_FULFILLMENT_COMMAND_VERSION, AgentCommandV2CatalogSchema,
  AgentCommandV2CapabilitySchema, AgentFulfillmentCommandWorkspaceSchema, PrepareAgentFulfillmentCommandSchema,
  AgentFulfillmentCommandViewSchema, AgentFulfillmentCommandReceiptSchema, AgentFulfillmentConfirmationSchema,
  AgentFulfillmentCommandIntentSchema, ConfirmAgentFulfillmentCommandSchema, canonicalAgentFulfillmentOriginal,
} from "./agent-fulfillment-command.js";

const id = "01999cab-abcd-7000-8000-000000000001", other = "01999cab-abcd-7000-8000-000000000002";
const requestId = "64f9ae8a-c894-4fb2-8589-f93e0293a010", hash = "a".repeat(64);
const now = "2026-10-23T00:00:00.000Z", later = "2026-10-23T00:05:00.000Z";
const original = PrepareFulfillmentCommandSchema.parse({ requestId, kind: "production_milestone", targetId: id,
  input: { type: "started", expectedProjectionVersion: 1, externalEventId: "SYNTHETIC-Mixed-CASE",
    occurredAt: now, evidence: { code: "SYNTHETIC", note: "Original authored observation", assetIds: [] } } });
const descriptor = { label: "Synthetic contract capability", effect: "prepare_original_command", preparation: "registered_original_owner",
  execution: "exact_operator_confirmation", externalEffect: "internal_record_only", available: true, blockReason: null };
function catalog() {
  const legacy = [
    ...ProcurementCommandKindSchema.options.map(kind => ({ domain: "procurement", kind })),
    ...IncomingCommandKindSchema.options.map(kind => ({ domain: "incoming", kind })),
    ...ProductionCommandKindSchema.options.map(kind => ({ domain: "production", kind })),
    ...FinanceCommandKindSchema.options.map(kind => ({ domain: "finance", kind })),
    ...AdCommandKindSchema.options.map(kind => ({ domain: "advertising", kind })),
  ];
  return [...legacy.map(item => ({ ...descriptor, ...item, protocol: AGENT_COMMAND_VERSION })),
    ...FulfillmentCommandKindSchema.options.map(kind => ({ ...descriptor, domain: "fulfillment", kind, protocol: AGENT_FULFILLMENT_COMMAND_VERSION }))];
}
function token() {
  return { version: AGENT_FULFILLMENT_COMMAND_VERSION, purpose: "agent_fulfillment_confirm", intentId: id, requestId,
    requestChecksum: hash, originalChecksum: hash, kind: original.kind, targetId: original.targetId, orderId: id, lineIds: [other],
    tenantId: id, userId: other, ceilingChecksum: hash, currentAuthority: hash, generation: 0,
    expectedStatus: "prepared", decision: "execute_original", issuedAt: now, expiresAt: later };
}
function view() {
  return { version: AGENT_FULFILLMENT_COMMAND_VERSION, contextAuthority: "synthetic-personal-authority", original, originalChecksum: hash,
    native: { id, requestId, requestChecksum: hash, kind: original.kind, targetId: original.targetId, orderId: id, lineIds: [other],
      status: "prepared", createdAt: now, expiresAt: "2026-10-24T00:00:00.000Z", leaseExpiresAt: null, acknowledged: false,
      canExecute: true, canCancel: true, summary: { orderNumber: "SYNTHETIC", lineCount: 1, label: "Synthetic original" }, receipt: null, errorCode: null },
    privateAvailable: true, confirmationToken: "synthetic-server-encrypted-token", confirmationExpiresAt: later,
    confirmationDecision: "execute_original", canConfirm: true, canCancel: true, canAcknowledge: false };
}

describe("independent Agent original fulfillment protocol", () => {
  it("retains the exact original37 and fourteen finite owner operations in an explicitly non-model catalog", () => {
    const values = AgentCommandV2CatalogSchema.parse(catalog());
    expect(values.filter(item => item.protocol === AGENT_COMMAND_VERSION)).toHaveLength(37);
    expect(values.filter(item => item.domain === "fulfillment").map(item => item.kind)).toEqual(FulfillmentCommandKindSchema.options);
    const workspace = { version: AGENT_FULFILLMENT_COMMAND_VERSION, catalogVersion: AGENT_COMMAND_CATALOG_V2_VERSION,
      contextAuthority: "synthetic-authority", capabilities: values, modelProposalState: "not_integrated", autonomousWrites: false, confirmationTtlSeconds: 300 };
    expect(AgentFulfillmentCommandWorkspaceSchema.parse(workspace)).toEqual(workspace);
    for (const capabilities of [values.slice(1), [...values.slice(0, -1), values[0]], [...values, values[0]]])
      expect(AgentCommandV2CatalogSchema.safeParse(capabilities).success).toBe(false);
    expect(AgentFulfillmentCommandWorkspaceSchema.safeParse({ ...workspace, autonomousWrites: true }).success).toBe(false);
    expect(AgentFulfillmentCommandWorkspaceSchema.safeParse({ ...workspace, modelProposalState: "integrated" }).success).toBe(false);
    const current = values.find(item => item.domain === "fulfillment");
    if (!current) throw new Error("synthetic_fulfillment_catalog_missing");
    for (const extra of [{ protocol: AGENT_COMMAND_VERSION }, { kind: "arbitrary_http" }, { externalEffect: "original_production_release" }])
      expect(AgentCommandV2CapabilitySchema.safeParse({ ...current, ...extra }).success).toBe(false);
  });

  it("preserves the original durable canonical identity and rejects old protocol or caller execution additions", () => {
    const input = { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: id, original };
    expect(PrepareAgentFulfillmentCommandSchema.parse(input).original).toEqual(original);
    expect(canonicalAgentFulfillmentOriginal(original)).toBe(fulfillmentCommandCanonicalJson(original));
    expect(canonicalAgentFulfillmentOriginal(original)).toContain("SYNTHETIC-Mixed-CASE");
    for (const extra of [{ version: AGENT_COMMAND_VERSION }, { execute: true }, { confirmationToken: "caller-token" }, { tenantId: other }])
      expect(PrepareAgentFulfillmentCommandSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(PrepareAgentFulfillmentCommandSchema.safeParse({ ...input, orderId: id.toUpperCase() }).success).toBe(false);
    expect(PrepareAgentCommandSchema.safeParse({ version: AGENT_COMMAND_VERSION, requestId,
      original: { domain: "fulfillment", command: original } }).success).toBe(false);
    const legacyDraft = { position: 0, capability: { domain: "production", kind: "reviewed_line" },
      label: "Synthetic", reason: "Synthetic", draftJson: "{}", claimIndexes: [], missingInformation: [] };
    expect(AgentNativeV3DraftSchema.parse(legacyDraft)).toEqual(legacyDraft);
    expect(AgentNativeV3DraftSchema.safeParse({ ...legacyDraft, capability: { domain: "fulfillment", kind: original.kind } }).success).toBe(false);
  });

  it("requires independent purpose status generation exact coordinates and bounded short approval without accepting an old token payload", () => {
    expect(AgentFulfillmentConfirmationSchema.parse(token())).toEqual(token());
    const resumed = { ...token(), expectedStatus: "uncertain", decision: "resume_original", generation: 2 };
    expect(AgentFulfillmentConfirmationSchema.parse(resumed)).toEqual(resumed);
    for (const extra of [{ version: AGENT_COMMAND_VERSION }, { purpose: "agent_command_confirm" }, { expectedStatus: "succeeded" },
      { expectedStatus: "uncertain" }, { generation: -1 }, { lineIds: [id, id] }, { expiresAt: now }, { expiresAt: "2026-10-23T00:05:00.001Z" },
      { currentAuthority: "raw-personal-authority" }, { autoConfirm: true }])
      expect(AgentFulfillmentConfirmationSchema.safeParse({ ...token(), ...extra }).success).toBe(false);
    const legacy = { version: AGENT_COMMAND_VERSION, id, requestId, tenantId: id, userId: other, ownerCommandId: id,
      originalChecksum: hash, ceilingChecksum: hash, currentAuthority: hash, issuedAt: now, expiresAt: later };
    expect(AgentCommandConfirmationSchema.parse(legacy)).toEqual(legacy);
    expect(AgentFulfillmentConfirmationSchema.safeParse(legacy).success).toBe(false);
    expect(AgentCommandConfirmationSchema.safeParse(token()).success).toBe(false);
    const confirm = { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: id, requestId, requestChecksum: hash,
      originalChecksum: hash, confirmationToken: "synthetic-only", decision: "execute_original" };
    expect(ConfirmAgentFulfillmentCommandSchema.parse(confirm)).toEqual(confirm);
    for (const extra of [{ decision: "confirm_all" }, { ownerCommandId: id }, { authority: hash }])
      expect(ConfirmAgentFulfillmentCommandSchema.safeParse({ ...confirm, ...extra }).success).toBe(false);
  });

  it("never offers confirmation or a private receipt without the original owner input and exact live state", () => {
    const value = view(); expect(AgentFulfillmentCommandViewSchema.parse(value).native.id).toBe(id);
    for (const extra of [{ original: null }, { originalChecksum: "b".repeat(64) }, { confirmationDecision: "resume_original" },
      { confirmationToken: null }, { canConfirm: false }, { confirmationExpiresAt: "2026-10-25T00:00:00.000Z" }])
      expect(AgentFulfillmentCommandViewSchema.safeParse({ ...value, ...extra }).success).toBe(false);
    const minimal = { ...value, original: null, originalChecksum: null, privateAvailable: false, confirmationToken: null,
      confirmationExpiresAt: null, confirmationDecision: null, canConfirm: false, canCancel: false,
      native: { ...value.native, status: "expired", summary: null, canExecute: false, canCancel: false } };
    expect(AgentFulfillmentCommandViewSchema.parse(minimal).privateAvailable).toBe(false);
    expect(AgentFulfillmentCommandViewSchema.safeParse({ ...minimal, native: value.native }).success).toBe(false);
    expect(AgentFulfillmentCommandViewSchema.safeParse({ ...value, original: { ...original, requestId: "64f9ae8a-c894-4fb2-8589-f93e0293a011" } }).success).toBe(false);
  });

  it("keeps recovery to exact nonprivate original coordinates without storing body tokens raw authority or original business keys", () => {
    const intent = { version: AGENT_FULFILLMENT_COMMAND_VERSION, ownerScope: hash, orderId: id, requestId,
      requestChecksum: hash, id: null, state: "unknown", createdAt: now };
    expect(Object.keys(AgentFulfillmentCommandIntentSchema.parse(intent))).toHaveLength(8);
    for (const field of ["original", "confirmationToken", "rawRequestKey", "authority", "summary", "receipt"])
      expect(AgentFulfillmentCommandIntentSchema.safeParse({ ...intent, [field]: "synthetic-private" }).success).toBe(false);
    const receipt = { version: AGENT_FULFILLMENT_COMMAND_VERSION, orderId: id, requestId, requestChecksum: hash,
      contextAuthority: "synthetic-authority", disposition: "not_found", id: null, privateAvailable: false };
    expect(AgentFulfillmentCommandReceiptSchema.parse(receipt).disposition).toBe("not_found");
    expect(AgentFulfillmentCommandReceiptSchema.safeParse({ ...receipt, disposition: "known" }).success).toBe(false);
    expect(AgentFulfillmentCommandReceiptSchema.safeParse({ ...receipt, id }).success).toBe(false);
    expect(AgentFulfillmentCommandReceiptSchema.safeParse({ ...receipt, requestId: requestId.toUpperCase() }).success).toBe(false);
    expect(AgentFulfillmentCommandReceiptSchema.safeParse({ ...receipt, original }).success).toBe(false);
  });
});
