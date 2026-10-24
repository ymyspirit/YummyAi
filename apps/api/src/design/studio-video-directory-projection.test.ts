import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { StudioVideoDirectoryItemSchema } from "@yummyai/contracts/pod/studio-video-directory";
import { projectStudioVideoLog, studioVideoTaskId, type StudioVideoSourceEntry } from "./studio-video-directory-projection.js";

type Row = Record<string, unknown>;
const entryId = "019f0000-0000-7000-8000-000000000001", taskId = "019f0000-0000-7000-8000-000000000002";
const sourceScope = "019f0000-0000-7000-8000-000000000003", requestId = "86cf4d41-62f9-4bd9-9dc6-e185ff274958";
const png = "data:image/png;base64,aGVsbG8=", mp4 = "data:video/mp4;base64,aGVsbG8=";
const task = { id: taskId, provider: "openai", model: "route::video-model" };
const reference = { id: "reference-1", name: "Original image", type: "image/png", dataUrl: "", storageKey: "image:one" };
const video = { id: "video-1", storageKey: "video:one", url: "", width: 1280, height: 720, bytes: 30, durationMs: 1300, mimeType: "video/mp4" };
function log(extra: Row = {}): Row {
  return { id: "log-1", title: "原生视频任务", createdAt: 1_700_000_000_000, prompt: "Private original prompt", time: "2026/10/24 12:00", model: "route::video-model",
    config: { model: "route::video-model", videoModel: "route::video-model", size: "16:9", vquality: "720", videoSeconds: "4", videoGenerateAudio: "true", videoWatermark: "false", videoMode: "frames" },
    references: [reference], durationMs: 0, size: "16:9", resolution: "720", seconds: "4", status: "pending", task, ...extra };
}
function row(value: unknown = log()): StudioVideoSourceEntry { return { id: entryId, key: "log-1", revision: 4, value: { studioDocument: true, data: value }, assetId: null }; }
const tracked = (status: "queued" | "running" | "completed" | "failed" = "queued") => new Map([[taskId, { status }]]);
const empty = new Map<string, { status: "queued" | "running" | "completed" | "failed" }>();
const marker = () => ({ version: 1, sourceScope, requestId, executionFrozen: true });
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.freeze(value); Object.values(value).forEach(freeze); } return value; }

describe("native Studio video directory metadata projection", () => {
  it.each(["object", "string", "wrapped-object", "wrapped-string"])("reads the original owner's %s form without changing native state", form => {
    const original = log(), stored = form === "object" ? original : form === "string" ? JSON.stringify(original)
      : { studioDocument: true, data: form === "wrapped-string" ? JSON.stringify(original) : original };
    const source = { ...row(), value: stored }, before = structuredClone(source);
    const result = projectStudioVideoLog(freeze(source), tracked("running"));
    expect(result).toMatchObject({ entryId, key: "log-1", revision: 4, title: "原生视频任务", createdAt: 1_700_000_000_000,
      nativeStatus: "pending", origin: "original", task: "tracked", generationStatus: "running", diagnostics: [] });
    expect(studioVideoTaskId(stored)).toBe(taskId); expect(source).toEqual(before);
    expect(StudioVideoDirectoryItemSchema.parse(result)).toEqual(result);
  });
  it("preserves native and ERP states independently and never returns secret-bearing source fields", () => {
    const original = log({ status: "failed", error: "Internal provider response https://private.invalid/task", providerTaskId: "remote-private-id" });
    const result = projectStudioVideoLog(row(original), tracked("completed"));
    expect(result.nativeStatus).toBe("failed"); expect(result.generationStatus).toBe("completed"); expect(result.diagnostics).toEqual([]);
    const serialized = JSON.stringify(result);
    for (const hidden of ["prompt", "config", "providerTaskId", "remote-private-id", "private.invalid", "Internal provider", "route::video-model"]) expect(serialized).not.toContain(hidden);
    expect(Object.keys(result).sort()).toEqual(["entryId", "key", "revision", "valueSha256", "title", "createdAt", "nativeStatus", "origin", "task", "generationStatus", "diagnostics"].sort());
  });
  it.each(["queued", "running", "completed", "failed"] as const)("recognizes only the supplied owner-matched %s ERP metadata", status => {
    const result = projectStudioVideoLog(row(), tracked(status));
    expect(result).toMatchObject({ nativeStatus: "pending", task: "tracked", generationStatus: status, diagnostics: [] });
  });
  it("matches legal UUID letter case without rewriting the original source or its hash", () => {
    const source = row(log({ task: { ...task, id: taskId.toUpperCase() } })), before = structuredClone(source);
    expect(studioVideoTaskId(source.value)).toBe(taskId);
    const result = projectStudioVideoLog(freeze(source), tracked("running"));
    expect(result).toMatchObject({ task: "tracked", generationStatus: "running", nativeStatus: "pending", diagnostics: [] });
    expect(source).toEqual(before); expect(result.valueSha256).not.toBe(projectStudioVideoLog(row(), tracked("running")).valueSha256);
  });
  it("keeps successful media and a failed task without a task object as native terminal facts", () => {
    expect(projectStudioVideoLog(row(log({ status: "success", task: undefined, video })), empty)).toMatchObject({ nativeStatus: "success", task: "none", diagnostics: [] });
    expect(projectStudioVideoLog(row(log({ status: "failed", task: undefined, error: "Original failure" })), empty)).toMatchObject({ nativeStatus: "failed", task: "none", diagnostics: [] });
  });
  it.each([null, [], "{broken", "null", { studioDocument: false, data: log() }, { studioDocument: true },
    { studioDocument: true, data: "[1]" }, { studioDocument: true, data: "{broken" }, { studioDocument: true, data: log(), extra: "unsupported" },
    { studioDocument: true, data: { studioDocument: true, data: log() } }])("diagnoses a damaged source instead of manufacturing an empty or successful item (%#)", value => {
    const result = projectStudioVideoLog({ ...row(), value }, empty);
    expect(result).toMatchObject({ nativeStatus: "unknown", title: null, createdAt: null, diagnostics: ["invalid_document"] });
    expect(studioVideoTaskId(value)).toBeUndefined();
  });
  it("diagnoses a conflicting native id and an accidental binary association", () => {
    const source = { ...row(log({ id: "another-log" })), assetId: taskId }, result = projectStudioVideoLog(source, tracked());
    expect(result.diagnostics).toEqual(["invalid_document", "unexpected_asset"]); expect(result.title).toBeNull();
  });
  it.each([undefined, null, "completed", "queued", 1, ["pending"]])("retains an unknown native status explicitly (%#)", status => {
    expect(projectStudioVideoLog(row(log({ status })), tracked())).toMatchObject({ nativeStatus: "unknown", diagnostics: ["invalid_status"] });
  });
  it("distinguishes missing, malformed and untracked tasks without inventing task failure", () => {
    expect(projectStudioVideoLog(row(log({ task: undefined })), empty)).toMatchObject({ nativeStatus: "pending", task: "none", generationStatus: null, diagnostics: ["missing_task"] });
    for (const broken of [null, [], {}, { ...task, provider: "unknown" }, { ...task, provider: ["openai"] }, { ...task, model: "" }, { ...task, id: "" }]) {
      expect(projectStudioVideoLog(row(log({ task: broken })), empty)).toMatchObject({ task: "invalid", diagnostics: ["invalid_task"] });
      expect(studioVideoTaskId({ studioDocument: true, data: log({ task: broken }) })).toBeUndefined();
    }
    expect(projectStudioVideoLog(row(), empty)).toMatchObject({ task: "untracked", generationStatus: null, nativeStatus: "pending", diagnostics: ["untracked_task"] });
  });
  it.each(["provider-remote-id", "operations/remote-task", "86cf4d41-62f9-4bd9-9dc6-e185ff274958"])("classifies a legal native task id %s as untracked without querying it as an ERP id", id => {
    const source = row(log({ task: { ...task, id } }));
    expect(studioVideoTaskId(source.value)).toBeUndefined();
    expect(projectStudioVideoLog(source, empty)).toMatchObject({ task: "untracked", generationStatus: null, diagnostics: ["untracked_task"] });
  });
  it.each(["root", "metadata"])("retains valid %s frozen history and permits its original unmatched task without an untracked blocker", location => {
    const origin = marker(), source = row(log({ task: { ...task, id: "old-provider-task" }, ...(location === "root" ? { _yummyaiOrigin: origin } : { metadata: { _yummyaiOrigin: origin } }) }));
    expect(projectStudioVideoLog(freeze(source), empty)).toMatchObject({ nativeStatus: "pending", origin: "frozen", task: "untracked", generationStatus: null, diagnostics: [] });
  });
  it.each([null, {}, { ...marker(), version: 2 }, { ...marker(), executionFrozen: false }, { ...marker(), sourceScope: "arbitrary-scope" },
    { ...marker(), requestId: "bad-id" }, { ...marker(), extra: "unknown" }])("blocks malformed origin metadata (%#)", _yummyaiOrigin => {
    expect(projectStudioVideoLog(row(log({ _yummyaiOrigin })), tracked())).toMatchObject({ origin: "invalid", diagnostics: ["invalid_origin"] });
  });
  it("blocks conflicting nested origins and keeps malformed frozen task diagnostics", () => {
    expect(projectStudioVideoLog(row(log({ _yummyaiOrigin: marker(), metadata: { _yummyaiOrigin: { ...marker(), sourceScope: "unassigned" } } })), tracked()).diagnostics).toEqual(["invalid_origin"]);
    expect(projectStudioVideoLog(row(log({ _yummyaiOrigin: marker(), task: { id: "old" } })), empty)).toMatchObject({ origin: "frozen", task: "invalid", diagnostics: ["invalid_task"] });
    expect(projectStudioVideoLog(row(log({ _yummyaiOrigin: marker(), task: undefined })), empty).diagnostics).toEqual(["missing_task"]);
  });
  it("accepts legacy inline media locations without reading or returning their content", () => {
    const result = projectStudioVideoLog(row(log({ status: "success", references: [{ ...reference, storageKey: undefined, dataUrl: png }], video: { ...video, storageKey: undefined, url: mp4 } })), tracked());
    expect(result.diagnostics).toEqual([]); expect(JSON.stringify(result)).not.toContain("aGVsbG8");
  });
  it("blocks inline MIME disagreement and trailing junk without claiming to decode a media container", () => {
    expect(projectStudioVideoLog(row(log({ references: [{ ...reference, dataUrl: png, type: "image/jpeg" }] })), tracked()).diagnostics).toEqual(["invalid_references"]);
    expect(projectStudioVideoLog(row(log({ references: [{ ...reference, dataUrl: `${png}\n` }] })), tracked()).diagnostics).toEqual(["invalid_references"]);
    expect(projectStudioVideoLog(row(log({ status: "success", video: { ...video, url: mp4, mimeType: "video/webm" } })), tracked()).diagnostics).toEqual(["invalid_media"]);
  });
  it.each([undefined, null, {}, [null], [{ ...reference, dataUrl: "https://private.invalid/ref.png" }], [{ ...reference, storageKey: "../asset" }],
    [{ ...reference, type: "video/mp4" }], [{ ...reference, dataUrl: "data:image/png;base64,broken" }], Array.from({ length: 11 }, () => reference)])("blocks unverified reference shapes or locations (%#)", references => {
    expect(projectStudioVideoLog(row(log({ references })), tracked()).diagnostics).toEqual(["invalid_references"]);
  });
  it.each([undefined, null, {}, { ...video, url: "https://private.invalid/video.mp4" }, { ...video, storageKey: "../asset" }, { ...video, mimeType: "image/png" },
    { ...video, width: 0 }, { ...video, bytes: Number.NaN }, { ...video, bytes: 1.5 }])("blocks damaged successful result media (%#)", video => {
    expect(projectStudioVideoLog(row(log({ status: "success", video })), tracked()).diagnostics).toEqual(["invalid_media"]);
  });
  it("validates supplied media even while native status is pending or failed", () => {
    for (const status of ["pending", "failed"]) expect(projectStudioVideoLog(row(log({ status, video: {} })), tracked()).diagnostics).toEqual(["invalid_media"]);
  });
  it.each([null, [], { videoSeconds: 4 }, { token: "private-key" }])("blocks invalid or credential-bearing native configuration (%#)", config => {
    const result = projectStudioVideoLog(row(log({ config })), tracked());
    expect(result.diagnostics).toContain("invalid_document"); expect(result.title).toBeNull();
    expect(JSON.stringify(result)).not.toContain("private-key");
  });
  it("checks decoded string documents for credential fields identically to object documents", () => {
    const original = log({ apiKey: "unit-secret-only" });
    for (const value of [original, JSON.stringify(original), { studioDocument: true, data: original }, { studioDocument: true, data: JSON.stringify(original) }]) {
      const result = projectStudioVideoLog({ ...row(), value }, tracked());
      expect(result.diagnostics).toEqual(["invalid_document"]); expect(result.title).toBeNull(); expect(studioVideoTaskId(value)).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("unit-secret-only");
    }
  });
  it("sanitizes title controls, bounds Unicode safely and never echoes URLs or likely credentials", () => {
    expect(projectStudioVideoLog(row(log({ title: "  正常\u202e标题\n  行  " })), tracked()).title).toBe("正常 标题 行");
    const limited = projectStudioVideoLog(row(log({ title: "画".repeat(159) + "𝄞" })), tracked()).title!;
    expect(limited).toBe("画".repeat(159));
    for (const title of ["https://private.invalid/secret", "Bearer private", "api_key: private", "sk-1234567890", taskId, null, {}, ""]) expect(projectStudioVideoLog(row(log({ title })), tracked()).title).toBeNull();
    for (const createdAt of [Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_VALUE, -1, "2026-10-24", null]) expect(projectStudioVideoLog(row(log({ createdAt })), tracked()).createdAt).toBeNull();
  });
  it.each([{ title: {} }, { title: [{ child: "unusable React child" }] }, { title: 42 }, { createdAt: { valueOf: null, toString: null } },
    { createdAt: "2026-10-24" }, { createdAt: -1 }, { createdAt: Number.MAX_VALUE }, { durationMs: { valueOf: null, toString: null } },
    { durationMs: "1300" }, { durationMs: -1 }, { durationMs: Number.POSITIVE_INFINITY }])("blocks unusable native display or arithmetic values before opening (%#)", extra => {
    const result = projectStudioVideoLog(row(log(extra)), tracked());
    expect(result.diagnostics).toEqual(["invalid_document"]); expect(result.title).toBeNull(); expect(result.createdAt).toBeNull();
    expect(result.nativeStatus).toBe("pending");
  });
  it("preserves compatible legacy missing display fields without inventing timestamps or changing the source", () => {
    const legacy = log();
    for (const key of ["title", "createdAt", "durationMs", "prompt", "time", "model", "config", "size", "resolution", "seconds", "error"]) delete legacy[key];
    const source = row(legacy), before = structuredClone(source), result = projectStudioVideoLog(freeze(source), tracked());
    expect(result).toMatchObject({ nativeStatus: "pending", task: "tracked", title: null, createdAt: null, diagnostics: [] });
    expect(source).toEqual(before);
  });
  it("hashes the full original stored value deterministically without collapsing storage representations", () => {
    const original = log(), sorted = Object.fromEntries(Object.entries(original).reverse());
    const direct = projectStudioVideoLog({ ...row(), value: original }, tracked()), reordered = projectStudioVideoLog({ ...row(), value: sorted }, tracked());
    const wrapped = projectStudioVideoLog(row(original), tracked()), text = projectStudioVideoLog({ ...row(), value: JSON.stringify(original) }, tracked());
    expect(direct.valueSha256).toBe(reordered.valueSha256);
    expect(new Set([direct.valueSha256, wrapped.valueSha256, text.valueSha256]).size).toBe(3);
    expect(projectStudioVideoLog(row(log({ prompt: "Changed hidden source" })), tracked()).valueSha256).not.toBe(wrapped.valueSha256);
    expect(projectStudioVideoLog({ ...row(), value: null }, empty).valueSha256).toBe(createHash("sha256").update("null").digest("hex"));
  });
  it("keeps malformed item diagnostics distinct and does not leak source data through an invalid item", () => {
    const source = row(log({ status: "unknown", _yummyaiOrigin: false, task: null, references: null, video: {}, config: 1 }));
    source.assetId = taskId;
    const result = projectStudioVideoLog(source, empty);
    expect(result.diagnostics).toEqual(["unexpected_asset", "invalid_status", "invalid_origin", "invalid_references", "invalid_media", "invalid_document", "invalid_task"]);
    expect(result.nativeStatus).toBe("unknown"); expect(result.title).toBeNull();
  });
});
