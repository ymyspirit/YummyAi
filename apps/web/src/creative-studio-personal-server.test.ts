import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { erpSessionAuthority, type ErpSessionView } from "@yummyai/contracts/auth/session";
import { StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { ConfigurationSnapshotSchema, publicModelConfigurationError } from "@yummyai/contracts/ai/model-configuration";
import { PersonalSessionError } from "./identity/core";
import type * as ErpServer from "./erp-auth/server";

const mocks = vi.hoisted(() => ({ upstream: vi.fn<typeof fetch>(), identity: vi.fn(), current: vi.fn<() => Promise<void>>() }));
vi.mock("./server-api", () => ({ apiFetch: mocks.upstream }));
vi.mock("./erp-auth/server", async original => ({
  ...(await original<typeof ErpServer>()), erpRequestIdentity: mocks.identity, assertErpIdentityCurrent: mocks.current,
}));
import {
  readStudioJson, requireStudioPersonalIdentity, studioPersonalCall, studioPersonalException, studioPersonalFailure,
} from "./creative-studio-personal-server";

const actor: ErpSessionView = {
  authenticated: true, canUseErp: true, userId: "019f0000-0000-7000-8000-000000000011",
  tenantId: "019f0000-0000-7000-8000-000000000012", displayName: "Synthetic operator", organizationName: "Synthetic tenant",
  dataScope: "tenant", permissions: ["design:read", "asset:read"],
  permissionScopes: { "design:read": "self", "asset:read": "tenant" },
};
const stamp = erpSessionAuthority(actor);
const identity = {
  view: actor, token: "server-only-token", sessionId: "server-only-session", authority: "synthetic-internal-digest",
  service: { configuration: { apiBase: "https://identity-api.example.test/" } },
} as unknown as ErpServer.ErpRequestIdentity;
const workspace = () => ({
  version: 1, scope: "unassigned", contextAuthority: stamp,
  capabilities: { read: true, save: false, mediaWrite: false, review: false, submit: false, configure: false },
  generation: { enabled: false, code: "operator_paused" },
});
const request = (authority: string | null = stamp) => new Request("https://erp.example.test/api/creative-studio/workspace", {
  headers: authority === null ? {} : { "x-yummyai-context-authority": authority },
});
const call = (source = request(), schema: { parse(value: unknown): unknown } = StudioWorkspaceSchema, limit = 4096) =>
  studioPersonalCall(source, identity, "creative-studio/workspace?scope=unassigned", { method: "GET" }, schema, limit);

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("WEB_AUTH_MODE", "personal"); vi.stubEnv("FACTORY_PORTAL_ONLY", "0");
  vi.stubEnv("API_BASE_URL", "https://unrelated-process-api.example.test");
  mocks.upstream.mockReset(); mocks.identity.mockReset(); mocks.current.mockReset();
  mocks.identity.mockResolvedValue(identity); mocks.current.mockResolvedValue();
});
afterEach(() => vi.unstubAllEnvs());

describe("personal Studio authenticated transport", () => {
  it.each([[400, "studio_model_selection_invalid"], [400, "studio_model_capability_mismatch"], [409, "studio_model_selection_changed"]] as const)("preserves model admission code %s %s only at its exact status", async (status, code) => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "PRIVATE PROVIDER DIAGNOSTIC", token: "PRIVATE" }, { status }));
    const response = await call(), body = await response.json();
    expect(response.status).toBe(status); expect(body.code).toBe(code);
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "PRIVATE" }, { status: 503 }));
    const wrongStatus = await call(); expect((await wrongStatus.json()).code).toBeUndefined();
    expect(mocks.upstream).toHaveBeenCalledTimes(2);
  });
  it("preserves only native inventory owner codes at their exact status without forwarding private details", async () => {
    for (const [status, code] of [[409, "studio_video_directory_changed"], [422, "studio_video_directory_too_large"]] as const) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "PRIVATE NATIVE CONFIG", task: { token: "PRIVATE" } }, { status }));
      const response = await call(), body = await response.json();
      expect(response.status).toBe(status); expect(body.code).toBe(code); expect(JSON.stringify(body)).not.toContain("PRIVATE");
      mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "PRIVATE" }, { status: status === 409 ? 422 : 409 }));
      const invalid = await call(); expect((await invalid.json()).code).toBeUndefined();
    }
  });
  it("maps only exact transfer status codes and never forwards private diagnostic prose", async () => {
    for (const [status, code] of [[400, "studio_transfer_invalid"], [404, "studio_transfer_missing"],
      [409, "studio_transfer_changed"], [409, "studio_transfer_cancelled"], [422, "studio_transfer_unavailable"]] as const) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "SYNTHETIC PRIVATE DIAGNOSTIC" }, { status }));
      const response = await call(), body = await response.json();
      expect(response.status).toBe(status); expect(body.code).toBe(code);
      expect(JSON.stringify(body)).not.toContain("SYNTHETIC PRIVATE DIAGNOSTIC");
    }
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "studio_transfer_cancelled", message: "SYNTHETIC PRIVATE DIAGNOSTIC" }, { status: 503 }));
    const response = await call(), body = await response.json();
    expect(response.status).toBe(503); expect(body.code).toBeUndefined(); expect(JSON.stringify(body)).not.toContain("DIAGNOSTIC");
  });
  it("uses the authenticated service API origin, exact authority header and strict paused workspace schema", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json(workspace()));
    const response = await studioPersonalCall(request(), identity, "creative-studio/workspace?scope=unassigned",
      { method: "GET", headers: { "x-yummyai-context-authority": "forged" } }, StudioWorkspaceSchema, 4096);
    expect(response.status).toBe(200); expect(await response.json()).toEqual(workspace());
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(mocks.upstream).toHaveBeenCalledExactlyOnceWith("https://identity-api.example.test/v1/creative-studio/workspace?scope=unassigned",
      expect.objectContaining({ method: "GET", cache: "no-store", redirect: "error", signal: expect.any(AbortSignal) }));
    const headers = new Headers(mocks.upstream.mock.calls[0]![1]!.headers);
    expect(headers.get("x-yummyai-context-authority")).toBe(stamp); expect(headers.has("authorization")).toBe(false);
    expect(mocks.current).toHaveBeenNthCalledWith(1, identity); expect(mocks.current).toHaveBeenNthCalledWith(2, identity);
  });

  it("requires raw authority equality and each current permission scope without inventing a tenant-wide permission", async () => {
    expect(await requireStudioPersonalIdentity(request(), [Permission.DesignRead, Permission.AssetRead])).toBe(identity);
    const changed = erpSessionAuthority({ ...actor, permissionScopes: { ...actor.permissionScopes, "asset:read": "self" } });
    for (const authority of [null, "not-an-authority", changed])
      await expect(requireStudioPersonalIdentity(request(authority), [Permission.DesignRead])).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    const missingScope = { ...actor, permissionScopes: { "design:read": "self" as const } };
    mocks.identity.mockResolvedValueOnce({ ...identity, view: missingScope });
    await expect(requireStudioPersonalIdentity(request(erpSessionAuthority(missingScope)), [Permission.AssetRead])).rejects.toBeInstanceOf(ForbiddenError);
    expect(mocks.upstream).not.toHaveBeenCalled();
  });

  it("rejects changed membership before an upstream request and does not retry it", async () => {
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    await expect(call()).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    expect(mocks.upstream).not.toHaveBeenCalled(); expect(mocks.current).toHaveBeenCalledTimes(1);
  });

  it("checks current identity after full body consumption and schema parsing rather than after response headers", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const parse = vi.fn((raw: unknown) => StudioWorkspaceSchema.parse(raw));
    mocks.upstream.mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ async start(controller) {
      await gate; controller.enqueue(new TextEncoder().encode(JSON.stringify(workspace()))); controller.close();
    } }), { headers: { "content-type": "application/json" } }));
    const pending = call(request(), { parse });
    // Attach the rejection assertion before releasing the body to avoid an unhandled rejection.
    const rejected = expect(pending).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    await vi.waitFor(() => expect(mocks.upstream).toHaveBeenCalledTimes(1));
    expect(mocks.current).toHaveBeenCalledTimes(1); expect(parse).not.toHaveBeenCalled();
    mocks.current.mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed")); release();
    await rejected;
    expect(parse).toHaveBeenCalledExactlyOnceWith(workspace()); expect(mocks.current).toHaveBeenCalledTimes(2);
  });

  it("rechecks authority after a malformed success body before returning a sanitized transport failure", async () => {
    mocks.upstream.mockResolvedValueOnce(new Response("{ private-provider-sentinel", { headers: { "content-type": "application/json" } }));
    mocks.current.mockResolvedValueOnce().mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    await expect(call()).rejects.toMatchObject({ status: 409, code: "authority_changed" });
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
    mocks.current.mockResolvedValue();
    mocks.upstream.mockResolvedValueOnce(new Response("{ private-provider-sentinel", { headers: { "content-type": "application/json" } }));
    const response = await call(); expect(response.status).toBe(502); expect(await response.text()).not.toContain("sentinel");
  });

  it("rejects extra private fields and incompatible generation capability instead of returning a partial success DTO", async () => {
    for (const raw of [{ ...workspace(), providerCredential: "private-sentinel" }, { ...workspace(), generation: { enabled: true, code: "ready" } }]) {
      mocks.upstream.mockResolvedValueOnce(Response.json(raw));
      const response = await call().catch(error => studioPersonalException(error, request()));
      expect(response.status).toBe(502); expect(await response.text()).not.toContain("sentinel");
    }
  });

  it.each(["authority_changed", "studio_paid_execution_paused"])("preserves only the allowed business code %s without private provider fields", async code => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "private-provider-sentinel", request: { token: "private-token-sentinel" } }, { status: 409 }));
    const response = await call(); expect(response.status).toBe(409);
    const body = await response.json(); expect(body.code).toBe(code); expect(JSON.stringify(body)).not.toContain("sentinel");
    expect(mocks.upstream).toHaveBeenCalledTimes(1); expect(mocks.current).toHaveBeenCalledTimes(2);
  });

  it("does not expose unknown codes or arbitrary exception messages, and preserves explicit short Chinese conflict messages", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "private-provider-sentinel", message: "另一页面已保存此项目。请保留当前内容，重新打开后再编辑。" }, { status: 409 }));
    const conflict = await call(); expect(await conflict.json()).toEqual({ error: "另一页面已保存此项目。请保留当前内容，重新打开后再编辑。" });
    mocks.upstream.mockRejectedValueOnce(new Error("private-provider-sentinel"));
    const unknown = await call().catch(error => studioPersonalException(error, request()));
    expect(unknown.status).toBe(502); expect(await unknown.text()).not.toContain("sentinel");
    expect(mocks.upstream).toHaveBeenCalledTimes(2);
  });

  it("does not echo Chinese-prefixed private provider diagnostics in a known paid-pause failure", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "studio_paid_execution_paused",
      message: "上游诊断 token=private-provider-sentinel", provider: { key: "private-key-sentinel" } }, { status: 409 }));
    const response = await call(); expect(response.status).toBe(409);
    const body = await response.json(); expect(body.code).toBe("studio_paid_execution_paused");
    expect(JSON.stringify(body)).not.toContain("sentinel");
  });

  it("rechecks current identity even when the upstream returned a known business failure", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "studio_paid_execution_paused" }, { status: 409 }));
    mocks.current.mockResolvedValueOnce().mockRejectedValueOnce(new PersonalSessionError(401, "login_required"));
    const response = await call().catch(error => studioPersonalException(error, request()));
    expect(response.status).toBe(401); expect(await response.json()).toHaveProperty("code", "login_required");
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });

  it("cancels a non-final202 response instead of accepting an unproven business result", async () => {
    const cancel = vi.fn();
    mocks.upstream.mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), { status: 202, headers: { "content-type": "application/json" } }));
    const response = await call(); expect(response.status).toBe(502); expect(cancel).toHaveBeenCalledTimes(1);
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });
});

describe("bounded personal Studio JSON reads", () => {
  it.each(["application/jsonp", "application/json-patch+json", "application/json, text/plain"])("rejects MIME impostor %s and cancels its unread body", async contentType => {
    const pull = vi.fn(), cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    await expect(readStudioJson(new Response(body, { headers: { "content-type": contentType } }), 128))
      .rejects.toMatchObject({ status: 415, message: "STUDIO_BODY_REJECTED" });
    expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts a case-insensitive exact JSON MIME token with parameters", async () => {
    expect(await readStudioJson(new Response('{"revision":4}', { headers: { "content-type": " Application/JSON ; charset=utf-8" } }), 128))
      .toEqual({ revision: 4 });
  });

  it("cancels a stalled partial JSON response through the original thirty-second deadline", async () => {
    const deadline = new AbortController(), timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const cancel = vi.fn();
    const source = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"private-provider-sentinel":'));
    }, cancel }), { headers: { "content-type": "application/json" } });
    try {
      const pending = readStudioJson(source, 1024);
      const rejected = expect(pending).rejects.toMatchObject({ status: 408, message: "STUDIO_BODY_REJECTED" });
      expect(timeout).toHaveBeenCalledExactlyOnceWith(30_000);
      await Promise.resolve(); deadline.abort(); await rejected;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { timeout.mockRestore(); }
  });

  it("cancels an already aborted request before consuming its first upload chunk", async () => {
    const aborted = new AbortController(), pull = vi.fn(), cancel = vi.fn();
    const source = new Request("https://erp.example.test/api/creative-studio/invoke", { method: "POST", signal: aborted.signal,
      headers: { "content-type": "application/json" }, body: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), duplex: "half",
    } as RequestInit & { duplex: "half" });
    aborted.abort();
    await expect(readStudioJson(source, 128)).rejects.toMatchObject({ status: 408, message: "STUDIO_BODY_REJECTED" });
    expect(pull).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels an in-flight request reader on caller abort and returns no partial private JSON", async () => {
    const aborted = new AbortController(), pull = vi.fn(), cancel = vi.fn();
    const source = new Request("https://erp.example.test/api/creative-studio/invoke", { method: "POST", signal: aborted.signal,
      headers: { "content-type": "application/json" }, body: new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 }), duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pending = readStudioJson(source, 128);
    const rejected = expect(pending).rejects.toMatchObject({ status: 408, message: "STUDIO_BODY_REJECTED" });
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(1)); aborted.abort(); await rejected;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reads JSON only after all chunks arrive and enforces UTF8 byte length instead of character length", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ text: "原稿" }));
    const source = () => new Response(new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(bytes.slice(0, 4)); controller.enqueue(bytes.slice(4)); controller.close();
    } }), { headers: { "content-type": "application/json; charset=utf-8" } });
    expect(await readStudioJson(source(), bytes.length)).toEqual({ text: "原稿" });
    await expect(readStudioJson(source(), bytes.length - 1)).rejects.toMatchObject({ status: 413 });
  });

  it("cancels oversized advertised and streamed JSON without preserving the raw body", async () => {
    for (const declared of [true, false]) {
      const cancel = vi.fn();
      const source = new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("private-provider-sentinel")); }, cancel }), {
        headers: { "content-type": "application/json", ...(declared ? { "content-length": "25" } : {}) },
      });
      await expect(readStudioJson(source, 8)).rejects.toMatchObject({ status: 413, message: "STUDIO_BODY_REJECTED" });
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ["text/plain", "{}", 415], ["application/json", "{", 400], ["application/json", "", 400],
  ] as const)("rejects %s content %s safely as%i", async (contentType, body, status) => {
    const source = new Response(body, { headers: { "content-type": contentType } });
    await expect(readStudioJson(source, 128)).rejects.toMatchObject({ status, message: "STUDIO_BODY_REJECTED" });
  });

  it("maps forbidden access and unsupported error statuses to bounded public failures", async () => {
    const denied = studioPersonalException(new ForbiddenError(Permission.AssetRead), request());
    expect(denied.status).toBe(403); expect(await denied.text()).not.toContain("asset:read");
    const failure = studioPersonalFailure(500);
    expect(failure.status).toBe(502); expect(failure.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("personal model configuration removal failures", () => {
  const cases = [
    ["model_configuration_revision_conflict", 409], ["model_configuration_channel_referenced", 409],
    ["model_configuration_channel_busy", 409], ["model_configuration_model_busy", 409],
    ["model_configuration_channel_missing", 404], ["model_configuration_model_missing", 404],
  ] as const;
  const configurationRequest = () => new Request("https://erp.example.test/api/creative-studio/configuration", {
    method: "POST", headers: { "content-type": "application/json", "x-yummyai-context-authority": stamp },
  });
  const configurationCall = () => studioPersonalCall(configurationRequest(), identity, "ai/configuration", {
    method: "POST", body: JSON.stringify({ operation: "channel.remove", id: actor.userId, revision: "synthetic-revision" }),
  }, ConfigurationSnapshotSchema, 2 * 1024 * 1024);

  it.each(cases)("returns only fixed %s presentation and the verified current authority at HTTP %i", async (code, status) => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "PRIVATE_REMOVAL_DIAGNOSTIC", route: { label: "PRIVATE_ROUTE", credential: "PRIVATE_CREDENTIAL" } }, { status }));
    const response = await configurationCall();
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ code, error: publicModelConfigurationError(code, status)!.message });
    expect(response.headers.get("x-yummyai-context-authority")).toBe(stamp);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
    expect(mocks.current).toHaveBeenCalledTimes(2);
  });

  it("does not pass wrong-status codes, unknown codes or arbitrary diagnostic text as configuration owner failures", async () => {
    for (const [code, status] of [["model_configuration_channel_busy", 503], ["model_configuration_channel_missing", 409], ["model_configuration_unknown", 409]] as const) {
      mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "渠道诊断 PRIVATE_REMOVAL_DIAGNOSTIC", apiKey: "PRIVATE_CREDENTIAL" }, { status }));
      const response = await configurationCall(), body = await response.json();
      expect(response.status).toBe(status);
      expect(body.code).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("PRIVATE");
    }
    expect(mocks.upstream).toHaveBeenCalledTimes(3);
  });

  it.each(["creative-studio/workspace?scope=unassigned", "creative-studio/invoke"])("does not reuse configuration deletion codes for %s", async target => {
    const code = "model_configuration_channel_busy";
    mocks.upstream.mockResolvedValueOnce(Response.json({ code, message: "PRIVATE_CONFIG_OWNER_DIAGNOSTIC" }, { status: 409 }));
    const response = await studioPersonalCall(request(), identity, target, { method: "GET" }, StudioWorkspaceSchema, 4096), body = await response.json();
    expect(response.status).toBe(409);
    expect(body.code).toBeUndefined();
    expect(body.error).not.toBe(publicModelConfigurationError(code, 409)!.message);
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });

  it("rechecks withdrawn authority before forwarding an otherwise known configuration rejection", async () => {
    mocks.upstream.mockResolvedValueOnce(Response.json({ code: "model_configuration_channel_busy", message: "PRIVATE" }, { status: 409 }));
    mocks.current.mockResolvedValueOnce().mockRejectedValueOnce(new PersonalSessionError(409, "authority_changed"));
    const response = await configurationCall().catch(error => studioPersonalException(error, configurationRequest()));
    expect(response.status).toBe(409);
    expect(await response.json()).toHaveProperty("code", "authority_changed");
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });

  it("keeps a lost configuration outcome unknown and never resends the removal", async () => {
    mocks.upstream.mockRejectedValueOnce(new TypeError("PRIVATE_LOST_ACK_DIAGNOSTIC"));
    const response = await configurationCall().catch(error => studioPersonalException(error, configurationRequest())), body = await response.json();
    expect(response.status).toBe(502);
    expect(body.code).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("PRIVATE");
    expect(mocks.upstream).toHaveBeenCalledTimes(1);
  });
});
