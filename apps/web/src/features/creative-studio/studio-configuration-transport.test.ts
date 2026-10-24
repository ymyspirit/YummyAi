import { afterEach, expect, it, vi } from "vitest";
import { studioApi, studioProject, type StudioRequestContext } from "./studio-api";

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
