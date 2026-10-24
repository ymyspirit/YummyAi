import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { Controller, Get, Module, Post, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { ForbiddenError, Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  CreatedIntegrationApiClientViewSchema, IntegrationAgentCatalogSchema, IntegrationWorkspaceViewSchema,
  RevokedIntegrationApiClientViewSchema, integrationApiClientRequestCanonical,
} from "@yummyai/contracts/integration";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { connectDatabase, migrateDatabase, integrationApiClients, integrationApiClientEvents, organizationTeams,
  organizationTeamMembers, withTenant, type TenantTransaction } from "@yummyai/database";
import { eq, sql, type SQL } from "drizzle-orm";
import { generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agentDelegationFixture, agentDelegationSha, requireAgentDelegationEnvironment } from "../../../../tools/testing/agent-delegation-fixture.mjs";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { DatabaseMembershipContextLoader, TenantContextGuard } from "../auth/tenant-context.guard.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { RequiresPermission } from "../auth/permissions.decorator.js";
import { InventoryController } from "../inventory/inventory.controller.js";
import { InventoryService } from "../inventory/inventory.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";
import { IntegrationAgentCapabilityController } from "./agent-capability.controller.js";

requireAgentDelegationEnvironment("current");
const baseRights = { [Permission.IntegrationRead]: "tenant", [Permission.IntegrationManage]: "tenant",
  [Permission.InventoryRead]: "self", [Permission.FinanceRead]: "tenant" } as const;
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
};
async function within<T>(operation: Promise<T>, label: string, ms = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
  finally { if (timer) clearTimeout(timer); }
}
function pgCode(error: unknown) {
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    if ("code" in current && typeof current.code === "string" && /^[0-9A-Z]{5}$/.test(current.code)) return current.code;
    current = "cause" in current ? current.cause : null;
  }
  return null;
}
async function pgReject(operation: Promise<unknown>, code = "23514") {
  try { await operation; } catch (error) { expect(pgCode(error)).toBe(code); return; }
  throw new Error("Native application SQL unexpectedly committed");
}
function credential(value: { bearerToken: string | null }) {
  if (!value.bearerToken) throw new Error("Actual one-time synthetic credential required");
  return value.bearerToken;
}

// Denial-only harness routes. Successful business reads below use the unmodified
// InventoryController/InventoryService, not a simulated tenant filtering adapter.
let forbiddenHandlerCalls = 0;
@Controller("delegation-qa")
class UnverifiedRoutes {
  @Get("undecorated") unverified() { forbiddenHandlerCalls++; return { unsafe: true }; }
  @Post("read-shaped-post") @RequiresPermission(Permission.InventoryRead)
  post() { forbiddenHandlerCalls++; return { unsafe: true }; }
}

describe.sequential("current API-client delegation and non-executable ERP capability metadata", () => {
  const database = connectDatabase(), f = agentDelegationFixture(database);
  beforeAll(() => migrateDatabase(database));
  afterAll(async () => { vi.restoreAllMocks(); await database.client.end(); });

  it("pins real current membership, individual scope limits, caller ceilings and original teams without borrowing another permission's tenant scope", async () => {
    const a = await f.actor(baseRights), first = await f.team(a), second = await f.team(a), current = await f.current(a);
    const ceiling: TenantContext = { ...current, permissionScopes: { ...current.permissionScopes, [Permission.FinanceRead]: "self" }, teamIds: [first.teamId] };
    const input = f.input({ scopes: ["inventory:read", "finance:read"] });
    const value = CreatedIntegrationApiClientViewSchema.parse(await f.service.createApiClient(ceiling, input));
    const pin = value.client.delegation!;
    expect(pin).toMatchObject({ version: "integration-api-delegation-v1", membershipId: a.membershipId,
      permissionScopes: { "inventory:read": "self", "finance:read": "self" }, teamIds: [first.teamId],
      requestChecksum: agentDelegationSha(integrationApiClientRequestCanonical(input)) });
    expect(pin.teamIds).not.toContain(second.teamId); expect(value.client.credentialState).toBe("pinned");
    const loaded = await f.loader.load(credential(value));
    expect(loaded).toMatchObject({ tenantId: a.tenantId, userId: a.userId, permissions: ["finance:read", "inventory:read"],
      permissionScopes: { "finance:read": "self", "inventory:read": "self" }, dataScope: "self", teamIds: [first.teamId] });
    expect(loaded?.permissions).not.toContain(Permission.IntegrationManage);
    const before = await f.state(a);
    await expect(f.service.createApiClient(current, f.input({ scopeLimits: { "inventory:read": "tenant" } })))
      .rejects.toThrow("integration_client_scope_exceeded");
    await expect(f.service.createApiClient(ceiling, f.input({ teamIds: [second.teamId] })))
      .rejects.toThrow("integration_client_team_exceeded");
    expect(await f.state(a)).toEqual(before);
    const explicit = await f.service.createApiClient(current, f.input({ scopes: ["finance:read"], scopeLimits: { "finance:read": "team" }, teamIds: [] }));
    expect(explicit.client.delegation).toMatchObject({ permissionScopes: { "finance:read": "team" }, teamIds: [] });
    const source = await f.row(a, value.client.id);
    expect(source?.delegationRequest).toEqual(input); expect(source?.secretDigest).toBe(agentDelegationSha(credential(value)));
    expect(JSON.stringify(value.client)).not.toMatch(/secretDigest|secret_digest|bearerToken/);
    const missing = await f.actor({ [Permission.InventoryRead]: "tenant" });
    await expect(f.service.createApiClient(missing.context, f.input())).rejects.toBeInstanceOf(ForbiddenError);
    const userId = createEntityId();
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic nonmember')", [userId, randomUUID(), `${userId}@example.invalid`]);
    const unchanged = await f.state(a);
    await expect(f.service.createApiClient({ ...current, userId }, f.input())).rejects.toBeInstanceOf(ForbiddenError);
    expect(await f.state(a)).toEqual(unchanged);
  });

  it("keeps birth scope and team ceilings through later grants and rejects removed permissions, inactive members, real expiry and the old tenant-only bootstrap", async () => {
    const a = await f.actor(baseRights), originalTeam = await f.team(a), current = await f.current(a);
    const input = f.input({ scopeLimits: { "inventory:read": "self" } }), value = await f.service.createApiClient(current, input), token = credential(value);
    const born = value.client.delegation;
    await f.setScopes(a, { ...baseRights, [Permission.InventoryRead]: "tenant", [Permission.ProductRead]: "tenant" });
    const extra = await f.team(a);
    expect(await f.loader.load(token)).toMatchObject({ permissions: ["inventory:read"], dataScope: "self", teamIds: [originalTeam.teamId] });
    expect((await f.loader.load(token))?.teamIds).not.toContain(extra.teamId);
    await f.teamActive(a, originalTeam.memberId, false);
    expect(await f.loader.load(token)).toMatchObject({ permissionScopes: { "inventory:read": "self" }, teamIds: [] });
    expect((await f.row(a, value.client.id))?.delegation).toEqual(born);
    await f.setScopes(a, { [Permission.IntegrationRead]: "tenant", [Permission.IntegrationManage]: "tenant" });
    expect(await f.loader.load(token)).toBeNull();
    const replay = await f.rebuild().createApiClient(await f.current(a), input);
    expect(replay.client.id).toBe(value.client.id); expect(replay.bearerToken === null).toBe(true);
    await f.memberStatus(a, "disabled");
    expect(await f.loader.load(token)).toBeNull();
    await expect(f.service.createApiClient(current, input)).rejects.toBeInstanceOf(ForbiddenError);
    await f.memberStatus(a, "active");
    const b = await f.actor(), expiresAt = new Date((await f.now()).getTime() + 1500).toISOString();
    const expiringInput = f.input({ expiresAt }), expiring = await f.service.createApiClient(b.context, expiringInput), expiringToken = credential(expiring);
    expect(await f.loader.load(expiringToken)).not.toBeNull(); await f.waitExpired(expiresAt);
    expect(await f.loader.load(expiringToken)).toBeNull();
    const expiredReplay = await f.rebuild().createApiClient(b.context, expiringInput);
    expect(expiredReplay.client).toMatchObject({ id: expiring.client.id, credentialState: "expired" });
    expect(expiredReplay.bearerToken === null).toBe(true);
    const live = await f.service.createApiClient(b.context, f.input({ scopeLimits: { "inventory:read": "self" } }));
    const liveToken = credential(live); expect(await f.loader.load(liveToken)).toMatchObject({ dataScope: "self" });
    const [oldBootstrap] = await withTenant(database.db, b.context, tx => tx.execute<{ count: number }>(sql`select count(*)::int as count
      from authenticate_integration_api_client(${live.client.id}::uuid,${agentDelegationSha(liveToken)})`));
    expect(oldBootstrap?.count).toBe(0);
    expect(await f.loader.load(`${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`)).toBeNull();
  });

  it("isolates client metadata and management by real self and team owners, tenant authority and forced cross-tenant RLS", async () => {
    const ownRights = { ...baseRights, [Permission.IntegrationRead]: "team", [Permission.IntegrationManage]: "team" } as const;
    const a = await f.actor(ownRights), b = await f.actor(ownRights, a.tenantId), admin = await f.actor(undefined, a.tenantId), foreign = await f.actor();
    const team = await f.team(a);
    await withTenant(database.db, b.context, tx => tx.insert(organizationTeamMembers).values({ id: createEntityId(), tenantId: b.tenantId,
      teamId: team.teamId, membershipId: b.membershipId, createdBy: b.userId }));
    const own = await f.service.createApiClient(await f.current(a), f.input()), other = await f.service.createApiClient(await f.current(b), f.input()),
      outside = await f.service.createApiClient(foreign.context, f.input());
    expect((await f.service.workspace(await f.current(a))).apiClients.map(row => row.id)).toEqual([own.client.id]);
    const self = { ...await f.current(a), permissionScopes: { ...a.context.permissionScopes, [Permission.IntegrationRead]: "self" as const } };
    expect((await f.service.workspace(self)).apiClients.map(row => row.id)).toEqual([own.client.id]);
    expect(new Set((await f.service.workspace(admin.context)).apiClients.map(row => row.id))).toEqual(new Set([own.client.id, other.client.id]));
    expect((await f.service.workspace(foreign.context)).apiClients.map(row => row.id)).toEqual([outside.client.id]);
    const before = await f.state(a), command = { expectedStatus: "active" as const, reasonCode: "SYNTHETIC_SCOPE_CHECK", idempotencyKey: randomUUID() };
    await expect(f.service.revokeApiClient(await f.current(a), other.client.id, command)).rejects.toBeInstanceOf(NotFoundException);
    await expect(f.service.revokeApiClient(admin.context, outside.client.id, command)).rejects.toBeInstanceOf(NotFoundException);
    expect(await f.state(a)).toEqual(before);
    expect((await withTenant(database.db, a.context, tx => tx.select().from(integrationApiClients).where(eq(integrationApiClients.id, outside.client.id))))).toEqual([]);
    const revoked = RevokedIntegrationApiClientViewSchema.parse(await f.service.revokeApiClient(admin.context, other.client.id, command));
    expect(revoked.client).toMatchObject({ id: other.client.id, status: "revoked", credentialState: "revoked" });
  });

  it("serializes same-key real births and restores only the original actor and canonical body without reissuing a secret or repeating events and audits", async () => {
    const a = await f.actor(), b = await f.actor(undefined, a.tenantId), input = f.input(), before = await f.state(a);
    const created = await Promise.all([f.service.createApiClient(a.context, input), f.rebuild().createApiClient(a.context, input), f.service.createApiClient(a.context, input)]);
    expect(new Set(created.map(row => row.client.id)).size).toBe(1); expect(created.filter(row => row.bearerToken !== null).length).toBe(1);
    const id = created[0]!.client.id, after = await f.state(a);
    expect(after).toMatchObject({ clients: before.clients + 1, events: before.events + 1, audits: before.audits + 1 });
    const replay = await f.rebuild().createApiClient(a.context, { ...input, label: ` ${input.label} ` });
    expect(replay.client.id).toBe(id); expect(replay.bearerToken === null).toBe(true);
    await expect(f.service.createApiClient(a.context, { ...input, label: "Changed original body" })).rejects.toThrow("integration_client_request_conflict");
    await expect(f.service.createApiClient(b.context, input)).rejects.toThrow("integration_client_request_conflict");
    expect(await f.state(a)).toEqual(after);
    const [proof] = await withTenant(database.db, a.context, tx => tx.execute<{ client: string; event: string; audit: string; auditCount: number }>(sql`select
      c.creation_transaction_id as client,e.creation_transaction_id as event,a.xmin::text as audit,
      (select count(*)::int from audit_events where entity_id=c.id and action='integration.api_client.create') as "auditCount"
      from integration_api_clients c join integration_api_client_events e on e.client_id=c.id and e.action='created'
      join audit_events a on a.entity_id=c.id and a.action='integration.api_client.create' where c.id=${id}::uuid`));
    expect(proof?.client).toMatch(/^\d+$/); expect(proof?.event).toBe(proof?.client);
    expect(proof?.audit).toBe(String(BigInt(proof!.client) % 4_294_967_296n)); expect(proof?.auditCount).toBe(1);
    expect(f.enqueued()).toBe(0);
  });

  it("rolls back credential and revocation audit failures atomically and keeps precise revoke replays immutable", async () => {
    const a = await f.actor(), before = await f.state(a);
    const failCreate = vi.spyOn(f.audit, "recordInTransaction").mockRejectedValueOnce(new Error("Synthetic creation audit failure"));
    try { await expect(f.service.createApiClient(a.context, f.input())).rejects.toThrow("Synthetic creation audit failure"); }
    finally { failCreate.mockRestore(); }
    expect(await f.state(a)).toEqual(before);
    const value = await f.service.createApiClient(a.context, f.input()), token = credential(value), active = await f.state(a);
    const command = { expectedStatus: "active" as const, reasonCode: "SYNTHETIC_REVOKE", idempotencyKey: randomUUID() };
    const failRevoke = vi.spyOn(f.audit, "recordInTransaction").mockRejectedValueOnce(new Error("Synthetic revoke audit failure"));
    try { await expect(f.service.revokeApiClient(a.context, value.client.id, command)).rejects.toThrow("Synthetic revoke audit failure"); }
    finally { failRevoke.mockRestore(); }
    expect(await f.state(a)).toEqual(active); expect(await f.loader.load(token)).not.toBeNull();
    const revoked = await f.service.revokeApiClient(a.context, value.client.id, command), finished = await f.state(a);
    expect(revoked.client.status).toBe("revoked"); expect(await f.loader.load(token)).toBeNull();
    expect(await f.rebuild().revokeApiClient(a.context, value.client.id, command)).toEqual(revoked);
    await expect(f.service.revokeApiClient(a.context, value.client.id, { ...command, reasonCode: "SYNTHETIC_CHANGED" })).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state(a)).toEqual(finished);
    expect(finished).toMatchObject({ clients: active.clients, events: active.events + 1, audits: active.audits + 1 });
  });

  it("enforces actual HTTP tenant-only owner admission and rechecks keys, members, scopes, expiry and team generation after real owner reads", async () => {
    const inventory = new InventoryService(database, f.audit), keys = await generateKeyPair("RS256"), reflector = new Reflector();
    const issuer = "https://synthetic-delegation.invalid", audience = "synthetic-delegation-api";
    const verifier = new OidcJwtStrategy({ issuer, audience, verificationKey: keys.publicKey });
    @Module({ controllers: [InventoryController, IntegrationAgentCapabilityController, UnverifiedRoutes], providers: [
      { provide: InventoryService, useValue: inventory }, { provide: DATABASE_CONNECTION, useValue: database },
    ] })
    class HttpFixtureModule {}
    let app: INestApplication | undefined;
    const pendingRequests: Array<Promise<Response>> = [];
    const original = inventory.workspace.bind(inventory);
    let gate: { reached: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
    const read = vi.spyOn(inventory, "workspace").mockImplementation(async context => {
      const value = await original(context), active = gate;
      if (active) { active.reached.resolve(); await within(active.release.promise, "Owner read gate release missing"); }
      return value;
    });
    try {
      app = await NestFactory.create(HttpFixtureModule, { logger: false });
      app.useGlobalGuards(new TenantContextGuard(verifier, new DatabaseMembershipContextLoader(database), f.loader, reflector),
        new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
      app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(f.loader));
      await app.listen(0, "127.0.0.1"); const origin = await app.getUrl();
      const request = (token: string, path: string, method = "GET") => fetch(origin + path, { method,
        headers: { authorization: `Bearer ${token}`, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}), signal: AbortSignal.timeout(15_000) });
      const a = await f.actor(), narrow = await f.service.createApiClient(a.context, f.input({ scopeLimits: { "inventory:read": "self" } }));
      const narrowToken = credential(narrow), count = read.mock.calls.length;
      expect((await request(narrowToken, "/v1/inventory/workspace")).status).toBe(403); expect(read).toHaveBeenCalledTimes(count);
      const teamOnly = await f.service.createApiClient(a.context, f.input({ scopeLimits: { "inventory:read": "team" } }));
      expect((await request(credential(teamOnly), "/v1/inventory/workspace")).status).toBe(403);
      const mixed = await f.service.createApiClient(a.context, f.input({ scopes: ["inventory:read", "finance:read"],
        scopeLimits: { "inventory:read": "self", "finance:read": "tenant" } }));
      expect((await request(credential(mixed), "/v1/inventory/workspace")).status).toBe(403);
      const metadata = await request(narrowToken, "/v1/integrations/agent-capabilities"); expect(metadata.status).toBe(200);
      expect(IntegrationAgentCatalogSchema.parse(await metadata.json()).mcpState).toBe("not_connected");
      const tenant = await f.service.createApiClient(a.context, f.input()), tenantToken = credential(tenant);
      expect((await request(tenantToken, "/v1/inventory/workspace")).status).toBe(200);
      expect((await request(tenantToken, "/delegation-qa/undecorated")).status).toBe(403);
      expect((await request(tenantToken, "/delegation-qa/read-shaped-post", "POST")).status).toBe(403);
      expect(forbiddenHandlerCalls).toBe(0);
      for (const change of ["scope", "permission", "membership", "key", "expiry", "team-generation"] as const) {
        const actor = await f.actor(), team = await f.team(actor), current = await f.current(actor), marker = `Synthetic owner body ${createEntityId()}`;
        await inventory.createWarehouse(current, { code: `QA-${randomUUID().slice(0, 8)}`.toUpperCase(), name: marker, type: "owned", countryCode: "US", timeZone: "UTC" });
        const expiresAt = change === "expiry" ? new Date((await f.now()).getTime() + 2500).toISOString() : null;
        const created = await f.service.createApiClient(current, f.input({ expiresAt })), token = credential(created);
        const control = await request(token, "/v1/inventory/workspace"); expect(control.status).toBe(200);
        expect(JSON.stringify(await control.json())).toContain(marker);
        const active = { reached: deferred(), release: deferred() }; gate = active;
        const pending = request(token, "/v1/inventory/workspace");
        pendingRequests.push(pending); void pending.catch(() => undefined);
        try {
          await within(active.reached.promise, `Actual owner read not reached for ${change}`);
          if (change === "scope") await f.setScopes(actor, { ...f.defaults, [Permission.InventoryRead]: "self" });
          else if (change === "permission") { const narrowed = { ...f.defaults }; delete narrowed[Permission.InventoryRead]; await f.setScopes(actor, narrowed); }
          else if (change === "membership") await f.memberStatus(actor, "disabled");
          else if (change === "key") await f.service.revokeApiClient(current, created.client.id, { expectedStatus: "active", reasonCode: "SYNTHETIC_LATE_REVOKE", idempotencyKey: randomUUID() });
          else if (change === "expiry") await f.waitExpired(expiresAt!);
          else await withTenant(database.db, actor.context, tx => tx.update(organizationTeams)
            .set({ accessGeneration: sql`${organizationTeams.accessGeneration}+1` }).where(eq(organizationTeams.id, team.teamId)));
        } finally { gate = undefined; active.release.resolve(); }
        const response = await pending; expect(response.status).toBe(401);
        const body = await response.json(); expect(body.message).toBe("API client authority changed during this request");
        expect(JSON.stringify(body)).not.toContain(marker);
      }
      const human = await f.actor({ [Permission.InventoryRead]: "self" });
      const signed = await new SignJWT({ tenant_id: human.tenantId }).setProtectedHeader({ alg: "RS256" }).setSubject(human.subject).setAudience(audience).setIssuer(issuer).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
      expect((await request(signed, "/v1/inventory/workspace")).status).toBe(200);
    } finally { gate?.release.resolve(); await Promise.allSettled(pendingRequests); read.mockRestore(); if (app) await app.close(); }
  });

  it("requires native current-member birth, immutable delegation, original transaction events and audits even after an early constraint flush", async () => {
    const a = await f.actor(baseRights), other = await f.actor(undefined, a.tenantId), source = await f.service.createApiClient(a.context, f.input());
    const sourceRow = (await f.row(a, source.client.id))!;
    async function rawBirth(tx: TenantTransaction, patch: { membershipId?: string; scope?: "self" | "tenant"; omitEvent?: boolean; omitAudit?: boolean } = {}) {
      const id = createEntityId(), input = f.input({ scopeLimits: { "inventory:read": patch.scope ?? "self" }, teamIds: [] });
      const [clock] = await tx.execute<{ now: string }>(sql`select clock_timestamp()::text as now`);
      const checksum = agentDelegationSha(integrationApiClientRequestCanonical(input));
      await tx.insert(integrationApiClients).values({ id, tenantId: a.tenantId, createdBy: a.userId, label: input.label, keyPrefix: `yai_${id}`,
        secretDigest: sourceRow.secretDigest, scopes: input.scopes, expiresAt: null, idempotencyKey: input.idempotencyKey, delegationRequest: input,
        delegation: { ...sourceRow.delegation!, membershipId: patch.membershipId ?? a.membershipId,
          permissionScopes: { "inventory:read": patch.scope ?? "self" }, teamIds: [], requestChecksum: checksum, capturedAt: new Date(clock!.now).toISOString() } });
      if (!patch.omitEvent) await tx.insert(integrationApiClientEvents).values({ id: createEntityId(), tenantId: a.tenantId, clientId: id,
        action: "created", actorUserId: a.userId, reasonCode: "CLIENT_CREATED", idempotencyKey: input.idempotencyKey });
      if (!patch.omitAudit) await f.audit.recordInTransaction(tx, a.context, { action: "integration.api_client.create", resourceType: "integration_api_client",
        resourceId: id, result: "success", metadata: { requestChecksum: checksum } });
      return id;
    }
    const control = await withTenant(database.db, a.context, async tx => { const id = await rawBirth(tx); await tx.execute(sql`set constraints all immediate`); return id; });
    expect(await f.row(a, control)).toMatchObject({ createdBy: a.userId, delegation: { membershipId: a.membershipId } });
    const before = await f.state(a);
    for (const patch of [{ omitEvent: true }, { omitAudit: true }, { membershipId: other.membershipId }, { scope: "tenant" as const }]) {
      await pgReject(withTenant(database.db, a.context, async tx => { await rawBirth(tx, patch); await tx.execute(sql`set constraints all immediate`); }));
      expect(await f.state(a)).toEqual(before);
    }
    const changes: SQL[] = [sql`update integration_api_clients set secret_digest=${"f".repeat(64)} where id=${control}::uuid`,
      sql`update integration_api_clients set created_by=${other.userId}::uuid where id=${control}::uuid`,
      sql`update integration_api_clients set expires_at=clock_timestamp()+interval '1 day' where id=${control}::uuid`,
      sql`update integration_api_clients set delegation=jsonb_set(delegation,'{permissionScopes,inventory:read}','"tenant"') where id=${control}::uuid`,
      sql`update integration_api_clients set creation_transaction_id='1' where id=${control}::uuid`];
    for (const change of changes) { await pgReject(withTenant(database.db, a.context, tx => tx.execute(change))); expect(await f.state(a)).toEqual(before); }
    await pgReject(withTenant(database.db, a.context, async tx => {
      const id = await rawBirth(tx); await tx.execute(sql`set constraints all immediate`);
      await tx.update(integrationApiClients).set({ status: "revoked", revokedAt: new Date() }).where(eq(integrationApiClients.id, id));
    }));
    await pgReject(withTenant(database.db, a.context, tx => tx.insert(integrationApiClientEvents).values({ id: createEntityId(), tenantId: a.tenantId,
      clientId: control, action: "created", actorUserId: a.userId, reasonCode: "CLIENT_CREATED", idempotencyKey: randomUUID() })));
    expect(await f.state(a)).toEqual(before);
    await f.memberStatus(a, "disabled");
    try { await pgReject(withTenant(database.db, a.context, async tx => { await rawBirth(tx); })); }
    finally { await f.memberStatus(a, "active"); }
    expect(await f.state(a)).toEqual(before);
  });

  it("returns an authority-bound complete ERP capability catalog as non-callable metadata without creating tools, credentials or business work", async () => {
    const a = await f.actor({ [Permission.IntegrationRead]: "self", [Permission.InventoryRead]: "self" }), before = await f.state(a);
    const value = IntegrationWorkspaceViewSchema.parse(await f.service.workspace(a.context));
    expect(value.clientAdmission).toEqual({ canManage: false, scopes: [{ scope: "inventory:read", maximumScope: "self" }], teamIds: [] });
    expect(value.agentCatalog).toEqual(IntegrationAgentCatalogSchema.parse(value.agentCatalog));
    expect(value.agentCatalog.contextAuthority).toBe(value.contextAuthority);
    expect(value.agentCatalog.mcpState).toBe("not_connected");
    expect(value.agentCatalog.capabilities).toHaveLength(24);
    expect(new Set(value.agentCatalog.capabilities.map(row => row.key)).size).toBe(24);
    expect(new Set(value.agentCatalog.capabilities.map(row => row.domain)).size).toBe(11);
    expect(value.agentCatalog.capabilities.every(row => row.callableViaAgent === false)).toBe(true);
    expect(value.agentCatalog.capabilities.find(row => row.key === "inventory.stock.read")?.agentState).toBe("adapter_pending");
    expect(value.agentCatalog.capabilities.find(row => row.key === "manufacturing.production.execute")?.agentState).toBe("unauthorized");
    const direct = await new IntegrationAgentCapabilityController(database).catalog({ headers: {}, tenantContext: a.context, authenticationKind: "oidc" });
    expect(direct).toEqual(value.agentCatalog);
    const stamp = JSON.parse(erpSessionAuthority(a.context));
    expect(JSON.parse(value.contextAuthority)).toMatchObject({ tenantId: stamp.tenantId, userId: stamp.userId });
    expect(JSON.stringify(value)).not.toMatch(/secret_digest|encryptedSigningSecret|bearerToken|postgres:/);
    expect(await f.state(a)).toEqual(before); expect(f.enqueued()).toBe(0);
  });
});
