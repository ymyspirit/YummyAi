import { randomUUID } from "node:crypto";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { StudioRpcSchema, type StudioRpc } from "@yummyai/contracts/pod/creative-studio";
import { StudioTransferLookupSchema, StudioTransferRequestSchema, type StudioTransferRequest } from "@yummyai/contracts/pod/studio-document-transfer";
import { StudioOriginalInspectionSchema, StudioResultIntentSchema, studioResultIntentKey } from "@yummyai/contracts/pod/studio-original";
import { assetFiles, creativeStudioEntries, creativeStudioRevisions, creativeStudioTransfers, withTenant } from "@yummyai/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Storage } from "@yummyai/storage";
import { requireStudioDocumentTransferEnvironment } from "../../../../tools/testing/require-studio-document-transfer-environment.mjs";
import { createCreativeStudioPersonalFixture, studioPersonalSha } from "./creative-studio-personal.test-fixture.js";
import { studioOriginalMedia } from "./studio-original-media.test-fixture.js";

export const transferCanvasKey = "infinite-canvas:canvas_store", transferAssetKey = "infinite-canvas:asset_store";
export const transferImageDraftKey = "infinite-canvas:image_draft", transferVideoDraftKey = "infinite-canvas:video_draft";
export const transferFixtureDate = "2026-10-24T00:00:00.000Z";
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
export function transferDocumentValue(value: unknown): unknown {
  if (value && typeof value === "object" && "studioDocument" in value && "data" in value) value = value.data;
  return typeof value === "string" ? JSON.parse(value) as unknown : value;
}

/** Real personal Studio owners, private S3 and ClamAV. Only the additional HEAD
 * observation is wrapped; no transfer owner, storage result or queue is faked. */
export async function createStudioDocumentTransferFixture(options: Parameters<typeof createCreativeStudioPersonalFixture>[0] = {}) {
  const environment = requireStudioDocumentTransferEnvironment();
  const media = await studioOriginalMedia(), base = await createCreativeStudioPersonalFixture(options);
  const actors: Array<Pick<TenantContext, "tenantId" | "userId">> = options.context ? [options.context] : [];
  const headCounts = { calls: 0 }, headAssets: Array<{ tenantId: string; id: string; objectKey: string }> = [];
  const actualInspect = base.storage.inspectPrivate.bind(base.storage), releases = new Set<() => void>();
  let headHook: (() => Promise<void>) | undefined, closed = false;
  base.storage.inspectPrivate = async (...args: Parameters<Storage["inspectPrivate"]>) => {
    const result = await actualInspect(...args);
    headCounts.calls++; headAssets.push({ tenantId: args[0].tenantId, id: args[1].id, objectKey: args[1].objectKey });
    await headHook?.(); return result;
  };
  async function actor(...args: Parameters<typeof base.actor>) { const value = await base.actor(...args); actors.push(value); return value; }
  const invoke = (context: TenantContext, raw: unknown) => base.invoke(context, StudioRpcSchema.parse(raw));
  async function upload(context: TenantContext, scope: string, bytes: Buffer, mediaType: string, key: string) {
    const namespace = mediaType.startsWith("image/") ? "image_files" as const : "media_files" as const;
    const result = await invoke(context, { operation: "state.set", scope, namespace, key, revision: 0,
      media: { mediaType, contentBase64: bytes.toString("base64") } });
    if (result.operation !== "state.set" || !result.data.assetId) throw new Error("studio_transfer_fixture_upload_missing");
    return { key, namespace, assetId: result.data.assetId, revision: result.data.revision, mediaType, bytes: bytes.length, checksumSha256: studioPersonalSha(bytes) };
  }
  async function save(context: TenantContext, scope: string, key: string, value: unknown, revision = 0, namespace: "app_state" | "image_generation_logs" | "video_generation_logs" = "app_state") {
    const reply = await invoke(context, { operation: "state.set", scope, namespace, key, revision, value });
    if (reply.operation !== "state.set") throw new Error("studio_transfer_fixture_save_missing"); return reply.data;
  }
  async function read(context: TenantContext, scope: string, key: string, namespace: "app_state" | "image_generation_logs" | "video_generation_logs" = "app_state") {
    const reply = await invoke(context, { operation: "state.get", scope, namespace, key });
    if (reply.operation !== "state.get" || !("value" in reply.data)) throw new Error("studio_transfer_fixture_document_missing");
    return { revision: reply.data.revision, value: transferDocumentValue(reply.data.value) };
  }
  async function preview(context: TenantContext, scope: string, targetScope: string) {
    const reply = await invoke(context, { operation: "document.preview", scope, targetScope });
    if (reply.operation !== "document.preview") throw new Error("studio_transfer_fixture_preview_missing"); return reply.data;
  }
  async function transfer(context: TenantContext, operation: "document.prepare" | "document.commit" | "document.lookup" | "document.cancel", request: StudioTransferRequest) {
    const reply = await invoke(context, { operation, ...StudioTransferRequestSchema.parse(request) });
    if (reply.operation !== operation) throw new Error("studio_transfer_fixture_reply_missing"); return StudioTransferLookupSchema.parse(reply.data);
  }
  async function request(context: TenantContext, scope: string, targetScope: string, requestId = randomUUID()) {
    const summary = await preview(context, scope, targetScope);
    return { summary, input: StudioTransferRequestSchema.parse({ scope, targetScope, requestId, manifestHash: summary.manifestHash }) };
  }
  function holdHead() {
    if (headHook) throw new Error("studio_transfer_fixture_head_already_held");
    const entered = deferred(), released = deferred(); let used = false;
    const release = () => { released.resolve(); releases.delete(release); }; releases.add(release);
    headHook = async () => { if (!used) { used = true; entered.resolve(); await released.promise; } };
    return { entered: entered.promise, release, clear() { release(); headHook = undefined; } };
  }
  async function snapshot(context: TenantContext, scope: string) {
    return withTenant(base.database.db, context, async tx => {
      const entries = await tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, scope)))
        .orderBy(asc(creativeStudioEntries.namespace), asc(creativeStudioEntries.key));
      const revisions = entries.length ? await tx.select().from(creativeStudioRevisions).where(inArray(creativeStudioRevisions.entryId, entries.map(row => row.id)))
        .orderBy(asc(creativeStudioRevisions.entryId), asc(creativeStudioRevisions.revision)) : [];
      const assetIds = [...new Set(entries.flatMap(row => row.assetId ? [row.assetId] : []))];
      const files = assetIds.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, assetIds)).orderBy(asc(assetFiles.id)) : [];
      return { entries, revisions, files, sha256: studioPersonalSha(JSON.stringify({ entries, revisions, files })) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function transfers(context: TenantContext) {
    return withTenant(base.database.db, context, tx => tx.select().from(creativeStudioTransfers).orderBy(asc(creativeStudioTransfers.id)),
      { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function original(context: TenantContext, assetId: string) {
    const row = await withTenant(base.database.db, context, async tx => (await tx.select().from(assetFiles).where(eq(assetFiles.id, assetId)))[0]);
    if (!row) throw new Error("studio_transfer_fixture_original_missing");
    return Buffer.from(await base.storage.readPrivate(context, { ...row, assetDomain: "authorized" }, { requiredDomain: "authorized" }));
  }
  async function resultIntent(context: TenantContext, scope: string, key: string) {
    const inspected = await invoke(context, { operation: "asset.inspect", scope, namespace: "image_files", key });
    if (inspected.operation !== "asset.inspect") throw new Error("studio_transfer_fixture_original_pin_missing");
    const source = StudioOriginalInspectionSchema.parse(inspected.data).source;
    const intent = StudioResultIntentSchema.parse({ version: 1, status: "prepared", request: { operation: "result.submit.pinned", scope, key, source,
      submissionId: randomUUID(), title: "Synthetic source intent stays here", rightsAttested: true, sourceReference: "Synthetic document transfer owned artwork" } });
    const intentKey = studioResultIntentKey(source); await save(context, scope, intentKey, intent); return { key: intentKey, intent };
  }
  async function schemaEvidence() {
    const [row] = await base.database.client.unsafe("select current_database() as name,current_user as role,(select count(*)::int from drizzle.__drizzle_migrations) as migrations");
    if (!row || row.name !== environment.name || row.role === "yummyai_app" || row.migrations !== 188)
      throw new Error("studio_transfer_fixture_requires_disposable_owner_current188");
    const [application] = await withTenant(base.database.db, { tenantId: createEntityId(), userId: createEntityId(), permissions: [], dataScope: "self" }, tx => tx.execute<{ role: string }>(sql`select current_user as role`));
    if (application?.role !== "yummyai_app") throw new Error("studio_transfer_fixture_requires_application_role");
    return { database: row.name as string, migrations: row.migrations as number, applicationRole: application.role };
  }
  async function seed(context: TenantContext, scope: string, label: "source" | "target", allMedia = label === "source") {
    const png = await upload(context, scope, media.png, "image/png", "image:transfer-main");
    const uploaded = [png];
    if (allMedia) for (const [key, bytes, mediaType] of [
      ["image:transfer-jpeg", media.jpeg, "image/jpeg"], ["image:transfer-webp", media.imageWebp, "image/webp"],
      ["video:transfer-mp4", media.mp4, "video/mp4"], ["video:transfer-webm", media.webm, "video/webm"],
      ["audio:transfer-wav", media.wav, "audio/wav"], ["audio:transfer-mp3", media.mp3, "audio/mpeg"],
    ] as const) uploaded.push(await upload(context, scope, bytes, mediaType, key));
    const video = uploaded.find(value => value.mediaType === "video/mp4"), audio = uploaded.find(value => value.mediaType === "audio/wav");
    const legacyDataUri = "data:image/png;base64," + media.png.toString("base64");
    const literal = `${label} ordinary text mentions canvas-collision node-image image:transfer-main without being a reference`;
    const reference = { id: "reference-collision", name: `${label} native reference`, type: "image/png", dataUrl: "", storageKey: png.key };
    const nodes: Array<Record<string, unknown>> = [
      { id: "node-group", type: "group", title: `${label} group`, position: { x: -40, y: -40 }, width: 1000, height: 600 },
      { id: "node-image", type: "image", title: `${label} image`, position: { x: 12, y: 34 }, width: 320, height: 180,
        metadata: { status: "success", content: "", storageKey: png.key, naturalWidth: media.width, naturalHeight: media.height, bytes: png.bytes, mimeType: png.mediaType,
          groupId: "node-group", images: [{ id: "variant-collision", status: "success", content: "", storageKey: png.key,
            naturalWidth: media.width, naturalHeight: media.height, bytes: png.bytes, mimeType: png.mediaType }], primaryImageId: "variant-collision",
          references: [png.key, legacyDataUri] } },
      { id: "node-text", type: "text", title: `${label} text`, position: { x: 400, y: 20 }, width: 300, height: 220, metadata: { content: literal, status: "success" } },
      { id: "node-legacy", type: "image", title: `${label} embedded legacy`, position: { x: 730, y: 20 }, width: 80, height: 45,
        metadata: { content: legacyDataUri, naturalWidth: media.width, naturalHeight: media.height, bytes: media.png.length, mimeType: "image/png", status: "success" } },
    ];
    if (video) nodes.push({ id: "node-video", type: "video", title: `${label} video`, position: { x: 15, y: 250 }, width: 160, height: 120,
      metadata: { content: "", storageKey: video.key, mimeType: video.mediaType, bytes: video.bytes, naturalWidth: media.videoWidth, naturalHeight: media.videoHeight,
        durationMs: media.videoDuration * 1000, status: "success", references: ["video:transfer-webm"] } });
    if (audio) nodes.push({ id: "node-audio", type: "audio", title: `${label} audio`, position: { x: 200, y: 250 }, width: 300, height: 80,
      metadata: { content: "", storageKey: audio.key, mimeType: audio.mediaType, bytes: audio.bytes, durationMs: media.audioDuration * 1000,
        status: "success", references: ["audio:transfer-mp3"] } });
    const canvas = { version: 0, state: { projects: [{ id: "canvas-collision", title: `${label} native canvas`, createdAt: transferFixtureDate, updatedAt: transferFixtureDate,
      nodes, connections: [{ id: "connection-collision", fromNodeId: "node-image", toNodeId: "node-text" }],
      chatSessions: [{ id: "chat-collision", title: `${label} chat`, createdAt: transferFixtureDate, updatedAt: transferFixtureDate,
        messages: [{ id: "message-collision", role: "user", text: literal, references: [
          { id: "chat-image", type: "image", title: `${label} chat original`, storageKey: png.key, dataUrl: "" },
          { id: "chat-legacy", type: "image", title: `${label} chat embedded`, dataUrl: legacyDataUri },
        ] }] }], activeChatId: "chat-collision", viewport: { x: -250, y: 140, k: 0.63 }, backgroundMode: "lines", showImageInfo: true,
    }], deletedProjects: [{ id: "target-only-tombstone", deletedAt: transferFixtureDate }] } };
    const assetBase = { coverUrl: "", tags: [label, "synthetic-transfer"], source: `${label} owned`, note: `${label} note`, createdAt: transferFixtureDate, updatedAt: transferFixtureDate };
    const assets = { version: 0, state: { assets: [
      { ...assetBase, id: "prompt-collision", kind: "text", title: `${label} prompt`, data: { content: literal } },
      { ...assetBase, id: "asset-collision", kind: "image", title: `${label} asset`, data: { dataUrl: "", storageKey: png.key,
        width: media.width, height: media.height, bytes: png.bytes, mimeType: png.mediaType }, metadata: { erpOriginalAssetId: png.assetId, erpOriginalStatus: "unknown" } },
      ...(video ? [{ ...assetBase, id: "video-asset-collision", kind: "video", title: `${label} video asset`, data: { url: "", storageKey: video.key,
        width: media.videoWidth, height: media.videoHeight, bytes: video.bytes, mimeType: video.mediaType } }] : []),
    ] } };
    const imageDraft = { version: 1, drafts: [{ id: "image-draft-collision", prompt: `${label} unsent image ${literal}`, references: [reference],
      config: { model: "synthetic-history-image", imageModel: "synthetic-history-image", quality: "medium", size: "640x360", count: "2" } }], activeId: "image-draft-collision" };
    const videoDraft = { version: 1, drafts: [{ id: "video-draft-collision", prompt: `${label} unsent video ${literal}`, references: [reference],
      config: { model: "synthetic-history-video", videoModel: "synthetic-history-video", size: "640x360", vquality: "720p", videoSeconds: "4", videoGenerateAudio: "false", videoWatermark: "false", videoMode: "image" } }], activeId: "video-draft-collision" };
    const imageLog = { id: "image-log-collision", createdAt: Date.parse(transferFixtureDate), title: `${label} image history`, prompt: literal, time: "00:00", model: "synthetic-history-image",
      config: imageDraft.drafts[0]!.config, references: [reference], durationMs: 1, successCount: 1, failCount: 0, imageCount: 1, size: "640x360", quality: "medium", status: "success",
      images: [{ id: "generated-image-collision", dataUrl: "", storageKey: png.key, durationMs: 1, width: media.width, height: media.height, bytes: png.bytes, mimeType: png.mediaType }] };
    const videoLog = { id: "video-log-collision", createdAt: Date.parse(transferFixtureDate), title: `${label} pending history`, prompt: literal, time: "00:00", model: "synthetic-history-video",
      config: videoDraft.drafts[0]!.config, references: [reference], durationMs: 1, size: "640x360", resolution: "720p", seconds: "4", status: "pending",
      task: { id: `${label}-synthetic-provider-task`, provider: "openai", model: "synthetic-history-video" },
      ...(video ? { video: { id: "generated-video-collision", url: "", storageKey: video.key, durationMs: 1, width: media.videoWidth, height: media.videoHeight, bytes: video.bytes, mimeType: video.mediaType } } : {}),
    };
    // Use the same mixed string/object forms the adopted native persistence emits.
    await save(context, scope, transferCanvasKey, JSON.stringify(canvas)); await save(context, scope, transferAssetKey, JSON.stringify(assets));
    await save(context, scope, transferImageDraftKey, imageDraft); await save(context, scope, transferVideoDraftKey, videoDraft);
    await save(context, scope, imageLog.id, imageLog, 0, "image_generation_logs"); await save(context, scope, videoLog.id, videoLog, 0, "video_generation_logs");
    return { uploaded, canvas, assets, imageDraft, videoDraft, imageLog, videoLog, legacyDataUri, literal, reference };
  }
  async function close() {
    if (closed) return; closed = true; const failures: string[] = [];
    for (const release of releases) release(); headHook = undefined; base.storage.inspectPrivate = actualInspect;
    try {
      const guarded = requireStudioDocumentTransferEnvironment();
      const [identity] = await base.database.client.unsafe("select current_database() as name,current_user as role");
      if (guarded.name !== environment.name || identity?.name !== environment.name || identity?.role === "yummyai_app") throw new Error("cleanup_identity_invalid");
      for (const value of actors) {
        await base.database.client.unsafe("delete from creative_studio_transfers where tenant_id=$1 and owner_id=$2", [value.tenantId, value.userId]);
        const [remaining] = await base.database.client.unsafe("select count(*)::int as count from creative_studio_transfers where tenant_id=$1 and owner_id=$2", [value.tenantId, value.userId]);
        if (remaining?.count !== 0) throw new Error("cleanup_transfer_rows_remaining");
      }
    } catch { failures.push("owned_transfer_cleanup"); }
    try { await base.close(); } catch { failures.push("base_close"); }
    if (failures.length) throw new Error("studio_transfer_fixture_close_failed:" + failures.join(","));
  }
  return { ...base, environment, actor, invoke, upload, save, read, preview, transfer, request, holdHead, snapshot, transfers, original, resultIntent,
    media, seed, schemaEvidence, headCounts, headAssets, copy, close, parseRequest: (value: unknown): StudioRpc => StudioRpcSchema.parse(value) };
}
