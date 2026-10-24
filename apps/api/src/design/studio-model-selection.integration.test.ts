import { HttpException } from "@nestjs/common";
import { Permission } from "@yummyai/authz";
import { createEntityId } from "@yummyai/contracts";
import { StudioGenerateRequestSchema, type StudioGenerateRequest } from "@yummyai/contracts/pod/creative-studio";
import { StudioPersonalReplySchema } from "@yummyai/contracts/pod/studio-personal";
import { creativeDesignBatches, creativeStudioEntries, creativeStudioRevisions, modelPreferences, modelProviderConfigs, modelRoutes, withTenant } from "@yummyai/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createStudioModelSelectionFixture, modelFixtureNames } from "./studio-model-selection.test-fixture.js";
import { studioPersonalAuthority } from "./creative-studio-personal.test-fixture.js";

type Fixture = Awaited<ReturnType<typeof createStudioModelSelectionFixture>>;
let f: Fixture;
const outcome = (pending: Promise<unknown>) => pending.then(() => ({ status: 200, code: null as unknown }), error => {
  const value = error instanceof HttpException ? error.getResponse() : null;
  return { status: error instanceof HttpException ? error.getStatus() : null,
    code: value && typeof value === "object" && "code" in value ? value.code : null };
});
async function basis() { const actor = await f.actor(), context = await f.current(actor), channel = await f.channel(context);
  return { actor, context, channel, scope: (await f.project(context)).id }; }
function noEffects(before: Awaited<ReturnType<Fixture["facts"]>>, after: Awaited<ReturnType<Fixture["facts"]>>) {
  expect(after.role).toBe("yummyai_app"); expect(after.tables).toEqual(before.tables); expect(after.queueAttempts).toEqual(before.queueAttempts);
  for (const key of ["storageReads", "storageWrites", "scans", "generationCalls", "dispatchAttempts"] as const) expect(after.counts[key]).toBe(before.counts[key]);
  expect(after.providerCalls).toBe(0); expect(after.workerProcesses).toBe(0);
}

describe("c5a8f4d1 exact Studio model capability and selection revision in disposable current188", () => {
  beforeAll(async () => { f = await createStudioModelSelectionFixture(); });
  afterAll(async () => { await f?.close(); });

  it("keeps shared-channel purposes and same-name different routes exact while defaults remain personal", async () => {
    const { actor, context, channel } = await basis();
    const beforeOtherChannel = await f.catalogue(context);
    const duplicate = await f.channel(context, "Synthetic alternate " + createEntityId(), [{ name: modelFixtureNames.video, capability: "video" }]);
    const initial = await f.catalogue(context), selected = initial.find(row => row.id === channel.models.find(model => model.capability === "video")!.id)!;
    for (const model of beforeOtherChannel) expect(initial.find(row => row.id === model.id)!.selectionRevision).toBe(model.selectionRevision);
    await f.defaults(context, { video: selected.id });
    const peer = await f.actor(actor.tenantId, "tenant"), foreign = await f.actor(), peerContext = await f.current(peer), before = await f.facts(context);
    const own = await f.catalogue(context), peers = await f.catalogue(peerContext);
    expect(new Set(own.filter(row => channel.models.some(model => model.id === row.id)).map(row => row.capability))).toEqual(new Set(["image", "video", "text"]));
    const sameName = own.filter(row => row.model === modelFixtureNames.video); expect(sameName).toHaveLength(2);
    expect(new Set(sameName.map(row => row.id))).toEqual(new Set([selected.id, duplicate.models[0]!.id]));
    expect(sameName.find(row => row.id === duplicate.models[0]!.id)!.selectionRevision).not.toBe(selected.selectionRevision);
    expect(own.find(row => row.id === selected.id)).toMatchObject({ capability: "video", isDefault: true, selectionRevision: selected.selectionRevision });
    expect(peers.find(row => row.id === selected.id)).toMatchObject({ capability: "video", isDefault: false, selectionRevision: selected.selectionRevision });
    expect(await f.catalogue(await f.current(foreign))).toEqual([]);
    for (const model of own) expect(model.selectionRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(own)).not.toMatch(/SYNTHETIC_NEVER_DISPATCHED|encryptedApiKey|baseUrl|endpoint/);
    noEffects(before, await f.facts(context));
    await f.grant(actor, f.permissions.filter(value => value !== Permission.ModelConfigure));
    expect(new Set((await f.catalogue(await f.current(actor))).map(row => row.id))).toEqual(new Set(own.map(row => row.id)));
  });

  it("excludes removed and disabled choices and returns a real empty catalogue without static fallbacks", async () => {
    const { context, channel } = await basis(), initial = await f.catalogue(context), removed = channel.models.find(row => row.capability === "video")!;
    await f.remove(context, channel.id, removed.id);
    const remaining = await f.catalogue(context); expect(remaining.some(row => row.id === removed.id)).toBe(false);
    const image = remaining.find(row => row.capability === "image")!;
    expect(image.selectionRevision).not.toBe(initial.find(row => row.id === image.id)!.selectionRevision);
    await f.status(context, channel.id, "disabled"); expect(await f.catalogue(context)).toEqual([]);
    await f.status(context, channel.id, "enabled"); expect((await f.catalogue(context)).map(row => row.id).sort()).toEqual(remaining.map(row => row.id).sort());
    for (const model of (await f.readChannel(context, channel.id)).models) await f.remove(context, channel.id, model.id);
    const before = await f.facts(context); expect(await f.catalogue(context)).toEqual([]); noEffects(before, await f.facts(context));
  });

  it("creates exact image video and text owners and replays only their original input and queue identity", async () => {
    const { actor, context, channel, scope } = await basis(), models = await f.catalogue(context), before = await f.facts(context), ids: string[] = [], inputs: StudioGenerateRequest[] = [];
    for (const capability of ["image", "video", "text"] as const) {
      const selected = models.find(row => row.capability === capability)!, input = await f.request(context, selected.id);
      const first = await f.generations.create(context, scope, input), replay = await f.generations.create(context, scope, input);
      expect(replay.id).toBe(first.id); ids.push(first.id); inputs.push(input);
      const [row] = await f.exactRows(context, [first.id]);
      expect(row).toMatchObject({ ownerId: context.userId, scope, status: "queued", input,
        modelSnapshot: { routeId: selected.id, providerConfigId: channel.id, model: selected.model, capability } });
      expect(await outcome(f.generations.create(context, scope, { ...input, prompt: "Changed original input" }))).toMatchObject({ status: 409 });
    }
    const attempts = f.queueAttempts.slice(before.queueAttempts.length); expect(attempts).toHaveLength(6);
    for (const id of ids) expect(attempts.filter(row => row.id === id)).toEqual([{ id, tenantId: context.tenantId, userId: context.userId }, { id, tenantId: context.tenantId, userId: context.userId }]);
    expect(new Set(attempts.map(row => row.id))).toEqual(new Set(ids)); expect(await f.exactRows(context, ids)).toHaveLength(3);
    const after = await f.facts(context); expect(after.tables.creative_studio_generations!.count - before.tables.creative_studio_generations!.count).toBe(3);
    expect(after.tables.creative_executions!.count - before.tables.creative_executions!.count).toBe(3);
    expect(after.tables.ai_budget_ledger).toEqual(before.tables.ai_budget_ledger); expect(after.providerCalls).toBe(0); expect(after.workerProcesses).toBe(0);
    await f.dependent(context, channel.id);
    const original = inputs[0]!, otherScope = (await f.project(context)).id, readBefore = await f.facts(context);
    expect((await f.catalogue(context)).find(row => row.id === original.modelId)!.selectionRevision).not.toBe(original.selectionRevision);
    expect(await f.generations.originalInput(context, scope, original.requestId)).toEqual(original); noEffects(readBefore, await f.facts(context));
    expect((await f.generations.create(context, scope, original)).id).toBe(ids[0]);
    const replayBefore = await f.facts(context); expect(replayBefore.tables).toEqual(readBefore.tables);
    expect(replayBefore.queueAttempts.slice(readBefore.queueAttempts.length)).toEqual([{ id: ids[0], tenantId: context.tenantId, userId: context.userId }]);
    expect(await outcome(f.generations.originalInput(context, otherScope, original.requestId))).toMatchObject({ status: 409 });
    noEffects(replayBefore, await f.facts(context));
    await f.grant(actor, f.permissions.filter(permission => permission !== Permission.DesignWrite));
    const revoked = await f.current(actor), revokedBefore = await f.facts(revoked);
    await expect(f.generations.originalInput(revoked, scope, original.requestId)).rejects.toThrow(); noEffects(revokedBefore, await f.facts(revoked));
  });

  it("rejects new unpinned wrong-purpose foreign and fabricated selections before any task execution or queue write", async () => {
    const { context, scope } = await basis(), selected = (await f.catalogue(context)).find(row => row.capability === "video")!, input = await f.request(context, selected.id);
    const before = await f.facts(context);
    const { capability: _capability, selectionRevision: _revision, ...legacy } = input; void _capability; void _revision;
    for (const raw of [legacy, { ...input, capability: "audio" }, { ...input, selectionRevision: "A".repeat(64) }])
      expect(await outcome(f.generations.create(context, scope, raw))).toEqual({ status: 400, code: "studio_model_selection_invalid" });
    expect(await outcome(f.generations.create(context, scope, { ...input, capability: "image" }))).toEqual({ status: 400, code: "studio_model_capability_mismatch" });
    expect(await outcome(f.generations.create(context, scope, { ...input, selectionRevision: "0".repeat(64) }))).toEqual({ status: 409, code: "studio_model_selection_changed" });
    expect(await outcome(f.generations.create(context, scope, { ...input, modelId: createEntityId() }))).toMatchObject({ status: 400 });
    const foreign = await f.actor(), foreignContext = await f.current(foreign), foreignBefore = await f.facts(foreignContext);
    expect(await outcome(f.generations.create(foreignContext, "unassigned", input))).toMatchObject({ status: 400 });
    noEffects(foreignBefore, await f.facts(foreignContext)); noEffects(before, await f.facts(context));
  });

  it("does not reuse an old selection after a channel revision purpose change disable or removal", async () => {
    const { context, channel, scope } = await basis(), image = (await f.catalogue(context)).find(row => row.capability === "image")!, original = await f.request(context, image.id);
    await f.changeCapability(context, channel.id, image.id, "video");
    const changed = (await f.catalogue(context)).find(row => row.id === image.id)!; expect(changed.capability).toBe("video"); expect(changed.selectionRevision).not.toBe(image.selectionRevision);
    let before = await f.facts(context);
    expect(await outcome(f.generations.create(context, scope, original))).toEqual({ status: 400, code: "studio_model_capability_mismatch" });
    expect(await outcome(f.generations.create(context, scope, { ...original, capability: "video" }))).toEqual({ status: 409, code: "studio_model_selection_changed" });
    noEffects(before, await f.facts(context));
    const beforeDependency = await f.request(context, changed.id); await f.dependent(context, channel.id); before = await f.facts(context);
    expect((await f.catalogue(context)).find(row => row.id === changed.id)!.selectionRevision).not.toBe(beforeDependency.selectionRevision);
    expect(await outcome(f.generations.create(context, scope, beforeDependency))).toEqual({ status: 409, code: "studio_model_selection_changed" }); noEffects(before, await f.facts(context));
    const disabledInput = await f.request(context, changed.id); await f.status(context, channel.id, "disabled"); before = await f.facts(context);
    expect(await outcome(f.generations.create(context, scope, disabledInput))).toMatchObject({ status: 400 }); noEffects(before, await f.facts(context));
    await f.status(context, channel.id, "enabled"); const removedInput = await f.request(context, changed.id); await f.remove(context, channel.id, changed.id); before = await f.facts(context);
    expect(await outcome(f.generations.create(context, scope, removedInput))).toMatchObject({ status: 400 }); noEffects(before, await f.facts(context));
  });

  it("reads retained legacy inputs without invented pins and rejects a held catalogue after current permission revocation", async () => {
    const { actor, context, scope } = await basis(), selected = (await f.catalogue(context)).find(row => row.capability === "image")!, id = await f.legacy(context, scope, selected);
    const before = await f.facts(context), reply = await f.invoke(context, { operation: "generations", scope });
    expect(reply.operation).toBe("generations");
    if (reply.operation !== "generations") throw new Error("studio_model_fixture_legacy_reply_invalid");
    const retained = reply.data.find(row => row.id === id)!; expect(retained.input).not.toHaveProperty("capability"); expect(retained.input).not.toHaveProperty("selectionRevision");
    expect(StudioPersonalReplySchema.safeParse(reply).success).toBe(true); noEffects(before, await f.facts(context));
    const held = f.hold("invoke");
    try {
      const pending = f.http(actor, "/v1/creative-studio/invoke", { version: 1, contextAuthority: studioPersonalAuthority(context), request: { operation: "models", scope } }, context);
      await held.entered; await f.grant(actor, f.permissions.filter(permission => permission !== Permission.DesignRead)); held.release();
      const response = await pending; expect(response.status).toBe(403); expect(await response.text()).not.toContain(modelFixtureNames.image);
      expect(f.queueAttempts).toEqual(before.queueAttempts);
    } finally { held.clear(); }
    expect(StudioGenerateRequestSchema.safeParse(retained.input).success).toBe(false);
  });

  it("closes only its browser-owned lifecycle through cancellation archival and verified logical deletion", async () => {
    const actor = await f.actor(), context = await f.current(actor), nested = await createStudioModelSelectionFixture({ database: f.database, context });
    try {
      expect(await nested.catalogue(context)).toEqual([]);
      const before = await nested.facts(context), seed = await nested.seed(context), originals = await nested.documents(context, seed.scope);
      const channelIds = [seed.channelId, seed.duplicateChannelId], routeIds = [seed.image.id, seed.video.id, seed.text.id, seed.duplicate.id];
      expect(originals.role).toBe("yummyai_app"); expect(originals.entries).toHaveLength(4);
      expect(originals.entries.every(row => row.revision === 1 && !row.deletedAt)).toBe(true);
      const [running] = await withTenant(f.database.db, context, tx => tx.select({ status: creativeDesignBatches.status }).from(creativeDesignBatches)
        .where(and(eq(creativeDesignBatches.id, seed.scope), eq(creativeDesignBatches.createdBy, context.userId))));
      expect(running?.status).toBe("running");
      const proof = await nested.close();
      expect(proof).toMatchObject({ role: "yummyai_app", channelIds, scopeIds: [seed.scope], projectStates: [{ id: seed.scope, status: "cancelled", archived: true }],
        removedDocuments: 4, retainedRevisions: 8, remainingActiveChannels: 0, remainingActiveRoutes: 0, remainingLiveDocuments: 0,
        remainingVisibleProjects: 0, remainingCatalogueModels: 0, credentialsCleared: true, defaultsCleared: true, retainedHistory: true });
      const actual = await withTenant(f.database.db, context, async tx => {
        const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
        const channels = await tx.select({ id: modelProviderConfigs.id, status: modelProviderConfigs.status, credentialCleared: sql<boolean>`${modelProviderConfigs.encryptedApiKey} = ''` })
          .from(modelProviderConfigs).where(and(inArray(modelProviderConfigs.id, channelIds), eq(modelProviderConfigs.createdBy, context.userId)));
        const routes = await tx.select({ id: modelRoutes.id, status: modelRoutes.status }).from(modelRoutes).where(inArray(modelRoutes.id, routeIds));
        const entries = await tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId), eq(creativeStudioEntries.scope, seed.scope))).orderBy(asc(creativeStudioEntries.id));
        const revisions = await tx.select().from(creativeStudioRevisions).where(inArray(creativeStudioRevisions.entryId, originals.entries.map(row => row.id)))
          .orderBy(asc(creativeStudioRevisions.entryId), asc(creativeStudioRevisions.revision));
        const [project] = await tx.select({ id: creativeDesignBatches.id, status: creativeDesignBatches.status, archivedAt: creativeDesignBatches.archivedAt }).from(creativeDesignBatches)
          .where(and(eq(creativeDesignBatches.id, seed.scope), eq(creativeDesignBatches.createdBy, context.userId)));
        const [preferences] = await tx.select({ defaults: modelPreferences.defaults }).from(modelPreferences).where(eq(modelPreferences.userId, context.userId));
        return { role: role?.role, channels, routes, entries, revisions, project, preferences };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      expect(actual.role).toBe("yummyai_app"); expect(actual.channels).toHaveLength(2); expect(actual.routes).toHaveLength(4);
      expect(actual.channels.every(row => row.status === "deleted" && row.credentialCleared)).toBe(true); expect(actual.routes.every(row => row.status === "disabled")).toBe(true);
      expect(Object.values(actual.preferences?.defaults ?? {}).every(value => value === null)).toBe(true);
      expect(actual.entries).toHaveLength(4); expect(actual.revisions).toHaveLength(8);
      for (const original of originals.entries) {
        expect(actual.entries.find(row => row.id === original.id)).toMatchObject({ revision: 2, value: null, assetId: null, deletedAt: expect.any(Date) });
        expect(actual.revisions.find(row => row.entryId === original.id && row.revision === 1)).toMatchObject({ value: original.value, assetId: original.assetId });
        expect(actual.revisions.find(row => row.entryId === original.id && row.revision === 2)).toMatchObject({ value: null, assetId: null });
      }
      expect(actual.project).toMatchObject({ id: seed.scope, status: "cancelled", archivedAt: expect.any(Date) });
      expect(await f.catalogue(context)).toEqual([]); expect((await f.bridge.projectSummaries(context)).some(row => row.id === seed.scope)).toBe(false);
      const after = await f.facts(context);
      for (const table of ["creative_studio_generations", "creative_executions", "ai_budget_ledger", "ai_budget_policies"]) expect(after.tables[table]).toEqual(before.tables[table]);
      expect(nested.queueAttempts).toEqual([]);
      for (const key of ["storageReads", "storageWrites", "scans", "generationCalls", "dispatchAttempts"] as const) expect(nested.counts[key]).toBe(0);
      expect(await nested.close()).toEqual(proof);
    } finally { await nested.close(); }
  });
});
