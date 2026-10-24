import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { PersonalSessionError } from "../../../../identity/core";
import type * as ErpServer from "../../../../erp-auth/server";

const { upstream, identity, current } = vi.hoisted(() => ({
  upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>(),
}));
vi.mock("../../../../server-api", () => ({ apiFetch: upstream }));
vi.mock("../../../../erp-auth/server", async original => ({
  ...(await original<typeof ErpServer>()), erpRequestIdentity: identity, assertErpIdentityCurrent: current,
}));
import { GET, PATCH, POST } from "./route";

const id = "019f0000-0000-7000-8000-000000000001";
const scope = "019f0000-0000-7000-8000-000000000002";
const otherScope = "019f0000-0000-7000-8000-000000000003";
const actor: ErpSessionView = {
  authenticated: true, canUseErp: true, userId: id, tenantId: otherScope, displayName: "Synthetic operator",
  organizationName: "Synthetic tenant", permissions: ["design:read", "asset:read", "model:configure"],
  dataScope: "tenant", permissionScopes: { "design:read": "self", "asset:read": "tenant", "model:configure": "tenant" },
};
const stamp = erpSessionAuthority(actor), apiBase = "https://personal-api.example.test";
const personalIdentity = (view = actor) => ({ view, token: "server-only-token", sessionId: "server-only-session",
  service: { configuration: { apiBase: apiBase + "/" } } });
const context = (path: string[]) => ({ params: Promise.resolve({ path }) });
const snapshot = () => ({ channels: [], analysisModels: [], defaults: { image: null, video: null, text: null, analysis: null }, defaultsRevision: 0 });
const provider = () => ({ id, provider: "openai", label: "Synthetic", endpoint: null, status: "enabled",
  createdAt: "2026-10-23T00:00:00.000Z", updatedAt: "2026-10-23T00:00:00.000Z", hasCredential: true });
const workspace = (selectedScope = scope) => ({ version: 1, scope: selectedScope, contextAuthority: stamp,
  capabilities: { read: true, save: true, mediaWrite: false, review: false, submit: false, configure: true },
  generation: { enabled: false, code: "operator_paused" } });
const invoke = () => ({ version: 1, contextAuthority: stamp,
  request: { operation: "state.get", scope, namespace: "app_state", key: "canvas:original" } });
const reply = () => ({ version: 1, scope, contextAuthority: stamp, operation: "state.get",
  data: { revision: 7, value: { title: "private-canvas-sentinel" } } });
const configuration = () => ({ operation: "channel.save", name: "Synthetic Responses",
  baseUrl: "http://localhost:8080/v1", apiKey: "synthetic-entry-only", textProtocol: "responses",
  models: [{ name: "synthetic-text", capability: "text" }] });
function request(path = "configuration", body: unknown = { operation: "configuration.get" }, options: { origin?: string; headers?: Record<string, string>; method?: string; raw?: boolean; stamp?: string | null } = {}) {
  const origin = options.origin ?? "https://erp.example.test";
  const method = options.method ?? "POST";
  const authority = options.stamp === undefined ? stamp : options.stamp;
  return new Request(`${origin}/api/creative-studio/${path}`, { method,
    headers: { ...(method === "GET" ? {} : { origin, "content-type": "application/json" }),
      ...(authority === null ? {} : { "x-yummyai-context-authority": authority }),
      authorization: "browser-credential-must-not-forward", ...options.headers },
    ...(method === "GET" ? {} : { body: options.raw ? String(body) : JSON.stringify(body) }) });
}
function streamedRequest(path: string, options: { stamp?: string | null; signal?: AbortSignal } = {}) {
  const cancel = vi.fn(), pull = vi.fn();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, pull, cancel }, { highWaterMark: 0 });
  const authority = options.stamp === undefined ? stamp : options.stamp;
  const source = new Request(`https://erp.example.test/api/creative-studio/${path}`, {
    method: "POST", headers: { origin: "https://erp.example.test", "content-type": "application/json",
      ...(authority === null ? {} : { "x-yummyai-context-authority": authority }) }, body, signal: options.signal, duplex: "half",
  } as RequestInit & { duplex: "half" });
  return { source, controller, cancel, pull };
}

beforeEach(() => {
  vi.stubEnv("API_BASE_URL", "http://api.example.test/");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("WEB_AUTH_MODE", "personal");
  vi.stubEnv("FACTORY_PORTAL_ONLY", "0");
  vi.stubEnv("CANVAS_STUDIO_PRODUCTION_ENABLED", "1");
  upstream.mockReset(); identity.mockReset(); current.mockReset();
  identity.mockResolvedValue(personalIdentity()); current.mockResolvedValue();
  upstream.mockImplementation(async () => Response.json(snapshot()));
});
afterEach(() => vi.unstubAllEnvs());

describe("original Studio transport", () => {
  it("preserves the complete pinned request and validates original facts without accepting storage internals", async () => {
    const source = { entryId: id, revision: 2, namespace: "image_files", assetId: otherScope, assetVersion: 1,
      checksumSha256: "b".repeat(64), mediaType: "image/jpeg", byteSize: 240_000, sourceKind: "owned" };
    const pinned = { operation: "result.lookup", scope, key: "original-image", title: "Synthetic original",
      submissionId: id, sourceReference: "Synthetic owned pixels", rightsAttested: true, source };
    upstream.mockResolvedValueOnce(Response.json({ version: 1, scope, contextAuthority: stamp, operation: "result.lookup", data: { status: "missing" } }));
    const restored = await POST(request("invoke", { version: 1, contextAuthority: stamp, request: pinned }), context(["invoke"]));
    expect(restored.status).toBe(200);
    expect(JSON.parse(String(upstream.mock.calls[0]![1]!.body)).request).toEqual(pinned);
    const inspect = { operation: "asset.inspect", scope, namespace: "image_files", key: pinned.key };
    const data = { source, technical: { status: "verified", kind: "image", encodedWidth: 1200, encodedHeight: 800,
      displayWidth: 800, displayHeight: 1200, orientation: 6, validation: "full_static_decode" } };
    upstream.mockResolvedValueOnce(Response.json({ version: 1, scope, contextAuthority: stamp, operation: "asset.inspect", data }));
    const actual = await POST(request("invoke", { version: 1, contextAuthority: stamp, request: inspect }), context(["invoke"]));
    expect(actual.status).toBe(200); expect((await actual.json()).data).toEqual(data);
    upstream.mockResolvedValueOnce(Response.json({ version: 1, scope, contextAuthority: stamp, operation: "asset.inspect",
      data: { ...data, source: { ...source, objectKey: "private-storage-sentinel" } } }));
    const invalid = await POST(request("invoke", { version: 1, contextAuthority: stamp, request: inspect }), context(["invoke"]));
    expect(invalid.status).toBe(502); expect(await invalid.text()).not.toContain("private-storage-sentinel");
  });

  it("returns the original-pin upgrade code with fixed public text and no provider diagnostic", async () => {
    const legacy = { operation: "result.submit", scope, key: "original-image", title: "Synthetic original",
      submissionId: id, sourceReference: "Synthetic owned pixels", rightsAttested: true };
    upstream.mockResolvedValueOnce(Response.json({ code: "studio_original_pin_required", message: "private-provider-sentinel" }, { status: 409 }));
    const response = await POST(request("invoke", { version: 1, contextAuthority: stamp, request: legacy }), context(["invoke"]));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: "studio_original_pin_required", error: "送审需要固定原稿版本 请刷新创作工作台后重试" });
  });
});

describe("creative configuration authenticated boundary", () => {
  it("forwards a production personal Responses configuration through server authentication", async () => {
    const body = configuration();
    const response = await POST(request("configuration", body), context(["configuration"]));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.json()).toEqual(snapshot());
    expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(upstream).toHaveBeenCalledExactlyOnceWith(`${apiBase}/v1/ai/configuration`,
      expect.objectContaining({ method: "POST", body: JSON.stringify(body), cache: "no-store", redirect: "error" }));
    const headers = new Headers(upstream.mock.calls[0]![1]!.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(headers.has("authorization")).toBe(false);
    expect(current).toHaveBeenCalledTimes(2);
  });

  it("keeps existing provider configuration reads, creates and valid UUID updates authenticated in production", async () => {
    upstream.mockResolvedValueOnce(Response.json([provider()])).mockResolvedValueOnce(Response.json(provider()))
      .mockResolvedValueOnce(Response.json({ ...provider(), status: "disabled" }));
    expect((await GET(request("providers", null, { method: "GET" }), context(["providers"]))).status).toBe(200);
    expect((await POST(request("providers", { provider: "openai", label: "Synthetic", apiKey: "synthetic-entry-only" }), context(["providers"]))).status).toBe(200);
    expect((await PATCH(request(`providers/${id}`, { status: "disabled" }, { method: "PATCH" }), context(["providers", id]))).status).toBe(200);
    expect(upstream.mock.calls.map(([url]) => url)).toEqual([`${apiBase}/v1/ai/model-configs`, `${apiBase}/v1/ai/model-configs`, `${apiBase}/v1/ai/model-configs/${id}`]);
    for (const [, init] of upstream.mock.calls) expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it.each(["local-service", "mistyped-auth-mode"])("rejects production auth mode %s before forwarding", async mode => {
    vi.stubEnv("WEB_AUTH_MODE", mode);
    expect((await POST(request(), context(["configuration"]))).status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
  });

  it("retains the local-service loopback boundary in development", async () => {
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("WEB_AUTH_MODE", "local-service");
    expect((await POST(request("configuration", configuration(), { origin: "http://localhost:3000" }), context(["configuration"]))).status).toBe(200);
    upstream.mockClear();
    const deniedOrigins: Array<{ origin: string; headers?: Record<string, string> }> = [{ origin: "https://outside.example.test" },
      { origin: "http://localhost:3000", headers: { "x-forwarded-for": "203.0.113.10" } },
      { origin: "http://localhost:3000", headers: { forwarded: "for=203.0.113.10" } }];
    for (const options of deniedOrigins)
      expect((await POST(request("configuration", configuration(), options), context(["configuration"]))).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
  });

  it("does not broaden production access to creative RPC or model generation routes", async () => {
    for (const path of ["rpc", "models"])
      expect((await POST(request(path, {}), context([path]))).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(identity).not.toHaveBeenCalled();
  });

  it("rejects cross-origin writes and cross-site reads before accessing server credentials", async () => {
    expect((await POST(request("configuration", configuration(), { headers: { origin: "https://other.example.test" } }), context(["configuration"]))).status).toBe(403);
    expect((await POST(request("configuration", configuration(), { headers: { origin: "null" } }), context(["configuration"]))).status).toBe(403);
    expect((await POST(request("configuration", configuration(), { headers: { "sec-fetch-site": "cross-site" } }), context(["configuration"]))).status).toBe(403);
    expect((await GET(request("providers", null, { method: "GET", headers: { "sec-fetch-site": "cross-site" } }), context(["providers"]))).status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("keeps the path allowlist, strict configuration schema and streamed body size bound", async () => {
    expect((await PATCH(request("providers/invalid", {}, { method: "PATCH" }), context(["providers", "invalid"]))).status).toBe(404);
    expect((await POST(request("configuration", { ...configuration(), textProtocol: "unknown" }), context(["configuration"]))).status).toBe(400);
    expect((await POST(request("configuration", { ...configuration(), tenantId: id }), context(["configuration"]))).status).toBe(400);
    expect((await POST(request("configuration", "{", { raw: true }), context(["configuration"]))).status).toBe(400);
    expect((await POST(request("configuration", {}, { headers: { "content-type": "text/plain" } }), context(["configuration"]))).status).toBe(415);
    expect((await POST(request("configuration", {}, { headers: { "content-length": String(128 * 1024 + 1) } }), context(["configuration"]))).status).toBe(413);
    expect((await POST(request("configuration", { value: "x".repeat(128 * 1024) }), context(["configuration"]))).status).toBe(413);
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([401, 403, 503])("preserves an upstream authentication/service HTTP %i without exposing diagnostics", async status => {
    upstream.mockResolvedValueOnce(Response.json({ message: "private-model-key-and-session-data" }, { status }));
    const response = await POST(request(), context(["configuration"]));
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private-model-key");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it.each([[401, "login_required"], [403, "erp_access_denied"]] as const)("does not mask thrown personal session %i as a transport failure", async (status, code) => {
    upstream.mockRejectedValueOnce(new PersonalSessionError(status, code));
    const response = await POST(request(), context(["configuration"]));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("retains safe conflict messages and does not retry an unknown configuration outcome", async () => {
    upstream.mockResolvedValueOnce(Response.json({ message: "模型配置已变化，请刷新后重试" }, { status: 409 }));
    const conflict = await POST(request("configuration", configuration()), context(["configuration"]));
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "模型配置已变化，请刷新后重试" });
    upstream.mockRejectedValueOnce(new Error("private-provider-token-and-body"));
    const unknown = await POST(request("configuration", configuration()), context(["configuration"]));
    expect(unknown.status).toBe(502);
    expect(await unknown.text()).not.toContain("private-provider-token");
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it("keeps ModelConfigure-only settings independent from the five-tool DesignRead and AssetRead workspace gate", async () => {
    const settingsActor: ErpSessionView = { ...actor, permissions: ["model:configure"], permissionScopes: { "model:configure": "tenant" } };
    identity.mockResolvedValue(personalIdentity(settingsActor));
    const authority = erpSessionAuthority(settingsActor);
    expect((await POST(request("configuration", configuration(), { stamp: authority }), context(["configuration"]))).status).toBe(200);
    expect((await GET(request("workspace", null, { method: "GET", stamp: authority }), context(["workspace"]))).status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("requires the full public configuration projection and accepts a separate strict discover catalogue", async () => {
    upstream.mockResolvedValueOnce(Response.json({ channels: [], defaultsRevision: 0, privateProvider: "sentinel" }));
    const invalid = await POST(request(), context(["configuration"]));
    expect(invalid.status).toBe(502); expect(await invalid.text()).not.toContain("sentinel");
    const catalogue = { models: ["synthetic-text"], fetchedAt: "2026-10-23T00:00:00.000Z", source: "provider", skipped: 0 };
    upstream.mockResolvedValueOnce(Response.json(catalogue));
    const discovered = await POST(request("configuration", { operation: "channel.discover", baseUrl: "https://provider.example.test/v1" }), context(["configuration"]));
    expect(discovered.status).toBe(200); expect(await discovered.json()).toEqual(catalogue);
  });
});

describe("personal Studio workspace and invoke boundary", () => {
  it("returns a strict scoped workspace using the authenticated API origin and current authority", async () => {
    upstream.mockResolvedValueOnce(Response.json(workspace()));
    const response = await GET(request(`workspace?scope=${scope}`, null, { method: "GET" }), context(["workspace"]));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(workspace());
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(upstream).toHaveBeenCalledExactlyOnceWith(`${apiBase}/v1/creative-studio/workspace?scope=${scope}`,
      expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error" }));
    expect(current).toHaveBeenCalledTimes(2);
  });

  it("forwards the exact original operation and scope without a browser credential or an inferred write", async () => {
    const body = invoke(); upstream.mockResolvedValueOnce(Response.json(reply()));
    const response = await POST(request("invoke", body), context(["invoke"]));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(reply());
    expect(upstream).toHaveBeenCalledExactlyOnceWith(`${apiBase}/v1/creative-studio/invoke`,
      expect.objectContaining({ method: "POST", cache: "no-store", redirect: "error" }));
    expect(JSON.parse(String(upstream.mock.calls[0]![1]!.body))).toEqual(body);
    expect(new Headers(upstream.mock.calls[0]![1]!.headers).get("x-yummyai-context-authority")).toBe(stamp);
    expect(new Headers(upstream.mock.calls[0]![1]!.headers).has("authorization")).toBe(false);
  });

  it("rejects missing and stale raw authority stamps before sending any request upstream", async () => {
    const stale = erpSessionAuthority({ ...actor, permissionScopes: { ...actor.permissionScopes, "design:read": "tenant" } });
    for (const authority of [null, stale]) {
      const response = await GET(request("workspace", null, { method: "GET", stamp: authority }), context(["workspace"]));
      expect(response.status).toBe(409); expect(await response.json()).toHaveProperty("code", "authority_changed");
    }
    const mismatchedBody = await POST(request("invoke", { ...invoke(), contextAuthority: stale }), context(["invoke"]));
    expect(mismatchedBody.status).toBe(409);
    expect(upstream).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
  });

  it("enforces production opt-in, personal authentication, strict routes, scope query and operation schemas", async () => {
    vi.stubEnv("CANVAS_STUDIO_PRODUCTION_ENABLED", "0");
    expect((await GET(request("workspace", null, { method: "GET" }), context(["workspace"]))).status).toBe(403);
    vi.stubEnv("CANVAS_STUDIO_PRODUCTION_ENABLED", "1");
    for (const path of [`workspace?scope=${scope}&scope=${otherScope}`, "workspace?tenantId=other", "workspace?scope=invalid"])
      expect((await GET(request(path, null, { method: "GET" }), context(["workspace"]))).status).toBe(400);
    expect((await POST(request("invoke?scope=" + scope, invoke()), context(["invoke"]))).status).toBe(400);
    expect(identity).not.toHaveBeenCalled();
    expect((await POST(request("invoke", { ...invoke(), actorId: id }), context(["invoke"]))).status).toBe(400);
    expect((await POST(request("invoke", { ...invoke(), request: { ...invoke().request, operation: "execute" } }), context(["invoke"]))).status).toBe(400);
    expect((await GET(request("invoke", null, { method: "GET" }), context(["invoke"]))).status).toBe(404);
    vi.stubEnv("NODE_ENV", "development"); vi.stubEnv("WEB_AUTH_MODE", "local-service");
    expect((await GET(request("workspace", null, { method: "GET", origin: "http://localhost:3000" }), context(["workspace"]))).status).toBe(403);
    expect(identity).toHaveBeenCalledTimes(2); expect(upstream).not.toHaveBeenCalled();
  });

  it("applies CSRF and cross-site read rejection to both new personal routes before identity lookup", async () => {
    const crossWrite = await POST(request("invoke", invoke(), { headers: { origin: "https://attacker.example.test" } }), context(["invoke"]));
    const crossRead = await GET(request("workspace", null, { method: "GET", headers: { "sec-fetch-site": "cross-site" } }), context(["workspace"]));
    expect([crossWrite.status, crossRead.status]).toEqual([403, 403]);
    expect(identity).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects substituted scopes, operations and authority or extra private response fields", async () => {
    const stale = erpSessionAuthority({ ...actor, dataScope: "self" });
    for (const value of [{ ...reply(), scope: otherScope }, { ...reply(), operation: "state.keys", data: [] },
      { ...reply(), contextAuthority: stale }, { ...reply(), providerDiagnostic: "private-provider-sentinel" }]) {
      upstream.mockResolvedValueOnce(Response.json(value));
      const response = await POST(request("invoke", invoke()), context(["invoke"]));
      expect(response.status).toBe(502); expect(await response.text()).not.toContain("private-");
    }
    for (const value of [{ ...workspace(), scope: otherScope }, { ...workspace(), contextAuthority: stale }]) {
      upstream.mockResolvedValueOnce(Response.json(value));
      expect((await GET(request(`workspace?scope=${scope}`, null, { method: "GET" }), context(["workspace"]))).status).toBe(409);
    }
  });

  it("waits for every private response byte and discards a slow successful body after current authority is withdrawn", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    upstream.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      await gate; controller.enqueue(new TextEncoder().encode(JSON.stringify(reply()))); controller.close();
    } }), { headers: { "content-type": "application/json" } }));
    const pending = POST(request("invoke", invoke()), context(["invoke"]));
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledTimes(1));
    expect(current).toHaveBeenCalledTimes(1);
    current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed")); release();
    const response = await pending;
    expect(response.status).toBe(409); expect(await response.json()).toHaveProperty("code", "authority_changed");
    expect(current).toHaveBeenCalledTimes(2); expect(upstream).toHaveBeenCalledTimes(1);
  });

  it("preserves paid-pause and authority error codes while dropping private diagnostics and never retrying an unknown write", async () => {
    for (const code of ["studio_paid_execution_paused", "authority_changed"]) {
      upstream.mockResolvedValueOnce(Response.json({ code, message: "private-provider-sentinel", private: { token: "private-key-sentinel" } }, { status: 409 }));
      const response = await POST(request("invoke", invoke()), context(["invoke"]));
      expect(response.status).toBe(409); const body = await response.json();
      expect(body.code).toBe(code); expect(JSON.stringify(body)).not.toContain("sentinel");
    }
    upstream.mockRejectedValueOnce(new Error("private-provider-sentinel"));
    const unknown = await POST(request("invoke", invoke()), context(["invoke"]));
    expect(unknown.status).toBe(502); expect(await unknown.text()).not.toContain("sentinel");
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it.each(["configuration", "invoke", "providers"])("authenticates %s before reading the upload and cancels an unauthenticated body", async path => {
    const upload = streamedRequest(path);
    identity.mockRejectedValueOnce(new PersonalSessionError(401, "login_required"));
    const response = await POST(upload.source, context([path]));
    expect(response.status).toBe(401); expect(await response.json()).toHaveProperty("code", "login_required");
    expect(upload.pull).not.toHaveBeenCalled(); expect(upload.cancel).toHaveBeenCalledTimes(1);
    expect(identity).toHaveBeenCalledTimes(1); expect(current).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });

  it("cancels an unread upload after missing or stale authority and after the original operation permission is withdrawn", async () => {
    const stale = erpSessionAuthority({ ...actor, dataScope: "self" });
    for (const authority of [null, stale]) {
      const upload = streamedRequest("invoke", { stamp: authority });
      const response = await POST(upload.source, context(["invoke"]));
      expect(response.status).toBe(409); expect(await response.json()).toHaveProperty("code", "authority_changed");
      expect(upload.pull).not.toHaveBeenCalled(); expect(upload.cancel).toHaveBeenCalledTimes(1);
    }
    const readOnlyActor: ErpSessionView = { ...actor, permissions: ["design:read", "asset:read"],
      permissionScopes: { "design:read": "tenant", "asset:read": "tenant" } };
    identity.mockResolvedValueOnce(personalIdentity(readOnlyActor));
    const denied = streamedRequest("configuration", { stamp: erpSessionAuthority(readOnlyActor) });
    expect((await POST(denied.source, context(["configuration"]))).status).toBe(403);
    expect(denied.pull).not.toHaveBeenCalled(); expect(denied.cancel).toHaveBeenCalledTimes(1);
    expect(current).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });

  it.each(["configuration", "invoke"])("rechecks current authority after the slow %s upload and refuses to send its original write", async path => {
    const upload = streamedRequest(path);
    const pending = POST(upload.source, context([path]));
    await vi.waitFor(() => expect(upload.pull).toHaveBeenCalledTimes(1));
    expect(identity).toHaveBeenCalledTimes(1); expect(current).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
    current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    upload.controller.enqueue(new TextEncoder().encode(JSON.stringify(path === "invoke" ? invoke() : configuration())));
    upload.controller.close();
    const response = await pending;
    expect(response.status).toBe(409); expect(await response.json()).toHaveProperty("code", "authority_changed");
    expect(current).toHaveBeenCalledTimes(1); expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects JSON-prefix MIME impostors on both authenticated writes before forwarding", async () => {
    for (const path of ["configuration", "invoke"]) for (const contentType of ["application/jsonp", "application/json-patch+json", "application/json, text/plain"]) {
      const response = await POST(request(path, path === "invoke" ? invoke() : configuration(), { headers: { "content-type": contentType } }), context([path]));
      expect(response.status).toBe(415); expect(await response.text()).not.toContain("synthetic-entry-only");
    }
    expect(identity).toHaveBeenCalledTimes(6); expect(current).not.toHaveBeenCalled(); expect(upstream).not.toHaveBeenCalled();
  });

  it("returns bounded408 and cancels a stalled authenticated upload at its body deadline without an upstream write", async () => {
    const deadline = new AbortController(), timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const upload = streamedRequest("invoke");
    try {
      const pending = POST(upload.source, context(["invoke"]));
      await vi.waitFor(() => expect(upload.pull).toHaveBeenCalledTimes(1));
      expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000); deadline.abort();
      const response = await pending; expect(response.status).toBe(408);
      expect(await response.json()).toEqual({ error: "数据读取超时 请保留当前内容后重试" });
      expect(upload.cancel).toHaveBeenCalledTimes(1); expect(upstream).not.toHaveBeenCalled(); expect(current).not.toHaveBeenCalled();
    } finally { timeout.mockRestore(); }
  });
});
