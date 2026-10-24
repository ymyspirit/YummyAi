import { describe, expect, it } from "vitest";
import { StudioRpcSchema } from "./creative-studio.js";
import { StudioVideoDirectorySchema, StudioVideoPreflightSchema } from "./studio-video-directory.js";

const id = "019aaaab-0000-7000-8000-000000000001", hash = "a".repeat(64);
const item = { entryId: id, key: "native-video-one", revision: 3, valueSha256: hash, title: "原视频记录", createdAt: 1000,
  nativeStatus: "pending", origin: "original", task: "tracked", generationStatus: "queued", diagnostics: [] };
const directory = { version: 1, snapshotHash: hash, total: 1, items: [item] };
const admission = { version: 1, snapshotHash: hash, total: 1, canOpen: true, blockedEntryIds: [], mode: "view_only", execution: "paused" };

describe("complete native video inventory transport", () => {
  it("accepts only a complete bounded directory, including a genuinely empty directory", () => {
    expect(StudioVideoDirectorySchema.parse(directory).items[0]?.nativeStatus).toBe("pending");
    expect(StudioVideoDirectorySchema.parse({ ...directory, total: 0, items: [] }).total).toBe(0);
    expect(StudioVideoDirectorySchema.safeParse({ ...directory, total: 2 }).success).toBe(false);
    expect(StudioVideoDirectorySchema.safeParse({ ...directory, total: 0 }).success).toBe(false);
  });
  it("rejects duplicate identities and raw native or provider payloads", () => {
    expect(StudioVideoDirectorySchema.safeParse({ ...directory, total: 2, items: [item, item] }).success).toBe(false);
    for (const field of ["prompt", "config", "providerTaskId", "error"]) {
      expect(StudioVideoDirectorySchema.safeParse({ ...directory, items: [{ ...item, [field]: "private" }] }).success).toBe(false);
    }
  });
  it("keeps unknown and frozen history explicit instead of normalizing them to success", () => {
    const unknown = { ...item, nativeStatus: "unknown", origin: "invalid", task: "invalid", generationStatus: null, diagnostics: ["invalid_document"] };
    expect(StudioVideoDirectorySchema.parse({ ...directory, items: [unknown] }).items[0]?.nativeStatus).toBe("unknown");
    const frozen = { ...item, origin: "frozen", task: "untracked", generationStatus: null };
    expect(StudioVideoDirectorySchema.parse({ ...directory, items: [frozen] }).items[0]?.nativeStatus).toBe("pending");
    expect(StudioVideoDirectorySchema.safeParse({ ...directory, items: [{ ...item, nativeStatus: "done" }] }).success).toBe(false);
  });
  it("admits only explicit view-only paused operation with consistent blockers", () => {
    expect(StudioVideoPreflightSchema.parse(admission).execution).toBe("paused");
    expect(StudioVideoPreflightSchema.parse({ ...admission, canOpen: false, blockedEntryIds: [id] }).canOpen).toBe(false);
    for (const patch of [{ canOpen: true, blockedEntryIds: [id] }, { canOpen: false }, { execution: "enabled" },
      { mode: "resume" }, { total: 0, blockedEntryIds: [id], canOpen: false }, { blockedEntryIds: [id, id], canOpen: false }])
      expect(StudioVideoPreflightSchema.safeParse({ ...admission, ...patch }).success).toBe(false);
  });
  it("never accepts caller-selected owner or an unpinned preflight", () => {
    expect(StudioRpcSchema.parse({ operation: "video.directory", scope: "unassigned" }).operation).toBe("video.directory");
    expect(StudioRpcSchema.parse({ operation: "video.preflight", scope: "unassigned", snapshotHash: hash }).operation).toBe("video.preflight");
    for (const request of [{ operation: "video.directory", ownerId: id }, { operation: "video.directory", limit: 40 },
      { operation: "video.preflight" }, { operation: "video.preflight", snapshotHash: "old" },
      { operation: "video.preflight", snapshotHash: hash, resume: true }])
      expect(StudioRpcSchema.safeParse({ scope: "unassigned", ...request }).success).toBe(false);
  });
});
