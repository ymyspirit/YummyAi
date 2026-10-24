import { afterEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { STUDIO_PERSONAL_METADATA_LIMIT } from "@yummyai/contracts/pod/studio-personal";
import { captureStudioContext, studioApi, studioProject, studioReadDenied, studioReadOperations, studioRpc, studioWorkspace, type StudioRequestContext } from "./studio-api";

const tenantId = "019a0000-0000-7000-8000-000000000001", userId = "019a0000-0000-7000-8000-000000000002", scope = "019a0000-0000-7000-8000-000000000003";
const authority = erpSessionAuthority({ tenantId, userId, permissions: ["design:read"], dataScope: "tenant", teamIds: [] });
const workspace = { version: 1, scope, contextAuthority: authority, capabilities: { read: true, save: true, mediaWrite: true, review: false, submit: false, configure: false }, generation: { enabled: false, code: "operator_paused" } };
function context(current = () => true) { return captureStudioContext({ authority, ownerScope: `${tenantId}:${userId}`, localDevelopment: false }, new AbortController().signal, current); }
function json(value: unknown, stamp = authority) { return Response.json(value, { headers: { "x-yummyai-context-authority": stamp } }); }
function reply(data: unknown, operation = "state.keys", selected = scope, stamp = authority) { return { version: 1, scope: selected, contextAuthority: stamp, operation, data }; }
afterEach(() => vi.unstubAllGlobals());

describe("personal Studio captured transport", () => {
  it("binds the workspace and invokes the selected original operation with the full personal envelope", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json(workspace)).mockResolvedValueOnce(json(reply(["original_canvas"])));
    vi.stubGlobal("fetch", fetch);
    const capture = context();
    expect((await studioWorkspace(scope, capture)).generation).toEqual({ enabled: false, code: "operator_paused" });
    expect(await studioRpc(scope, { operation: "state.keys", namespace: "app_state" }, undefined, capture)).toEqual(["original_canvas"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/creative-studio/workspace?scope=${scope}`);
    const [url, options] = fetch.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("/api/creative-studio/invoke");
    expect(options.headers).toMatchObject({ "x-yummyai-context-authority": authority });
    expect(JSON.parse(String(options.body))).toEqual({ version: 1, contextAuthority: authority, request: { scope, operation: "state.keys", namespace: "app_state" } });
  });

  it("rejects a mismatched scope, operation, authority, header and extra private output fields", async () => {
    const values = [json(reply([], "state.keys", "unassigned")), json(reply([], "assets")), json(reply([], "state.keys", scope, erpSessionAuthority({ tenantId, userId, permissions: [], dataScope: "self", teamIds: [] }))), json(reply([]), "different"), json({ ...reply([]), extra: "not_accepted" })];
    const fetch = vi.fn(); for (const value of values) fetch.mockResolvedValueOnce(value);
    vi.stubGlobal("fetch", fetch);
    for (let index = 0; index < values.length; index++) await expect(studioRpc(scope, { operation: "state.keys", namespace: "app_state" }, undefined, context())).rejects.toBeInstanceOf(Error);
    expect(fetch).toHaveBeenCalledTimes(values.length);
  });

  it("discards a fully received old success when the captured membership changes before acceptance", async () => {
    let current = true;
    const capture = context(() => current);
    const response = json(reply(["old_key"]));
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => { current = false; return response; }));
    await expect(studioRpc(scope, { operation: "state.keys", namespace: "app_state" }, undefined, capture)).rejects.toMatchObject({ code: "authority_changed" });
    const controller = new AbortController(); controller.abort();
    expect(() => captureStudioContext({ authority, ownerScope: `${tenantId}:${userId}`, localDevelopment: false }, controller.signal, () => true)).toThrow();
    expect(() => captureStudioContext({ authority, ownerScope: `${tenantId}:${scope}`, localDevelopment: false }, new AbortController().signal, () => true)).toThrow();
  });

  it("keeps a lost save unknown and performs only the caller's subsequent original read", async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("network lost")).mockResolvedValueOnce(json(reply({ revision: 5, value: { text: "saved draft" } }, "state.get")));
    vi.stubGlobal("fetch", fetch);
    await expect(studioRpc(scope, { operation: "state.set", namespace: "app_state", key: "canvas", revision: 4, value: { text: "saved draft" } }, undefined, context())).rejects.toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await studioRpc(scope, { operation: "state.get", namespace: "app_state", key: "canvas" }, undefined, context())).toEqual({ revision: 5, value: { text: "saved draft" } });
    expect(fetch).toHaveBeenCalledTimes(2);
    const operations = fetch.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)).request.operation);
    expect(operations).toEqual(["state.set", "state.get"]);
  });

  it("does not submit paid generation or classify generation result adoption as a retryable read", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(studioRpc(scope, { operation: "generate", input: { requestId: userId, modelId: userId, capability: "image", selectionRevision: "a".repeat(64), prompt: "synthetic draft" } }, undefined, context())).rejects.toMatchObject({ code: "operator_paused" });
    expect(fetch).not.toHaveBeenCalled();
    expect(studioReadOperations.has("generation.get")).toBe(false);
    expect(studioReadOperations.has("generate")).toBe(false);
  });

  it("enforces bounded metadata, fatal UTF8, strict configuration and finite redacted errors", async () => {
    const snapshot = { channels: [], analysisModels: [], defaults: { image: null, video: null, text: null, analysis: null }, defaultsRevision: 0 };
    const fetch = vi.fn().mockResolvedValueOnce(json(snapshot))
      .mockResolvedValueOnce(new Response("{}", { headers: { "content-type": "application/json", "content-length": String(STUDIO_PERSONAL_METADATA_LIMIT + 1) } }))
      .mockResolvedValueOnce(new Response(Uint8Array.of(0xff), { headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(json({ ...snapshot, credential: "must_not_be_displayed" }))
      .mockResolvedValueOnce(Response.json({ message: "must_not_be_displayed" }, { status: 503 }))
      .mockResolvedValueOnce(new Response("not json", { status: 403 }));
    vi.stubGlobal("fetch", fetch);
    expect(await studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).toEqual(snapshot);
    for (let i = 0; i < 3; i++) await expect(studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).rejects.toMatchObject({ status: 502 });
    await expect(studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).rejects.toMatchObject({ message: "ERP 创作服务尚未就绪" });
    await expect(studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).rejects.toMatchObject({ status: 403 });
  });

  it("keeps explicit local-development RPC compatibility while refusing uncaptured personal requests", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json([])); vi.stubGlobal("fetch", fetch);
    const legacy = captureStudioContext({ authority: "local-development", ownerScope: null, localDevelopment: true }, new AbortController().signal, () => true);
    expect(await studioRpc("unassigned", { operation: "models" }, undefined, legacy)).toEqual([]);
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/creative-studio/rpc");
    expect(JSON.parse(String((fetch.mock.calls[0]?.[1] as RequestInit).body))).toEqual({ scope: "unassigned", operation: "models" });
    await expect(studioProject("projects", undefined, undefined as unknown as StudioRequestContext)).rejects.toMatchObject({ code: "authority_changed" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("distinguishes ordinary conflicts from a literal authority change without accepting arbitrary project paths", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({ code: "ordinary_conflict" }, { status: 409 })).mockResolvedValueOnce(Response.json({ code: "authority_changed" }, { status: 409 }));
    vi.stubGlobal("fetch", fetch);
    const call = () => studioRpc(scope, { operation: "state.keys", namespace: "app_state" }, undefined, context());
    const ordinary = await call().catch(cause => cause), changed = await call().catch(cause => cause);
    expect(studioReadDenied(ordinary)).toBe(false); expect(studioReadDenied(changed)).toBe(true);
    await expect(studioProject("briefs/invalid/other", undefined, context())).rejects.toMatchObject({ status: 400 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
