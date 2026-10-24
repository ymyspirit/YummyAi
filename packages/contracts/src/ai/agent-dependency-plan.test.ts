import { describe, expect, it } from "vitest";
import {
  AGENT_DEPENDENCY_PLAN_VERSION as version, AGENT_DEPENDENCY_PLAN_KIND as kind,
  AgentDependencyPlanBillDraftSchema, AgentDependencyPlanIntentSchema, AgentDependencyPlanPageSchema,
  AgentDependencyPlanReceiptSchema, AgentDependencyPlanSourceSchema, AgentDependencyPlanViewSchema,
  CreateAgentDependencyPlanSchema, PrepareAgentDependencyPlanSchema, canonicalAgentDependencyPlanRequest,
  type AgentDependencyPlanView,
} from "./agent-dependency-plan.js";

const id = (n: number) => `019d1710-b400-7000-8000-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64), at = "2026-10-23T00:00:00.000Z";
const source = { invoiceId: id(2), purchaseOrderId: id(3), purchaseOrderVersionId: id(4), procurementProofId: id(5), supplierId: id(6),
  invoiceNumber: "INV-TEST-1", currency: "USD", totalMinor: 125, issuedAt: at, sourceChecksum: hash };
const draft = { domain: "finance", command: { kind: "bill_record", targetId: null, input: {
  kind: "procurement_invoice", procurementInvoiceId: id(2), supplierId: id(6), externalBillId: "INV-TEST-1", currency: "USD", amountMinor: 125,
  issuedAt: at, dueAt: null, idempotencyKey: id(7),
} } } as const;
const view = (): AgentDependencyPlanView => ({ version, kind, id: id(10), requestId: id(11), requestChecksum: hash,
  parentAgentCommandId: id(1), childRequestId: id(12), childAgentCommandId: null, childOwnerCommandId: null,
  childPreparationRequestChecksum: null, childOriginalChecksum: null, preparationRequestedAt: null,
  dueAt: null, createdAt: at, updatedAt: at, expiresAt: "2026-10-30T00:00:00.000Z", cancelledAt: null,
  contextAuthority: "synthetic-current-authority", state: "ready_to_prepare",
  parent: { agentCommandId: id(1), requestId: id(13), requestChecksum: hash, ownerCommandId: id(14), domain: "procurement", kind: "invoice_record", state: "succeeded", resultId: id(2) },
  child: null, dependency: { from: "procurement_invoice", to: "finance_bill", requires: "original_owner_succeeded" }, source, childDraft: draft,
  privateAvailable: true, canPrepare: true, canCancel: true, blockReason: null, businessExecution: "separate_original_confirmation", modelCalls: 0, queueDispatches: 0,
});

describe("native invoice to payable dependency contract", () => {
  it("admits only the new explicit dependency and canonical due date without another child body", () => {
    const input = { version, kind, requestId: id(11), parentAgentCommandId: id(1), dueAt: "2026-10-24T00:00:00Z" };
    expect(JSON.parse(canonicalAgentDependencyPlanRequest(input)).dueAt).toBe("2026-10-24T00:00:00.000Z");
    expect(canonicalAgentDependencyPlanRequest({ ...input, requestId: input.requestId.toUpperCase(), parentAgentCommandId: input.parentAgentCommandId.toUpperCase() })).toBe(canonicalAgentDependencyPlanRequest(input));
    for (const change of [{ dependsOn: [id(1)] }, { draft }, { tenantId: id(2) }, { confirmationToken: "synthetic" }])
      expect(CreateAgentDependencyPlanSchema.safeParse({ ...input, ...change }).success).toBe(false);
    expect(PrepareAgentDependencyPlanSchema.safeParse({ version, requestId: id(11), sourceChecksum: hash }).success).toBe(true);
    expect(PrepareAgentDependencyPlanSchema.safeParse({ version, requestId: id(11), sourceChecksum: hash, childRequestId: id(12) }).success).toBe(false);
  });
  it("requires a real predecessor result before a future invoice identity can be used", () => {
    expect(AgentDependencyPlanViewSchema.parse(view())).toEqual(view());
    for (const parent of [{ ...view().parent, state: "prepared", resultId: null }, { ...view().parent, resultId: id(9) }, { ...view().parent, ownerCommandId: null }])
      expect(AgentDependencyPlanViewSchema.safeParse({ ...view(), parent }).success).toBe(false);
    expect(AgentDependencyPlanViewSchema.safeParse({ ...view(), state: "succeeded", canPrepare: false }).success).toBe(false);
  });
  it("rejects rewriting any invoice field to fit finance", () => {
    for (const input of [{ supplierId: id(9) }, { currency: "EUR" }, { amountMinor: 126 }, { externalBillId: "OTHER" },
      { procurementInvoiceId: id(9) }, { issuedAt: "2026-10-22T00:00:00.000Z" }, { dueAt: "2026-10-25T00:00:00.000Z" }])
      expect(AgentDependencyPlanViewSchema.safeParse({ ...view(), childDraft: { ...draft, command: { ...draft.command, input: { ...draft.command.input, ...input } } } }).success).toBe(false);
    expect(AgentDependencyPlanBillDraftSchema.safeParse({ ...draft, command: { ...draft.command, input: { ...draft.command.input, kind: "supplier_invoice", procurementInvoiceId: null } } }).success).toBe(false);
    expect(AgentDependencyPlanSourceSchema.safeParse({ ...source, totalMinor: 0 }).success).toBe(true);
    expect(AgentDependencyPlanBillDraftSchema.safeParse({ ...draft, command: { ...draft.command, input: { ...draft.command.input, amountMinor: 0 } } }).success).toBe(false);
  });
  it("keeps hidden input, original child references and the preparation pin consistent", () => {
    for (const change of [{ privateAvailable: false }, { childAgentCommandId: id(18) }, { childOwnerCommandId: id(19) }, { preparationRequestedAt: at }, { childOriginalChecksum: hash }])
      expect(AgentDependencyPlanViewSchema.safeParse({ ...view(), ...change }).success).toBe(false);
    const child = { agentCommandId: id(18), requestId: id(12), requestChecksum: hash, ownerCommandId: id(19), domain: "finance", kind: "bill_record", state: "prepared", resultId: null };
    const prepared = { ...view(), state: "child_prepared", canPrepare: false, child, childAgentCommandId: id(18), childOwnerCommandId: id(19),
      preparationRequestedAt: at, childOriginalChecksum: hash, childPreparationRequestChecksum: hash };
    expect(AgentDependencyPlanViewSchema.safeParse(prepared).success).toBe(true);
    expect(AgentDependencyPlanViewSchema.safeParse({ ...prepared, child: { ...child, requestId: id(20) } }).success).toBe(false);
    expect(AgentDependencyPlanViewSchema.safeParse({ ...view(), modelCalls: 1 }).success).toBe(false);
  });
  it("retains only scalar recovery identity and bounded personal pagination", () => {
    const marker = { version: 1, ownerScope: hash, requestId: id(11), requestChecksum: hash, planId: id(10), state: "unknown", createdAt: at };
    expect(AgentDependencyPlanIntentSchema.safeParse(marker).success).toBe(true);
    for (const state of ["prepare_unknown", "cancel_unknown", "known"]) {
      const actual = AgentDependencyPlanIntentSchema.parse({ ...marker, state });
      expect(Object.keys(actual)).toHaveLength(7); expect(actual.requestId).toBe(marker.requestId);
    }
    for (const extra of [{ source }, { draft }, { confirmationToken: "synthetic" }]) expect(AgentDependencyPlanIntentSchema.safeParse({ ...marker, ...extra }).success).toBe(false);
    expect(AgentDependencyPlanReceiptSchema.safeParse({ version, requestId: id(11), requestChecksum: hash, contextAuthority: "current", disposition: "not_found", id: id(10) }).success).toBe(false);
    const page = { version, contextAuthority: "current", items: [], limit: 20, upperId: null, nextBefore: null, hasMore: false, scope: "personal", coverage: "bounded_original_id_range" };
    expect(AgentDependencyPlanPageSchema.safeParse(page).success).toBe(true);
    expect(AgentDependencyPlanPageSchema.safeParse({ ...page, hasMore: true }).success).toBe(false);
    expect(AgentDependencyPlanPageSchema.safeParse({ ...page, coverage: "all_history" }).success).toBe(false);
  });
});
