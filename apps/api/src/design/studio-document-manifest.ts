import { createHash } from "node:crypto";
import { assertStudioDocument } from "@yummyai/contracts/pod/creative-studio";
import type { StudioTransferCounts } from "@yummyai/contracts/pod/studio-document-transfer";
import type { CanvasNodeData, CanvasConnection, CanvasAssistantSession } from "../../../../packages/canvas-runtime/vendor/src/types/canvas.js";

export type TransferEntry = { id: string; namespace: string; key: string; revision: number; value: unknown; assetId: string | null; deletedAt: Date | null };
type JsonObject = Record<string, unknown>;
type Namespace = "image_files" | "media_files";
type Write = { namespace: string; key: string; value: unknown; assetId: string | null; targetEntryId: string | null; targetRevision: number; sourceEntryIds: string[] };
export type StudioDocumentPlan = { writes: Write[]; counts: StudioTransferCounts; excluded: string[]; mediaKeys: Array<{ namespace: Namespace; key: string }> };
type NativeProject = { id: string; nodes: CanvasNodeData[]; connections: CanvasConnection[]; chatSessions: CanvasAssistantSession[]; activeChatId: string | null };
const canvasKey = "infinite-canvas:canvas_store", assetKey = "infinite-canvas:asset_store";
const imageKey = "infinite-canvas:image_draft", videoKey = "infinite-canvas:video_draft";
const editable = new Set([canvasKey, assetKey, imageKey, videoKey, "studio:prompts"]);
const nodeTypes = new Set(["image", "video", "audio", "text", "config", "group"]);
const mediaFields = new Set(["url", "dataUrl", "cover", "coverUrl", "previewUrl", "thumbnailUrl", "src"]);
function fail(code: string): never { throw new Error(`STUDIO_DOCUMENT_${code}`); }
function object(value: unknown): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_OBJECT"); return value as JsonObject; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) fail("INVALID_ARRAY"); return value; }
function text(value: unknown): string { if (typeof value !== "string" || !value || value.length > 1000) fail("INVALID_ID"); return value; }
function unique(items: unknown[]): JsonObject[] {
  const ids = new Set<string>(); return items.map(item => { const row = object(item), id = text(row.id); if (ids.has(id)) fail("DUPLICATE_ID"); ids.add(id); return row; });
}
function json(value: unknown, depth = 0): void {
  if (depth > 64) fail("DOCUMENT_DEPTH");
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) json(item, depth + 1); return; }
  if (!value || typeof value !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("NON_JSON_DOCUMENT");
  for (const item of Object.values(value as JsonObject)) json(item, depth + 1);
}
function clone<T>(value: T): T { json(value); return JSON.parse(JSON.stringify(value)) as T; }
function document(entry: TransferEntry): unknown {
  json(entry.value); const envelope = object(entry.value);
  if (envelope.studioDocument !== true || !Object.hasOwn(envelope, "data") || entry.assetId !== null) fail("INVALID_ENVELOPE");
  let value = envelope.data;
  if (typeof value === "string") { try { value = JSON.parse(value) as unknown; } catch { fail("INVALID_JSON_DOCUMENT"); } }
  json(value); assertStudioDocument(value); return clone(value);
}
function stored(entry: TransferEntry, value: unknown): unknown {
  assertStudioDocument(value); const envelope = object(entry.value);
  return { ...clone(envelope), data: typeof envelope.data === "string" ? JSON.stringify(value) : value };
}
function zustand(value: unknown, collection: "projects" | "assets"): { root: JsonObject; state: JsonObject; items: JsonObject[] } {
  const root = object(value); if (root.version !== 0) fail("UNSUPPORTED_STORE_VERSION");
  const state = object(root.state), allowed = collection === "projects" ? ["projects", "deletedProjects"] : ["assets"];
  if (Object.keys(state).some(key => !allowed.includes(key)) || Object.keys(root).some(key => !["version", "state", "_yummyaiOrigin"].includes(key))) fail("UNKNOWN_STORE_FIELDS");
  const items = unique(array(state[collection]));
  if (collection === "projects") {
    const removed = unique(array(state.deletedProjects));
    if (removed.some(row => items.some(item => item.id === row.id))) fail("CONTRADICTORY_PROJECT_TOMBSTONE");
  }
  return { root, state, items };
}
function promptList(value: unknown): { items: JsonObject[]; wrap: (items: JsonObject[]) => unknown } {
  const items = Array.isArray(value) ? value : object(value).version === 1 ? array(object(value).items) : fail("UNSUPPORTED_LEGACY_PROMPTS");
  const rows = unique(items);
  if (rows.some(row => ![row.content, row.text, row.prompt].some(value => typeof value === "string"))) fail("UNSUPPORTED_LEGACY_PROMPTS");
  return { items: rows, wrap: next => Array.isArray(value) ? next : { ...object(value), items: next } };
}
function drafts(value: unknown): { root: JsonObject; items: JsonObject[] } {
  const root = object(value); if (root.version !== 1 || Object.keys(root).some(key => !["version", "drafts", "activeId"].includes(key))) fail("UNSUPPORTED_DRAFT_VERSION");
  const items = unique(array(root.drafts));
  if (root.activeId !== null && !items.some(item => item.id === root.activeId)) fail("DANGLING_ACTIVE_DRAFT");
  for (const item of items) {
    if (typeof item.prompt !== "string" || !Array.isArray(item.references) || !item.config || typeof item.config !== "object" || Array.isArray(item.config)
      || Object.values(item.config).some(value => typeof value !== "string")) fail("INVALID_WORKBENCH_DRAFT");
  }
  return { root, items };
}

/** Native editor plans only; authority, immutable asset pins and scope locks belong to the owner. */
export function buildStudioDocumentPlan(source: TransferEntry[], target: TransferEntry[], identity: { sourceScope: string; targetScope: string; requestId: string }): StudioDocumentPlan {
  if (!identity.sourceScope || !identity.targetScope || !identity.requestId || identity.sourceScope === identity.targetScope) fail("INVALID_IDENTITY");
  if (source.length > 10_000 || target.length > 10_000) fail("ENTRY_LIMIT");
  const sourceRows = new Map<string, TransferEntry>(), targetRows = new Map<string, TransferEntry>(), ids = new Set<string>();
  const address = (entry: Pick<TransferEntry, "namespace" | "key">) => `${entry.namespace}/${entry.key}`;
  for (const [entries, index] of [[source, sourceRows], [target, targetRows]] as const) {
    for (const entry of entries) {
      if (!entry.id || !entry.key || !entry.namespace || !Number.isSafeInteger(entry.revision) || entry.revision < 1 || index.has(address(entry)) || ids.has(entry.id)) fail("INVALID_ENTRY");
      if (entry.deletedAt !== null && (!(entry.deletedAt instanceof Date) || !Number.isFinite(entry.deletedAt.getTime()))) fail("INVALID_TOMBSTONE");
      index.set(address(entry), entry); ids.add(entry.id);
    }
  }
  const result: StudioDocumentPlan = { writes: [], counts: { canvases: 0, prompts: 0, assets: 0, imageDrafts: 0, videoDrafts: 0, history: 0, media: 0 }, excluded: [], mediaKeys: [] };
  const origin = { version: 1, sourceScope: identity.sourceScope, requestId: identity.requestId, executionFrozen: true };
  const digest = (kind: string, ...parts: string[]) => createHash("sha256").update(JSON.stringify([identity.sourceScope, identity.targetScope, identity.requestId, kind, ...parts])).digest("hex");
  const reserved = new Set<string>(), mapped = new Map<string, string>();
  function reserve(value: unknown) {
    if (Array.isArray(value)) { value.forEach(reserve); return; }
    if (value && typeof value === "object") { const row = object(value); if (typeof row.id === "string") reserved.add(row.id); Object.values(row).forEach(reserve); }
  }
  // Reserve target tombstones too: copied IDs cannot resurrect a deleted target object.
  for (const entry of target) if (entry.namespace === "app_state" && editable.has(entry.key) && entry.deletedAt === null || ["image_generation_logs", "video_generation_logs"].includes(entry.namespace) && entry.deletedAt === null) reserve(document(entry));
  function newId(kind: string, owner: string, id: unknown): string {
    const original = text(id), at = JSON.stringify([kind, owner, original]);
    const old = mapped.get(at); if (old) return old;
    const next = "copy-" + digest(kind, owner, original); if (reserved.has(next)) fail("TARGET_ID_COLLISION");
    reserved.add(next); mapped.set(at, next); return next;
  }
  const media = new Map<string, { entry: TransferEntry; namespace: Namespace; key: string }>();
  for (const entry of [...source].sort((a, b) => address(a).localeCompare(address(b)))) {
    if (entry.deletedAt !== null) { result.excluded.push(address(entry)); continue; }
    if (entry.key.startsWith("erp-result-v1:")) continue;
    if (!["image_files", "media_files"].includes(entry.namespace)) continue;
    if (!entry.assetId || entry.value !== null) fail("INVALID_MEDIA_ENTRY");
    const namespace = entry.namespace as Namespace, key = "copy:" + digest("media", namespace, entry.key);
    if (targetRows.has(`${namespace}/${key}`)) fail("TARGET_MEDIA_COLLISION");
    media.set(address(entry), { entry, namespace, key }); result.mediaKeys.push({ namespace, key: entry.key });
  }
  function resource(key: string, namespace?: Namespace) {
    let choices = namespace ? [media.get(`${namespace}/${key}`)].filter(Boolean) : [...media.values()].filter(item => item.entry.key === key);
    // A native object can be visited at its variant and enclosing graph levels.
    if (!choices.length) choices = [...media.values()].filter(item => item.key === key && (!namespace || item.namespace === namespace));
    if (choices.length !== 1) fail(choices.length ? "AMBIGUOUS_MEDIA_REFERENCE" : "MISSING_MEDIA_REFERENCE");
    return choices[0]!;
  }
  function dataUri(value: string, namespace?: Namespace): string {
    const match = /^data:((?:image\/(?:png|jpeg|webp)|video\/(?:mp4|webm)|audio\/(?:mpeg|wav)));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || match[2]!.length > 28_000_000) fail("INVALID_EMBEDDED_MEDIA");
    if (namespace && (namespace === "image_files") !== match[1]!.startsWith("image/")) fail("EMBEDDED_MEDIA_NAMESPACE_MISMATCH");
    const bytes = Buffer.from(match[2]!, "base64"); if (!bytes.length || bytes.length > 20 * 1024 * 1024 || bytes.toString("base64") !== match[2]) fail("INVALID_EMBEDDED_MEDIA");
    return value;
  }
  function mediaValue(value: unknown, namespace?: Namespace, resolved = false): unknown {
    if (typeof value !== "string") fail("INVALID_MEDIA_REFERENCE");
    if (value === "") return value;
    if (value.startsWith("data:")) return dataUri(value, namespace);
    if (/^(?:blob:|https?:\/\/)/i.test(value)) { if (resolved) return ""; fail("UNRESOLVED_MEDIA_URL"); }
    return resource(value, namespace).key;
  }
  function namespaceFor(row: JsonObject, fallback?: Namespace): Namespace | undefined {
    const mime = row.mimeType ?? row.type;
    return typeof mime === "string" && /^(video|audio)\//.test(mime) || ["video", "audio"].includes(String(row.kind)) ? "media_files"
      : typeof mime === "string" && mime.startsWith("image/") || row.kind === "image" ? "image_files" : fallback;
  }
  function mediaObject(value: unknown, fallback?: Namespace, mediaContent = false): unknown {
    if (Array.isArray(value)) return value.map(item => mediaObject(item, fallback));
    if (!value || typeof value !== "object") return value;
    const row = object(value), namespace = namespaceFor(row, fallback), key = row.storageKey;
    mediaContent ||= ["image", "video", "audio"].includes(String(row.kind));
    const file = key === undefined ? undefined : resource(text(key), namespace);
    const output: JsonObject = {};
    for (const [field, item] of Object.entries(row)) {
      if (field === "storageKey") { output[field] = file!.key; continue; }
      if (field === "references") {
        output[field] = array(item).map(ref => typeof ref === "string" ? mediaValue(ref) : mediaObject(ref, "image_files", true)); continue;
      }
      if (field === "images") { output[field] = array(item).map(image => mediaObject(image, "image_files", true)); continue; }
      if (["video", "audio", "cover"].includes(field) && item && typeof item === "object") { output[field] = mediaObject(item, field === "cover" ? "image_files" : "media_files", true); continue; }
      if (mediaFields.has(field) && typeof item === "string" || mediaContent && ["content", "data"].includes(field) && typeof item === "string") {
        const cover = ["cover", "coverUrl", "thumbnailUrl", "previewUrl"].includes(field);
        const resolved = Boolean(file && (!cover || item === row.url || item === row.dataUrl || item === row.content));
        output[field] = mediaValue(item, namespace, resolved); continue;
      }
      output[field] = mediaObject(item, namespace, mediaContent && field === "data");
    }
    return output;
  }
  const projectIds = new Map<string, string>(), assetIds = new Map<string, string>(), promptIds = new Map<string, string>();
  const sourceCanvas = sourceRows.get(`app_state/${canvasKey}`), sourceAssets = sourceRows.get(`app_state/${assetKey}`), sourcePrompts = sourceRows.get("app_state/studio:prompts");
  const live = (entry: TransferEntry | undefined): entry is TransferEntry => Boolean(entry && entry.deletedAt === null);
  if (live(sourceCanvas)) for (const project of zustand(document(sourceCanvas), "projects").items) projectIds.set(text(project.id), newId("project", "", project.id));
  if (live(sourceAssets)) for (const asset of zustand(document(sourceAssets), "assets").items) assetIds.set(text(asset.id), newId("asset", "", asset.id));
  if (live(sourcePrompts)) for (const prompt of promptList(document(sourcePrompts)).items) promptIds.set(text(prompt.id), newId("prompt", "", prompt.id));
  function references(value: unknown, owner: string, nodes?: Map<string, string>): JsonObject[] {
    return unique(array(value)).map((row, index) => ({ ...object(mediaObject(row, namespaceFor(row, "image_files"), ["image", "video", "audio"].includes(String(row.type)))),
      id: nodes?.get(text(row.id)) ?? assetIds.get(text(row.id)) ?? newId("reference", `${owner}:${index}`, row.id) }));
  }
  function project(value: JsonObject): JsonObject {
    const native = value as unknown as NativeProject, owner = text(native.id), nodes = unique(array(native.nodes)), nodeIds = new Map<string, string>();
    const viewport = object(value.viewport);
    if (typeof value.title !== "string" || ![viewport.x, viewport.y, viewport.k].every(item => typeof item === "number" && Number.isFinite(item)) || Number(viewport.k) <= 0) fail("INVALID_CANVAS_VIEWPORT");
    for (const node of nodes) {
      if (!nodeTypes.has(String(node.type))) fail("UNSUPPORTED_NODE_TYPE");
      const position = object(node.position);
      if (typeof node.title !== "string" || ![position.x, position.y, node.width, node.height].every(item => typeof item === "number" && Number.isFinite(item)) || Number(node.width) < 0 || Number(node.height) < 0) fail("INVALID_NODE_GEOMETRY");
      nodeIds.set(text(node.id), newId("node", owner, node.id));
    }
    const resolveNode = (id: unknown) => nodeIds.get(text(id)) ?? fail("DANGLING_NODE_REFERENCE");
    function typedReferences(value: unknown): unknown {
      if (Array.isArray(value)) return value.map(typedReferences);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(object(value)).map(([key, item]) => {
        if (["nodeId", "fromNodeId", "toNodeId", "sourceNodeId", "groupId"].includes(key) && item !== null) {
          const id = text(item); return [key, nodeIds.get(id) ?? ([...nodeIds.values()].includes(id) ? id : fail("DANGLING_NODE_REFERENCE"))];
        }
        if (["canvasId", "projectId"].includes(key) && item !== null) {
          const id = text(item); return [key, projectIds.get(id) ?? ([...projectIds.values()].includes(id) ? id : fail("DANGLING_PROJECT_REFERENCE"))];
        }
        return [key, typedReferences(item)];
      }));
    }
    const nextNodes = nodes.map(node => {
      const metadata = node.metadata === undefined ? undefined : object(clone(node.metadata)), nodeOwner = `${owner}:${text(node.id)}`;
      if (metadata) {
        if (metadata.groupId !== undefined) { const group = nodes.find(candidate => candidate.id === metadata.groupId); if (group?.type !== "group") fail("DANGLING_GROUP"); metadata.groupId = resolveNode(metadata.groupId); }
        for (const [field, primary, kind] of [["images", "primaryImageId", "image"], ["texts", "primaryTextId", "text"]] as const) {
          const variants = metadata[field] === undefined ? [] : unique(array(metadata[field]));
          const variantIds = new Map(variants.map(row => [text(row.id), newId(kind, nodeOwner, row.id)]));
          if (metadata[primary] !== undefined) metadata[primary] = variantIds.get(text(metadata[primary])) ?? fail("DANGLING_PRIMARY_VARIANT");
          if (metadata[field] !== undefined) metadata[field] = variants.map(row => ({ ...object(mediaObject(row, kind === "image" ? "image_files" : undefined, kind === "image")), id: variantIds.get(text(row.id))! }));
        }
      }
      return { ...node, id: resolveNode(node.id), ...(metadata ? { metadata: mediaObject(metadata, node.type === "image" ? "image_files" : ["audio", "video"].includes(String(node.type)) ? "media_files" : undefined, ["image", "video", "audio"].includes(String(node.type))) } : {}), _yummyaiOrigin: { ...origin } };
    });
    const connections = unique(array(native.connections)).map(row => ({ ...row, id: newId("connection", owner, row.id), fromNodeId: resolveNode(row.fromNodeId), toNodeId: resolveNode(row.toNodeId) }));
    const sessions = unique(array(native.chatSessions)), sessionIds = new Map(sessions.map(row => [text(row.id), newId("session", owner, row.id)]));
    const chatSessions = sessions.map(session => ({ ...session, id: sessionIds.get(text(session.id)), messages: unique(array(session.messages)).map(message => ({ ...object(mediaObject(message)),
      id: newId("message", `${owner}:${text(session.id)}`, message.id), ...(message.references === undefined ? {} : { references: references(message.references, `${owner}:${text(session.id)}:${text(message.id)}`, nodeIds) }) })) }));
    const activeChatId = native.activeChatId === null ? null : sessionIds.get(text(native.activeChatId)) ?? fail("DANGLING_ACTIVE_CHAT");
    return object(typedReferences({ ...clone(value), id: projectIds.get(owner), nodes: nextNodes, connections, chatSessions, activeChatId, _yummyaiOrigin: { ...origin } }));
  }
  function targetDocument(entry: TransferEntry | undefined) { return live(entry) ? document(entry) : undefined; }
  function write(entry: TransferEntry, value: unknown, key = entry.key, assetId: string | null = null) {
    const existing = targetRows.get(`${entry.namespace}/${key}`);
    result.writes.push({ namespace: entry.namespace, key, value, assetId, targetEntryId: existing?.id ?? null, targetRevision: existing?.revision ?? 0, sourceEntryIds: [entry.id] });
  }
  for (const entry of [...source].sort((a, b) => address(a).localeCompare(address(b)))) {
    if (!live(entry)) continue;
    if (media.has(address(entry))) { const file = media.get(address(entry))!; write(entry, null, file.key, entry.assetId); result.counts.media++; continue; }
    if (entry.key.startsWith("erp-result-v1:") || entry.namespace === "app_state" && !editable.has(entry.key) || !["app_state", "image_generation_logs", "video_generation_logs"].includes(entry.namespace)) { result.excluded.push(address(entry)); continue; }
    const sourceValue = document(entry), existing = targetRows.get(address(entry)), targetValue = targetDocument(existing), basis = live(existing) ? existing : entry;
    if (entry.namespace.endsWith("_generation_logs")) {
      const log = object(sourceValue); if (text(log.id) !== entry.key || typeof log.status !== "string") fail("INVALID_HISTORY");
      const id = newId("log", entry.namespace, log.id), next = object(mediaObject(log)); next.id = id; next._yummyaiOrigin = { ...origin };
      if (log.references !== undefined) next.references = references(log.references, `${entry.namespace}:${entry.key}`);
      if (log.images !== undefined) next.images = unique(array(log.images)).map(image => ({ ...object(mediaObject(image, "image_files", true)), id: newId("log-image", entry.key, image.id) }));
      if (log.video !== undefined) { const video = object(log.video); next.video = { ...object(mediaObject(video, "media_files", true)), id: newId("log-video", entry.key, video.id) }; }
      if (targetRows.has(`${entry.namespace}/${id}`)) fail("TARGET_HISTORY_COLLISION");
      write(entry, stored(entry, next), id); result.counts.history++; continue;
    }
    let next: unknown;
    if (entry.key === canvasKey || entry.key === assetKey) {
      const field = entry.key === canvasKey ? "projects" : "assets", from = zustand(sourceValue, field), to = targetValue === undefined ? undefined : zustand(targetValue, field);
      const appended = from.items.map(item => {
        if (field === "projects") return project(item);
        if (!["image", "video", "text"].includes(String(item.kind))) fail("UNSUPPORTED_ASSET_KIND");
        if (item.kind === "text") { result.counts.prompts++; if (typeof object(item.data).content !== "string") fail("INVALID_TEXT_ASSET"); }
        const data = item.kind === "text" ? clone(item.data) : mediaObject(item.data, item.kind === "image" ? "image_files" : "media_files", true);
        const rawData = object(item.data);
        const ownCover = typeof rawData.storageKey === "string" && (item.coverUrl === rawData.dataUrl || item.coverUrl === rawData.url);
        const coverUrl = ownCover && typeof item.coverUrl === "string" && /^(?:blob:|https?:\/\/)/i.test(item.coverUrl) ? "" : item.coverUrl;
        const output = object(mediaObject({ ...item, ...(item.coverUrl === undefined ? {} : { coverUrl }), data }, undefined)); output.data = data; output.id = assetIds.get(text(item.id)); return output;
      });
      next = { ...clone(to?.root ?? from.root), state: { ...clone(to?.state ?? from.state), [field]: [...(to?.items ?? []), ...appended],
        ...(field === "projects" ? { deletedProjects: clone(to?.state.deletedProjects ?? []) } : {}) } };
      if (field === "projects") result.counts.canvases += appended.length; else result.counts.assets += appended.length;
    } else if (entry.key === "studio:prompts") {
      const from = promptList(sourceValue), to = targetValue === undefined ? undefined : promptList(targetValue);
      next = (to ?? from).wrap([...(to?.items ?? []), ...from.items.map(prompt => ({ ...prompt, id: promptIds.get(text(prompt.id))! }))]); result.counts.prompts += from.items.length;
    } else {
      const from = drafts(sourceValue), to = targetValue === undefined ? undefined : drafts(targetValue), kind = entry.key === imageKey ? "image" : "video";
      const appended = from.items.map(draft => {
        const next = object(mediaObject(draft));
        for (const field of ["canvasId", "projectId"]) if (draft[field] !== undefined) next[field] = projectIds.get(text(draft[field])) ?? fail("DANGLING_PROJECT_REFERENCE");
        if (draft.promptId !== undefined) next.promptId = assetIds.get(text(draft.promptId)) ?? promptIds.get(text(draft.promptId)) ?? fail("DANGLING_PROMPT_REFERENCE");
        return { ...next, id: newId(`${kind}-draft`, "", draft.id), references: references(draft.references, `${kind}:${text(draft.id)}`), _yummyaiOrigin: { ...origin } };
      });
      next = { ...clone(to?.root ?? from.root), drafts: [...(to?.items ?? []), ...appended], activeId: to ? to.root.activeId : from.root.activeId === null ? null : newId(`${kind}-draft`, "", from.root.activeId) };
      result.counts[kind === "image" ? "imageDrafts" : "videoDrafts"] += appended.length;
    }
    write(entry, stored(basis, next));
  }
  result.excluded.sort();
  return result;
}
