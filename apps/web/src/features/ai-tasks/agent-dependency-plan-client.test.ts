import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_COMMAND_VERSION, canonicalAgentCommandOriginal, canonicalAgentCommandRequest } from "@yummyai/contracts/ai/agent-command";
import {
  AGENT_DEPENDENCY_PLAN_VERSION, AGENT_DEPENDENCY_PLAN_KIND,
  AgentDependencyPlanBillDraftSchema, AgentDependencyPlanSourceSchema, AgentDependencyPlanViewSchema,
  agentDependencyPlanSourcePayload, canonicalAgentDependencyPlanRequest,
} from "@yummyai/contracts/ai/agent-dependency-plan";
import { readAgentDependencyPlan } from "./agent-dependency-plan-client";

const authority = "synthetic exact current personal authority";
const date = "2026-10-23T00:00:00.000Z";
const id = (value: number) => "019a0000-0000-7000-8000-" + value.toString(16).padStart(12, "0");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function originalPlan() {
  const request = { version: AGENT_DEPENDENCY_PLAN_VERSION, kind: AGENT_DEPENDENCY_PLAN_KIND,
    requestId: id(2), parentAgentCommandId: id(3), dueAt: null };
  const provisional = AgentDependencyPlanSourceSchema.parse({ invoiceId: id(5), purchaseOrderId: id(6),
    purchaseOrderVersionId: id(7), procurementProofId: id(8), supplierId: id(9),
    invoiceNumber: "SYNTHETIC-INVOICE-1", currency: "USD", totalMinor: 5300, issuedAt: date, sourceChecksum: "0".repeat(64) });
  const source = { ...provisional, sourceChecksum: sha(canonicalJson(agentDependencyPlanSourcePayload(provisional))) };
  const childDraft = AgentDependencyPlanBillDraftSchema.parse({ domain: "finance", command: { kind: "bill_record", targetId: null,
    input: { supplierId: source.supplierId, kind: "procurement_invoice", externalBillId: source.invoiceNumber,
      currency: source.currency, amountMinor: source.totalMinor, issuedAt: source.issuedAt, dueAt: request.dueAt,
      procurementInvoiceId: source.invoiceId, idempotencyKey: id(10) } } });
  const childRequestId = id(4);
  return AgentDependencyPlanViewSchema.parse({ ...request, id: id(1), requestChecksum: sha(canonicalAgentDependencyPlanRequest(request)),
    childRequestId, childAgentCommandId: null, childOwnerCommandId: null,
    childOriginalChecksum: sha(canonicalAgentCommandOriginal(childDraft)),
    childPreparationRequestChecksum: sha(canonicalAgentCommandRequest("prepare", {
      version: AGENT_COMMAND_VERSION, requestId: childRequestId, original: childDraft,
    })), preparationRequestedAt: date, createdAt: date, updatedAt: date, expiresAt: "2026-10-30T00:00:00.000Z", cancelledAt: null,
    contextAuthority: authority, state: "preparation_unknown",
    parent: { agentCommandId: request.parentAgentCommandId, requestId: id(11), requestChecksum: "a".repeat(64),
      ownerCommandId: id(12), domain: "procurement", kind: "invoice_record", state: "succeeded", resultId: source.invoiceId },
    child: null, dependency: { from: "procurement_invoice", to: "finance_bill", requires: "original_owner_succeeded" },
    source, childDraft, privateAvailable: true, canPrepare: true, canCancel: true, blockReason: "preparation_unresolved",
    businessExecution: "separate_original_confirmation", modelCalls: 0, queueDispatches: 0 });
}

const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200,
  headers: { "content-type": "application/json", "x-yummyai-context-authority": authority } });

describe("original dependency-plan read transport", () => {
  beforeEach(() => { vi.stubGlobal("crypto", webcrypto); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("reads a fixed original whose native idempotency key differs from its child request identity without another POST", async () => {
    const value = originalPlan(), fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response(value));
    vi.stubGlobal("fetch", fetcher);
    expect(value.childDraft?.command.input.idempotencyKey).not.toBe(value.childRequestId);
    expect(await readAgentDependencyPlan(value.id, authority)).toEqual(value);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith("/api/agent-dependency-plans/requests/" + value.id,
      expect.objectContaining({ method: "GET", body: undefined, cache: "no-store", credentials: "same-origin",
        headers: { "x-yummyai-context-authority": authority } }));
  });

  it("rejects changes to the fixed native draft or recorded preparation hashes and never retries through a write", async () => {
    const value = originalPlan(), draft = value.childDraft;
    if (!draft) throw new Error("The original fixture must contain its fixed native draft");
    const changedDraft = { ...value, childDraft: { ...draft, command: { ...draft.command,
      input: { ...draft.command.input, idempotencyKey: id(99) } } } };
    const fetcher = vi.fn<typeof fetch>(); vi.stubGlobal("fetch", fetcher);
    for (const changed of [changedDraft, { ...value, childOriginalChecksum: "f".repeat(64) },
      { ...value, childPreparationRequestChecksum: "b".repeat(64) }, { ...value, childRequestId: id(98) }]) {
      fetcher.mockResolvedValueOnce(response(changed));
      await expect(readAgentDependencyPlan(value.id, authority)).rejects.toHaveProperty("status", 502);
    }
    fetcher.mockRejectedValueOnce(new TypeError("Synthetic unreadable original response"));
    await expect(readAgentDependencyPlan(value.id, authority)).rejects.toHaveProperty("status", 0);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.every(([url, init]) => url === "/api/agent-dependency-plans/requests/" + value.id
      && init?.method === "GET" && init.body === undefined)).toBe(true);
  });
});
