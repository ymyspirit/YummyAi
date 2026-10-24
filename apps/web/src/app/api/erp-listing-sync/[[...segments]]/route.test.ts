import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { PersonalSessionError } from "../../../../identity/core";
import { syncActor, syncAuthority, syncChecksum, syncIds, syncInput, syncReceipt, syncResponse, syncView, syncWorkspace } from "../../../../features/marketplaces/listing-sync.test-fixture";
const mocks = vi.hoisted(() => ({ identity: vi.fn(), current: vi.fn<() => Promise<void>>(), upstream: vi.fn<typeof fetch>() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current,
  erpAuthFailure: (error: PersonalSessionError) => Response.json({ code: error.code, message: "本人权限需重新核对" }, { status: error.status, headers: { "cache-control": "private, no-store" } }) }));
import { GET, POST } from "./route";

const origin = "http://localhost:3130", base = origin + "/api/erp-listing-sync", context = (...segments: string[]) => ({ params: Promise.resolve({ segments }) });
function request(suffix = "", body?: unknown, authority: string | null = syncAuthority, from: string | null = origin) {
  const headers = new Headers(authority === null ? undefined : { "x-yummyai-context-authority": authority });
  if (body !== undefined) { headers.set("content-type", "application/json"); if (from !== null) headers.set("origin", from); }
  return new Request(base + suffix, { method: body === undefined ? "GET" : "POST", headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
const receiptPath = () => `/receipt?requestKey=${syncIds.key}&requestChecksum=${syncChecksum()}`;
beforeEach(() => { vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8130"); mocks.identity.mockReset().mockResolvedValue({ view: syncActor, authority: syncAuthority });
  mocks.current.mockReset().mockResolvedValue(undefined); mocks.upstream.mockReset(); });
afterEach(() => vi.unstubAllEnvs());
describe("fixed personal Listing sync BFF", () => {
  it("rejects unknown paths, duplicate queries, foreign origins and missing original keys before forwarding", async () => {
    expect((await GET(request("/requests"), context("requests"))).status).toBe(400);
    expect((await GET(request(`/workspace?listingId=${syncIds.listing}&listingId=${syncIds.listing}`), context("workspace"))).status).toBe(400);
    expect((await GET(request(`/requests/${syncIds.request}?target=other`), context("requests", syncIds.request))).status).toBe(400);
    expect((await POST(request("/receipt", {}), context("receipt"))).status).toBe(400);
    expect((await POST(request("/requests", syncInput(), syncAuthority, "https://other.synthetic.test"), context("requests"))).status).toBe(403);
    expect((await POST(request("/requests", { ...syncInput(), requestKey: undefined }), context("requests"))).status).toBe(400);
    expect((await POST(request("/requests", { ...syncInput(), desiredState: { synthetic: true } }), context("requests"))).status).toBe(400);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });
  it("allows read-only recovery but requires current Publish and exact personal authority for a new request", async () => {
    const reader = { ...syncActor, permissions: ["listing:read"] as typeof syncActor.permissions }, authority = createHash("sha256").update(erpSessionAuthority(reader)).digest("hex");
    mocks.identity.mockResolvedValue({ view: reader, authority });
    expect((await POST(request("/requests", syncInput(), authority), context("requests"))).status).toBe(403); expect(mocks.upstream).not.toHaveBeenCalled();
    mocks.upstream.mockResolvedValueOnce(Response.json(syncReceipt()));
    const recovered = await GET(request(receiptPath(), undefined, authority), context("receipt")); expect(recovered.status).toBe(200);
    expect(recovered.headers.get("x-yummyai-context-authority")).toBe(authority);
    expect(mocks.upstream.mock.calls[0]![1]!.method).toBe("GET");
    const count = mocks.upstream.mock.calls.length;
    expect((await GET(request(receiptPath(), undefined, null), context("receipt"))).status).toBe(409); expect(mocks.upstream).toHaveBeenCalledTimes(count);
  });
  it("proves POST 201 with the original key and target receipt, rejecting substituted IDs, targets or a missing stored receipt", async () => {
    mocks.upstream.mockResolvedValueOnce(syncResponse(syncView(), 201)).mockResolvedValueOnce(syncResponse(syncReceipt()));
    const result = await POST(request("/requests", syncInput()), context("requests")); expect(result.status).toBe(201);
    expect(result.headers.get("cache-control")).toBe("private, no-store"); expect((await result.json() as { id: string }).id).toBe(syncIds.request);
    expect(mocks.upstream.mock.calls[1]![0]).toBe(`http://127.0.0.1:8130/v1/marketplace-listing-syncs${receiptPath()}`);
    expect(mocks.upstream.mock.calls[1]![1]!.method).toBe("GET");
    const wrong = syncReceipt(); wrong.request!.listingVersionId = syncIds.other;
    mocks.upstream.mockResolvedValueOnce(syncResponse(syncView(), 201)).mockResolvedValueOnce(syncResponse(wrong));
    expect((await POST(request("/requests", syncInput()), context("requests"))).status).toBe(502);
    const wrongId = syncReceipt(); wrongId.request!.id = syncIds.other;
    mocks.upstream.mockResolvedValueOnce(syncResponse(syncView(), 201)).mockResolvedValueOnce(syncResponse(wrongId));
    expect((await POST(request("/requests", syncInput()), context("requests"))).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(syncResponse(syncView(), 201)).mockResolvedValueOnce(syncResponse({ message: "synthetic missing stored receipt" }, 404));
    expect((await POST(request("/requests", syncInput()), context("requests"))).status).toBe(502);
  });
  it("binds original IDs and event history, masks upstream errors, and refuses late private facts after authority changes", async () => {
    mocks.upstream.mockResolvedValueOnce(syncResponse({ ...syncView(), id: syncIds.other }));
    expect((await GET(request(`/requests/${syncIds.request}`), context("requests", syncIds.request))).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(syncResponse(syncView())).mockResolvedValueOnce(syncResponse([{ ...syncView().current, id: syncIds.other }]));
    expect((await GET(request(`/requests/${syncIds.request}/events`), context("requests", syncIds.request, "events"))).status).toBe(502);
    mocks.upstream.mockResolvedValueOnce(syncResponse({ code: "raw_private_diagnostic", message: "synthetic raw details" }, 503));
    const masked = await GET(request(`/workspace?listingId=${syncIds.listing}`), context("workspace")); expect(masked.status).toBe(503); expect(await masked.text()).not.toContain("synthetic raw details");
    mocks.upstream.mockResolvedValueOnce(syncResponse(syncWorkspace())); mocks.current.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const denied = await GET(request(`/workspace?listingId=${syncIds.listing}`), context("workspace")); expect(denied.status).toBe(409); expect(await denied.text()).not.toContain("Synthetic original account");
  });
});
