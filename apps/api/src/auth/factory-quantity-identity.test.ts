import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";

type Fixture = Awaited<ReturnType<typeof startFactoryIdentityFixture>>;
let fixture: Fixture | undefined;
const erp = "http://localhost:3130/api/erp-auth/callback", factory = "http://localhost:31991/api/factory-auth/callback";
const call = (url: string, params?: URLSearchParams) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000),
  ...(params ? { method: "POST", body: params } : {}) });
async function start(dual = true) {
  vi.stubEnv("FACTORY_QUANTITY_FACTORY_ORIGIN", "http://localhost:31991");
  fixture = await startFactoryIdentityFixture("019f0000-0000-7000-8000-000000000001", "synthetic-operator", dual ? "http://localhost:3130" : "http://localhost:31991",
    dual ? { application: "erp", clientId: "yummyai-web", factoryQuantityDualClient: true } : {});
  return fixture;
}
async function authorize(value: Fixture, clientId: string, redirect: string) {
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url");
  const params = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirect, state, nonce,
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url") });
  const response = await call(`${value.baseUrl}/protocol/openid-connect/auth?${params}`); expect(response.status).toBe(200);
  const flow = /name="flow" value="([A-Za-z0-9_-]+)"/.exec(await response.text())?.[1]; expect(flow).toBeTruthy();
  const login = await call(`${value.baseUrl}/fixture-login`, new URLSearchParams({ flow: flow!, account: "main" })); expect(login.status).toBe(303);
  const destination = new URL(login.headers.get("location")!); expect(`${destination.origin}${destination.pathname}`).toBe(redirect);
  expect(destination.searchParams.get("state")).toBe(state); expect(destination.searchParams.get("iss")).toBe(value.baseUrl);
  return { clientId, redirect, verifier, nonce, code: destination.searchParams.get("code")! };
}
async function exchange(value: Fixture, flow: Awaited<ReturnType<typeof authorize>>, changes: Record<string, string> = {}) {
  return call(`${value.baseUrl}/protocol/openid-connect/token`, new URLSearchParams({ grant_type: "authorization_code", client_id: flow.clientId,
    code: flow.code, redirect_uri: flow.redirect, code_verifier: flow.verifier, ...changes }));
}
afterEach(async () => { try { await fixture?.close(); } finally { fixture = undefined; vi.unstubAllEnvs(); } });

describe("opt-in factory quantity dual personal identity fixture", () => {
  it("preserves the default single factory client and rejects the extra ERP client", async () => {
    const value = await start(false), flow = await authorize(value, "yummyai-factory", factory);
    expect((await exchange(value, flow)).status).toBe(200);
    const params = new URLSearchParams({ client_id: "yummyai-web", response_type: "code", redirect_uri: erp,
      state: "s".repeat(43), nonce: "n".repeat(43), code_challenge: "c".repeat(43), code_challenge_method: "S256" });
    expect((await call(`${value.baseUrl}/protocol/openid-connect/auth?${params}`)).status).toBe(400);
    expect(value.proof()).not.toHaveProperty("clients");
  });
  it("signs both real PKCE code flows for their exact client audience and isolated callback", async () => {
    const value = await start(), jwks = createRemoteJWKSet(new URL(`${value.baseUrl}/protocol/openid-connect/certs`));
    for (const [client, redirect] of [["yummyai-web", erp], ["yummyai-factory", factory]] as const) {
      const flow = await authorize(value, client, redirect), response = await exchange(value, flow); expect(response.status).toBe(200);
      const tokens = await response.json() as { access_token: string; id_token: string; refresh_token: string };
      expect((await jwtVerify(tokens.id_token, jwks, { issuer: value.baseUrl, audience: client })).payload).toMatchObject({ nonce: flow.nonce, sub: "synthetic-factory-main" });
      expect((await jwtVerify(tokens.access_token, jwks, { issuer: value.baseUrl, audience: "yummyai-api" })).payload).toMatchObject({ azp: client });
      const refresh = await call(`${value.baseUrl}/protocol/openid-connect/token`, new URLSearchParams({ grant_type: "refresh_token", client_id: client, refresh_token: tokens.refresh_token }));
      expect(refresh.status).toBe(200);
      const renewed = await refresh.json() as { access_token: string; refresh_token: string };
      expect(renewed.refresh_token).not.toBe(tokens.refresh_token);
      expect((await jwtVerify(renewed.access_token, jwks, { issuer: value.baseUrl, audience: "yummyai-api" })).payload.azp).toBe(client);
    }
    expect(value.proof()).toMatchObject({ authorizationRequests: 2, codeExchanges: 2, refreshExchanges: 2,
      clients: { "yummyai-web": { authorizationRequests: 1, codeExchanges: 1, refreshExchanges: 1 }, "yummyai-factory": { authorizationRequests: 1, codeExchanges: 1, refreshExchanges: 1 } } });
  });
  it("rejects swapped clients, origins, callback paths and arbitrary loopback ports", async () => {
    const value = await start();
    for (const [client, redirect] of [["yummyai-web", factory], ["yummyai-factory", erp], ["yummyai-factory", factory.replace("31991", "31992")],
      ["yummyai-factory", factory.replace("factory-auth", "erp-auth")], ["other-client", factory]]) {
      const params = new URLSearchParams({ client_id: client!, response_type: "code", redirect_uri: redirect!, state: "s".repeat(43), nonce: "n".repeat(43),
        code_challenge_method: "S256", code_challenge: "c".repeat(43) });
      expect((await call(`${value.baseUrl}/protocol/openid-connect/auth?${params}`)).status).toBe(400);
    }
    expect(value.proof().authorizationRequests).toBe(0);
  });
  it("cannot exchange one client's actual code with the other client or a different redirect", async () => {
    const value = await start();
    const attempts: Record<string, string>[] = [{ client_id: "yummyai-web", redirect_uri: erp }, { redirect_uri: erp }];
    for (const changes of attempts) {
      const flow = await authorize(value, "yummyai-factory", factory);
      expect((await exchange(value, flow, changes)).status).toBe(400);
      expect((await exchange(value, flow)).status).toBe(400);
    }
    expect(value.proof().codeExchanges).toBe(0);
  });
  it("checks actual PKCE and consumes each code once without a second result", async () => {
    const value = await start(), bad = await authorize(value, "yummyai-web", erp);
    expect((await exchange(value, bad, { code_verifier: "wrong-verifier" })).status).toBe(400);
    expect((await exchange(value, bad)).status).toBe(400);
    const good = await authorize(value, "yummyai-web", erp);
    expect((await exchange(value, good)).status).toBe(200); expect((await exchange(value, good)).status).toBe(400);
  });
  it("cannot redeem or rotate another client's actual refresh token", async () => {
    const value = await start(), flow = await authorize(value, "yummyai-factory", factory), response = await exchange(value, flow);
    expect(response.status).toBe(200); const tokens = await response.json() as { refresh_token: string };
    const wrong = new URLSearchParams({ grant_type: "refresh_token", client_id: "yummyai-web", refresh_token: tokens.refresh_token });
    expect((await call(`${value.baseUrl}/protocol/openid-connect/token`, wrong)).status).toBe(400);
    wrong.set("client_id", "yummyai-factory"); expect((await call(`${value.baseUrl}/protocol/openid-connect/token`, wrong)).status).toBe(400);
    expect(value.proof().refreshExchanges).toBe(0);
  });
  it("rejects an untrusted or reserved dual origin before opening an identity listener", async () => {
    for (const origin of ["https://external.example", "http://localhost:3130", "http://localhost:3132", "http://localhost:8001", "http://localhost:31991/path", "http://user:pass@localhost:31991"]) {
      vi.stubEnv("FACTORY_QUANTITY_FACTORY_ORIGIN", origin);
      await expect(startFactoryIdentityFixture("tenant", "operator", "http://localhost:3130", { factoryQuantityDualClient: true })).rejects.toThrow("Invalid dual factory fixture origin");
    }
  });
});
