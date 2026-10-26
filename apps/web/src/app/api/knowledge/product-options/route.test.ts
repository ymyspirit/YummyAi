import { createEntityId } from "@yummyai/contracts";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PersonalSessionError } from "../../../../identity/core";
const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(), failure: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("../../../../erp-auth/server", () => ({ erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current, erpAuthFailure: mocks.failure }));
import { GET } from "./route";
const actor: ErpSessionView = { authenticated: true, canUseErp: true, tenantId: createEntityId(), userId: createEntityId(), dataScope: "tenant",
  displayName: "Synthetic P6 operator", organizationName: "Synthetic P6 tenant", permissions: ["workflow:read", "product:read"],
  permissionScopes: { "workflow:read": "tenant", "product:read": "tenant" } };
const authority = erpSessionAuthority(actor);
const request = (query = "", stamp: string | null = authority) => new Request("http://web.test/api/knowledge/product-options" + query,
  { headers: stamp === null ? {} : { "x-yummyai-context-authority": stamp } });
const candidates = () => ({ contextAuthority: authority, items: [{ id: createEntityId(), code: "PILLOW", name: "Synthetic pillow" }], hasMore: false, limit: 40 });
beforeEach(() => {
  vi.clearAllMocks(); mocks.upstream.mockReset(); mocks.identity.mockResolvedValue({ view: actor }); mocks.current.mockResolvedValue();
  mocks.failure.mockImplementation((error: PersonalSessionError) => Response.json({ code: error.code }, { status: error.status }));
  vi.stubEnv("API_BASE_URL", "http://api.test");
});
afterEach(() => vi.unstubAllEnvs());

it("rejects caller scope injection, duplicate query and missing authority without reading products", async () => {
  for (const query of ["?tenantId=other", "?q=a&q=b", "?limit=100", "?q=" + "x".repeat(201)])
    expect((await GET(request(query))).status).toBe(400);
  expect((await GET(request("", null))).status).toBe(409);
  expect(mocks.upstream).not.toHaveBeenCalled();
});
it("reads only the bounded original owner options and preserves exact Unicode search", async () => {
  const value = candidates(); mocks.upstream.mockResolvedValueOnce(Response.json(value));
  const response = await GET(request("?q=" + encodeURIComponent(" 抱枕%_ ")));
  expect(response.status).toBe(200); expect(await response.json()).toEqual(value);
  expect(response.headers.get("x-yummyai-context-authority")).toBe(authority);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(mocks.upstream).toHaveBeenCalledWith("http://api.test/v1/knowledge/product-options?q=%E6%8A%B1%E6%9E%95%25_", expect.objectContaining({ cache: "no-store" }));
  expect(mocks.current).toHaveBeenCalledTimes(1);
});
it("rejects another authority and clears a late response after membership changes", async () => {
  mocks.upstream.mockResolvedValueOnce(Response.json({ ...candidates(), contextAuthority: "another scope" }));
  expect((await GET(request())).status).toBe(409);
  mocks.upstream.mockResolvedValueOnce(Response.json(candidates())); mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
  const response = await GET(request()); expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ code: "authority_changed" });
});
it("rejects malformed, oversized and non-200 upstream results without exposing private diagnostics", async () => {
  const row = candidates().items[0]!;
  for (const value of [{ ...candidates(), items: [row, row] }, { ...candidates(), hasMore: true }, { ...candidates(), limit: 100 }]) {
    mocks.upstream.mockResolvedValueOnce(Response.json(value)); expect((await GET(request())).status).toBe(502);
  }
  mocks.upstream.mockResolvedValueOnce(Response.json({ ...candidates(), privateDetails: "x".repeat(130 * 1024) }));
  expect((await GET(request())).status).toBe(502);
  mocks.upstream.mockResolvedValueOnce(Response.json(candidates(), { status: 201 })); expect((await GET(request())).status).toBe(502);
  mocks.upstream.mockResolvedValueOnce(Response.json({ message: "private source content" }, { status: 403 }));
  const denied = await GET(request()); expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("private source");
});
