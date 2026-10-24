import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { StudioRpcSchema, type StudioRpc } from "@yummyai/contracts/pod/creative-studio";
import { StudioOriginalInspectionSchema, StudioResultIntentSchema, studioResultIntentKey, type StudioPinnedResultRequest } from "@yummyai/contracts/pod/studio-original";
import { assetFiles, creativeDesignCandidates, creativeDesignVersions, creativeStudioEntries, creativeStudioRevisions,
  memberships, membershipRoles, roles, withTenant } from "@yummyai/database";
import { and, eq, inArray } from "drizzle-orm";
import { requireStudioOriginalEnvironment } from "../../../../tools/testing/require-studio-original-environment.mjs";
import { createCreativeStudioPersonalFixture, studioPersonalSha } from "./creative-studio-personal.test-fixture.js";
import { studioOriginalMedia } from "./studio-original-media.test-fixture.js";
export { studioPersonalSha as studioOriginalFixtureSha } from "./creative-studio-personal.test-fixture.js";

export async function createStudioOriginalFixture(options: Parameters<typeof createCreativeStudioPersonalFixture>[0] = {}) {
  const environment = requireStudioOriginalEnvironment();
  const base = await createCreativeStudioPersonalFixture(options), media = await studioOriginalMedia();
  const restoredRoles = new Map<string, { context: TenantContext; permissions: string[] }>();
  const request = (value: unknown) => StudioRpcSchema.parse(value);
  const invoke = (context: TenantContext, input: unknown) => base.invoke(context, request(input));
  async function upload(context: TenantContext, scope: string, bytes: Buffer, mediaType = "image/png", key = "image:original-" + createEntityId()) {
    const namespace = mediaType.startsWith("image/") ? "image_files" : "media_files";
    const reply = await invoke(context, { scope, operation: "state.set", namespace, key, revision: 0,
      media: { contentBase64: bytes.toString("base64"), mediaType } });
    if (reply.operation !== "state.set" || !reply.data.assetId) throw new Error("studio_original_fixture_upload_missing");
    return { key, namespace, assetId: reply.data.assetId, revision: reply.data.revision };
  }
  async function inspect(context: TenantContext, scope: string, key: string, namespace = "image_files") {
    const packet = await invoke(context, { scope, operation: "asset.inspect", namespace, key });
    if (packet.operation !== "asset.inspect") throw new Error("studio_original_fixture_inspection_missing");
    return StudioOriginalInspectionSchema.parse(packet.data);
  }
  async function prepare(context: TenantContext, input: StudioPinnedResultRequest) {
    const key = studioResultIntentKey(input.source), intent = StudioResultIntentSchema.parse({ version: 1, status: "prepared", request: input });
    await invoke(context, { scope: input.scope, operation: "state.set", namespace: "app_state", key, revision: 0, value: intent });
    return { key, intent };
  }
  async function pinned(context: TenantContext, scope: string, key: string, title = "Synthetic original candidate") {
    const source = (await inspect(context, scope, key)).source;
    const input: StudioPinnedResultRequest = { operation: "result.submit.pinned", scope, key, source, title,
      submissionId: randomUUID(), rightsAttested: true, sourceReference: "Synthetic original owned artwork c14d7a62" };
    return { input, ...await prepare(context, input) };
  }
  /** Explicit legacy fixture admission only. Used to prove invalid old bytes
   * cannot acquire verified metadata by merely having an asset row. */
  async function legacy(context: TenantContext, scope: string, bytes: Buffer, mediaType: string) {
    const assetId = createEntityId(), entryId = createEntityId(), key = "legacy:" + createEntityId();
    const namespace = mediaType.startsWith("image/") ? "image_files" : "media_files";
    const stored = await base.storage.putPrivate(context, { body: bytes, domain: "authorized", fileName: "synthetic-legacy.bin", mediaType });
    await withTenant(base.database.db, context, async tx => {
      await tx.insert(assetFiles).values({ id: assetId, tenantId: context.tenantId, ownerUserId: context.userId,
        objectKey: stored.objectKey, fileName: "synthetic-legacy.bin", mediaType, byteSize: bytes.length,
        checksumSha256: studioPersonalSha(bytes), assetDomain: "authorized", rightsStatus: "unverified", rightsMetadata: { source: { kind: "owned" } } });
      await tx.insert(creativeStudioEntries).values({ id: entryId, tenantId: context.tenantId, ownerId: context.userId, scope, namespace, key, assetId, revision: 1 });
      await tx.insert(creativeStudioRevisions).values({ id: createEntityId(), tenantId: context.tenantId, entryId, revision: 1, assetId });
    });
    return { key, namespace, assetId, entryId };
  }
  async function source(context: TenantContext, assetId: string) {
    return withTenant(base.database.db, context, async tx => {
      const [row] = await tx.select().from(assetFiles).where(eq(assetFiles.id, assetId));
      if (!row) throw new Error("studio_original_fixture_source_missing"); return row;
    });
  }
  async function original(context: TenantContext, assetId: string) {
    const file = await source(context, assetId);
    return Buffer.from(await base.storage.readPrivate(context, { ...file, assetDomain: "authorized" }, { requiredDomain: "authorized" }));
  }
  async function candidates(context: TenantContext, scope: string) {
    const brief = await base.bridge.get(context, scope);
    return withTenant(base.database.db, context, async tx => {
      const rows = await tx.select().from(creativeDesignCandidates).where(eq(creativeDesignCandidates.itemId, brief.itemId));
      const versions = rows.length ? await tx.select().from(creativeDesignVersions).where(inArray(creativeDesignVersions.sourceCandidateId, rows.map(row => row.id))) : [];
      const ids = rows.flatMap(row => row.assetId ? [row.assetId] : []);
      const assets = ids.length ? await tx.select().from(assetFiles).where(inArray(assetFiles.id, ids)) : [];
      return { candidates: rows.map(row => ({ id: row.id, assetId: row.assetId, submissionId: row.parameterSnapshot.submissionId, inputChecksum: row.inputChecksum })),
        versions: versions.map(row => ({ id: row.id, sourceCandidateId: row.sourceCandidateId, status: row.status })),
        assets: assets.map(row => ({ id: row.id, version: row.version, checksumSha256: row.checksumSha256,
          byteSize: row.byteSize, mediaType: row.mediaType, rightsStatus: row.rightsStatus })) };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function documents(context: TenantContext, scope: string) {
    return withTenant(base.database.db, context, async tx => {
      const rows = await tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId),
        eq(creativeStudioEntries.scope, scope), eq(creativeStudioEntries.namespace, "app_state")));
      return rows.map(row => ({ key: row.key, revision: row.revision, value: row.value, deleted: !!row.deletedAt }));
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function noReview(context: TenantContext) {
    await withTenant(base.database.db, context, async tx => {
      const owned = await tx.select({ id: roles.id, permissions: roles.permissions }).from(roles).innerJoin(membershipRoles,
        and(eq(membershipRoles.tenantId, roles.tenantId), eq(membershipRoles.roleId, roles.id)))
        .innerJoin(memberships, and(eq(memberships.tenantId, membershipRoles.tenantId), eq(memberships.id, membershipRoles.membershipId)))
        .where(and(eq(memberships.userId, context.userId), eq(memberships.tenantId, context.tenantId)));
      if (!owned.length) throw new Error("studio_original_fixture_role_missing");
      for (const row of owned) {
        if (!restoredRoles.has(row.id)) restoredRoles.set(row.id, { context, permissions: [...row.permissions] });
        await tx.update(roles).set({ permissions: row.permissions.filter(value => value !== Permission.DesignReview) }).where(eq(roles.id, row.id));
      }
    });
    return base.current(context);
  }
  async function close() {
    let failed = false;
    try {
      for (const [id, row] of restoredRoles) await withTenant(base.database.db, row.context, tx => tx.update(roles).set({ permissions: row.permissions }).where(eq(roles.id, id)));
      restoredRoles.clear();
    } catch { failed = true; }
    try { await base.close(); } catch { failed = true; }
    if (failed) throw new Error("studio_original_fixture_close_failed");
  }
  return { ...base, environment, media, request, invoke, upload, inspect, prepare, pinned, legacy, source, original,
    candidates, documents, noReview, close, parseRequest: (value: unknown): StudioRpc => StudioRpcSchema.parse(value) };
}
