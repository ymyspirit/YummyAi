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
});
