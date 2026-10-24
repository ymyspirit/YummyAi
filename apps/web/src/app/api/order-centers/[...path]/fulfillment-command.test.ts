import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { FulfillmentCommandViewSchema, fulfillmentCommandCanonicalJson, PrepareFulfillmentCommandSchema } from "@yummyai/contracts/order/fulfillment-command";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";
const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), displayName: "Synthetic fulfillment operator", organizationName: "Synthetic tenant",
  dataScope: "tenant", permissions: ["order:read", "order:write", "order:pii:read"], permissionScopes: { "order:read": "tenant", "order:write": "tenant", "order:pii:read": "tenant" } };
const stamp = erpSessionAuthority(actor), orderId = createEntityId(), lineId = createEntityId(), intentId = createEntityId();
const command = PrepareFulfillmentCommandSchema.parse({ requestId: randomUUID(), kind: "shipment_dispatch", targetId: createEntityId(), input: {
  expectedVersion: 1, reason: "Synthetic explicitly checked handover", occurredAt: "2026-10-23T00:00:00.000Z", idempotencyKey: randomUUID(),
} });
const view = () => FulfillmentCommandViewSchema.parse({ id: intentId, requestId: command.requestId, requestChecksum: createHash("sha256").update(fulfillmentCommandCanonicalJson(command)).digest("hex"),
  kind: command.kind, targetId: command.targetId, orderId, lineIds: [lineId], status: "prepared", createdAt: "2026-10-23T00:00:00.000Z", expiresAt: "2026-10-24T00:00:00.000Z",
  leaseExpiresAt: null, acknowledged: false, canExecute: true, canCancel: true, summary: { orderNumber: "SYNTHETIC_PRIVATE_ORIGINAL_ORDER", lineCount: 1, label: "登记实际交运" }, receipt: null, errorCode: null });
const context = (path: string[] = []) => ({ params: Promise.resolve({ path: ["fulfillment-commands", ...path] }) });
function request(method: "GET" | "POST", suffix = "", body?: unknown, authority = stamp) {
  return new Request("http://web.test/api/order-centers/fulfillment-commands" + suffix, { method,
    headers: { "x-yummyai-context-authority": authority, ...(method === "POST" ? { origin: "http://web.test", "content-type": "application/json" } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

describe("Personal original fulfillment command BFF", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
    mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test"; });
  it("requires a current original stamp, finite strict query and typed input before any owner request", async () => {
    expect((await GET(request("GET", `?orderId=${orderId}`, undefined, "stale"), context())).status).toBe(409);
    expect((await GET(request("GET", `?orderId=${orderId}&orderId=${orderId}`), context())).status).toBe(400);
    expect((await GET(request("GET", `?orderId=${orderId}&tenantId=${actor.tenantId}`), context())).status).toBe(400);
    expect((await POST(request("POST", "", { ...command, arbitraryTool: "dispatch" }), context())).status).toBe(400);
    expect((await POST(request("POST", `/${intentId}/execute`, { input: command.input }), context([intentId, "execute"]))).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("binds prepare/list/get to the original request hash, target and line; GET never becomes an execution", async () => {
    const original = view(); mocks.upstream.mockResolvedValueOnce(Response.json(original, { status: 201 }));
    const prepared = await POST(request("POST", "", command), context());
    expect(prepared.status).toBe(201); expect(prepared.headers.get("x-yummyai-context-authority")).toBe(stamp); expect(await prepared.json()).toEqual(original);
    mocks.upstream.mockResolvedValueOnce(Response.json({ items: [original], truncated: false }));
    const listed = await GET(request("GET", `?orderId=${orderId}&lineId=${lineId}`), context()); expect(listed.status).toBe(200);
    expect(mocks.upstream.mock.calls.at(-1)?.[1]?.method).toBe("GET"); expect(mocks.upstream.mock.calls.at(-1)?.[1]?.body).toBeUndefined();
    for (const changed of [{ ...original, requestChecksum: "b".repeat(64) }, { ...original, targetId: createEntityId() }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(changed)); expect((await POST(request("POST", "", command), context())).status).toBe(502);
    }
    mocks.upstream.mockResolvedValueOnce(Response.json({ items: [{ ...original, orderId: createEntityId() }], truncated: false }));
    expect((await GET(request("GET", `?orderId=${orderId}`), context())).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...original, id: createEntityId() }));
    expect((await GET(request("GET", `/${intentId}`), context([intentId]))).status).toBe(502);
  });
  it("rejects a valid late old200 after authority change and hides upstream private errors", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(view())); mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const late = await GET(request("GET", `/${intentId}`), context([intentId])); expect(late.status).toBe(409); expect(await late.text()).not.toContain("SYNTHETIC_PRIVATE_ORIGINAL_ORDER");
    mocks.upstream.mockResolvedValueOnce(Response.json({ message: "SYNTHETIC_PRIVATE_FAILURE" }, { status: 500 }));
    const denied = await GET(request("GET", `/${intentId}`), context([intentId])); expect(denied.status).toBe(502); expect(await denied.text()).not.toContain("SYNTHETIC_PRIVATE_FAILURE");
  });
  it("accepts a bodyless read acknowledgement without granting execution after OrderWrite is withdrawn", async () => {
    const reader: ErpSessionView = { ...actor, permissions: ["order:read", "order:pii:read"], permissionScopes: { "order:read": "tenant", "order:pii:read": "tenant" } };
    const readerStamp = erpSessionAuthority(reader); mocks.identity.mockResolvedValue({ view: reader });
    const acknowledged = FulfillmentCommandViewSchema.parse({ ...view(), status: "acknowledged", acknowledged: true, canExecute: false, canCancel: false, summary: null, receipt: null });
    mocks.upstream.mockResolvedValueOnce(Response.json(acknowledged));
    const result = await POST(request("POST", `/${intentId}/acknowledge`, undefined, readerStamp), context([intentId, "acknowledge"]));
    expect(result.status).toBe(200); expect(await result.json()).toEqual(acknowledged); expect(mocks.upstream.mock.calls[0]?.[1]?.body).toBe("{}");
    expect((await POST(request("POST", `/${intentId}/execute`, undefined, readerStamp), context([intentId, "execute"]))).status).toBe(403);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });
  it("recognizes Next zero-byte POST streams while rejecting nonempty non-JSON and cross-site actions", async () => {
    const streamed = (value: string, origin = "http://web.test") => new Request(`http://web.test/api/order-centers/fulfillment-commands/${intentId}/execute`, {
      method: "POST", headers: { origin, "x-yummyai-context-authority": stamp }, duplex: "half",
      body: new ReadableStream<Uint8Array>({ start(controller) { if (value) controller.enqueue(new TextEncoder().encode(value)); controller.close(); } }),
    } as RequestInit & { duplex: "half" });
    mocks.upstream.mockResolvedValueOnce(Response.json(view()));
    const result = await POST(streamed(""), context([intentId, "execute"]));
    expect(result.status).toBe(200); expect(result.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(mocks.upstream.mock.calls[0]?.[1]?.body).toBe("{}");
    expect((await POST(streamed("{}"), context([intentId, "execute"]))).status).toBe(403);
    expect((await POST(streamed("", "http://other.test"), context([intentId, "execute"]))).status).toBe(403);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });
});
