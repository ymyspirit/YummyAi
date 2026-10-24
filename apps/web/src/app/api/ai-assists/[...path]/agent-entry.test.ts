import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { ASSIST_TARGET_PAGE_VERSION } from "@yummyai/contracts/ai/task-target-page";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET } from "./route";
const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), displayName: "Synthetic page reader", organizationName: "Synthetic tenant",
  dataScope: "tenant", permissions: ["order:read", "order:pii:read"], permissionScopes: { "order:read": "tenant", "order:pii:read": "tenant" } };
const authority = erpSessionAuthority(actor), context = (name: string) => ({ params: Promise.resolve({ path: [name] }) });
function request(query = "kind=order_review&q=original&pageSize=1", stamp: string | null = authority, name = "task-target-pages") {
  return new Request("http://web.test/api/ai-assists/" + name + "?" + query, { headers: stamp === null ? {} : { "x-yummyai-context-authority": stamp } });
}
function value() { const id = createEntityId(); return { version: ASSIST_TARGET_PAGE_VERSION, effect: "read", kind: "order_review", contextAuthority: authority,
  checkedAt: "2026-10-22T00:00:00.000Z", collectionFingerprint: "a".repeat(64), total: 1, readCount: 1, consistency: "unchanged_collection", complete: true, nextCursor: null,
  query: { kind: "order_review", q: "original", pageSize: 1 }, items: [{ id, label: "Synthetic object", detail: "Synthetic owner detail", href: "/orders?line=" + id }] }; }
describe("Personal target page BFF without changing original v1 ABI", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
    mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status })); process.env.API_BASE_URL = "http://api.test"; });
  it("requires the current raw stamp for complete pages, preserves old v1 reads and rejects ambiguous or unknown query fields before owner IO", async () => {
    for (const stamp of [null, "stale authority"]) expect((await GET(request(undefined, stamp), context("task-target-pages"))).status).toBe(409);
    expect(mocks.upstream).not.toHaveBeenCalled();
    const page = value(); mocks.upstream.mockResolvedValueOnce(Response.json(page));
    const response = await GET(request(), context("task-target-pages")); expect(response.status).toBe(200);
    expect(await response.json()).toEqual(page); expect(response.headers.get("x-yummyai-context-authority")).toBe(authority); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.upstream.mock.lastCall?.[0]).toBe("http://api.test/v1/ai-assists/task-target-pages?kind=order_review&q=original&pageSize=1");
    const count = mocks.upstream.mock.calls.length;
    for (const query of ["", "kind=order_review&kind=creative", "kind=order_review&pageSize=101", "kind=order_review&offset=500"])
      expect((await GET(request(query), context("task-target-pages"))).status).toBe(400);
    expect(mocks.upstream).toHaveBeenCalledTimes(count);
    const legacy = { items: [], hasMore: false }; mocks.upstream.mockResolvedValueOnce(Response.json(legacy));
    expect(await (await GET(request("kind=order_review", null, "task-targets"), context("task-targets"))).json()).toEqual(legacy);
  });
  it("rejects substituted DTOs and echoes, masks raw errors and rechecks identity after consuming the actual response body", async () => {
    for (const changed of [{ privatePrompt: "synthetic-private" }, { query: { kind: "creative", q: "original", pageSize: 1 } }, { total: 2 }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ ...value(), ...changed }));
      expect((await GET(request(), context("task-target-pages"))).status).toBe(502);
    }
    mocks.upstream.mockResolvedValueOnce(Response.json({ message: "synthetic-private-upstream" }, { status: 500 }));
    const error = await GET(request(), context("task-target-pages")); expect(error.status).toBe(502); expect(await error.text()).not.toContain("synthetic-private-upstream");
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "assist_target_collection_changed" }, { status: 409 }));
    const conflict = await GET(request(), context("task-target-pages")); expect(conflict.status).toBe(409); expect(await conflict.json()).toMatchObject({ code: "assist_target_collection_changed" });
    let bodyRead = false;
    mocks.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ pull(controller) { bodyRead = true; controller.enqueue(new TextEncoder().encode(JSON.stringify(value()))); controller.close(); } })));
    mocks.current.mockImplementationOnce(async () => { expect(bodyRead).toBe(true); throw new PersonalSessionError(409, "authority_changed"); });
    const denied = await GET(request(), context("task-target-pages")); expect(denied.status).toBe(409); expect(await denied.text()).not.toContain("Synthetic owner detail");
  });
});
