import { HttpException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { ErpSessionViewSchema } from "@yummyai/contracts/auth/session";
import { StudioRpcSchema, type StudioRpc } from "@yummyai/contracts/pod/creative-studio";
import { StudioPersonalReplySchema, StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCreativeStudioPersonalFixture, studioPersonalAuthority, studioPersonalDocumentKey,
  studioPersonalSha, type StudioPersonalActor } from "./creative-studio-personal.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createCreativeStudioPersonalFixture>>;
let f: Fixture, a: StudioPersonalActor, peer: StudioPersonalActor, foreign: StudioPersonalActor;
function request(raw: unknown): StudioRpc { return StudioRpcSchema.parse(raw); }
const doc = (scope: string, revision: number, value: string) => request({ scope, operation: "state.set", namespace: "app_state", key: studioPersonalDocumentKey, revision, value });
const read = (scope: string) => request({ scope, operation: "state.get", namespace: "app_state", key: studioPersonalDocumentKey });
function dataRead(value: unknown) {
  const packet = StudioPersonalReplySchema.parse(value);
  if (packet.operation !== "state.get") throw new Error("studio_personal_test_read_expected"); return packet.data;
}
function dataWrite(value: unknown) {
  const packet = StudioPersonalReplySchema.parse(value);
  if (packet.operation !== "state.set") throw new Error("studio_personal_test_write_expected"); return packet.data;
}
function status(error: unknown) {
  if (error instanceof HttpException) return error.getStatus();
  if (error && typeof error === "object" && "status" in error && typeof error.status === "number") return error.status;
  return null;
}
async function failure(operation: Promise<unknown>) {
  return operation.then(() => ({ rejected: false, status: null }), error => ({ rejected: true, status: status(error) }));
}

describe("current187 personal Studio real owners and private storage", () => {
  beforeAll(async () => {
    f = await createCreativeStudioPersonalFixture(); a = await f.actor();
    peer = await f.actor(a.tenantId); foreign = await f.actor();
  });
  afterAll(async () => { await f?.close(); });

  it("original_document_and_private_media_roundtrip_uses_personal_OIDC_and_real_S3", async () => {
    const context = await f.current(a), project = await f.project(context), png = await f.image();
    const sessionResponse = await f.http(a, "/v1/identity/session", undefined, context);
    expect(sessionResponse.status).toBe(200);
    const session = ErpSessionViewSchema.parse(await sessionResponse.json());
    expect(session.userId).toBe(a.userId); expect(session.tenantId).toBe(a.tenantId);
    for (const scope of ["unassigned", project.id]) {
      const workspaceResponse = await f.http(a, `/v1/creative-studio/workspace?scope=${scope}`, undefined, context);
      expect(workspaceResponse.status).toBe(200);
      const workspace = StudioWorkspaceSchema.parse(await workspaceResponse.json());
      expect(workspace.scope).toBe(scope); expect(workspace.contextAuthority).toBe(studioPersonalAuthority(context));
      expect(workspaceResponse.headers.get("x-yummyai-context-authority")).toBe(workspace.contextAuthority);
      expect(workspace.capabilities.save).toBe(true); expect(workspace.capabilities.mediaWrite).toBe(true);
      expect(workspace.generation.enabled).toBe(false); expect(workspace.generation.code).toBe("operator_paused");
      const input = doc(scope, 0, "Synthetic original private document " + scope);
      const response = await f.http(a, "/v1/creative-studio/invoke", { version: 1, contextAuthority: workspace.contextAuthority, request: input }, context);
      expect(response.status).toBe(200); expect(dataWrite(await response.json()).revision).toBe(1);
      const restored = dataRead(await f.invoke(context, read(scope)));
      expect("value" in restored).toBe(true);
      if (!("value" in restored)) throw new Error("studio_personal_document_missing");
      expect(studioPersonalSha(JSON.stringify(restored.value))).toBe(studioPersonalSha(JSON.stringify("Synthetic original private document " + scope)));
      const key = "image:personal-" + createEntityId();
      const mediaWrite = dataWrite(await f.invoke(context, request({ scope, operation: "state.set", namespace: "image_files", key, revision: 0,
        media: { contentBase64: png.toString("base64"), mediaType: "image/png" } })));
      expect(mediaWrite.revision).toBe(1); expect(mediaWrite.assetId === null).toBe(false);
      const mediaRead = dataRead(await f.invoke(context, request({ scope, operation: "state.get", namespace: "image_files", key })));
      expect("media" in mediaRead).toBe(true);
      if (!("media" in mediaRead)) throw new Error("studio_personal_media_missing");
      expect(mediaRead.assetId).toBe(mediaWrite.assetId);
      expect(studioPersonalSha(Buffer.from(mediaRead.media.contentBase64, "base64"))).toBe(studioPersonalSha(png));
      const preview = await f.invoke(context, request({ scope, operation: "asset.preview", namespace: "image_files", key }));
      if (preview.operation !== "asset.preview") throw new Error("studio_personal_preview_missing");
      expect(preview.data.mediaType).toBe("image/webp"); expect(Buffer.from(preview.data.contentBase64, "base64").length).toBeGreaterThan(0);
    }
    const facts = await f.facts(context); expect(facts.role).toBe("yummyai_app");
    expect(facts.counts.scans).toBeGreaterThan(0); expect(facts.counts.storageReads).toBeGreaterThan(0);
    expect(facts.counts.generationCalls).toBe(0); expect(facts.counts.dispatchAttempts).toBe(0);
  });

  it("same_scope_revision_has_one_winner_and_a_discarded_save_response_recovers_only_by_read", async () => {
    const context = await f.current(a), project = await f.project(context), scope = project.id;
    await f.invoke(context, doc(scope, 0, "Original revision one"));
    const results = await Promise.allSettled([f.invoke(context, doc(scope, 1, "Concurrent version A")), f.invoke(context, doc(scope, 1, "Concurrent version B"))]);
    expect(results.filter(value => value.status === "fulfilled").length).toBe(1);
    const rejected = results.find(value => value.status === "rejected");
    expect(rejected?.status === "rejected" ? status(rejected.reason) : null).toBe(409);
    const before = await f.address(context, scope, "app_state", studioPersonalDocumentKey);
    expect(before.revision).toBe(2); expect(before.revisions).toEqual([1, 2]);
    const response = await f.http(a, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context),
      request: doc(scope, 2, "Committed original response deliberately discarded") }, context);
    expect(response.status).toBe(200); await response.body?.cancel();
    // This API leaf discards a real successful body. The browser leaf additionally
    // aborts the exact route after its actual upstream commit, without replay.
    const calls = f.counts.originalInvokes;
    const restored = dataRead(await f.invoke(context, read(scope)));
    expect(restored.revision).toBe(3); expect(f.counts.originalInvokes - calls).toBe(1);
    const after = await f.address(context, scope, "app_state", studioPersonalDocumentKey);
    expect(after.revisions).toEqual([1, 2, 3]); expect(after.revision).toBe(3);
  });

  it("same_tenant_other_actor_cross_tenant_and_narrow_incoming_authority_do_not_borrow_access", async () => {
    const context = await f.current(a), own = await f.project(context), peerContext = await f.current(peer), other = await f.project(peerContext);
    await f.invoke(context, doc(own.id, 0, "Synthetic original owner sentinel"));
    for (const actor of [peer, foreign]) {
      const result = await failure(f.personal.workspace(await f.current(actor), { scope: own.id }));
      expect(result.rejected).toBe(true); expect([403, 404]).toContain(result.status);
    }
    const narrow: TenantContext = { ...context, permissions: [Permission.DesignRead, Permission.AssetRead],
      permissionScopes: { [Permission.DesignRead]: "self", [Permission.AssetRead]: "self" }, dataScope: "self" };
    await f.grant(a, f.permissions, "tenant");
    try {
      const limited = await f.personal.workspace(narrow, { scope: own.id }); expect(limited.capabilities.save).toBe(false);
      expect((await failure(f.invoke(narrow, doc(own.id, 1, "Forbidden caller promotion")))).status).toBe(403);
      expect((await failure(f.personal.workspace(narrow, { scope: other.id }))).status).toBe(403);
      const full = await f.current(a), sharedScope = await f.personal.workspace(full, { scope: other.id });
      expect(sharedScope.capabilities.read).toBe(true);
      const missingOtherOwnerValue = dataRead(await f.invoke(full, read(other.id)));
      expect("value" in missingOtherOwnerValue && missingOtherOwnerValue.value === null).toBe(true);
    } finally { await f.grant(a, f.permissions); }
    const { permissionScopes: _scopes, ...legacyAdapter } = context;
    expect(_scopes === undefined).toBe(false);
    expect((await failure(f.personal.workspace(legacyAdapter, { scope: own.id }))).status).toBe(403);
  });

  it("one_fixed_OIDC_token_observes_current_role_and_membership_revocation", async () => {
    const context = await f.current(a), first = await f.http(a, "/v1/creative-studio/workspace", undefined, context);
    expect(first.status).toBe(200); await first.body?.cancel(); const credentialId = f.requests.at(-1)?.credentialId;
    try {
      await f.grant(a, [Permission.DesignRead, Permission.AssetRead]);
      const stale = await f.http(a, "/v1/creative-studio/workspace", undefined, context);
      expect(stale.status).toBe(409); await stale.body?.cancel();
      const current = await f.current(a), response = await f.http(a, "/v1/creative-studio/workspace", undefined, current);
      expect(response.status).toBe(200); expect(StudioWorkspaceSchema.parse(await response.json()).capabilities.save).toBe(false);
      expect(f.requests.at(-1)?.credentialId).toBe(credentialId);
      await f.active(a, false);
      const revoked = await f.http(a, "/v1/creative-studio/workspace", undefined, current);
      expect(revoked.status).toBe(403); await revoked.body?.cancel(); expect(f.requests.at(-1)?.credentialId).toBe(credentialId);
    } finally { await f.active(a, true); await f.grant(a, f.permissions); }
  });

  it.each(["state.get", "asset.preview"] as const)("actual_private_storage_read_then_revocation_never_returns_%s_bytes", async operation => {
    const context = await f.current(a), scope = (await f.project(context)).id, key = "image:late-" + createEntityId(), png = await f.image(7);
    await f.invoke(context, request({ scope, operation: "state.set", namespace: "image_files", key, revision: 0, media: { contentBase64: png.toString("base64"), mediaType: "image/png" } }));
    const hold = f.hold("read"), pending = failure(f.invoke(context, request({ scope, operation, namespace: "image_files", key })));
    try {
      await hold.entered; await f.grant(a, f.permissions.filter(value => value !== Permission.AssetRead)); hold.release();
      const result = await pending; expect(result.rejected).toBe(true); expect(result.status).toBe(403);
    } finally { hold.clear(); await pending; await f.grant(a, f.permissions); }
    expect((await f.address(await f.current(a), scope, "image_files", key)).revision).toBe(1);
  });

  it("actual_private_put_then_revocation_cannot_associate_an_entry_or_rewrite_history", async () => {
    const context = await f.current(a), scope = (await f.project(context)).id, key = "image:late-put-" + createEntityId(), png = await f.image(19);
    const hold = f.hold("put"), writes = f.counts.storageWrites;
    const pending = failure(f.invoke(context, request({ scope, operation: "state.set", namespace: "image_files", key, revision: 0,
      media: { contentBase64: png.toString("base64"), mediaType: "image/png" } })));
    try {
      await hold.entered; expect(f.counts.storageWrites - writes).toBe(1);
      await f.grant(a, f.permissions.filter(value => value !== Permission.AssetWrite)); hold.release();
      const result = await pending; expect(result.rejected).toBe(true); expect(result.status).toBe(403);
    } finally { hold.clear(); await pending; await f.grant(a, f.permissions); }
    const actual = await f.address(await f.current(a), scope, "image_files", key);
    expect(actual.count).toBe(0); expect(actual.revisions.length).toBe(0);
    // The already-put object is not falsely called rolled back. Its exact key is
    // privately tracked and remains owned by the outer disposable bucket teardown.
  });

  it("paid_generation_is_explicitly_paused_and_invalid_inputs_do_not_create_budget_or_queue_work", async () => {
    const context = await f.current(a), before = await f.facts(context);
    const generate = request({ scope: "unassigned", operation: "generate", input: { requestId: createEntityId(), modelId: createEntityId(), capability: "image", selectionRevision: "a".repeat(64), prompt: "Synthetic paused request" } });
    const paused = await f.http(a, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: generate }, context);
    expect(paused.status).toBe(409);
    const error = await paused.json() as { code?: unknown }; expect(error.code).toBe("studio_paid_execution_paused");
    for (const path of ["/v1/creative-studio/workspace?scope=unassigned&tenantId=other", "/v1/creative-studio/workspace?scope=invalid"] ) {
      const response = await f.http(a, path, undefined, context); expect(response.status).toBe(400); await response.body?.cancel();
    }
    const bad = await f.http(a, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: { ...read("unassigned"), tenantId: foreign.tenantId } }, context);
    expect(bad.status).toBe(400); await bad.body?.cancel();
    const after = await f.facts(context);
    expect(after.tables).toEqual(before.tables);
    expect(after.counts.generationCalls - before.counts.generationCalls).toBe(0);
    expect(after.counts.dispatchAttempts - before.counts.dispatchAttempts).toBe(0);
    expect(after.providerCalls).toBe(0); expect(after.workerProcesses).toBe(0);
  });
});
