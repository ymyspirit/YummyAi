import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Permission } from "@yummyai/authz/permissions";
import { PersonalSessionError } from "../../../../../../identity/core";
import { nodeActor, nodeAuthority, nodeCreated, nodeIds, nodeInput, nodeResponse, nodeWorkspace } from "../../../../../../features/marketplaces/store-node.test-fixture";

const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>() }));
vi.mock("../../../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../../../erp-auth/server", () => ({
  erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current,
  erpAuthFailure: (error: PersonalSessionError) => Response.json({ code: error.code, message: "当前本人权限已变化" },
    { status: error.status, headers: { "cache-control": "private, no-store" } }),
}));
import { GET, POST } from "./route";

const origin = "http://localhost:3130", root = `${origin}/api/marketplace-accounts/${nodeIds.account}/nodes`;
const context = (...path: string[]) => ({ params: Promise.resolve({ id: nodeIds.account, path }) });
function request(path = "", body?: unknown, authority: string | null = nodeAuthority, requestOrigin: string | null = origin) {
  const headers = new Headers(authority === null ? undefined : { "x-yummyai-context-authority": authority });
  if (body !== undefined) { headers.set("content-type", "application/json"); if (requestOrigin !== null) headers.set("origin", requestOrigin); }
  return new Request(`${root}${path}`, { method: body === undefined ? "GET" : "POST", headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeEach(() => {
  vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130");
  mocks.upstream.mockReset(); mocks.identity.mockReset(); mocks.current.mockReset().mockResolvedValue(undefined);
  mocks.identity.mockResolvedValue({ view: nodeActor, authority: nodeAuthority });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("personal store node BFF", () => {
  it("refuses unknown paths, any query, cross-origin POST and extra body fields before forwarding", async () => {
    expect((await GET(request("/unknown"), context("unknown"))).status).toBe(400);
    expect((await GET(request("?page=1&page=1"), context())).status).toBe(400);
    expect((await POST(request("/enrollments", nodeInput, nodeAuthority, "https://different.synthetic.test"), context("enrollments"))).status).toBe(403);
    expect((await POST(request("/enrollments", nodeInput, nodeAuthority, null), context("enrollments"))).status).toBe(403);
    expect((await POST(request("/enrollments", { ...nodeInput, privateKey: "synthetic-forbidden-input" }), context("enrollments"))).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("requires StoreRead and each write bit plus the exact personal authority without inferring management", async () => {
    for (const removed of [Permission.StoreRead, Permission.StoreManage, Permission.StoreAuthorize]) {
      mocks.identity.mockResolvedValue({ view: { ...nodeActor, permissions: nodeActor.permissions.filter(bit => bit !== removed) }, authority: nodeAuthority });
      expect((await POST(request("/enrollments", nodeInput), context("enrollments"))).status).toBe(403);
    }
    mocks.identity.mockResolvedValue({ view: nodeActor, authority: nodeAuthority });
    expect((await GET(request("", undefined, null), context())).status).toBe(409);
    expect((await POST(request("/enrollments", nodeInput, "f".repeat(64)), context("enrollments"))).status).toBe(409);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("binds first-use enrollment to the exact request and allows revocation with disabled node configuration", async () => {
    mocks.upstream.mockResolvedValueOnce(nodeResponse(nodeCreated(), 201));
    const created = await POST(request("/enrollments", nodeInput), context("enrollments"));
    expect(created.status).toBe(201); expect(created.headers.get("x-yummyai-context-authority")).toBe(nodeAuthority);
    expect(created.headers.get("cache-control")).toBe("private, no-store");
    expect(Boolean((await created.json() as { enrollment: { ticketToken: string } }).enrollment.ticketToken)).toBe(true);
    const sent = JSON.parse(String(mocks.upstream.mock.calls[0]![1]!.body)) as typeof nodeInput;
    expect(sent.idempotencyKey).toBe(nodeInput.idempotencyKey); expect(sent.publicKeyPem).toBe(nodeInput.publicKeyPem);
    const wrong = nodeCreated(); wrong.workspace.nodes[0]!.creationRequestKey = "f".repeat(64);
    mocks.upstream.mockResolvedValueOnce(nodeResponse(wrong, 201));
    const rejected = await POST(request("/enrollments", nodeInput), context("enrollments"));
    expect(rejected.status).toBe(502); expect((await rejected.text()).includes("ticketToken")).toBe(false);
    const swapped = nodeCreated(); swapped.enrollment.nodeId = nodeIds.other;
    mocks.upstream.mockResolvedValueOnce(nodeResponse(swapped, 201));
    expect((await POST(request("/enrollments", nodeInput), context("enrollments"))).status).toBe(502);
    const revoked = nodeWorkspace(); revoked.configuration.enabled = false; revoked.nodes[0]!.status = "revoked";
    const fence = { expectedAuthorizationGeneration: nodeIds.generation, expectedBindingRevision: 0, expectedCertificateGeneration: 1 };
    mocks.upstream.mockResolvedValueOnce(nodeResponse(revoked));
    expect((await POST(request(`/${nodeIds.node}/revoke`, fence), context(nodeIds.node, "revoke"))).status).toBe(200);
    const untouched = nodeWorkspace(); untouched.configuration.enabled = false;
    mocks.upstream.mockResolvedValueOnce(nodeResponse(untouched));
    expect((await POST(request(`/${nodeIds.node}/revoke`, fence), context(nodeIds.node, "revoke"))).status).toBe(502);
  });
  it("discards a submitted ticket after current identity changes and exposes only a finite safe error code", async () => {
    mocks.upstream.mockResolvedValueOnce(nodeResponse(nodeCreated(), 201));
    mocks.current.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const late = await POST(request("/enrollments", nodeInput), context("enrollments"));
    expect(late.status).toBe(409); expect((await late.text()).includes("ticketToken")).toBe(false);
    mocks.current.mockResolvedValue(undefined);
    mocks.upstream.mockResolvedValueOnce(nodeResponse({ code: "store_node_ticket_not_replayable", raw: "synthetic-private-upstream-diagnostic" }, 409));
    const replay = await POST(request("/enrollments", nodeInput), context("enrollments"));
    expect(replay.status).toBe(409); const text = await replay.text();
    expect(text).toContain("store_node_ticket_not_replayable"); expect(text).not.toContain("synthetic-private-upstream-diagnostic");
    mocks.upstream.mockResolvedValueOnce(nodeResponse({ code: "not_an_allowed_code", message: "synthetic-private-upstream-diagnostic" }, 409));
    const other = await POST(request("/enrollments", nodeInput), context("enrollments"));
    expect(await other.json()).not.toHaveProperty("code");
  });
});
