import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonalSessionError } from "./identity/core";
import type { ErpRequestIdentity } from "./erp-auth/server";
import type * as ErpServer from "./erp-auth/server";

const authority = vi.hoisted(() => ({ ambient: vi.fn(), current: vi.fn(), scope: vi.fn() }));
vi.mock("./erp-auth/request", () => ({
  erpAmbientIdentity: authority.ambient,
  hasNextRequestContext: authority.scope,
}));
vi.mock("./erp-auth/server", async (original) => ({
  ...(await original<typeof ErpServer>()),
  assertErpIdentityCurrent: authority.current,
}));
import { apiFetch, getApiHeaders } from "./server-api";
import { getLocalApiHeaders } from "./local-service-api";

function actor(token: string) {
  return {
    token,
    sessionId: "synthetic-session",
    service: {
      configuration: { apiBase: "https://api.example" },
      logout: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as ErpRequestIdentity;
}
beforeEach(() => {
  vi.stubEnv("WEB_AUTH_MODE", "personal");
  vi.stubEnv("FACTORY_PORTAL_ONLY", "0");
  vi.stubEnv("E2E_ISOLATED_DAILY", "0");
  vi.stubEnv("API_ACCESS_TOKEN", "synthetic-service-credential");
  authority.ambient.mockReset();
  authority.current.mockReset();
  authority.scope.mockReset();
  authority.current.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("personal server API authority", () => {
  it("never falls back to the process credential when personal authentication fails", async () => {
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    authority.ambient.mockRejectedValue(new PersonalSessionError(401, "login_required"));
    expect((await apiFetch("https://api.example/v1/products")).status).toBe(401);
    await expect(getApiHeaders()).rejects.toMatchObject({ status: 401 });
    expect(transport).not.toHaveBeenCalled();
  });
  it("keeps concurrent callers' access tokens separate and overrides supplied authorization", async () => {
    authority.ambient
      .mockResolvedValueOnce(actor("synthetic-reader"))
      .mockResolvedValueOnce(actor("synthetic-operator"));
    const transport = vi.fn().mockImplementation(async () => new Response("{}"));
    vi.stubGlobal("fetch", transport);
    const responses = await Promise.all([
      apiFetch("https://api.example/v1/products", {
        headers: { authorization: "Bearer synthetic-forged" },
      }),
      apiFetch("https://api.example/v1/orders"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(
      transport.mock.calls.map((call) => new Headers(call[1].headers).get("authorization")),
    ).toEqual(["Bearer synthetic-reader", "Bearer synthetic-operator"]);
    expect(
      transport.mock.calls.every(
        (call) => call[1].cache === "no-store" && call[1].redirect === "error",
      ),
    ).toBe(true);
  });
  it("does not replay a write when the business API rejects the personal token", async () => {
    const identity = actor("synthetic-expired");
    authority.ambient.mockResolvedValue(identity);
    const transport = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", transport);
    expect(
      (await apiFetch("https://api.example/v1/products", { method: "POST", body: "{}" })).status,
    ).toBe(401);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(identity.service.logout).toHaveBeenCalledTimes(1);
  });
  it("discards a completed response if the user's authority changed while it was in flight", async () => {
    authority.ambient.mockResolvedValue(actor("synthetic-before-change"));
    authority.current.mockRejectedValue(new PersonalSessionError(409, "authority_changed"));
    const cancel = vi.fn(),
      transport = vi
        .fn()
        .mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 201 }));
    vi.stubGlobal("fetch", transport);
    const response = await apiFetch("https://api.example/v1/products", { method: "POST" });
    expect(response.status).toBe(409);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect((await response.json()).message).toContain("原操作结果");
  });
  it("does not send personal tokens to another origin or outside the business API prefix", async () => {
    authority.ambient.mockResolvedValue(actor("synthetic-private"));
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    for (const target of [
      "https://untrusted.example/v1/products",
      "https://api.example/not-v1/products",
    ])
      expect((await apiFetch(target)).status).toBe(400);
    expect(transport).not.toHaveBeenCalled();
  });
  it("rejects direct developer credential access in production, including disposable flags", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("WEB_AUTH_MODE", "local-service");
    vi.stubEnv("E2E_ISOLATED_DAILY", "1");
    vi.stubEnv(
      "DATABASE_URL",
      "postgres://localhost/order_daily_e2e_01234567890123456789012345678901",
    );
    vi.stubEnv("S3_PRIVATE_BUCKET", "order-daily-e2e-01234567890123456789012345678901");
    await expect(getLocalApiHeaders()).rejects.toMatchObject({ status: 403 });
    expect(authority.scope).not.toHaveBeenCalled();
  });
});
