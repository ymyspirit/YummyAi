import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import type { StudioVideoDirectory, StudioVideoDirectoryItem, StudioVideoPreflight } from "@yummyai/contracts/pod/studio-video-directory";
import { captureStudioContext, studioReadDenied, studioRpc } from "./studio-api";
import { createStudioVideoDirectory, createStudioVideoRequiredNavigation } from "./studio-video-directory-state";
import { StudioVideoDirectory as DirectoryView } from "./studio-video-directory";

const hash = "a".repeat(64), scope = "unassigned", tenantId = "019a0000-0000-7000-8000-000000000001", userId = "019a0000-0000-7000-8000-000000000002";
const authority = erpSessionAuthority({ tenantId, userId, permissions: ["design:read"], dataScope: "self", teamIds: [] });
const item = (index: number): StudioVideoDirectoryItem => ({ entryId: `019a0000-0000-7000-8000-${String(index).padStart(12, "0")}`, key: `video-log-${index}`, revision: 1, valueSha256: hash, title: `原记录 ${index}`, createdAt: 1, nativeStatus: "pending", origin: "frozen", task: "untracked", generationStatus: null, diagnostics: [] });
const inventory = (count = 1): StudioVideoDirectory => ({ version: 1, snapshotHash: hash, total: count, items: Array.from({ length: count }, (_, index) => item(index + 1)) });
const preflight = (total = 1, ids: string[] = []): StudioVideoPreflight => ({ version: 1, snapshotHash: hash, total, canOpen: ids.length === 0, mode: "view_only", execution: "paused", blockedEntryIds: ids });
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(accept => { resolve = accept; }); return { promise, resolve }; };
const context = () => captureStudioContext({ authority, ownerScope: `${tenantId}:${userId}`, localDevelopment: false }, new AbortController().signal, () => true);
afterEach(() => vi.unstubAllGlobals());

describe("complete native video inventory before opening", () => {
  it("ignores a late video-required after leaving video while retaining current video owner navigation", () => {
    let requestedTool: "video" | "image" | "prompts" = "video", active = true;
    const navigate = vi.fn(), current = () => ({ active, tool: requestedTool, scope, authority });
    const required = createStudioVideoRequiredNavigation({ current, navigate });
    const old = { type: "studio.video-required", scope, contextAuthority: authority };
    // Admission:null can queue the runtime's notice before the next studio.tool arrives.
    // Delivery reads the host's current tool, not the tool captured when it was queued.
    const queued = () => required(old);
    requestedTool = "image"; queued(); requestedTool = "prompts"; queued(); expect(navigate).not.toHaveBeenCalled();
    requestedTool = "video"; required({ ...old, contextAuthority: "old-authority" }); required({ ...old, scope: tenantId }); expect(navigate).not.toHaveBeenCalled();
    required(old); expect(navigate).toHaveBeenCalledExactlyOnceWith(scope);
    active = false; queued(); expect(navigate).toHaveBeenCalledOnce();
  });
  it("reads all 51 records and blocks on the last unknown without opening or changing a native fact", async () => {
    const directory = inventory(51), last = directory.items[50]!; last.nativeStatus = "unknown"; last.origin = "invalid"; last.diagnostics = ["invalid_status"];
    const original = JSON.stringify(directory), admission = vi.fn(), call = vi.fn().mockResolvedValueOnce(directory).mockResolvedValueOnce(preflight(51, [last.entryId]));
    const helper = createStudioVideoDirectory({ current: vi.fn(), call, admission, failure: vi.fn() });
    await helper.read(); expect(helper.snapshot()).toMatchObject({ phase: "ready", directory: { total: 51 } }); expect(call).toHaveBeenCalledOnce();
    expect(admission.mock.calls.every(([value]) => value === null)).toBe(true);
    await helper.open(); expect(helper.snapshot()).toMatchObject({ phase: "blocked", preflight: { blockedEntryIds: [last.entryId] } });
    expect(call.mock.calls.map(([request]) => request)).toEqual([{ operation: "video.directory" }, { operation: "video.preflight", snapshotHash: hash }]);
    expect(admission.mock.calls.every(([value]) => value === null)).toBe(true); expect(JSON.stringify(directory)).toBe(original);
  });
  it("opens only after explicit matching preflight and revokes admission before an explicit reread", async () => {
    const admission = vi.fn(), calls: AbortSignal[] = [], call = vi.fn(async (input: Record<string, unknown>, signal: AbortSignal) => { calls.push(signal); return input.operation === "video.directory" ? inventory(0) : preflight(0); });
    const helper = createStudioVideoDirectory({ current: vi.fn(), call, admission, failure: vi.fn() });
    await helper.read(); expect(helper.snapshot().directory?.total).toBe(0); expect(admission).toHaveBeenLastCalledWith(null);
    await helper.open(); expect(helper.snapshot().phase).toBe("opened"); expect(admission).toHaveBeenLastCalledWith(preflight(0));
    await helper.read(); expect(helper.snapshot().phase).toBe("ready"); expect(admission).toHaveBeenLastCalledWith(null);
    helper.stop(); expect(calls.every(signal => !signal.aborted)).toBe(true); // Completed 200 bodies are never aborted by a later operation.
  });
  it("rejects partial and contradictory inventories rather than rendering an empty or complete directory", async () => {
    const admission = vi.fn(), failure = vi.fn(), call = vi.fn().mockResolvedValueOnce({ ...inventory(1), total: 0 });
    const helper = createStudioVideoDirectory({ current: vi.fn(), call, admission, failure }); await helper.read(); await helper.open();
    expect(helper.snapshot()).toMatchObject({ phase: "error" }); expect(helper.snapshot().directory).toBeUndefined(); expect(call).toHaveBeenCalledOnce(); expect(failure).toHaveBeenCalledOnce();
    expect(admission.mock.calls.every(([value]) => value === null)).toBe(true);
  });
  it("rejects a valid-looking preflight for another snapshot and requires a new complete read", async () => {
    const admission = vi.fn(), call = vi.fn().mockResolvedValueOnce(inventory()).mockResolvedValueOnce({ ...preflight(), snapshotHash: "b".repeat(64) });
    const helper = createStudioVideoDirectory({ current: vi.fn(), call, admission, failure: vi.fn() }); await helper.read(); await helper.open(); await helper.open();
    expect(helper.snapshot().phase).toBe("error"); expect(helper.snapshot().directory).toBeUndefined(); expect(call).toHaveBeenCalledTimes(2); expect(admission.mock.calls.every(([value]) => value === null)).toBe(true);
  });
  it("discards a held old directory after a newer read while keeping the newer full directory", async () => {
    const old = deferred(), signals: AbortSignal[] = [], admission = vi.fn();
    const call = vi.fn((_input: Record<string, unknown>, signal: AbortSignal) => { signals.push(signal); return signals.length === 1 ? old.promise : Promise.resolve(inventory(2)); });
    const helper = createStudioVideoDirectory({ current: vi.fn(), call, admission, failure: vi.fn() }); const pending = helper.read(); await helper.read(); old.resolve(inventory(1)); await pending;
    expect(signals[0]?.aborted).toBe(true); expect(signals[1]?.aborted).toBe(false); expect(helper.snapshot()).toMatchObject({ phase: "ready", directory: { total: 2 } });
  });
  it("keeps CLEAR empty when a held complete 200 or preflight body arrives late", async () => {
    for (const atPreflight of [false, true]) {
      const held = deferred(), admission = vi.fn(), failure = vi.fn(), call = vi.fn();
      if (atPreflight) call.mockResolvedValueOnce(inventory()); call.mockImplementationOnce(() => held.promise);
      const helper = createStudioVideoDirectory({ current: vi.fn(), call, admission, failure });
      if (atPreflight) await helper.read(); const pending = atPreflight ? helper.open() : helper.read(); helper.stop(); held.resolve(atPreflight ? preflight() : inventory()); await pending;
      expect(helper.snapshot()).toEqual({ phase: "idle" }); expect(admission).toHaveBeenLastCalledWith(null); expect(admission.mock.calls.every(([value]) => value === null)).toBe(true); expect(failure).not.toHaveBeenCalled();
    }
  });
  it("drops a source result when its captured authority is invalidated before its body is accepted", async () => {
    let current = true; const held = deferred(), admission = vi.fn();
    const helper = createStudioVideoDirectory({ current: () => { if (!current) throw new Error("authority changed"); }, call: () => held.promise, admission, failure: vi.fn() });
    const pending = helper.read(); current = false; helper.stop(); held.resolve(inventory()); await pending;
    expect(helper.snapshot().directory).toBeUndefined(); expect(admission).toHaveBeenLastCalledWith(null);
  });
  it.each([[409, "studio_video_directory_changed"], [422, "studio_video_directory_too_large"], [409, "studio_video_directory_unavailable"]])("retains HTTP %i %s as a directory error without inventing an authority change", async (status, code) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ code }, { status })); vi.stubGlobal("fetch", fetch);
    const error = await studioRpc(scope, { operation: "video.directory" }, undefined, context()).catch(cause => cause);
    expect(error).toMatchObject({ status, code }); expect(studioReadDenied(error)).toBe(false); expect(fetch).toHaveBeenCalledOnce();
  });
  it("shows missing capability explicitly without attempting a directory or rendering a native iframe", () => {
    const html = renderToStaticMarkup(createElement(DirectoryView, { scope, active: true, capture: context, onReadDenied: vi.fn(), onAdmission: vi.fn() }));
    expect(html).toContain('aria-label="视频原生日志目录"'); expect(html).toContain('data-error-code="studio_video_directory_unavailable"'); expect(html).toContain("当前服务尚未提供完整视频历史检查"); expect(html).not.toContain("<iframe"); expect(html).not.toContain("核对并打开视频工作台");
  });
});
