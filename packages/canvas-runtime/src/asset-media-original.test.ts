import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import type { Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasNodeData } from "@/types/canvas";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
const bytes = "synthetic original bytes";
const source = { entryId: "019f0000-0000-7000-8000-000000000001", revision: 3, namespace: "image_files" as const, assetId: "019f0000-0000-7000-8000-000000000002", assetVersion: 1, checksumSha256: createHash("sha256").update(bytes).digest("hex"), mediaType: "image/png", byteSize: bytes.length, sourceKind: "owned" as const };
const workspace = { version: 1, scope: "unassigned", originalHandoffVersion: 1, contextAuthority: erpSessionAuthority({ tenantId: source.entryId, userId: source.assetId, permissions: [], dataScope: "self", teamIds: [] }), capabilities: { read: true, save: true, mediaWrite: true, review: false, submit: false, configure: false }, generation: { enabled: false, code: "operator_paused" } };
const transport = vi.hoisted(() => ({ rpc: vi.fn(), notify: vi.fn(), initialized: Promise.resolve({ workspace: undefined as unknown }), persistence: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() } }));
vi.mock("./rpc", () => transport);
vi.mock("./storage", () => ({ decodeBlob: (media: { contentBase64: string; mediaType: string }) => new Blob([atob(media.contentBase64)], { type: media.mediaType }) }));
vi.mock("./localforage-storage", () => ({ localForageStorage: transport.persistence }));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
const inspection = { source, technical: { status: "verified", kind: "image", encodedWidth: 240, encodedHeight: 640, displayWidth: 640, displayHeight: 240, orientation: 6, validation: "full_static_decode" } };
const original = { revision: source.revision, assetId: source.assetId, media: { contentBase64: btoa(bytes), mediaType: source.mediaType } };
const asset: Asset = { id: source.assetId, kind: "image", title: "合成夹具", coverUrl: "", tags: [], createdAt: "", updatedAt: "", data: { dataUrl: "", storageKey: "image:fixture", width: 9999, height: 9999, bytes: 1, mimeType: "image/png" } };
beforeEach(() => { vi.resetModules(); vi.stubGlobal("window", new EventTarget()); transport.initialized = Promise.resolve({ workspace }); transport.rpc.mockReset(); transport.notify.mockReset(); transport.persistence.getItem.mockReset().mockResolvedValue(null); transport.persistence.setItem.mockReset().mockResolvedValue(undefined); transport.persistence.removeItem.mockReset().mockResolvedValue(undefined); });
afterEach(() => { window.dispatchEvent(new CustomEvent("studio.workspace", { detail: { workspace: undefined } })); if (vi.isFakeTimers()) vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function setup() {
  const lifecycle = (await import("./canvas-lifecycle")).canvasLifecycles;
  const a = lifecycle.create("A"); a.activate(); a.beginRestore(); a.markRestored();
  const media = await import("./asset-media"); await Promise.resolve();
  return { lifecycle, a, media };
}
describe("original asset insertion callback ownership", () => {
  it("does not read or insert late A metadata into B after a slow inspection", async () => {
    const { lifecycle, media } = await setup(); let resolve!: (value: unknown) => void;
    transport.rpc.mockImplementation(() => new Promise(done => { resolve = done; }));
    const action = vi.fn(), insertion = media.withAssetOriginal(asset, action, true);
    await vi.waitFor(() => expect(transport.rpc).toHaveBeenCalledTimes(1));
    const b = lifecycle.create("B"); b.activate(); b.beginRestore(); b.markRestored(); resolve(inspection); await insertion;
    expect(action).not.toHaveBeenCalled(); expect(transport.rpc.mock.calls.map(([input]) => input.operation)).toEqual(["asset.inspect"]);
    expect(transport.notify).not.toHaveBeenCalled();
  });
  it("does not insert late A original bytes into B and cancels the original read signal", async () => {
    const { lifecycle, media } = await setup(); let resolve!: (value: unknown) => void;
    transport.rpc.mockResolvedValueOnce(inspection).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const action = vi.fn(), insertion = media.withAssetOriginal(asset, action, true);
    await vi.waitFor(() => expect(transport.rpc).toHaveBeenCalledTimes(2));
    const signal = transport.rpc.mock.calls[1]![1].signal as AbortSignal;
    const b = lifecycle.create("B"); b.activate(); b.beginRestore(); b.markRestored(); expect(signal.aborted).toBe(true);
    resolve(original); await insertion; expect(action).not.toHaveBeenCalled();
    expect(transport.notify).not.toHaveBeenCalled();
  });
  it("replaces forged nonzero client dimensions with verified original projection and exact bytes", async () => {
    const { media, a } = await setup(); transport.rpc.mockResolvedValueOnce(inspection).mockResolvedValueOnce(original);
    const action = vi.fn(); await media.withAssetOriginal(asset, action, true);
    expect(action).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ width: 640, height: 240, bytes: bytes.length }) }));
    const data = (action.mock.calls[0]![0] as Extract<Asset, { kind: "image" }>).data;
    expect(data.dataUrl).toMatch(/^blob:/);
    const { persistedCanvasOriginals } = await import("./canvas-legacy-media"), { restoreCanvasMedia } = await import("./canvas-project-session");
    const saved: CanvasNodeData = persistedCanvasOriginals({ id: "new-original", type: CanvasNodeType.Image, title: "New original", position: { x: 0, y: 0 }, width: data.width, height: data.height, metadata: { content: data.dataUrl, storageKey: data.storageKey } });
    expect(saved.metadata).toEqual({ content: "", storageKey: asset.data.storageKey });
    transport.rpc.mockResolvedValueOnce(original);
    const restored = await restoreCanvasMedia([saved], [], a, a.beginRestore());
    expect(restored.nodes[0]?.metadata?.content).toMatch(/^blob:/); expect(restored.nodes[0]?.metadata?.content).not.toBe(data.dataUrl);
    expect(persistedCanvasOriginals(restored.nodes)).toStrictEqual([saved]); a.release();
  });
  it("keeps keyed original fields stable through repeated restore and a B whole-store save", async () => {
    const { lifecycle, a } = await setup(), { restoreCanvasMedia } = await import("./canvas-project-session");
    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store"), { useStudioModels } = await import("./model-state");
    await useCanvasStore.persist.rehydrate(); useStudioModels.setState({ canSave: true }); vi.useFakeTimers();
    const uri = `data:image/png;base64,${btoa(bytes)}`, base = { title: "Synthetic original", position: { x: 40, y: 80 }, width: 320, height: 180 };
    const image = { id: "variant", status: "success" as const, content: "blob:previous-variant-session", storageKey: "image:variant", naturalWidth: 640, naturalHeight: 240, bytes: bytes.length, mimeType: "image/png" };
    const nodes: CanvasNodeData[] = [
      { ...base, id: "keyed-image", type: CanvasNodeType.Image, metadata: { content: "blob:previous-synthetic-session", storageKey: asset.data.storageKey, images: [image, { ...image, id: "legacy", content: uri, storageKey: undefined }] } },
      { ...base, id: "keyed-without-content", type: CanvasNodeType.Image, metadata: { storageKey: "image:without-content" } },
      { ...base, id: "keyed-video", type: CanvasNodeType.Video, metadata: { content: "blob:previous-video-session", storageKey: "video:original" } },
      { ...base, id: "keyed-audio", type: CanvasNodeType.Audio, metadata: { content: "blob:previous-audio-session", storageKey: "audio:original" } },
    ];
    const sessions: CanvasAssistantSession[] = [{ id: "chat", title: "Original chat", createdAt: "old", updatedAt: "old", messages: [
      { id: "references", role: "user", text: "Original references", references: [
        { id: "keyed-ref", type: CanvasNodeType.Image, title: "Keyed", dataUrl: "blob:previous-reference-session", storageKey: asset.data.storageKey },
        { id: "keyed-ref-without-url", type: CanvasNodeType.Image, title: "Keyed without URL", storageKey: "image:reference" },
        { id: "legacy-ref", type: CanvasNodeType.Image, title: "Legacy", dataUrl: uri },
      ] }, { id: "without-references", role: "assistant", text: "No media" },
    ] }];
    const sourceA: CanvasProject = { id: "A", title: "Original A", createdAt: "old", updatedAt: "old", nodes, chatSessions: sessions, connections: [], activeChatId: "chat", backgroundMode: "lines", showImageInfo: false, viewport: { x: 137, y: 83, k: .65 } };
    useCanvasStore.setState({ projects: [sourceA], deletedProjects: [] }); transport.rpc.mockResolvedValue(original);
    let previousDisplay = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const savedA = useCanvasStore.getState().openProject("A")!;
      const restored = await restoreCanvasMedia(savedA.nodes, savedA.chatSessions, a, a.beginRestore()); a.markRestored();
      const display = restored.nodes[0]!.metadata!.content!;
      expect(display).toMatch(/^blob:/); expect(display).not.toBe(previousDisplay || nodes[0]!.metadata!.content); previousDisplay = display;
      useCanvasStore.getState().updateProject("A", { nodes: restored.nodes, chatSessions: restored.sessions });
      expect(useCanvasStore.getState().openProject("A")!.nodes).toStrictEqual(nodes);
      expect(useCanvasStore.getState().openProject("A")!.chatSessions).toStrictEqual(sessions);
    }
    const bId = useCanvasStore.getState().createProject("B"), b = lifecycle.create(bId); b.activate(); b.beginRestore(); b.markRestored();
    const bNode: CanvasNodeData = { ...base, id: "b-only", type: CanvasNodeType.Text, metadata: { content: "B only" } };
    useCanvasStore.getState().updateProject(bId, { nodes: [bNode] }); await vi.runAllTimersAsync();
    const saved = JSON.parse(String(transport.persistence.setItem.mock.lastCall?.[1])) as { state: { projects: CanvasProject[] } };
    const finalA = saved.state.projects.find(project => project.id === "A")!;
    expect(finalA.nodes).toEqual(JSON.parse(JSON.stringify(nodes))); expect(finalA.chatSessions).toEqual(sessions);
    expect(finalA.connections).toEqual(sourceA.connections); expect(finalA.viewport).toEqual(sourceA.viewport);
    expect(JSON.stringify(saved)).not.toContain(previousDisplay); expect(saved.state.projects.find(project => project.id === bId)?.nodes).toEqual([bNode]);
    expect(transport.rpc.mock.calls.every(([request]) => request.operation === "state.get")).toBe(true); b.release();
  });
  it("restores a readonly legacy embedded original without owner RPC or upload and rejects a late old lease", async () => {
    transport.initialized = Promise.resolve({ workspace: { ...workspace, capabilities: { ...workspace.capabilities, save: false, mediaWrite: false } } });
    const { lifecycle, a } = await setup(), { restoreCanvasMedia } = await import("./canvas-project-session"), { persistedCanvasOriginals } = await import("./canvas-legacy-media");
    const uri = `data:image/png;base64,${btoa(bytes)}`;
    const node: CanvasNodeData = { id: "legacy", type: CanvasNodeType.Image, title: "Legacy", position: { x: 4, y: 8 }, width: 400, height: 300, metadata: { content: uri } };
    const restored = await restoreCanvasMedia([node], [], a, a.beginRestore());
    expect(restored.nodes[0]?.metadata?.content).toMatch(/^blob:/);
    expect(persistedCanvasOriginals(restored.nodes)[0]?.metadata?.content).toBe(uri);
    expect(transport.rpc).not.toHaveBeenCalled();
    const late = restoreCanvasMedia([node], [], a, a.beginRestore()), rejected = expect(late).rejects.toMatchObject({ name: "AbortError" });
    const b = lifecycle.create("B"); b.activate(); b.beginRestore(); await rejected;
    expect(transport.rpc).not.toHaveBeenCalled();
  });
});
