import "reflect-metadata";
import { randomBytes, randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import { Module, type CallHandler, type ExecutionContext, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { generateKeyPair, SignJWT } from "jose";
import { tap } from "rxjs";
import { SecretVault } from "@yummyai/ai-core";
import { intersectPermissionContexts, Permission } from "@yummyai/authz";
import { createEntityId, TenantContextSchema, type TenantContext } from "@yummyai/contracts";
import { PrepareFulfillmentCommandSchema, type FulfillmentCommandKind } from "@yummyai/contracts/order/fulfillment-command";
import { CreateShipmentInputSchema } from "@yummyai/contracts/order/shipment";
import { RecordQualityInspectionInputSchema } from "@yummyai/contracts/order/production";
import { RecordQualityGroupsInputSchema } from "@yummyai/contracts/order/quality-groups";
import { orderFulfillmentCommandIntents, orderWorkItems, productionEditorProjects, memberships, membershipRoles, roles,
  loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { and, eq, sql } from "drizzle-orm";
import { requireFulfillmentCommandEnvironment } from "../../../../tools/testing/require-fulfillment-command-environment.mjs";
import { fulfillmentOwnerPorts } from "../ai/agent-fulfillment.test-fixture.js";
import { factoryCapacityFixture } from "../suppliers/factory-capacity.test-fixture.js";
import { OrderFulfillmentCommandService } from "./order-fulfillment-command.service.js";
import { OrderFulfillmentCommandOwner } from "./order-fulfillment-command-owner.js";
import { OrderFulfillmentCommandController } from "./order-fulfillment-command.controller.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { TenantContextGuard, DatabaseMembershipContextLoader, DatabaseApiClientContextLoader } from "../auth/tenant-context.guard.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

export function fulfillmentCommandDeferred() {
  let release!: () => void;
  const promise = new Promise<void>(done => { release = done; });
  return { promise, release };
}
export async function fulfillmentCommandBounded<T>(operation: Promise<T>, label: string, ms = 20_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_done, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { clearTimeout(timer); }
}

/** Synthetic identities, initial order/work admissions and physical attestations
 * are explicit fixture inputs. Approval, rendering, manufacture, capacity, all
 * fourteen owner mutations and every receipt use their real implementations.
 * No model, marketplace, carrier purchase or queue consumer is invoked. */
export function orderFulfillmentCommandFixture(database: DatabaseConnection,
  options: { orderVault?: SecretVault; integrationVault?: SecretVault } = {}) {
  const isolated = requireFulfillmentCommandEnvironment(), base = factoryCapacityFixture(database,
    options.orderVault ? { vault: options.orderVault } : {});
  const owners = fulfillmentOwnerPorts(database, base.vault, options.integrationVault ?? new SecretVault(randomBytes(32)));
  const allPermissions = Object.values(Permission), a = TenantContextSchema.parse({ ...base.seed(), permissionScopes: Object.fromEntries(allPermissions.map(bit => [bit, "tenant"])) });
  const foreign = TenantContextSchema.parse({ ...base.seed(base.foreign), permissionScopes: Object.fromEntries(allPermissions.map(bit => [bit, "tenant"])) });
  const peer = TenantContextSchema.parse({ ...a, userId: createEntityId() }), peerMembershipId = createEntityId(), peerRoleId = createEntityId();
  const hooks: { beforeExecute?: () => Promise<void>; afterExecute?: () => Promise<void>; afterDescribe?: () => Promise<void>; afterLocate?: () => Promise<void> } = {};
  const releases = new Set<() => void>(), running = new Set<Promise<unknown>>(), tokens = new Map<string, string>();
  const calls = { execute: 0, ownerCompleted: 0, locate: 0, describe: 0, lostExecuteResponses: 0, scenes: 0 };
  let app: INestApplication | undefined, origin: string | undefined, signing: Awaited<ReturnType<typeof generateKeyPair>> | undefined;
  let closed = false, dropExecuteId: string | undefined;
  const originalAudit = owners.audit.recordInTransaction.bind(owners.audit);
  class ObservedOwner extends OrderFulfillmentCommandOwner {
    override async describe(...args: Parameters<OrderFulfillmentCommandOwner["describe"]>) {
      calls.describe++; const actual = await super.describe(...args); await hooks.afterDescribe?.(); return actual;
    }
    override async locate(...args: Parameters<OrderFulfillmentCommandOwner["locate"]>) {
      calls.locate++; const actual = await super.locate(...args); await hooks.afterLocate?.(); return actual;
    }
    override async execute(...args: Parameters<OrderFulfillmentCommandOwner["execute"]>) {
      calls.execute++; await hooks.beforeExecute?.(); await super.execute(...args); calls.ownerCompleted++; await hooks.afterExecute?.();
    }
  }
  const owner = new ObservedOwner(database, base.vault, owners.production, owners.delivery, owners.shipping);
  const service = () => new OrderFulfillmentCommandService(database, base.vault, owner, owners.audit);
  async function current(actor = a) {
    return withTenant(database.db, actor, async tx => TenantContextSchema.parse(intersectPermissionContexts(actor, await loadCurrentMembershipContext(tx, actor))));
  }
  async function initialize() {
    requireFulfillmentCommandEnvironment(); await base.initialize();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,$4)",
      [peer.userId, `capacity-${peer.userId}`, `${peer.userId}@example.invalid`, "Synthetic fulfillment peer"]);
    await withTenant(database.db, a, async tx => {
      await tx.insert(memberships).values({ id: peerMembershipId, tenantId: a.tenantId, userId: peer.userId, status: "active" });
      await tx.insert(roles).values({ id: peerRoleId, tenantId: a.tenantId, name: "Synthetic independent fulfillment peer", permissions: allPermissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: a.tenantId, membershipId: peerMembershipId, roleId: peerRoleId });
    });
    await owners.storage.ensureBucket();
  }
  const roleId = (actor: TenantContext) => actor.userId === a.userId ? base.owner.roleId : actor.userId === peer.userId ? peerRoleId : base.foreign.roleId;
  async function permissions(actor: TenantContext, values: readonly string[], scope: "self" | "team" | "tenant" = "tenant") {
    const [before] = await withTenant(database.db, actor, tx => tx.select({ permissions: roles.permissions, dataScope: roles.dataScope }).from(roles).where(eq(roles.id, roleId(actor))));
    if (!before) throw new Error("fulfillment_fixture_original_role_missing");
    await withTenant(database.db, actor, tx => tx.update(roles).set({ permissions: [...values], dataScope: scope }).where(eq(roles.id, roleId(actor))));
    return { restore: () => withTenant(database.db, actor, tx => tx.update(roles).set({ permissions: before.permissions, dataScope: before.dataScope }).where(eq(roles.id, roleId(actor)))) };
  }
  async function membership(actor: TenantContext, status: "active" | "disabled") {
    await withTenant(database.db, actor, tx => tx.update(memberships).set({ status }).where(and(eq(memberships.userId, actor.userId), eq(memberships.tenantId, actor.tenantId))));
  }
  function hold(phase: "beforeExecute" | "afterExecute" | "afterDescribe" | "afterLocate") {
    const entered = fulfillmentCommandDeferred(), released = fulfillmentCommandDeferred(); releases.add(released.release);
    hooks[phase] = async () => { hooks[phase] = undefined; entered.release(); await released.promise; };
    return { entered: entered.promise, release: () => { released.release(); releases.delete(released.release); } };
  }
  function execute(actor: TenantContext, id: string) {
    const operation = service().execute(actor, id); running.add(operation);
    void operation.then(() => running.delete(operation), () => running.delete(operation)); return operation;
  }
  type Scene = Awaited<ReturnType<typeof owners.seed>>;
  async function scene(whole = false, actor = a) {
    const value = await owners.seed(await current(actor), whole ? [1, 1] : [3], { wholeRelease: whole }); calls.scenes++; return value;
  }
  async function accept(value: Scene, actor = a) {
    let packet = await owners.delivery.get(await current(actor), value.packet.id);
    for (const selected of packet.items) for (const kind of ["received", "accepted"] as const) {
      const item = packet.items.find(row => row.id === selected.id);
      if (!item?.snapshot?.manufacturing) throw new Error("fulfillment_fixture_actual_file_missing");
      packet = await owners.delivery.recordFeedback(await current(actor), packet.id, item.id, { kind, expectedSequence: item.sequence,
        fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum, idempotencyKey: randomUUID(),
        reference: "SYNTHETIC_ORIGINAL_FILE", note: "Synthetic explicit operator attestation for this exact original file only",
        occurredAt: await owners.clock(actor), verifiedByOperator: true });
    }
  }
  async function complete(value: Scene, actor = a) {
    await accept(value, actor);
    for (const production of value.productions) for (const type of ["started", "completed"] as const) {
      const actual = await owners.production.get(await current(actor), production.order.id);
      await owners.production.recordMilestone(await current(actor), production.order.id, { type, expectedProjectionVersion: actual.productionOrder.projectionVersion,
        externalEventId: randomUUID(), occurredAt: await owners.clock(actor), evidence: { code: "SYNTHETIC_OBSERVATION", note: "Synthetic operator fixture attestation only", assetIds: [] } });
    }
  }
  async function standard(value: Scene, actor = a) {
    return owners.production.createQualityStandard(await current(actor), { name: `Synthetic original fulfillment check ${createEntityId()}`,
      supplierId: value.site.supplierId, skuId: null, minimumScoreBps: 9000,
      criteria: [{ code: "PRINT", label: "Synthetic explicit physical check", weightBps: 10000, blocking: true }] });
  }
  const assessment = () => ({ formatVersion: 2 as const, criterionResults: [{ code: "PRINT", scoreBps: 10000, passed: true, evidenceAssetIds: [] }] });
  async function quality(value: Scene, actor = a) {
    await complete(value, actor); const basis = await standard(value, actor);
    for (const production of value.productions) {
      const actual = await owners.production.get(await current(actor), production.order.id);
      await owners.production.inspect(await current(actor), production.order.id, RecordQualityInspectionInputSchema.parse({
        expectedProductionProjectionVersion: actual.productionOrder.projectionVersion, qualityStandardVersionId: basis.id,
        result: "passed", scoreBps: 10000, assessment: assessment(), inspectedAt: await owners.clock(actor), evidenceAssetIds: [], defects: [], idempotencyKey: randomUUID(),
      }));
    }
    return basis;
  }
  async function shipmentInput(value: Scene, actor = a, excludeShipmentId?: string) {
    const sources = await owners.shipping.productionSources(await current(actor), value.order.id, excludeShipmentId);
    const lines = value.order.lines.map(line => {
      const eligible = sources.filter(source => source.orderLineId === line.id && source.availableQuantity >= line.quantity && source.blockers.length === 0);
      if (eligible.length !== 1 || !eligible[0]?.qualityInspectionId) throw new Error("fulfillment_fixture_unique_actual_quality_source_required");
      const source = eligible[0];
      return { orderLineId: line.id, quantity: line.quantity, productionAllocations: [{ productionOrderId: source.productionOrderId,
        productionVersionId: source.productionVersionId, qualityInspectionId: source.qualityInspectionId, qualityGroupId: source.qualityGroupId,
        expectedProductionProjectionVersion: source.projectionVersion, quantity: line.quantity }] };
    });
    return CreateShipmentInputSchema.parse({ shipDate: await owners.clock(actor), shipFromCountryCode: "US", idempotencyKey: randomUUID(),
      packages: [{ packageReferenceId: `SYNTHETIC-${createEntityId()}`, trackingNumber: `SYNTHETIC-${createEntityId()}`, carrierCode: "SYNTHETIC",
        carrierName: "Synthetic original carrier", carrierService: "Synthetic explicit source", lines }] });
  }
  async function wholePins(value: Scene, actor = a) {
    const actual = await owners.production.wholeOrderFulfillment(await current(actor), value.order.id);
    return actual.items.map(item => {
      if (!item.production) throw new Error("fulfillment_fixture_original_whole_production_required");
      return { lineId: item.lineId, quantity: item.quantity, expectedRevision: item.expectedRevision, expectedProjectionVersion: item.expectedProjectionVersion,
        productionOrderId: item.production.id, expectedProductionProjectionVersion: item.production.projectionVersion };
    });
  }
  async function command(kind: FulfillmentCommandKind, actor = a) {
    const value = await scene(kind.startsWith("whole_"), actor), first = value.productions[0];
    if (!first) throw new Error("fulfillment_fixture_original_production_required");
    const requestId = randomUUID(), idempotencyKey = randomUUID(), now = () => owners.clock(actor);
    let raw: unknown;
    if (kind === "delivery_create") {
      const items = await Promise.all(value.productions.map(async production => {
        const actual = await owners.production.get(await current(actor), production.order.id);
        return { productionOrderId: production.order.id, productionVersionId: production.version.id,
          expectedProjectionVersion: actual.productionOrder.projectionVersion };
      }));
      raw = { kind, requestId, targetId: value.order.id, input: { supplierId: value.site.supplierId, factoryId: value.site.factory.id,
        items, idempotencyKey } };
    } else if (kind === "delivery_feedback") {
      const packet = await owners.delivery.get(await current(actor), value.packet.id), item = packet.items[0];
      if (!item?.snapshot?.manufacturing) throw new Error("fulfillment_fixture_original_packet_required");
      raw = { kind, requestId, targetId: item.id, packageId: packet.id, input: { kind: "received", expectedSequence: item.sequence,
        fileChecksum: item.snapshot.file.checksum, manufacturingChecksum: item.snapshot.manufacturing.plan.checksum, idempotencyKey,
        reference: "SYNTHETIC_ORIGINAL_RECEIPT", note: "Synthetic explicit operator observation of this exact original file",
        occurredAt: await now(), verifiedByOperator: true } };
    } else if (kind === "production_milestone" || kind === "whole_production_milestone") {
      await accept(value, actor);
      const evidence = { code: "SYNTHETIC_OBSERVATION", note: "Synthetic original physical attestation only", assetIds: [] };
      if (kind === "whole_production_milestone") raw = { kind, requestId, targetId: value.order.id,
        input: { type: "started", occurredAt: await now(), evidence, items: await wholePins(value, actor), idempotencyKey } };
      else { const actual = await owners.production.get(await current(actor), first.order.id);
        raw = { kind, requestId, targetId: first.order.id, input: { type: "started", expectedProjectionVersion: actual.productionOrder.projectionVersion,
          externalEventId: idempotencyKey, occurredAt: await now(), evidence } }; }
    } else if (kind === "quality_inspection" || kind === "quality_group_inspection" || kind === "whole_quality_inspection") {
      await complete(value, actor); const basis = await standard(value, actor);
      if (kind === "whole_quality_inspection") raw = { kind, requestId, targetId: value.order.id, input: { items: await wholePins(value, actor),
        qualityStandardVersionId: basis.id, scoreBps: 10000, assessment: assessment(), inspectedAt: await now(), evidenceAssetIds: [], idempotencyKey } };
      else { const actual = await owners.production.get(await current(actor), first.order.id);
        raw = kind === "quality_inspection" ? { kind, requestId, targetId: first.order.id, input: { expectedProductionProjectionVersion: actual.productionOrder.projectionVersion,
          qualityStandardVersionId: basis.id, result: "passed", scoreBps: 10000, assessment: assessment(), inspectedAt: await now(), evidenceAssetIds: [], defects: [], idempotencyKey } }
          : { kind, requestId, targetId: first.order.id, input: RecordQualityGroupsInputSchema.parse({ formatVersion: 3, productionVersionId: first.version.id,
            expectedProductionProjectionVersion: actual.productionOrder.projectionVersion, expectedRootInspectionId: null, qualityStandardVersionId: basis.id,
            inspectedAt: await now(), segregationConfirmed: true, idempotencyKey,
            groups: [{ key: "good", label: "Synthetic original isolated bin", quantity: first.quantity, criterionResults: assessment().criterionResults, defects: [] }] }) }; }
    } else if (kind === "production_recovery") {
      const actual = await owners.production.get(await current(actor), first.order.id);
      await owners.production.recordMilestone(await current(actor), first.order.id, { type: "failed", expectedProjectionVersion: actual.productionOrder.projectionVersion,
        externalEventId: randomUUID(), occurredAt: await now(), evidence: { code: "SYNTHETIC_FAILED", note: "Synthetic original failure attestation only", assetIds: [] } });
      const work = await owners.work.detail(await current(actor), first.lineId);
      raw = { kind, requestId, targetId: first.order.id, input: { type: "remake", originalProductionOrderId: first.order.id, remakeQuantity: 1,
        reason: "Synthetic explicit original remake", expectedCompletionAt: value.site.capacity.expectedCompletionAt, manufacturing: first.manufacturing.manufacturing,
        capacityPlan: value.site.capacity.capacityPlan, reviewedArtwork: { renderId: first.renderId, expectedRevision: work.line.revision,
          expectedProjectionVersion: work.line.projectionVersion, instructions: "Synthetic same approved original artwork" }, idempotencyKey } };
    } else {
      await quality(value, actor); const content = await shipmentInput(value, actor);
      if (kind === "shipment_create") raw = { kind, requestId, targetId: value.order.id, input: content };
      else if (kind === "whole_shipment_create") {
        const pins = await wholePins(value, actor), packet = content.packages[0]!;
        raw = { kind, requestId, targetId: value.order.id, input: { shipDate: content.shipDate, shipFromCountryCode: content.shipFromCountryCode,
          trackingNumber: packet.trackingNumber, carrierCode: packet.carrierCode, carrierName: packet.carrierName, carrierService: packet.carrierService,
          items: pins.map(pin => ({ lineId: pin.lineId, quantity: pin.quantity, expectedRevision: pin.expectedRevision,
            expectedProjectionVersion: pin.expectedProjectionVersion, productionAllocations: packet.lines.find(line => line.orderLineId === pin.lineId)?.productionAllocations })), idempotencyKey } };
      } else {
        let saved = await owners.shipping.create(await current(actor), value.order.id, content);
        if (kind === "shipment_version") raw = { kind, requestId, targetId: saved.shipment.id,
          input: { ...await shipmentInput(value, actor, saved.shipment.id), expectedCurrentVersion: 1, idempotencyKey } };
        else {
          const version = saved.versions.find(row => row.versionNumber === saved.shipment.currentVersionNumber);
          if (!version) throw new Error("fulfillment_fixture_original_shipment_version_required");
          const review = { decision: "approved" as const, reasonCode: "SYNTHETIC_REVIEW", reason: "Synthetic explicit original quality and allocation review",
            expectedCurrentVersion: saved.shipment.currentVersionNumber, idempotencyKey };
          if (kind === "shipment_review") raw = { kind, requestId, targetId: saved.shipment.id, versionId: version.id, input: review };
          else {
            saved = await owners.shipping.reviewVersion(await current(actor), saved.shipment.id, version.id, { ...review, idempotencyKey: randomUUID() });
            const dispatch = { expectedVersion: saved.shipment.currentVersionNumber, occurredAt: await now(), reason: "Synthetic actual handover observation only", idempotencyKey };
            if (kind === "shipment_dispatch") raw = { kind, requestId, targetId: saved.shipment.id, input: dispatch };
            else { saved = await owners.shipping.dispatch(await current(actor), saved.shipment.id, { ...dispatch, idempotencyKey: randomUUID() });
              raw = { kind, requestId, targetId: saved.shipment.id, input: { expectedVersion: saved.shipment.currentVersionNumber,
                evidenceReference: "Synthetic operator platform check; no marketplace request", confirmedAt: await now(), idempotencyKey } }; }
          }
        }
      }
    }
    return { scene: value, command: PrepareFulfillmentCommandSchema.parse(raw) };
  }
  async function business(actor = a) {
    const main = await owners.state(actor);
    const additional = await withTenant(database.db, actor, async tx => {
      const result: Record<string, { count: number; hash: string }> = {};
      for (const table of ["shipment_version_reviews", "shipment_manual_confirmations", "production_recovery_cases", "factory_capacity_reservations", "factory_capacity_events", "order_work_events"]) {
        const [row] = await tx.execute<{ count: number; hash: string }>(sql`select count(*)::int as count,md5(coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text)::text,'[]')) as hash from ${sql.identifier(table)} r`);
        if (!row) throw new Error("fulfillment_fixture_business_projection_missing"); result[table] = row;
      }
      return result;
    });
    return { ...main, ...additional };
  }
  async function intent(id: string, actor = a) {
    const [row] = await withTenant(database.db, actor, tx => tx.select().from(orderFulfillmentCommandIntents).where(eq(orderFulfillmentCommandIntents.id, id)));
    return row ? { id: row.id, requestId: row.requestId, requestChecksum: row.requestChecksum, ownerChecksum: row.ownerChecksum, kind: row.kind,
      orderId: row.orderId, targetId: row.targetId, status: row.status, generation: row.generation, encryptedInputPresent: row.encryptedInput !== null,
      leasePresent: row.leaseToken !== null, leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null, authoritySnapshot: row.authoritySnapshot,
      expiresAt: row.expiresAt.toISOString(), acknowledged: row.acknowledgedAt !== null, redacted: row.redactedAt !== null } : null;
  }
  async function auditState(actor = a) {
    return withTenant(database.db, actor, async tx => (await tx.execute<{ action: string; count: number }>(sql`
      select action,count(*)::int as count from audit_events group by action order by action`)));
  }
  function failNextAudit(action: string) {
    let failed = false;
    owners.audit.recordInTransaction = async (...args: Parameters<typeof owners.audit.recordInTransaction>) => {
      if (!failed && args[2].action === action) { failed = true; throw new Error("fulfillment_synthetic_final_audit_failed"); }
      return originalAudit(...args);
    };
    return { restore: () => { owners.audit.recordInTransaction = originalAudit; }, failed: () => failed };
  }
  async function shortenSource(value: Scene, seconds = 3) {
    await withTenant(database.db, a, async tx => {
      const [clock] = await tx.execute<{ deadline: Date }>(sql`select clock_timestamp()+${seconds}*interval '1 second' as deadline`);
      if (!clock) throw new Error("fulfillment_fixture_source_clock_missing");
      for (const row of value.productions) {
        await tx.update(orderWorkItems).set({ expiresAt: new Date(clock.deadline) }).where(eq(orderWorkItems.id, row.lineId));
        await tx.update(productionEditorProjects).set({ expiresAt: new Date(clock.deadline) }).where(eq(productionEditorProjects.id, row.projectId));
      }
    });
  }
  async function waitExpired(id: string) {
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const [row] = await withTenant(database.db, a, tx => tx.execute<{ expired: boolean }>(sql`select expires_at<=clock_timestamp() as expired from order_fulfillment_command_intents where id=${id}::uuid`));
      if (row?.expired) return; await new Promise<void>(done => setTimeout(done, 50));
    }
    throw new Error("fulfillment_fixture_real_expiry_not_observed");
  }
  async function token(actor = a) {
    const prior = tokens.get(actor.userId); if (prior) return prior; signing ??= await generateKeyPair("RS256");
    const value = await new SignJWT({ tenant_id: actor.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(`capacity-${actor.userId}`)
      .setIssuer("https://synthetic-fulfillment-command.invalid").setAudience("synthetic-fulfillment-command-api").setIssuedAt().setExpirationTime("30m").sign(signing.privateKey);
    tokens.set(actor.userId, value); return value;
  }
  async function startHttp() {
    if (origin) return origin; signing ??= await generateKeyPair("RS256");
    @Module({ controllers: [OrderFulfillmentCommandController, IdentitySessionController], providers: [
      { provide: DATABASE_CONNECTION, useValue: database }, { provide: OrderFulfillmentCommandService, useValue: service() },
    ] }) class FulfillmentPersonalModule {}
    app = await NestFactory.create(FulfillmentPersonalModule, { logger: false, abortOnError: false });
    const reflector = new Reflector(), clients = new DatabaseApiClientContextLoader(database);
    app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer: "https://synthetic-fulfillment-command.invalid", audience: "synthetic-fulfillment-command-api", verificationKey: signing.publicKey }),
      new DatabaseMembershipContextLoader(database), clients, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
    app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(clients), { intercept(context: ExecutionContext, next: CallHandler) {
      const request = context.switchToHttp().getRequest<{ method: string; url: string }>();
      return next.handle().pipe(tap(() => {
        if (dropExecuteId && request.method === "POST" && request.url === `/v1/order-centers/fulfillment-commands/${dropExecuteId}/execute`) {
          dropExecuteId = undefined; calls.lostExecuteResponses++; context.switchToHttp().getResponse<ServerResponse>().destroy();
        }
      }));
    } });
    await app.listen(0, "127.0.0.1"); origin = await app.getUrl(); return origin;
  }
  async function http(actor: TenantContext, suffix = "", body?: unknown) {
    if (!/^(?:\?[A-Za-z0-9%=&_-]+|\/[a-f0-9-]{36}(?:\/(?:execute|cancel|acknowledge))?)?$/.test(suffix)) throw new Error("fulfillment_fixture_http_path_invalid");
    return fetch(`${await startHttp()}/v1/order-centers/fulfillment-commands${suffix}`, { method: body === undefined ? "GET" : "POST", redirect: "error",
      headers: { authorization: `Bearer ${await token(actor)}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function settle() {
    hooks.beforeExecute = undefined; hooks.afterExecute = undefined; hooks.afterDescribe = undefined; hooks.afterLocate = undefined; dropExecuteId = undefined;
    owners.audit.recordInTransaction = originalAudit; for (const release of releases) release(); releases.clear();
    await Promise.allSettled([...running]);
    for (const actor of [a, peer, foreign]) { await membership(actor, "active"); await permissions(actor, allPermissions); }
    const rows = await withTenant(database.db, a, tx => tx.select({ id: orderFulfillmentCommandIntents.id }).from(orderFulfillmentCommandIntents)
      .where(and(eq(orderFulfillmentCommandIntents.createdBy, a.userId), sql`${orderFulfillmentCommandIntents.acknowledgedAt} is null`)));
    for (const row of rows) {
      let view = await service().get(await current(), row.id);
      if (view.canCancel) view = await service().cancel(await current(), row.id);
      if (["succeeded", "rejected", "cancelled", "expired"].includes(view.status)) await service().acknowledge(await current(), row.id);
      else throw new Error("fulfillment_fixture_unresolved_original_at_close");
    }
  }
  async function close() {
    if (closed) return; closed = true; const failures: unknown[] = [];
    try { await settle(); } catch (error) { failures.push(error); }
    try { await app?.close(); } catch (error) { failures.push(error); }
    tokens.clear(); if (failures.length) throw new AggregateError(failures, "fulfillment_fixture_close_failed");
  }
  return { isolated, base, owners, owner, service, a, peer, foreign, allPermissions, calls, hooks, current, initialize, permissions, membership,
    hold, execute, scene, command, accept, complete, quality, standard, assessment, shipmentInput, wholePins, business, intent, auditState,
    failNextAudit, shortenSource, waitExpired, token, startHttp, http, loseExecuteResponse: (id: string) => { dropExecuteId = id; }, settle, close };
}
