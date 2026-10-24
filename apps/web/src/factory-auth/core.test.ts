import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { FactoryIdentitySessions } from "./core";
import type { FactoryAuthStore } from "./store";

class MemoryStore implements FactoryAuthStore {
  readonly rows = new Map<string, { value: string; expires: number }>();
  readonly locks = new Map<string, string>();
  failRemoval = false;
  async get(kind: "flow" | "session", id: string) {
    const key = `${kind}:${id}`,
      row = this.rows.get(key);
    if (row && row.expires > Date.now()) return row.value;
    this.rows.delete(key);
    return null;
  }
  async put(kind: "flow" | "session", id: string, value: string, ttl: number) {
    this.rows.set(`${kind}:${id}`, { value, expires: Date.now() + ttl * 1000 });
  }
  async consumeFlow(id: string, expected: string) {
    const key = `flow:${id}`,
      row = this.rows.get(key);
    if (row?.value !== expected) return false;
    this.rows.delete(key);
    return true;
  }
  async replaceSession(id: string, previous: string, next: string) {
    const key = `session:${id}`,
      row = this.rows.get(key);
    if (row?.value !== previous) return false;
    this.rows.set(key, { value: next, expires: row.expires });
    return true;
  }
  async removeSession(id: string) {
    if (this.failRemoval) throw Error("Synthetic store unavailable during removal");
    this.rows.delete(`session:${id}`);
  }
  async takeRefreshLock(id: string, owner: string) {
    if (this.locks.has(id)) return false;
    this.locks.set(id, owner);
    return true;
  }
  async releaseRefreshLock(id: string, owner: string) {
    if (this.locks.get(id) === owner) this.locks.delete(id);
  }
  async isRefreshLocked(id: string) {
    return this.locks.has(id);
  }
}
function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe("personal factory identity sessions", () => {
  let server: Server, issuer: string, privateKey: CryptoKey;
  const tenantId = "019f0000-0000-7000-8000-000000000001",
    clientId = "synthetic-factory-client",
    subject = "synthetic-factory-member";
  beforeAll(async () => {
    const keys = await generateKeyPair("RS256");
    privateKey = keys.privateKey;
    const publicKey = await exportJWK(keys.publicKey);
    server = createServer((request, response) => {
      if (request.url !== "/keys") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          keys: [{ ...publicKey, kid: "synthetic-factory-key", alg: "RS256", use: "sig" }],
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.unstubAllEnvs();
  });
  async function scenario(
    options: {
      wrongNonce?: boolean;
      application?: "erp";
      erpAllowed?: boolean;
      returnPath?: string;
      wrongAudience?: boolean;
      inactive?: boolean;
      expires?: number;
      refreshLost?: boolean;
      gate?: ReturnType<typeof deferred>;
      entered?: ReturnType<typeof deferred>;
    } = {},
  ) {
    const store = new MemoryStore(),
      counts = { codes: 0, refreshes: 0, memberships: 0 };
    let nonce = "",
      challenge = "",
      codeUsed = false;
    const jwt = async (audience: string, claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "synthetic-factory-key" })
        .setIssuer(issuer)
        .setAudience(audience)
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/protocol/openid-connect/token")) {
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe(clientId);
        if (body.get("grant_type") === "authorization_code") {
          counts.codes++;
          expect(codeUsed).toBe(false);
          codeUsed = true;
          expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
            challenge,
          );
          return Response.json({
            access_token: await jwt(options.wrongAudience ? "other-api" : "yummyai-api", {
              tenant_id: tenantId,
              azp: clientId,
            }),
            id_token: await jwt(clientId, {
              nonce: options.wrongNonce ? "different-nonce" : nonce,
            }),
            refresh_token: "synthetic-rotating-refresh-v1",
            expires_in: options.expires ?? 300,
          });
        }
        counts.refreshes++;
        expect(body.get("refresh_token")).toBe("synthetic-rotating-refresh-v1");
        options.entered?.resolve();
        await options.gate?.promise;
        if (options.refreshLost) throw Error("Synthetic response lost after token rotation");
        return Response.json({
          access_token: await jwt("yummyai-api", { tenant_id: tenantId, azp: clientId }),
          refresh_token: "synthetic-rotating-refresh-v2",
          expires_in: 300,
        });
      }
      if (String(input).endsWith("/v1/factory-portal/session")) {
        counts.memberships++;
        return options.inactive
          ? Response.json({ message: "Inactive member" }, { status: 401 })
          : Response.json({ authenticated: true, canRead: true, canRespond: true });
      }
      if (String(input).endsWith("/v1/identity/session")) {
        counts.memberships++;
        return Response.json({
          authenticated: true,
          canRead: true,
          canUseErp: options.erpAllowed !== false,
        });
      }
      throw Error("Unexpected synthetic identity endpoint");
    };
    const service = new FactoryIdentitySessions(
      {
        application: options.application,
        origin: "http://127.0.0.1:3001",
        issuer,
        clientId,
        audience: "yummyai-api",
        jwksUri: `${issuer}/keys`,
        apiBase: "http://synthetic-api.invalid",
        sessionKey: Buffer.alloc(32, 91),
      },
      store,
      fetcher,
    );
    const flow = await service.start(options.returnPath);
    nonce = flow.url.searchParams.get("nonce")!;
    challenge = flow.url.searchParams.get("code_challenge")!;
    return { store, counts, service, flow, state: flow.url.searchParams.get("state")! };
  }
  it("keeps ERP flow encryption separate and pins its own callback and return path", async () => {
    const f = await scenario({ application: "erp", returnPath: "/products?plan=synthetic-plan" });
    expect(f.flow.url.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:3001/api/erp-auth/callback",
    );
    const factory = new FactoryIdentitySessions(
      { ...f.service.configuration, application: "factory" },
      f.store,
    );
    await expect(factory.finish(f.flow.flowId, f.state, "synthetic-code")).rejects.toMatchObject({
      status: 401,
    });
    const session = await f.service.finish(f.flow.flowId, f.state, "synthetic-code");
    expect(session.returnPath).toBe("/products?plan=synthetic-plan");
    expect(await f.service.token(session.sessionId)).toBeTruthy();
  });
  it("does not accept factory read access as ERP membership", async () => {
    const f = await scenario({ application: "erp", erpAllowed: false });
    await expect(f.service.finish(f.flow.flowId, f.state, "synthetic-code")).rejects.toMatchObject({
      status: 403,
      code: "erp_access_denied",
    });
    expect([...f.store.rows.keys()].some((key) => key.startsWith("session:"))).toBe(false);
  });
  it("uses S256, state, nonce, signed claims and current membership, while keeping tokens encrypted", async () => {
    const f = await scenario();
    expect(f.flow.url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(f.flow.url.searchParams.get("nonce")).toBeTruthy();
    const session = await f.service.finish(f.flow.flowId, f.state, "synthetic-code");
    expect(session.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const token = await f.service.token(session.sessionId);
    const serialized = JSON.stringify([...f.store.rows.values()]);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain("synthetic-rotating-refresh-v1");
    expect(serialized).not.toContain(subject);
    expect(f.counts).toEqual({ codes: 1, refreshes: 0, memberships: 1 });
    await expect(f.service.finish(f.flow.flowId, f.state, "synthetic-code")).rejects.toMatchObject({
      status: 400,
    });
    expect(f.counts.codes).toBe(1);
  });
  it("rejects wrong and non-ASCII state without consuming the legitimate flow", async () => {
    const f = await scenario();
    await expect(
      f.service.finish(f.flow.flowId, "界".repeat(f.state.length), "synthetic-code"),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.counts.codes).toBe(0);
    await expect(
      f.service.finish(f.flow.flowId, f.state, "synthetic-code"),
    ).resolves.toHaveProperty("sessionId");
  });
  it.each([{ wrongNonce: true }, { wrongAudience: true }, { inactive: true }])(
    "rejects mismatched identity or inactive membership before creating a session %j",
    async (options) => {
      const f = await scenario(options);
      await expect(f.service.finish(f.flow.flowId, f.state, "synthetic-code")).rejects.toThrow();
      expect([...f.store.rows.keys()].filter((key) => key.startsWith("session:"))).toHaveLength(0);
    },
  );
  it("does not substitute the operator token when the caller has no personal session", async () => {
    vi.stubEnv("API_ACCESS_TOKEN", "synthetic-operator-fallback");
    const f = await scenario();
    await expect(f.service.token(undefined)).rejects.toMatchObject({ status: 401 });
    expect(f.counts).toEqual({ codes: 0, refreshes: 0, memberships: 0 });
  });
  it("rotates once across concurrent requests and preserves the original absolute session deadline", async () => {
    const gate = deferred(),
      entered = deferred(),
      f = await scenario({ expires: 1, gate, entered }),
      session = await f.service.finish(f.flow.flowId, f.state, "synthetic-code"),
      deadline = f.store.rows.get(`session:${session.sessionId}`)!.expires;
    const first = f.service.token(session.sessionId);
    await entered.promise;
    const second = f.service.token(session.sessionId);
    gate.resolve();
    const tokens = await Promise.all([first, second]);
    expect(tokens[0]).toBe(tokens[1]);
    expect(f.counts.refreshes).toBe(1);
    expect(f.store.rows.get(`session:${session.sessionId}`)!.expires).toBe(deadline);
  });
  it("cannot recreate a logged-out session when an in-flight refresh completes", async () => {
    const gate = deferred(),
      entered = deferred(),
      f = await scenario({ expires: 1, gate, entered }),
      session = await f.service.finish(f.flow.flowId, f.state, "synthetic-code"),
      pending = f.service.token(session.sessionId);
    await entered.promise;
    await f.service.logout(session.sessionId);
    gate.resolve();
    await expect(pending).rejects.toMatchObject({ status: 401 });
    expect(await f.store.get("session", session.sessionId)).toBeNull();
  });
  it("does not replay a rotating refresh after an uncertain response and a failed removal", async () => {
    const f = await scenario({ expires: 1, refreshLost: true }),
      session = await f.service.finish(f.flow.flowId, f.state, "synthetic-code");
    f.store.failRemoval = true;
    await expect(f.service.token(session.sessionId)).rejects.toMatchObject({ status: 401 });
    await expect(f.service.token(session.sessionId)).rejects.toMatchObject({ status: 401 });
    expect(f.counts.refreshes).toBe(1);
  }, 10000);
  it("rechecks session liveness before a delayed caller can return private data", async () => {
    const f = await scenario(),
      session = await f.service.finish(f.flow.flowId, f.state, "synthetic-code");
    await f.service.assertLiveSession(session.sessionId);
    await f.service.logout(session.sessionId);
    await expect(f.service.assertLiveSession(session.sessionId)).rejects.toMatchObject({
      status: 401,
    });
  });
});
