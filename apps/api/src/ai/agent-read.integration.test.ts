import { randomUUID } from "node:crypto";
import { Module, ConflictException, ForbiddenException, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { erpPermissionContext, ForbiddenError, Permission } from "@yummyai/authz";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AgentBalancePageViewSchema, AgentExceptionPageViewSchema, AgentReadWorkspaceSchema, type AgentReadToolKey } from "@yummyai/contracts/ai/agent-read";
import { stockQuantityString } from "@yummyai/contracts/inventory/quantity";
import { connectDatabase } from "@yummyai/database";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { agentReadFixture, allAgentPermissions, bounded, deferred, requireAgentReadEnvironment } from "./agent-read.test-fixture.js";
import { AgentReadController } from "./agent-read.controller.js";
import { AgentReadService } from "./agent-read.service.js";
import { AssistController } from "./assist.controller.js";
import { AssistService } from "./assist.service.js";
import { DatabaseMembershipContextLoader, TenantContextGuard } from "../auth/tenant-context.guard.js";
import type { TokenVerifier } from "../auth/oidc-jwt.strategy.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { IdentitySessionController } from "../auth/identity-session.controller.js";

const database = connectDatabase(requireAgentReadEnvironment());
const f = agentReadFixture(database);
const allScopes = () => Object.fromEntries(allAgentPermissions.map(bit => [bit, "tenant" as const]));

describe.sequential("Agent read tools through the original business owners", () => {
  beforeAll(() => f.initialize());
  afterAll(async () => { f.close(); await database.client.end(); });
  async function call(tool: AgentReadToolKey, input: unknown, actor = f.a, service = f.gateway()) {
    const workspace = AgentReadWorkspaceSchema.parse(await service.workspace(actor.context));
    return service.call(actor.context, { version: workspace.version, executionContract: workspace.executionContract, tool, input });
  }

  it("reads every one of 501 actual owner balances with exact units and no business, queue or model writes", async () => {
    const source = await f.stock(f.a, 501), service = f.gateway(), before = await f.state();
    const expected = (await f.inventory.listBalances(f.a.context)).filter(row => row.stockItemId === source.stockItemId);
    const seen = [], fingerprints = new Set<string>(); let cursor: string | null = null;
    do {
      const page = AgentBalancePageViewSchema.parse(await call("inventory.balances.page", { stockItemId: source.stockItemId, pageSize: 100, cursor }, f.a, service));
      seen.push(...page.items); fingerprints.add(page.collectionFingerprint);
      expect(page.total).toBe(501); expect(page.readCount).toBe(seen.length);
      expect(page.complete).toBe(page.nextCursor === null); cursor = page.nextCursor;
    } while (cursor);
    expect(fingerprints.size).toBe(1); expect(seen).toHaveLength(501);
    expect(new Set(seen.map(row => row.dimensionKey)).size).toBe(501);
    expect(seen.map(row => row.locationId).sort()).toEqual(expected.map(row => row.locationId).sort());
    const first = seen.find(row => row.locationId === source.locations[0])!;
    expect(first.unit).toBe("meter"); expect(stockQuantityString(first.physicalQuantity)).toBe("1.000000001");
    expect(stockQuantityString(first.reservedQuantity)).toBe("0.000000001"); expect(stockQuantityString(first.availableQuantity)).toBe("1");
    expect(await f.state()).toEqual(before);
  });

  it("reads original exception metadata without PII permission, messages, resolution text or implicit handling", async () => {
    const parent = await f.order(), opened = await f.exception(parent.id);
    const reader = await f.actor(f.a.tenantId, { [Permission.OrderRead]: "tenant" });
    const before = await f.state();
    const page = AgentExceptionPageViewSchema.parse(await call("orders.exceptions.page", { orderId: parent.id, pageSize: 1 }, reader));
    expect(page.total).toBe(1); expect(page.complete).toBe(true);
    expect(page.items[0]).toMatchObject({ id: opened.id, orderId: parent.id, status: "open", sequence: 1, eventMissing: false });
    expect(Object.keys(page.items[0]!).sort()).toEqual(["id", "orderId", "category", "status", "eventMissing", "eventId", "sequence", "orderSequence", "openedAt", "resolvedAt", "sourceChecksum"].sort());
    expect(JSON.stringify(page)).not.toContain("Synthetic private issue"); expect(JSON.stringify(page)).not.toContain("SYNTHETIC_PRIVATE_CODE");
    const foreign = AgentExceptionPageViewSchema.parse(await call("orders.exceptions.page", { orderId: parent.id }, f.foreign));
    expect(foreign.items).toEqual([]); expect(foreign.total).toBe(0);
    expect(await f.state()).toEqual(before);
  });

  it("binds encrypted cursors to actor, tenant, tool, filter, page size and the complete changing source", async () => {
    const source = await f.stock(), first = AgentBalancePageViewSchema.parse(await call("inventory.balances.page", { stockItemId: source.stockItemId, pageSize: 1 }));
    expect(first.complete).toBe(false); expect(typeof first.nextCursor).toBe("string");
    const cursor = first.nextCursor!;
    const before = await f.state();
    for (const [actor, tool, input] of [
      [f.second, "inventory.balances.page", { stockItemId: source.stockItemId, pageSize: 1, cursor }],
      [f.foreign, "inventory.balances.page", { stockItemId: source.stockItemId, pageSize: 1, cursor }],
      [f.a, "orders.exceptions.page", { pageSize: 1, cursor }],
      [f.a, "inventory.balances.page", { locationId: source.locations[0], pageSize: 1, cursor }],
      [f.a, "inventory.balances.page", { stockItemId: source.stockItemId, pageSize: 2, cursor }],
      [f.a, "inventory.balances.page", { stockItemId: source.stockItemId, pageSize: 1, cursor: "synthetic-invalid-envelope" }],
    ] as const) await expect(call(tool, input, actor)).rejects.toBeInstanceOf(ConflictException);
    expect(await f.state()).toEqual(before);
    await f.inventory.recordMovement(f.a.context, { stockItemId: source.stockItemId, locationId: source.locations[2]!, lotId: null, bucket: "physical", type: "adjustment",
      quantityDelta: "0.000000001", unit: "meter", sourceType: "manual", sourceId: randomUUID(), reasonCode: "SYNTHETIC_RECOUNT", occurredAt: new Date().toISOString(), idempotencyKey: randomUUID() });
    const changed = await f.state();
    await expect(call("inventory.balances.page", { stockItemId: source.stockItemId, pageSize: 1, cursor })).rejects.toMatchObject({ response: { code: "agent_collection_changed" } });
    const restarted = AgentBalancePageViewSchema.parse(await call("inventory.balances.page", { stockItemId: source.stockItemId, pageSize: 1 }));
    expect(restarted.readCount).toBe(1); expect(restarted.collectionFingerprint).not.toBe(first.collectionFingerprint);
    expect(await f.state()).toEqual(changed);
  });

  it("uses current per-bit tenant authority and the caller ceiling without borrowing broad unrelated permissions", async () => {
    const actor = await f.actor(), service = f.gateway();
    for (const bit of [Permission.InventoryRead, Permission.OrderRead]) {
      for (const scope of ["self", "team"] as const) {
        await f.scopes(actor, { [bit]: scope, [Permission.FinanceRead]: "tenant" });
        const tool = bit === Permission.InventoryRead ? "inventory.balances.page" : "orders.exceptions.page";
        const workspace = await service.workspace(actor.context);
        expect(workspace.tools.find(value => value.key === tool)?.available).toBe(false);
        await expect(call(tool, {}, actor, service)).rejects.toBeInstanceOf(ForbiddenException);
      }
    }
    await f.scopes(actor, allScopes());
    const ceiling = { ...actor, context: { ...actor.context, permissionScopes: { ...actor.context.permissionScopes, [Permission.InventoryRead]: "self" as const } } };
    await expect(call("inventory.balances.page", {}, ceiling, service)).rejects.toBeInstanceOf(ForbiddenException);
    await f.memberActive(actor, false);
    await expect(service.workspace(actor.context)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects late real owner results after a domain downgrade or a current authority change", async () => {
    const service = f.gateway();
    for (const phase of ["scope", "authority"] as const) {
      const actor = await f.actor(f.a.tenantId), reached = deferred(), release = deferred();
      const original = f.inventory.agentBalancePage.bind(f.inventory);
      const hold = vi.spyOn(f.inventory, "agentBalancePage").mockImplementationOnce(async (...args) => {
        const value = await original(...args); reached.resolve(); await bounded(release.promise, "Read result release gate missing"); return value;
      });
      const pending = call("inventory.balances.page", {}, actor, service); void pending.catch(() => {});
      try {
        await bounded(reached.promise, "Actual inventory owner did not return");
        await f.scopes(actor, phase === "scope" ? { ...allScopes(), [Permission.InventoryRead]: "self" } :
          Object.fromEntries(allAgentPermissions.filter(bit => bit !== Permission.NotificationRead).map(bit => [bit, "tenant"])));
        const afterChange = await f.state(); release.resolve();
        if (phase === "scope") await expect(pending).rejects.toBeInstanceOf(ForbiddenException);
        else await expect(pending).rejects.toMatchObject({ response: { code: "authority_changed" } });
        expect(await f.state()).toEqual(afterChange);
      } finally { release.resolve(); await pending.catch(() => {}); hold.mockRestore(); }
    }
  });

  it("admits only the two actual named HTTP read tools for delegated clients and never opens a paid POST", async () => {
    const reflector = new Reflector(), gateway = f.gateway(); let app: INestApplication | undefined;
    @Module({ controllers: [AgentReadController, AssistController], providers: [
      { provide: AgentReadService, useValue: gateway }, { provide: AssistService, useValue: f.assists },
    ] })
    class HttpFixtureModule {}
    try {
      app = await NestFactory.create(HttpFixtureModule, { logger: false });
      const verifier: TokenVerifier = { verify: async () => { throw new Error("This client-only test supplies no OIDC token"); } };
      app.useGlobalGuards(new TenantContextGuard(verifier, new DatabaseMembershipContextLoader(database), f.loader, reflector), new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
      app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(f.loader));
      await app.listen(0, "127.0.0.1"); const origin = await app.getUrl();
      const created = await f.integration.createApiClient(f.a.context, { label: "Synthetic named tool reader", scopes: ["inventory:read", "order:read"],
        expiresAt: null, idempotencyKey: randomUUID(), scopeLimits: { "inventory:read": "tenant", "order:read": "tenant" }, teamIds: [] });
      const token = created.bearerToken; if (!token) throw new Error("Synthetic credential missing");
      const request = (path: string, body?: unknown) => fetch(origin + path, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
      const workspaceResponse = await request("/v1/agent-reads/workspace"); expect(workspaceResponse.status).toBe(200);
      const workspace = AgentReadWorkspaceSchema.parse(await workspaceResponse.json()); expect(workspace.mcpState).toBe("not_connected");
      const before = await f.state();
      for (const tool of ["orders.exceptions.page", "inventory.balances.page"] as const) {
        const response = await request("/v1/agent-reads/call", { version: workspace.version, executionContract: workspace.executionContract, tool, input: {} });
        expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
        expect((await response.json() as { effect: string }).effect).toBe("read");
      }
      expect((await request("/v1/agent-reads/call", { version: workspace.version, executionContract: workspace.executionContract, tool: "inventory.recordMovement", input: {} })).status).toBe(403);
      expect((await request("/v1/ai-assists/runs", {})).status).toBe(403);
      expect(await f.state()).toEqual(before);
      const reached = deferred(), release = deferred(), original = f.inventory.agentBalancePage.bind(f.inventory);
      const hold = vi.spyOn(f.inventory, "agentBalancePage").mockImplementationOnce(async (...args) => {
        const value = await original(...args); reached.resolve(); await bounded(release.promise, "HTTP owner release gate missing"); return value;
      });
      const pending = request("/v1/agent-reads/call", { version: workspace.version, executionContract: workspace.executionContract, tool: "inventory.balances.page", input: {} });
      void pending.catch(() => {});
      try {
        await bounded(reached.promise, "Actual delegated inventory owner did not return");
        await f.integration.revokeApiClient(f.a.context, created.client.id, { expectedStatus: "active", idempotencyKey: randomUUID(), reasonCode: "SYNTHETIC_REVOKE" });
        const revoked = await f.state(); release.resolve();
        const response = await pending; expect(response.status).toBe(401);
        expect(await response.text()).not.toContain("physicalQuantity");
        expect(await f.state()).toEqual(revoked);
      } finally { release.resolve(); await pending.catch(() => {}); hold.mockRestore(); }
    } finally { await app?.close(); }
  });

  it("uses the ERP transport authority while retaining complete owner authority for mixed factory roles", async () => {
    const full = await f.current(f.a);
    expect(full.permissions).toContain(Permission.FactoryTaskRead);
    const expected = erpSessionAuthority(erpPermissionContext(full));
    expect(expected).not.toBe(erpSessionAuthority(full));
    const request = await f.knowledgeRequest(), original = await f.assists.create(full, request); await f.process(original.id);
    const before = await f.state(), service = f.gateway();
    const identity = await new IdentitySessionController(database).session({ headers: {}, tenantContext: full, authenticationKind: "oidc" }, {});
    expect(erpSessionAuthority(identity)).toBe(expected);
    expect((await service.workspace(full)).contextAuthority).toBe(expected);
    const owner = vi.spyOn(f.inventory, "agentBalancePage");
    try {
      const workspace = await service.workspace(full);
      const page = await service.call(full, { version: workspace.version, executionContract: workspace.executionContract, tool: "inventory.balances.page", input: { pageSize: 1 } });
      expect(page.contextAuthority).toBe(expected);
      expect(owner.mock.calls[0]?.[0].permissions).toContain(Permission.FactoryTaskRead);
      expect(owner.mock.calls[0]?.[0].permissions).toContain(Permission.FactoryTaskRespond);
    } finally { owner.mockRestore(); }
    const receipt = await f.assists.receipt(full, f.proof(request));
    expect(receipt.contextAuthority).toBe(expected); expect(receipt.run?.id).toBe(original.id);
    expect(await f.state()).toEqual(before);
  });
});
