import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import type { TenantContext } from "@yummyai/contracts";
import { AgentNativeV4DecisionSchema, agentNativeV4DefinitionSelection,
  type AgentNativeV4TurnInput } from "@yummyai/contracts/ai/agent-native-v4";
import { AGENT_FULFILLMENT_PROPOSAL_VERSION, parseAgentFulfillmentSuggestion } from "@yummyai/contracts/ai/agent-fulfillment-proposal";
import { AGENT_FULFILLMENT_TOOL } from "@yummyai/contracts/ai/agent-fulfillment";
import { PrepareFulfillmentCommandSchema } from "@yummyai/contracts/order/fulfillment-command";
import { CreateShipmentInputSchema, ShipmentCreateWorkspaceSchema } from "@yummyai/contracts/order/shipment";
import { RecordQualityGroupsInputSchema, type QualityPhysicalGroupView } from "@yummyai/contracts/order/quality-groups";
import { withTenant, type DatabaseConnection } from "@yummyai/database";
import { sql } from "drizzle-orm";
import { requireShipmentCreateEnvironment } from "../../../../tools/testing/require-shipment-create-environment.mjs";
import { agentNativeV4Fixture, type AgentNativeV4FixtureOptions } from "./agent-native-v4.test-fixture.js";
import type { AgentActor } from "./agent-read.test-fixture.js";
import { OrderShipmentService } from "../orders/order-shipment.service.js";
import { OrderShipmentCommandController } from "../orders/order-shipment.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { DatabaseMembershipContextLoader, TenantContextGuard } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

/** Explicit synthetic initial admissions and physical attestations. Rendering,
 * manufacture, completion, disjoint QC groups and every shipment receipt use the
 * original owners. The inherited real OpenAiProvider only reaches loopback
 * Responses; the exact original Redis envelope is processed without a Worker. */
export function shipmentCreateFixture(database: DatabaseConnection, options: AgentNativeV4FixtureOptions = {}) {
  const environment = requireShipmentCreateEnvironment(), native = agentNativeV4Fixture(database, options), owners = native.original.owners;
  let app: INestApplication | undefined, origin: string | undefined, signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined, closed = false;
  const tokens = new Map<string, string>();
  const current = () => native.current();
  async function scenario() {
    const context = await current(), scene = await owners.seed(context, [5, 1]);
    await native.original.complete(scene, context);
    const standard = await native.original.standard(scene, context);
    const groups: Array<QualityPhysicalGroupView & { lineId: string; productionProjectionVersionAfterInspection: number }> = [];
    for (const [index, production] of scene.productions.entries()) {
      const basis = await owners.production.qualityGroups(context, production.order.id);
      const result = await owners.production.inspectGroups(context, production.order.id, RecordQualityGroupsInputSchema.parse({
        formatVersion: 3, productionVersionId: basis.productionVersionId, expectedProductionProjectionVersion: basis.projectionVersion,
        expectedRootInspectionId: basis.rootInspectionId, qualityStandardVersionId: standard.id, inspectedAt: await owners.clock(context),
        segregationConfirmed: true, idempotencyKey: randomUUID(), groups: [
          { key: "good", label: `Synthetic line ${index + 1} passed physical bin`, quantity: index === 0 ? 3 : 1,
            criterionResults: [{ code: "PRINT", scoreBps: 10000, passed: true, evidenceAssetIds: [] }], defects: [] },
          ...(index === 0 ? [{ key: "held", label: "Synthetic line 1 isolated rejected bin", quantity: 2,
            criterionResults: [{ code: "PRINT", scoreBps: 0, passed: false, evidenceAssetIds: [] }],
            defects: [{ code: "PRINT_DEFECT", severity: "major", responsibility: "supplier", disposition: "remake", note: "Synthetic segregated physical observation", evidenceAssetIds: [] }] }] : []),
        ],
      }));
      groups.push(...result.workspace.groups.filter(group => group.active).map(group => ({ ...group, lineId: production.lineId,
        productionProjectionVersionAfterInspection: result.workspace.projectionVersion })));
    }
    const workspace = ShipmentCreateWorkspaceSchema.parse(await owners.shipping.createWorkspace(context, scene.order.id));
    const a = scene.productions[0], b = scene.productions[1];
    if (!a || !b || workspace.lines.length !== 2) throw new Error("shipment_create_original_two_lines_required");
    const aGood = groups.find(group => group.lineId === a.lineId && group.result === "passed"), aHeld = groups.find(group => group.lineId === a.lineId && group.result === "failed");
    const bGood = groups.find(group => group.lineId === b.lineId && group.result === "passed");
    if (!aGood || !aHeld || !bGood || aGood.quantity !== 3 || aHeld.quantity !== 2 || bGood.quantity !== 1)
      throw new Error("shipment_create_original_disjoint_groups_required");
    function allocation(lineId: string, groupId: string) {
      const source = workspace.sources.find(row => row.orderLineId === lineId && row.qualityGroupId === groupId);
      if (!source?.qualityInspectionId || source.blockers.length || source.availableQuantity < 1) throw new Error("shipment_create_actual_source_required");
      return { productionOrderId: source.productionOrderId, productionVersionId: source.productionVersionId,
        qualityInspectionId: source.qualityInspectionId, qualityGroupId: source.qualityGroupId,
        expectedProductionProjectionVersion: source.projectionVersion, quantity: 1 };
    }
    const line = (lineId: string, groupId: string) => ({ orderLineId: lineId, quantity: 1, productionAllocations: [allocation(lineId, groupId)] });
    const packet = (suffix: string, lines: ReturnType<typeof line>[]) => ({ packageReferenceId: `SYNTHETIC-PARTIAL-${suffix}`,
      trackingNumber: `SYNTHETIC-TRACK-${scene.seedId}-${suffix}`, carrierCode: "SYNTHETIC", carrierName: "Synthetic original carrier",
      carrierService: "Synthetic partial shipment only", lines });
    const input = CreateShipmentInputSchema.parse({ shipDate: await owners.clock(context), shipFromCountryCode: "US", idempotencyKey: randomUUID(),
      packages: [packet("A", [line(a.lineId, aGood.id), line(b.lineId, bGood.id)]), packet("B", [line(a.lineId, aGood.id)])] });
    const command = PrepareFulfillmentCommandSchema.parse({ kind: "shipment_create", requestId: randomUUID(), targetId: scene.order.id, input });
    if (command.kind !== "shipment_create") throw new Error("shipment_create_original_command_required");
    return { scene, command, workspace, groups: { aGood, aHeld, bGood } };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;
  function decision(value: Scenario, packet: AgentNativeV4TurnInput) {
    const binding = packet.bindings[0]; if (!binding || binding.tool !== AGENT_FULFILLMENT_TOOL) throw new Error("shipment_create_actual_read_binding_required");
    if (!packet.definitions.some(row => { const selection = agentNativeV4DefinitionSelection(row.definition); return selection.kind === "read" && selection.tool === binding.tool; }))
      return { action: "definition", label: "Discover original fulfillment source", definition: { kind: "read", tool: binding.tool }, read: null, result: null };
    const observation = packet.observations.find(row => row.request.bindingIndex === 0);
    if (!observation) return { action: "read", label: "Read only this original order and actual QC groups", definition: null, read: { bindingIndex: 0, keyword: null }, result: null };
    if (!packet.definitions.some(row => { const selection = agentNativeV4DefinitionSelection(row.definition); return selection.kind === "command" && selection.command.domain === "fulfillment" && selection.command.kind === "shipment_create"; }))
      return { action: "definition", label: "Discover the original partial shipment definition", definition: { kind: "command", command: { domain: "fulfillment", kind: "shipment_create" } }, read: null, result: null };
    const result = observation.results[0];
    if (result?.version !== "erp-agent-fulfillment-v1" || result.data.order.id !== value.scene.order.id) throw new Error("shipment_create_original_observation_required");
    // Only real line/source pins and suggested partial quantities enter the
    // model packet. Tracking, dates and every physical check stay with the UI.
    const suggestion = parseAgentFulfillmentSuggestion({ version: AGENT_FULFILLMENT_PROPOSAL_VERSION, domain: "fulfillment",
      source: { stepId: observation.stepId, resultIndex: 0, dataChecksum: result.dataChecksum, orderId: result.data.order.id, expectedSequence: result.data.order.sequence },
      original: { kind: "shipment_create", targetId: value.scene.order.id, input: { packages: value.command.input.packages.map(pkg => ({
        packageReferenceId: pkg.packageReferenceId, lines: pkg.lines.map(line => ({ orderLineId: line.orderLineId, quantity: line.quantity, productionAllocations: line.productionAllocations })),
      })) } } });
    return AgentNativeV4DecisionSchema.parse({ action: "finish", label: "Suggest two partial packages from this exact original read", definition: null, read: null,
      result: { summary: "Synthetic partial package suggestion; not a physical inspection, shipment approval or handover", missingInformation: [],
        claims: [{ stepId: observation.stepId, resultIndex: 0, dataChecksum: result.dataChecksum, path: ["order", "sequence"], value: result.data.order.sequence }],
        proposals: [{ position: 0, capability: { domain: "fulfillment", kind: "shipment_create" }, label: "Synthetic two-package partial suggestion",
          reason: "Original lines and QC identities do not establish a person's packaging confirmation", draftJson: JSON.stringify(suggestion), claimIndexes: [0],
          missingInformation: ["Complete tracking, dates, physical source checks and separate original confirmation"] }] } });
  }
  async function plan(options: { modelId?: string } = {}) {
    const value = await scenario(), input = await native.request(value, options.modelId ? { modelId: options.modelId } : {});
    native.controls.decision = packet => decision(value, packet);
    const created = await native.service().start(await current(), input); await native.process(created.id);
    const view = await native.service().get(await current(), created.id), item = view.items[0], proposal = view.result?.proposals[0];
    if (view.status !== "completed" || !item || !proposal || proposal.id !== item.id || proposal.draft.fulfillment?.original.kind !== "shipment_create")
      throw new Error("shipment_create_original_model_parent_not_completed:" + JSON.stringify({
        status: view.status, errorCode: view.errorCode,
        counters: { modelCalls: native.modelCalls.length, responses: native.wire.length, providerFailures: native.providerFailures.length },
        steps: view.steps.map(step => ({ kind: step.kind, phase: step.phase, errorCode: step.errorCode, submissionState: step.submissionState })),
        itemPresent: !!item, proposalPresent: !!proposal, itemProposalIdMatches: !!item && proposal?.id === item.id,
        shipmentCreateSuggestion: proposal?.draft.fulfillment?.original.kind === "shipment_create",
      }));
    return { scenario: value, input, view, item, prepare: native.prepareInput(view, item, value) };
  }
  async function httpWorkspace(actor: AgentActor, orderId: string, search = "") {
    if (!/^[a-f0-9-]{36}$/.test(orderId) && orderId !== "not-an-id" || search !== "" && search !== "?unexpected=1") throw new Error("shipment_create_http_target_invalid");
    if (!origin) {
      signing = await generateKeyPair("RS256");
      @Module({ controllers: [OrderShipmentCommandController], providers: [{ provide: DATABASE_CONNECTION, useValue: database },
        { provide: OrderShipmentService, useValue: owners.shipping }] }) class WorkspaceModule {}
      app = await NestFactory.create(WorkspaceModule, { logger: false, abortOnError: false }); const reflector = new Reflector();
      app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-shipment-create.invalid", audience: "synthetic-shipment-create-api", verificationKey: signing.publicKey }),
        new DatabaseMembershipContextLoader(database), native.base.loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
      app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(native.base.loader)); await app.listen(0, "127.0.0.1"); origin = await app.getUrl();
    }
    if (!signing) throw new Error("shipment_create_synthetic_signer_missing");
    let token = tokens.get(actor.userId);
    if (!token) { token = await new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(actor.subject)
      .setIssuer("https://synthetic-shipment-create.invalid").setAudience("synthetic-shipment-create-api").setIssuedAt().setExpirationTime("30m").sign(signing.privateKey); tokens.set(actor.userId, token); }
    return fetch(`${origin}/v1/orders/${orderId}/shipment-create-workspace${search}`, { redirect: "error", headers: { authorization: `Bearer ${token}` } });
  }
  async function business() { return native.business(); }
  async function shipmentState(orderId: string) {
    return withTenant(database.db, await current(), async tx => {
      const facts: Record<string, { count: number; hash: string }> = {};
      for (const table of ["shipments", "shipment_versions", "shipment_packages", "shipment_package_lines", "shipment_production_allocations", "shipment_version_reviews", "shipment_tracking_events", "shipment_writeback_requests", "shipment_manual_confirmations"]) {
        const [row] = await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'[]')) as hash from ${sql.identifier(table)} r`);
        if (!row) throw new Error("shipment_create_business_metadata_missing"); facts[table] = row;
      }
      const [role] = await tx.execute<{ role: string }>(sql`select current_user as role`);
      const own = await tx.execute<{ count: number }>(sql`select count(*)::int as count from shipments where order_id=${orderId}::uuid`);
      return { tables: facts, role: role?.role ?? null, orderShipmentCount: own[0]?.count ?? -1 };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }
  async function close() {
    if (closed) return; closed = true; const failures: unknown[] = [];
    try { await app?.close(); } catch (error) { failures.push(error); }
    try { await native.close(); } catch (error) { failures.push(error); }
    tokens.clear(); if (failures.length) throw new AggregateError(failures, "shipment_create_fixture_close_failed");
  }
  return { environment, native, owners, current, scenario, plan, business, shipmentState, httpWorkspace,
    initialize: () => native.initialize(), workspace: async (orderId: string, context?: TenantContext) => ShipmentCreateWorkspaceSchema.parse(await owners.shipping.createWorkspace(context ?? await current(), orderId)),
    complete: (value: Scenario, itemId: string) => native.complete(value, itemId), close };
}

export type ShipmentCreateFixture = ReturnType<typeof shipmentCreateFixture>;
export type ShipmentCreateScenario = Awaited<ReturnType<ShipmentCreateFixture["scenario"]>>;
