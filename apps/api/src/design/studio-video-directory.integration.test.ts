import { HttpException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStudioVideoDirectoryFixture, frozenVideoLog, nativeVideoLog } from "./studio-video-directory.test-fixture.js";
import { studioPersonalAuthority } from "./creative-studio-personal.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createStudioVideoDirectoryFixture>>;
let f: Fixture;
const outcome = (pending: Promise<unknown>) => pending.then(() => ({ status: 200, code: null as unknown }), error => {
  const raw = error instanceof HttpException ? error.getResponse() : null;
  return { status: error instanceof HttpException ? error.getStatus() : null, code: raw && typeof raw === "object" && "code" in raw ? raw.code : null };
});
async function basis() { const actor = await f.actor(), context = await f.current(actor); return { actor, context, scope: (await f.project(context)).id }; }
function noEffects(before: Awaited<ReturnType<Fixture["facts"]>>, after: Awaited<ReturnType<Fixture["facts"]>>) {
  expect(after.tables).toEqual(before.tables); expect(after.videoCalls).toEqual(before.videoCalls);
  expect(after.videoCalls).toEqual({ get: 0, create: 0, bridge: 0 });
  for (const name of ["storageReads", "storageWrites", "scans", "generationCalls", "dispatchAttempts"] as const) expect(after.counts[name]).toBe(before.counts[name]);
  expect(after.role).toBe("yummyai_app"); expect(after.providerCalls).toBe(0); expect(after.workerProcesses).toBe(0);
}
describe("b6e9a3f2 safe complete native video directory in disposable current188", () => {
  beforeAll(async () => { f = await createStudioVideoDirectoryFixture(); });
  afterAll(async () => { await f?.close(); });

  it("returns every native log past forty including the unsafe tail with exact revision facts and no private task content", async () => {
    const { context, scope } = await basis();
    const rows = Array.from({ length: 44 }, (_, index) => { const key = "complete-" + String(index).padStart(3, "0"); return { key, value: nativeVideoLog(key) }; });
    rows.push({ key: "complete-zzz-unsafe", value: nativeVideoLog("complete-zzz-unsafe", "pending") });
    const admitted = await f.rawLogs(context, scope, rows), before = await f.facts(context);
    const directory = await f.directory(context, scope); expect(directory.total).toBe(45); expect(directory.items).toHaveLength(45);
    expect(new Set(directory.items.map(item => item.key))).toEqual(new Set(rows.map(row => row.key)));
    for (const item of directory.items) expect(item).toMatchObject({ entryId: admitted.find(row => row.key === item.key)!.entryId, revision: 1 });
    const tail = directory.items.find(item => item.key === "complete-zzz-unsafe")!; expect(tail.task).toBe("untracked"); expect(tail.nativeStatus).toBe("pending");
    expect((await f.preflight(context, scope, directory.snapshotHash)).blockedEntryIds).toContain(tail.entryId);
    expect(JSON.stringify(directory)).not.toContain("SYNTHETIC_PRIVATE"); expect(JSON.stringify(directory)).not.toContain("synthetic-untracked-provider-task");
    noEffects(before, await f.facts(context));
  });

  it("uses owner scope tenant and current personal authority rather than tenant-wide permission to claim logs or hashes", async () => {
    const { actor, context, scope } = await basis(), peer = await f.actor(actor.tenantId, "tenant"), stranger = await f.actor();
    await f.rawLogs(context, "unassigned", [{ key: "personal-only", value: nativeVideoLog("personal-only") }]);
    const own = await f.directory(context, "unassigned"), peerContext = await f.current(peer);
    expect((await f.directory(peerContext, "unassigned")).total).toBe(0);
    expect(await outcome(f.preflight(peerContext, "unassigned", own.snapshotHash))).toEqual({ status: 409, code: "studio_video_directory_changed" });
    const foreign = await f.http(stranger, `/v1/creative-studio/workspace?scope=${scope}`, undefined, await f.current(stranger));
    expect(foreign.status).toBe(404); expect(await foreign.text()).not.toContain("personal-only");
    await f.grant(actor, f.permissions.filter(value => value !== Permission.DesignWrite));
    const changed = await f.http(actor, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: { operation: "video.directory", scope } }, context);
    expect(changed.status).toBe(409); expect(await changed.json()).toMatchObject({ code: "authority_changed" });
    await f.active(actor, false);
    expect((await f.http(actor, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: { operation: "video.directory", scope } }, context)).status).toBe(403);
  });

  it("keeps malformed unknown missing-task and invalid frozen histories visible and blocked without normalizing their originals", async () => {
    const { context, scope } = await basis();
    const rows = [ { key: "bad-json", value: "{broken" }, { key: "null-log", value: null },
      { key: "unknown-status", value: { ...nativeVideoLog("unknown-status"), status: "unknown-sentinel" } },
      { key: "missing-task", value: { ...nativeVideoLog("missing-task"), status: "pending" } },
      { key: "bad-task", value: { ...nativeVideoLog("bad-task", "pending"), task: { id: "bad", provider: "unknown", model: "x" } } },
      { key: "bad-origin", value: { ...frozenVideoLog("bad-origin"), _yummyaiOrigin: { version: 1, executionFrozen: false } } },
      { key: "bad-refs", value: { ...nativeVideoLog("bad-refs"), references: ["not-a-reference"] } },
      { key: "bad-media", value: { ...nativeVideoLog("bad-media", "success"), video: { url: "https://synthetic.invalid/private" } } } ];
    await f.rawLogs(context, scope, rows); const before = await f.facts(context), original = await f.logs(context, scope);
    const directory = await f.directory(context, scope); expect(directory.total).toBe(rows.length);
    const preflight = await f.preflight(context, scope, directory.snapshotHash); expect(preflight.canOpen).toBe(false);
    expect(new Set(preflight.blockedEntryIds)).toEqual(new Set(directory.items.map(item => item.entryId)));
    expect(directory.items.every(item => item.diagnostics.length > 0)).toBe(true);
    expect(await f.logs(context, scope)).toEqual(original); noEffects(before, await f.facts(context));
  });

  it("admits legitimate frozen history in view-only paused mode but does not exempt an ordinary pending sibling", async () => {
    const { context, scope } = await basis(), frozen = frozenVideoLog("frozen-retained");
    await f.rawLogs(context, scope, [{ key: frozen.id, value: frozen }]);
    const directory = await f.directory(context, scope), before = await f.facts(context);
    expect(directory.items[0]).toMatchObject({ origin: "frozen", nativeStatus: "pending" });
    expect(await f.preflight(context, scope, directory.snapshotHash)).toEqual({ version: 1, snapshotHash: directory.snapshotHash,
      total: 1, canOpen: true, mode: "view_only", execution: "paused", blockedEntryIds: [] });
    noEffects(before, await f.facts(context));
    await f.rawLogs(context, scope, [{ key: "ordinary-pending", value: nativeVideoLog("ordinary-pending", "pending") }]);
    const mixed = await f.directory(context, scope), checked = await f.preflight(context, scope, mixed.snapshotHash);
    expect(checked.canOpen).toBe(false); expect(checked.blockedEntryIds).toEqual([mixed.items.find(item => item.key === "ordinary-pending")!.entryId]);
    expect((await f.logs(context, scope)).find(row => row.key === frozen.id)!.value).toEqual(frozen);
  });

  it("rejects old snapshots after adding revising deleting native records or changing tracked task metadata", async () => {
    const { actor, context, scope } = await basis(), id = await f.generation(context, scope);
    const tracked = { ...nativeVideoLog("tracked", "pending"), task: { id, provider: "openai", model: "synthetic-history-video" } };
    await f.rawLogs(context, scope, [{ key: tracked.id, value: tracked }]);
    let directory = await f.directory(context, scope); expect(directory.items[0]).toMatchObject({ task: "tracked", generationStatus: "running" });
    const peer = await f.actor(actor.tenantId, "tenant"), otherScope = (await f.project(context)).id;
    const wrongTasks = [
      { key: "peer-video", id: await f.generation(await f.current(peer), scope) },
      { key: "other-scope-video", id: await f.generation(context, otherScope) },
      { key: "same-scope-image", id: await f.generation(context, scope, "image") },
    ];
    await f.rawLogs(context, scope, [...wrongTasks.map(task => ({ key: task.key, value: { ...nativeVideoLog(task.key, "pending"),
      task: { id: task.id, provider: "openai", model: "synthetic-history-video" } } })),
      { key: "same-video-uppercase", value: { ...nativeVideoLog("same-video-uppercase", "pending"),
        task: { id: id.toUpperCase(), provider: "openai", model: "synthetic-history-video" } } }]);
    directory = await f.directory(context, scope);
    for (const task of wrongTasks) expect(directory.items.find(item => item.key === task.key)).toMatchObject({ task: "untracked", generationStatus: null, diagnostics: ["untracked_task"] });
    expect(directory.items.find(item => item.key === "same-video-uppercase")).toMatchObject({ task: "tracked", generationStatus: "running", diagnostics: [] });
    const associationCheck = await f.preflight(context, scope, directory.snapshotHash); expect(associationCheck.canOpen).toBe(false);
    expect(new Set(associationCheck.blockedEntryIds)).toEqual(new Set(directory.items.filter(item => wrongTasks.some(task => task.key === item.key)).map(item => item.entryId)));
    await f.generationStatus(context, id, "failed");
    expect(await outcome(f.preflight(context, scope, directory.snapshotHash))).toEqual({ status: 409, code: "studio_video_directory_changed" });
    directory = await f.directory(context, scope); await f.rawLogs(context, scope, [{ key: "new-after-read", value: nativeVideoLog("new-after-read") }]);
    expect(await outcome(f.preflight(context, scope, directory.snapshotHash))).toEqual({ status: 409, code: "studio_video_directory_changed" });
    directory = await f.directory(context, scope); await f.revise(context, scope, "new-after-read", { ...nativeVideoLog("new-after-read"), title: "Revised native title" });
    expect(await outcome(f.preflight(context, scope, directory.snapshotHash))).toEqual({ status: 409, code: "studio_video_directory_changed" });
    directory = await f.directory(context, scope); await f.revise(context, scope, "new-after-read", undefined, true);
    expect(await outcome(f.preflight(context, scope, directory.snapshotHash))).toEqual({ status: 409, code: "studio_video_directory_changed" });
    const other = (await f.project(context)).id; expect(await outcome(f.preflight(context, other, (await f.directory(context, scope)).snapshotHash))).toEqual({ status: 409, code: "studio_video_directory_changed" });
  });

  it("fails explicitly at the full count and source-byte limits instead of returning a safe truncated directory", async () => {
    const { context, scope } = await basis();
    await f.rawLogs(context, scope, Array.from({ length: 10_001 }, (_, index) => { const key = "limit-" + index; return { key, value: nativeVideoLog(key) }; }));
    expect(await outcome(f.directory(context, scope))).toEqual({ status: 422, code: "studio_video_directory_too_large" });
    const bytesScope = (await f.project(context)).id;
    await f.rawLogs(context, bytesScope, Array.from({ length: 5 }, (_, index) => { const key = "byte-limit-" + index; return { key, value: { ...nativeVideoLog(key), prompt: "x".repeat(7_000_000) } }; }));
    expect(await outcome(f.directory(context, bytesScope))).toEqual({ status: 422, code: "studio_video_directory_too_large" });
    expect(await outcome(f.preflight(context, bytesScope, "0".repeat(64)))).toEqual({ status: 422, code: "studio_video_directory_too_large" });
    expect(f.videoCounts).toEqual({ get: 0, create: 0, bridge: 0 }); expect(f.counts.dispatchAttempts).toBe(0);
  });

  it("does not return a computed personal directory after permission revocation while its response is held", async () => {
    const { actor, context, scope } = await basis(); await f.rawLogs(context, scope, [{ key: "late-private", value: nativeVideoLog("late-private") }]);
    const hold = f.hold("invoke");
    try {
      const pending = f.http(actor, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: { scope, operation: "video.directory" } }, context);
      await hold.entered; await f.grant(actor, f.permissions.filter(value => value !== Permission.DesignRead)); hold.release();
      const response = await pending; expect(response.status).toBe(403); const body = await response.text();
      expect(body).not.toContain("late-private"); expect(body).not.toContain("SYNTHETIC_PRIVATE");
    } finally { hold.clear(); }
  });

  it("advertises the new protocol and repeats both read operations without generation candidate audit or storage writes", async () => {
    const { actor, context, scope } = await basis(); await f.rawLogs(context, scope, [{ key: "ordinary-history", value: nativeVideoLog("ordinary-history") }]);
    const before = await f.facts(context), workspace = await f.http(actor, `/v1/creative-studio/workspace?scope=${scope}`, undefined, context);
    expect(workspace.status).toBe(200); expect(StudioWorkspaceSchema.parse(await workspace.json()).videoDirectoryVersion).toBe(1);
    for (let index = 0; index < 3; index++) {
      const directory = await f.directory(context, scope); expect((await f.preflight(context, scope, directory.snapshotHash)).canOpen).toBe(true);
    }
    noEffects(before, await f.facts(context));
    expect(await outcome(f.preflight(context, scope, createEntityId().replaceAll("-", "").padEnd(64, "0"))))
      .toEqual({ status: 409, code: "studio_video_directory_changed" });
  });
});
