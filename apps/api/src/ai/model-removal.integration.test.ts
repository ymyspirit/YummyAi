import { randomBytes } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { emptyModelDefaults, type ConfigurationSnapshot, type ConfiguredChannel, type ModelConfigurationRemovalCode } from "@yummyai/contracts/ai/model-configuration";
import { StudioGenerateRequestSchema, StudioGenerateSchema } from "@yummyai/contracts/pod/creative-studio";
import { aiAssistRuns, connectDatabase, creativeStudioGenerations, migrateDatabase, modelPreferences, modelProviderConfigs, modelRoutes, withTenant } from "@yummyai/database";
import type { Storage } from "@yummyai/storage";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import { StudioGenerationService } from "../design/studio-generation.service.js";
import type { AssistContextService } from "./assist-context.service.js";
import { AssistService } from "./assist.service.js";
import { ModelConfigurationService } from "./model-configuration.service.js";
import { ModelConfigController } from "./model-config.controller.js";
import type { AuthenticatedRequest } from "../auth/tenant-context.guard.js";

async function ownerFailure(operation: Promise<unknown>, status: number, code: ModelConfigurationRemovalCode, originalMessage?: string) {
  const failure: unknown = await operation.then(() => null, (cause: unknown) => cause);
  expect(failure).toBeInstanceOf(HttpException);
  if (!(failure instanceof HttpException)) throw new Error("Expected native model-configuration owner failure");
  expect(failure.getStatus()).toBe(status);
  expect(failure.getResponse()).toMatchObject({ code, message: expect.any(String) });
  if (originalMessage) expect(failure.message).toContain(originalMessage);
}

describe("model removal preserves tenant history and active tasks", () => {
  const database = connectDatabase(), vault = new SecretVault(randomBytes(32));
  const context: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
  const other = { ...context, tenantId: createEntityId() }, member = { ...context, userId: createEntityId() };
  const service = new ModelConfigurationService(database, vault);
  const controller = new ModelConfigController(database, vault);
  const assist = new AssistService(database, vault, {} as AssistContextService, { enqueue: async () => {} });
  const generation = new StudioGenerationService(database, {} as Storage, { enqueue: async () => {} }, {} as CanvasBridgeService);
  const read = () => service.invoke(context, { operation: "configuration.get" }) as Promise<ConfigurationSnapshot>;
  const removeInput = (channel: ConfiguredChannel, modelId = channel.models[0]!.id) => ({ operation: "model.remove", channelId: channel.id, modelId, revision: channel.revision });
  const removeChannelInput = (channel: ConfiguredChannel) => ({ operation: "channel.remove", id: channel.id, revision: channel.revision });
  async function channel(capability = "text") {
    const name = `Synthetic deletion ${createEntityId()}`;
    const snapshot = await service.invoke(context, { operation: "channel.save", name, baseUrl: "https://synthetic.example.test/v1", apiKey: "synthetic-unused-key", models: [{ name: "synthetic-model", label: name, capability }] }) as ConfigurationSnapshot;
    return snapshot.channels.find(item => item.name === name)!;
  }
  beforeAll(async () => {
    await migrateDatabase(database);
    for (const tenantId of [context.tenantId, other.tenantId]) await database.client.unsafe("insert into organizations (id,name,slug) values ($1,'Synthetic removal',$2)", [tenantId, `remove-${tenantId}`]);
    for (const userId of [context.userId, member.userId]) await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,'Synthetic removal user')", [userId, `remove-${userId}`, `${userId}@example.test`]);
  });
  afterAll(async () => { await database.client.end(); });

  it("rejects foreign tenants, wrong channels, missing permissions and stale revisions", async () => {
    const first = await channel(), second = await channel();
    const before = await read();
    await ownerFailure(service.invoke(other, removeInput(first)), 404, "model_configuration_channel_missing");
    await ownerFailure(service.invoke(context, removeInput(second, first.models[0]!.id)), 404, "model_configuration_model_missing");
    await expect(service.invoke({ ...context, permissions: [] }, removeInput(first))).rejects.toThrow();
    await ownerFailure(service.invoke(context, { ...removeInput(first), revision: "stale" }), 409, "model_configuration_revision_conflict");
    await ownerFailure(service.invoke(other, removeChannelInput(first)), 404, "model_configuration_channel_missing");
    await expect(service.invoke({ ...context, permissions: [] }, removeChannelInput(first))).rejects.toThrow();
    await ownerFailure(service.invoke(context, { ...removeChannelInput(first), revision: "stale" }), 409, "model_configuration_revision_conflict");
    expect(await read()).toEqual(before);
  });

  it("removes a shared text model from both pickers and clears only this user's defaults", async () => {
    const current = await channel(), modelId = current.models[0]!.id;
    const originalSelection = (await generation.models(context)).find(row => row.id === modelId)!;
    for (const user of [context, member]) {
      const snapshot = await service.invoke(user, { operation: "configuration.get" }) as ConfigurationSnapshot;
      await service.invoke(user, { operation: "defaults.save", revision: snapshot.defaultsRevision, defaults: { ...emptyModelDefaults(), text: modelId, analysis: modelId } });
    }
    const before = await read();
    const removed = await service.invoke(context, removeInput(current)) as ConfigurationSnapshot;
    expect(removed.channels.find(item => item.id === current.id)!.models).toEqual([]);
    expect(removed.analysisModels.some(item => item.id === modelId)).toBe(false);
    expect(removed.defaults).toEqual(emptyModelDefaults());
    expect(removed.defaultsRevision).toBe(before.defaultsRevision + 1);
    expect((await assist.models(member)).some(item => item.id === modelId)).toBe(false);
    expect((await generation.models(member)).some(item => item.id === modelId)).toBe(false);
    const [route] = await withTenant(database.db, context, tx => tx.select().from(modelRoutes).where(eq(modelRoutes.id, modelId)));
    expect(route?.status).toBe("disabled");
    const [preferences] = await withTenant(database.db, member, tx => tx.select().from(modelPreferences));
    expect(preferences?.defaults.analysis).toBe(modelId);
    await expect(generation.create(context, "unassigned", StudioGenerateRequestSchema.parse({ requestId: createEntityId(), modelId,
      capability: "text", selectionRevision: originalSelection.selectionRevision, prompt: "Synthetic prompt" }))).rejects.toMatchObject({
        status: 409, response: { code: "studio_paid_execution_paused" },
      });
  });

  it.each(["queued", "running"] as const)("protects another member's %s generation through direct removal and channel editing", async status => {
    const current = await channel("image"), modelId = current.models[0]!.id;
    const id = createEntityId();
    await withTenant(database.db, member, tx => tx.insert(creativeStudioGenerations).values({ id, tenantId: context.tenantId, ownerId: member.userId, scope: "unassigned", requestId: createEntityId(), status, input: StudioGenerateSchema.parse({ requestId: createEntityId(), modelId, prompt: "Synthetic retained prompt" }), modelSnapshot: { providerConfigId: current.id, model: "synthetic-model", capability: "image" }, references: [] }));
    await ownerFailure(service.invoke(context, removeInput(current)), 409, "model_configuration_model_busy", "仍有排队或进行中的任务");
    await ownerFailure(service.invoke(context, removeChannelInput(current)), 409, "model_configuration_channel_busy", "仍有排队或进行中的任务");
    await ownerFailure(service.invoke(context, { operation: "channel.save", id: current.id, revision: current.revision, name: "Must roll back", baseUrl: current.baseUrl, models: [] }), 409, "model_configuration_model_busy", "仍有排队或进行中的任务");
    expect((await read()).channels.find(item => item.id === current.id)).toEqual(current);
    await withTenant(database.db, member, tx => tx.update(creativeStudioGenerations).set({ status: "completed", resultText: "Synthetic retained result" }).where(eq(creativeStudioGenerations.id, id)));
    const [before] = await withTenant(database.db, member, tx => tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, id)));
    await service.invoke(context, removeInput(current));
    await service.invoke(context, removeChannelInput((await read()).channels.find(item => item.id === current.id)!));
    const [after] = await withTenant(database.db, member, tx => tx.select().from(creativeStudioGenerations).where(eq(creativeStudioGenerations.id, id)));
    expect(after).toEqual(before);
  });

  it("protects pending analyses even after retention expiry, preserves completed snapshots and supports re-adding removed models", async () => {
    const current = await channel();
    const input = { providerConfigId: current.id, model: "synthetic-analysis", label: "Synthetic priced analysis", inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 };
    const { id: modelId } = await assist.addModel(context, input);
    await ownerFailure(service.invoke(context, removeInput(current)), 409, "model_configuration_revision_conflict");
    const updated = (await read()).channels.find(item => item.id === current.id)!;
    const model = (await assist.models(context)).find(item => item.id === modelId)!;
    const id = createEntityId();
    await withTenant(database.db, member, tx => tx.insert(aiAssistRuns).values({ id, tenantId: context.tenantId, ownerId: member.userId, requestId: createEntityId(), kind: "creative", scope: "unassigned", status: "queued", inputFingerprint: "a".repeat(64), requestFingerprint: "b".repeat(64), modelSnapshot: { ...model, providerConfigId: current.id }, promptVersion: "synthetic-v1", reservedCostUsd: "0.01", expiresAt: new Date(Date.now() - 1000) }));
    const [pendingBefore] = await withTenant(database.db, member, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, id)));
    await ownerFailure(service.invoke(context, removeInput(updated, modelId)), 409, "model_configuration_model_busy", "仍有排队或进行中的任务");
    await ownerFailure(service.invoke(context, removeChannelInput(updated)), 409, "model_configuration_channel_busy", "仍有排队或进行中的任务");
    const [pendingAfter] = await withTenant(database.db, member, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, id)));
    expect(pendingAfter).toEqual(pendingBefore);
    await withTenant(database.db, member, tx => tx.update(aiAssistRuns).set({ status: "completed", encryptedOutput: vault.encrypt("Synthetic retained analysis"), completedAt: new Date() }).where(eq(aiAssistRuns.id, id)));
    const [before] = await withTenant(database.db, member, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, id)));
    await service.invoke(context, removeInput(updated, modelId));
    expect((await assist.models(context)).some(item => item.id === modelId)).toBe(false);
    expect((await assist.addModel(context, input)).id).toBe(modelId);
    expect((await assist.models(context)).find(item => item.id === modelId)?.maxTaskCostUsd).toBe(1);
    const [after] = await withTenant(database.db, member, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, id)));
    expect(after).toEqual(before);
  });

  it("deletes a disabled empty channel, discards its credential and rejects every attempt to revive it", async () => {
    const name = `Empty channel ${createEntityId()}`;
    let snapshot = await service.invoke(context, { operation: "channel.save", name, baseUrl: "https://synthetic.example.test/v1", apiKey: "synthetic-unused-key", models: [] }) as ConfigurationSnapshot;
    const original = snapshot.channels.find(item => item.name === name)!;
    snapshot = await service.invoke(context, { operation: "channel.status", id: original.id, revision: original.revision, status: "disabled" }) as ConfigurationSnapshot;
    const disabled = snapshot.channels.find(item => item.id === original.id)!;
    await service.invoke(context, removeChannelInput(disabled));
    expect((await read()).channels.some(item => item.id === original.id)).toBe(false);
    const request = { tenantContext: context } as AuthenticatedRequest;
    expect((await controller.list(request)).some(item => item.id === original.id)).toBe(false);
    const [stored] = await withTenant(database.db, context, tx => tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, original.id)));
    expect(stored).toMatchObject({ status: "deleted", encryptedApiKey: "" });
    await ownerFailure(service.invoke(context, removeChannelInput(disabled)), 404, "model_configuration_channel_missing");
    await expect(controller.update(request, original.id, { status: "enabled", apiKey: "must-not-save" })).rejects.toMatchObject({ status: 404 });
    await expect(service.invoke(context, { operation: "channel.status", id: original.id, revision: disabled.revision, status: "enabled" })).rejects.toMatchObject({ status: 404 });
    await expect(service.invoke(context, { operation: "channel.save", id: original.id, revision: disabled.revision, name, baseUrl: disabled.baseUrl, models: [] })).rejects.toMatchObject({ status: 404 });
    await expect(service.invoke(context, { operation: "channel.discover", id: original.id, baseUrl: disabled.baseUrl })).rejects.toMatchObject({ status: 404 });
    await expect(generation.addModel(context, { providerConfigId: original.id, model: "synthetic", label: "must-not-add", capability: "image" })).rejects.toMatchObject({ status: 400 });
    await expect(assist.addModel(context, { providerConfigId: original.id, model: "synthetic", label: "must-not-add", inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxTaskCostUsd: 1 })).rejects.toMatchObject({ status: 400 });
    snapshot = await service.invoke(context, { operation: "channel.save", name, baseUrl: disabled.baseUrl, apiKey: "new-synthetic-key", models: [] }) as ConfigurationSnapshot;
    expect(snapshot.channels.find(item => item.name === name)?.id).not.toBe(original.id);
  });

  it("removes a channel's creative and independent analysis models atomically and allows a fresh channel with the same name", async () => {
    const name = `Replacement ${createEntityId()}`;
    const input = { operation: "channel.save", name, baseUrl: "https://synthetic.example.test/v1", apiKey: "synthetic-unused-key", models: [{ name: "shared-text", capability: "text" }] };
    let snapshot = await service.invoke(context, input) as ConfigurationSnapshot;
    const current = snapshot.channels.find(item => item.name === name)!, textId = current.models[0]!.id;
    const { id: analysisId } = await assist.addModel(context, { providerConfigId: current.id, model: "priced-analysis", label: `Analysis ${current.id}`, inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 });
    snapshot = await read();
    await service.invoke(context, { operation: "defaults.save", revision: snapshot.defaultsRevision, defaults: { ...emptyModelDefaults(), text: textId, analysis: analysisId } });
    const latest = (await read()).channels.find(item => item.id === current.id)!;
    expect(latest.analysisModels).toEqual([{ id: analysisId, name: "priced-analysis", label: `Analysis ${current.id}`,
      analysisPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, maxTaskCostUsd: 1 } }]);
    snapshot = await service.invoke(context, removeChannelInput(latest)) as ConfigurationSnapshot;
    expect(snapshot.channels.some(item => item.id === current.id)).toBe(false);
    expect(snapshot.defaults).toEqual(emptyModelDefaults());
    expect((await assist.models(context)).some(item => [textId, analysisId].includes(item.id))).toBe(false);
    expect((await generation.models(context)).some(item => item.id === textId)).toBe(false);
    const routes = await withTenant(database.db, context, tx => tx.select().from(modelRoutes));
    expect(routes.filter(item => [textId, analysisId].includes(item.id)).map(item => item.status)).toEqual(["disabled", "disabled"]);
    snapshot = await service.invoke(context, input) as ConfigurationSnapshot;
    const replacement = snapshot.channels.find(item => item.name === name)!;
    expect(replacement.id).not.toBe(current.id);
    expect(replacement.models[0]!.id).not.toBe(textId);
    expect(snapshot.defaults).toEqual(emptyModelDefaults());
  });

  it("includes shared and business route dependencies in the revision and blocks their deletion", async () => {
    const current = await channel(), second = await channel();
    const routeId = createEntityId();
    await withTenant(database.db, context, tx => tx.insert(modelRoutes).values({ id: routeId, tenantId: context.tenantId, modelKey: `Synthetic shared route ${routeId}`, taskType: "AI-01", targets: [current, second].map(item => ({ providerConfigId: item.id, providerModel: "synthetic", timeoutMs: 1000 })) }));
    await ownerFailure(service.invoke(context, removeChannelInput(current)), 409, "model_configuration_revision_conflict");
    const latest = (await read()).channels.find(item => item.id === current.id)!;
    expect(latest.dependentRoutes.map(item => item.id)).toContain(routeId);
    await ownerFailure(service.invoke(context, removeChannelInput(latest)), 409, "model_configuration_channel_referenced", "仍被业务路由引用");
    expect((await read()).channels.find(item => item.id === current.id)).toEqual(latest);
  });
});
