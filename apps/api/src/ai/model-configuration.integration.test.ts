import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { emptyModelDefaults, type ConfigurationSnapshot, type ModelCatalogue } from "@yummyai/contracts/ai/model-configuration";
import { connectDatabase, migrateDatabase, modelPreferences, modelProviderConfigs, modelRoutes, withTenant } from "@yummyai/database";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelConfigurationService } from "./model-configuration.service.js";
import { StudioGenerationService } from "../design/studio-generation.service.js";
import type { CanvasBridgeService } from "../design/canvas-bridge.service.js";
import type { Storage } from "@yummyai/storage";

const fixtureDatabase = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(fixtureDatabase.pathname))
  throw new Error("Disposable model configuration fixture required");

describe("ERP model configuration adapter", () => {
  const database = connectDatabase(), vault = new SecretVault(randomBytes(32)), service = new ModelConfigurationService(database, vault);
  const a: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: [Permission.ModelConfigure, Permission.DesignRead], dataScope: "tenant" };
  const generation = new StudioGenerationService(database, {} as Storage, { enqueue: async () => {} }, {} as CanvasBridgeService);
  const b: TenantContext = { ...a, tenantId: createEntityId() }, member = { ...a, userId: createEntityId() };
  let server: Server, endpoint = "", snapshot: ConfigurationSnapshot, status = 200;
  const requests: Array<{ path?: string; authenticated: boolean }> = [];
  const invoke = (input: unknown, context = a) => service.invoke(context, input);
  const read = (context = a) => invoke({ operation: "configuration.get" }, context) as Promise<ConfigurationSnapshot>;
  const channelInput = () => ({ operation: "channel.save", id: snapshot.channels[0]!.id, revision: snapshot.channels[0]!.revision, name: "Synthetic OpenAI", baseUrl: endpoint, models: snapshot.channels[0]!.models });
  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe("insert into organizations (id,name,slug) values ($1,'Config A',$2),($3,'Config B',$4)", [a.tenantId, `config-${a.tenantId}`, b.tenantId, `config-${b.tenantId}`]);
    for (const context of [a, member]) await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,'Synthetic Config User')", [context.userId, `config-${context.userId}`, `${context.userId}@example.test`]);
    server = createServer((request, response) => { requests.push({ path: request.url, authenticated: request.headers.authorization === "Bearer synthetic-config-key" }); response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(status === 200 ? { data: [{ id: "qa-image" }, { id: "qa-text" }, { id: "qa-image" }] } : { error: "private-secret-error" })); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await database.client.end(); });

  it("atomically saves a channel with multiple models and redacts stored credentials", async () => {
    snapshot = await invoke({ operation: "channel.save", name: "Synthetic OpenAI", baseUrl: endpoint, apiKey: "synthetic-config-key", models: [{ name: "qa-image", capability: "image" }, { name: "qa-text", capability: "text" }] }) as ConfigurationSnapshot;
    expect(snapshot.channels[0]!.models).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-config-key");
    const [stored] = await withTenant(database.db, a, tx => tx.select().from(modelProviderConfigs));
    expect(stored!.encryptedApiKey).not.toContain("synthetic-config-key");
    expect(requests).toEqual([]);
  });
  it("discovers from saved credentials without generating or altering model configuration", async () => {
    const result = await invoke({ operation: "channel.discover", id: snapshot.channels[0]!.id, baseUrl: endpoint }) as ModelCatalogue;
    expect(result.models).toEqual(["qa-image", "qa-text"]);
    expect(requests).toEqual([{ path: "/v1/models", authenticated: true }]);
    expect(await read()).toEqual(snapshot);
    await expect(invoke({ operation: "channel.discover", id: snapshot.channels[0]!.id, baseUrl: "https://different.example.test/v1" })).rejects.toThrow("API 地址已修改");
    expect(requests).toHaveLength(1);
  });
  it("denies cross-tenant discovery, modification, and missing permission before any provider call", async () => {
    expect((await read(b)).channels).toEqual([]);
    await expect(invoke({ operation: "channel.discover", id: snapshot.channels[0]!.id, baseUrl: endpoint }, b)).rejects.toMatchObject({ status: 404 });
    await expect(invoke(channelInput(), b)).rejects.toMatchObject({ status: 404 });
    await expect(invoke({ operation: "configuration.get" }, { ...a, permissions: [] })).rejects.toThrow();
    expect(requests).toHaveLength(1);
  });
  it("preserves credentials and route IDs on edit, and rejects stale revisions", async () => {
    const ids = snapshot.channels[0]!.models.map(model => model.id), old = channelInput();
    snapshot = await invoke({ ...old, models: [...old.models, { name: "qa-text-two", capability: "text" }] }) as ConfigurationSnapshot;
    expect(snapshot.channels[0]!.models.slice(0, 2).map(model => model.id)).toEqual(ids);
    await expect(invoke(old)).rejects.toMatchObject({ status: 409 });
    await invoke({ operation: "channel.discover", id: snapshot.channels[0]!.id, baseUrl: endpoint });
    expect(requests.at(-1)?.authenticated).toBe(true);
  });
  it("validates all model entries before committing a partial channel change", async () => {
    const before = snapshot;
    await expect(invoke({ ...channelInput(), name: "Must not persist", models: [{ name: "qa-other", capability: "image" }, { id: createEntityId(), name: "foreign-route", capability: "text" }] })).rejects.toMatchObject({ status: 404 });
    expect(await read()).toEqual(before);
  });
  it("saves defaults by user, enforces RLS, and rejects incompatible and stale defaults", async () => {
    const image = snapshot.channels[0]!.models.find(model => model.capability === "image")!.id;
    snapshot = await invoke({ operation: "defaults.save", revision: 0, defaults: { ...emptyModelDefaults(), image } }) as ConfigurationSnapshot;
    expect((await read()).defaults.image).toBe(image);
    expect((await generation.models(a)).find(model => model.id === image)?.isDefault).toBe(true);
    expect((await generation.models(member)).some(model => model.isDefault)).toBe(false);
    expect((await read(member)).defaults.image).toBeNull();
    expect(await withTenant(database.db, member, tx => tx.select().from(modelPreferences))).toEqual([]);
    await expect(invoke({ operation: "defaults.save", revision: 0, defaults: emptyModelDefaults() })).rejects.toMatchObject({ status: 409 });
    await expect(invoke({ operation: "defaults.save", revision: 1, defaults: { ...emptyModelDefaults(), text: image } })).rejects.toMatchObject({ status: 400 });
    await expect(withTenant(database.db, member, tx => tx.insert(modelPreferences).values({ tenantId: a.tenantId, userId: a.userId, defaults: emptyModelDefaults() }))).rejects.toThrow();
    const flags = await database.client.unsafe("select relrowsecurity, relforcerowsecurity from pg_class where relname='model_preferences'");
    expect(flags[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
  });
  it("removes models by disabling routes and re-enables the original ID when selected again", async () => {
    const removed = snapshot.channels[0]!.models.find(model => model.capability === "image")!;
    snapshot = await invoke({ ...channelInput(), models: snapshot.channels[0]!.models.filter(model => model.id !== removed.id) }) as ConfigurationSnapshot;
    const [route] = await withTenant(database.db, a, tx => tx.select().from(modelRoutes).where(eq(modelRoutes.id, removed.id)));
    expect(route?.status).toBe("disabled");
    expect(snapshot.defaults.image).toBeNull();
    snapshot = await invoke({ ...channelInput(), models: [...snapshot.channels[0]!.models, { name: removed.name, capability: removed.capability }] }) as ConfigurationSnapshot;
    expect(snapshot.channels[0]!.models.find(model => model.name === removed.name)?.id).toBe(removed.id);
    const count = await withTenant(database.db, a, tx => tx.select({ count: sql<number>`count(*)::int` }).from(modelRoutes));
    expect(count[0]?.count).toBe(3);
  });
  it("returns safe directory failures and leaves existing configuration intact", async () => {
    status = 401;
    await expect(invoke({ operation: "channel.discover", id: snapshot.channels[0]!.id, baseUrl: endpoint })).rejects.toThrow("渠道认证失败");
    expect(await read()).toEqual(snapshot);
  });
  it("does not apply an image default to a model whose capability has changed", async () => {
    const image = snapshot.channels[0]!.models.find(model => model.capability === "image")!;
    snapshot = await invoke({ operation: "defaults.save", revision: snapshot.defaultsRevision, defaults: { ...snapshot.defaults, image: image.id } }) as ConfigurationSnapshot;
    snapshot = await invoke({ ...channelInput(), models: snapshot.channels[0]!.models.map(model => model.id === image.id ? { ...model, capability: "text" } : model) }) as ConfigurationSnapshot;
    expect(snapshot.defaults.image).toBe(image.id);
    expect((await generation.models(a)).find(model => model.id === image.id)).toMatchObject({ capability: "text", isDefault: false });
  });
  it("refuses to silently collapse historical same-name multi-capability routes", async () => {
    const original = snapshot.channels[0]!.models[0]!;
    await withTenant(database.db, a, tx => tx.insert(modelRoutes).values({ id: createEntityId(), tenantId: a.tenantId, modelKey: "Historical image variant", taskType: "studio_image", targets: [{ providerConfigId: snapshot.channels[0]!.id, providerModel: original.name, timeoutMs: 12345 }] }));
    snapshot = await read();
    const before = snapshot;
    await expect(invoke({ ...channelInput(), models: snapshot.channels[0]!.models.filter(model => model.label !== "Historical image variant") })).rejects.toThrow("同名多用途模型");
    expect(await read()).toEqual(before);
  });

  const persistedConfiguration = () => withTenant(database.db, a, async tx => ({
    providers: await tx.select().from(modelProviderConfigs).orderBy(modelProviderConfigs.id),
    routes: await tx.select().from(modelRoutes).orderBy(modelRoutes.id),
    preferences: await tx.select().from(modelPreferences).orderBy(modelPreferences.userId),
  }));

  it("adds a local Responses channel without rewriting existing credentials, routes or user defaults", async () => {
    const before = await persistedConfiguration(), callsBefore = requests.length;
    const configured = await invoke({ operation: "channel.save", name: "Synthetic local Responses",
      baseUrl: endpoint, apiKey: "synthetic-responses-only", textProtocol: "responses",
      models: [{ name: "synthetic-responses-text", capability: "text" }] }) as ConfigurationSnapshot;
    const channel = configured.channels.find(row => row.name === "Synthetic local Responses")!;
    expect(channel).toMatchObject({ provider: "openai", baseUrl: endpoint, hasCredential: true });
    expect(channel.models).toHaveLength(1);
    expect(channel.models[0]).toMatchObject({ name: "synthetic-responses-text", capability: "text" });
    expect(configured.analysisModels.some(row => row.id === channel.models[0]!.id)).toBe(true);
    expect(JSON.stringify(configured)).not.toContain("synthetic-responses-only");
    const after = await persistedConfiguration();
    expect(after.providers.filter(row => row.id !== channel.id)).toEqual(before.providers);
    expect(after.routes.filter(row => row.id !== channel.models[0]!.id)).toEqual(before.routes);
    expect(after.preferences).toEqual(before.preferences);
    const saved = after.providers.find(row => row.id === channel.id)!;
    expect(saved.encryptedApiKey).not.toContain("synthetic-responses-only");
    expect(vault.withSecret(saved.encryptedApiKey, value => value)).toBe("synthetic-responses-only");
    expect(requests).toHaveLength(callsBefore);
  });

  it("keeps legacy address inference and permits editing an unchanged explicit Responses protocol", async () => {
    const legacy = await invoke({ operation: "channel.save", name: "Synthetic legacy protocol",
      baseUrl: endpoint, apiKey: "synthetic-legacy-only", models: [{ name: "synthetic-legacy-text", capability: "text" }] }) as ConfigurationSnapshot;
    const old = legacy.channels.find(row => row.name === "Synthetic legacy protocol")!;
    expect(old.provider).toBe("openai-compatible");
    const explicit = legacy.channels.find(row => row.name === "Synthetic local Responses")!;
    const before = await persistedConfiguration();
    const edited = await invoke({ operation: "channel.save", id: explicit.id, revision: explicit.revision,
      name: explicit.name, baseUrl: explicit.baseUrl, textProtocol: "responses", models: explicit.models }) as ConfigurationSnapshot;
    expect(edited.channels.find(row => row.id === explicit.id)).toMatchObject({ provider: "openai", models: explicit.models });
    const after = await persistedConfiguration();
    expect(after.providers.find(row => row.id === explicit.id)?.encryptedApiKey).toBe(before.providers.find(row => row.id === explicit.id)?.encryptedApiKey);
    expect(after.providers.find(row => row.id === old.id)).toEqual(before.providers.find(row => row.id === old.id));
    expect(after.routes.filter(row => row.targets.some(target => target.providerConfigId === old.id))).toEqual(before.routes.filter(row => row.targets.some(target => target.providerConfigId === old.id)));
    expect(after.preferences).toEqual(before.preferences);
  });

  it.each([
    ["Synthetic legacy protocol", "responses"],
    ["Synthetic local Responses", "chat_completions"],
  ] as const)("rejects changing %s to %s before modifying any persisted configuration", async (name, textProtocol) => {
    const snapshotBefore = await read(), channel = snapshotBefore.channels.find(row => row.name === name)!;
    const before = await persistedConfiguration(), callsBefore = requests.length;
    await expect(invoke({ operation: "channel.save", id: channel.id, revision: channel.revision,
      name: "Must not replace the original channel", baseUrl: "http://localhost:8080/v1",
      apiKey: "synthetic-replacement-must-not-persist", textProtocol,
      models: channel.models.map(model => ({ ...model, label: "Must not alter the original route" })) })).rejects.toMatchObject({ status: 409 });
    expect(await read()).toEqual(snapshotBefore);
    expect(await persistedConfiguration()).toEqual(before);
    expect(requests).toHaveLength(callsBefore);
  });
});
