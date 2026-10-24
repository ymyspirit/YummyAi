import { beforeEach, describe, expect, it } from "vitest";
import { buildStudioDocumentPlan, type TransferEntry } from "./studio-document-manifest.js";

type Row = Record<string, unknown>;
const identity = { sourceScope: "unassigned", targetScope: "019f0000-0000-7000-8000-000000000001", requestId: "86cf4d41-62f9-4bd9-9dc6-e185ff274958" };
const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/W9sAAAAASUVORK5CYII=";
const canvasKey = "infinite-canvas:canvas_store", assetKey = "infinite-canvas:asset_store", imageKey = "infinite-canvas:image_draft", videoKey = "infinite-canvas:video_draft";
let serial = 0;
beforeEach(() => { serial = 0; });
function doc(key: string, value: unknown, namespace = "app_state", asString = true): TransferEntry {
  return { id: `entry-${++serial}`, namespace, key, revision: 4, assetId: null, deletedAt: null, value: { studioDocument: true, data: asString ? JSON.stringify(value) : value } };
}
function file(key: string, namespace = "image_files"): TransferEntry { return { id: `entry-${++serial}`, namespace, key, revision: 3, assetId: `asset-${serial}`, deletedAt: null, value: null }; }
function value(entry: { value: unknown }): Row {
  const data = (entry.value as Row).data; return (typeof data === "string" ? JSON.parse(data) : data) as Row;
}
function items(entry: { value: unknown }, field: string): Row[] { return ((value(entry).state as Row)[field]) as Row[]; }
function nativeNode(id: string, type = "text", metadata: Row = { content: "original text" }): Row { return { id, type, title: id, position: { x: 11, y: 17 }, width: 140, height: 90, metadata }; }
function canvas(id = "same-project"): Row {
  return { id, title: "image:original is ordinary title", createdAt: "old", updatedAt: "old", nodes: [nativeNode("same-node")], connections: [], chatSessions: [], activeChatId: null,
    viewport: { x: 137, y: 83, k: .65 }, backgroundMode: "lines", showImageInfo: true };
}
function canvases(projects: Row[], deletedProjects: Row[] = []): Row { return { version: 0, state: { projects, deletedProjects } }; }
function assets(list: Row[]): Row { return { version: 0, state: { assets: list } }; }
function draft(id = "same-draft"): Row { return { id, prompt: "same-node image:original", references: [], config: { model: "permitted-model-id", size: "1:1", quality: "auto", count: "1" } }; }
function drafts(list: Row[], activeId: string | null): Row { return { version: 1, drafts: list, activeId }; }
function frozen<T>(input: T): T { if (input && typeof input === "object") { Object.freeze(input); Object.values(input).forEach(frozen); } return input; }

describe("native Studio document transfer planning", () => {
  it("appends every tool into nonempty targets, preserves original target values and binds target CAS", () => {
    const source = [doc(canvasKey, canvases([canvas()])), doc(assetKey, assets([{ id: "same-asset", kind: "text", title: "Original prompt", tags: ["gift"], note: "keep note", source: "owned words", data: { content: "same-node image:original" } }])),
      doc(imageKey, drafts([draft()], "same-draft")), doc(videoKey, drafts([draft()], "same-draft")), doc("studio:prompts", [{ id: "legacy", content: "Exact original words" }])];
    const target = [doc(canvasKey, canvases([canvas()], [{ id: "target-deleted", deletedAt: "old" }]), "app_state", false), doc(assetKey, assets([{ id: "same-asset", kind: "text", data: { content: "Target text" } }])),
      doc(imageKey, drafts([draft()], "same-draft")), doc(videoKey, drafts([draft()], null)), doc("studio:prompts", { version: 1, items: [{ id: "legacy", content: "Target words" }] })];
    const before = structuredClone({ source, target }), plan = buildStudioDocumentPlan(frozen(source), frozen(target), identity);
    expect(plan.counts).toEqual({ canvases: 1, prompts: 2, assets: 1, imageDrafts: 1, videoDrafts: 1, history: 0, media: 0 });
    expect({ source, target }).toEqual(before);
    for (const write of plan.writes) expect(write).toMatchObject({ targetEntryId: target.find(row => row.key === write.key)!.id, targetRevision: 4, sourceEntryIds: [source.find(row => row.key === write.key)!.id] });
    const copiedCanvas = plan.writes.find(row => row.key === canvasKey)!;
    expect(typeof (copiedCanvas.value as Row).data).toBe("object");
    expect(items(copiedCanvas, "projects")[0]).toEqual(canvas());
    expect(items(copiedCanvas, "projects")[1]!.id).not.toBe("same-project");
    expect(((value(copiedCanvas).state as Row).deletedProjects)).toEqual([{ id: "target-deleted", deletedAt: "old" }]);
    expect((value(plan.writes.find(row => row.key === imageKey)!).activeId)).toBe("same-draft");
    expect((value(plan.writes.find(row => row.key === videoKey)!).activeId)).toBeNull();
    const copiedAsset = items(plan.writes.find(row => row.key === assetKey)!, "assets")[1]!;
    expect(copiedAsset).toMatchObject({ title: "Original prompt", tags: ["gift"], note: "keep note", source: "owned words", data: { content: "same-node image:original" } });
    expect((value(plan.writes.find(row => row.key === "studio:prompts")!).items as Row[])[0]).toEqual({ id: "legacy", content: "Target words" });
  });

  it("rewrites graph/group/variant/chat identities and complete media references while preserving prose and original bytes", () => {
    const p = canvas(); p.nodes = [nativeNode("group", "group", {}), nativeNode("image", "image", { storageKey: "image:original", content: "", status: "loading", groupId: "group", images: [{ id: "variant", storageKey: "image:original", content: "", status: "success", naturalWidth: 120, naturalHeight: 60, bytes: 10, mimeType: "image/png" }], primaryImageId: "variant", references: ["image:original", "video:original", "audio:original", png] }),
      nativeNode("video", "video", { storageKey: "video:original", content: "", videoTaskId: "provider-task-keep", status: "loading" }), nativeNode("audio", "audio", { storageKey: "audio:original", content: "" }),
      nativeNode("text", "text", { content: "image:original image group variant chat https://ordinary.example", texts: [{ id: "words", status: "success", content: "image:original" }], primaryTextId: "words" })];
    p.connections = [{ id: "edge", fromNodeId: "image", toNodeId: "text" }];
    p.chatSessions = [{ id: "chat", title: "Original chat", createdAt: "old", updatedAt: "old", messages: [{ id: "message", role: "user", text: "image and image:original stay words", references: [{ id: "image", type: "image", title: "Image", dataUrl: "", storageKey: "image:original" }, { id: "text", type: "text", title: "Text", text: "image:original" }] }] }]; p.activeChatId = "chat";
    const source = [doc(canvasKey, canvases([p], [{ id: "source-deleted", deletedAt: "old" }])), file("image:original"), file("video:original", "media_files"), file("audio:original", "media_files"), file("image:orphan")];
    const original = structuredClone(source), plan = buildStudioDocumentPlan(source, [], identity), project = items(plan.writes.find(row => row.key === canvasKey)!, "projects")[0]!;
    const nodes = project.nodes as Row[], image = nodes[1]!, imageMetadata = image.metadata as Row;
    expect(source).toEqual(original); expect(plan.mediaKeys).toHaveLength(4); expect(plan.counts.media).toBe(4);
    expect((project.connections as Row[])[0]).toMatchObject({ fromNodeId: image.id, toNodeId: nodes[4]!.id });
    expect(imageMetadata.groupId).toBe(nodes[0]!.id); expect(imageMetadata.primaryImageId).toBe((imageMetadata.images as Row[])[0]!.id);
    expect((imageMetadata.references as string[]).slice(0, 3).every(key => /^copy:[a-f0-9]{64}$/.test(key))).toBe(true);
    expect((imageMetadata.references as string[])[3]).toBe(png);
    expect((nodes[2]!.metadata as Row)).toMatchObject({ videoTaskId: "provider-task-keep", status: "loading" });
    expect((nodes[4]!.metadata as Row).content).toBe("image:original image group variant chat https://ordinary.example");
    const session = (project.chatSessions as Row[])[0]!, message = (session.messages as Row[])[0]!;
    expect(project.activeChatId).toBe(session.id); expect((message.references as Row[])[0]!.id).toBe(image.id); expect(message.text).toBe("image and image:original stay words");
    expect(project.viewport).toEqual(p.viewport); expect(project.backgroundMode).toBe("lines"); expect(project.showImageInfo).toBe(true);
    for (const node of nodes) expect(node._yummyaiOrigin).toEqual({ version: 1, sourceScope: identity.sourceScope, requestId: identity.requestId, executionFrozen: true });
    expect((value(plan.writes.find(row => row.key === canvasKey)!).state as Row).deletedProjects).toEqual([]);
    for (const entry of source.filter(row => row.assetId)) expect(plan.writes.find(row => row.assetId === entry.assetId)).toMatchObject({ value: null, assetId: entry.assetId, targetEntryId: null, targetRevision: 0, sourceEntryIds: [entry.id] });
  });

  it("copies pending native video and image logs as frozen history without changing provider facts or target logs", () => {
    const source = [file("image:original"), file("video:original", "media_files"), doc("same-log", { id: "same-log", status: "pending", prompt: "same-log image:original", references: [{ id: "reference", name: "Original", type: "image/png", dataUrl: "", storageKey: "image:original" }], task: { id: "remote-task", provider: "openai", status: "in_progress" }, video: { id: "result", url: "", storageKey: "video:original", mimeType: "video/mp4" } }, "video_generation_logs"),
      doc("same-log", { id: "same-log", status: "success", images: [{ id: "result", dataUrl: png, width: 1, height: 1 }] }, "image_generation_logs")];
    const target = [doc("same-log", { id: "same-log", status: "success", prompt: "Target untouched" }, "video_generation_logs")], before = structuredClone(target);
    const plan = buildStudioDocumentPlan(source, target, identity), logs = plan.writes.filter(row => row.namespace.endsWith("_generation_logs"));
    expect(plan.counts.history).toBe(2); expect(target).toEqual(before);
    for (const row of logs) { expect(row.key).toBe(value(row).id); expect(row.key).not.toBe("same-log"); expect(row.targetEntryId).toBeNull(); expect(value(row)._yummyaiOrigin).toMatchObject({ executionFrozen: true }); }
    expect(value(logs.find(row => row.namespace === "video_generation_logs")!)).toMatchObject({ status: "pending", task: { id: "remote-task", provider: "openai", status: "in_progress" }, prompt: "same-log image:original" });
    expect((value(logs.find(row => row.namespace === "image_generation_logs")!).images as Row[])[0]!.dataUrl).toBe(png);
  });

  it("restores draft choice only for an empty target and deterministically remaps typed draft references", () => {
    const imageDraft = draft(); imageDraft.references = [{ id: "asset-ui", name: "Exact image:original", type: "image/png", storageKey: "image:original", dataUrl: "blob:old-image-session" }]; imageDraft.projectId = "same-project"; imageDraft.promptId = "asset-ui";
    const source = [doc(canvasKey, canvases([canvas()])), doc(assetKey, assets([{ id: "asset-ui", kind: "text", data: { content: "Original" } }])), doc(imageKey, drafts([imageDraft], "same-draft")), file("image:original")];
    const plan = buildStudioDocumentPlan(source, [], identity), copy = value(plan.writes.find(row => row.key === imageKey)!), copied = (copy.drafts as Row[])[0]!;
    expect(copy.activeId).toBe(copied.id); expect(copied.projectId).toBe(items(plan.writes.find(row => row.key === canvasKey)!, "projects")[0]!.id);
    expect(copied.promptId).toBe(items(plan.writes.find(row => row.key === assetKey)!, "assets")[0]!.id);
    expect((copied.references as Row[])[0]).toMatchObject({ name: "Exact image:original", dataUrl: "" }); expect(copied.prompt).toBe("same-node image:original");
    expect(buildStudioDocumentPlan([...source].reverse(), [], identity)).toEqual(plan);
    expect(buildStudioDocumentPlan(source, [], { ...identity, requestId: "different-request" })).not.toEqual(plan);
  });

  it.each([{ label: "numeric count", config: { count: 2 } }, { label: "array", config: [] }, { label: "null", config: null }])("rejects non-native draft config $label without changing the source", ({ config }) => {
    for (const key of [imageKey, videoKey]) {
      const source = [doc(key, drafts([{ ...draft(), config }], "same-draft"))], before = structuredClone(source);
      expect(() => buildStudioDocumentPlan(frozen(source), [], identity)).toThrow("STUDIO_DOCUMENT_INVALID_WORKBENCH_DRAFT");
      expect(source).toEqual(before);
    }
  });

  it("preserves string-only native draft config and ordinary prompt text exactly", () => {
    const original = { ...draft(), prompt: "count:2 same-node image:original stay ordinary words", config: { model: "permitted-model-id", count: "2", videoSeconds: "12", videoGenerateAudio: "false" } };
    const source = [doc(imageKey, drafts([original], "same-draft")), doc(videoKey, drafts([original], "same-draft"))], before = structuredClone(source);
    const plan = buildStudioDocumentPlan(frozen(source), [], identity);
    for (const row of plan.writes) expect((value(row).drafts as Row[])[0]).toMatchObject({ prompt: original.prompt, config: original.config });
    expect(source).toEqual(before);
  });

  it("rewrites bare data/cover keys, hydrates stable-key display aliases, and keeps embedded legacy media exact", () => {
    const source = [file("image:original"), doc(assetKey, assets([{ id: "asset-ui", kind: "image", title: "image:original", coverUrl: "image:original", data: { dataUrl: "image:original", storageKey: "image:original", mimeType: "image/png", width: 9, height: 7, bytes: 10 } }, { id: "embedded", kind: "image", coverUrl: png, data: { dataUrl: png, width: 1, height: 1 } },
      { id: "alias", kind: "image", coverUrl: "blob:stale", data: { dataUrl: "blob:stale", storageKey: "image:original" } }]))];
    const plan = buildStudioDocumentPlan(source, [], identity), list = items(plan.writes.find(row => row.key === assetKey)!, "assets");
    expect(list[0]!.coverUrl).toMatch(/^copy:/); expect((list[0]!.data as Row).dataUrl).toBe(list[0]!.coverUrl); expect(list[0]!.title).toBe("image:original");
    expect(list[1]!.coverUrl).toBe(png); expect((list[1]!.data as Row).dataUrl).toBe(png); expect(list[2]!.coverUrl).toBe(""); expect((list[2]!.data as Row).dataUrl).toBe("");
  });

  it("walks typed media in nested chat detail, cover and data without replacing free prose", () => {
    const p = canvas(); p.chatSessions = [{ id: "chat", messages: [{ id: "message", role: "assistant", text: "same-node image:original",
      detail: { nodeId: "same-node", projectId: "same-project", text: "same-node image:original", images: [{ id: "detail-image", content: "image:original" }], cover: { data: "image:original" } } }] }];
    const source = [doc(canvasKey, canvases([p])), file("image:original")], plan = buildStudioDocumentPlan(source, [], identity);
    const copied = items(plan.writes.find(row => row.key === canvasKey)!, "projects")[0]!, detail = (((copied.chatSessions as Row[])[0]!.messages as Row[])[0]!.detail as Row);
    expect(detail.nodeId).toBe((copied.nodes as Row[])[0]!.id); expect(detail.projectId).toBe(copied.id); expect(detail.text).toBe("same-node image:original");
    expect((detail.images as Row[])[0]!.content).toMatch(/^copy:/); expect((detail.cover as Row).data).toBe((detail.images as Row[])[0]!.content);
    const broken = structuredClone(p); ((((broken.chatSessions as Row[])[0]!.messages as Row[])[0]!.detail as Row).cover as Row).data = "image:missing";
    expect(() => buildStudioDocumentPlan([doc(canvasKey, canvases([broken])), file("image:original")], [], identity)).toThrow("STUDIO_DOCUMENT_MISSING_MEDIA_REFERENCE");
  });

  it("can transfer an already copied document again with fresh IDs and media addresses but the same immutable assets", () => {
    const p = canvas(); p.nodes = [nativeNode("image", "image", { content: "image:original", storageKey: "image:original", images: [{ id: "variant", content: png }], primaryImageId: "variant", references: [png, "video:original"] }), nativeNode("words", "text", { content: "same-project image image:original are ordinary words", note: "Preserve exact metadata" })];
    p.connections = [{ id: "edge", fromNodeId: "image", toNodeId: "words" }];
    const workbench = draft(); workbench.references = [{ id: "asset-ui", name: "Original image", type: "image/png", dataUrl: "", storageKey: "image:original" }]; workbench.projectId = "same-project"; workbench.promptId = "asset-ui";
    const source = [doc(canvasKey, canvases([p])), doc(assetKey, assets([{ id: "asset-ui", kind: "image", data: { storageKey: "image:original", dataUrl: "image:original" } }])), doc(imageKey, drafts([workbench], "same-draft")), file("image:original"), file("video:original", "media_files"),
      doc("video-log", { id: "video-log", status: "pending", task: { id: "provider-original-task", status: "in_progress" }, video: { id: "video-result", url: "", storageKey: "video:original" } }, "video_generation_logs")];
    const first = buildStudioDocumentPlan(source, [], identity), before = structuredClone(first);
    const intermediate: TransferEntry[] = first.writes.map((row, index) => ({ id: `copied-entry-${index}`, namespace: row.namespace, key: row.key, revision: 1, value: row.value, assetId: row.assetId, deletedAt: null }));
    const again = { sourceScope: identity.targetScope, targetScope: "019f0000-0000-7000-8000-000000000002", requestId: "86cf4d41-62f9-4bd9-9dc6-e185ff274959" };
    const second = buildStudioDocumentPlan(frozen(intermediate), [], again), copied = items(second.writes.find(row => row.key === canvasKey)!, "projects")[0]!, firstProject = items(first.writes.find(row => row.key === canvasKey)!, "projects")[0]!;
    expect(first).toEqual(before); expect(second.counts).toEqual(first.counts);
    expect(second.mediaKeys).toEqual(intermediate.filter(row => row.assetId !== null).map(row => ({ namespace: row.namespace, key: row.key })).sort((a, b) => `${a.namespace}/${a.key}`.localeCompare(`${b.namespace}/${b.key}`)));
    for (const row of intermediate.filter(row => row.assetId !== null)) { const next = second.writes.find(write => write.assetId === row.assetId)!; expect(row.key).toMatch(/^copy:[a-f0-9]{64}$/); expect(next.key).toMatch(/^copy:[a-f0-9]{64}$/); expect(next.key).not.toBe(row.key); expect(next.value).toBeNull(); }
    const nodes = copied.nodes as Row[], metadata = nodes[0]!.metadata as Row, imageMedia = second.writes.find(row => row.assetId === source.find(row => row.key === "image:original")!.assetId)!;
    expect(copied.id).not.toBe(firstProject.id); expect(nodes[0]!.id).not.toBe((firstProject.nodes as Row[])[0]!.id);
    expect((copied.connections as Row[])[0]).toMatchObject({ fromNodeId: nodes[0]!.id, toNodeId: nodes[1]!.id }); expect(metadata.storageKey).toBe(imageMedia.key); expect(metadata.content).toBe(imageMedia.key);
    expect(metadata.primaryImageId).toBe((metadata.images as Row[])[0]!.id); expect((metadata.images as Row[])[0]!.content).toBe(png); expect((metadata.references as string[])[0]).toBe(png);
    expect(copied.viewport).toEqual(p.viewport); expect(copied.title).toBe(p.title); expect(nodes[1]!.metadata).toEqual((p.nodes as Row[])[1]!.metadata);
    expect(nodes[0]!._yummyaiOrigin).toEqual({ version: 1, sourceScope: again.sourceScope, requestId: again.requestId, executionFrozen: true });
    const copiedDrafts = value(second.writes.find(row => row.key === imageKey)!), copiedDraft = (copiedDrafts.drafts as Row[])[0]!;
    expect(copiedDrafts.activeId).toBe(copiedDraft.id); expect(copiedDraft.projectId).toBe(copied.id); expect(copiedDraft.promptId).toBe(items(second.writes.find(row => row.key === assetKey)!, "assets")[0]!.id); expect((copiedDraft.references as Row[])[0]!.storageKey).toBe(imageMedia.key);
    expect(value(second.writes.find(row => row.namespace === "video_generation_logs")!)).toMatchObject({ status: "pending", task: { id: "provider-original-task", status: "in_progress" } });
  });

  it("checks orphan media integrity and native namespace ambiguity, and rejects contradictory tombstones", () => {
    const orphan = file("image:orphan"); orphan.assetId = null;
    expect(() => buildStudioDocumentPlan([orphan], [], identity)).toThrow("STUDIO_DOCUMENT_INVALID_MEDIA_ENTRY");
    const p = canvas(); p.nodes = [nativeNode("video", "video", { content: png })];
    expect(() => buildStudioDocumentPlan([doc(canvasKey, canvases([p]))], [], identity)).toThrow("STUDIO_DOCUMENT_EMBEDDED_MEDIA_NAMESPACE_MISMATCH");
    expect(() => buildStudioDocumentPlan([doc(canvasKey, canvases([canvas()], [{ id: "same-project", deletedAt: "old" }]))], [], identity)).toThrow("STUDIO_DOCUMENT_CONTRADICTORY_PROJECT_TOMBSTONE");
  });

  it("excludes tombstones, configuration, execution records and all result intent keys without parsing them", () => {
    const removed = doc(canvasKey, { broken: true }); removed.deletedAt = new Date("2020-01-01");
    const source = [removed, doc("erp-result-v1:pending", { request: "must stay" }), doc("infinite-canvas:config_store", { apiKey: "must never copy" }), doc("job", { status: "running" }, "generations"), { ...file("erp-result-v1:other"), value: null }];
    const plan = buildStudioDocumentPlan(source, [], identity);
    expect(plan.writes).toEqual([]); expect(plan.mediaKeys).toEqual([]); expect(plan.excluded).toHaveLength(5); expect(new Set(plan.excluded).size).toBe(5);
  });

  it.each(["image:missing", "blob:unresolved", "https://unresolved.example/image.png", "file:///private.png", "data:image/png;base64,%%%"])("rejects unresolved or malformed media %s atomically", reference => {
    const p = canvas(); p.nodes = [nativeNode("image", "image", { content: reference, status: "success" })];
    expect(() => buildStudioDocumentPlan([doc(canvasKey, canvases([p]))], [], identity)).toThrow(/STUDIO_DOCUMENT_/);
  });

  it("rejects missing/deleted/ambiguous media, even in chat and unselected variants", () => {
    const missing = file("image:missing"); missing.deletedAt = new Date("2020-01-01");
    const p = canvas(); p.nodes = [nativeNode("image", "image", { images: [{ id: "variant", content: "", storageKey: "image:missing" }], primaryImageId: "variant" })];
    expect(() => buildStudioDocumentPlan([doc(canvasKey, canvases([p])), missing], [], identity)).toThrow("STUDIO_DOCUMENT_MISSING_MEDIA_REFERENCE");
    p.nodes = []; p.chatSessions = [{ id: "chat", messages: [{ id: "msg", text: "safe text", references: [{ id: "ref", type: "image", storageKey: "image:missing", dataUrl: "" }] }] }];
    expect(() => buildStudioDocumentPlan([doc(canvasKey, canvases([p]))], [], identity)).toThrow("STUDIO_DOCUMENT_MISSING_MEDIA_REFERENCE");
    const video = doc("log", { id: "log", status: "pending", references: ["shared"] }, "video_generation_logs");
    expect(() => buildStudioDocumentPlan([video, file("shared"), file("shared", "media_files")], [], identity)).toThrow("STUDIO_DOCUMENT_AMBIGUOUS_MEDIA_REFERENCE");
  });

  it("does not overwrite a deterministic media address, including a target tombstone", () => {
    const original = file("image:original"), mapped = buildStudioDocumentPlan([original], [], identity).writes[0]!;
    const target = { ...file(mapped.key), deletedAt: new Date("2020-01-01") };
    expect(() => buildStudioDocumentPlan([original], [target], identity)).toThrow("STUDIO_DOCUMENT_TARGET_MEDIA_COLLISION");
  });

  it("rejects dangling graph/selection IDs and unsupported node protocols", () => {
    for (const broken of [
      { ...canvas(), connections: [{ id: "edge", fromNodeId: "same-node", toNodeId: "missing" }] },
      { ...canvas(), activeChatId: "missing" },
      { ...canvas(), nodes: [nativeNode("same-node", "image", { primaryImageId: "missing", images: [] })] },
      { ...canvas(), nodes: [nativeNode("same-node", "text", { groupId: "missing" })] },
      { ...canvas(), nodes: [nativeNode("same-node", "unreviewed:plugin")] },
      { ...canvas(), viewport: { x: 0, y: 0, k: 0 } },
    ]) expect(() => buildStudioDocumentPlan([doc(canvasKey, canvases([broken]))], [], identity)).toThrow(/STUDIO_DOCUMENT_/);
    expect(() => buildStudioDocumentPlan([doc(imageKey, drafts([draft()], "missing"))], [], identity)).toThrow("STUDIO_DOCUMENT_DANGLING_ACTIVE_DRAFT");
  });

  it("rejects corrupted envelopes, unknown versions, opaque legacy prompts, duplicate IDs and credentials", () => {
    const badJson = doc(canvasKey, canvases([])); badJson.value = { studioDocument: true, data: "{not JSON" };
    const badEnvelope = doc(canvasKey, canvases([])); badEnvelope.value = canvases([]);
    for (const source of [[badJson], [badEnvelope], [doc(canvasKey, { version: 2, state: { projects: [], deletedProjects: [] } })], [doc("studio:prompts", { syntheticDraft: "untyped original retained" })],
      [doc(assetKey, assets([{ id: "dupe", kind: "text" }, { id: "dupe", kind: "text" }]))], [doc(imageKey, drafts([{ ...draft(), config: { apiKey: "secret" } }], "same-draft"))]]) {
      expect(() => buildStudioDocumentPlan(source, [], identity)).toThrow();
    }
  });

  it("reuses a deleted target entry's CAS history without applying source deletion markers", () => {
    const target = doc(canvasKey, canvases([canvas("removed-target")])); target.deletedAt = new Date("2020-01-01");
    const plan = buildStudioDocumentPlan([doc(canvasKey, canvases([canvas()], [{ id: "source-deleted", deletedAt: "old" }]))], [target], identity);
    expect(plan.writes[0]).toMatchObject({ targetEntryId: target.id, targetRevision: 4 });
    expect(items(plan.writes[0]!, "projects")).toHaveLength(1); expect((value(plan.writes[0]!).state as Row).deletedProjects).toEqual([]);
  });
});
