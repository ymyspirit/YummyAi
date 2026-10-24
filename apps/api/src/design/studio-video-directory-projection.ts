import { createHash } from "node:crypto";
import { z } from "zod";
import { assertStudioDocument } from "@yummyai/contracts/pod/creative-studio";
import { StudioKeySchema, StudioScopeSchema } from "@yummyai/contracts/pod/studio-address";
import { StudioVideoDirectoryItemSchema, type StudioVideoDirectoryItem } from "@yummyai/contracts/pod/studio-video-directory";

export type StudioVideoSourceEntry = {
  id: string; key: string; revision: number; value: unknown; assetId: string | null;
};
type JsonObject = Record<string, unknown>;
type GenerationStatus = "queued" | "running" | "completed" | "failed";
type Diagnostic = StudioVideoDirectoryItem["diagnostics"][number];
const uuid7 = z.uuidv7();
const uuid = z.uuid();
const statuses: readonly GenerationStatus[] = ["queued", "running", "completed", "failed"];
const configKeys = new Set(["model", "videoModel", "size", "vquality", "videoSeconds", "videoGenerateAudio", "videoWatermark", "videoMode"]);
const has = (value: JsonObject, key: string) => Object.hasOwn(value, key);
const object = (value: unknown): value is JsonObject => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const controlCharacter = (value: string) => {
  const code = value.charCodeAt(0);
  return code <= 0x1f || code >= 0x7f && code <= 0x9f;
};
const identifier = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1000 && !Array.from(value).some(controlCharacter);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
function document(value: unknown): JsonObject | undefined {
  try {
    assertStudioDocument(value);
    const decoded: unknown = typeof value === "string" ? JSON.parse(value) : value;
    if (!object(decoded)) return;
    let log: unknown = decoded;
    if (has(decoded, "studioDocument")) {
      if (decoded.studioDocument !== true || !has(decoded, "data") || Object.keys(decoded).some(key => !["studioDocument", "data"].includes(key))) return;
      log = typeof decoded.data === "string" ? JSON.parse(decoded.data) : decoded.data;
    }
    if (!object(log) || has(log, "studioDocument")) return;
    assertStudioDocument(log);
    return log;
  } catch { return undefined; }
}
function nativeTask(value: unknown): value is JsonObject & { id: string; provider: string; model: string } {
  return object(value) && identifier(value.id) && typeof value.provider === "string" && ["openai", "gemini", "plugin"].includes(value.provider)
    && typeof value.model === "string" && value.model.trim().length > 0 && value.model.length <= 500;
}

/** Only an original ERP UUID can be used for the owner's metadata-only join. */
export function studioVideoTaskId(value: unknown): string | undefined {
  const log = document(value);
  return log && nativeTask(log.task) && uuid7.safeParse(log.task.id).success ? log.task.id.toLowerCase() : undefined;
}

function origin(log: JsonObject): StudioVideoDirectoryItem["origin"] {
  let current: JsonObject = log, found: string | undefined;
  for (let depth = 0; depth < 32; depth++) {
    if (has(current, "_yummyaiOrigin")) {
      const marker = current._yummyaiOrigin;
      if (!object(marker) || Object.keys(marker).some(key => !["version", "sourceScope", "requestId", "executionFrozen"].includes(key))
        || marker.version !== 1 || marker.executionFrozen !== true || !StudioScopeSchema.safeParse(marker.sourceScope).success || !uuid.safeParse(marker.requestId).success) return "invalid";
      const identity = canonical(marker);
      if (found !== undefined && found !== identity) return "invalid";
      found = identity;
    }
    if (!has(current, "metadata")) return found === undefined ? "original" : "frozen";
    if (!object(current.metadata)) return "invalid";
    current = current.metadata;
  }
  return "invalid";
}
function title(value: unknown, task: unknown): string | null {
  if (typeof value !== "string") return null;
  const clean = Array.from(value, character => controlCharacter(character) ? " " : character).join("").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean || /(?:https?|wss?|data|blob|file|ftp|javascript):|(?:api[_ -]?key|authorization|bearer|password|token|cookie|secret|providerTaskId)|\bsk-[a-z0-9_-]{8,}/iu.test(clean)
    || object(task) && typeof task.id === "string" && task.id.length > 0 && clean.includes(task.id)) return null;
  let limited = "";
  for (const character of clean) { if (limited.length + character.length > 160) break; limited += character; }
  return limited;
}
function inlineMedia(value: string, kind: "image" | "video", mediaType?: string): boolean {
  const match = /^data:((?:image|video)\/[a-z0-9.+-]+);base64,([a-z0-9+/]+={0,2})$/iu.exec(value);
  return !!match && match[0].length === value.length && match[1]!.toLowerCase().startsWith(`${kind}/`) && (!mediaType || match[1]!.toLowerCase() === mediaType.toLowerCase()) && match[2]!.length % 4 === 0
    && Buffer.from(match[2]!, "base64").toString("base64") === match[2];
}
function mediaLocation(value: unknown, storageKey: unknown, kind: "image" | "video", mediaType?: string): boolean {
  const stored = storageKey !== undefined && StudioKeySchema.safeParse(storageKey).success;
  if (storageKey !== undefined && !stored || typeof value !== "string") return false;
  return value === "" ? stored : inlineMedia(value, kind, mediaType);
}
function references(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 10 && value.every(item => object(item) && identifier(item.id) && typeof item.name === "string" && item.name.length <= 1000
    && typeof item.type === "string" && /^image\/[a-z0-9.+-]+$/iu.test(item.type) && mediaLocation(item.dataUrl, item.storageKey, "image", item.type)
    && (item.url === undefined || typeof item.url === "string" && (item.url === "" || inlineMedia(item.url, "image", item.type))));
}
function media(value: unknown): boolean {
  return object(value) && identifier(value.id) && typeof value.mimeType === "string" && mediaLocation(value.url, value.storageKey, "video", value.mimeType)
    && finite(value.durationMs) && finite(value.width) && value.width > 0 && finite(value.height) && value.height > 0
    && finite(value.bytes) && Number.isSafeInteger(value.bytes) && value.bytes > 0
    && typeof value.mimeType === "string" && ["video/mp4", "video/webm"].includes(value.mimeType);
}

/** Pure metadata projection. It never hydrates native UI or executes a task. */
export function projectStudioVideoLog(row: StudioVideoSourceEntry, tracked: ReadonlyMap<string, { status: GenerationStatus }>): StudioVideoDirectoryItem {
  const diagnostics: Diagnostic[] = [];
  const add = (code: Diagnostic) => { if (!diagnostics.includes(code)) diagnostics.push(code); };
  let valueSha256: string;
  try { valueSha256 = createHash("sha256").update(canonical(row.value)).digest("hex"); }
  catch { throw new Error("STUDIO_VIDEO_SOURCE_VALUE_INVALID"); }
  const result: StudioVideoDirectoryItem = { entryId: row.id, key: row.key, revision: row.revision, valueSha256,
    title: null, createdAt: null, nativeStatus: "unknown", origin: "invalid", task: "none", generationStatus: null, diagnostics };
  const log = document(row.value);
  if (!log || log.id !== row.key) add("invalid_document");
  if (row.assetId !== null) add("unexpected_asset");
  if (log) {
    result.title = title(log.title, log.task);
    result.createdAt = finite(log.createdAt) && log.createdAt <= 8_640_000_000_000_000 ? log.createdAt : null;
    if (typeof log.status === "string" && ["pending", "success", "failed"].includes(log.status)) result.nativeStatus = log.status as StudioVideoDirectoryItem["nativeStatus"];
    else add("invalid_status");
    result.origin = origin(log);
    if (result.origin === "invalid") add("invalid_origin");
    if (!references(log.references)) add("invalid_references");
    if (has(log, "video") && log.video !== undefined || result.nativeStatus === "success") {
      if (!media(log.video)) add("invalid_media");
    }
    if (has(log, "config") && (!object(log.config) || Object.entries(log.config).some(([key, item]) => !configKeys.has(key) || typeof item !== "string"))
      || ["title", "prompt", "model", "time", "size", "resolution", "seconds", "error"].some(key => has(log, key) && log[key] !== undefined && typeof log[key] !== "string")
      || ["createdAt", "durationMs"].some(key => has(log, key) && log[key] !== undefined && (!finite(log[key]) || key === "createdAt" && log[key] > 8_640_000_000_000_000))) add("invalid_document");
    if (log.task === undefined) {
      if (result.nativeStatus === "pending") add("missing_task");
    } else if (!nativeTask(log.task)) { result.task = "invalid"; add("invalid_task"); }
    else {
      const id = uuid7.safeParse(log.task.id).success ? log.task.id.toLowerCase() : undefined, match = id ? tracked.get(id) : undefined;
      result.task = match ? "tracked" : "untracked";
      if (match && statuses.includes(match.status)) result.generationStatus = match.status;
      else if (match) { result.task = "invalid"; add("invalid_task"); }
      else if (result.origin !== "frozen") add("untracked_task");
    }
  }
  if (diagnostics.includes("invalid_document")) { result.title = null; result.createdAt = null; }
  return StudioVideoDirectoryItemSchema.parse(result);
}
