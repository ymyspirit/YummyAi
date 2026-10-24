import { beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { PersonalSessionError } from "../../../../identity/core";
import { GET, HEAD } from "./route";

const state = vi.hoisted(() => ({ api: vi.fn(), identity: vi.fn(), current: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: state.api }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: state.identity, assertErpIdentityCurrent: state.current,
  erpAuthFailure: (error: { status: number; code: string }) => Response.json({ message: "Current personal access unavailable", code: error.code }, { status: error.status }) }));
const id = "019f0000-0000-7000-8000-000000000101", versionId = "019f0000-0000-7000-8000-000000000102", actorId = "019f0000-0000-7000-8000-000000000001";
const view = { userId: actorId, tenantId: "019f0000-0000-7000-8000-000000000002", permissions: [Permission.ListingRead], dataScope: "self" as const };
const authority = erpSessionAuthority(view), context = { params: Promise.resolve({ listingId: id }) };
const request = (head = false, stamp = authority) => new Request(`http://erp.invalid/api/listings/${id}`, { method: head ? "HEAD" : "GET", headers: { "x-yummyai-context-authority": stamp } });
const value = () => ({ listing: { id, ownerUserId: actorId, status: "draft", title: "Original private listing" }, version: { id: versionId }, history: [] });
beforeEach(() => { state.api.mockReset(); state.identity.mockReset().mockResolvedValue({ view, authority: "a".repeat(64) }); state.current.mockReset().mockResolvedValue(undefined); process.env.API_BASE_URL = "http://api.invalid"; });

describe("Listing personal body and current object authority", () => {
  it("buffers the original body then checks the exact object with HEAD without demanding StoreRead", async () => {
    state.api.mockResolvedValueOnce(Response.json(value())).mockResolvedValueOnce(new Response(null));
    const response = await GET(request(), context);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(value()); expect(response.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(state.api.mock.calls.map(call => call[1].method ?? "GET")).toEqual(["GET", "HEAD"]);
    expect(state.api.mock.calls.every(call => call[0] === `http://api.invalid/v1/listings/${id}`)).toBe(true);
    expect(state.current).toHaveBeenCalledTimes(3);
  });
  it("does not stream a partial body or return it after owner access changes under unchanged membership", async () => {
    const text = JSON.stringify(value()), encoder = new TextEncoder(); let finish!: () => void, allowed = true, finished = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(text.slice(0, 15))); finish = () => { if (!finished) { finished = true; controller.enqueue(encoder.encode(text.slice(15))); controller.close(); } }; } });
    state.api.mockImplementation((_url, init) => init.method === "HEAD" ? new Response(null, { status: allowed ? 200 : 403 }) : new Response(stream, { headers: { "content-type": "application/json" } }));
    const reading = GET(request(), context); let returned = false; void reading.then(() => { returned = true; });
    try {
      await vi.waitFor(() => expect(state.api).toHaveBeenCalledTimes(1)); expect(returned).toBe(false);
      allowed = false; finish(); const response = await reading;
      expect(response.status).toBe(403); expect(await response.text()).not.toContain("Original private listing");
      expect(state.api.mock.calls.map(call => call[1].method ?? "GET")).toEqual(["GET", "HEAD"]);
    } finally { finish(); await reading; }
  });
  it("keeps HEAD bodyless and refuses missing read permission or a foreign raw authority before forwarding", async () => {
    expect((await HEAD(request(true, "b".repeat(64)), context)).status).toBe(409); expect(state.api).not.toHaveBeenCalled();
    state.identity.mockResolvedValueOnce({ view: { ...view, permissions: [] } }); expect((await HEAD(request(true), context)).status).toBe(403); expect(state.api).not.toHaveBeenCalled();
    state.api.mockResolvedValueOnce(new Response(null)); const response = await HEAD(request(true), context);
    expect(response.status).toBe(200); expect(await response.text()).toBe(""); expect(response.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(state.api).toHaveBeenCalledTimes(1); expect(state.api.mock.calls[0]![1].method).toBe("HEAD");
  });
  it("discards a fully read body on late membership revocation or invalid original parent", async () => {
    state.api.mockResolvedValueOnce(Response.json(value())); state.current.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const response = await GET(request(), context); expect(response.status).toBe(409); expect(await response.text()).not.toContain("Original private listing");
    state.current.mockReset().mockResolvedValue(undefined); state.api.mockReset().mockResolvedValueOnce(Response.json({ ...value(), listing: { ...value().listing, id: versionId } }));
    expect((await GET(request(), context)).status).toBe(502); expect(state.api).toHaveBeenCalledTimes(1);
  });
});
