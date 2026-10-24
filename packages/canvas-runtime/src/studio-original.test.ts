import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import type { StudioWorkspace } from "@yummyai/contracts/pod/studio-personal";
import { createOriginalFactsUpdates, createOriginalInspector, originalFacts, originalWorkspaceIdentity, verifiedMediaProjection } from "./original-inspection";
import { createCanvasIfAllowed, createCanvasLifecycles, fitCanvasBounds, restoredViewport } from "./canvas-lifecycle";
import { adaptStudioOriginal } from "../studio-original-adapter";
import { persistedCanvasOriginals, restoreLegacyImage } from "./canvas-legacy-media";
import { applyCatalogueProjection, catalogueAssetId, cataloguePreviewIdentity, catalogueProjectionActive, mergeStudioCatalogue } from "./asset-catalogue";
import type { Asset } from "@/stores/use-asset-store";
const source = { entryId: "019f0000-0000-7000-8000-000000000001", revision: 3, namespace: "image_files" as const, assetId: "019f0000-0000-7000-8000-000000000002", assetVersion: 1, checksumSha256: "a".repeat(64), mediaType: "image/jpeg", byteSize: 4321, sourceKind: "owned" as const };
const inspection = { source, technical: { status: "verified" as const, kind: "image" as const, encodedWidth: 640, encodedHeight: 480, displayWidth: 480, displayHeight: 640, orientation: 6, validation: "full_static_decode" as const } };
const workspace: StudioWorkspace = { version: 1, scope: "unassigned", originalHandoffVersion: 1, contextAuthority: erpSessionAuthority({ tenantId: source.entryId, userId: source.assetId, permissions: [], dataScope: "self", teamIds: [] }), capabilities: { read: true, save: true, mediaWrite: true, review: false, submit: false, configure: false }, generation: { enabled: false, code: "operator_paused" } };
const address = { key: "image:original", namespace: "image_files" as const, assetId: source.assetId };
describe("original media and canvas ownership", () => {
  it("uses only verified original display dimensions, orientation and registered bytes", () => {
    expect(verifiedMediaProjection(inspection)).toEqual({ width: 480, height: 640, bytes: 4321, mimeType: "image/jpeg" });
    expect(originalFacts(inspection)).toContain("480×640 px"); expect(originalFacts(inspection)).toContain("编码 640×480");
    const failed = { source, technical: { status: "failed" as const, code: "integrity_mismatch" as const } };
    expect(originalFacts(failed)).toContain("登记大小"); expect(originalFacts(failed)).not.toContain("640");
    expect(() => verifiedMediaProjection(failed)).toThrow("尚未通过核对");
  });
  it("sends no new inspection operation to an older service", async () => {
    const transport = vi.fn(), inspector = createOriginalInspector(transport); inspector.configure({ ...workspace, originalHandoffVersion: undefined });
    await expect(inspector.inspect(address)).rejects.toThrow("尚未提供原件核对"); expect(transport).not.toHaveBeenCalled();
  });
  it("keeps one pending inspection through two equivalent workspace echoes and presents its original facts", async () => {
    let resolve!: (value: unknown) => void;
    const transport = vi.fn<(request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>>(() => new Promise<unknown>(done => { resolve = done; }));
    const inspector = createOriginalInspector(transport), updates = createOriginalFactsUpdates(originalWorkspaceIdentity(workspace));
    inspector.configure(workspace); const result = inspector.inspect(address), initialKey = updates.key();
    const signal = transport.mock.calls[0]![1];
    for (let echo = 0; echo < 2; echo++) {
      const same = { ...workspace, capabilities: { ...workspace.capabilities } };
      inspector.configure(same);
      expect(updates.workspace(originalWorkspaceIdentity(same))).toBeUndefined();
      expect(updates.key()).toBe(initialKey); expect(signal.aborted).toBe(false);
    }
    expect(transport).toHaveBeenCalledTimes(1); resolve(inspection);
    await expect(result.then(originalFacts)).resolves.toContain("480×640 px");
  });
  it("invalidates pending original reads for real scope, authority, protocol or capability changes", async () => {
    const changedAuthority = erpSessionAuthority({ tenantId: source.entryId, userId: source.entryId, permissions: [], dataScope: "self", teamIds: [] });
    const changed: StudioWorkspace[] = [{ ...workspace, scope: source.entryId }, { ...workspace, contextAuthority: changedAuthority },
      { ...workspace, originalHandoffVersion: undefined }, ...Object.keys(workspace.capabilities).map(name => {
        const capability = name as keyof StudioWorkspace["capabilities"];
        return { ...workspace, capabilities: { ...workspace.capabilities, [capability]: !workspace.capabilities[capability] } };
      })];
    for (const next of changed) {
      let resolve!: (value: unknown) => void;
      const transport = vi.fn<(request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>>(() => new Promise<unknown>(done => { resolve = done; }));
      const inspector = createOriginalInspector(transport), updates = createOriginalFactsUpdates(originalWorkspaceIdentity(workspace));
      inspector.configure(workspace); const result = inspector.inspect(address), rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
      const before = updates.key(); inspector.configure(next);
      const invalidated = updates.workspace(originalWorkspaceIdentity(next));
      expect(invalidated).toBeDefined(); expect(invalidated).toBe(updates.key()); expect(invalidated).not.toBe(before);
      expect(transport.mock.calls[0]![1].aborted).toBe(true); resolve(inspection); await rejected;
    }
    const updates = createOriginalFactsUpdates(originalWorkspaceIdentity(workspace)), before = updates.key();
    updates.workspace(originalWorkspaceIdentity(changed[0])); updates.workspace(originalWorkspaceIdentity(workspace));
    expect(updates.key()).not.toBe(before);
  });
  it("rechecks an explicit refresh without restarting again on a same-workspace echo or adopting late old facts", async () => {
    const pending: Array<(value: unknown) => void> = [];
    const transport = vi.fn<(request: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>>(() => new Promise<unknown>(resolve => pending.push(resolve)));
    const inspector = createOriginalInspector(transport), identity = originalWorkspaceIdentity(workspace), updates = createOriginalFactsUpdates(identity), adopted = vi.fn();
    inspector.configure(workspace); const oldController = new AbortController();
    const old = inspector.inspect(address, oldController.signal).then(adopted), rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    const before = updates.key(), refreshed = updates.refresh(); expect(refreshed).not.toBe(before); oldController.abort();
    const currentController = new AbortController(), current = inspector.inspect(address, currentController.signal).then(adopted);
    inspector.configure({ ...workspace }); expect(updates.workspace(identity)).toBeUndefined(); expect(updates.key()).toBe(refreshed);
    expect(transport).toHaveBeenCalledTimes(2); expect(transport.mock.calls[1]![1].aborted).toBe(false);
    pending[0]!(inspection); await rejected; expect(adopted).not.toHaveBeenCalled();
    pending[1]!(inspection); await current; expect(adopted).toHaveBeenCalledExactlyOnceWith(inspection);
  });
  it("repairs a persisted old catalogue ID by current namespace and key before inspecting the new original", async () => {
    const old: Asset = { id: source.entryId, kind: "image", title: "本人保留名称", tags: ["保留标签"], source: "本人来源", createdAt: "old", updatedAt: "old", coverUrl: "", data: { dataUrl: "", storageKey: address.key, width: 9999, height: 7777, bytes: 100000, mimeType: "image/png" } };
    const inspector = createOriginalInspector(async () => inspection); inspector.configure(workspace);
    await expect(inspector.inspect({ ...address, assetId: old.id })).rejects.toThrow("原件已变化");
    const next = mergeStudioCatalogue([old], [{ key: address.key, namespace: "image_files", assetId: source.assetId, mediaType: source.mediaType, fileName: "server-name.jpg" }], "now");
    const repaired = next[0]!;
    expect(repaired).toMatchObject({ id: source.assetId, title: old.title, tags: old.tags, source: old.source, metadata: { erpOriginalStatus: "unknown" }, data: { width: 0, height: 0, bytes: 0, mimeType: source.mediaType } });
    expect(cataloguePreviewIdentity(repaired)).not.toBe(cataloguePreviewIdentity(old));
    const facts = await inspector.inspect({ ...address, assetId: catalogueAssetId(repaired) });
    expect(facts.source.assetId).toBe(source.assetId); expect(originalFacts(facts)).toContain("480×640 px");
    expect(mergeStudioCatalogue(next, [{ key: address.key, namespace: "image_files", assetId: source.assetId, mediaType: source.mediaType, fileName: "server-name.jpg" }], "later")).toBe(next);
  });
  it("keeps catalogue entries outside a bounded server result and marks projection-only changes so readonly hydration does not write", () => {
    const outside: Asset = { id: source.assetId, kind: "image", title: "目录外保留", tags: [], createdAt: "old", updatedAt: "old", coverUrl: "", data: { dataUrl: "", storageKey: "image:outside-page", width: 4, height: 8, bytes: 16, mimeType: "image/png" } };
    const current = [outside]; expect(mergeStudioCatalogue(current, [], "now")).toBe(current);
    expect(catalogueProjectionActive()).toBe(false);
    const ownerWrite = vi.fn();
    applyCatalogueProjection(() => { if (!catalogueProjectionActive()) ownerWrite(); });
    expect(ownerWrite).not.toHaveBeenCalled(); expect(catalogueProjectionActive()).toBe(false);
    expect(() => applyCatalogueProjection(() => { throw new Error("Synthetic projection stop"); })).toThrow("projection stop");
    expect(catalogueProjectionActive()).toBe(false);
  });
  it("limits concurrent original reads to three and one bad file does not block the rest", async () => {
    const pending: Array<(value: unknown) => void> = [], transport = vi.fn(() => new Promise<unknown>(resolve => pending.push(resolve)));
    const inspector = createOriginalInspector(transport); inspector.configure(workspace);
    const calls = Array.from({ length: 5 }, (_, index) => inspector.inspect({ ...address, key: `image:${index}` }).then(value => value.technical.status, () => "failed"));
    expect(transport).toHaveBeenCalledTimes(3);
    pending[0]!({ malformed: true }); pending[1]!(inspection); pending[2]!(inspection);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(5));
    pending[3]!(inspection); pending[4]!(inspection);
    expect(await Promise.all(calls)).toEqual(["failed", "verified", "verified", "verified", "verified"]);
  });
  it("rejects a mismatched asset and ignores late metadata after owner scope changes", async () => {
    let resolve!: (value: unknown) => void;
    const inspector = createOriginalInspector(() => new Promise(done => { resolve = done; })); inspector.configure(workspace);
    const first = inspector.inspect(address); const failed = expect(first).rejects.toBeDefined();
    inspector.configure({ ...workspace, scope: source.entryId }); resolve(inspection); await failed;
    const wrong = inspector.inspect({ ...address, assetId: source.entryId }); const wrongFailed = expect(wrong).rejects.toThrow("原件已变化"); resolve(inspection); await wrongFailed;
  });
  it("a cancelled visible card cannot adopt a late successful inspection", async () => {
    let resolve!: (value: unknown) => void; const controller = new AbortController();
    const inspector = createOriginalInspector(() => new Promise(done => { resolve = done; })); inspector.configure(workspace);
    const result = inspector.inspect(address, controller.signal), failed = expect(result).rejects.toBeDefined(); controller.abort(); resolve(inspection); await failed;
  });
  it("isolates both restore epochs and global writes when A changes to B", () => {
    const registry = createCanvasLifecycles(), a = registry.create("A"), b = registry.create("B");
    a.activate(); const oldRestore = a.beginRestore(); a.markRestored(); const insertA = registry.captureWrite(); expect(registry.canWrite("A")).toBe(true);
    b.activate(); const restoreB = b.beginRestore(); expect(oldRestore()).toBe(false); expect(insertA()).toBe(false); expect(registry.canWrite("A")).toBe(false); expect(registry.canWrite("B")).toBe(false);
    expect(restoreB()).toBe(true); b.markRestored(); expect(registry.canWrite("B")).toBe(true); expect(insertA()).toBe(false);
    b.release(); expect(registry.canWrite("B")).toBe(false);
  });
  it("late picker completion is invalid even after retrying the same canvas ID", () => {
    const registry = createCanvasLifecycles(), a = registry.create("A"); a.activate(); a.beginRestore(); a.markRestored(); const originalInsertion = registry.captureWrite();
    a.beginRestore(); a.markRestored(); expect(registry.canWrite("A")).toBe(true); expect(originalInsertion()).toBe(false);
  });
  it("a loading-shell create action rechecks the current save capability instead of adopting a stale enabled menu", () => {
    let canSave = true; const originalCreate = vi.fn(), invoke = () => createCanvasIfAllowed(() => canSave, originalCreate);
    canSave = false; invoke(); expect(originalCreate).not.toHaveBeenCalled();
    canSave = true; invoke(); expect(originalCreate).toHaveBeenCalledTimes(1);
  });
  it("restores legacy embedded bytes locally while the durable global state preserves their original URI", () => {
    const uri = `data:image/png;base64,${btoa("synthetic local legacy original")}`, controller = new AbortController();
    const url = restoreLegacyImage(uri, controller.signal, () => true);
    const globalValue = persistedCanvasOriginals({ nodes: [{ metadata: { content: url } }], viewport: { x: 40, y: 50, k: .5 } });
    expect(url).toMatch(/^blob:/); expect(globalValue.nodes[0]?.metadata.content).toBe(uri);
    controller.abort(); expect(globalValue.nodes[0]?.metadata.content).toBe(uri);
    expect(() => restoreLegacyImage(uri, controller.signal, () => false)).toThrow();
    expect(() => restoreLegacyImage("data:image/svg+xml;base64,PHN2Zz4=", new AbortController().signal, () => true)).toThrow("格式暂不支持");
  });
  it("preserves valid historic viewports and uses a finite fallback only for invalid input", () => {
    expect(restoredViewport({ x: 471.25, y: -603, k: .37 })).toEqual({ x: 471.25, y: -603, k: .37 });
    for (const value of [null, {}, { x: 0, y: 0, k: 0 }, { x: Infinity, y: 0, k: 1 }]) expect(restoredViewport(value)).toEqual({ x: 0, y: 0, k: 1 });
    const next = fitCanvasBounds({ left: -600, top: -100, right: 900, bottom: 900 }, { width: 390, height: 650 })!;
    expect(next.k).toBeLessThan(1); expect(-600 * next.k + next.x).toBeGreaterThanOrEqual(31); expect(900 * next.k + next.x).toBeLessThanOrEqual(359);
    expect(fitCanvasBounds({ left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }, { width: 390, height: 650 })).toBeNull();
  });
  it("applies all lifecycle and fact transforms against exact fixed upstream anchors", () => {
    for (const name of ["pages/canvas/project.tsx", "stores/canvas/use-canvas-store.ts", "components/canvas/canvas-zoom-controls.tsx", "pages/assets/index.tsx", "components/canvas/asset-picker-modal.tsx", "components/canvas/canvas-side-panel.tsx", "services/image-storage.ts", "services/file-storage.ts"]) {
      const original = readFileSync(new URL(`../vendor/src/${name}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
      const result = adaptStudioOriginal(original, name, value => `/owned/${value}`);
      expect(result).not.toBe(original);
      if (name === "pages/canvas/project.tsx") { expect(result).toContain("isCurrentRestore"); expect(result).toContain("canvasLease.canSave()"); expect(result).toContain("nodeBounds(nodesRef.current)"); expect(result).toContain("data-studio-canvas-id"); }
      if (name === "pages/assets/index.tsx") expect(result).not.toContain("{asset.data.width}x{asset.data.height}");
      if (name.endsWith("-storage.ts")) { expect(result).not.toContain("URL.createObjectURL(blob)"); expect(result).toContain("createCanvasDisplayUrl(blob)"); }
    }
    expect(() => adaptStudioOriginal("incompatible upstream", "pages/canvas/project.tsx", value => value)).toThrow("requires one anchor");
  });
});
