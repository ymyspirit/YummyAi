import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const apiRequire = createRequire(new URL("../../apps/api/package.json", import.meta.url));
const { generateKeyPair, exportJWK, SignJWT } = await import(pathToFileURL(apiRequire.resolve("jose")).href);
export type AgentMcpAuthAccount = { subject: string; tenantId: string; name: string };
type Code = { subject: string; tenantId: string; nonce: string; challenge: string; redirect: string; clientId: string; createdAt: number };

/** Synthetic external IdP transport only. ERP authentication, membership, RLS,
 * budget, Worker execution and all business facts remain the actual owners. */
export async function startAgentMcpAuthFixture(options: { accounts: Record<string, AgentMcpAuthAccount>; clientId?: string; audience?: string; webOrigin?: string }) {
  const clientId = options.clientId ?? "yummyai-agent-mcp", audience = options.audience ?? "yummyai-api";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(publicKey), kid: "synthetic-mcp-personal", use: "sig", alg: "RS256" };
  const flows = new Map<string, Omit<Code, "subject" | "tenantId" | "createdAt"> & { state: string }>();
  const codes = new Map<string, Code>(), refreshes = new Map<string, Pick<Code, "subject" | "tenantId" | "clientId">>();
  const controlKey = opaqueControl(), redirects = new Map<string, Set<string>>([[clientId, new Set()]]);
  if (options.webOrigin) redirects.set("yummyai-web", new Set([options.webOrigin + "/api/erp-auth/callback"]));
  const clientProofs = new Map<string, { authorizationRequests: number; codeExchanges: number; refreshExchanges: number }>();
  for (const id of redirects.keys()) clientProofs.set(id, { authorizationRequests: 0, codeExchanges: 0, refreshExchanges: 0 });
  const proof = { authorizations: 0, codeExchanges: 0, refreshExchanges: 0, invalidPkce: 0, replayedCodes: 0, replayedRefreshes: 0,
    issuedRefreshes: 0, liveRefreshes: 0, closed: false };
  const controls: { accessSeconds: number; refreshDelayMs: number; rejectRefresh: boolean; badNonce: boolean; wrongCallbackIssuer: boolean; beforeRefreshResponse?: () => Promise<void> } =
    { accessSeconds: 300, refreshDelayMs: 0, rejectRefresh: false, badNonce: false, wrongCallbackIssuer: false };
  const requests: Array<{ method: string; path: string; grant: "authorization_code" | "refresh_token" | null; status: number }> = [];
  let issuer = "", closed = false;
  const opaque = () => randomBytes(32).toString("base64url");
  function opaqueControl() { return randomBytes(32).toString("base64url"); }
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value));
  };
  async function form(request: IncomingMessage) {
    const chunks: Buffer[] = []; let count = 0;
    for await (const value of request) { const chunk = Buffer.from(value); count += chunk.byteLength;
      if (count > 32_768) throw new Error("mcp_auth_fixture_input_invalid"); chunks.push(chunk); }
    return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  }
  function callback(value: string | null) {
    try { const url = new URL(value ?? ""); return url.protocol === "http:" && url.hostname === "127.0.0.1" && !!url.port &&
      url.pathname === "/callback" && !url.search && !url.hash && !url.username && !url.password ? url.href : null; } catch { return null; }
  }
  async function access(account: Pick<Code, "subject" | "tenantId">, issuingClient: string) {
    return new SignJWT({ tenant_id: account.tenantId, azp: issuingClient }).setProtectedHeader({ alg: "RS256", kid: jwk.kid })
      .setSubject(account.subject).setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + controls.accessSeconds).sign(privateKey);
  }
  async function issue(account: Pick<Code, "subject" | "tenantId" | "clientId">, nonce?: string) {
    const refresh = opaque(); refreshes.set(refresh, account); proof.issuedRefreshes++; proof.liveRefreshes = refreshes.size;
    return { token_type: "Bearer", expires_in: controls.accessSeconds, access_token: await access(account, account.clientId), refresh_token: refresh,
      ...(nonce ? { id_token: await new SignJWT({ nonce: controls.badNonce ? "synthetic-wrong-nonce" : nonce, tenant_id: account.tenantId, azp: account.clientId })
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setSubject(account.subject).setIssuer(issuer).setAudience(account.clientId).setIssuedAt().setExpirationTime("5m").sign(privateKey) } : {}) };
  }
  const server = createServer(async (request, response) => {
    let path = "/invalid", grant: "authorization_code" | "refresh_token" | null = null;
    response.once("finish", () => requests.push({ method: request.method ?? "", path, grant, status: response.statusCode }));
    try {
      const url = new URL(request.url ?? "/", issuer); path = url.pathname;
      if (path === "/.well-known/openid-configuration" && request.method === "GET") {
        json(response, 200, { issuer, authorization_endpoint: issuer + "/authorize", token_endpoint: issuer + "/token", jwks_uri: issuer + "/jwks",
          response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true }); return;
      }
      if (["/jwks", "/protocol/openid-connect/certs"].includes(path) && request.method === "GET") { json(response, 200, { keys: [jwk] }); return; }
      if (["/authorize", "/protocol/openid-connect/auth"].includes(path) && request.method === "GET") {
        const query = url.searchParams, requestedClient = query.get("client_id") ?? "", redirect = query.get("redirect_uri");
        if (!redirect || !redirects.get(requestedClient)?.has(redirect) || query.get("response_type") !== "code" || query.get("code_challenge_method") !== "S256" ||
          !["state", "nonce", "code_challenge"].every(key => /^[A-Za-z0-9_-]{32,128}$/.test(query.get(key) ?? ""))) {
          json(response, 400, { error: "invalid_request" }); return;
        }
        const id = opaque(); flows.set(id, { nonce: query.get("nonce")!, challenge: query.get("code_challenge")!, state: query.get("state")!, redirect, clientId: requestedClient }); proof.authorizations++;
        clientProofs.get(requestedClient)!.authorizationRequests++;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; form-action 'self' " + new URL(redirect).origin + "; frame-ancestors 'none'" });
        // Account identifiers are fixture-owned constants, never user data.
        response.end('<!doctype html><html><head><title>Synthetic identity fixture</title></head><body><h1>Synthetic identity fixture</h1><form method="post" action="/login"><input type="hidden" name="flow" value="' + id +
          '"><label>Test account<select name="account">' + Object.keys(options.accounts).map(key => '<option value="' + key + '">' + key + '</option>').join("") +
          '</select></label><button>Continue synthetic login</button></form></body></html>'); return;
      }
      if (path === "/login" && request.method === "POST") {
        const body = await form(request), flow = flows.get(body.get("flow") ?? ""), account = options.accounts[body.get("account") ?? ""];
        flows.delete(body.get("flow") ?? ""); if (!flow || !account) { json(response, 400, { error: "invalid_request" }); return; }
        const code = opaque(); codes.set(code, { ...account, ...flow, createdAt: Date.now() });
        const destination = new URL(flow.redirect); destination.searchParams.set("code", code); destination.searchParams.set("state", flow.state);
        destination.searchParams.set("iss", controls.wrongCallbackIssuer ? "https://synthetic-wrong-issuer.invalid" : issuer);
        response.writeHead(303, { location: destination.href, "cache-control": "no-store" }); response.end(); return;
      }
      if (["/token", "/protocol/openid-connect/token"].includes(path) && request.method === "POST") {
        const body = await form(request), requestedClient = body.get("client_id") ?? "";
        if (!redirects.has(requestedClient) || body.has("client_secret")) { json(response, 400, { error: "invalid_client" }); return; }
        if (body.get("grant_type") === "authorization_code") {
          grant = "authorization_code"; const record = codes.get(body.get("code") ?? ""); codes.delete(body.get("code") ?? "");
          if (!record || Date.now() - record.createdAt > 60_000) { proof.replayedCodes++; json(response, 400, { error: "invalid_grant" }); return; }
          if (requestedClient !== record.clientId || body.get("redirect_uri") !== record.redirect || createHash("sha256").update(body.get("code_verifier") ?? "").digest("base64url") !== record.challenge) {
            proof.invalidPkce++; json(response, 400, { error: "invalid_grant" }); return;
          }
          proof.codeExchanges++; clientProofs.get(requestedClient)!.codeExchanges++; json(response, 200, await issue(record, record.nonce)); return;
        }
        if (body.get("grant_type") === "refresh_token") {
          grant = "refresh_token"; const previous = body.get("refresh_token") ?? "", record = refreshes.get(previous); refreshes.delete(previous); proof.liveRefreshes = refreshes.size;
          if (!record || record.clientId !== requestedClient || controls.rejectRefresh) { proof.replayedRefreshes++; json(response, 400, { error: "invalid_grant" }); return; }
          proof.refreshExchanges++; if (controls.refreshDelayMs) await new Promise(resolve => setTimeout(resolve, controls.refreshDelayMs));
          clientProofs.get(requestedClient)!.refreshExchanges++;
          const issued = await issue(record); await controls.beforeRefreshResponse?.(); json(response, 200, issued); return;
        }
        json(response, 400, { error: "unsupported_grant_type" }); return;
      }
      if (path.startsWith("/_fixture/") && request.headers["x-fixture-control"] === controlKey) {
        if (path === "/_fixture/proof") { json(response, 200, safeProof()); return; }
        const body = await form(request);
        if (path === "/_fixture/register-mcp-client" && request.method === "POST") {
          const redirect = callback(body.get("redirect_uri"));
          if (body.get("client_id") !== clientId || !redirect || redirects.get(clientId)!.size >= 64) { json(response, 400, { error: "invalid_request" }); return; }
          redirects.get(clientId)!.add(redirect); json(response, 200, { registered: true }); return;
        }
        if (path === "/_fixture/configure") {
          const seconds = body.get("accessSeconds"), delay = body.get("refreshDelay");
          if (seconds) controls.accessSeconds = Math.max(1, Math.min(900, Number(seconds)));
          if (delay) controls.refreshDelayMs = Math.max(0, Math.min(10_000, Number(delay)));
          json(response, 200, { configured: true }); return;
        }
        if (path === "/_fixture/token" && options.accounts[body.get("account") ?? ""]) {
          const requestedClient = body.get("client_id") ?? "yummyai-web";
          if (!redirects.has(requestedClient)) { json(response, 400, { error: "invalid_client" }); return; }
          json(response, 200, { access_token: await access(options.accounts[body.get("account")!]!, requestedClient) }); return;
        }
      }
      json(response, 404, { error: "not_found" });
    } catch { if (!response.headersSent) json(response, 500, { error: "synthetic_identity_transport_failed" }); else response.destroy(); }
  });
  await new Promise<void>((accept, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => accept()); });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("mcp_auth_fixture_address_invalid"); issuer = "http://127.0.0.1:" + address.port;
  function safeProof() { return { ...proof, authorizationRequests: proof.authorizations, clients: Object.fromEntries([...clientProofs].map(([id, counts]) => [id, { ...counts }])) }; }
  return { issuer, clientId, audience, publicKey, controls, proof, requests, controlKey, safeProof,
    registerCallback(redirectUri: string) { const actual = callback(redirectUri); if (!actual || redirects.get(clientId)!.size >= 64) throw new Error("mcp_auth_fixture_callback_invalid"); redirects.get(clientId)!.add(actual); },
    async operatorToken(subject: string) { const account = Object.values(options.accounts).find(value => value.subject === subject); if (!account) throw new Error("mcp_auth_fixture_operator_missing"); return access(account, options.webOrigin ? "yummyai-web" : clientId); },
    revokeRefreshes() { refreshes.clear(); proof.liveRefreshes = 0; },
    async authorize(url: URL, account: string) {
      if (url.origin !== issuer || url.pathname !== "/authorize" || !options.accounts[account]) throw new Error("mcp_auth_fixture_authorization_invalid");
      const initial = await fetch(url, { redirect: "error" }); if (initial.status !== 200) throw new Error("mcp_auth_fixture_authorization_rejected");
      const html = await initial.text(), flow = /name="flow" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1]; if (!flow) throw new Error("mcp_auth_fixture_flow_missing");
      const login = await fetch(issuer + "/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ flow, account }), redirect: "manual" });
      const location = login.headers.get("location"); if (login.status !== 303 || !location) throw new Error("mcp_auth_fixture_callback_missing");
      const target = new URL(location); if (!callback(target.origin + target.pathname)) throw new Error("mcp_auth_fixture_callback_invalid");
      const finished = await fetch(target, { redirect: "manual" }); if (finished.status >= 400) throw new Error("mcp_auth_fixture_callback_rejected");
    },
    async close() { if (closed) return; closed = true; server.closeAllConnections();
      await new Promise<void>((accept, reject) => server.close(error => error ? reject(new Error("mcp_auth_fixture_close_failed")) : accept())); proof.closed = true; },
  };
}

/** Runner-owned compiled-personal IdP. Only this new family uses the additional
 * exact CLI callback registration; old identity fixtures remain byte-frozen. */
export async function startAgentMcpBrowserIdentityFixture(tenantId: string, operatorSubject: string, portalOrigin: string,
  options: { application?: "erp"; clientId?: "yummyai-web"; accounts: Record<string, { subject: string; name: string; tenantId?: string }> }) {
  if (portalOrigin !== "http://localhost:3130" || options.application !== undefined && options.application !== "erp" || options.clientId !== undefined && options.clientId !== "yummyai-web") throw new Error("mcp_auth_fixture_web_origin_invalid");
  const accounts = Object.fromEntries(Object.entries(options.accounts).map(([key, value]) => [key, { ...value, tenantId: value.tenantId ?? tenantId }]));
  const idp = await startAgentMcpAuthFixture({ accounts, webOrigin: portalOrigin });
  return { baseUrl: idp.issuer, controlKey: idp.controlKey, operatorToken: () => idp.operatorToken(operatorSubject), proof: idp.safeProof, close: idp.close };
}
