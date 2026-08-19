import { afterEach, describe, expect, it, vi } from "vitest";

import { exchangeExtensionCode, refreshExtensionAccessToken } from "./auth.js";

afterEach(() => vi.restoreAllMocks());

describe("extension OIDC token exchange", () => {
  it("exchanges a PKCE authorization code and stores expiry metadata", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access", expires_in: 300, refresh_token: "refresh" }), {
        headers: { "content-type": "application/json" },
        status: 200,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await exchangeExtensionCode(
      { code: "code", codeVerifier: "verifier", redirectUri: "https://ext.chromiumapp.org/oidc" },
      { tokenEndpoint: "http://localhost:8081/token" },
    );

    expect(result.accessToken).toBe("access");
    expect(result.refreshToken).toBe("refresh");
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain("grant_type=authorization_code");
  });

  it("surfaces the identity provider error when refresh fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error_description: "Refresh token is expired" }), {
          headers: { "content-type": "application/json" },
          status: 400,
        }),
      ),
    );

    await expect(
      refreshExtensionAccessToken("expired", { tokenEndpoint: "http://localhost:8081/token" }),
    ).rejects.toThrow("Refresh token is expired");
  });
});
