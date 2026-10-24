import { beforeEach, describe, it, expect, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";
import { Permission } from "@yummyai/authz/permissions";
import { publicationPreviewFixture } from "../../../../features/marketplaces/publication-preview.test-fixture";
import { GET, POST, HEAD } from "./route";
const state = vi.hoisted(() => ({ api: vi.fn(), current: vi.fn(), identity: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: state.api }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: state.identity, assertErpIdentityCurrent: state.current,
  erpAuthFailure: (error: { status: number; code: string }) => Response.json({ message: "Current identity unavailable", code: error.code }, { status: error.status }) }));
beforeEach(() => { state.api.mockReset(); state.current.mockReset().mockResolvedValue(undefined); state.identity.mockReset(); process.env.API_BASE_URL = "http://api.invalid"; });
function setIdentity(context: { authority: string; actorId: string; tenantId: string }, permissions: Permission[] = [Permission.ListingRead, Permission.StoreRead, Permission.ListingPublish]) {
  state.identity.mockResolvedValue({ authority: context.authority, view: { userId: context.actorId, tenantId: context.tenantId, permissions, dataScope: "tenant" } });
}
const route = (segments: string[]) => ({ params: Promise.resolve({ segments }) });
function request(path: string, authority: string, body?: unknown) { return new Request(`http://localhost/api/erp-publication-preview/${path}`, { method: body === undefined ? "GET" : "POST",
  headers: { origin: "http://localhost", "x-yummyai-context-authority": authority, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
describe("publication preview personal BFF", () => {
  it("rejects unknown routes, duplicate query, wrong authority and missing permission without forwarding", async () => {
    const { context, input } = await publicationPreviewFixture(); setIdentity(context);
    expect((await GET(request("unknown", context.authority), route(["unknown"]))).status).toBe(400);
    expect((await GET(request(`workspace?listingId=${context.listingId}&listingId=${context.listingId}&listingVersionId=${context.listingVersionId}`, context.authority), route(["workspace"]))).status).toBe(400);
    expect((await POST(request("requests", "f".repeat(64), input), route(["requests"]))).status).toBe(409);
    setIdentity(context, [Permission.ListingRead, Permission.ListingPublish]);
    expect((await POST(request("requests", context.authority, input), route(["requests"]))).status).toBe(403);
    expect((await GET(request(`requests/${input.listingId}`, context.authority), route(["requests", input.listingId]))).status).toBe(403); expect(state.api).not.toHaveBeenCalled();
  });
  it("requires a second read-only proof for the exact submitted key, checksum, request and target", async () => {
    const { context, input, value } = await publicationPreviewFixture(); setIdentity(context);
    const proof = { protocol: value.protocol, requestKey: input.requestKey, requestChecksum: input.requestChecksum, found: true, request: value, observedAt: "2026-10-22T00:00:00.000Z" };
    state.api.mockResolvedValueOnce(Response.json(value, { status: 201 })).mockResolvedValueOnce(Response.json(proof)).mockResolvedValueOnce(new Response(null));
    const response = await POST(request("requests", context.authority, input), route(["requests"])); expect(response.status).toBe(201);
    expect(state.api).toHaveBeenCalledTimes(3); expect(state.api.mock.calls[0]![1].method).toBe("POST"); expect(state.api.mock.calls[1]![1].method).toBe("GET");
    expect(state.api.mock.calls[2]![1].method).toBe("HEAD"); expect(new URL(state.api.mock.calls[2]![0]).pathname).toBe(`/v1/marketplace-publications/preview/${value.request.id}`);
    expect(new URL(state.api.mock.calls[1]![0]).searchParams.get("requestKey")).toBe(input.requestKey); expect(new URL(state.api.mock.calls[1]![0]).searchParams.get("requestChecksum")).toBe(input.requestChecksum);
    state.api.mockReset().mockResolvedValueOnce(Response.json(value, { status: 201 })).mockResolvedValueOnce(Response.json({ ...proof, requestChecksum: "0".repeat(64) }));
    expect((await POST(request("requests", context.authority, input), route(["requests"]))).status).toBe(502); expect(state.api).toHaveBeenCalledTimes(2);
  });
  it("keeps a committed response unknown when proof is unavailable and never returns a late private body after revocation", async () => {
    const { context, input, value } = await publicationPreviewFixture(); setIdentity(context);
    state.api.mockResolvedValueOnce(Response.json(value, { status: 201 })).mockResolvedValueOnce(Response.json({ message: "missing" }, { status: 404 }));
    expect((await POST(request("requests", context.authority, input), route(["requests"]))).status).toBe(502); expect(state.api).toHaveBeenCalledTimes(2);
    state.api.mockReset().mockResolvedValueOnce(Response.json(value)); state.current.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const late = await GET(request(`requests/${value.request.id}`, context.authority), route(["requests", value.request.id]));
    expect(late.status).toBe(409); expect(await late.text()).not.toContain(value.request.id); expect(state.api).toHaveBeenCalledTimes(1);
  });
  it("rejects an old authorized body when current object access is lost under the same membership authority", async () => {
    const { context, value } = await publicationPreviewFixture(); setIdentity(context);
    state.api.mockResolvedValueOnce(Response.json(value)).mockResolvedValueOnce(new Response(null, { status: 403 }));
    const response = await GET(request(`requests/${value.request.id}`, context.authority), route(["requests", value.request.id]));
    expect(response.status).toBe(403); expect(await response.text()).not.toContain(value.request.id);
    expect(state.api.mock.calls.map(call => call[1].method)).toEqual(["GET", "HEAD"]);
    expect(state.current.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
  it("exports only two bodyless HEAD routes with strict canonical account CSV and keeps ordinary conflicts distinct", async () => {
    const { context, value, target } = await publicationPreviewFixture(); setIdentity(context);
    const head = (path: string) => new Request(`http://localhost/api/erp-publication-preview/${path}`, { method: "HEAD", headers: { "x-yummyai-context-authority": context.authority } });
    for (const segments of [["receipt"], ["requests", value.request.id, "events"]]) expect((await HEAD(head(segments.join("/")), route(segments))).status).toBe(400);
    const query = new URLSearchParams({ listingId: context.listingId, listingVersionId: context.listingVersionId, accountIds: `${target.accountId},${target.accountId}` });
    expect((await HEAD(head(`workspace?${query}`), route(["workspace"]))).status).toBe(400); expect(state.api).not.toHaveBeenCalled();
    query.set("accountIds", target.accountId); state.api.mockResolvedValueOnce(new Response(null));
    const good = await HEAD(head(`workspace?${query}`), route(["workspace"])); expect(good.status).toBe(200); expect(await good.text()).toBe("");
    expect(good.headers.get("x-yummyai-context-authority")).toBe(context.authority); expect(state.api.mock.calls[0]![1].method).toBe("HEAD");
    state.api.mockResolvedValueOnce(new Response(null, { status: 409, headers: { "x-yummyai-error-code": "publication_preview_conflict" } }));
    const conflict = await HEAD(head(`requests/${value.request.id}`), route(["requests", value.request.id])); expect(conflict.status).toBe(409); expect(conflict.headers.has("x-yummyai-error-code")).toBe(false);
    state.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const denied = await HEAD(head(`requests/${value.request.id}`), route(["requests", value.request.id])); expect(denied.status).toBe(409); expect(denied.headers.get("x-yummyai-error-code")).toBe("authority_changed"); expect(await denied.text()).toBe("");
  });
});
