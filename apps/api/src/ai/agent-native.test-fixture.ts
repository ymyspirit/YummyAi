import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import type * as Psd from "../../../../packages/mockup-renderer/node_modules/ag-psd/dist/index.js";
import { OpenAiCompatibleProvider, createEnvironmentSecretVault, type ModelResponseCheckpoint, type ResolvedModelRequest, type SecretVault } from "@yummyai/ai-core";
import { intersectPermissionContexts } from "@yummyai/authz";
import { createEntityId, CreateMockupTemplateInspectionInputSchema, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { AgentCommandOriginalSchema, type AgentCommandOriginal } from "@yummyai/contracts/ai/agent-command";
import { agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import { AGENT_NATIVE_VERSION, AgentNativeDecisionSchema, AgentNativeTurnInputSchema, CreateAgentNativeSchema,
  PrepareAgentNativeItemSchema, canonicalAgentNativeRequest, defaultAgentNativeLimits, type CreateAgentNative,
  type AgentNativeClaim, type AgentNativeDecision, type AgentNativeTurnInput, type AgentNativeView } from "@yummyai/contracts/ai/agent-native";
import { AgentToolCallSchema, AgentToolDefinitionRequestSchema, type AgentToolCall } from "@yummyai/contracts/ai/agent-tools";
import type { KnowledgeFields } from "@yummyai/contracts/knowledge";
import { agentPlanRuns, agentPlanSteps, agentPlanItems, aiBudgetLedger, memberships, marketplaceAccounts, connectDatabase, withTenant, loadCurrentMembershipContext, type DatabaseConnection } from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { AgentNativeRuntime } from "../../../../packages/workflow-core/src/agent-native-runtime.js";
import type { AgentNativeToolsPort } from "../../../../packages/workflow-core/src/agent-native-model.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { roleBenchmarkOwners, roleEnvelope } from "../../../../tools/testing/role-benchmark-fixture.mjs";
import { syntheticSupplierProfile } from "../../../../tools/testing/factory-fixtures.js";
import { MockupTemplateCompileProcessor } from "../../../worker/src/processors/pod-batch-workflow.processor.js";
import { CreativeExecutionOperatorService } from "../design/creative-execution-operator.service.js";
import { FactoryDirectoryService } from "../suppliers/factory-directory.service.js";
import { FactoryCapacityService } from "../suppliers/factory-capacity.service.js";
import { createSyntheticFactory } from "../suppliers/factory-directory.test-fixture.js";
import { createSyntheticFactoryCapacity } from "../suppliers/factory-capacity.test-fixture.js";
import { OrderRoutingService } from "../orders/order-routing.service.js";
import { agentPlanFixture } from "./agent-plan.test-fixture.js";
import { type AgentActor } from "./agent-read.test-fixture.js";
import { AgentToolOwners } from "./agent-tool-owners.js";
import { AgentToolsService } from "./agent-tools.service.js";
import { AgentNativeService } from "./agent-native.service.js";
import type { AgentPlanDispatcher } from "./agent-plan.service.js";
import { createQueue, QueueName, JobEnvelopeSchema } from "@yummyai/jobs";
import { AgentPlanProcessor } from "../../../worker/src/processors/agent-plan.processor.js";
import { agentPlanRuntimeRouter } from "../../../worker/src/agent-plan-runtime-router.js";

export const agentNativeSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export function requireAgentNativeEnvironment(environment: NodeJS.ProcessEnv = process.env, target: "current" | "pre-0175" = "current") {
  const url = new URL(requireDisposableIntegrationEnvironment(environment)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = environment.E2E_DISPOSABLE_REDIS_URL;
  const flags = ["E2E_AGENT_NATIVE_ISOLATED", "E2E_AGENT_TOOLS_ISOLATED", "E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED",
    "E2E_ROLE_BENCHMARK_ISOLATED", "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED", "E2E_ISOLATED_DAILY"];
  if (!nonce || flags.some(key => environment[key] !== "1") || environment.E2E_LEGACY_SCHEMA_TARGET !== target || !local.includes(url.hostname) ||
    environment.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || environment.REDIS_URL !== redis ||
    environment.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` || !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("Native Agent fixture requires every opt-in and the exact disposable current nonce database bucket and Redis before construction or connection");
  return { url: url.href, nonce };
}

/** Claims copy actual native scalar fields. They do not establish proposed
 * prices, currency conversion, business correctness or production approval. */
export function nativeClaims(packet: AgentNativeTurnInput): AgentNativeClaim[] {
  const claims: AgentNativeClaim[] = [];
  for (const observation of packet.observations) for (const [resultIndex, result] of observation.results.entries()) {
    const add = (path: AgentNativeClaim["path"], value: AgentNativeClaim["value"]) => claims.push({ stepId: observation.stepId, resultIndex, dataChecksum: result.dataChecksum, path, value });
    if (result.tool === "inventory.balances.page") {
      const row = result.data.items[0]; if (row) { add(["items", 0, "physicalQuantity"], row.physicalQuantity); add(["items", 0, "unit"], row.unit); }
      if (observation.collectionComplete && resultIndex === 0) add(["total"], result.data.total);
    } else if (result.tool === "orders.exceptions.page") { const row = result.data.items[0]; if (row) add(["items", 0, "category"], row.category); }
    else if (result.tool === "knowledge.search") { const row = result.data.references[0]; if (row) add(["references", 0, "checksum"], row.checksum); }
    else if (result.tool === "creative.history") { const row = result.data.entries[0]; if (row) add(["entries", 0, "phase"], row.phase); }
    else { add(["factoryId"], result.data.factoryId); if (result.data.calendar[0]) add(["calendar", 0, "capacityUnits"], result.data.calendar[0].capacityUnits); }
  }
  return claims;
}
export function finishNative(packet: AgentNativeTurnInput, originals: readonly AgentCommandOriginal[] = []): AgentNativeDecision {
  const claims = nativeClaims(packet);
  return AgentNativeDecisionSchema.parse({ action: "finish", label: "Seal original bounded native evidence without business execution", definition: null, read: null,
    result: { summary: "Synthetic model transport proposes individually reviewable originals; exact cited fields do not prove commercial parameters", claims,
      missingInformation: packet.observations.some(row => row.collectionComplete === false) ? ["Original paged collection is only a bounded prefix"] : [],
      proposals: originals.map((original, position) => {
        const slot = packet.slots[position]; if (!slot) throw new Error("Synthetic proposal exceeds actual server slots");
        const fixed = AgentCommandOriginalSchema.parse({ ...original, command: { ...original.command, input: { ...original.command.input, idempotencyKey: slot.idempotencyKey } } });
        return { position, capability: { domain: original.domain, kind: original.command.kind }, label: "Review synthetic original " + original.domain,
          reason: "Operator-provided parameters need separate original-owner review", draftJson: JSON.stringify(fixed), claimIndexes: claims.map((_, index) => index), missingInformation: [] };
      }) } });
}
export function nativeSequence(packet: AgentNativeTurnInput, originals: readonly AgentCommandOriginal[] = [], keyword = "Synthetic native evidence"): AgentNativeDecision {
  for (const [bindingIndex, binding] of packet.bindings.entries()) {
    if (!packet.definitions.some(row => row.definition.selection.kind === "read" && row.definition.selection.tool === binding.tool))
      return AgentNativeDecisionSchema.parse({ action: "definition", label: "Load only the selected original read schema", definition: { kind: "read", tool: binding.tool }, read: null, result: null });
    if (!packet.observations.some(row => row.request.bindingIndex === bindingIndex)) return AgentNativeDecisionSchema.parse({ action: "read", label: "Read the fixed native object and scope",
      definition: null, read: { bindingIndex, keyword: binding.tool === "knowledge.search" ? keyword : null }, result: null });
  }
  for (const original of originals) if (!packet.definitions.some(row => row.definition.selection.kind === "command" && agentPlanCommandKey(row.definition.selection.command) === agentPlanCommandKey({ domain: original.domain, kind: original.command.kind })))
    return AgentNativeDecisionSchema.parse({ action: "definition", label: "Load exactly one proposed native command schema", definition: { kind: "command", command: { domain: original.domain, kind: original.command.kind } }, read: null, result: null });
  return finishNative(packet, originals);
}

/** Every read, scan, parser and original command is its real owner. The only
 * synthetic model boundary is HTTP transport. This fixture never approves a
 * production file, reserves factory capacity or publishes a marketplace item. */
export function agentNativeFixture(database: DatabaseConnection, options: { contentVault?: SecretVault; modelVault?: SecretVault } = {}) {
  requireAgentNativeEnvironment();
  const prior = agentPlanFixture(database, options), originalBase = prior.base, commandOwners = prior.owners;
  const actorContext = (actor: AgentActor): AgentActor => ({ ...actor, context: TenantContextSchema.parse(actor.context) });
  // Old test actors have subject/roleIds bookkeeping. Only actual membership
  // permission fields may cross a strict native owner boundary; never forward
  // that actor object as an authorization context or edit the old fixture.
  const base = { ...originalBase,
    current: async (actor: Pick<AgentActor, "tenantId" | "userId">) => TenantContextSchema.parse(await originalBase.current({ tenantId: actor.tenantId, userId: actor.userId })),
    actor: async (...args: Parameters<typeof originalBase.actor>) => actorContext(await originalBase.actor(...args)),
    scopes: async (...args: Parameters<typeof originalBase.scopes>) => TenantContextSchema.parse(await originalBase.scopes(...args)),
    get a() { return actorContext(originalBase.a); }, get second() { return actorContext(originalBase.second); }, get foreign() { return actorContext(originalBase.foreign); },
    get modelId() { return originalBase.modelId; },
  };
  const facts = roleBenchmarkOwners(database, base.originalVault, { assistVault: options.contentVault ?? base.vault });
  const creative = new CreativeExecutionOperatorService(database), factories = new FactoryDirectoryService(database, base.audit), capacity = new FactoryCapacityService(database, base.audit);
  const nativeOwners = new AgentToolOwners(base.knowledge, creative, capacity, prior.gateway), gateway = new AgentToolsService(database, base.integrationVault, nativeOwners, commandOwners.adapter);
  const dispatcherCalls: Array<Parameters<AgentPlanDispatcher["enqueue"]>[0]> = [], modelCalls: AgentNativeTurnInput[] = [];
  const definitionCalls: Array<{ context: TenantContext; input: z.infer<typeof AgentToolDefinitionRequestSchema> }> = [];
  const readCalls: Array<{ context: TenantContext; input: AgentToolCall; result?: Awaited<ReturnType<AgentToolsService["call"]>> }> = [];
  const wire: Array<{ bodyBytes: number; schemaBytes: number }> = [];
  const controls: { failQueue: boolean; unknownUsage: boolean; decision: (packet: AgentNativeTurnInput) => unknown;
    beforeModel?: (packet: AgentNativeTurnInput) => Promise<void>; afterCheckpoint?: (packet: AgentNativeTurnInput, value: ModelResponseCheckpoint) => Promise<void>;
    beforeRead?: (context: TenantContext, input: AgentToolCall) => Promise<void>; afterRead?: (result: Awaited<ReturnType<AgentToolsService["call"]>>) => Promise<void> } = {
    failQueue: false, unknownUsage: false, decision: packet => nativeSequence(packet) };
  const dispatcher: AgentPlanDispatcher = { enqueue: async value => { dispatcherCalls.push(value); if (controls.failQueue) throw new Error("Synthetic native queue unavailable"); } };
  const tools: AgentNativeToolsPort = { workspace: context => gateway.workspace(context), definition: async (context, raw) => {
    const input = AgentToolDefinitionRequestSchema.parse(raw);
    definitionCalls.push({ context, input }); return gateway.definition(context, input);
  }, call: async (context, raw) => { const input = AgentToolCallSchema.parse(raw), call: (typeof readCalls)[number] = { context, input }; readCalls.push(call); await controls.beforeRead?.(context, input);
    const result = await gateway.call(context, input); call.result = result; await controls.afterRead?.(result); return result; } };
  const service = (retentionSeconds?: number) => new AgentNativeService(database, options.contentVault ?? base.vault, gateway, commandOwners.service(), commandOwners.adapter, dispatcher, retentionSeconds);
  const runtime = () => new AgentNativeRuntime({ database, contentVault: options.contentVault ?? base.vault, modelVault: options.modelVault ?? base.modelVault, tools,
    providerFactory: (provider, apiKey, model) => new class extends OpenAiCompatibleProvider {
      override generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal) {
        const packet = AgentNativeTurnInputSchema.parse(request.untrustedSourceData);
        return super.generate({ ...request, onResponseCheckpoint: async value => { await request.onResponseCheckpoint?.(value); await controls.afterCheckpoint?.(packet, value); } }, signal);
      }
    }({ providerId: provider.id, apiKey, endpoint: "https://synthetic-agent-native.invalid/v1", pricing: model.inputUsdPerMillion === null || model.outputUsdPerMillion === null ? null : {
      inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion }, fetch: async (_url, init) => {
        const text = String(init?.body), body = JSON.parse(text) as { messages?: Array<{ role?: string; content?: unknown }>; response_format?: unknown };
        const user = body.messages?.find(row => row.role === "user")?.content, framed = typeof user === "string" ? /<untrusted_source_data>\n([\s\S]*)\n<\/untrusted_source_data>/.exec(user)?.[1] : undefined;
        const packet = AgentNativeTurnInputSchema.parse(JSON.parse(framed ?? "null")); modelCalls.push(packet);
        wire.push({ bodyBytes: Buffer.byteLength(text), schemaBytes: Buffer.byteLength(JSON.stringify(body.response_format ?? null)) });
        await controls.beforeModel?.(packet);
        return Response.json({ id: "synthetic-native-" + createEntityId(), choices: [{ message: { content: JSON.stringify(controls.decision(packet)) } }],
          ...(controls.unknownUsage ? {} : { usage: { prompt_tokens: 50, completion_tokens: 80 } }) });
      } }),
  });
  async function request(actor = base.a, changes: Partial<CreateAgentNative> = {}) {
    const workspace = await service().workspace(await base.current(actor));
    return CreateAgentNativeSchema.parse({ version: AGENT_NATIVE_VERSION, requestId: randomUUID(), modelId: base.modelId, goal: "Read actual native evidence and offer unapproved original commands",
      contextText: "Synthetic operator statements are not verified evidence", bindings: [{ tool: "inventory.balances.page", scope: {} }], allowedCommands: [],
      limits: { ...defaultAgentNativeLimits(), maxModelTurns: 16 }, maxCostUsd: 1, executionContract: workspace.executionContract, ...changes });
  }
  async function card(context: TenantContext, query: string, publish: boolean, spuId: string | null = null) {
    const fields: KnowledgeFields = { title: query, summary: query, body: query + " actual reviewed native evidence", topic: "operations", platform: "all", market: "ALL", spuId,
      sourceType: "team", sourceLabel: "Synthetic reviewed original", sourceUrl: "", owner: "Synthetic reviewer", verifiedOn: "2026-01-01", reviewDueOn: "2099-12-31", tags: [] };
    const saved = await base.knowledge.save(context, null, { fields, expectedRevision: 0, reason: "Synthetic native source", requestId: randomUUID() });
    if (publish) { await base.knowledge.change(context, saved.id, "submit", { expectedRevision: 1, version: 1, reason: "Actual fixture review", requestId: randomUUID() });
      await base.knowledge.change(context, saved.id, "publish", { expectedRevision: 2, version: 1, reason: "Actual fixture publication", requestId: randomUUID() }); }
    return saved.id;
  }
  async function inspection(context: TenantContext) {
    const bytes = await readFile(new URL("../../../../packages/mockup-renderer/fixtures/controlled-canvas.psd", import.meta.url));
    const psd = createRequire(new URL("../../../../packages/mockup-renderer/package.json", import.meta.url))("ag-psd") as typeof Psd;
    const source = psd.readPsd(bytes, { useImageData: true, skipThumbnail: true }), slotKey = "main-" + context.userId + "-" + createEntityId().slice(-12);
    const slot = source.children?.find(row => row.name === "@slot:main"); if (!slot) throw new Error("Actual controlled PSD slot missing"); slot.name = "@slot:" + slotKey;
    const asset = await facts.ownedAsset(context, psd.writePsdBuffer(source, { generateThumbnail: false }), "synthetic-native-distinct.psd", "image/vnd.adobe.photoshop");
    const created = await facts.mockups.createInspection(context, CreateMockupTemplateInspectionInputSchema.parse({ sourceAssetId: asset.id, sourceAssetVersion: asset.version, checksumSha256: asset.checksumSha256, slotKey }));
    const [row] = await withTenant(database.db, context, tx => tx.execute<{ actor: string }>(sql`select requested_by as actor from creative_executions where inspection_id=${created.id}::uuid`));
    if (row?.actor !== context.userId) throw new Error("Actual PSD execution must retain its original actor");
    await new MockupTemplateCompileProcessor(database, facts.storage).process(roleEnvelope(context, { inspectionId: created.id }));
    const history = await creative.history(context, "inspection", created.id);
    if (!history.entries.some(entry => entry.phase === "completed" && entry.artifacts.length)) throw new Error("Actual controlled PSD compile did not complete with its artifact");
    return { id: created.id, asset, history };
  }
  async function source(actor = base.a) { return sourceContext(await base.current(actor)); }
  async function sourceContext(context: TenantContext) {
    const [member] = await withTenant(database.db, context, tx => tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, context.userId), eq(memberships.status, "active"))));
    if (!member) throw new Error("Actual native source actor requires active membership");
    const actor: AgentActor = { tenantId: context.tenantId, userId: context.userId, membershipId: member.id, subject: "unused-existing-fixture-member", roleIds: new Map(), context };
    const raw = await prior.sourceContext(context), query = "Synthetic native " + randomUUID().replace(/[0-9]/g, value => String.fromCharCode(97 + Number(value))).replaceAll("-", "");
    const published: string[] = []; for (let index = 0; index < 7; index++) published.push(await card(context, query + " " + String.fromCharCode(97 + index), true));
    const draftId = await card(context, query + " unpublished", false), compiled = await inspection(context);
    // Browser leaves share one real operator but restart this child. An old
    // fixture's process-local account cache cannot provide a unique shop name.
    const accountId = createEntityId(), orderKey = createEntityId();
    await withTenant(database.db, context, tx => tx.insert(marketplaceAccounts).values({ id: accountId, tenantId: context.tenantId, platform: "etsy",
      displayName: "Synthetic native metadata " + accountId, region: "GLOBAL", authorizationMode: "etsy_oauth", createdBy: context.userId }));
    const order = await base.orders.ingestNormalized(context, { accountId, platform: "etsy", externalEventId: `${orderKey}:1`, externalOrderId: orderKey,
      providerStatus: "paid", placedAt: new Date().toISOString(), orderTotal: { amountMinor: 1000, currency: "USD" },
      lines: [{ externalLineId: `${orderKey}-line`, externalListingId: null, skuCode: null, title: "Synthetic non-artwork item", quantity: 1,
        unitPrice: { amountMinor: 1000, currency: "USD" }, customizationCount: 0 }], redactedSource: { fixture: orderKey }, protectedDetails: null });
    await base.exception(order.id, actor);
    const routing = new OrderRoutingService(database, commandOwners.orders, base.audit);
    await routing.updateSupplier(context, raw.supplierId, { name: "Synthetic native capacity parent", regionCode: "US", settlementCurrency: "USD", profile: syntheticSupplierProfile, status: "active" });
    const site = await createSyntheticFactory(factories, context, raw.supplierId, "other", "Synthetic native metadata site");
    const pool = await createSyntheticFactoryCapacity(database, context, { factory: site.factory, capacityUnits: 10, bindings: [{ capabilityVersionId: site.capability.versionId, unitsPerItem: 1 }] });
    const bindings: CreateAgentNative["bindings"] = [{ tool: "orders.exceptions.page", scope: { status: "all", orderId: order.id } }, { tool: "inventory.balances.page", scope: { stockItemId: raw.stockItemId } },
      { tool: "knowledge.search", scope: { topic: "operations", platform: "all", market: "ALL", spuIds: [] } }, { tool: "creative.history", scope: { scope: "inspection", ownerId: compiled.id } },
      { tool: "factory.capacity", scope: { factoryId: site.factory.id, query: { from: pool.localDate, days: 2 } } }];
    return { ...raw, bindings, query, published, draftId, compiled, order, site, pool };
  }
  const rows = (context = base.a.context) => withTenant(database.db, context, async tx => ({ runs: await tx.select().from(agentPlanRuns).orderBy(agentPlanRuns.id),
    steps: await tx.select().from(agentPlanSteps).orderBy(agentPlanSteps.id), items: await tx.select().from(agentPlanItems).orderBy(agentPlanItems.id),
    ledgers: await tx.select().from(aiBudgetLedger).orderBy(aiBudgetLedger.id), audits: await tx.execute<{ id: string; action: string; entity_id: string; metadata: unknown }>(sql`select id,action,entity_id,metadata from audit_events where action like 'agent.plan.%' order by id`) }));
  const clear = () => { prior.clear(); controls.failQueue = false; controls.unknownUsage = false; controls.beforeModel = undefined; controls.beforeRead = undefined; controls.afterRead = undefined;
    controls.afterCheckpoint = undefined; controls.decision = packet => nativeSequence(packet); };
  async function initialize() { await prior.initialize(); await facts.initialize(); }
  const checksum = (value: unknown) => agentNativeSha(canonicalAgentNativeRequest(value));
  const prepareInput = (run: Pick<AgentNativeView, "requestId">, item: { proposalChecksum: string }) => PrepareAgentNativeItemSchema.parse({ version: AGENT_NATIVE_VERSION, requestId: run.requestId, proposalChecksum: item.proposalChecksum });
  return { prior, base, owners: commandOwners, facts, creative, factories, capacity, nativeOwners, gateway, tools, service, runtime, controls, dispatcherCalls, modelCalls, definitionCalls, readCalls, wire,
    request, source, sourceContext, card, inspection, rows, business: prior.business, clear, checksum, confirmation: prior.confirmation, prepareInput, initialize, settlePrepared: prior.settlePrepared,
    close() { facts.close(); prior.close(); }, process: (id: string, actor: AgentActor = base.a) => runtime().process(actor.context, id) };
}

export const AgentNativeBrowserSeedSchema = z.object({ stockItemId: z.uuidv7(), supplierId: z.uuidv7(), inspectionId: z.uuidv7(), factoryId: z.uuidv7(),
  from: z.iso.date(), query: z.string(), originals: z.array(AgentCommandOriginalSchema).length(2), contextText: z.string().max(16_000) }).strict();
export const AgentNativeBrowserStatsSchema = z.object({ modelCalls: z.int().nonnegative(), readCalls: z.int().nonnegative(), definitionCalls: z.int().nonnegative(),
  modelGateEntered: z.boolean(), settled: z.boolean(), failure: z.string().nullable(), originalQueueJobId: z.string().nullable() }).strict();

/** A compiled-browser test loads decorated native owners only in its own
 * exact-nonce tsx child. Importing this fixture does not spawn or connect. */
async function nativeBrowserChild() {
  const { url, nonce } = requireAgentNativeEnvironment(), database = connectDatabase(url);
  const fixture = agentNativeFixture(database, { contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
    modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config") });
  const queue = createQueue(QueueName.AgentPlan, process.env.E2E_DISPOSABLE_REDIS_URL);
  let context: TenantContext | undefined, source: Awaited<ReturnType<typeof fixture.sourceContext>> | undefined, active: Promise<unknown> | undefined;
  let settled = false, modelGateEntered = false, failure: string | null = null, originalQueueJobId: string | null = null;
  let releaseGate: (() => void) | undefined, serial = Promise.resolve(), closed = false, phase = "ready";
  const stats = () => AgentNativeBrowserStatsSchema.parse({ modelCalls: fixture.modelCalls.length, readCalls: fixture.readCalls.length, definitionCalls: fixture.definitionCalls.length,
    modelGateEntered, settled, failure, originalQueueJobId });
  const close = async () => {
    if (closed) return; closed = true; releaseGate?.(); const errors: unknown[] = [];
    try { await active; } catch (error) { errors.push(error); }
    try { await queue.close(); } catch (error) { errors.push(error); }
    try { fixture.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "agent_native_child_cleanup_failed");
  };
  process.on("disconnect", () => { releaseGate?.(); void serial.then(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => {
    serial = serial.then(async () => {
      if (!raw || typeof raw !== "object") return; const message = raw as Record<string, unknown>;
      if (message.nonce !== nonce || typeof message.id !== "number") return;
      try {
        let value: unknown;
        if (message.operation === "close") { await close(); value = { closed: true }; }
        else if (message.operation === "seed") {
          phase = "identity"; const caller = TenantContextSchema.parse(message.context);
          context = await withTenant(database.db, caller, async tx => TenantContextSchema.parse(intersectPermissionContexts(caller, await loadCurrentMembershipContext(tx, caller, { lock: true }))));
          phase = "real_native_sources"; await fixture.facts.initialize(); source = await fixture.sourceContext(context);
          value = AgentNativeBrowserSeedSchema.parse({ stockItemId: source.stockItemId, supplierId: source.supplierId, inspectionId: source.compiled.id, factoryId: source.site.factory.id,
            from: source.pool.localDate, query: source.query, originals: source.originals, contextText: source.contextText });
        } else if (message.operation === "execute") {
          if (!source || !context || active && !settled) throw new Error("agent_native_child_sources_unavailable");
          const id = z.uuidv7().parse(message.runId), job = await queue.getJob(id); if (!job?.id) throw new Error("agent_native_original_redis_intent_missing");
          const envelope = JobEnvelopeSchema.parse(job.data), payload = z.object({ runId: z.uuidv7(), operation: z.literal("execute") }).strict().parse(envelope.payload);
          if (payload.runId !== id || envelope.tenantId !== context.tenantId || envelope.requestedBy !== context.userId) throw new Error("agent_native_original_queue_identity_mismatch");
          originalQueueJobId = job.id; settled = false; failure = null; modelGateEntered = false;
          let gate: Promise<void> | undefined; if (message.holdFirstModel === true) gate = new Promise(accept => { releaseGate = accept; });
          fixture.controls.beforeModel = async packet => { if (packet.turn === 1 && gate) { modelGateEntered = true; await gate; } };
          fixture.controls.decision = packet => nativeSequence(packet, source!.originals.filter(original => packet.allowedCommands.some(command => command.domain === original.domain && command.kind === original.command.kind)), source!.query);
          phase = "actual_native_processor";
          active = new AgentPlanProcessor(agentPlanRuntimeRouter(database, fixture.prior.runtime(), fixture.runtime())).process(envelope).then(result => { settled = true; return result; }, error => { settled = true; failure = "runtime_rejected"; throw error; });
          void active.catch(() => {}); value = { started: true, originalQueueJobId };
        } else if (message.operation === "progress") value = stats();
        else if (message.operation === "release") { releaseGate?.(); value = { released: true }; }
        else if (message.operation === "wait") { await active; value = stats(); }
        else if (message.operation === "business") { if (!context) throw new Error("agent_native_child_identity_missing"); value = await fixture.business(context); }
        else throw new Error("agent_native_child_operation_invalid");
        process.send?.({ type: "result", nonce, id: message.id, value });
      } catch (error) {
        let code: string | null = null, candidate: unknown = error;
        for (let depth = 0; depth < 8 && candidate && typeof candidate === "object"; depth++) {
          if ("code" in candidate && typeof candidate.code === "string" && /^[A-Z0-9]{5}$/.test(candidate.code)) { code = candidate.code; break; }
          candidate = "cause" in candidate ? candidate.cause : null;
        }
        process.send?.({ type: "failure", nonce, id: message.id, phase, code });
      }
    });
  });
  process.send?.({ type: "ready", nonce });
}
if (process.argv.includes("--agent-native-browser-child")) void nativeBrowserChild().catch(() => { process.exitCode = 1; });
