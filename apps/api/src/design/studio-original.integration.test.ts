import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { CANVAS_BRIDGE } from "@yummyai/contracts/pod/canvas-bridge";
import { StudioPersonalReplySchema, StudioWorkspaceSchema } from "@yummyai/contracts/pod/studio-personal";
import { studioResultIntentKey, type StudioPinnedResultRequest } from "@yummyai/contracts/pod/studio-original";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { studioPersonalAuthority, studioPersonalSha } from "./creative-studio-personal.test-fixture.js";
import { createStudioOriginalFixture } from "./studio-original.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createStudioOriginalFixture>>;
let f: Fixture;
async function outcome(operation: Promise<unknown>) {
  return operation.then(value => ({ ok: true as const, value, status: null }), error => {
    const body = error instanceof HttpException ? error.getResponse() : null;
    return { ok: false as const,
      status: error instanceof HttpException ? error.getStatus() : error && typeof error === "object" && "status" in error ? error.status : null,
      code: body && typeof body === "object" && "code" in body ? body.code : null };
  });
}
async function basis() {
  const actor = await f.actor(), context = await f.current(actor), scope = (await f.project(context)).id;
  return { actor, context, scope };
}
const lookup = (input: StudioPinnedResultRequest) => ({ ...input, operation: "result.lookup" as const });
async function submit(context: TenantContext, input: StudioPinnedResultRequest) {
  const packet = await f.invoke(context, input);
  if (packet.operation !== "result.submit.pinned") throw new Error("studio_original_test_receipt_missing"); return packet.data;
}
function unchangedPaid(before: Awaited<ReturnType<Fixture["facts"]>>, after: Awaited<ReturnType<Fixture["facts"]>>) {
  for (const table of ["creative_studio_generations", "creative_executions", "ai_budget_ledger", "ai_budget_policies", "model_provider_configs", "model_routes"])
    expect(after.tables[table]).toEqual(before.tables[table]);
  expect(after.counts.generationCalls).toBe(0); expect(after.counts.dispatchAttempts).toBe(0);
  expect(after.providerCalls).toBe(0); expect(after.workerProcesses).toBe(0); expect(after.role).toBe("yummyai_app");
}

describe("c14d7a62 original facts and pinned personal handoff in disposable current187", () => {
  beforeAll(async () => { f = await createStudioOriginalFixture(); });
  afterAll(async () => { vi.restoreAllMocks(); await f?.close(); });

  it("inspects actual non-square PNG and EXIF6 JPEG without changing original bytes rights or versions", async () => {
    const { context, scope } = await basis(), before = await f.facts(context), scans = f.counts.scans;
    for (const [bytes, mediaType, orientation] of [[f.media.png, "image/png", 1], [f.media.jpeg, "image/jpeg", 6], [f.media.imageWebp, "image/webp", 1]] as const) {
      const uploaded = await f.upload(context, scope, bytes, mediaType), original = await f.source(context, uploaded.assetId);
      const inspection = await f.inspect(context, scope, uploaded.key);
      expect(inspection.source).toMatchObject({ revision: 1, namespace: "image_files", assetId: uploaded.assetId,
        assetVersion: 1, checksumSha256: studioPersonalSha(bytes), byteSize: bytes.length, mediaType, sourceKind: "owned" });
      expect(inspection.technical).toEqual({ status: "verified", kind: "image", encodedWidth: f.media.width,
        encodedHeight: f.media.height, displayWidth: orientation === 6 ? f.media.height : f.media.width,
        displayHeight: orientation === 6 ? f.media.width : f.media.height, orientation, validation: "full_static_decode" });
      await f.invoke(context, { scope, operation: "asset.preview", namespace: "image_files", key: uploaded.key });
      expect(studioPersonalSha(await f.original(context, uploaded.assetId))).toBe(studioPersonalSha(bytes));
      expect(await f.source(context, uploaded.assetId)).toEqual(original);
      expect((await f.address(context, scope, "image_files", uploaded.key)).revisions).toEqual([1]);
    }
    expect(f.counts.scans - scans).toBeGreaterThanOrEqual(4); unchangedPaid(before, await f.facts(context));
  });

  it("inspects genuine timed WebM rotated MP4 MP3 and PCM WAV without claiming codec decoding", async () => {
    const { context, scope } = await basis(), before = await f.facts(context);
    const video = await f.upload(context, scope, f.media.webm, "video/webm", "video:" + createEntityId());
    const videoInfo = await f.inspect(context, scope, video.key, video.namespace);
    expect(videoInfo.technical).toMatchObject({ status: "verified", kind: "video", encodedWidth: 64, encodedHeight: 48,
      displayWidth: 64, displayHeight: 48, rotation: 0, validation: "container_and_packets" });
    if (videoInfo.technical.status !== "verified" || videoInfo.technical.kind !== "video") throw new Error("studio_original_test_video_missing");
    expect(videoInfo.technical.durationSeconds).toBeCloseTo(f.media.videoDuration, 2);
    const audio = await f.upload(context, scope, f.media.wav, "audio/wav", "audio:" + createEntityId());
    const audioInfo = await f.inspect(context, scope, audio.key, audio.namespace);
    expect(audioInfo.technical).toMatchObject({ status: "verified", kind: "audio", validation: "container_and_packets" });
    if (audioInfo.technical.status !== "verified" || audioInfo.technical.kind !== "audio") throw new Error("studio_original_test_audio_missing");
    expect(audioInfo.technical.durationSeconds).toBeCloseTo(f.media.audioDuration, 2);
    const mp4 = await f.upload(context, scope, f.media.mp4, "video/mp4", "video:mp4-" + createEntityId());
    const mp4Info = await f.inspect(context, scope, mp4.key, mp4.namespace);
    expect(mp4Info.technical).toMatchObject({ status: "verified", kind: "video", encodedWidth: 64, encodedHeight: 48,
      displayWidth: 48, displayHeight: 64, rotation: 90, validation: "container_and_packets" });
    const mp3 = await f.upload(context, scope, f.media.mp3, "audio/mpeg", "audio:mp3-" + createEntityId());
    const mp3Info = await f.inspect(context, scope, mp3.key, mp3.namespace);
    expect(mp3Info.technical).toMatchObject({ status: "verified", kind: "audio", validation: "container_and_packets" });
    if (mp3Info.technical.status !== "verified" || mp3Info.technical.kind !== "audio") throw new Error("studio_original_test_mp3_missing");
    expect(mp3Info.technical.durationSeconds).toBeCloseTo(f.media.mp3Duration, 2);
    expect(await f.original(context, video.assetId)).toEqual(f.media.webm); expect(await f.original(context, audio.assetId)).toEqual(f.media.wav);
    expect(await f.original(context, mp4.assetId)).toEqual(f.media.mp4); expect(await f.original(context, mp3.assetId)).toEqual(f.media.mp3);
    unchangedPaid(before, await f.facts(context));
  });

  it.each(["fake-webm", "fake-mp4", "truncated-wav", "truncated-webm"] as const)("rejects %s uploads and never verifies the same legacy bytes", async kind => {
    const { context, scope } = await basis();
    const bytes = kind === "fake-webm" ? Buffer.from("1a45dfa300000000000000000000000000000000", "hex")
      : kind === "fake-mp4" ? Buffer.from("000000206674797069736f6d0000000069736f6d6d7034320000000000000000", "hex")
        : kind === "truncated-wav" ? f.media.wav.subarray(0, 43) : f.media.webm.subarray(0, f.media.webm.length - 20);
    const mediaType = kind === "fake-mp4" ? "video/mp4" : kind === "truncated-wav" ? "audio/wav" : "video/webm";
    const key = "media:invalid-" + createEntityId(), bad = await outcome(f.upload(context, scope, bytes, mediaType, key));
    expect(bad.ok).toBe(false); expect(bad.status).toBe(422); expect("code" in bad && bad.code).toBe("studio_original_invalid_media");
    expect((await f.address(context, scope, "media_files", key)).count).toBe(0);
    const old = await f.legacy(context, scope, bytes, mediaType), inspection = await f.inspect(context, scope, old.key, old.namespace);
    expect(inspection.technical.status).not.toBe("verified");
    expect(inspection.technical).not.toHaveProperty("encodedWidth"); expect(inspection.technical).not.toHaveProperty("durationSeconds");
    expect(await f.original(context, old.assetId)).toEqual(bytes);
    expect((await f.source(context, old.assetId)).rightsStatus).toBe("unverified");
  });

  it.each(["read", "scan"] as const)("does not return inspected facts after current asset-read revocation during actual %s", async stage => {
    const { actor, context, scope } = await basis(), uploaded = await f.upload(context, scope, f.media.png);
    const hold = f.hold(stage), pending = outcome(f.inspect(context, scope, uploaded.key));
    try {
      await hold.entered; await f.grant(actor, f.permissions.filter(value => value !== Permission.AssetRead)); hold.release();
      const result = await pending; expect(result.ok).toBe(false); expect(result.status).toBe(403);
    } finally { hold.clear(); await pending; await f.grant(actor, f.permissions); }
    expect((await f.address(await f.current(actor), scope, uploaded.namespace, uploaded.key)).revisions).toEqual([1]);
  });

  it.each(["read", "scan"] as const)("does not associate a reference after current authority changes during original %s", async stage => {
    const { actor, context, scope } = await basis(), uploaded = await f.upload(context, "unassigned", f.media.jpeg, "image/jpeg");
    await f.invoke(context, { scope: "unassigned", operation: "asset.review", key: uploaded.key, decision: "approve", sourceReference: "Synthetic approved JPEG source" });
    const hold = f.hold(stage), pending = outcome(f.invoke(context, { scope, operation: "reference.attach", assetId: uploaded.assetId }));
    try {
      await hold.entered; await f.grant(actor, f.permissions.filter(value => value !== Permission.AssetRead)); hold.release();
      const result = await pending; expect(result.ok).toBe(false); expect(result.status).toBe(403);
    } finally { hold.clear(); await pending; await f.grant(actor, f.permissions); }
    expect((await f.address(await f.current(actor), scope, "image_files", "image:asset-" + uploaded.assetId)).count).toBe(0);
    expect(await f.original(await f.current(actor), uploaded.assetId)).toEqual(f.media.jpeg);
  });

  it.each([false, true])("submits a manual PNG with approved-reference=%s through personal OIDC without DesignReview", async approved => {
    const { actor, context: initial, scope } = await basis();
    let originalOwner = actor.userId, uploaded: Awaited<ReturnType<Fixture["upload"]>>;
    if (approved) {
      const owner = await f.actor(actor.tenantId), ownerContext = await f.current(owner); originalOwner = owner.userId;
      uploaded = await f.upload(ownerContext, "unassigned", f.media.png);
      await f.invoke(ownerContext, { scope: "unassigned", operation: "asset.review", key: uploaded.key, decision: "approve", sourceReference: "Synthetic approved shared reference" });
      await f.grant(actor, f.permissions.filter(value => value !== Permission.DesignReview), "tenant");
      const attached = await f.invoke(await f.current(actor), { scope, operation: "reference.attach", assetId: uploaded.assetId });
      if (attached.operation !== "reference.attach") throw new Error("studio_original_test_shared_reference_missing");
      uploaded = { ...uploaded, key: attached.data.key };
    } else {
      uploaded = await f.upload(initial, scope, f.media.png);
      await f.grant(actor, f.permissions.filter(value => value !== Permission.DesignReview));
    }
    const context = await f.current(actor);
    const workspaceResponse = await f.http(actor, "/v1/creative-studio/workspace?scope=" + scope, undefined, context);
    expect(workspaceResponse.status).toBe(200); const workspace = StudioWorkspaceSchema.parse(await workspaceResponse.json());
    expect(workspace.originalHandoffVersion).toBe(1); expect(workspace.capabilities.submit).toBe(true); expect(workspace.capabilities.review).toBe(false);
    const before = await f.facts(context), { input } = await f.pinned(context, scope, uploaded.key);
    const response = await f.http(actor, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: input }, context);
    expect(response.status).toBe(200); const packet = StudioPersonalReplySchema.parse(await response.json());
    expect(packet.operation).toBe("result.submit.pinned");
    const facts = await f.candidates(context, scope);
    expect(facts.candidates).toHaveLength(1); expect(facts.versions).toHaveLength(1); expect(facts.versions[0]!.status).toBe("pending_review");
    expect(facts.assets[0]).toMatchObject({ checksumSha256: studioPersonalSha(f.media.png), byteSize: f.media.png.length, mediaType: "image/png" });
    expect(await f.original(context, uploaded.assetId)).toEqual(f.media.png);
    expect((await f.source(context, uploaded.assetId)).ownerUserId).toBe(originalOwner); unchangedPaid(before, await f.facts(context));
  });

  it("recovers one concurrent committed submission by read only despite current-key replacement and rejects changed original pins", async () => {
    const { actor, context, scope } = await basis(), uploaded = await f.upload(context, scope, f.media.png), { input } = await f.pinned(context, scope, uploaded.key);
    const before = await f.facts(context), [left, right] = await Promise.all([submit(context, input), submit(context, input)]);
    expect(left.candidateId).toBe(right.candidateId); expect(left.versionId).toBe(right.versionId);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    const committed = await f.candidates(context, scope), scans = f.counts.scans, writes = f.counts.storageWrites;
    const recovery = await f.invoke(context, lookup(input));
    expect(recovery.operation).toBe("result.lookup");
    if (recovery.operation !== "result.lookup" || recovery.data.status !== "found") throw new Error("studio_original_test_lookup_missing");
    expect(recovery.data.receipt.candidateId).toBe(left.candidateId); expect(f.counts.storageWrites).toBe(writes); expect(f.counts.scans).toBe(scans);
    for (const changed of [{ ...input, source: { ...input.source, checksumSha256: "0".repeat(64) } }, { ...input, title: "Changed original title" },
      { ...input, sourceReference: "Changed original provenance" }]) {
      const denied = await outcome(f.invoke(context, lookup(changed))); expect(denied.ok).toBe(false); expect(denied.status).toBe(409);
    }
    await f.invoke(context, { scope, operation: "state.set", namespace: "image_files", key: uploaded.key, revision: 1,
      media: { contentBase64: f.media.jpeg.toString("base64"), mediaType: "image/jpeg" } });
    const afterReplacement = await f.invoke(context, lookup(input));
    expect(afterReplacement.operation === "result.lookup" && afterReplacement.data.status === "found").toBe(true);
    const peer = await f.actor(actor.tenantId); await f.grant(peer, f.permissions, "tenant");
    expect((await outcome(f.invoke(await f.current(peer), lookup(input)))).ok).toBe(false);
    await f.grant(actor, f.permissions.filter(value => value !== Permission.AssetRead));
    expect((await outcome(f.invoke(context, lookup(input)))).ok).toBe(false); await f.grant(actor, f.permissions);
    expect(await f.candidates(await f.current(actor), scope)).toEqual(committed); unchangedPaid(before, await f.facts(await f.current(actor)));
  });

  it("requires the durable exact intent and blocks unresolved intent replacement deletion and fabricated confirmation", async () => {
    const { context, scope } = await basis(), uploaded = await f.upload(context, scope, f.media.png), inspection = await f.inspect(context, scope, uploaded.key);
    const input: StudioPinnedResultRequest = { operation: "result.submit.pinned", scope, key: uploaded.key, source: inspection.source,
      title: "Synthetic immutable intent", submissionId: randomUUID(), sourceReference: "Synthetic owned source", rightsAttested: true };
    expect((await outcome(f.invoke(context, input))).status).toBe(409);
    const prepared = await f.prepare(context, input), address = () => f.address(context, scope, "app_state", prepared.key);
    for (const operation of [
      { scope, operation: "state.set", namespace: "app_state", key: prepared.key, revision: 1,
        value: { ...prepared.intent, request: { ...input, submissionId: randomUUID() } } },
      { scope, operation: "state.remove", namespace: "app_state", key: prepared.key, revision: 1 },
      { scope, operation: "state.set", namespace: "app_state", key: prepared.key, revision: 1,
        value: { version: 1, status: "confirmed", request: input,
          receipt: { batchId: scope, candidateId: createEntityId(), versionId: createEntityId(), assetId: uploaded.assetId, replayed: false } } },
    ]) expect((await outcome(f.invoke(context, operation))).ok).toBe(false);
    expect((await address()).revisions).toEqual([1]); expect((await f.candidates(context, scope)).candidates).toHaveLength(0);
    const missing = await f.invoke(context, lookup(input)); expect(missing.operation === "result.lookup" && missing.data.status === "missing").toBe(true);
    expect(studioResultIntentKey(input.source)).toBe(prepared.key);
    await f.invoke(context, { scope, operation: "state.set", namespace: "app_state", key: "studio:prompts", revision: 0,
      value: { syntheticDraft: "Keep this original editable document" } });
    const sourceDocuments = await f.documents(context, scope), sourceMedia = await f.address(context, scope, "image_files", uploaded.key);
    const revised = await f.bridge.revise(context, scope, { requestId: randomUUID(), name: "Synthetic next original brief",
      prompt: "Synthetic next direction without carrying unresolved submission authority", expectedRevision: 1, referenceAssetIds: [] });
    const copied = await f.documents(context, revised.id);
    expect(copied.map(row => row.key)).toContain("studio:prompts"); expect(copied.map(row => row.key)).not.toContain(prepared.key);
    expect((await f.address(context, revised.id, "image_files", uploaded.key)).assetId).toBe(uploaded.assetId);
    expect(await f.documents(context, scope)).toEqual(sourceDocuments);
    expect(await f.address(context, scope, "image_files", uploaded.key)).toEqual(sourceMedia);
  });

  it("rejects the old unpinned personal submission before entering the original owner or creating a candidate", async () => {
    const { context, scope } = await basis(), before = f.counts.originalInvokes, originalSubmit = vi.spyOn(f.bridge, "submit");
    try {
      const result = await outcome(f.invoke(context, { operation: "result.submit", scope, key: "image:legacy", title: "Synthetic forbidden legacy",
        submissionId: randomUUID(), sourceReference: "Synthetic owned source", rightsAttested: true }));
      expect(result.ok).toBe(false); expect(result.status).toBe(409); expect("code" in result && result.code).toBe("studio_original_pin_required");
      expect(f.counts.originalInvokes).toBe(before); expect(originalSubmit).not.toHaveBeenCalled();
      expect((await f.candidates(context, scope)).candidates).toHaveLength(0);
    } finally { originalSubmit.mockRestore(); }
  });

  it("scans the standalone bridge first original once and refuses a first commit after scan-time revocation", async () => {
    const { actor, context, scope } = await basis(), input = { submissionId: randomUUID(), protocolVersion: 1,
      pluginVersion: CANVAS_BRIDGE.pluginVersion, upstreamVersion: CANVAS_BRIDGE.upstreamVersion, sourceNodeId: "synthetic-original-node",
      title: "Synthetic standalone original", contentBase64: f.media.png.toString("base64"), rightsAttested: true,
      sourceKind: "owned", sourceReference: "Synthetic original standalone fixture" };
    const scans = f.counts.scans, first = await f.bridge.submit(context, scope, input);
    expect(f.counts.scans).toBe(scans + 1); const again = await f.bridge.submit(context, scope, input);
    expect(again).toEqual({ ...first, replayed: true }); expect(f.counts.scans).toBe(scans + 1);
    const another = { ...input, submissionId: randomUUID() }, hold = f.hold("scan"), pending = outcome(f.bridge.submit(context, scope, another));
    try {
      await hold.entered; await f.grant(actor, f.permissions.filter(value => value !== Permission.AssetWrite)); hold.release();
      const result = await pending; expect(result.ok).toBe(false); expect(result.status).toBe(403);
    } finally { hold.clear(); await pending; await f.grant(actor, f.permissions); }
    expect((await f.candidates(await f.current(actor), scope)).candidates).toHaveLength(1);
  });
});
