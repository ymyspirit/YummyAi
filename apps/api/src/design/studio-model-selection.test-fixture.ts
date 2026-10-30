import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { createEnvironmentSecretVault } from "@yummyai/ai-core";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { emptyModelDefaults, type ConfigurationSnapshot, type ConfiguredChannel } from "@yummyai/contracts/ai/model-configuration";
import { StudioGenerateRequestSchema, StudioGenerateSchema, type StudioGenerateRequest } from "@yummyai/contracts/pod/creative-studio";
import { StudioModelSchema, type StudioModel } from "@yummyai/contracts/pod/studio-personal";
import { creativeDesignBatches, creativeStudioEntries, creativeStudioGenerations, creativeStudioRevisions, modelPreferences, modelProviderConfigs, modelRoutes, withTenant } from "@yummyai/database";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { requireStudioModelSelectionEnvironment } from "../../../../tools/testing/studio-model-selection-environment.mjs";
import { ModelConfigurationService } from "../ai/model-configuration.service.js";
import { createCreativeStudioPersonalFixture } from "./creative-studio-personal.test-fixture.js";
import { StudioGenerationService } from "./studio-generation.service.js";

export type StudioModelFixtureChannel = ConfiguredChannel;
export const modelFixtureDate = 1_792_780_000_000;
export const modelFixtureNames = { image: "synthetic-video-looking-image", video: "synthetic-image-looking-video", text: "synthetic-image-looking-text" } as const;
export type StudioModelFixtureSeed = {
  scope: string; channelId: string; duplicateChannelId: string; image: StudioModel; video: StudioModel; text: StudioModel; duplicate: StudioModel;
  imagePrompt: string; videoPrompt: string; canvasTitle: string;
};
export type StudioModelBrowserCleanup = {
  role: "yummyai_app"; channelIds: string[]; scopeIds: string[]; removedDocuments: number; retainedRevisions: number;
  projectStates: Array<{ id: string; status: "cancelled"; archived: true }>;
  remainingActiveChannels: 0; remainingActiveRoutes: 0; remainingLiveDocuments: 0; remainingVisibleProjects: 0;
  remainingCatalogueModels: 0; credentialsCleared: true; defaultsCleared: true; retainedHistory: true;
};
export type StudioModelCleanupPhase = "authority" | "documents" | "archive" | "channels" | "verification" | "base_close";
const cleanupFailure = (phase: StudioModelCleanupPhase, cause: unknown) => new Error(`studio_model_fixture_cleanup_${phase}_failed`, { cause });

/** Real membership/RLS, configuration and generation owners. Only the queue is
 * an in-memory recorder: no Worker, provider client or external processor exists. */
export async function createStudioModelSelectionFixture(options: Parameters<typeof createCreativeStudioPersonalFixture>[0] = {}) {
  const environment = requireStudioModelSelectionEnvironment(), vault = createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config");
  const base = await createCreativeStudioPersonalFixture(options);
  const ownedChannels = new Map<string, string[]>(), ownedScopes = new Set<string>();
  let closing: Promise<StudioModelBrowserCleanup | null> | undefined;
  const queueAttempts: Array<{ id: string; tenantId: string; userId: string }> = [];
  const configuration = new ModelConfigurationService(base.database, vault);
  const generations = new StudioGenerationService(base.database, base.storage, { async enqueue(input) { queueAttempts.push({ ...input }); } }, base.bridge);
  async function current(actor: Parameters<typeof base.current>[0]) {
    const value = await base.current(actor);
    return TenantContextSchema.strict().parse({
      tenantId: value.tenantId, userId: value.userId, permissions: value.permissions, dataScope: value.dataScope,
      ...(value.teamId !== undefined ? { teamId: value.teamId } : {}),
      ...(value.teamIds !== undefined ? { teamIds: value.teamIds } : {}),
      ...(value.teamAuthority !== undefined ? { teamAuthority: value.teamAuthority } : {}),
      ...(value.permissionScopes !== undefined ? { permissionScopes: value.permissionScopes } : {}),
    });
  }
  function browserIdentity(context: TenantContext) {
    if (options.context && (context.tenantId !== options.context.tenantId || context.userId !== options.context.userId)) throw new Error("studio_model_fixture_browser_owner_changed");
  }
  const configure = (context: TenantContext, input: unknown) => configuration.invoke(context, input) as Promise<ConfigurationSnapshot>;
  async function catalogue(context: TenantContext) { return StudioModelSchema.array().parse(await generations.models(context)); }
  async function channel(context: TenantContext, name = "Synthetic shared " + createEntityId(), models: Array<{ name: string; capability: "image" | "video" | "text"; label?: string }> = [
    { name: modelFixtureNames.image, capability: "image" as const }, { name: modelFixtureNames.video, capability: "video" as const },
    { name: modelFixtureNames.text, capability: "text" as const },
  ]) {
    browserIdentity(context);
    const snapshot = await configure(context, { operation: "channel.save", name, baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "SYNTHETIC_NEVER_DISPATCHED_c5a8f4d1", models });
    const saved = snapshot.channels.find(row => row.name === name); if (!saved) throw new Error("studio_model_fixture_channel_missing");
    if (options.context) ownedChannels.set(saved.id, saved.models.map(model => model.id));
    return saved;
  }
  async function readChannel(context: TenantContext, id: string) {
    const snapshot = await configure(context, { operation: "configuration.get" }), selected = snapshot.channels.find(row => row.id === id);
    if (!selected) throw new Error("studio_model_fixture_channel_missing"); return selected;
  }
  async function status(context: TenantContext, id: string, value: "enabled" | "disabled") {
    const selected = await readChannel(context, id); return configure(context, { operation: "channel.status", id, revision: selected.revision, status: value });
  }
  async function changeCapability(context: TenantContext, id: string, modelId: string, capability: "image" | "video" | "text") {
    const selected = await readChannel(context, id); return configure(context, { operation: "channel.save", id, revision: selected.revision,
      name: selected.name, baseUrl: selected.baseUrl, models: selected.models.map(model => model.id === modelId ? { ...model, capability } : model) });
  }
  async function remove(context: TenantContext, id: string, modelId: string) {
    const selected = await readChannel(context, id); return configure(context, { operation: "model.remove", channelId: id, modelId, revision: selected.revision });
  }
  async function dependent(context: TenantContext, channelId: string) {
    const id = createEntityId();
    // Explicit synthetic retained dependency: even a disabled non-picker route
    // belongs to this exact channel revision. No execution or price is created.
    await withTenant(base.database.db, context, tx => tx.insert(modelRoutes).values({ id, tenantId: context.tenantId,
      modelKey: "Synthetic retained dependency " + id, taskType: "studio_analysis", status: "disabled",
      targets: [{ providerConfigId: channelId, providerModel: "synthetic-retained-analysis", timeoutMs: 1000 }] }));
    return id;
  }
  async function defaults(context: TenantContext, values: Partial<Record<"image" | "video" | "text", string | null>>) {
    const snapshot = await configure(context, { operation: "configuration.get" });
    return configure(context, { operation: "defaults.save", revision: snapshot.defaultsRevision, defaults: { ...emptyModelDefaults(), ...values } });
  }
  async function request(context: TenantContext, modelId: string, patch: Partial<StudioGenerateRequest> = {}) {
    const selected = (await catalogue(context)).find(model => model.id === modelId); if (!selected) throw new Error("studio_model_fixture_route_missing");
    return StudioGenerateRequestSchema.parse({ requestId: randomUUID(), modelId: selected.id, capability: selected.capability,
      selectionRevision: selected.selectionRevision, prompt: "Synthetic exact model selection only", ...patch });
  }
  async function rows(context: TenantContext) {
    return withTenant(base.database.db, context, tx => tx.select().from(creativeStudioGenerations)
      .where(eq(creativeStudioGenerations.ownerId, context.userId)).orderBy(asc(creativeStudioGenerations.id)));
  }
  async function facts(context: TenantContext) { return { ...await base.facts(context), queueAttempts: queueAttempts.map(row => ({ ...row })) }; }
  async function documents(context: TenantContext, scope: string) {
    return withTenant(base.database.db, context, async tx => {
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      if (role?.role !== "yummyai_app") throw new Error("studio_model_fixture_non_owner_required");
      const entries = await tx.select().from(creativeStudioEntries).where(and(eq(creativeStudioEntries.ownerId, context.userId),
        eq(creativeStudioEntries.scope, scope))).orderBy(asc(creativeStudioEntries.namespace), asc(creativeStudioEntries.key), asc(creativeStudioEntries.id));
      return { role: role.role, entries };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function legacy(context: TenantContext, scope: string, selected: StudioModel) {
    const selectedChannel = (await configure(context, { operation: "configuration.get" })).channels.find(row => row.models.some(model => model.id === selected.id));
    if (!selectedChannel) throw new Error("studio_model_fixture_channel_missing");
    const id = createEntityId(), input = StudioGenerateSchema.parse({ requestId: randomUUID(), modelId: selected.id, prompt: "Synthetic retained legacy generation" });
    await withTenant(base.database.db, context, tx => tx.insert(creativeStudioGenerations).values({ id, tenantId: context.tenantId, ownerId: context.userId,
      scope, requestId: input.requestId, input, modelSnapshot: { providerConfigId: selectedChannel.id, routeId: selected.id, model: selected.model,
        capability: selected.capability }, references: [], status: "failed", error: "studio_fixture_retained_legacy" }));
    return id;
  }
  async function seed(context: TenantContext): Promise<StudioModelFixtureSeed> {
    browserIdentity(context);
    const first = await channel(context), duplicate = await channel(context, "Synthetic duplicate name " + createEntityId(), [{ name: modelFixtureNames.video, capability: "video" }]);
    const listed = await catalogue(context), image = listed.find(row => first.models.some(model => model.id === row.id) && row.capability === "image")!,
      video = listed.find(row => first.models.some(model => model.id === row.id) && row.capability === "video")!,
      text = listed.find(row => first.models.some(model => model.id === row.id) && row.capability === "text")!,
      secondVideo = listed.find(row => duplicate.models.some(model => model.id === row.id))!;
    if (!image || !video || !text || !secondVideo) throw new Error("studio_model_fixture_seed_missing");
    await defaults(context, { image: image.id, video: video.id, text: text.id });
    const scope = (await base.project(context)).id, imagePrompt = "Synthetic image draft c5a8f4d1", videoPrompt = "Synthetic video draft c5a8f4d1", canvasTitle = "Synthetic model selection canvas";
    if (options.context) ownedScopes.add(scope);
    const value = (model: StudioModel) => `${model.id}::${model.model}`;
    // The old video draft deliberately names an image route. It must remain
    // inspectable as an invalid choice until the operator explicitly repairs it.
    await base.invoke(context, { scope, operation: "state.set", namespace: "app_state", key: "infinite-canvas:image_draft", revision: 0,
      value: { version: 1, drafts: [{ id: "model-image-original", prompt: imagePrompt, references: [], config: { model: value(image), imageModel: value(image), size: "640x360", quality: "medium", count: "1" } }], activeId: "model-image-original" } });
    await base.invoke(context, { scope, operation: "state.set", namespace: "app_state", key: "infinite-canvas:video_draft", revision: 0,
      value: { version: 1, drafts: [{ id: "model-video-original", prompt: videoPrompt, references: [], config: { model: value(image), videoModel: value(image), size: "16:9", videoSeconds: "4", vquality: "720p", videoGenerateAudio: "false", videoWatermark: "false", videoMode: "text" } }], activeId: "model-video-original" } });
    await base.invoke(context, { scope, operation: "state.set", namespace: "app_state", key: "infinite-canvas:canvas_store", revision: 0,
      value: JSON.stringify({ version: 0, state: { projects: [{ id: "model-selection-canvas", title: canvasTitle, createdAt: modelFixtureDate, updatedAt: modelFixtureDate,
        nodes: [{ id: "model-selection-text", type: "text", title: "Retained source", position: { x: 10, y: 20 }, width: 280, height: 160, metadata: { content: "Synthetic unchanged canvas text", status: "success" } }],
        connections: [], chatSessions: [], activeChatId: null, viewport: { x: 0, y: 0, k: 1 }, backgroundMode: "lines", showImageInfo: true }], deletedProjects: [] } }) });
    await base.invoke(context, { scope, operation: "state.set", namespace: "app_state", key: "infinite-canvas:asset_store", revision: 0,
      value: JSON.stringify({ version: 0, state: { assets: [] } }) });
    return { scope, channelId: first.id, duplicateChannelId: duplicate.id, image, video, text, duplicate: secondVideo, imagePrompt, videoPrompt, canvasTitle };
  }
  async function executions(context: TenantContext, generationIds: string[]) {
    if (!generationIds.length) return [];
    return withTenant(base.database.db, context, tx => tx.execute(sql`select studio_generation_id,step_key,status from creative_executions
      where tenant_id=${context.tenantId} and studio_generation_id in (${sql.join(generationIds.map(id => sql`${id}::uuid`), sql`,`)}) order by studio_generation_id`));
  }
  async function exactRows(context: TenantContext, ids: string[]) {
    return withTenant(base.database.db, context, tx => tx.select().from(creativeStudioGenerations).where(and(eq(creativeStudioGenerations.ownerId, context.userId),
      inArray(creativeStudioGenerations.id, ids))).orderBy(asc(creativeStudioGenerations.id)));
  }
  async function cleanupBrowser(): Promise<StudioModelBrowserCleanup | null> {
    if (!options.context) return null;
    let context: TenantContext;
    try { context = await current({ tenantId: options.context.tenantId, userId: options.context.userId }); }
    catch (error) { throw cleanupFailure("authority", error); }
    const channelIds = [...ownedChannels.keys()], routeIds = [...ownedChannels.values()].flat(), scopeIds = [...ownedScopes];
    const errors: unknown[] = [], projectStates: StudioModelBrowserCleanup["projectStates"] = []; let removedDocuments = 0, retainedRevisions = 0;
    // These identities came only from this fixture's successful owner creations.
    // Logical deletion retains immutable entries, revisions and model history;
    // the outer nonce runner subsequently removes the entire disposable database.
    for (const scope of scopeIds) {
      let phase: "documents" | "archive" = "documents";
      try {
        const entries = (await documents(context, scope)).entries;
        for (const entry of entries.filter(row => !row.deletedAt)) {
          if (entry.namespace !== "app_state" || !["infinite-canvas:canvas_store", "infinite-canvas:asset_store", "studio:prompts", "infinite-canvas:image_draft", "infinite-canvas:video_draft"].includes(entry.key) || entry.assetId)
            throw new Error("studio_model_fixture_unexpected_owned_document");
          let revision = entry.revision, removed = false;
          for (let attempt = 0; attempt < 3 && !removed; attempt++) {
            try { await base.invoke(context, { operation: "state.remove", scope, namespace: "app_state", key: entry.key, revision }); removed = true; removedDocuments++; }
            catch (error) {
              if (!(error instanceof HttpException) || error.getStatus() !== 409) throw error;
              const latest = await base.address(context, scope, "app_state", entry.key);
              if (latest.deleted) { removed = true; break; }
              if (latest.count !== 1 || latest.revision === revision) throw error;
              revision = latest.revision;
            }
          }
          if (!removed) throw new Error("studio_model_fixture_document_cleanup_conflict");
        }
        const keys = await base.invoke(context, { operation: "state.keys", scope, namespace: "app_state" });
        if (keys.operation !== "state.keys" || keys.data.length) throw new Error("studio_model_fixture_document_cleanup_not_visible");
        phase = "archive";
        await base.pod.cancelDesignBatch(context, scope);
        await base.pod.archiveDesignBatch(context, scope, { archived: true, reason: "Synthetic model-selection fixture cleanup c5a8f4d1" });
      } catch (error) { errors.push(cleanupFailure(phase, error)); }
    }
    for (const id of channelIds) {
      try { const selected = await readChannel(context, id); await configure(context, { operation: "channel.remove", id, revision: selected.revision }); }
      catch (error) { errors.push(cleanupFailure("channels", error)); }
    }
    try {
      const proof = await withTenant(base.database.db, context, async tx => {
        const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
        const channels = channelIds.length ? await tx.select({ id: modelProviderConfigs.id, status: modelProviderConfigs.status,
          credentialCleared: sql<boolean>`${modelProviderConfigs.encryptedApiKey} = ''` }).from(modelProviderConfigs)
          .where(and(inArray(modelProviderConfigs.id, channelIds), eq(modelProviderConfigs.createdBy, context.userId))) : [];
        const routes = routeIds.length ? await tx.select({ id: modelRoutes.id, status: modelRoutes.status }).from(modelRoutes).where(inArray(modelRoutes.id, routeIds)) : [];
        const entries = scopeIds.length ? await tx.select({ id: creativeStudioEntries.id, deletedAt: creativeStudioEntries.deletedAt }).from(creativeStudioEntries)
          .where(and(eq(creativeStudioEntries.ownerId, context.userId), inArray(creativeStudioEntries.scope, scopeIds))) : [];
        const projects = scopeIds.length ? await tx.select({ id: creativeDesignBatches.id, status: creativeDesignBatches.status, archivedAt: creativeDesignBatches.archivedAt }).from(creativeDesignBatches)
          .where(and(inArray(creativeDesignBatches.id, scopeIds), eq(creativeDesignBatches.createdBy, context.userId), eq(creativeDesignBatches.executionMode, "infinite_canvas"))) : [];
        const [preferences] = await tx.select({ defaults: modelPreferences.defaults }).from(modelPreferences).where(eq(modelPreferences.userId, context.userId));
        const revisions = entries.length ? await tx.select({ id: creativeStudioRevisions.id }).from(creativeStudioRevisions).where(inArray(creativeStudioRevisions.entryId, entries.map(entry => entry.id))) : [];
        return { role: role?.role, channels, routes, entries, projects, preferences, retainedRevisions: revisions.length };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      if (proof.role !== "yummyai_app" || proof.channels.length !== channelIds.length || proof.channels.some(row => row.status !== "deleted" || !row.credentialCleared)
        || proof.routes.length !== routeIds.length || proof.routes.some(row => row.status !== "disabled") || proof.entries.some(row => !row.deletedAt)
        || proof.projects.length !== scopeIds.length || proof.projects.some(row => row.status !== "cancelled" || !row.archivedAt)
        || Object.values(proof.preferences?.defaults ?? {}).flatMap(value => typeof value === "object" && value !== null ? Object.values(value) : [value]).some(id => id && routeIds.includes(id))
        || proof.entries.length > 0 && proof.retainedRevisions < proof.entries.length) throw new Error("studio_model_fixture_cleanup_not_verified");
      if ((await catalogue(context)).length || (await base.bridge.projectSummaries(context)).some(row => scopeIds.includes(row.id))) throw new Error("studio_model_fixture_cleanup_not_visible");
      for (const row of proof.projects) {
        if (row.status !== "cancelled" || !row.archivedAt) throw new Error("studio_model_fixture_project_cleanup_not_verified");
        projectStates.push({ id: row.id, status: row.status, archived: true });
      }
      retainedRevisions = proof.retainedRevisions;
    } catch (error) { errors.push(cleanupFailure("verification", error)); }
    if (errors.length) throw new AggregateError(errors, "studio_model_fixture_cleanup_failed");
    return { role: "yummyai_app", channelIds, scopeIds, projectStates, removedDocuments, retainedRevisions,
      remainingActiveChannels: 0, remainingActiveRoutes: 0, remainingLiveDocuments: 0, remainingVisibleProjects: 0,
      remainingCatalogueModels: 0, credentialsCleared: true, defaultsCleared: true, retainedHistory: true };
  }
  function close() {
    closing ??= (async () => {
      let proof: StudioModelBrowserCleanup | null = null; const errors: unknown[] = [];
      try { proof = await cleanupBrowser(); } catch (error) { errors.push(error); }
      finally { try { await base.close(); } catch (error) { errors.push(cleanupFailure("base_close", error)); } }
      if (errors.length) throw new AggregateError(errors, "studio_model_fixture_close_failed");
      return proof;
    })();
    return closing;
  }
  return { ...base, environment, current, configuration, generations, configure, catalogue, channel, readChannel, status, changeCapability, remove, dependent, defaults,
    request, rows, facts, documents, legacy, seed, executions, exactRows, queueAttempts, close };
}
