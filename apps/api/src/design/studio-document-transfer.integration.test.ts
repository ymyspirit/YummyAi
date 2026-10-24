import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import type { TenantContext } from "@yummyai/contracts";
import { StudioTransferLookupSchema, StudioTransferPageSchema, StudioTransferRequestSchema, type StudioTransferLookup, type StudioTransferRequest } from "@yummyai/contracts/pod/studio-document-transfer";
import { StudioPersonalReplySchema, StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { assetFiles, creativeStudioTransfers, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { studioPersonalAuthority, studioPersonalSha } from "./creative-studio-personal.test-fixture.js";
import { createStudioDocumentTransferFixture, transferAssetKey, transferCanvasKey, transferDocumentValue,
  transferImageDraftKey, transferVideoDraftKey } from "./studio-document-transfer.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createStudioDocumentTransferFixture>>;
let f: Fixture;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("studio_transfer_test_object_missing");
  return value as Record<string, unknown>;
};
const list = (value: unknown): Array<Record<string, unknown>> => {
  if (!Array.isArray(value)) throw new Error("studio_transfer_test_array_missing"); return value.map(record);
};
async function outcome(operation: Promise<unknown>) {
  return operation.then(value => ({ ok: true as const, value, status: null, code: null }), error => {
    const body = error instanceof HttpException ? error.getResponse() : null;
    return { ok: false as const, status: error instanceof HttpException ? error.getStatus() : error && typeof error === "object" && "status" in error ? error.status : null,
      code: body && typeof body === "object" && "code" in body ? body.code : null };
  });
}
async function sqlFailure(operation: Promise<unknown>) {
  try { await operation; return null; }
  catch (error) {
    for (let current: unknown = error, depth = 0; current && typeof current === "object" && depth < 5; depth++) {
      if ("code" in current && typeof current.code === "string") return current.code;
      current = "cause" in current ? current.cause : null;
    }
    throw error;
  }
}
async function basis(unassigned = false) {
  const actor = await f.actor(), context = await f.current(actor);
  return { actor, context, scope: unassigned ? "unassigned" : (await f.project(context)).id, targetScope: (await f.project(context)).id };
}
function receipt(result: StudioTransferLookup) {
  expect(result.status).toBe("committed");
  if (result.status !== "committed") throw new Error("studio_transfer_test_receipt_missing"); return result.receipt;
}
function unchangedPaid(before: Awaited<ReturnType<Fixture["facts"]>>, after: Awaited<ReturnType<Fixture["facts"]>>) {
  for (const table of ["creative_studio_generations", "creative_executions", "ai_budget_ledger", "ai_budget_policies", "model_provider_configs", "model_routes"])
    expect(after.tables[table]).toEqual(before.tables[table]);
  expect(after.counts.generationCalls).toBe(0); expect(after.counts.dispatchAttempts).toBe(0);
  expect(after.providerCalls).toBe(0); expect(after.workerProcesses).toBe(0); expect(after.role).toBe("yummyai_app");
}
async function waitForHead(hold: ReturnType<Fixture["holdHead"]>, operation: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([hold.entered, operation.then(() => { throw new Error("studio_transfer_test_completed_before_real_head"); }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("studio_transfer_test_real_head_timeout")), 15_000); })]); }
  finally { if (timer) clearTimeout(timer); }
}
async function httpTransfer(actor: Awaited<ReturnType<Fixture["actor"]>>, context: TenantContext, operation: "document.prepare" | "document.commit" | "document.lookup" | "document.cancel", input: StudioTransferRequest) {
  const response = await f.http(actor, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: { operation, ...input } }, context);
  expect(response.status).toBe(200); const reply = StudioPersonalReplySchema.parse(await response.json());
  if (reply.operation !== operation) throw new Error("studio_transfer_test_http_reply_missing"); return StudioTransferLookupSchema.parse(reply.data);
}

describe("d8b42e71 complete native Studio document transfer in disposable current188", () => {
  beforeAll(async () => { f = await createStudioDocumentTransferFixture(); expect(await f.schemaEvidence()).toMatchObject({ migrations: 188, applicationRole: "yummyai_app" }); });
  afterAll(async () => { await f?.close(); });

  it("appends the real five tools and seven original media formats to a nonempty target preserving typed links legacy bytes and all source history", async () => {
    const { actor, context, scope, targetScope } = await basis(), source = await f.seed(context, scope, "source"), target = await f.seed(context, targetScope, "target");
    target.canvas.state.projects.push({ ...f.copy(target.canvas.state.projects[0]!), id: "target-only-tombstone", title: "Target canvas protected from source tombstone" });
    target.canvas.state.deletedProjects = [{ id: "target-deleted-only", deletedAt: "2026-10-24T00:00:00.000Z" }];
    await f.save(context, targetScope, transferCanvasKey, JSON.stringify(target.canvas), 1);
    const intent = await f.resultIntent(context, scope, source.uploaded[0]!.key);
    const beforeSource = await f.snapshot(context, scope), beforeTarget = await f.snapshot(context, targetScope), before = await f.facts(context);
    const workspaceResponse = await f.http(actor, "/v1/creative-studio/workspace?scope=" + scope, undefined, context);
    expect(workspaceResponse.status).toBe(200); const workspace = StudioWorkspaceSchema.parse(await workspaceResponse.json());
    expect(workspace.documentTransferVersion).toBe(1); expect(workspace.generation).toEqual({ enabled: false, code: "operator_paused" });
    const previewResponse = await f.http(actor, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: { operation: "document.preview", scope, targetScope } }, context);
    expect(previewResponse.status).toBe(200); const previewReply = StudioPersonalReplySchema.parse(await previewResponse.json());
    if (previewReply.operation !== "document.preview") throw new Error("studio_transfer_test_http_preview_missing");
    expect(previewReply.data.counts).toEqual({ canvases: 1, prompts: 1, assets: 3, imageDrafts: 1, videoDrafts: 1, history: 2, media: 7 });
    expect(previewReply.data.excluded).toContain("app_state/" + intent.key);
    const input = StudioTransferRequestSchema.parse({ scope, targetScope, requestId: randomUUID(), manifestHash: previewReply.data.manifestHash });
    expect((await httpTransfer(actor, context, "document.prepare", input)).status).toBe("prepared");
    expect(await f.snapshot(context, targetScope)).toEqual(beforeTarget);
    const writes = f.counts.storageWrites, reads = f.counts.storageReads, scans = f.counts.scans, heads = f.headCounts.calls;
    const committed = receipt(await httpTransfer(actor, context, "document.commit", input));
    expect(committed.counts).toEqual(previewReply.data.counts); expect(committed.entries).toHaveLength(13);
    expect(f.counts.storageWrites).toBe(writes); expect(f.counts.storageReads).toBe(reads); expect(f.counts.scans).toBe(scans);
    expect(f.headCounts.calls).toBeGreaterThan(heads); expect(await f.snapshot(context, scope)).toEqual(beforeSource);
    const afterTarget = await f.snapshot(context, targetScope);
    expect(afterTarget.entries.some(row => row.key === intent.key)).toBe(false);
    for (const media of source.uploaded) {
      const originalEntry = beforeSource.entries.find(row => row.namespace === media.namespace && row.key === media.key)!;
      const imported = committed.entries.find(row => row.sourceEntryIds.includes(originalEntry.id)); expect(imported).toBeDefined();
      const copiedEntry = afterTarget.entries.find(row => row.id === imported!.targetEntryId)!;
      expect(copiedEntry.assetId).toBe(media.assetId); expect(copiedEntry.key).not.toBe(media.key);
      expect(studioPersonalSha(await f.original(context, media.assetId))).toBe(media.checksumSha256);
    }
    const canvas = record((await f.read(context, targetScope, transferCanvasKey)).value), projects = list(record(canvas.state).projects);
    expect(projects).toHaveLength(3); expect(projects.slice(0, 2)).toEqual(target.canvas.state.projects);
    expect(record(canvas.state).deletedProjects).toEqual(target.canvas.state.deletedProjects);
    const importedProject = projects[2]!, sourceProject = source.canvas.state.projects[0]!;
    expect(importedProject.id).not.toBe(sourceProject.id); expect(importedProject.viewport).toEqual(sourceProject.viewport);
    expect(importedProject.backgroundMode).toBe(sourceProject.backgroundMode); expect(importedProject.showImageInfo).toBe(true);
    const nodes = list(importedProject.nodes), image = nodes.find(row => row.title === "source image")!, text = nodes.find(row => row.title === "source text")!, group = nodes.find(row => row.type === "group")!;
    const imageMeta = record(image.metadata); expect(image.id).not.toBe("node-image"); expect(imageMeta.groupId).toBe(group.id);
    expect(imageMeta.primaryImageId).toBe(list(imageMeta.images)[0]!.id); expect(record(text.metadata).content).toBe(source.literal);
    expect(list(importedProject.connections)[0]).toMatchObject({ fromNodeId: image.id, toNodeId: text.id });
    expect(record(nodes.find(row => row.title === "source embedded legacy")!.metadata).content).toBe(source.legacyDataUri);
    const imageSource = beforeSource.entries.find(row => row.namespace === "image_files" && row.key === source.uploaded[0]!.key)!;
    const copiedImage = committed.entries.find(row => row.sourceEntryIds.includes(imageSource.id))!;
    expect(imageMeta.storageKey).toBe(copiedImage.key); expect(imageMeta.references).toEqual([copiedImage.key, source.legacyDataUri]);
    expect(nodes.filter(row => ["image", "video", "audio"].includes(String(row.type))).map(row => row.type)).toEqual(["image", "image", "video", "audio"]);
    for (const node of nodes) expect(record(node._yummyaiOrigin)).toMatchObject({ sourceScope: scope, requestId: input.requestId, executionFrozen: true });
    const chats = list(importedProject.chatSessions), message = list(chats[0]!.messages)[0]!;
    expect(importedProject.activeChatId).toBe(chats[0]!.id); expect(message.text).toBe(source.literal);
    expect(list(message.references).map(row => row.dataUrl)).toContain(source.legacyDataUri); expect(list(message.references)[0]!.storageKey).toBe(copiedImage.key);
    const assetDoc = record((await f.read(context, targetScope, transferAssetKey)).value), assets = list(record(assetDoc.state).assets);
    expect(assets.slice(0, target.assets.state.assets.length)).toEqual(target.assets.state.assets);
    expect(record(assets.find(row => row.title === "source prompt")!.data).content).toBe(source.literal);
    for (const [key, originalDraft] of [[transferImageDraftKey, target.imageDraft], [transferVideoDraftKey, target.videoDraft]] as const) {
      const draft = record((await f.read(context, targetScope, key)).value), rows = list(draft.drafts);
      expect(draft.activeId).toBe(originalDraft.activeId); expect(rows).toHaveLength(2); expect(rows[0]).toEqual(originalDraft.drafts[0]);
      expect(list(rows[1]!.references)[0]!.storageKey).toBe(copiedImage.key); expect(record(rows[1]!._yummyaiOrigin).executionFrozen).toBe(true);
    }
    const importedHistory = afterTarget.entries.filter(row => row.namespace.endsWith("_generation_logs") && ![target.imageLog.id, target.videoLog.id].includes(row.key));
    expect(importedHistory).toHaveLength(2);
    const videoHistory = record(transferDocumentValue(importedHistory.find(row => row.namespace === "video_generation_logs")!.value));
    expect(videoHistory.status).toBe("pending"); expect(videoHistory.task).toEqual(source.videoLog.task); expect(record(videoHistory._yummyaiOrigin).executionFrozen).toBe(true);
    unchangedPaid(before, await f.facts(context));
  });

  it("rejects changed source revisions and newly inserted source keys after preparation without partial target writes", async () => {
    const { context, scope, targetScope } = await basis();
    await f.save(context, scope, "studio:prompts", [{ id: "source-prompt", content: "Original source draft" }]);
    for (const change of ["revision", "new-key"] as const) {
      const { input } = await f.request(context, scope, targetScope); await f.transfer(context, "document.prepare", input);
      const target = await f.snapshot(context, targetScope);
      if (change === "revision") await f.save(context, scope, "studio:prompts", [{ id: "source-prompt", content: "Later source revision" }], 1);
      else await f.save(context, scope, transferImageDraftKey, { version: 1, drafts: [{ id: "new-source-draft", prompt: "New source key", references: [], config: {} }], activeId: "new-source-draft" });
      const denied = await outcome(f.transfer(context, "document.commit", input)); expect(denied.ok).toBe(false); expect(denied.status).toBe(409);
      expect(await f.snapshot(context, targetScope)).toEqual(target); expect((await f.transfers(context)).find(row => row.requestId === input.requestId)!.receipt).toBeNull();
    }
  });

  it("detects a new target key inserted during real private HEAD preflight and preserves that concurrent target save", async () => {
    const { context, scope, targetScope } = await basis(); await f.seed(context, scope, "source", false);
    const { input } = await f.request(context, scope, targetScope); await f.transfer(context, "document.prepare", input);
    const hold = f.holdHead(), operation = outcome(f.transfer(context, "document.commit", input));
    try {
      await waitForHead(hold, operation); await f.save(context, targetScope, "studio:prompts", [{ id: "concurrent-target", content: "Keep this saved new key" }]);
      const concurrent = await f.snapshot(context, targetScope); hold.release(); const denied = await operation;
      expect(denied.ok).toBe(false); expect(denied.status).toBe(409); expect(await f.snapshot(context, targetScope)).toEqual(concurrent);
      expect((await f.transfers(context))[0]!.receipt).toBeNull();
    } finally { hold.clear(); await operation; }
  });

  it("reauthorizes current asset permission and active membership after private HEAD before any target append", async () => {
    for (const revoke of ["asset-read", "membership"] as const) {
      const { actor, context, scope, targetScope } = await basis(); await f.seed(context, scope, "source", false);
      const { input } = await f.request(context, scope, targetScope); await f.transfer(context, "document.prepare", input);
      const target = await f.snapshot(context, targetScope), hold = f.holdHead(), operation = outcome(f.transfer(context, "document.commit", input));
      try {
        await waitForHead(hold, operation);
        if (revoke === "asset-read") await f.grant(actor, f.permissions.filter(value => value !== Permission.AssetRead)); else await f.active(actor, false);
        hold.release(); const denied = await operation; expect(denied.ok).toBe(false); expect(denied.status).toBe(403);
      } finally { hold.clear(); await operation; await f.active(actor, true); await f.grant(actor, f.permissions); }
      expect(await f.snapshot(await f.current(actor), targetScope)).toEqual(target); expect((await f.transfers(await f.current(actor)))[0]!.receipt).toBeNull();
    }
  });

  it("enforces owner and tenant isolation for original manifests requests targets and receipts even with tenant-wide permissions", async () => {
    const { actor, context, scope, targetScope } = await basis(); await f.save(context, scope, "studio:prompts", [{ id: "private-prompt", content: "Owned source" }]);
    const { input } = await f.request(context, scope, targetScope); await f.transfer(context, "document.prepare", input); const committed = receipt(await f.transfer(context, "document.commit", input));
    const beforeSource = await f.snapshot(context, scope), beforeTarget = await f.snapshot(context, targetScope), beforeTransfers = await f.transfers(context);
    for (const peer of [await f.actor(actor.tenantId, "tenant"), await f.actor(undefined, "tenant")]) {
      await f.grant(peer, f.permissions, "tenant"); const peerContext = await f.current(peer);
      expect(await f.transfers(peerContext)).toEqual([]);
      if (peer.tenantId === actor.tenantId) {
        expect(await f.transfer(peerContext, "document.lookup", input)).toEqual({ status: "missing", request: input, receipt: null });
        expect((await outcome(f.transfer(peerContext, "document.prepare", input))).status).toBe(409);
        expect((await outcome(f.transfer(peerContext, "document.commit", input))).status).toBe(404);
        const empty = await outcome(f.preview(peerContext, scope, targetScope)); expect(empty.status).toBe(400); expect(empty.code).toBe("studio_transfer_invalid");
      } else {
        for (const operation of ["document.lookup", "document.prepare", "document.commit"] as const) {
          const denied = await outcome(f.transfer(peerContext, operation, input)); expect(denied.ok).toBe(false); expect(denied.status).toBe(404);
        }
        expect((await outcome(f.preview(peerContext, scope, targetScope))).status).toBe(404);
      }
    }
    expect(receipt(await f.transfer(context, "document.lookup", input))).toEqual(committed);
    expect(await f.snapshot(context, scope)).toEqual(beforeSource); expect(await f.snapshot(context, targetScope)).toEqual(beforeTarget); expect(await f.transfers(context)).toEqual(beforeTransfers);
  });

  it("commits concurrent identical keys once and recovers the original receipt read only after a lost reply and later document edits", async () => {
    const { actor, context, scope, targetScope } = await basis(); await f.seed(context, scope, "source", false); await f.seed(context, targetScope, "target");
    const { input } = await f.request(context, scope, targetScope); await f.transfer(context, "document.prepare", input);
    const alternateTarget = (await f.project(context)).id;
    const [left, right, crossScope] = await Promise.all([f.transfer(context, "document.commit", input), f.transfer(context, "document.commit", input),
      outcome(f.transfer(context, "document.prepare", { ...input, targetScope: alternateTarget }))]);
    expect(crossScope.ok).toBe(false); expect(crossScope.status).toBe(409); expect(crossScope.code).toBe("studio_transfer_changed");
    expect(receipt(left)).toEqual(receipt(right)); const target = await f.snapshot(context, targetScope), transfers = await f.transfers(context);
    expect(transfers).toHaveLength(1); expect(transfers[0]!.receipt).toEqual(receipt(left));
    // The server commits a real personal HTTP request; the caller discards its
    // body and subsequently resolves the original key without another commit.
    const reply = await f.http(actor, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: { operation: "document.commit", ...input } }, context);
    expect(reply.status).toBe(200); await reply.body?.cancel();
    const before = await f.facts(context), heads = f.headCounts.calls;
    const recovered = receipt(await httpTransfer(actor, context, "document.lookup", input)); expect(recovered).toEqual(receipt(left));
    expect(f.headCounts.calls).toBe(heads); expect(await f.transfers(context)).toEqual(transfers); expect(await f.snapshot(context, targetScope)).toEqual(target);
    for (const changed of [{ ...input, manifestHash: "0".repeat(64) }, { ...input, targetScope: (await f.project(context)).id }]) {
      for (const operation of ["document.prepare", "document.commit", "document.lookup"] as const) expect((await outcome(f.transfer(context, operation, changed))).status).toBe(409);
    }
    for (const editedScope of [scope, targetScope]) {
      const draft = await f.read(context, editedScope, transferImageDraftKey), value = record(f.copy(draft.value));
      list(value.drafts)[0]!.prompt = `Later ordinary edit in ${editedScope === scope ? "source" : "target"}`;
      await f.save(context, editedScope, transferImageDraftKey, value, draft.revision);
    }
    const afterEditSource = await f.snapshot(context, scope), afterEditTarget = await f.snapshot(context, targetScope), afterEditTransfers = await f.transfers(context), beforeLookupHeads = f.headCounts.calls;
    expect(receipt(await f.transfer(context, "document.lookup", input))).toEqual(recovered);
    expect(await f.snapshot(context, scope)).toEqual(afterEditSource); expect(await f.snapshot(context, targetScope)).toEqual(afterEditTarget);
    expect(await f.transfers(context)).toEqual(afterEditTransfers); expect(f.headCounts.calls).toBe(beforeLookupHeads); unchangedPaid(before, await f.facts(context));
  });

  it("blocks missing bare media keys unresolved blob remote references and unknown native versions atomically", async () => {
    for (const invalid of ["missing-key", "blob", "remote", "version"] as const) {
      const { context, scope, targetScope } = await basis(), source = await f.seed(context, scope, "source", false); await f.seed(context, targetScope, "target");
      const changed = f.copy(source.canvas), metadata = record(changed.state.projects[0]!.nodes.find(row => row.id === "node-image")!.metadata);
      if (invalid === "version") changed.version = 99;
      else if (invalid === "missing-key") metadata.references = ["image:not-saved-anywhere"];
      else { delete metadata.storageKey; delete metadata.images; delete metadata.primaryImageId; metadata.content = invalid === "blob" ? "blob:http://127.0.0.1/synthetic-unresolved" : "https://synthetic.invalid/unresolved.png"; }
      await f.save(context, scope, transferCanvasKey, JSON.stringify(changed), 1);
      const target = await f.snapshot(context, targetScope), before = await f.facts(context), prior = await f.transfers(context);
      const denied = await outcome(f.preview(context, scope, targetScope)); expect(denied.ok).toBe(false); expect(denied.status).toBe(400); expect(denied.code).toBe("studio_transfer_invalid");
      expect(await f.snapshot(context, targetScope)).toEqual(target); expect(await f.transfers(context)).toEqual(prior); unchangedPaid(before, await f.facts(context));
    }
  });

  it("supports unassigned source recovery and makes prepared identity manifest and a committed receipt immutable under the application SQL role", async () => {
    const { context, scope, targetScope } = await basis(true); await f.save(context, scope, "studio:prompts", [{ id: "unassigned-prompt", content: "Unassigned owned draft" }]);
    const { input } = await f.request(context, scope, targetScope); const missing = await f.transfer(context, "document.lookup", input);
    expect(missing).toEqual({ status: "missing", request: input, receipt: null }); expect(await f.transfers(context)).toEqual([]);
    await f.transfer(context, "document.prepare", input); const prepared = (await f.transfers(context))[0]!;
    for (const mutation of [
      () => withTenant(f.database.db, context, tx => tx.update(creativeStudioTransfers).set({ request: { ...input, manifestHash: "f".repeat(64) } }).where(eq(creativeStudioTransfers.id, prepared.id))),
      () => withTenant(f.database.db, context, tx => tx.update(creativeStudioTransfers).set({ manifest: { forged: true } }).where(eq(creativeStudioTransfers.id, prepared.id))),
      () => withTenant(f.database.db, context, tx => tx.delete(creativeStudioTransfers).where(eq(creativeStudioTransfers.id, prepared.id))),
    ]) expect(await sqlFailure(mutation())).toBe("42501");
    const fake = { id: prepared.id, sourceScope: scope, targetScope, requestId: input.requestId, manifestHash: input.manifestHash,
      copiedAt: new Date().toISOString(), counts: { canvases: 0, prompts: 1, assets: 0, imageDrafts: 0, videoDrafts: 0, history: 0, media: 0 }, entries: [] };
    expect(await sqlFailure(withTenant(f.database.db, context, tx => tx.execute(sql`update creative_studio_transfers set receipt=${JSON.stringify(fake)}::jsonb,committed_at=now() where id=${prepared.id}`)))).toBe("23514");
    expect((await f.transfers(context))[0]).toEqual(prepared);
    const committed = receipt(await f.transfer(context, "document.commit", input)), committedRow = (await f.transfers(context))[0]!;
    for (const mutation of [
      () => withTenant(f.database.db, context, tx => tx.update(creativeStudioTransfers).set({ receipt: { ...committed, copiedAt: new Date(Date.parse(committed.copiedAt) + 1).toISOString() }, committedAt: new Date() }).where(eq(creativeStudioTransfers.id, prepared.id))),
      () => withTenant(f.database.db, context, tx => tx.update(creativeStudioTransfers).set({ receipt: null, committedAt: null }).where(eq(creativeStudioTransfers.id, prepared.id))),
    ]) expect(await sqlFailure(mutation())).toBe("23514");
    expect((await f.transfers(context))[0]).toEqual(committedRow); expect(receipt(await f.transfer(context, "document.lookup", input))).toEqual(committed);
  });

  it("cancels prepared requests immutably and wins a held HEAD commit race without appending while committed cancellation retains every copy", async () => {
    const stale = await basis(); await f.seed(stale.context, stale.scope, "source", false); await f.seed(stale.context, stale.targetScope, "target");
    const { input: old } = await f.request(stale.context, stale.scope, stale.targetScope); await f.transfer(stale.context, "document.prepare", old);
    const originalIntent = (await f.transfers(stale.context))[0]!;
    const draft = await f.read(stale.context, stale.scope, transferImageDraftKey), edited = record(f.copy(draft.value));
    list(edited.drafts)[0]!.prompt = "Source changed after preparation but cancellation must stay available";
    await f.save(stale.context, stale.scope, transferImageDraftKey, edited, draft.revision);
    await f.save(stale.context, stale.targetScope, "studio:prompts", [{ id: "target-after-prepare", content: "Keep the later target save" }]);
    const targetBeforeCancel = await f.snapshot(stale.context, stale.targetScope), headsBeforeCancel = f.headCounts.calls;
    const cancelled = await httpTransfer(stale.actor, stale.context, "document.cancel", old);
    expect(cancelled).toEqual({ status: "cancelled", request: old, receipt: null });
    const cancelledRow = (await f.transfers(stale.context))[0]!;
    expect(cancelledRow.request).toEqual(originalIntent.request); expect(cancelledRow.manifest).toEqual(originalIntent.manifest);
    expect(cancelledRow.receipt).toBeNull(); expect(cancelledRow.committedAt).toBeNull(); expect(cancelledRow.cancelledAt).toBeInstanceOf(Date);
    expect(await f.transfer(stale.context, "document.cancel", old)).toEqual(cancelled);
    expect(await f.transfer(stale.context, "document.prepare", old)).toEqual(cancelled);
    const denied = await outcome(f.transfer(stale.context, "document.commit", old)); expect(denied.status).toBe(409); expect(denied.code).toBe("studio_transfer_cancelled");
    for (const operation of ["document.cancel", "document.prepare", "document.commit", "document.lookup"] as const) {
      const changed = await outcome(f.transfer(stale.context, operation, { ...old, manifestHash: "f".repeat(64) }));
      expect(changed.status).toBe(409); expect(changed.code).toBe("studio_transfer_changed");
    }
    expect(await f.snapshot(stale.context, stale.targetScope)).toEqual(targetBeforeCancel); expect(f.headCounts.calls).toBe(headsBeforeCancel);
    // A terminal cancellation remains observable even when its old original is
    // later rejected. It grants no read of that media and never reopens a copy.
    await f.invoke(stale.context, { operation: "asset.review", scope: stale.scope, key: "image:transfer-main", decision: "reject", sourceReference: "Synthetic old source rejected after cancellation" });
    expect(await f.transfer(stale.context, "document.lookup", old)).toEqual(cancelled); expect(await f.transfer(stale.context, "document.cancel", old)).toEqual(cancelled);
    expect(f.headCounts.calls).toBe(headsBeforeCancel); expect((await f.transfers(stale.context))[0]).toEqual(cancelledRow);
    expect(await sqlFailure(withTenant(f.database.db, stale.context, tx => tx.update(creativeStudioTransfers).set({ cancelledAt: null }).where(eq(creativeStudioTransfers.id, cancelledRow.id))))).toBe("23514");

    const race = await basis(); await f.seed(race.context, race.scope, "source", false); await f.seed(race.context, race.targetScope, "target");
    const { input } = await f.request(race.context, race.scope, race.targetScope); await f.transfer(race.context, "document.prepare", input);
    const sourceBeforeRace = await f.snapshot(race.context, race.scope), targetBeforeRace = await f.snapshot(race.context, race.targetScope);
    const hold = f.holdHead(), operation = outcome(f.transfer(race.context, "document.commit", input));
    try {
      await waitForHead(hold, operation); expect(await f.transfer(race.context, "document.cancel", input)).toEqual({ status: "cancelled", request: input, receipt: null });
      hold.release(); const lost = await operation; expect(lost.ok).toBe(false); expect(lost.status).toBe(409); expect(lost.code).toBe("studio_transfer_cancelled");
    } finally { hold.clear(); await operation; }
    expect(await f.snapshot(race.context, race.scope)).toEqual(sourceBeforeRace); expect(await f.snapshot(race.context, race.targetScope)).toEqual(targetBeforeRace);
    const finalCancelled = (await f.transfers(race.context))[0]!;
    expect(finalCancelled.cancelledAt).toBeInstanceOf(Date); expect(finalCancelled.committedAt).toBeNull(); expect(finalCancelled.receipt).toBeNull();
    const { input: next } = await f.request(race.context, race.scope, race.targetScope); expect(next.requestId).not.toBe(input.requestId);
    await f.transfer(race.context, "document.prepare", next); const committed = receipt(await f.transfer(race.context, "document.commit", next));
    const committedTarget = await f.snapshot(race.context, race.targetScope), terminalRows = await f.transfers(race.context), finalHeads = f.headCounts.calls;
    expect(receipt(await f.transfer(race.context, "document.cancel", next))).toEqual(committed);
    expect(receipt(await f.transfer(race.context, "document.lookup", next))).toEqual(committed);
    expect(await f.snapshot(race.context, race.targetScope)).toEqual(committedTarget); expect(await f.transfers(race.context)).toEqual(terminalRows);
    expect(f.headCounts.calls).toBe(finalHeads); expect(terminalRows).toHaveLength(2);
    expect(terminalRows.find(row => row.requestId === next.requestId)).toMatchObject({ receipt: committed, cancelledAt: null });
  });

  it("recovers owned prepared committed and cancelled original requests by read only keyset pages without local markers or leaking unavailable targets", async () => {
    const initial = await basis(); await f.grant(initial.actor, f.permissions, "tenant");
    const context = await f.current(initial.actor), { scope, targetScope } = initial;
    await f.save(context, scope, "studio:prompts", [{ id: "server-index-source", content: "Owned exact original requests survive a closed tab" }]);
    const originals: Array<{ request: StudioTransferRequest; status: "prepared" | "committed" | "cancelled" }> = [];
    for (const status of ["prepared", "cancelled", "committed"] as const) {
      const { input } = await f.request(context, scope, targetScope); await f.transfer(context, "document.prepare", input);
      if (status === "cancelled") await f.transfer(context, "document.cancel", input);
      if (status === "committed") await f.transfer(context, "document.commit", input);
      originals.push({ request: input, status });
    }
    const peer = await f.actor(initial.actor.tenantId), peerTarget = (await f.project(peer.context)).id;
    const { input: unavailable } = await f.request(context, scope, peerTarget); await f.transfer(context, "document.prepare", unavailable);
    async function requests(current: TenantContext, cursor?: string, limit = 2) {
      const reply = await f.invoke(current, { operation: "document.requests", scope, limit, ...(cursor ? { cursor } : {}) });
      if (reply.operation !== "document.requests") throw new Error("studio_transfer_test_original_index_missing"); return StudioTransferPageSchema.parse(reply.data);
    }
    // This personal transport has no browser marker input. The server supplies
    // the complete exact four original fields from its immutable owner records.
    const response = await f.http(initial.actor, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context),
      request: { operation: "document.requests", scope, limit: 50 } }, context);
    expect(response.status).toBe(200); const packet = StudioPersonalReplySchema.parse(await response.json());
    if (packet.operation !== "document.requests") throw new Error("studio_transfer_test_personal_index_missing");
    const all = StudioTransferPageSchema.parse(packet.data); expect(all.items).toHaveLength(4); expect(all.unavailableOnPage).toBe(0); expect(all.nextCursor).toBeNull();
    for (const original of originals) expect(all.items.find(item => item.request.requestId === original.request.requestId)).toMatchObject(original);
    expect(all.items.find(item => item.request.requestId === unavailable.requestId)!.request).toEqual(unavailable);
    await f.grant(initial.actor, f.permissions, "self"); const narrowed = await f.current(initial.actor);
    const before = await f.facts(narrowed), beforeRows = await f.transfers(narrowed), beforeSource = await f.snapshot(narrowed, scope), beforeTarget = await f.snapshot(narrowed, targetScope), heads = f.headCounts.calls;
    const pages = []; let cursor: string | undefined;
    for (let count = 0; count < 4; count++) {
      const page = await requests(narrowed, cursor); pages.push(page); if (!page.nextCursor) break; cursor = page.nextCursor;
    }
    expect(pages).toHaveLength(2); expect(pages.at(-1)!.nextCursor).toBeNull(); expect(pages.reduce((count, page) => count + page.unavailableOnPage, 0)).toBe(1);
    const recovered = pages.flatMap(page => page.items), expected = beforeRows.filter(row => row.requestId !== unavailable.requestId).sort((a, b) => a.id < b.id ? 1 : -1);
    expect(recovered.map(item => item.request.requestId)).toEqual(expected.map(row => row.requestId)); expect(new Set(recovered.map(item => item.request.requestId)).size).toBe(3);
    expect(JSON.stringify(pages)).not.toContain(peerTarget); expect(JSON.stringify(pages)).not.toContain(unavailable.requestId);
    for (const item of recovered) expect(await f.transfer(narrowed, "document.lookup", item.request)).toEqual(item);
    await f.grant(peer, f.permissions, "tenant"); expect(await requests(await f.current(peer))).toEqual({ items: [], nextCursor: null, unavailableOnPage: 0 });
    const outsider = await f.actor(undefined, "tenant"); expect((await outcome(requests(await f.current(outsider)))).status).toBe(404);
    expect(await f.transfers(narrowed)).toEqual(beforeRows); expect(await f.snapshot(narrowed, scope)).toEqual(beforeSource); expect(await f.snapshot(narrowed, targetScope)).toEqual(beforeTarget);
    const after = await f.facts(narrowed); expect(f.headCounts.calls).toBe(heads); expect(after.counts.storageReads).toBe(before.counts.storageReads); expect(after.counts.storageWrites).toBe(before.counts.storageWrites); unchangedPaid(before, after);

    const expiry = await basis(), image = await f.upload(expiry.context, expiry.scope, f.media.png, "image/png", "image:expired-server-index");
    const { input: expiringRequest } = await f.request(expiry.context, expiry.scope, expiry.targetScope); await f.transfer(expiry.context, "document.prepare", expiringRequest);
    const [file] = (await f.snapshot(expiry.context, expiry.scope)).files; if (!file) throw new Error("studio_transfer_test_expiring_source_missing");
    expect(file.rightsStatus).toBe("unverified");
    await withTenant(f.database.db, expiry.context, tx => tx.update(assetFiles).set({ rightsMetadata: { ...file.rightsMetadata,
      source: { ...record(file.rightsMetadata.source), licenseExpiresAt: "2020-01-01T00:00:00.000Z" } } }).where(eq(assetFiles.id, image.assetId)));
    const expiryRows = await f.transfers(expiry.context), expiryBefore = await f.facts(expiry.context), expiryHeads = f.headCounts.calls;
    const expired = await f.invoke(expiry.context, { operation: "document.requests", scope: expiry.scope, limit: 25 });
    if (expired.operation !== "document.requests") throw new Error("studio_transfer_test_expired_index_missing");
    expect(StudioTransferPageSchema.parse(expired.data)).toEqual({ items: [], nextCursor: null, unavailableOnPage: 1 });
    expect(JSON.stringify(expired.data)).not.toContain(expiringRequest.requestId); expect(JSON.stringify(expired.data)).not.toContain(expiry.targetScope);
    expect((await f.snapshot(expiry.context, expiry.scope)).files[0]!.rightsStatus).toBe("unverified"); expect(await f.transfers(expiry.context)).toEqual(expiryRows);
    const expiryAfter = await f.facts(expiry.context); expect(f.headCounts.calls).toBe(expiryHeads); expect(expiryAfter.counts.storageReads).toBe(expiryBefore.counts.storageReads);
    expect(expiryAfter.counts.storageWrites).toBe(expiryBefore.counts.storageWrites); unchangedPaid(expiryBefore, expiryAfter);
  });
});
