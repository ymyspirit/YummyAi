import "reflect-metadata";
import { createHash, randomUUID } from "node:crypto";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { OpenAiCompatibleProvider, createEnvironmentSecretVault, type ModelResponseCheckpoint, type ResolvedModelRequest, type SecretVault } from "@yummyai/ai-core";
import { Permission, intersectPermissionContexts } from "@yummyai/authz";
import { TenantContextSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { AgentCommandOriginalSchema, type AgentCommandOriginal } from "@yummyai/contracts/ai/agent-command";
import { agentPlanCommandKey } from "@yummyai/contracts/ai/agent-plan";
import { AgentToolCallSchema } from "@yummyai/contracts/ai/agent-tools";
import { AgentResourceCallSchema } from "@yummyai/contracts/ai/agent-resources";
import { AGENT_NATIVE_V2_VERSION, AgentNativeV2BindingSchema, AgentNativeV2DecisionSchema, AgentNativeV2TurnInputSchema,
  CreateAgentNativeV2Schema, PrepareAgentNativeV2ItemSchema, canonicalAgentNativeV2Request, defaultAgentNativeV2Limits,
  agentNativeV2DefinitionSelection, type AgentNativeV2Claim, type AgentNativeV2TurnInput,
  type AgentNativeV2View, type CreateAgentNativeV2 } from "@yummyai/contracts/ai/agent-native-v2";
import { agentPlanRuns, agentPlanItems, agentCommandRequests, memberships, connectDatabase, loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { JobEnvelopeSchema, createQueue, QueueName } from "@yummyai/jobs";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { AgentNativeV2Runtime } from "../../../../packages/workflow-core/src/agent-native-v2-runtime.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AgentPlanProcessor } from "../../../worker/src/processors/agent-plan.processor.js";
import { agentPlanRuntimeRouter } from "../../../worker/src/agent-plan-runtime-router.js";
import { agentNativeFixture } from "./agent-native.test-fixture.js";
import { agentResourcesFixture } from "./agent-resources.test-fixture.js";
import { type AgentActor } from "./agent-read.test-fixture.js";
import { AgentNativeV2Service } from "./agent-native-v2.service.js";
import { AgentNativeV2Controller } from "./agent-native-v2.controller.js";
import type { AgentPlanDispatcher } from "./agent-plan.service.js";
import { RedisAgentPlanDispatcher } from "./redis-agent-plan-dispatcher.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

export const nativeV2Hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
type AgentNativeV2Decision = z.infer<typeof AgentNativeV2DecisionSchema>;
export const nativeV2Scopes = () => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));
export const nativeV2Flags = ["E2E_AGENT_NATIVE_V2_ISOLATED", "E2E_AGENT_RESOURCES_ISOLATED", "E2E_AGENT_MCP_ISOLATED", "E2E_AGENT_NATIVE_ISOLATED",
  "E2E_AGENT_TOOLS_ISOLATED", "E2E_AGENT_PLAN_ISOLATED", "E2E_AGENT_LOOP_ISOLATED", "E2E_AGENT_COMMAND_ISOLATED", "E2E_AGENT_READ_ISOLATED",
  "E2E_ROLE_BENCHMARK_ISOLATED", "E2E_BUSINESS_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_BENCHMARK_ISOLATED", "E2E_KNOWLEDGE_EVALUATION_ISOLATED", "E2E_ISOLATED_DAILY"] as const;
export function requireAgentNativeV2Environment(env: NodeJS.ProcessEnv = process.env, target: "current" | "pre-0176" = "current") {
  const url = new URL(requireDisposableIntegrationEnvironment(env)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = env.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || nativeV2Flags.some(key => env[key] !== "1") || env.E2E_LEGACY_SCHEMA_TARGET !== target || !local.includes(url.hostname) ||
    env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || env.REDIS_URL !== redis || env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
    !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("NativeV2 acceptance requires every isolated flag and exact current nonce database private bucket and Redis before connection");
  return { url: url.href, nonce, redis };
}

/** The browser loads decorated owners only in its strict nonce tsx child. */
async function nativeV2BrowserChild() {
  const env = requireAgentNativeV2Environment(), database = connectDatabase(env.url);
  const f = agentNativeV2Fixture(database, { contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
    modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config") });
  let context: TenantContext | undefined, actor: AgentActor | undefined, source: Awaited<ReturnType<typeof f.seed>> | undefined;
  let active: Promise<unknown> | undefined, settled = true, entered = false, release: (() => void) | undefined, failure: string | null = null;
  let serial = Promise.resolve(), closed = false, phase = "ready";
  const stats = () => ({ modelCalls: f.modelCalls.length, definitions: f.definitionCalls.length, reads: f.readCalls.length, settled, entered, failure });
  const close = async () => { if (closed) return; closed = true; release?.(); const errors: unknown[] = [];
    try { await active; } catch (error) { errors.push(error); }
    try { if (context) await f.settlePrepared(context); } catch (error) { errors.push(error); }
    try { await f.close(); } catch (error) { errors.push(error); }
    try { await database.client.end(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "NativeV2 child cleanup failed"); };
  process.on("disconnect", () => { release?.(); void serial.then(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => { serial = serial.then(async () => {
    if (!raw || typeof raw !== "object") return; const message = raw as Record<string, unknown>;
    if (message.nonce !== env.nonce || typeof message.id !== "number") return;
    try { let value: unknown;
      if (message.operation === "seed") {
        phase = "actual_personal_membership"; const caller = TenantContextSchema.parse(message.context);
        context = await withTenant(database.db, caller, async tx => TenantContextSchema.parse(intersectPermissionContexts(caller, await loadCurrentMembershipContext(tx, caller, { lock: true }))));
        const [member] = await withTenant(database.db, context, tx => tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, context!.userId), eq(memberships.status, "active"))));
        if (!member) throw new Error("NativeV2 actual personal membership missing"); actor = { ...context, context, subject: "unused-personal-source-actor", membershipId: member.id, roleIds: new Map() };
        phase = "actual_eleven_owner_sources"; await f.legacy.facts.initialize(); await f.resources.facts.initialize(); source = await f.seed(actor);
        value = { bindings: source.bindings, query: source.query, originals: source.originals, contextText: source.old.contextText,
          inputs: source.fresh.inputs, inspectionId: source.old.compiled.id, factoryId: source.old.site.factory.id, from: source.old.pool.localDate };
      } else if (message.operation === "execute") {
        if (!source || !actor || !context || active && !settled) throw new Error("NativeV2 child sources or execution unavailable");
        const id = z.uuidv7().parse(message.runId), job = await f.queue.getJob(id); if (!job) throw new Error("Actual nativeV2 Redis job missing");
        const envelope = JobEnvelopeSchema.parse(job.data); if (envelope.tenantId !== context.tenantId || envelope.requestedBy !== context.userId) throw new Error("Actual nativeV2 Redis identity mismatch");
        let gate: Promise<void> | undefined; if (message.hold === true) gate = new Promise(accept => { release = accept; });
        f.controls.beforeModel = async packet => { if (gate && packet.turn === 1) { entered = true; await gate; } };
        f.controls.decision = packet => nativeV2Sequence(packet, source!.originals.filter(original => packet.allowedCommands.some(command => command.domain === original.domain && command.kind === original.command.kind)), source!.query);
        phase = "actual_v2_worker_router"; settled = false; failure = null; active = f.process(id, actor).then(result => { settled = true; return result; }, error => { settled = true; failure = "native_v2_runtime_rejected"; throw error; });
        void active.catch(() => {}); value = { started: true, originalQueueJobId: job.id };
      } else if (message.operation === "progress") value = stats();
      else if (message.operation === "wait") { await active; value = stats(); }
      else if (message.operation === "release") { release?.(); value = { released: true }; }
      else if (message.operation === "business") { if (!context) throw new Error("NativeV2 actual personal context missing"); value = await f.business(context); }
      else if (message.operation === "close") { await close(); value = { closed: true }; }
      else throw new Error("NativeV2 child operation invalid");
      process.send?.({ type: "result", nonce: env.nonce, id: message.id, value });
    } catch (error) { let code: string | null = null, cause: unknown = error;
      for (let depth = 0; depth < 7 && cause && typeof cause === "object"; depth++) { if ("code" in cause && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code)) code ??= cause.code; cause = "cause" in cause ? cause.cause : null; }
      process.send?.({ type: "failure", nonce: env.nonce, id: message.id, phase, code }); }
  }); });
  process.send?.({ type: "ready", nonce: env.nonce });
}
if (process.argv.includes("--agent-native-v2-browser-child")) void nativeV2BrowserChild().catch(() => { process.exitCode = 1; });

/** The synthetic model copies actual owner DTO fields. It does not prove the
 * commercial correctness or causal meaning of an unconfirmed business draft. */
export function nativeV2Claims(packet: AgentNativeV2TurnInput): AgentNativeV2Claim[] {
  const claims: AgentNativeV2Claim[] = [];
  for (const observation of packet.observations) for (const [resultIndex, result] of observation.results.entries()) {
    const add = (path: AgentNativeV2Claim["path"], value: AgentNativeV2Claim["value"]) => claims.push({ stepId: observation.stepId, resultIndex, dataChecksum: result.dataChecksum, path, value });
    switch (result.tool) {
      case "orders.exceptions.page": if (result.data.items[0]) add(["items", 0, "category"], result.data.items[0].category); break;
      case "inventory.balances.page": if (result.data.items[0]) { add(["items", 0, "physicalQuantity"], result.data.items[0].physicalQuantity); add(["items", 0, "unit"], result.data.items[0].unit); }
        if (observation.collectionComplete && resultIndex === 0) add(["total"], result.data.total); break;
      case "knowledge.search": if (result.data.references[0]) add(["references", 0, "checksum"], result.data.references[0].checksum); break;
      case "creative.history": if (result.data.entries[0]) add(["entries", 0, "phase"], result.data.entries[0].phase); break;
      case "factory.capacity": add(["factoryId"], result.data.factoryId); if (result.data.calendar[0]) add(["calendar", 0, "capacityUnits"], result.data.calendar[0].capacityUnits); break;
      case "research.evidence": add(["snapshot", "price", "amount"], result.data.snapshot.price?.amount ?? null); add(["snapshot", "price", "currency"], result.data.snapshot.price?.currency ?? null); break;
      case "catalog.sku": if (result.data.recipe) { add(["recipe", "status"], result.data.recipe.status); add(["recipe", "specification", "facts", "packageQuantity"], result.data.recipe.specification.facts.packageQuantity); } break;
      case "listing.version": add(["version", "content", "title"], result.data.version.content.title); break;
      case "orders.order": add(["lines", 0, "quantity"], result.data.lines[0]?.quantity ?? null); add(["externalOrderId"], result.data.externalOrderId); break;
      case "finance.profit_run": add(["profitMinor"], result.data.profitMinor); add(["reportingCurrency"], result.data.reportingCurrency); break;
      case "advertising.analysis": add(["accountId"], result.data.accountId); break;
    }
  }
  return claims;
}
export function finishNativeV2(packet: AgentNativeV2TurnInput, originals: readonly AgentCommandOriginal[] = []): AgentNativeV2Decision {
  const claims = nativeV2Claims(packet);
  return AgentNativeV2DecisionSchema.parse({ action: "finish", label: "Seal source scalar evidence and unconfirmed proposals", definition: null, read: null,
    result: { summary: "Synthetic HTTP model copied original source scalars; draft parameters and commercial causality still need original-owner review", claims,
      missingInformation: packet.observations.some(row => row.collectionComplete === false) ? ["Only a bounded original collection prefix was read"] : [],
      proposals: originals.map((original, position) => {
        const slot = packet.slots[position]; if (!slot) throw new Error("Actual server proposal slot missing");
        const fixed = AgentCommandOriginalSchema.parse({ ...original, command: { ...original.command, input: { ...original.command.input, idempotencyKey: slot.idempotencyKey } } });
        return { position, capability: { domain: fixed.domain, kind: fixed.command.kind }, label: "Review synthetic original " + fixed.domain,
          reason: "Operator parameters are not established by source scalar matching", draftJson: JSON.stringify(fixed), claimIndexes: claims.map((_, index) => index).slice(0, 20), missingInformation: [] };
      }) } });
}
export function nativeV2Sequence(packet: AgentNativeV2TurnInput, originals: readonly AgentCommandOriginal[] = [], keyword = "Synthetic native evidence"): AgentNativeV2Decision {
  for (const [bindingIndex, binding] of packet.bindings.entries()) {
    if (!packet.definitions.some(row => { const selected = agentNativeV2DefinitionSelection(row.definition); return selected.kind === "read" && selected.tool === binding.tool; }))
      return AgentNativeV2DecisionSchema.parse({ action: "definition", label: "Load this original source definition only", definition: { kind: "read", tool: binding.tool }, read: null, result: null });
    if (!packet.observations.some(row => row.request.bindingIndex === bindingIndex)) return AgentNativeV2DecisionSchema.parse({ action: "read", label: "Read the fixed original source",
      definition: null, read: { bindingIndex, keyword: binding.tool === "knowledge.search" ? keyword : null }, result: null });
  }
  for (const original of originals) if (!packet.definitions.some(row => { const selected = agentNativeV2DefinitionSelection(row.definition); return selected.kind === "command" && agentPlanCommandKey(selected.command) === original.domain + "/" + original.command.kind; }))
    return AgentNativeV2DecisionSchema.parse({ action: "definition", label: "Load one separately reviewable native command schema", definition: { kind: "command", command: { domain: original.domain, kind: original.command.kind } }, read: null, result: null });
  return finishNativeV2(packet, originals);
}

/** Real owners, Redis envelopes, Worker router and provider decode/checkpoints.
 * Only the external model HTTP response is synthetic. */
export function agentNativeV2Fixture(database: DatabaseConnection, options: { contentVault?: SecretVault; modelVault?: SecretVault } = {}) {
  const env = requireAgentNativeV2Environment(), legacy = agentNativeFixture(database, options), resources = agentResourcesFixture(database), base = legacy.base;
  const realDispatcher = new RedisAgentPlanDispatcher(), queue = createQueue(QueueName.AgentPlan, env.redis);
  const ownedRuns = new Set<string>();
  const dispatches: Array<Parameters<AgentPlanDispatcher["enqueue"]>[0]> = [], modelCalls: AgentNativeV2TurnInput[] = [], wire: Array<{ bodyBytes: number; schemaBytes: number }> = [];
  const definitionCalls: Array<{ kind: "legacy" | "resource"; input: unknown }> = [], readCalls: Array<{ kind: "legacy" | "resource"; context: TenantContext; input: unknown; result?: unknown }> = [];
  const controls: { failQueue: boolean; unknownUsage: boolean; decision: (packet: AgentNativeV2TurnInput) => unknown;
    beforeModel?: (packet: AgentNativeV2TurnInput) => Promise<void>; afterCheckpoint?: (packet: AgentNativeV2TurnInput, value: ModelResponseCheckpoint) => Promise<void>;
    afterRead?: (context: TenantContext, input: unknown, result: unknown) => Promise<void> } = { failQueue: false, unknownUsage: false, decision: packet => nativeV2Sequence(packet) };
  const dispatcher: AgentPlanDispatcher = { enqueue: async input => { ownedRuns.add(input.id); dispatches.push(input); if (controls.failQueue) throw new Error("Synthetic nativeV2 dispatch unavailable"); await realDispatcher.enqueue(input); } };
  const tools = { workspace: legacy.gateway.workspace.bind(legacy.gateway), definition: async (...args: Parameters<typeof legacy.gateway.definition>) => {
    definitionCalls.push({ kind: "legacy", input: args[1] }); return legacy.gateway.definition(...args);
  }, call: async (context: TenantContext, raw: unknown) => { const input = AgentToolCallSchema.parse(raw), row = { kind: "legacy" as const, context, input, result: undefined as unknown };
    readCalls.push(row); const result = await legacy.gateway.call(context, input); row.result = result; await controls.afterRead?.(context, input, result); return result; } };
  const resourcePort = { workspace: resources.service.workspace.bind(resources.service), assertBindingAccess: resources.service.assertBindingAccess.bind(resources.service), definition: async (...args: Parameters<typeof resources.service.definition>) => {
    definitionCalls.push({ kind: "resource", input: args[1] }); return resources.service.definition(...args);
  }, call: async (context: TenantContext, raw: unknown) => { const input = AgentResourceCallSchema.parse(raw), row = { kind: "resource" as const, context, input, result: undefined as unknown };
    readCalls.push(row); const result = await resources.service.call(context, input); row.result = result; await controls.afterRead?.(context, input, result); return result; } };
  const service = (retentionSeconds?: number) => new AgentNativeV2Service(database, options.contentVault ?? base.vault, legacy.gateway, resources.service,
    legacy.owners.service(), legacy.owners.adapter, dispatcher, retentionSeconds);
  const runtime = () => new AgentNativeV2Runtime({ database, contentVault: options.contentVault ?? base.vault, modelVault: options.modelVault ?? base.modelVault,
    tools, resources: resourcePort, providerFactory: (provider, apiKey, model) => new class extends OpenAiCompatibleProvider {
      override generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal) {
        const packet = AgentNativeV2TurnInputSchema.parse(request.untrustedSourceData);
        return super.generate({ ...request, onResponseCheckpoint: async value => { await request.onResponseCheckpoint?.(value); await controls.afterCheckpoint?.(packet, value); } }, signal);
      }
    }({ providerId: provider.id, apiKey, endpoint: "https://synthetic-native-v2.invalid/v1", pricing: model.inputUsdPerMillion === null || model.outputUsdPerMillion === null ? null : {
      inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion }, fetch: async (_url, init) => {
        const text = String(init?.body), body = JSON.parse(text) as { messages?: Array<{ role?: string; content?: unknown }>; response_format?: unknown };
        const user = body.messages?.find(row => row.role === "user")?.content, framed = typeof user === "string" ? /<untrusted_source_data>\n([\s\S]*)\n<\/untrusted_source_data>/.exec(user)?.[1] : undefined;
        const packet = AgentNativeV2TurnInputSchema.parse(JSON.parse(framed ?? "null")); modelCalls.push(packet);
        wire.push({ bodyBytes: Buffer.byteLength(text), schemaBytes: Buffer.byteLength(JSON.stringify(body.response_format ?? null)) }); await controls.beforeModel?.(packet);
        return Response.json({ id: "synthetic-native-v2-" + createEntityId(), choices: [{ message: { content: JSON.stringify(controls.decision(packet)) } }],
          ...(controls.unknownUsage ? {} : { usage: { prompt_tokens: 50, completion_tokens: 80 } }) });
      } }),
  });
  async function request(actor = base.a, changes: Partial<CreateAgentNativeV2> = {}) {
    const workspace = await service().workspace(await base.current(actor));
    return CreateAgentNativeV2Schema.parse({ version: AGENT_NATIVE_V2_VERSION, requestId: randomUUID(), goal: "Read fixed original sources and propose separately reviewable commands",
      contextText: "Operator notes remain unverified", modelId: base.modelId, bindings: [{ tool: "inventory.balances.page", scope: {} }], allowedCommands: [],
      limits: defaultAgentNativeV2Limits(), maxCostUsd: 1, executionContract: workspace.executionContract, ...changes });
  }
  async function seed(actor = base.a) {
    const context = await base.current(actor), old = await legacy.source(actor), fresh = await resources.seed(context);
    const bindings = [...old.bindings, ...Object.entries(fresh.inputs).map(([tool, scope]) => AgentNativeV2BindingSchema.parse({ tool, scope }))];
    return { old, fresh, bindings, originals: old.originals, query: old.query };
  }
  async function processRun(id: string, actor = base.a) {
    ownedRuns.add(id);
    let job = await queue.getJob(id);
    if (!job) { const [row] = await withTenant(database.db, await base.current(actor), tx => tx.select().from(agentPlanRuns).where(and(eq(agentPlanRuns.id, id), eq(agentPlanRuns.ownerId, actor.userId))));
      if (!row) throw new Error("Actual nativeV2 dispatch parent missing"); await realDispatcher.enqueue({ id, tenantId: row.tenantId, userId: row.ownerId, expiresAt: row.expiresAt }); job = await queue.getJob(id); }
    if (!job) throw new Error("Actual nativeV2 Redis execute envelope missing");
    return new AgentPlanProcessor(agentPlanRuntimeRouter(database, legacy.prior.runtime(), legacy.runtime(), runtime())).process(JobEnvelopeSchema.parse(job.data));
  }
  const clear = () => { controls.failQueue = false; controls.unknownUsage = false; controls.beforeModel = undefined; controls.afterRead = undefined; controls.afterCheckpoint = undefined;
    controls.decision = packet => nativeV2Sequence(packet); };
  let app: INestApplication | undefined, signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined, origin: string | undefined, closed = false;
  async function token(actor = base.a) { signing ??= await generateKeyPair("RS256"); return new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(actor.subject)
    .setIssuer("https://synthetic-native-v2-oidc.invalid").setAudience("synthetic-native-v2-api").setIssuedAt().setExpirationTime("5m").sign(signing.privateKey); }
  async function startHttp() {
    if (origin) return origin; signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [IdentitySessionController, AgentNativeV2Controller], providers: [{ provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentNativeV2Service, useValue: service() }] })
    class PersonalNativeV2Module {}
    const reflector = new Reflector(); app = await NestFactory.create(PersonalNativeV2Module, { logger: false });
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-native-v2-oidc.invalid", audience: "synthetic-native-v2-api", verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), base.loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(base.loader)); await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function settlePrepared(context = base.a.context) {
    if (!ownedRuns.size) return;
    const records = await withTenant(database.db, context, tx => tx.select({ command: agentCommandRequests }).from(agentPlanItems)
      .innerJoin(agentCommandRequests, eq(agentCommandRequests.id, agentPlanItems.agentCommandId))
      .where(and(inArray(agentPlanItems.runId, [...ownedRuns]), eq(agentCommandRequests.ownerId, context.userId))));
    for (const { command: row } of records) { if (!row.ownerCommandId) continue;
      const ref = { domain: row.binding.domain, commandId: row.ownerCommandId, accountId: row.binding.accountId }; let current = await legacy.owners.adapter.read(context, ref);
      if (current.native.view.canCancel) current = await legacy.owners.adapter.cancel(context, ref);
      if (["succeeded", "cancelled", "rejected", "expired"].includes(current.native.view.status) && !current.native.view.acknowledged) await legacy.owners.adapter.acknowledge(context, ref);
    }
  }
  async function close() { if (closed) return; closed = true; const errors: unknown[] = [];
    for (const done of [() => app?.close(), () => realDispatcher.onModuleDestroy(), () => queue.close(), () => resources.close(), () => legacy.close()]) try { await done(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "NativeV2 exact fixture teardown failed"); }
  async function initialize() { try { await legacy.initialize(); await resources.facts.initialize(); } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "NativeV2 fixture initialization and cleanup failed"); } throw error; } }
  return { database, env, base, legacy, resources, tools, resourcePort, service, runtime, dispatcher, queue, modelCalls, wire, dispatches, definitionCalls, readCalls, controls,
    request, seed, process: processRun, clear, initialize, close, token, startHttp, settlePrepared, rows: legacy.rows, business: legacy.business,
    confirmation: legacy.confirmation, proof: (input: CreateAgentNativeV2) => ({ requestId: input.requestId, requestChecksum: nativeV2Hash(canonicalAgentNativeV2Request(input)) }),
    prepareInput: (view: Pick<AgentNativeV2View, "requestId">, item: { proposalChecksum: string }) => PrepareAgentNativeV2ItemSchema.parse({ version: AGENT_NATIVE_V2_VERSION, requestId: view.requestId, proposalChecksum: item.proposalChecksum }) };
}
