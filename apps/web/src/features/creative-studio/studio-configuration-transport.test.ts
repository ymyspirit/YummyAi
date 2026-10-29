import { afterEach, expect, it, vi } from "vitest";
import { studioApi, studioProject, type StudioRequestContext } from "./studio-api";
import { publicModelConfigurationError } from "@yummyai/contracts/ai/model-configuration";

afterEach(() => vi.unstubAllGlobals());
const context = (): StudioRequestContext => ({ authority: "synthetic-current-authority", ownerScope: "synthetic-owner",
  localDevelopment: false, signal: new AbortController().signal, isCurrent: () => true });
const snapshot = { channels: [], analysisModels: [], defaults: { image: null, video: null, text: null, analysis: null }, defaultsRevision: 0 };

it.each([200, 201])("reads a validated configuration returned with legitimate HTTP %s", async status => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot, { status,
    headers: { "x-yummyai-context-authority": "synthetic-current-authority" } })));
  await expect(studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).resolves.toEqual(snapshot);
});

it("keeps the current-identity fence for successful POST responses", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot, { status: 201,
    headers: { "x-yummyai-context-authority": "another-authority" } })));
  await expect(studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).rejects.toMatchObject({ code: "authority_changed" });
});

it("does not accept a queued response or malformed configuration as saved settings", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot, { status: 202 })));
  await expect(studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).rejects.toMatchObject({ status: 202 });
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...snapshot, unexpected: true }, { status: 201,
    headers: { "x-yummyai-context-authority": "synthetic-current-authority" } })));
  await expect(studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).rejects.toMatchObject({ status: 502 });
});

it("reads a legitimate 201 JSON body above the error-body limit using the success limit", async () => {
  const body = " ".repeat(9 * 1024) + JSON.stringify(snapshot);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 201,
    headers: { "content-type": "application/json", "x-yummyai-context-authority": "synthetic-current-authority" } })));
  await expect(studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).resolves.toEqual(snapshot);
});

it("rejects HTTP 201 for a GET project read instead of broadening all successful statuses", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json([], { status: 201,
    headers: { "x-yummyai-context-authority": "synthetic-current-authority" } })));
  await expect(studioProject("projects", undefined, context())).rejects.toMatchObject({ status: 201 });
});

const remove = { operation: "channel.remove", id: "019a0000-0000-7000-8000-000000000001", revision: "synthetic-revision" };
const removalFailures = [
  ["model_configuration_revision_conflict", 409], ["model_configuration_channel_referenced", 409],
  ["model_configuration_channel_busy", 409], ["model_configuration_model_busy", 409],
  ["model_configuration_channel_missing", 404], ["model_configuration_model_missing", 404],
] as const;

it.each(removalFailures)("retains authenticated fixed configuration failure %s at HTTP %i without trusting body text", async (code, status) => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ code, error: "PRIVATE_OWNER_DIAGNOSTIC", detail: { apiKey: "PRIVATE_CREDENTIAL" } }, {
    status, headers: { "x-yummyai-context-authority": "synthetic-current-authority" },
  }));
  vi.stubGlobal("fetch", fetch);
  await expect(studioApi("configuration", remove, "POST", undefined, context())).rejects.toMatchObject({
    status, code, message: publicModelConfigurationError(code, status)!.message,
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(remove);
});

it.each([undefined, "another-authority"])("rejects a known removal failure with missing or substituted response authority %s", async authority => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ code: "model_configuration_channel_busy", error: "PRIVATE" }, {
    status: 409, headers: authority === undefined ? {} : { "x-yummyai-context-authority": authority },
  }));
  vi.stubGlobal("fetch", fetch);
  await expect(studioApi("configuration", remove, "POST", undefined, context())).rejects.toMatchObject({ code: "authority_changed" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("does not apply configuration removal codes to project reads or wrong-status configuration errors", async () => {
  const code = "model_configuration_channel_busy", fetch = vi.fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ code, error: "PRIVATE_CONFIG_DIAGNOSTIC" }, { status: 409, headers: { "x-yummyai-context-authority": "synthetic-current-authority" } }))
    .mockResolvedValueOnce(Response.json({ code, error: "PRIVATE_CONFIG_DIAGNOSTIC" }, { status: 503, headers: { "x-yummyai-context-authority": "synthetic-current-authority" } }));
  vi.stubGlobal("fetch", fetch);
  const projectFailure = await studioProject("projects", undefined, context()).catch((cause: unknown) => cause),
    wrongStatus = await studioApi("configuration", remove, "POST", undefined, context()).catch((cause: unknown) => cause);
  for (const failure of [projectFailure, wrongStatus]) {
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toHaveProperty("code", code);
    expect((failure as Error).message).not.toContain("PRIVATE");
    expect((failure as Error).message).not.toBe(publicModelConfigurationError(code, 409)!.message);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
});

it("discards a complete known failure body after the current identity changes", async () => {
  let current = true, body!: ReadableStreamDefaultController<Uint8Array>;
  const bytes = new TextEncoder().encode(JSON.stringify({ code: "model_configuration_channel_busy", error: "PRIVATE" }));
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), {
    status: 409, headers: { "content-type": "application/json", "x-yummyai-context-authority": "synthetic-current-authority" },
  }));
  vi.stubGlobal("fetch", fetch);
  body.enqueue(bytes.slice(0, 6));
  const pending = studioApi("configuration", remove, "POST", undefined, { ...context(), isCurrent: () => current });
  const rejected = expect(pending).rejects.toMatchObject({ code: "authority_changed" });
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  current = false;
  body.enqueue(bytes.slice(6));
  body.close();
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("keeps unknown writes unknown and does not retry before a separate read-only configuration request", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>()
    .mockRejectedValueOnce(new TypeError("PRIVATE_LOST_ACK"))
    .mockResolvedValueOnce(Response.json(snapshot, { status: 201, headers: { "x-yummyai-context-authority": "synthetic-current-authority" } }));
  vi.stubGlobal("fetch", fetch);
  await expect(studioApi("configuration", remove, "POST", undefined, context())).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  await expect(studioApi("configuration", { operation: "configuration.get" }, "POST", undefined, context())).resolves.toEqual(snapshot);
  expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([remove, { operation: "configuration.get" }]);
});
