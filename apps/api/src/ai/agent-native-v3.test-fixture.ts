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
import { AgentFulfillmentCallSchema, AGENT_FULFILLMENT_TOOL } from "@yummyai/contracts/ai/agent-fulfillment";
import { ReviewFactoryErpVoidSchema } from "@yummyai/contracts/order/factory-erp-void-review";
import { AGENT_NATIVE_V3_VERSION, AgentNativeV3BindingSchema, AgentNativeV3DecisionSchema, AgentNativeV3TurnInputSchema,
  CreateAgentNativeV3Schema, PrepareAgentNativeV3ItemSchema, canonicalAgentNativeV3Request, defaultAgentNativeV3Limits,
  agentNativeV3DefinitionSelection, type AgentNativeV3Claim, type AgentNativeV3TurnInput, type AgentNativeV3View, type CreateAgentNativeV3 } from "@yummyai/contracts/ai/agent-native-v3";
import { agentPlanItems, agentCommandRequests, memberships, connectDatabase, loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { JobEnvelopeSchema } from "@yummyai/jobs";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { AgentNativeV3Runtime } from "../../../../packages/workflow-core/src/agent-native-v3-runtime.js";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AgentPlanProcessor } from "../../../worker/src/processors/agent-plan.processor.js";
import { agentPlanRuntimeRouter } from "../../../worker/src/agent-plan-runtime-router.js";
import { agentNativeV2Fixture, nativeV2Flags } from "./agent-native-v2.test-fixture.js";
import { fulfillmentOwnerPorts } from "./agent-fulfillment.test-fixture.js";
import { type AgentActor } from "./agent-read.test-fixture.js";
import { AgentFulfillmentService } from "./agent-fulfillment.service.js";
import { AgentNativeV3Service } from "./agent-native-v3.service.js";
import { AgentNativeV3Controller } from "./agent-native-v3.controller.js";
import type { AgentPlanDispatcher } from "./agent-plan.service.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { createOrderPiiVault } from "../orders/order-pii-vault.js";
import { createIntegrationSecretVault } from "../integrations/integration-secret-vault.js";

export const nativeV3Hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const nativeV3Scopes = () => Object.fromEntries(Object.values(Permission).map(bit => [bit, "tenant" as const]));
export const nativeV3Flags = [...nativeV2Flags, "E2E_AGENT_FULFILLMENT_ISOLATED", "E2E_FACTORY_ERP_IMPORT_ISOLATED", "E2E_AGENT_NATIVE_V3_ISOLATED"] as const;
export function requireAgentNativeV3Environment(env: NodeJS.ProcessEnv = process.env, target: "current" | "pre-0177" = "current") {
  const url = new URL(requireDisposableIntegrationEnvironment(env)), nonce = /^\/order_daily_e2e_([a-f0-9]{32})$/.exec(url.pathname)?.[1];
  const local = ["localhost", "127.0.0.1", "[::1]"], redis = env.E2E_DISPOSABLE_REDIS_URL;
  if (!nonce || nativeV3Flags.some(key => env[key] !== "1") || env.E2E_LEGACY_SCHEMA_TARGET !== target || !local.includes(url.hostname) ||
    env.S3_PRIVATE_BUCKET !== `order-daily-e2e-${nonce}` || !redis || env.REDIS_URL !== redis || env.E2E_DISPOSABLE_REDIS_CONTAINER !== `yummyai-daily-${nonce}` ||
    !["redis:", "rediss:"].includes(new URL(redis).protocol) || !local.includes(new URL(redis).hostname))
    throw new Error("NativeV3 requires all seventeen flags and the exact nonce database private bucket and Redis before connection");
  return { url: url.href, nonce, redis };
}

/** The model transport is synthetic. Every quoted value comes from an actual
 * original owner packet. This does not validate a draft's commercial meaning. */
export function nativeV3Claims(packet: AgentNativeV3TurnInput): AgentNativeV3Claim[] {
  const claims: AgentNativeV3Claim[] = [];
  for (const observation of packet.observations) for (const [resultIndex, result] of observation.results.entries()) {
    const add = (path: AgentNativeV3Claim["path"], value: AgentNativeV3Claim["value"]) => claims.push({ stepId: observation.stepId, resultIndex, dataChecksum: result.dataChecksum, path, value });
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
      case "orders.fulfillment": {
        add(["order", "sequence"], result.data.order.sequence);
        if (result.data.kind === "production") for (const [index, row] of result.data.rows.entries()) {
          add(["rows", index, "quantity"], row.quantity); add(["rows", index, "status"], row.status);
          if (row.delivery.data) { add(["rows", index, "delivery", "data", "manufacturingContentChecksum"], row.delivery.data.manufacturingContentChecksum);
            add(["rows", index, "delivery", "data", "manufacturingPlanChecksum"], row.delivery.data.manufacturingPlanChecksum); }
          if (row.factory.data) { add(["rows", index, "factory", "data", "status"], row.factory.data.status);
            add(["rows", index, "factory", "data", "shippedQuantity"], row.factory.data.shippedQuantity);
            if (row.factory.data.voidSummary) { add(["rows", index, "factory", "data", "voidSummary", "pending"], row.factory.data.voidSummary.pending);
              add(["rows", index, "factory", "data", "voidSummary", "requiresOrderHandling"], row.factory.data.voidSummary.requiresOrderHandling); } }
          for (const [groupIndex, group] of (row.quality.data?.groups ?? []).entries()) { add(["rows", index, "quality", "data", "groups", groupIndex, "quantity"], group.quantity);
            add(["rows", index, "quality", "data", "groups", groupIndex, "result"], group.result); }
        }
        if (result.data.kind === "shipments") for (const [index, row] of result.data.rows.entries())
          add(["rows", index, "physicalHandover", "allDispatched"], row.physicalHandover.allDispatched);
        if (result.data.kind === "logistics") for (const [index, row] of result.data.rows.entries()) {
          add(["rows", index, "quotedCostMinor"], row.quotedCostMinor); add(["rows", index, "actualCostMinor"], row.actualCostMinor);
          add(["rows", index, "quotedCurrency"], row.quotedCurrency); add(["rows", index, "actualCurrency"], row.actualCurrency); add(["rows", index, "minorUnitDigits"], row.minorUnitDigits);
        }
      }
    }
  }
  return claims;
}
export function finishNativeV3(packet: AgentNativeV3TurnInput, originals: readonly AgentCommandOriginal[] = []) {
  const claims = nativeV3Claims(packet);
  return AgentNativeV3DecisionSchema.parse({ action: "finish", label: "Seal original source scalars and separately reviewable drafts", definition: null, read: null,
    result: { summary: "Synthetic model copied original evidence; factory observations are not our physical handover and proposals still require individual original-owner review",
      claims, missingInformation: ["Exhausting a fulfillment index does not establish complete physical fulfillment"],
      proposals: originals.map((original, position) => {
        const slot = packet.slots[position]; if (!slot) throw new Error("Actual V3 proposal slot missing");
        const fixed = AgentCommandOriginalSchema.parse({ ...original, command: { ...original.command, input: { ...original.command.input, idempotencyKey: slot.idempotencyKey } } });
        return { position, capability: { domain: fixed.domain, kind: fixed.command.kind }, label: "Review synthetic original " + fixed.domain,
          reason: "Original scalar matches do not establish the draft's business meaning", draftJson: JSON.stringify(fixed), claimIndexes: claims.map((_, index) => index).slice(0, 20), missingInformation: [] };
      }) } });
}
export function nativeV3Sequence(packet: AgentNativeV3TurnInput, originals: readonly AgentCommandOriginal[] = [], keyword = "Synthetic native evidence") {
  for (const [bindingIndex, binding] of packet.bindings.entries()) {
    if (!packet.definitions.some(row => { const selected = agentNativeV3DefinitionSelection(row.definition); return selected.kind === "read" && selected.tool === binding.tool; }))
      return AgentNativeV3DecisionSchema.parse({ action: "definition", label: "Discover this fixed original source", definition: { kind: "read", tool: binding.tool }, read: null, result: null });
    if (!packet.observations.some(row => row.request.bindingIndex === bindingIndex)) return AgentNativeV3DecisionSchema.parse({ action: "read", label: "Read the fixed original source",
      definition: null, read: { bindingIndex, keyword: binding.tool === "knowledge.search" ? keyword : null }, result: null });
  }
  for (const original of originals) if (!packet.definitions.some(row => { const selected = agentNativeV3DefinitionSelection(row.definition); return selected.kind === "command" &&
    agentPlanCommandKey(selected.command) === original.domain + "/" + original.command.kind; }))
    return AgentNativeV3DecisionSchema.parse({ action: "definition", label: "Discover one original command schema", definition: { kind: "command", command: { domain: original.domain, kind: original.command.kind } }, read: null, result: null });
  return finishNativeV3(packet, originals);
}

/** Public old fixture methods are composed without changing historical paths.
 * The original JPG/Rule Center admission remains explicitly synthetic legacy. */
export function agentNativeV3Fixture(database: DatabaseConnection, options: { contentVault?: SecretVault; modelVault?: SecretVault; orderVault?: SecretVault; integrationVault?: SecretVault } = {}) {
  const env = requireAgentNativeV3Environment(), prior = agentNativeV2Fixture(database, options), base = prior.base;
  const fulfillmentVault = options.orderVault ?? base.originalVault, fulfillment = fulfillmentOwnerPorts(database, fulfillmentVault, options.integrationVault ?? base.integrationVault);
  const fulfillmentBusiness = async (context: TenantContext) => Object.fromEntries(Object.entries(await fulfillment.state(context))
    .filter(([table]) => !["ai_budget_ledger", "agent_plan_runs", "agent_command_requests"].includes(table)));
  const fulfillmentService = new AgentFulfillmentService(database, fulfillment.orders, fulfillment.production, fulfillment.quantities, fulfillment.delivery, fulfillment.shipping, fulfillment.logisticsRead, fulfillmentVault);
  const ownedRuns = new Set<string>(), modelCalls: AgentNativeV3TurnInput[] = [], wire: Array<{ bodyBytes: number; schemaBytes: number }> = [];
  const definitionCalls: Array<{ kind: "legacy" | "resource" | "fulfillment"; input: unknown }> = [];
  const readCalls: Array<{ kind: "legacy" | "resource" | "fulfillment"; context: TenantContext; input: unknown; result?: unknown }> = [];
  const controls: { failQueue: boolean; unknownUsage: boolean; decision: (packet: AgentNativeV3TurnInput) => unknown;
    beforeModel?: (packet: AgentNativeV3TurnInput) => Promise<void>; afterCheckpoint?: (packet: AgentNativeV3TurnInput, value: ModelResponseCheckpoint) => Promise<void>;
    afterRead?: (context: TenantContext, input: unknown, result: unknown) => Promise<void> } = { failQueue: false, unknownUsage: false, decision: packet => nativeV3Sequence(packet) };
  const dispatches: Array<Parameters<AgentPlanDispatcher["enqueue"]>[0]> = [], dispatcher: AgentPlanDispatcher = { enqueue: async input => {
    ownedRuns.add(input.id); dispatches.push(input); if (controls.failQueue) throw new Error("Synthetic V3 queue transport unavailable"); await prior.dispatcher.enqueue(input);
  } };
  const tools = { workspace: prior.legacy.gateway.workspace.bind(prior.legacy.gateway), definition: async (...args: Parameters<typeof prior.legacy.gateway.definition>) => {
    definitionCalls.push({ kind: "legacy", input: args[1] }); return prior.legacy.gateway.definition(...args);
  }, call: async (context: TenantContext, raw: unknown) => { const input = AgentToolCallSchema.parse(raw), row = { kind: "legacy" as const, context, input, result: undefined as unknown };
    readCalls.push(row); const result = await prior.legacy.gateway.call(context, input); row.result = result; await controls.afterRead?.(context, input, result); return result; } };
  const resources = { workspace: prior.resources.service.workspace.bind(prior.resources.service), assertBindingAccess: prior.resources.service.assertBindingAccess.bind(prior.resources.service),
    definition: async (...args: Parameters<typeof prior.resources.service.definition>) => { definitionCalls.push({ kind: "resource", input: args[1] }); return prior.resources.service.definition(...args); },
    call: async (context: TenantContext, raw: unknown) => { const input = AgentResourceCallSchema.parse(raw), row = { kind: "resource" as const, context, input, result: undefined as unknown };
      readCalls.push(row); const result = await prior.resources.service.call(context, input); row.result = result; await controls.afterRead?.(context, input, result); return result; } };
  const fulfillmentPort = { workspace: fulfillmentService.workspace.bind(fulfillmentService), assertBindingAccess: fulfillmentService.assertBindingAccess.bind(fulfillmentService),
    assertResultAccess: fulfillmentService.assertResultAccess.bind(fulfillmentService),
    definition: async (...args: Parameters<typeof fulfillmentService.definition>) => { definitionCalls.push({ kind: "fulfillment", input: args[1] }); return fulfillmentService.definition(...args); },
    call: async (context: TenantContext, raw: unknown) => { const input = AgentFulfillmentCallSchema.parse(raw), row = { kind: "fulfillment" as const, context, input, result: undefined as unknown };
      readCalls.push(row); const result = await fulfillmentService.call(context, input); row.result = result; await controls.afterRead?.(context, input, result); return result; } };
  const service = (retentionSeconds?: number) => new AgentNativeV3Service(database, options.contentVault ?? base.vault, prior.legacy.gateway, prior.resources.service,
    prior.legacy.owners.service(), prior.legacy.owners.adapter, dispatcher, fulfillmentService, retentionSeconds);
  const runtime = () => new AgentNativeV3Runtime({ database, contentVault: options.contentVault ?? base.vault, modelVault: options.modelVault ?? base.modelVault,
    tools, resources, fulfillment: fulfillmentPort, providerFactory: (provider, apiKey, model) => new class extends OpenAiCompatibleProvider {
      override generate<T>(request: ResolvedModelRequest<T>, signal: AbortSignal) {
        const packet = AgentNativeV3TurnInputSchema.parse(request.untrustedSourceData);
        return super.generate({ ...request, onResponseCheckpoint: async value => { await request.onResponseCheckpoint?.(value); await controls.afterCheckpoint?.(packet, value); } }, signal);
      }
    }({ providerId: provider.id, apiKey, endpoint: "https://synthetic-native-v3.invalid/v1", pricing: model.inputUsdPerMillion === null || model.outputUsdPerMillion === null ? null : {
      inputUsdPerMillion: model.inputUsdPerMillion, outputUsdPerMillion: model.outputUsdPerMillion }, fetch: async (_url, init) => {
        const text = String(init?.body), body = JSON.parse(text) as { messages?: Array<{ role?: string; content?: unknown }>; response_format?: unknown };
        const user = body.messages?.find(row => row.role === "user")?.content, framed = typeof user === "string" ? /<untrusted_source_data>\n([\s\S]*)\n<\/untrusted_source_data>/.exec(user)?.[1] : undefined;
        const packet = AgentNativeV3TurnInputSchema.parse(JSON.parse(framed ?? "null")); modelCalls.push(packet);
        wire.push({ bodyBytes: Buffer.byteLength(text), schemaBytes: Buffer.byteLength(JSON.stringify(body.response_format ?? null)) }); await controls.beforeModel?.(packet);
        return Response.json({ id: "synthetic-native-v3-" + createEntityId(), choices: [{ message: { content: JSON.stringify(controls.decision(packet)) } }],
          ...(controls.unknownUsage ? {} : { usage: { prompt_tokens: 50, completion_tokens: 80 } }) });
      } }),
  });
  async function request(actor = base.a, changes: Partial<CreateAgentNativeV3> = {}) {
    const workspace = await service().workspace(await base.current(actor));
    return CreateAgentNativeV3Schema.parse({ version: AGENT_NATIVE_V3_VERSION, requestId: randomUUID(), goal: "Read fourteen fixed original sources and retain separate human confirmation",
      contextText: "Operator notes remain unverified", modelId: base.modelId, bindings: [{ tool: "inventory.balances.page", scope: {} }], allowedCommands: [],
      limits: defaultAgentNativeV3Limits(), maxCostUsd: 1, executionContract: workspace.executionContract, ...changes });
  }
  async function reviewVoid(context: TenantContext, scene: Awaited<ReturnType<typeof fulfillment.seed>>, observed: Awaited<ReturnType<typeof fulfillment.observe>>) {
    if (observed.view.factoryId !== scene.site.factory.id) throw new Error("Actual void source must belong to this fixed factory");
    const first = observed.application.observations[0]; if (!first) throw new Error("Actual void observation required");
    const detail = await fulfillment.imports.voidObservation(context, first.bindingId, first.observationId);
    const { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt } = detail.observation;
    return fulfillment.imports.reviewVoid(context, first.bindingId, ReviewFactoryErpVoidSchema.parse({ expectedBindingRevision: detail.basis.bindingRevision,
      expectedItemsChecksum: detail.basis.itemsChecksum, expectedObservationSequence: detail.basis.observationSequence,
      observation: { id, sequence, importId, rowNumber, rowChecksum, fileChecksum, previewChecksum, recordedAt }, expectedPreviousReviewId: detail.observation.latestReview?.id ?? null,
      source: { importId: observed.view.id, rowNumber, fileChecksum: observed.view.fileChecksum, previewChecksum: observed.view.previewChecksum },
      outcome: "confirmed_voided", reasonCode: "factory_contact", provenance: "operator_attested", confirmed: true, idempotencyKey: createEntityId() }));
  }
  async function seed(actor = base.a) {
    const old = await prior.seed(actor), context = await base.current(actor), scene = await fulfillment.seed(context, [5], { usLogistics: true });
    const shipped = await fulfillment.observe(context, scene, "已出库"), voided = await fulfillment.observe(context, scene, "已作废");
    const reviewed = await reviewVoid(context, scene, voided);
    // The original import owner requires a deliverable production source.
    // Record its observations and complete the original logistics purchase
    // before real QC puts two items on hold. Factory observations and buying
    // logistics never assert our physical handover.
    const logistics = await fulfillment.logisticsTask(context, scene), storedLogistics = await fulfillment.logisticsRead.get(context, logistics.taskId);
    if (storedLogistics.status !== "completed" || storedLogistics.quotedCostMinor !== 500 || storedLogistics.actualCostMinor !== 600)
      throw new Error("Actual synthetic logistics purchase must complete with original quoted500 and actual600 minor units before QC");
    const quality = await fulfillment.quality(context, scene, 3), shipment = await fulfillment.shipment(context, scene);
    const order = await fulfillment.orders.get(context, scene.order.id);
    const bindings = [...old.bindings.map(binding => binding.tool === "orders.order" ? AgentNativeV3BindingSchema.parse({ tool: binding.tool, scope: { orderId: order.id, expectedSequence: order.latestEventSequence } }) : AgentNativeV3BindingSchema.parse(binding)),
      ...["production", "shipments", "logistics"].map(kind => AgentNativeV3BindingSchema.parse({ tool: AGENT_FULFILLMENT_TOOL, scope: { orderId: order.id, expectedSequence: order.latestEventSequence, kind } }))];
    return { old, scene, order, quality, shipment, logistics, shipped, voided, reviewed, bindings, originals: old.originals, query: old.query };
  }
  async function processRun(id: string, actor = base.a) {
    ownedRuns.add(id); const job = await prior.queue.getJob(id); if (!job) throw new Error("Actual V3 Redis job missing");
    const envelope = JobEnvelopeSchema.parse(job.data); if (envelope.tenantId !== actor.tenantId || envelope.requestedBy !== actor.userId) throw new Error("Actual V3 Redis actor mismatch");
    return new AgentPlanProcessor(agentPlanRuntimeRouter(database, prior.legacy.prior.runtime(), prior.legacy.runtime(), prior.runtime(), runtime())).process(envelope);
  }
  const clear = () => { controls.failQueue = false; controls.unknownUsage = false; controls.beforeModel = undefined; controls.afterRead = undefined; controls.afterCheckpoint = undefined;
    controls.decision = packet => nativeV3Sequence(packet); };
  let app: INestApplication | undefined, signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined, origin: string | undefined, closed = false;
  async function token(actor = base.a) { signing ??= await generateKeyPair("RS256"); return new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(actor.subject)
    .setIssuer("https://synthetic-native-v3-oidc.invalid").setAudience("synthetic-native-v3-api").setIssuedAt().setExpirationTime("5m").sign(signing.privateKey); }
  async function startHttp() {
    if (origin) return origin; signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [IdentitySessionController, AgentNativeV3Controller], providers: [{ provide: DATABASE_CONNECTION, useValue: database }, { provide: AgentNativeV3Service, useValue: service() }] })
    class PersonalNativeV3Module {}
    const reflector = new Reflector(); app = await NestFactory.create(PersonalNativeV3Module, { logger: false });
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-native-v3-oidc.invalid", audience: "synthetic-native-v3-api", verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), base.loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(base.loader)); await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function settlePrepared(context = base.a.context) {
    if (!ownedRuns.size) return;
    const records = await withTenant(database.db, context, tx => tx.select({ command: agentCommandRequests }).from(agentPlanItems).innerJoin(agentCommandRequests, eq(agentCommandRequests.id, agentPlanItems.agentCommandId))
      .where(and(inArray(agentPlanItems.runId, [...ownedRuns]), eq(agentCommandRequests.ownerId, context.userId))));
    for (const { command: row } of records) { if (!row.ownerCommandId) continue;
      const ref = { domain: row.binding.domain, commandId: row.ownerCommandId, accountId: row.binding.accountId }; let current = await prior.legacy.owners.adapter.read(context, ref);
      if (current.native.view.canCancel) current = await prior.legacy.owners.adapter.cancel(context, ref);
      if (["succeeded", "cancelled", "rejected", "expired"].includes(current.native.view.status) && !current.native.view.acknowledged) await prior.legacy.owners.adapter.acknowledge(context, ref);
    }
  }
  async function close() { if (closed) return; closed = true; const errors: unknown[] = [];
    for (const done of [() => app?.close(), () => prior.close()]) try { await done(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "NativeV3 exact fixture teardown failed"); }
  return { database, env, prior, base, fulfillment, fulfillmentBusiness, fulfillmentService, fulfillmentPort, tools, resources, service, runtime, dispatcher, modelCalls, wire, dispatches, definitionCalls, readCalls,
    controls, request, seed, reviewVoid, process: processRun, clear, initialize: prior.initialize, close, token, startHttp, settlePrepared, rows: prior.rows, business: prior.business,
    confirmation: prior.confirmation, proof: (input: CreateAgentNativeV3) => ({ requestId: input.requestId, requestChecksum: nativeV3Hash(canonicalAgentNativeV3Request(input)) }),
    prepareInput: (view: Pick<AgentNativeV3View, "requestId">, item: { proposalChecksum: string }) => PrepareAgentNativeV3ItemSchema.parse({ version: AGENT_NATIVE_V3_VERSION, requestId: view.requestId, proposalChecksum: item.proposalChecksum }) };
}

/** Only the nonce-owned tsx child imports decorated owners for compiled UI. */
async function nativeV3BrowserChild() {
  const env = requireAgentNativeV3Environment(), database = connectDatabase(env.url), f = agentNativeV3Fixture(database, {
    contentVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:ai-assist"),
    modelVault: createEnvironmentSecretVault("MODEL_CREDENTIAL_ENCRYPTION_KEY", "yummyai:model-config"), orderVault: createOrderPiiVault(), integrationVault: createIntegrationSecretVault() });
  let context: TenantContext | undefined, actor: AgentActor | undefined, source: Awaited<ReturnType<typeof f.seed>> | undefined;
  let active: Promise<unknown> | undefined, settled = true, entered = false, release: (() => void) | undefined, failure: string | null = null, serial = Promise.resolve(), closed = false, phase = "ready";
  const stats = () => ({ modelCalls: f.modelCalls.length, definitions: f.definitionCalls.length, reads: f.readCalls.length, settled, entered, failure });
  const close = async () => { if (closed) return; closed = true; release?.(); const errors: unknown[] = [];
    for (const done of [() => active, () => context ? f.settlePrepared(context) : undefined, () => f.close(), () => database.client.end()]) try { await done(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, "NativeV3 child cleanup failed"); };
  process.on("disconnect", () => { release?.(); void serial.then(close).catch(() => { process.exitCode = 1; }); });
  process.on("message", raw => { serial = serial.then(async () => {
    if (!raw || typeof raw !== "object") return; const message = raw as Record<string, unknown>; if (message.nonce !== env.nonce || typeof message.id !== "number") return;
    try { let value: unknown;
      if (message.operation === "seed") {
        phase = "actual_personal_membership"; const caller = TenantContextSchema.parse(message.context);
        context = await withTenant(database.db, caller, async tx => TenantContextSchema.parse(intersectPermissionContexts(caller, await loadCurrentMembershipContext(tx, caller, { lock: true }))));
        const [member] = await withTenant(database.db, context, tx => tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, context!.userId), eq(memberships.status, "active"))));
        if (!member) throw new Error("NativeV3 actual personal membership missing"); actor = { ...context, context, subject: "unused-personal-source-actor", membershipId: member.id, roleIds: new Map() };
        phase = "actual_fourteen_owner_sources"; await f.prior.legacy.facts.initialize(); await f.prior.resources.facts.initialize(); source = await f.seed(actor);
        value = { bindings: source.bindings, originals: source.originals, query: source.query, contextText: source.old.old.contextText,
          orderId: source.order.id, orderSequence: source.order.latestEventSequence, inputs: { ...source.old.fresh.inputs, "orders.order": { orderId: source.order.id, expectedSequence: source.order.latestEventSequence } },
          inspectionId: source.old.old.compiled.id, factoryId: source.old.old.site.factory.id, from: source.old.old.pool.localDate };
      } else if (message.operation === "execute") {
        if (!source || !actor || !context || active && !settled) throw new Error("NativeV3 child source or execution unavailable");
        const id = z.uuidv7().parse(message.runId), job = await f.prior.queue.getJob(id); if (!job) throw new Error("Actual V3 Redis job missing");
        let gate: Promise<void> | undefined; if (message.hold === true) gate = new Promise(accept => { release = accept; });
        f.controls.beforeModel = async packet => { if (gate && packet.turn === 1) { entered = true; await gate; } };
        f.controls.decision = packet => nativeV3Sequence(packet, source!.originals.filter(original => packet.allowedCommands.some(command => command.domain === original.domain && command.kind === original.command.kind)), source!.query);
        phase = "actual_v3_worker_router"; settled = false; failure = null; active = f.process(id, actor).then(result => { settled = true; return result; }, error => { settled = true; failure = "native_v3_runtime_rejected"; throw error; });
        void active.catch(() => {}); value = { started: true, originalQueueJobId: job.id };
      } else if (message.operation === "progress") value = stats();
      else if (message.operation === "wait") { await active; value = stats(); }
      else if (message.operation === "release") { release?.(); value = { released: true }; }
      else if (message.operation === "business") { if (!context) throw new Error("NativeV3 actual personal context missing"); value = { native: await f.business(context), fulfillment: await f.fulfillmentBusiness(context),
        carrier: { ...f.fulfillment.carrier.calls }, enqueues: [f.fulfillment.shipmentEnqueues.length, f.fulfillment.logisticsEnqueues.length] }; }
      else if (message.operation === "close") { await close(); value = { closed: true }; }
      else throw new Error("NativeV3 child operation invalid");
      process.send?.({ type: "result", nonce: env.nonce, id: message.id, value });
    } catch (error) { let code: string | null = null, cause: unknown = error;
      for (let depth = 0; depth < 7 && cause && typeof cause === "object"; depth++) { if ("code" in cause && typeof cause.code === "string" && /^[A-Z0-9]{5}$/.test(cause.code)) code ??= cause.code; cause = "cause" in cause ? cause.cause : null; }
      process.send?.({ type: "failure", nonce: env.nonce, id: message.id, phase, code }); }
  }); });
  process.send?.({ type: "ready", nonce: env.nonce });
}
if (process.argv.includes("--agent-native-v3-browser-child")) void nativeV3BrowserChild().catch(() => { process.exitCode = 1; });
