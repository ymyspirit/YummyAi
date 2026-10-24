import { randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { startAuthorization, exchangeAuthorization, refreshAuthorization, type AuthorizationServerMetadata } from "@modelcontextprotocol/client";
import { createRemoteJWKSet, customFetch, jwtVerify } from "jose";
import { z } from "zod";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import type { AgentMcpAuthProfile } from "./config.js";
import { AgentMcpSavedIdentitySchema, AgentMcpSavedTokensSchema, type AgentMcpSavedIdentity, type AgentMcpSavedTokens } from "./credential-store.js";
import { AgentMcpAuthError, authAbort, authCheck } from "./error.js";

const Metadata = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  jwks_uri: z.string(),
  response_types_supported: z.array(z.string()),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  authorization_response_iss_parameter_supported: z.boolean().optional(),
});
type Metadata = z.infer<typeof Metadata>;
const Tokens = z.object({
  access_token: z.string().min(1).max(32768),
  refresh_token: z.string().min(1).max(32768).optional(),
  id_token: z.string().min(1).max(32768).optional(),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive().max(86400),
});
export type AgentMcpVerifiedTokens = Readonly<{ identity: AgentMcpSavedIdentity; tokens: AgentMcpSavedTokens }>;
type Authorization = Readonly<{ url: URL; codeVerifier: string; state: string; nonce: string }>;

async function boundedJson(response: Response, limit: number): Promise<unknown> {
  const reader = response.body?.getReader();
  try {
    authCheck(reader && /^application\/(?:json|jwk-set\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? ""),
      "mcp_auth_login_failed");
    const length = response.headers.get("content-length");
    authCheck(length === null || /^[0-9]+$/.test(length) && Number(length) <= limit, "mcp_auth_login_failed");
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const item = await reader.read(); if (item.done) break;
      total += item.value.byteLength; authCheck(total <= limit, "mcp_auth_login_failed"); chunks.push(item.value);
    }
    const bytes = Buffer.concat(chunks);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
    finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
  } finally {
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    else await response.body?.cancel().catch(() => {});
  }
}

/** Granular SDK helpers only: no automatic discovery/DCR, step-up, or ERP retry. */
export class AgentMcpOidc {
  private metadata: Promise<Metadata> | undefined;
  constructor(readonly profile: AgentMcpAuthProfile, private readonly fetcher: typeof fetch,
    private readonly now: () => number) {}

  private endpoint(raw: string): URL {
    const url = new URL(raw), issuer = new URL(this.profile.issuer);
    authCheck(url.origin === issuer.origin && !url.username && !url.password && !url.search && !url.hash &&
      url.pathname.startsWith(issuer.pathname.replace(/\/$/, "") + "/"), "mcp_auth_login_failed");
    return url;
  }
  private async response(url: URL, init: RequestInit = {}, signal?: AbortSignal): Promise<Response> {
    authAbort(signal);
    const deadline = AbortSignal.timeout(10_000);
    try {
      const response = await this.fetcher(url, { ...init, cache: "no-store", redirect: "error", credentials: "omit",
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
      const body = await boundedJson(response, response.ok ? 128 * 1024 : 8192);
      // IdP descriptions never reach SDK errors or stderr.
      const safe = response.ok ? body : {
        error: typeof body === "object" && body !== null && "error" in body && body.error === "invalid_grant"
          ? "invalid_grant" : "server_error",
      };
      return new Response(JSON.stringify(safe), { status: response.status, headers: { "content-type": "application/json" } });
    } catch (error) {
      if (signal?.aborted) throw new AgentMcpAuthError("mcp_auth_cancelled");
      if (deadline.aborted) throw new AgentMcpAuthError("mcp_auth_timeout");
      if (error instanceof AgentMcpAuthError) throw error;
      throw new AgentMcpAuthError("mcp_auth_login_failed");
    }
  }
  private discovery(signal?: AbortSignal): Promise<Metadata> {
    this.metadata ??= (async () => {
      const url = new URL(this.profile.issuer + "/.well-known/openid-configuration");
      const response = await this.response(url, { headers: { accept: "application/json" } }, signal);
      authCheck(response.ok, "mcp_auth_login_failed");
      const metadata = Metadata.parse(await response.json());
      authCheck(metadata.issuer === this.profile.issuer && metadata.response_types_supported.includes("code") &&
        (!metadata.code_challenge_methods_supported || metadata.code_challenge_methods_supported.includes("S256")) &&
        (!metadata.token_endpoint_auth_methods_supported || metadata.token_endpoint_auth_methods_supported.includes("none")),
      "mcp_auth_login_failed");
      for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint, metadata.jwks_uri]) this.endpoint(endpoint);
      return metadata;
    })().catch(error => {
      this.metadata = undefined;
      throw error instanceof AgentMcpAuthError ? error : new AgentMcpAuthError("mcp_auth_login_failed");
    });
    return this.metadata;
  }
  async start(signal?: AbortSignal): Promise<Authorization> {
    const metadata = await this.discovery(signal), state = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url");
    const started = await startAuthorization(this.profile.issuer, { metadata: metadata as AuthorizationServerMetadata,
      clientInformation: { client_id: this.profile.clientId, token_endpoint_auth_method: "none" },
      redirectUrl: this.profile.redirectUri, scope: "openid profile", state });
    started.authorizationUrl.searchParams.set("nonce", nonce);
    return { url: started.authorizationUrl, codeVerifier: started.codeVerifier, state, nonce };
  }
  async complete(flow: Authorization, callback: { code: string; iss?: string }, signal?: AbortSignal): Promise<AgentMcpVerifiedTokens> {
    try {
      const metadata = await this.discovery(signal);
      const tokens = await exchangeAuthorization(this.profile.issuer, { metadata: metadata as AuthorizationServerMetadata,
        clientInformation: { client_id: this.profile.clientId, token_endpoint_auth_method: "none" },
        authorizationCode: callback.code, iss: callback.iss, codeVerifier: flow.codeVerifier,
        redirectUri: this.profile.redirectUri,
        fetchFn: (url, init) => {
          authCheck(String(url) === metadata.token_endpoint, "mcp_auth_login_failed");
          return this.response(this.endpoint(String(url)), init, signal);
        } });
      return await this.verify(tokens, { nonce: flow.nonce }, signal);
    } catch (error) {
      if (error instanceof AgentMcpAuthError) throw error;
      throw new AgentMcpAuthError("mcp_auth_login_failed");
    }
  }
  async refresh(tokens: AgentMcpSavedTokens, identity: AgentMcpSavedIdentity): Promise<AgentMcpVerifiedTokens> {
    authCheck(tokens.refreshToken, "mcp_auth_required");
    try {
      const metadata = await this.discovery();
      const renewed = await refreshAuthorization(this.profile.issuer, { metadata: metadata as AuthorizationServerMetadata,
        clientInformation: { client_id: this.profile.clientId, token_endpoint_auth_method: "none" },
        refreshToken: tokens.refreshToken,
        fetchFn: (url, init) => {
          authCheck(String(url) === metadata.token_endpoint, "mcp_auth_login_failed");
          return this.response(this.endpoint(String(url)), init);
        } });
      return await this.verify(renewed, { identity });
    } catch (error) {
      if (error instanceof AgentMcpAuthError && error.code === "mcp_auth_token_too_short") throw error;
      // Whether a one-time token was consumed cannot be inferred from a failed exchange.
      throw new AgentMcpAuthError("mcp_auth_refresh_unknown");
    }
  }
  private async verify(raw: unknown, expected: { nonce?: string; identity?: AgentMcpSavedIdentity },
    signal?: AbortSignal): Promise<AgentMcpVerifiedTokens> {
    try {
      const tokens = Tokens.parse(raw), metadata = await this.discovery(signal);
      const jwks = createRemoteJWKSet(this.endpoint(metadata.jwks_uri), { timeoutDuration: 10_000,
        [customFetch]: (url, init) => this.response(this.endpoint(String(url)), init, signal) });
      const options = { issuer: this.profile.issuer, algorithms: ["RS256"], currentDate: new Date(this.now()), clockTolerance: 5 };
      const { payload: access } = await jwtVerify(tokens.access_token, jwks, {
        ...options, audience: this.profile.audience, requiredClaims: ["sub", "exp", "tenant_id"],
      });
      authCheck(access.sub && access.azp === this.profile.clientId && typeof access.exp === "number", "mcp_auth_identity_changed");
      if (expected.nonce) authCheck(tokens.id_token, "mcp_auth_identity_changed");
      if (tokens.id_token) {
        const { payload: id } = await jwtVerify(tokens.id_token, jwks, { ...options,
          audience: this.profile.clientId, requiredClaims: ["sub", "exp"] });
        authCheck(id.sub === access.sub && (!expected.nonce || id.nonce === expected.nonce) &&
          (id.azp === undefined || id.azp === this.profile.clientId), "mcp_auth_identity_changed");
      }
      const sessionResponse = await this.response(new URL("/v1/identity/session", this.profile.apiUrl),
        { headers: { accept: "application/json", authorization: "Bearer " + tokens.access_token } }, signal);
      authCheck(sessionResponse.status === 200, "mcp_auth_login_failed");
      const session = ErpSessionViewSchema.parse(await sessionResponse.json());
      authCheck(session.authenticated && session.canUseErp && session.tenantId === access.tenant_id,
        "mcp_auth_identity_changed");
      const identity = AgentMcpSavedIdentitySchema.parse({ subject: access.sub, tenantId: access.tenant_id, userId: session.userId });
      if (expected.identity) authCheck(identity.subject === expected.identity.subject &&
        identity.tenantId === expected.identity.tenantId && identity.userId === expected.identity.userId, "mcp_auth_identity_changed");
      const saved = AgentMcpSavedTokensSchema.parse({ accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        accessExpiresAt: Math.min(access.exp * 1000, this.now() + tokens.expires_in * 1000) });
      authCheck(saved.accessExpiresAt - this.now() >= 150_000, "mcp_auth_token_too_short");
      return { identity, tokens: saved };
    } catch (error) {
      if (error instanceof AgentMcpAuthError) throw error;
      throw new AgentMcpAuthError("mcp_auth_identity_changed");
    }
  }
}

export async function receiveAgentMcpAuthorization(
  profile: AgentMcpAuthProfile, flow: Authorization,
  open: (url: URL) => Promise<void>, options: { signal?: AbortSignal; timeoutMs: number },
): Promise<{ code: string; iss?: string }> {
  authAbort(options.signal);
  const redirect = /^http:\/\/127\.0\.0\.1:([0-9]+)\/callback$/.exec(profile.redirectUri);
  authCheck(redirect && Number(redirect[1]) >= 1 && Number(redirect[1]) <= 65535, "mcp_auth_profile_invalid");
  const port = Number(redirect[1]);
  let finish!: (value: { code: string; iss?: string }) => void, fail!: (error: AgentMcpAuthError) => void, consumed = false;
  const callback = new Promise<{ code: string; iss?: string }>((resolve, reject) => { finish = resolve; fail = reject; });
  void callback.catch(() => {});
  const server = http.createServer((request, response) => {
    let accepted = false;
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "text/plain; charset=utf-8");
    response.setHeader("content-security-policy", "default-src 'none'");
    response.setHeader("referrer-policy", "no-referrer");
    response.setHeader("connection", "close");
    try {
      authCheck(!consumed && request.method === "GET" && request.socket.remoteAddress === "127.0.0.1" &&
        request.url && request.url.length <= 8192 && request.headers.host, "mcp_auth_flow_invalid");
      const host = new URL("http://" + request.headers.host), expected = new URL(profile.redirectUri);
      authCheck(host.origin === expected.origin, "mcp_auth_flow_invalid");
      const url = new URL(request.url, expected);
      authCheck(url.origin === expected.origin && url.pathname === "/callback" && !url.hash, "mcp_auth_flow_invalid");
      const allowed = new Set(["code", "state", "iss", "session_state", "error", "error_description"]);
      for (const key of url.searchParams.keys()) authCheck(allowed.has(key) && url.searchParams.getAll(key).length === 1, "mcp_auth_flow_invalid");
      const state = url.searchParams.get("state") ?? "", left = Buffer.from(state), right = Buffer.from(flow.state);
      authCheck(left.byteLength === right.byteLength && timingSafeEqual(left, right), "mcp_auth_flow_invalid");
      consumed = true; accepted = true;
      authCheck(!url.searchParams.has("error"), "mcp_auth_login_failed");
      const code = url.searchParams.get("code"), iss = url.searchParams.get("iss") ?? undefined;
      authCheck(code && code.length <= 4096 && (!iss || iss.length <= 2048), "mcp_auth_flow_invalid");
      response.statusCode = 200; response.end("ERP sign-in received. You may close this window.");
      finish({ code, iss });
    } catch {
      response.statusCode = 400; response.end("ERP sign-in was not accepted.");
      if (accepted) fail(new AgentMcpAuthError("mcp_auth_login_failed"));
    }
  });
  server.headersTimeout = 5000; server.requestTimeout = 5000; server.keepAliveTimeout = 1000; server.maxHeadersCount = 16;
  const aborted = () => fail(new AgentMcpAuthError("mcp_auth_cancelled"));
  const timer = setTimeout(() => fail(new AgentMcpAuthError("mcp_auth_timeout")), options.timeoutMs);
  options.signal?.addEventListener("abort", aborted, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", () => reject(new AgentMcpAuthError("mcp_auth_login_failed")));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve);
    });
    authAbort(options.signal);
    void Promise.resolve().then(() => open(flow.url)).catch(() => fail(new AgentMcpAuthError("mcp_auth_login_failed")));
    return await callback;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", aborted);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
