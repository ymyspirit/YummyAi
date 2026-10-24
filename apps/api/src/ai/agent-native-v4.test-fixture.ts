import "reflect-metadata";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server, type ServerResponse } from "node:http";
import { Module, type CallHandler, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { tap } from "rxjs";
import { z } from "zod";
import { OpenAiProvider, SecretVault, type ModelResponseCheckpoint, type ResolvedModelRequest } from "@yummyai/ai-core";
import { canonicalJson } from "@yummyai/contracts/common/canonical-json";
import { AGENT_FULFILLMENT_COMMAND_VERSION, PrepareAgentFulfillmentCommandSchema, ConfirmAgentFulfillmentCommandSchema,
  CancelAgentFulfillmentCommandSchema, AcknowledgeAgentFulfillmentCommandSchema, type AgentFulfillmentCommandView } from "@yummyai/contracts/ai/agent-fulfillment-command";
import { AGENT_FULFILLMENT_PROPOSAL_VERSION, parseAgentFulfillmentSuggestion } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { AGENT_FULFILLMENT_TOOL } from "@yummyai/contracts/ai/agent-fulfillment";
import { AGENT_NATIVE_V4_VERSION, AgentNativeV4DecisionSchema, AgentNativeV4TurnInputSchema, CreateAgentNativeV4Schema,
  PrepareAgentNativeV4ItemSchema, AgentNativeV4ItemReceiptQuerySchema, canonicalAgentNativeV4Request,
  defaultAgentNativeV4Limits, agentNativeV4DefinitionSelection, type AgentNativeV4TurnInput, type AgentNativeV4View,
  type CreateAgentNativeV4 } from "@yummyai/contracts/ai/agent-native-v4";
import type { FulfillmentCommandKind } from "@yummyai/contracts/order/fulfillment-command";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { agentCommandV2Capabilities, SharedAgentCommandV2Gateway } from "@yummyai/workflow-core";
import { AgentNativeV4Runtime } from "../../../../packages/workflow-core/src/agent-native-v4-runtime.js";
import { requireAgentNativeV4Environment } from "../../../../tools/testing/require-agent-native-v4-environment.mjs";
import { AgentPlanProcessor } from "../../../worker/src/processors/agent-plan.processor.js";
import { agentPlanRuntimeRouter } from "../../../worker/src/agent-plan-runtime-router.js";
import { orderFulfillmentCommandFixture, fulfillmentCommandBounded } from "../orders/order-fulfillment-command.test-fixture.js";
import { agentNativeV3Fixture, nativeV3Scopes } from "./agent-native-v3.test-fixture.js";
import { type AgentActor, bounded, deferred } from "./agent-read.test-fixture.js";
import { AgentFulfillmentCommandOwner } from "./agent-fulfillment-command-owner.js";
import { AgentFulfillmentCommandService } from "./agent-fulfillment-command.service.js";
import { AgentFulfillmentCommandController } from "./agent-fulfillment-command.controller.js";
import { AgentNativeV4Service } from "./agent-native-v4.service.js";
import { AgentNativeV4Controller } from "./agent-native-v4.controller.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

export const nativeV4Hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const version = AGENT_NATIVE_V4_VERSION, originalVersion = AGENT_FULFILLMENT_COMMAND_VERSION;
type Scenario = Awaited<ReturnType<ReturnType<typeof orderFulfillmentCommandFixture>["command"]>>;
const inputText = z.object({ input: z.array(z.object({ role: z.literal("user"), content: z.string() }).strict()).length(1),
  store: z.literal(false), stream: z.literal(false), model: z.string().min(1), text: z.object({ format: z.object({ type: z.literal("json_schema"),
    name: z.string().min(1), schema: z.record(z.string(), z.unknown()), strict: z.literal(true) }).strict() }).strict(),
  instructions: z.string(), max_output_tokens: z.number().int().positive() }).strict();

/** All business inputs and physical attestations are explicitly synthetic. The
 * original fixture creates every source through its actual owners. Only the
 * loopback Responses server is synthetic; OpenAiProvider, encrypted checkpoints,
 * budgets, RLS, Redis envelope, processor and all original receipts are real.
 * No nativeV3.seed(), queue consumer, external model or paid endpoint is used. */
export type AgentNativeV4FixtureOptions = {
  contentVault?: SecretVault; modelVault?: SecretVault; orderVault?: SecretVault; integrationVault?: SecretVault;
  actor?: AgentActor;
};
export function agentNativeV4Fixture(database: DatabaseConnection, options: AgentNativeV4FixtureOptions = {}) {
  const environment = requireAgentNativeV4Environment(), original = orderFulfillmentCommandFixture(database, options);
  const prior = agentNativeV3Fixture(database, { orderVault: original.base.vault,
    ...(options.contentVault ? { contentVault: options.contentVault } : {}),
    ...(options.modelVault ? { modelVault: options.modelVault } : {}),
    ...(options.integrationVault ? { integrationVault: options.integrationVault } : {}) }), base = prior.base;
  const contentVault = options.contentVault ?? base.vault, confirmationVault = new SecretVault(randomBytes(32));
  const prepared = new Map<string, string>(), ownedRuns = new Set<string>(), running = new Set<Promise<unknown>>(), releases = new Set<() => void>();
  const calls = { prepare: 0, confirm: 0, receipt: 0, lostResponses: 0 };
  const modelCalls: AgentNativeV4TurnInput[] = [], httpCalls: Array<{ method: string; path: string; queryKeys: string[]; bodyChecksum: string | null }> = [];
  const wire: Array<{ method: "POST"; path: "/v1/responses"; bytes: number; runId: string; turn: number; schemaChecksum: string }> = [];
  const hooks: { beforePrepare?: () => Promise<void>; afterPrepare?: () => Promise<void>; afterRead?: () => Promise<void>;
    afterCheckpoint?: (packet: AgentNativeV4TurnInput, checkpoint: ModelResponseCheckpoint) => Promise<void> } = {};
  const controls: { scenario: Scenario | null; fault: "none" | "submitted_unknown" | "missing_usage";
    decision?: (packet: AgentNativeV4TurnInput) => unknown } = { scenario: null, fault: "none" };
  class ObservedFulfillment extends AgentFulfillmentCommandService {
    override async prepare(...args: Parameters<AgentFulfillmentCommandService["prepare"]>) {
      calls.prepare++; await hooks.beforePrepare?.(); const view = await super.prepare(...args);
      prepared.set(view.native.id, view.native.orderId); await hooks.afterPrepare?.(); return view;
    }
    override async get(...args: Parameters<AgentFulfillmentCommandService["get"]>) {
      const view = await super.get(...args); await hooks.afterRead?.(); return view;
    }
    override async receipt(...args: Parameters<AgentFulfillmentCommandService["receipt"]>) { calls.receipt++; return super.receipt(...args); }
    override async confirm(...args: Parameters<AgentFulfillmentCommandService["confirm"]>) { calls.confirm++; return super.confirm(...args); }
  }
  const fulfillmentCommands = new ObservedFulfillment(database, confirmationVault, new AgentFulfillmentCommandOwner(original.service()), original.owners.audit);
  const definitions = new SharedAgentCommandV2Gateway(database, prior.prior.legacy.gateway, { capabilities: agentCommandV2Capabilities });
  class OwnedNativeV4Service extends AgentNativeV4Service {
    override async start(...args: Parameters<AgentNativeV4Service["start"]>) {
      const view = await super.start(...args); ownedRuns.add(view.id); return view;
    }
  }
  const service = (retentionSeconds?: number) => new OwnedNativeV4Service(database, contentVault, prior.prior.legacy.gateway, prior.prior.resources.service,
    prior.prior.legacy.owners.service(), prior.prior.legacy.owners.adapter, prior.dispatcher, prior.fulfillmentService, fulfillmentCommands, retentionSeconds);
  let providerServer: Server | undefined, providerOrigin: string | undefined, app: INestApplication | undefined, apiOrigin: string | undefined;
  let signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined, dropPrepare = false, dropStart = false, closed = false;
  const tokens = new Map<string, string>(), providerFailures: string[] = [];

  function decision(packet: AgentNativeV4TurnInput) {
    if (controls.decision) return controls.decision(packet);
    const scenario = controls.scenario;
    if (!scenario) return AgentNativeV4DecisionSchema.parse({ action: "finish", label: "Read-only original empty proposal", definition: null, read: null,
      result: { summary: "Synthetic Responses transport with no original business action", claims: [], proposals: [], missingInformation: [] } });
    const read = packet.bindings[0]; if (!read) throw new Error("native4_fixed_binding_missing");
    if (!packet.definitions.some(row => { const selected = agentNativeV4DefinitionSelection(row.definition); return selected.kind === "read" && selected.tool === read.tool; }))
      return { action: "definition", label: "Discover original fixed source", definition: { kind: "read", tool: read.tool }, read: null, result: null };
    if (!packet.observations.some(row => row.request.bindingIndex === 0)) return { action: "read", label: "Read this fixed original source", definition: null, read: { bindingIndex: 0, keyword: null }, result: null };
    const kind = scenario.command.kind;
    if (!packet.definitions.some(row => { const selected = agentNativeV4DefinitionSelection(row.definition); return selected.kind === "command" && selected.command.domain === "fulfillment" && selected.command.kind === kind; }))
      return { action: "definition", label: "Discover independent original preparation definition", definition: { kind: "command", command: { domain: "fulfillment", kind } }, read: null, result: null };
    const observation = packet.observations.find(row => row.request.bindingIndex === 0), source = observation?.results[0];
    if (!observation || !source || source.version !== "erp-agent-fulfillment-v1") throw new Error("native4_actual_fulfillment_source_missing");
    const suggestion = parseAgentFulfillmentSuggestion({ version: AGENT_FULFILLMENT_PROPOSAL_VERSION, domain: "fulfillment",
      source: { stepId: observation.stepId, resultIndex: 0, dataChecksum: source.dataChecksum, orderId: source.data.order.id, expectedSequence: source.data.order.sequence },
      original: { kind, targetId: scenario.command.targetId, input: {},
        ...(scenario.command.kind === "delivery_feedback" ? { packageId: scenario.command.packageId } : {}),
        ...(scenario.command.kind === "shipment_review" ? { versionId: scenario.command.versionId } : {}) } });
    return AgentNativeV4DecisionSchema.parse({ action: "finish", label: "Suggest only the exact original target without person fields", definition: null, read: null,
      result: { summary: "Synthetic model suggests an original kind and target only; every original form field and confirmation remains separate",
        claims: [{ stepId: observation.stepId, resultIndex: 0, dataChecksum: source.dataChecksum, path: ["order", "sequence"], value: source.data.order.sequence }],
        missingInformation: [], proposals: [{ position: 0, capability: { domain: "fulfillment", kind }, label: "Synthetic original suggestion",
          reason: "Read evidence does not constitute a physical operator confirmation", draftJson: JSON.stringify(suggestion), claimIndexes: [0],
          missingInformation: ["Complete and review the actual original form before separate confirmation"] }] } });
  }
  async function startProvider() {
    if (providerOrigin) return providerOrigin;
    providerServer = createServer((request, response) => { void (async () => {
      if (request.method !== "POST" || request.url !== "/v1/responses" || request.headers.authorization !== "Bearer synthetic-no-provider-credential") {
        providerFailures.push("unexpected_provider_route_or_credential"); response.writeHead(400).end(); return;
      }
      const parts: Buffer[] = []; let bytes = 0;
      for await (const part of request) { const value = Buffer.isBuffer(part) ? part : Buffer.from(part); bytes += value.length;
        if (bytes > 1_500_000) throw new Error("native4_synthetic_wire_too_large"); parts.push(value); }
      const body = inputText.parse(JSON.parse(Buffer.concat(parts).toString("utf8"))), text = body.input[0]!.content;
      const framed = /<untrusted_source_data>\n([\s\S]*)\n<\/untrusted_source_data>/.exec(text)?.[1];
      const packet = AgentNativeV4TurnInputSchema.parse(JSON.parse(framed ?? "null")); modelCalls.push(packet);
      wire.push({ method: "POST", path: "/v1/responses", bytes, runId: packet.runId, turn: packet.turn, schemaChecksum: nativeV4Hash(body.text.format.schema) });
      if (controls.fault === "submitted_unknown") { response.destroy(); return; }
      const result = decision(packet), requestId = `synthetic-responses-${randomUUID()}`;
      response.writeHead(200, { "content-type": "application/json", "x-request-id": requestId });
      response.end(JSON.stringify({ id: requestId, status: "completed", output: [{ type: "message", role: "assistant",
        content: [{ type: "output_text", text: JSON.stringify(result) }] }],
        ...(controls.fault === "missing_usage" ? {} : { usage: { input_tokens: 50, output_tokens: 80 } }) }));
    })().catch(() => { providerFailures.push("synthetic_responses_request_invalid"); response.destroy(); }); });
    await new Promise<void>((done, reject) => { providerServer!.once("error", reject); providerServer!.listen(0, "127.0.0.1", done); });
    const address = providerServer.address(); if (!address || typeof address === "string") throw new Error("native4_loopback_provider_address_invalid");
    providerOrigin = `http://127.0.0.1:${address.port}`; return providerOrigin;
  }
  function runtime() {
    if (!providerOrigin) throw new Error("native4_loopback_provider_not_initialized");
    return new AgentNativeV4Runtime({ database, contentVault, modelVault: options.modelVault ?? base.modelVault, tools: prior.tools, resources: prior.resources,
      fulfillment: prior.fulfillmentPort, commandDefinitions: definitions,
      providerFactory: (_provider, apiKey, model) => new class extends OpenAiProvider {
        override generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal) {
          const packet = AgentNativeV4TurnInputSchema.parse(request.untrustedSourceData);
          return super.generate({ ...request, onResponseCheckpoint: async checkpoint => { await request.onResponseCheckpoint?.(checkpoint); await hooks.afterCheckpoint?.(packet, checkpoint); } }, signal);
        }
      }({ apiKey, endpoint: providerOrigin, pricing: model.inputUsdPerMillion === null || model.outputUsdPerMillion === null ? null : {
        inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion } }) });
  }
  const current = (actor = options.actor ?? base.a) => base.current(actor);
  async function initialize() {
    requireAgentNativeV4Environment(); await prior.initialize(); await base.scopes(base.a, nativeV3Scopes());
    await original.initialize(); await startProvider();
  }
  async function scenario(kind: FulfillmentCommandKind) { return original.command(kind, await current()); }
  async function request(value: Scenario | null = null, changes: Partial<CreateAgentNativeV4> = {}) {
    controls.scenario = value;
    const context = await current(), workspace = await service().workspace(context);
    const order = value ? await original.owners.orders.get(context, value.scene.order.id) : null;
    const kind = value && ["shipment_version", "shipment_review", "shipment_dispatch", "shipment_platform_confirmation"].includes(value.command.kind) ? "shipments" : "production";
    return CreateAgentNativeV4Schema.parse({ version, requestId: randomUUID(), goal: "Synthetic original fulfillment proposal with individual human completion",
      contextText: "Fixture operator notes and physical observations are synthetic", modelId: base.modelId,
      bindings: order ? [{ tool: AGENT_FULFILLMENT_TOOL, scope: { orderId: order.id, expectedSequence: order.latestEventSequence, kind } }]
        : [{ tool: "inventory.balances.page", scope: {} }],
      allowedCommands: value ? [{ domain: "fulfillment", kind: value.command.kind }] : [], limits: defaultAgentNativeV4Limits(), maxCostUsd: 1,
      executionContract: workspace.executionContract, ...changes });
  }
  async function processRun(id: string) {
    ownedRuns.add(id); const job = await prior.prior.queue.getJob(id);
    if (!job) throw new Error("native4_actual_redis_envelope_missing");
    const envelope = JobEnvelopeSchema.parse(job.data), actor = await current();
    if (envelope.tenantId !== actor.tenantId || envelope.requestedBy !== actor.userId) throw new Error("native4_actual_redis_actor_mismatch");
    const route = agentPlanRuntimeRouter(database, prior.prior.legacy.prior.runtime(), prior.prior.legacy.runtime(), prior.prior.runtime(), prior.runtime(), runtime());
    const task = new AgentPlanProcessor(route).process(envelope); running.add(task); void task.then(() => running.delete(task), () => running.delete(task)); return task;
  }
  function complete(value: Scenario, itemId: string) {
    return PrepareAgentFulfillmentCommandSchema.parse({ version: originalVersion, orderId: value.scene.order.id,
      original: { ...value.command, requestId: itemId, input: { ...value.command.input,
        ...(value.command.kind === "production_milestone" ? { externalEventId: itemId } : { idempotencyKey: itemId }) } } });
  }
  const itemQuery = (view: AgentNativeV4View, item: AgentNativeV4View["items"][number]) => AgentNativeV4ItemReceiptQuerySchema.parse({ version, requestId: view.requestId, proposalChecksum: item.proposalChecksum });
  const prepareInput = (view: AgentNativeV4View, item: AgentNativeV4View["items"][number], value: Scenario) =>
    PrepareAgentNativeV4ItemSchema.parse({ ...itemQuery(view, item), completion: complete(value, item.id) });
  function originalLookup(view: AgentFulfillmentCommandView) { return { version: originalVersion, orderId: view.native.orderId,
    requestId: view.native.requestId, requestChecksum: view.native.requestChecksum }; }
  const confirmation = (view: AgentFulfillmentCommandView) => ConfirmAgentFulfillmentCommandSchema.parse({ ...originalLookup(view),
    originalChecksum: view.originalChecksum, confirmationToken: view.confirmationToken, decision: view.confirmationDecision });
  function hold(phase: "beforePrepare" | "afterPrepare" | "afterRead" | "afterCheckpoint") {
    const entered = deferred(), released = deferred(); releases.add(released.resolve);
    const once = async () => { hooks[phase] = undefined; entered.resolve(); await released.promise; }; hooks[phase] = once;
    return { entered: entered.promise, release() { released.resolve(); releases.delete(released.resolve); } };
  }
  async function token(actor: AgentActor = base.a) {
    const old = tokens.get(actor.userId); if (old) return old;
    signing ??= await generateKeyPair("RS256");
    const value = await new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(actor.subject)
      .setIssuer("https://synthetic-native-v4.invalid").setAudience("synthetic-native-v4-api").setIssuedAt().setExpirationTime("30m").sign(signing.privateKey);
    tokens.set(actor.userId, value); return value;
  }
  async function startHttp() {
    if (apiOrigin) return apiOrigin; signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [AgentNativeV4Controller, AgentFulfillmentCommandController, IdentitySessionController], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentNativeV4Service, useValue: service() },
      { provide: AgentFulfillmentCommandService, useValue: fulfillmentCommands },
    ] }) class PersonalV4Module {}
    app = await NestFactory.create(PersonalV4Module, { logger: false, abortOnError: false });
    const reflector = new Reflector();
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-native-v4.invalid", audience: "synthetic-native-v4-api", verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), base.loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(base.loader), { intercept(context: ExecutionContext, next: CallHandler) {
      const incoming = context.switchToHttp().getRequest<{ url: string; method: string }>();
      return next.handle().pipe(tap(() => { if (incoming.method === "POST" && (dropStart && incoming.url === "/v1/agent-native-v4/runs" ||
        dropPrepare && /^\/v1\/agent-native-v4\/runs\/[a-f0-9-]{36}\/items\/[a-f0-9-]{36}\/prepare$/.test(incoming.url))) {
        dropPrepare = false; dropStart = false; calls.lostResponses++; context.switchToHttp().getResponse<ServerResponse>().destroy();
      } }));
    } });
    await app.listen(0, "127.0.0.1"); apiOrigin = await app.getUrl(); return apiOrigin;
  }
  async function http(actor: AgentActor, path: string, body?: unknown) {
    const url = new URL(path, "http://fixture.invalid");
    if (url.origin !== "http://fixture.invalid" || !/^\/(?:workspace|receipt|runs(?:\/[a-f0-9-]{36}(?:\/stop|\/items\/[a-f0-9-]{36}\/(?:prepare|receipt))?)?)$/.test(url.pathname)
      || [...url.searchParams.keys()].some(key => !["version", "requestId", "requestChecksum", "proposalChecksum"].includes(key))) throw new Error("native4_fixture_http_path_invalid");
    const method = body === undefined ? "GET" : "POST";
    httpCalls.push({ method, path: url.pathname, queryKeys: [...url.searchParams.keys()].sort(), bodyChecksum: body === undefined ? null : nativeV4Hash(body) });
    return fetch(`${await startHttp()}/v1/agent-native-v4${url.pathname}${url.search}`, { method, redirect: "error",
      headers: { authorization: `Bearer ${await token(actor)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  function clear() { hooks.beforePrepare = undefined; hooks.afterPrepare = undefined; hooks.afterRead = undefined; hooks.afterCheckpoint = undefined;
    controls.fault = "none"; controls.decision = undefined; controls.scenario = null; dropPrepare = false; dropStart = false; prior.clear(); }
  async function waitParentExpired(id: string) {
    await fulfillmentCommandBounded((async () => { for (;;) {
      const [row] = await withTenant(database.db, await current(), tx => tx.execute<{ expired: boolean }>(sql`
        select expires_at<=clock_timestamp() as expired from agent_plan_runs where id=${id}::uuid`));
      if (!row) throw new Error("native4_expiry_original_parent_missing"); if (row.expired) return;
      await new Promise<void>(done => setTimeout(done, 50));
    } })(), "native4_real_parent_expiry_not_observed", 40_000);
  }
  async function settle() {
    clear(); for (const release of releases) release(); releases.clear(); await Promise.allSettled([...running]);
    for (const actor of [base.a, base.second, base.foreign]) { await base.memberActive(actor, true); await base.scopes(actor, nativeV3Scopes()); }
    const context = await current(), failures: unknown[] = [];
    for (const [id, orderId] of prepared) try {
      let view = await fulfillmentCommands.get(context, id, { version: originalVersion, orderId });
      if (view.canCancel) view = await fulfillmentCommands.cancel(context, id, CancelAgentFulfillmentCommandSchema.parse({ ...originalLookup(view), decision: "cancel_original" }));
      if (["succeeded", "cancelled", "rejected", "expired", "acknowledged"].includes(view.native.status)) {
        if (view.native.status !== "acknowledged") await fulfillmentCommands.acknowledge(context, id, AcknowledgeAgentFulfillmentCommandSchema.parse({ ...originalLookup(view), decision: "acknowledge_original" }));
        prepared.delete(id);
      } else throw new Error("native4_original_intent_unresolved");
    } catch (error) { failures.push(error); }
    const rows = await prior.rows(context);
    for (const row of rows.runs.filter(row => ownedRuns.has(row.id) && row.version === version && row.ownerId === context.userId && ["queued", "running", "stopping"].includes(row.status)))
      try { await service().stop(context, row.id, { version, requestId: row.requestId }); await runtime().process(context, row.id); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, "native4_fixture_settle_failed");
  }
  async function close() {
    if (closed) return; closed = true; const failures: unknown[] = [];
    for (const done of [settle, () => app?.close(), () => original.close(), () => prior.close(), async () => {
      if (!providerServer) return; providerServer.closeAllConnections(); await new Promise<void>((done, reject) => providerServer!.close(error => error ? reject(error) : done()));
    }]) try { await done(); } catch (error) { failures.push(error); }
    tokens.clear(); if (failures.length) throw new AggregateError(failures, "native4_fixture_close_failed");
  }
  const business = async () => Object.fromEntries(Object.entries(await original.business(await current()))
    .filter(([table]) => !["ai_budget_ledger", "agent_plan_runs", "agent_command_requests"].includes(table)));
  return { environment, database, prior, base, original, contentVault, fulfillmentCommands, definitions, service, runtime, initialize, current, scenario, request,
    process: processRun, complete, prepareInput, itemQuery, confirmation, originalLookup, modelCalls, wire, calls, hooks, controls, providerFailures, httpCalls,
    http, token, hold, clear, settle, close, business, rows: prior.rows, bounded, waitParentExpired,
    losePrepareResponse() { dropPrepare = true; }, loseStartResponse() { dropStart = true; }, proof: (input: CreateAgentNativeV4) => ({ requestId: input.requestId,
      requestChecksum: createHash("sha256").update(canonicalAgentNativeV4Request(input)).digest("hex") }) };
}
