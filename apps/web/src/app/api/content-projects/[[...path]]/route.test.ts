import { afterEach, describe, expect, it, vi } from "vitest";
import { createEntityId } from "@yummyai/contracts";
import { PersonalSessionError } from "../../../../identity/core";
const personal = vi.hoisted(() => ({ identity: vi.fn(), current: vi.fn(), fetch: vi.fn(), logout: vi.fn(), localFetch: vi.fn() }));
vi.mock("../../../../server-api", () => ({ apiFetch: vi.fn() }));
vi.mock("../../../../erp-auth/request", () => ({ erpAmbientIdentity: personal.identity, hasNextRequestContext: vi.fn().mockResolvedValue(true) }));
vi.mock("../../../../erp-auth/server", () => ({ assertErpIdentityCurrent: personal.current,
  erpAuthFailure: (error: { status: number }) => Response.json({ message: "PRIVATE_AUTH_DIAGNOSTIC" }, { status: error.status }) }));
vi.mock("../../../../local-service-api", () => ({ getLocalApiHeaders: vi.fn(), localApiFetch: personal.localFetch }));
import { apiFetch } from "../../../../server-api";
import { GET } from "./route";
const get = (path: string[] = [], query = "", options: { origin?: string; headers?: HeadersInit; signal?: AbortSignal } = {}) => GET(new Request(`${options.origin ?? "http://localhost:3000"}/api/content-projects${path.length ? `/${path.join("/")}` : ""}${query}`, { headers: options.headers, signal: options.signal }), { params: Promise.resolve({ path }) });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
describe("content project authenticated read proxy", () => {
  it("allows the pillow list and exact order route without widening the read allowlist", async () => {
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8000");
    vi.mocked(apiFetch).mockResolvedValue(Response.json({}));
    expect((await get(["pillow"], "?stage=in_review&page=2")).status).toBe(200);
    expect(vi.mocked(apiFetch).mock.calls[0]?.[0]).toBe("http://127.0.0.1:8000/v1/content-projects/pillow?q=&page=2&pageSize=20&stage=in_review");
    const id = createEntityId();
    expect((await get(["pillow", "orders", id])).status).toBe(200);
    expect((await get(["pillow", "orders", id], "?tenantId=other")).status).toBe(400);
    expect((await get(["pillow", "orders", id, "resume"])).status).toBe(404);
    expect((await get(["pillow"], "?stage=made-up")).status).toBe(400);
  });
  it("passes only validated filters and forwards an existing authenticated response privately", async () => {
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8000");
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ items: [] }));
    const response = await get([], "?q=original&page=2");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(vi.mocked(apiFetch).mock.calls[0]?.[0]).toBe("http://127.0.0.1:8000/v1/content-projects?q=original&page=2&pageSize=20");
  });
  it("rejects caller-selected tenancy, path traversal and invalid paging before a network call", async () => {
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8000");
    for (const query of ["?tenantId=other", "?page=-1", "?page=1.5", "?pageSize=100"]) expect((await get([], query)).status).toBe(400);
    expect((await get([createEntityId(), "export"])).status).toBe(404);
    expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
  it("rejects cross-site reads in production before an upstream request", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await get([], "", { origin: "https://erp.example.test", headers: { "sec-fetch-site": "cross-site" } });
    expect(response.status).toBe(403); expect(vi.mocked(apiFetch)).not.toHaveBeenCalled();
  });
  it("preserves authorization failures without leaking upstream bodies", async () => {
    vi.stubEnv("API_BASE_URL", "http://127.0.0.1:8000");
    vi.mocked(apiFetch).mockResolvedValue(Response.json({ privateDetail: "synthetic" }, { status: 403 }));
    const response = await get([createEntityId()]);
    expect(response.status).toBe(403); expect(await response.text()).not.toContain("synthetic");
  });
  it.each([[], ["pillow"]].map(path => ({ path })))("rejects duplicate filters for $path before reading private data", async ({ path }) => {
    vi.stubEnv("API_BASE_URL", "https://api.example.test");
    for (const query of ["?q=first&q=second", "?page=1&page=2", "?pageSize=20&pageSize=30", "?tenantId=first&tenantId=second"]) {
      expect((await get(path, query)).status).toBe(400);
    }
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it.each([[], ["pillow"], [createEntityId()], ["pillow", "orders", createEntityId()]].map(path => ({ path })))("rejects tenant query selection for $path", async ({ path }) => {
    vi.stubEnv("API_BASE_URL", "https://api.example.test");
    expect((await get(path, "?tenantId=another-tenant")).status).toBe(400);
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it.each([["tenants", createEntityId()], ["pillow", "tenants", createEntityId()], ["pillow", "orders", ".."], ["pillow", "orders", `${createEntityId()}%2Fprivate`]].map(path => ({ path })))("rejects unlisted tenant or traversal path $path", async ({ path }) => {
    vi.stubEnv("API_BASE_URL", "https://api.example.test");
    expect((await get(path)).status).toBe(404);
    expect(apiFetch).not.toHaveBeenCalled();
  });
  it("shares cancellation with the original read and never retries a failed transport", async () => {
    vi.stubEnv("API_BASE_URL", "https://api.example.test");
    const controller = new AbortController();
    vi.mocked(apiFetch).mockRejectedValue(new Error("PRIVATE_UPSTREAM_DIAGNOSTIC"));
    const response = await get([], "", { signal: controller.signal });
    const signal = vi.mocked(apiFetch).mock.calls[0]?.[1]?.signal;
    controller.abort(); expect(signal?.aborted).toBe(true);
    expect(response.status).toBe(502); expect(await response.text()).not.toContain("PRIVATE");
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});

async function personalTransport() {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("WEB_AUTH_MODE", "personal");
  vi.stubEnv("API_BASE_URL", "https://api.example.test"); vi.stubGlobal("fetch", personal.fetch);
  personal.identity.mockResolvedValue({ token: "test-user-token", sessionId: "synthetic-session",
    service: { configuration: { apiBase: "https://api.example.test" }, logout: personal.logout } });
  personal.current.mockResolvedValue(undefined); personal.logout.mockResolvedValue(undefined);
  const original = await vi.importActual<{ apiFetch: typeof apiFetch }>("../../../../server-api");
  vi.mocked(apiFetch).mockImplementation(original.apiFetch);
}

describe("production content projects use the existing personal OIDC transport", () => {
  it.each([[], ["pillow"], [createEntityId()], ["pillow", "orders", createEntityId()]].map(path => ({ path })))("reads allowed path $path from a deployed non-loopback origin", async ({ path }) => {
    await personalTransport(); personal.fetch.mockResolvedValue(Response.json({ items: [] }));
    const response = await get(path, "", { origin: "https://erp.example.test", headers: {
      "sec-fetch-site": "same-origin", authorization: "Bearer caller-forged-token", "x-tenant-id": "caller-selected-tenant" } });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ items: [] });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(personal.identity).toHaveBeenCalledTimes(1); expect(personal.current).toHaveBeenCalledTimes(1);
    expect(personal.localFetch).not.toHaveBeenCalled();
    const [url, init] = personal.fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe("https://api.example.test");
    expect(url.pathname).toBe(`/v1/content-projects${path.length ? `/${path.join("/")}` : ""}`);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-user-token");
    expect(new Headers(init.headers).has("x-tenant-id")).toBe(false);
    expect(init).toMatchObject({ cache: "no-store", redirect: "error" });
  });
  it.each([401, 403] as const)("preserves personal authentication status %i without disclosing its diagnostics", async status => {
    await personalTransport(); personal.identity.mockRejectedValue(new PersonalSessionError(status, status === 401 ? "login_required" : "erp_access_denied"));
    const response = await get([], "", { origin: "https://erp.example.test" });
    expect(response.status).toBe(status); expect(await response.text()).not.toContain("PRIVATE");
    expect(personal.fetch).not.toHaveBeenCalled(); expect(personal.localFetch).not.toHaveBeenCalled();
  });
  it("keeps backend permission denial authoritative even for an authenticated operator", async () => {
    await personalTransport(); personal.fetch.mockResolvedValue(Response.json({ message: "PRIVATE_TENANT_DIAGNOSTIC" }, { status: 403 }));
    const response = await get(["pillow"], "", { origin: "https://erp.example.test" });
    expect(response.status).toBe(403); expect(await response.text()).not.toContain("PRIVATE");
    expect(personal.current).toHaveBeenCalledTimes(1); expect(personal.localFetch).not.toHaveBeenCalled();
  });
  it("does not adopt a successful upstream response after the personal membership expires", async () => {
    await personalTransport(); personal.fetch.mockResolvedValue(Response.json({ privateBody: "PRIVATE_PROJECT_DATA" }));
    personal.current.mockRejectedValue(new PersonalSessionError(401, "login_required"));
    const response = await get([], "", { origin: "https://erp.example.test" });
    expect(response.status).toBe(401); expect(await response.text()).not.toContain("PRIVATE");
    expect(personal.localFetch).not.toHaveBeenCalled();
  });
});
