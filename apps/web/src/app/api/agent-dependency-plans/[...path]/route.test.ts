import { createHash } from "node:crypto";
import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_DEPENDENCY_PLAN_VERSION as version, AGENT_DEPENDENCY_PLAN_KIND as kind, canonicalAgentDependencyPlanRequest,
  agentDependencyPlanSourcePayload, type AgentDependencyPlanView } from "@yummyai/contracts/ai/agent-dependency-plan";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";

const mock = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mock.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mock.identity, assertErpIdentityCurrent: mock.current, erpAuthFailure: mock.failure }));
import { GET, POST } from "./route";

const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), displayName: "Synthetic operator",
  organizationName: "Synthetic tenant", permissions: ["workflow:read", "workflow:run"],
  permissionScopes: { "workflow:read": "self", "workflow:run": "self" }, dataScope: "self" };
const authority = erpSessionAuthority(actor), at = "2026-10-23T00:00:00.000Z", origin = "http://web.test";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const root = createEntityId(), parent = createEntityId(), native = createEntityId(), requestId = createEntityId(), childRequest = createEntityId();
const input = { version, kind, requestId, parentAgentCommandId: parent, dueAt: null };
const view = (): AgentDependencyPlanView => ({ ...input, id: root, requestChecksum: sha(canonicalAgentDependencyPlanRequest(input)), childRequestId: childRequest,
  childAgentCommandId: null, childOwnerCommandId: null, childPreparationRequestChecksum: null, childOriginalChecksum: null, preparationRequestedAt: null,
  createdAt: at, updatedAt: at, expiresAt: "2026-10-30T00:00:00.000Z", cancelledAt: null, contextAuthority: authority, state: "waiting_predecessor",
  parent: { agentCommandId: parent, requestId: createEntityId(), requestChecksum: "b".repeat(64), ownerCommandId: native,
    domain: "procurement", kind: "invoice_record", state: "prepared", resultId: null }, child: null,
  dependency: { from: "procurement_invoice", to: "finance_bill", requires: "original_owner_succeeded" }, source: null, childDraft: null,
  privateAvailable: true, canPrepare: false, canCancel: true, blockReason: "parent_not_succeeded", businessExecution: "separate_original_confirmation", modelCalls: 0, queueDispatches: 0,
});
const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });
const request = (path: string, body?: unknown, stamp: string | null = authority, otherOrigin = origin) => new Request(origin + "/api/agent-dependency-plans/" + path,
  { method: body === undefined ? "GET" : "POST", headers: { origin: otherOrigin, "content-type": "application/json", ...(stamp ? { "x-yummyai-context-authority": stamp } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });

describe("fixed dependency personal BFF", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mock.upstream.mockReset(); mock.identity.mockResolvedValue({ view: actor }); mock.current.mockResolvedValue();
    mock.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test";
  });
  it("admits only exact same-origin actions and bounded metadata without caller identities or business execution", async () => {
    for (const [path, body] of [["requests", { ...input, tenantId: actor.tenantId }], ["requests", { ...input, childDraft: {} }],
      [`requests/${root}/confirm`, {}], [`requests/${root}/prepare`, { version, requestId, sourceChecksum: "a".repeat(64), execute: true }]] as const)
      expect([400, 404]).toContain((await POST(request(path, body), ctx(...path.split("/")))).status);
    expect((await POST(request("requests", input, null), ctx("requests"))).status).toBe(409);
    expect((await POST(request("requests", input, authority, "http://foreign.test"), ctx("requests"))).status).toBe(403);
    expect((await GET(request("requests?limit=20&limit=50"), ctx("requests"))).status).toBe(400);
    expect((await GET(request("workspace?tenantId=other"), ctx("workspace"))).status).toBe(400);
    expect((await GET(request("requests?limit=51"), ctx("requests"))).status).toBe(400);
    expect(mock.upstream).not.toHaveBeenCalled();
  });
  it("binds actual201 creation to its original request and parent without accepting another plan", async () => {
    const value = view(); mock.upstream.mockResolvedValueOnce(Response.json(value, { status: 201 }));
    const result = await POST(request("requests", input), ctx("requests")); expect(result.status).toBe(201); expect(await result.json()).toEqual(value);
    expect(result.headers.get("cache-control")).toBe("private, no-store"); expect(result.headers.get("x-yummyai-context-authority")).toBe(authority);
    for (const changed of [{ ...value, requestId: createEntityId() }, { ...value, requestChecksum: "c".repeat(64) },
      { ...value, parentAgentCommandId: createEntityId() }, { ...value, autoConfirmed: true }]) {
      mock.upstream.mockResolvedValueOnce(Response.json(changed, { status: 201 })); expect((await POST(request("requests", input), ctx("requests"))).status).toBe(502);
    }
    mock.upstream.mockResolvedValueOnce(Response.json(value)); expect((await POST(request("requests", input), ctx("requests"))).status).toBe(502);
  });
  it("recovers only the exact GET receipt and never retries a lost POST", async () => {
    const query = { requestId, requestChecksum: view().requestChecksum }, path = "receipts?" + new URLSearchParams(query);
    const receipt = { version, ...query, contextAuthority: authority, disposition: "known", id: root };
    mock.upstream.mockResolvedValueOnce(Response.json(receipt)); expect((await GET(request(path), ctx("receipts"))).status).toBe(200);
    mock.upstream.mockResolvedValueOnce(Response.json({ ...receipt, requestChecksum: "f".repeat(64) })); expect((await GET(request(path), ctx("receipts"))).status).toBe(502);
    mock.upstream.mockRejectedValueOnce(new TypeError("synthetic lost response"));
    expect((await POST(request(`requests/${root}/prepare`, { version, requestId, sourceChecksum: "a".repeat(64) }), ctx("requests", root, "prepare"))).status).toBe(502);
    expect(mock.upstream.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET", "POST"]);
    mock.upstream.mockResolvedValueOnce(Response.json({ message: "synthetic private SQL" }, { status: 409 }));
    const denied = await GET(request(path), ctx("receipts")); expect(denied.status).toBe(409); expect(await denied.text()).not.toContain("synthetic private SQL");
  });
  it("rejects changed source checksums and source substitutions even when the payload is otherwise well shaped", async () => {
    const base = view(), invoiceId = createEntityId(), source = { invoiceId, purchaseOrderId: createEntityId(), purchaseOrderVersionId: createEntityId(), procurementProofId: createEntityId(),
      supplierId: createEntityId(), invoiceNumber: "INV-SYNTHETIC", currency: "USD", totalMinor: 123, issuedAt: at, sourceChecksum: "a".repeat(64) };
    source.sourceChecksum = sha(canonicalJson(agentDependencyPlanSourcePayload(source)));
    const ready = { ...base, parent: { ...base.parent, state: "succeeded", resultId: invoiceId }, state: "ready_to_prepare", canPrepare: true, blockReason: null, source,
      childDraft: { domain: "finance", command: { kind: "bill_record", targetId: null, input: { kind: "procurement_invoice", procurementInvoiceId: invoiceId, supplierId: source.supplierId,
        currency: source.currency, externalBillId: source.invoiceNumber, amountMinor: source.totalMinor, issuedAt: at, dueAt: null, idempotencyKey: createEntityId() } } } };
    mock.upstream.mockResolvedValueOnce(Response.json(ready)); expect((await GET(request(`requests/${root}`), ctx("requests", root))).status).toBe(200);
    for (const change of [{ source: { ...source, sourceChecksum: "f".repeat(64) } }, { childOriginalChecksum: "f".repeat(64), childPreparationRequestChecksum: "f".repeat(64), preparationRequestedAt: at }]) {
      mock.upstream.mockResolvedValueOnce(Response.json({ ...ready, ...change })); expect((await GET(request(`requests/${root}`), ctx("requests", root))).status).toBe(502);
    }
    mock.upstream.mockResolvedValueOnce(Response.json(ready, { status: 201 }));
    expect((await POST(request(`requests/${root}/prepare`, { version, requestId, sourceChecksum: "f".repeat(64) }), ctx("requests", root, "prepare"))).status).toBe(502);
  });
  it("retains the bounded pagination range and refuses duplicate or substituted summaries", async () => {
    const base = view(), { contextAuthority: _a, state: _b, parent: _c, child: _d, dependency: _e, source: _f, childDraft: _g,
      privateAvailable: _h, canPrepare: _i, canCancel: _j, blockReason: _k, businessExecution: _l, modelCalls: _m, queueDispatches: _n, ...summary } = base;
    void [_a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n];
    const page = { version, contextAuthority: authority, items: [summary], limit: 20, upperId: root, nextBefore: null, hasMore: false, scope: "personal", coverage: "bounded_original_id_range" };
    mock.upstream.mockResolvedValueOnce(Response.json(page)); expect((await GET(request("requests"), ctx("requests"))).status).toBe(200);
    mock.upstream.mockResolvedValueOnce(Response.json({ ...page, items: [summary, summary] })); expect((await GET(request("requests"), ctx("requests"))).status).toBe(502);
    mock.upstream.mockResolvedValueOnce(Response.json({ ...page, limit: 50 })); expect((await GET(request("requests"), ctx("requests"))).status).toBe(502);
  });
  it("checks identity after all response bytes before exposing an earlier successful body", async () => {
    mock.upstream.mockResolvedValueOnce(Response.json(view())); mock.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const result = await GET(request(`requests/${root}`), ctx("requests", root)); expect(result.status).toBe(409); expect(await result.json()).toEqual({ code: "authority_changed" });
    mock.upstream.mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }));
    expect((await GET(request(`requests/${root}`), ctx("requests", root))).status).toBe(502);
  });
});
