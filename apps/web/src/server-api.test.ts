import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("apiFetch", () => {
  it("refreshes a cached OIDC token and retries once after a 401", async () => {
    delete process.env.API_ACCESS_TOKEN;
    process.env.OIDC_ISSUER = "http://identity.test/realms/yummyai";
    process.env.LOCAL_OIDC_CLIENT_ID = "local-client";
    process.env.LOCAL_OIDC_CLIENT_SECRET = "local-secret";

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "stale", expires_in: 300 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "fresh", expires_in: 300 }))
      .mockResolvedValueOnce(jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("./server-api");

    const response = await apiFetch("http://api.test/v1/research-items", {
      cache: "no-store",
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(authorizationHeader(fetchMock.mock.calls[1]?.[1])).toBe("Bearer stale");
    expect(authorizationHeader(fetchMock.mock.calls[3]?.[1])).toBe("Bearer fresh");
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function authorizationHeader(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get("authorization");
}
