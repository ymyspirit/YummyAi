import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { type ShipmentCreateWorkspace } from "@yummyai/contracts/order/shipment";
import { PersonalSessionError } from "../../../../identity/core";

const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET, POST } from "./route";

const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), displayName: "Synthetic packing operator", organizationName: "Synthetic tenant",
  dataScope: "tenant", permissions: ["order:read", "order:write", "order:pii:read"], permissionScopes: { "order:read": "tenant", "order:write": "tenant", "order:pii:read": "tenant" } };
const authority = erpSessionAuthority(actor), orderId = createEntityId(), lineId = createEntityId();
const view = (): ShipmentCreateWorkspace => ({ orderId, orderNumber: "SYNTHETIC_PRIVATE_PACKING_ORDER", orderSequence: 3, contextAuthority: authority,
  lines: [{ lineId, title: "Synthetic real original line", quantity: 5 }], sources: [], canCreate: false, blockers: ["尚无合格来源"] });
const context = { params: Promise.resolve({ path: ["orders", orderId, "shipment-create-workspace"] }) };
const request = (query = "", stamp: string | null = authority) => new Request(`http://web.test/api/order-centers/orders/${orderId}/shipment-create-workspace${query}`,
  { headers: stamp === null ? {} : { "x-yummyai-context-authority": stamp } });

describe("personal complete shipment creation basis", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
    mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test"; });
  it("rejects caller-selected scopes, a missing or old stamp and a foreign permission ceiling before the owner read", async () => {
    for (const query of [`?tenantId=${actor.tenantId}`, "?limit=1", "?after=anything", "?x=1&x=2"])
      expect((await GET(request(query), context)).status).toBe(400);
    expect((await GET(request("", null), context)).status).toBe(409);
    expect((await GET(request("", "old-authority"), context)).status).toBe(409);
    const denied: ErpSessionView = { ...actor, permissions: ["order:read"], permissionScopes: { "order:read": "tenant" } };
    mocks.identity.mockResolvedValueOnce({ view: denied });
    expect((await GET(request("", erpSessionAuthority(denied)), context)).status).toBe(403);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("returns only the typed same-order full basis through a no-store GET with cancellation and the same authority", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(view()));
    const result = await GET(request(), context);
    expect(result.status).toBe(200); expect(await result.json()).toEqual(view());
    expect(result.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(result.headers.get("cache-control")).toContain("no-store");
    expect(mocks.upstream.mock.calls[0]).toEqual([`http://api.test/v1/orders/${orderId}/shipment-create-workspace`,
      expect.objectContaining({ cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) })]);
    expect(mocks.upstream.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(mocks.current).toHaveBeenCalledTimes(1);
    const post = new Request(request(), { method: "POST", body: "{}", headers: { origin: "http://web.test", "content-type": "application/json" } });
    expect((await POST(post, context)).status).toBe(404);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });
  it("does not emit another order, a partial or untyped packet, or an authority changed inside the owner read", async () => {
    for (const changed of [{ ...view(), orderId: createEntityId() }, { ...view(), unexpected: "private" }, { ...view(), lines: [] },
      { ...view(), sources: [], canCreate: true, blockers: ["blocked"] }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(changed)); expect((await GET(request(), context)).status).toBe(502);
    }
    const reduced: ErpSessionView = { ...actor, permissions: ["order:read", "order:pii:read"], permissionScopes: { "order:read": "tenant", "order:pii:read": "tenant" } };
    mocks.upstream.mockResolvedValueOnce(Response.json({ ...view(), contextAuthority: erpSessionAuthority(reduced) }));
    const changed = await GET(request(), context); expect(changed.status).toBe(409); expect(await changed.text()).not.toContain("SYNTHETIC_PRIVATE");
  });
  it("rechecks a fresh late200 after body I/O and never returns private data after the session changes", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const encoded = new TextEncoder().encode(JSON.stringify(view()));
    mocks.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ async start(controller) { await pending; controller.enqueue(encoded); controller.close(); } }),
      { headers: { "content-type": "application/json" } }));
    const reading = GET(request(), context);
    await vi.waitFor(() => expect(mocks.upstream).toHaveBeenCalledOnce());
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed")); release();
    const result = await reading; expect(result.status).toBe(409); expect(await result.text()).not.toContain("SYNTHETIC_PRIVATE");
  });
  it("bounds owner output and sanitizes denied, oversized and failed private responses", async () => {
    for (const status of [404, 422, 500]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ message: "SYNTHETIC_PRIVATE_FAILURE" }, { status }));
      const result = await GET(request(), context); expect(result.status).toBe(status === 500 ? 502 : status); expect(await result.text()).not.toContain("SYNTHETIC_PRIVATE");
    }
    mocks.upstream.mockResolvedValueOnce(new Response("x".repeat(4 * 1024 * 1024 + 1), { headers: { "content-type": "application/json" } }));
    expect((await GET(request(), context)).status).toBe(502);
  });
});
