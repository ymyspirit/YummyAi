import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { assistModelExecutionSnapshot } from "@yummyai/contracts/ai/assist";
import { defaultAgentLoopLimits } from "@yummyai/contracts/ai/agent-loop";
import { defaultAgentNativeV4Limits } from "@yummyai/contracts/ai/agent-native-v4";
import { AGENT_READ_VERSION } from "@yummyai/contracts/ai/agent-read";
import { emptyModelDefaults, type ConfigurationSnapshot, type ConfiguredChannel, type ModelCatalogue } from "@yummyai/contracts/ai/model-configuration";
import { agentLoopRuns, agentPlanRuns, aiAssistRuns, aiBudgetLedger, connectDatabase, loadCurrentMembershipContext, memberships, membershipRoles, migrateDatabase, modelProviderConfigs, modelRoutes, readModelExecutionRouteFingerprint, recordAuditInTransaction, roles, withTenant } from "@yummyai/database";
import { agentLoopHarness, agentLoopSkill, agentNativeV4Harness, agentNativeV4Protocol, agentNativeV4ReadSkill, agentNativeV4Skill, agentReadHarness } from "@yummyai/workflow-core";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AssistContextService } from "./assist-context.service.js";
import { AssistService } from "./assist.service.js";
import { ModelConfigurationService } from "./model-configuration.service.js";
import { NativeServiceEngine } from "./agent-native-engine.service.js";

const fixtureDatabase = new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid");
if (process.env.E2E_ISOLATED_DAILY !== "1" || !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(fixtureDatabase.pathname))
  throw new Error("Disposable model settings workflow fixture required");

describe("native model settings preserve personal defaults, unknown costs and immutable history", () => {
  const database = connectDatabase(), vault = new SecretVault(randomBytes(32));
  const service = new ModelConfigurationService(database, vault);
  const queued: string[] = [];
  const assist = new AssistService(database, vault, {} as AssistContextService, { enqueue: async value => { queued.push(value.id); } });
  const tenantId = createEntityId(), foreignTenantId = createEntityId();
  const credential = randomBytes(24).toString("hex");
  const directoryRequests: Array<{ method: string | undefined; path: string | undefined; authenticated: boolean }> = [];
  let server: Server, endpoint = "", context: TenantContext, member: TenantContext;
  const invoke = (input: unknown, actor = context) => service.invoke(actor, input);
  const read = (actor = context) => invoke({ operation: "configuration.get" }, actor) as Promise<ConfigurationSnapshot>;
  const current = async (id: string) => (await read()).channels.find(channel => channel.id === id)!;
  const route = async (id: string) => (await withTenant(database.db, context, tx => tx.select().from(modelRoutes).where(eq(modelRoutes.id, id))))[0]!;
  const model = async (id: string, actor = context) => (await assist.models(actor)).find(item => item.id === id)!;
  async function channel(actor = context) {
    const name = `Synthetic settings ${createEntityId()}`;
    const snapshot = await invoke({ operation: "channel.save", name, baseUrl: endpoint, apiKey: credential, textProtocol: "responses", models: [
      { name: "fixture-text-a", label: `${name} A`, capability: "text" },
      { name: "fixture-text-b", label: `${name} B`, capability: "text" },
      { name: "fixture-image", label: `${name} image`, capability: "image" },
    ] }, actor) as ConfigurationSnapshot;
    return snapshot.channels.find(item => item.name === name)!;
  }
  function ownedInput(channel: ConfiguredChannel, modelId: string) {
    return { channelId: channel.id, modelId, revision: channel.revision };
  }
  async function priced(channelId: string, modelId: string, cap: number | null = null) {
    return invoke({ operation: "model.analysis-pricing.save", ...ownedInput(await current(channelId), modelId),
      pricing: { inputUsdPerMillion: 2, outputUsdPerMillion: 5, maxTaskCostUsd: cap } }) as Promise<ConfigurationSnapshot>;
  }
  beforeAll(async () => {
    await migrateDatabase(database);
    for (const id of [tenantId, foreignTenantId]) await database.client.unsafe("insert into organizations (id,name,slug) values ($1,'Synthetic model settings',$2)", [id, `model-settings-${id}`]);
    server = createServer((request, response) => {
      directoryRequests.push({ method: request.method, path: request.url, authenticated: request.headers.authorization === `Bearer ${credential}` });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "fixture-text-a" }, { id: "fixture-image" }, { id: "fixture-text-a" }] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });
  beforeEach(async () => {
    context = { tenantId, userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
    member = { ...context, userId: createEntityId() };
    for (const actor of [context, member]) await database.client.unsafe("insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,'Synthetic settings member')", [actor.userId, `model-settings-${actor.userId}`, `${actor.userId}@example.test`]);
  });
  afterAll(async () => {
    try { if (server) await new Promise<void>(resolve => server.close(() => resolve())); }
    finally { await database.client.end(); }
  });

  it("reads only the provider catalogue and keeps discovery distinct from registration and capability verification", async () => {
    const configured = await channel(), before = await read(), count = directoryRequests.length;
    const catalogue = await invoke({ operation: "channel.discover", id: configured.id, baseUrl: endpoint }) as ModelCatalogue;
    expect(catalogue.models).toEqual(["fixture-image", "fixture-text-a"]);
    expect(catalogue).toMatchObject({ source: "provider", skipped: 0 });
    expect(catalogue).not.toHaveProperty("verified");
    expect(catalogue).not.toHaveProperty("capabilities");
    expect(directoryRequests.slice(count)).toEqual([{ method: "GET", path: "/v1/models", authenticated: true }]);
    expect(await read()).toEqual(before);
    expect(JSON.stringify(before)).not.toContain(credential);
    expect(queued).toEqual([]);
  });

  it("keeps purpose defaults personal and preserves them when the legacy four-field editor saves", async () => {
    const configured = await channel(), [first, second] = configured.models.filter(item => item.capability === "text");
    let snapshot = await read();
    snapshot = await invoke({ operation: "defaults.save", revision: snapshot.defaultsRevision, defaults: { ...emptyModelDefaults(), text: first!.id } }) as ConfigurationSnapshot;
    snapshot = await invoke({ operation: "purpose-defaults.save", revision: snapshot.defaultsRevision,
      defaults: { order_review: second!.id, artwork_preflight: first!.id, agent_chat: second!.id, knowledge_answer: first!.id } }) as ConfigurationSnapshot;
    const expected = { order_review: second!.id, artwork_preflight: first!.id, agent_chat: second!.id, knowledge_answer: first!.id };
    expect(snapshot.defaults.purposeDefaults).toEqual(expected);
    expect((await model(second!.id)).defaultFor).toEqual(expect.arrayContaining(["order_review", "agent_chat"]));
    expect((await model(first!.id)).defaultFor ?? []).not.toContain("order_review");
    expect((await read(member)).defaults.purposeDefaults ?? {}).toEqual({});
    expect((await model(second!.id, member)).defaultFor ?? []).not.toContain("order_review");
    const legacy = await invoke({ operation: "defaults.save", revision: snapshot.defaultsRevision,
      defaults: { ...emptyModelDefaults(), text: second!.id } }) as ConfigurationSnapshot;
    expect(legacy.defaults.purposeDefaults).toEqual(expected);
    expect(legacy.defaults.text).toBe(second!.id);
    expect(legacy.defaultsRevision).toBe(snapshot.defaultsRevision + 1);
    const emptyPatch = await invoke({ operation: "purpose-defaults.save", revision: legacy.defaultsRevision, defaults: {} }) as ConfigurationSnapshot;
    expect(emptyPatch.defaults).toEqual(legacy.defaults);
    const cleared = await invoke({ operation: "purpose-defaults.save", revision: emptyPatch.defaultsRevision,
      defaults: { order_review: null, artwork_preflight: null, agent_chat: null } }) as ConfigurationSnapshot;
    expect(cleared.defaults.purposeDefaults).toEqual({ order_review: null, artwork_preflight: null, agent_chat: null, knowledge_answer: first!.id });
    expect(cleared.defaults).toMatchObject({ image: null, text: second!.id, video: null, analysis: null });
  });

  it("rejects incompatible, foreign and stale purpose choices without partially updating personal defaults", async () => {
    const configured = await channel(), text = configured.models.find(item => item.capability === "text")!, image = configured.models.find(item => item.capability === "image")!;
    const before = await read();
    for (const defaults of [{ order_review: image.id }, { agent_chat: createEntityId() }])
      await expect(invoke({ operation: "purpose-defaults.save", revision: before.defaultsRevision, defaults })).rejects.toMatchObject({ status: 400 });
    await expect(invoke({ operation: "purpose-defaults.save", revision: before.defaultsRevision + 1, defaults: { order_review: text.id } })).rejects.toMatchObject({ status: 409 });
    await expect(invoke({ operation: "purpose-defaults.save", revision: before.defaultsRevision, defaults: { order_review: text.id }, userId: member.userId })).rejects.toMatchObject({ status: 400 });
    await expect(invoke({ operation: "purpose-defaults.save", revision: 0, defaults: { order_review: text.id } }, { ...context, tenantId: foreignTenantId })).rejects.toMatchObject({ status: 400 });
    await expect(invoke({ operation: "purpose-defaults.save", revision: before.defaultsRevision, defaults: { order_review: text.id } }, { ...context, permissions: [] })).rejects.toThrow();
    expect(await read()).toEqual(before);
  });

  it("pauses and restores the same model while channel edits preserve the pause and delete does not turn history into a recoverable model", async () => {
    const configured = await channel(), first = configured.models.find(item => item.capability === "text")!;
    await priced(configured.id, first.id, 25.5);
    const initial = await route(first.id), pricing = initial.targets[0]!.analysisPricing;
    let snapshot = await invoke({ operation: "model.status", ...ownedInput(await current(configured.id), first.id), status: "disabled" }) as ConfigurationSnapshot;
    const paused = snapshot.channels.find(item => item.id === configured.id)!.models.find(item => item.id === first.id)!;
    expect(paused).toMatchObject({ id: first.id, status: "disabled" });
    expect((await assist.models(context)).some(item => item.id === first.id)).toBe(false);
    expect((await route(first.id)).targets[0]!.analysisPricing).toEqual(pricing);
    const edit = await current(configured.id);
    snapshot = await invoke({ operation: "channel.save", id: edit.id, revision: edit.revision, name: edit.name, baseUrl: edit.baseUrl,
      models: edit.models.map(({ id, name, label, capability }) => ({ id, name, label, capability })) }) as ConfigurationSnapshot;
    expect(snapshot.channels.find(item => item.id === configured.id)!.models.find(item => item.id === first.id)?.status).toBe("disabled");
    expect((await assist.models(context)).some(item => item.id === first.id)).toBe(false);
    await expect(invoke({ operation: "purpose-defaults.save", revision: snapshot.defaultsRevision, defaults: { order_review: first.id } })).rejects.toMatchObject({ status: 400 });
    snapshot = await invoke({ operation: "model.status", ...ownedInput(await current(configured.id), first.id), status: "enabled" }) as ConfigurationSnapshot;
    expect(snapshot.channels.find(item => item.id === configured.id)!.models.find(item => item.id === first.id)?.status ?? "enabled").toBe("enabled");
    expect(await model(first.id)).toMatchObject({ id: first.id, maxTaskCostUsd: 25.5 });
    const restored = await route(first.id);
    expect(restored.targets[0]!.analysisPricing).toEqual(pricing);
    expect(restored.targets[0]!.providerConfigId).toBe(initial.targets[0]!.providerConfigId);
    await invoke({ operation: "model.status", ...ownedInput(await current(configured.id), first.id), status: "disabled" });
    await invoke({ operation: "model.remove", ...ownedInput(await current(configured.id), first.id) });
    expect((await current(configured.id)).models.some(item => item.id === first.id)).toBe(false);
    expect((await route(first.id)).targets[0]!.configurationDisabled).not.toBe(true);
  });

  it.each(["queued", "running"] as const)("does not disable or reprice another member's %s work", async status => {
    const configured = await channel(), selected = configured.models.find(item => item.capability === "text")!, saved = await model(selected.id);
    const runId = createEntityId();
    await withTenant(database.db, member, tx => tx.insert(aiAssistRuns).values({ id: runId, tenantId, ownerId: member.userId, requestId: createEntityId(),
      kind: "creative", scope: "unassigned", status, inputFingerprint: "a".repeat(64), requestFingerprint: "b".repeat(64),
      encryptedInput: vault.encrypt("Synthetic settings active input"), modelSnapshot: { ...assistModelExecutionSnapshot(saved), providerConfigId: configured.id },
      promptVersion: "synthetic-model-settings", reservedCostUsd: "0.000000", expiresAt: new Date(Date.now() + 86_400_000),
      startedAt: status === "running" ? new Date() : null }));
    const before = await read(), original = await route(selected.id);
    await expect(invoke({ operation: "model.status", ...ownedInput(await current(configured.id), selected.id), status: "disabled" }))
      .rejects.toMatchObject({ status: 409, response: { code: "model_configuration_model_in_use" } });
    await expect(priced(configured.id, selected.id, null)).rejects.toMatchObject({ status: 409, response: { code: "model_configuration_model_in_use" } });
    await expect(invoke({ operation: "channel.status", id: configured.id, revision: (await current(configured.id)).revision, status: "disabled" }))
      .rejects.toMatchObject({ status: 409, response: { code: "model_configuration_channel_in_use" } });
    expect(await read()).toEqual(before);
    expect(await route(selected.id)).toEqual(original);
    expect((await withTenant(database.db, member, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, runId))))[0]?.status).toBe(status);
    expect(queued).toEqual([]);
  });

  it("creates an unlimited analysis model with unknown prices and distinguishes an explicit free quote", async () => {
    const configured = await channel();
    const created = await assist.addModel(context, { providerConfigId: configured.id, model: "fixture-unpriced-analysis", label: `Unknown price ${createEntityId()}` });
    expect(await model(created.id)).toMatchObject({ inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null });
    expect((await route(created.id)).targets[0]!.analysisPricing).toEqual({ inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null });
    const free = await assist.addModel(context, { providerConfigId: configured.id, model: "fixture-free-analysis", label: `Free quote ${createEntityId()}`,
      inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxTaskCostUsd: null });
    expect(await model(free.id)).toMatchObject({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, maxTaskCostUsd: null });
    await expect(assist.addModel(context, { providerConfigId: configured.id, model: "fixture-invalid-cap", label: `Must not create ${createEntityId()}`, maxTaskCostUsd: 25.5 })).rejects.toThrow();
    expect(queued).toEqual([]);
  });

  it("allows a quote above the old twenty-dollar form limit and keeps saved call usage and pricing immutable", async () => {
    const configured = await channel(), selected = configured.models.find(item => item.capability === "text")!;
    await priced(configured.id, selected.id, 25.5);
    const snapshot = { ...assistModelExecutionSnapshot(await model(selected.id)), providerConfigId: configured.id }, runId = createEntityId();
    await withTenant(database.db, context, tx => tx.insert(aiAssistRuns).values({ id: runId, tenantId, ownerId: context.userId, requestId: createEntityId(),
      kind: "creative", scope: "unassigned", status: "completed", inputFingerprint: "c".repeat(64), requestFingerprint: "d".repeat(64),
      encryptedInput: vault.encrypt("Synthetic immutable input"), encryptedOutput: vault.encrypt("Synthetic immutable output"), modelSnapshot: snapshot,
      promptVersion: "synthetic-model-settings", reservedCostUsd: "25.500000", expiresAt: new Date(Date.now() + 86_400_000),
      inputTokens: 2300, outputTokens: 41, costUsd: "0.123456", completedAt: new Date(),
      tokenUsage: { version: "model-token-usage-v1", inputTokens: 2300, outputTokens: 41, cachedInputTokens: 0, totalTokens: 2341, totalTokensBasis: "provider" } }));
    const before = (await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, runId))))[0]!;
    const identity = await route(selected.id);
    const preferences = await read(), alternate = configured.models.filter(item => item.capability === "text").find(item => item.id !== selected.id)!;
    await invoke({ operation: "purpose-defaults.save", revision: preferences.defaultsRevision, defaults: { creative: alternate.id } });
    expect((await model(alternate.id)).defaultFor).toContain("creative");
    await priced(configured.id, selected.id, null);
    expect(await model(selected.id)).toMatchObject({ inputUsdPerMillion: 2, outputUsdPerMillion: 5, maxTaskCostUsd: null });
    const changed = await route(selected.id);
    expect({ ...changed.targets[0], analysisPricing: undefined }).toEqual({ ...identity.targets[0], analysisPricing: undefined });
    const after = (await withTenant(database.db, context, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, runId))))[0]!;
    expect(after).toEqual(before);
    expect(after.modelSnapshot.maxTaskCostUsd).toBe(25.5);
    expect(after.modelSnapshot).not.toHaveProperty("defaultFor");
    expect(after.tokenUsage?.totalTokens).toBe(2341);
    expect(after.costUsd).toBe("0.123456");
  });

  it("retains a legacy same-provider analysis cap instead of bypassing it through a shared text model", async () => {
    const configured = await channel(), shared = configured.models.find(item => item.capability === "text")!;
    const legacy = await assist.addModel(context, { providerConfigId: configured.id, model: shared.name, label: `Retained cap ${createEntityId()}`,
      inputUsdPerMillion: 3, outputUsdPerMillion: 7, maxTaskCostUsd: 4 });
    expect(await model(shared.id)).toMatchObject({ inputUsdPerMillion: 3, outputUsdPerMillion: 7, maxTaskCostUsd: 4 });
    expect((await current(configured.id)).models.find(item => item.id === shared.id)).toMatchObject({
      analysisPricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 7, maxTaskCostUsd: 4 }, analysisPricingInheritedFrom: legacy.id,
    });
    const before = await route(shared.id), oldAnalysis = await route(legacy.id), preferences = (await read()).defaults;
    await expect(invoke({ operation: "model.analysis-pricing.save", ...ownedInput(await current(configured.id), shared.id),
      pricing: { inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null } }))
      .rejects.toMatchObject({ status: 409, response: { code: "model_configuration_pricing_conflict" } });
    expect(await route(shared.id)).toEqual(before);
    expect(await route(legacy.id)).toEqual(oldAnalysis);
    expect((await read()).defaults).toEqual(preferences);
    expect(await model(shared.id)).toMatchObject({ maxTaskCostUsd: 4 });
    await invoke({ operation: "model.status", ...ownedInput(await current(configured.id), legacy.id), status: "disabled" });
    expect((await assist.models(context)).some(item => item.id === legacy.id)).toBe(false);
    expect(await model(shared.id)).toMatchObject({ inputUsdPerMillion: 3, outputUsdPerMillion: 7, maxTaskCostUsd: 4 });
    expect((await current(configured.id)).models.find(item => item.id === shared.id)?.analysisPricingInheritedFrom).toBe(legacy.id);
    const paused = await route(legacy.id);
    await expect(assist.addModel(context, { providerConfigId: configured.id, model: "replacement-must-not-save", label: paused.modelKey,
      inputUsdPerMillion: null, outputUsdPerMillion: null, maxTaskCostUsd: null }))
      .rejects.toMatchObject({ status: 409, response: { code: "model_configuration_model_paused" } });
    expect(await route(legacy.id)).toEqual(paused);
    expect(await model(shared.id)).toMatchObject({ inputUsdPerMillion: 3, outputUsdPerMillion: 7, maxTaskCostUsd: 4 });
  });

  it.each(["queued", "running"] as const)("protects the inherited quote source when the same provider/model alias has %s work", async status => {
    const configured = await channel(), shared = configured.models.find(item => item.capability === "text")!;
    const legacy = await assist.addModel(context, { providerConfigId: configured.id, model: shared.name, label: `Alias retained cap ${createEntityId()}`,
      inputUsdPerMillion: 3, outputUsdPerMillion: 7, maxTaskCostUsd: 4 });
    const saved = await model(shared.id), runId = createEntityId();
    await withTenant(database.db, member, tx => tx.insert(aiAssistRuns).values({ id: runId, tenantId, ownerId: member.userId, requestId: createEntityId(),
      kind: "creative", scope: "unassigned", status, inputFingerprint: "e".repeat(64), requestFingerprint: "f".repeat(64),
      encryptedInput: vault.encrypt("Synthetic alias work input"), modelSnapshot: { ...assistModelExecutionSnapshot(saved), providerConfigId: configured.id },
      promptVersion: "synthetic-model-settings", reservedCostUsd: "4.000000", expiresAt: new Date(Date.now() + 86_400_000),
      startedAt: status === "running" ? new Date() : null }));
    const before = await read(), source = await route(legacy.id), alias = await route(shared.id);
    await expect(priced(configured.id, legacy.id, null)).rejects.toMatchObject({ status: 409, response: { code: "model_configuration_model_in_use" } });
    expect(await route(legacy.id)).toEqual(source);
    expect(await route(shared.id)).toEqual(alias);
    expect(await read()).toEqual(before);
    expect((await withTenant(database.db, member, tx => tx.select().from(aiAssistRuns).where(eq(aiAssistRuns.id, runId))))[0]?.status).toBe(status);
  });

  it.each(["loop", "native_plan"] as const)("preserves another member's active %s snapshot and budget when configuration is changed", async family => {
    const configured = await channel(), selected = configured.models.find(item => item.capability === "text")!;
    await priced(configured.id, selected.id, 4);
    const membershipId = createEntityId(), roleId = createEntityId();
    await withTenant(database.db, member, async tx => {
      await tx.insert(memberships).values({ id: membershipId, tenantId, userId: member.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId, name: `Synthetic settings guard ${roleId}`, permissions: member.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId });
    });
    const actor = await withTenant(database.db, member, tx => loadCurrentMembershipContext(tx, member));
    const saved = await model(selected.id, actor), runId = createEntityId(), ledgerId = createEntityId(), requestId = createEntityId();
    const contract = family === "loop" ? agentLoopHarness.pin(agentLoopSkill) : agentNativeV4Harness.pin(agentNativeV4Skill);
    const readContract = family === "loop" ? agentReadHarness.pin({ key: "erp.agent.read", version: AGENT_READ_VERSION }) : agentNativeV4Harness.pin(agentNativeV4ReadSkill);
    const input = JSON.stringify({ fixture: "Synthetic settings guard only", requestId, modelId: selected.id, ownerId: actor.userId });
    const inputChecksum = createHash("sha256").update(input).digest("hex"), requestChecksum = createHash("sha256").update(requestId).digest("hex");
    const routeFingerprint = await withTenant(database.db, actor, tx => readModelExecutionRouteFingerprint(tx, selected.id));
    expect(routeFingerprint).toMatch(/^[a-f0-9]{64}$/);
    const record = { id: runId, tenantId, ownerId: actor.userId, requestId, requestChecksum, inputChecksum, encryptedInput: vault.encrypt(input),
      originCeiling: actor, executionContract: contract, readExecutionContract: readContract,
      modelSnapshot: { ...assistModelExecutionSnapshot(saved), providerConfigId: configured.id, routeFingerprint: routeFingerprint! },
      budgetLedgerId: ledgerId, capUsd: "4.000000", deadlineAt: sql`clock_timestamp()+interval '600 seconds'`, expiresAt: sql`clock_timestamp()+interval '1 day'` };
    // These retained snapshots are never enqueued or executed. The test exercises
    // the real tenant-scoped configuration guard and actual native table records.
    await withTenant(database.db, actor, async tx => {
      await tx.insert(aiBudgetLedger).values({ id: ledgerId, tenantId, requestId: runId, taskType: family === "loop" ? "erp_agent" : "erp_agent_plan", modelKey: saved.model, provider: "synthetic-fixture", amountUsd: "4.000000", state: "reserved" });
      if (family === "loop") await tx.insert(agentLoopRuns).values({ ...record, status: "queued", allowedTools: ["orders.exceptions.page"], limits: defaultAgentLoopLimits() });
      else await tx.insert(agentPlanRuns).values({ ...record, version: "erp-agent-native-v4", status: "queued", allowedReads: ["orders.exceptions.page"], allowedCommands: [], limits: defaultAgentNativeV4Limits() });
      await recordAuditInTransaction(tx, actor, { action: family === "loop" ? "agent.loop.create" : "agent.plan.create", resourceType: family === "loop" ? "agent_loop_run" : "agent_plan_run",
        resourceId: runId, result: "success", metadata: { requestChecksum, inputChecksum, budgetLedgerId: ledgerId } });
    });
    if (family === "native_plan") {
      // stop() needs only the authenticated original row and real membership.
      // The absent read/command ports must never run in this configuration test.
      const stopOwner = new NativeServiceEngine(agentNativeV4Protocol, database, vault, null!, null!, null!, { enqueue: async () => { throw new Error("Configuration guard fixture must never enqueue"); } });
      expect(await stopOwner.stop(actor, runId, { version: "erp-agent-native-v4", requestId })).toMatchObject({ runId, status: "stopping" });
    }
    const readNative = () => withTenant(database.db, actor, async tx => ({
      rows: family === "loop" ? await tx.select().from(agentLoopRuns).where(eq(agentLoopRuns.id, runId)) : await tx.select().from(agentPlanRuns).where(eq(agentPlanRuns.id, runId)),
      ledger: await tx.select().from(aiBudgetLedger).where(eq(aiBudgetLedger.id, ledgerId)),
    }));
    const before = await readNative(), original = await route(selected.id);
    expect(before.rows[0]).toMatchObject({ ownerId: actor.userId, status: family === "loop" ? "queued" : "stopping" });
    expect(before.ledger[0]).toMatchObject({ requestId: runId, state: "reserved", amountUsd: "4.000000" });
    await expect(invoke({ operation: "model.status", ...ownedInput(await current(configured.id), selected.id), status: "disabled" }))
      .rejects.toMatchObject({ status: 409, response: { code: "model_configuration_model_in_use" } });
    await expect(priced(configured.id, selected.id, null)).rejects.toMatchObject({ status: 409, response: { code: "model_configuration_model_in_use" } });
    await expect(invoke({ operation: "channel.status", id: configured.id, revision: (await current(configured.id)).revision, status: "disabled" }))
      .rejects.toMatchObject({ status: 409, response: { code: "model_configuration_channel_in_use" } });
    await expect(invoke({ operation: "model.remove", ...ownedInput(await current(configured.id), selected.id) }))
      .rejects.toMatchObject({ status: 409, response: { code: "model_configuration_model_busy" } });
    expect(await route(selected.id)).toEqual(original);
    expect(await readNative()).toEqual(before);
    expect(queued).toEqual([]);
  });

  it("changes the display label without changing route identity, stored credentials, protocol or call history", async () => {
    const configured = await channel(), selected = configured.models.find(item => item.capability === "text")!;
    const before = await route(selected.id), provider = (await withTenant(database.db, context, tx => tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, configured.id))))[0]!;
    const saved = await invoke({ operation: "model.update", ...ownedInput(configured, selected.id), label: "Synthetic readable model label" }) as ConfigurationSnapshot;
    expect(saved.channels.find(item => item.id === configured.id)!.models.find(item => item.id === selected.id)).toMatchObject({ id: selected.id, label: "Synthetic readable model label" });
    const after = await route(selected.id);
    expect(after.targets).toEqual(before.targets);
    expect(after.taskType).toBe(before.taskType);
    expect((await withTenant(database.db, context, tx => tx.select().from(modelProviderConfigs).where(eq(modelProviderConfigs.id, configured.id))))[0]).toEqual(provider);
    await expect(invoke({ operation: "model.update", ...ownedInput(configured, selected.id), label: "Stale update must not persist" })).rejects.toMatchObject({ status: 409 });
    expect((await route(selected.id)).modelKey).toBe("Synthetic readable model label");
    expect(directoryRequests.every(request => request.method === "GET" && request.path === "/v1/models")).toBe(true);
  });
});
