import { randomUUID } from "node:crypto";
import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory, Reflector } from "@nestjs/core";
import { Permission, ForbiddenError, erpPermissionContext } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { erpSessionAuthority } from "@yummyai/contracts/auth/session";
import { AssistTargetPageViewSchema, type AssistTargetPageQuery } from "@yummyai/contracts/ai/task-target-page";
import { AssistTaskTargetsSchema } from "@yummyai/contracts/ai/task-workspace";
import { connectDatabase, readMigrationEvidence } from "@yummyai/database";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { assistTargetPageFixture, requireAgentEntryEnvironment } from "./assist-target-page.test-fixture.js";
import { allAgentPermissions, bounded, deferred } from "./agent-read.test-fixture.js";
import { AssistTargetPageService } from "./assist-target-page.service.js";
import { AssistTargetPageController } from "./assist-target-page.controller.js";
import { DatabaseMembershipContextLoader, TenantContextGuard } from "../auth/tenant-context.guard.js";
import { OidcJwtStrategy } from "../auth/oidc-jwt.strategy.js";
import { PermissionsGuard } from "../auth/permissions.guard.js";
import { ApiClientRouteGuard } from "../auth/api-client-route.guard.js";
import { ApiClientAuthorityInterceptor } from "../auth/api-client-authority.interceptor.js";
import { generateKeyPair, SignJWT } from "jose";

const database = connectDatabase(requireAgentEntryEnvironment()), f = assistTargetPageFixture(database);
const scopes = () => Object.fromEntries(allAgentPermissions.map(bit => [bit, "tenant" as const]));
const page = async (query: AssistTargetPageQuery, context = f.base.a.context) => AssistTargetPageViewSchema.parse(await f.gateway().page(context, query));
const query = (kind: AssistTargetPageQuery["kind"], q = "", pageSize = 40): AssistTargetPageQuery => ({ kind, q, pageSize });
const changed = { response: { code: "assist_target_collection_changed" }, status: 409 };

describe.sequential("Complete original Assist object pages", () => {
  beforeAll(async () => { expect((await readMigrationEvidence(database)).actualRows).toHaveLength(171); await f.initialize(); });
  afterAll(async () => { f.close(); await database.client.end(); });

  it("reads every one of 501 real order objects in stable unique order while preserving the original 40-item v1 ABI and zero paid effects", async () => {
    const source = await f.orderLines(501), before = await f.state();
    const seen: string[] = [], fingerprints = new Set<string>(); let cursor: string | null = null;
    do {
      const next = await page({ ...query("order_review", source.label, 100), ...(cursor ? { cursor } : {}) });
      expect(next.total).toBe(501); seen.push(...next.items.map(row => row.id)); fingerprints.add(next.collectionFingerprint);
      expect(next.readCount).toBe(seen.length); expect(next.complete).toBe(next.nextCursor === null);
      cursor = next.nextCursor;
    } while (cursor);
    expect(seen).toEqual(source.lines.map(row => row.id).sort().reverse());
    expect(new Set(seen).size).toBe(501); expect(fingerprints.size).toBe(1);
    const legacy = AssistTaskTargetsSchema.parse(await f.legacy.targets(f.base.a.context, { kind: "order_review", q: source.label }));
    expect(legacy).toMatchObject({ hasMore: true }); expect(legacy.items.map(row => row.id)).toEqual(seen.slice(0, 40));
    expect(await f.state()).toEqual(before);
  });

  it("uses real sources for all nine native kinds including composite stock targets, parsed templates and an explicitly empty knowledge selection", async () => {
    const order = await f.orderLines(1), canvas = await f.creative(), catalog = await f.catalog(), template = await f.template();
    const finance = await f.financeTarget(), afterSales = await f.afterSalesTarget(order.id), stock = await f.base.stock(f.base.a, 3);
    const before = await f.state();
    const cases = [
      ["order_review", order.label, order.lines[0]!.id], ["artwork_preflight", order.label, order.lines[0]!.id],
      ["creative", canvas.name, canvas.id], ["sku_package", catalog.name, catalog.listing.listing.id],
      ["template_config", template.label, template.id], ["business_review", "USD", finance.id],
      ["procurement_review", "Synthetic exact material", `${stock.stockItemId}:${stock.locations[0]}`],
      ["after_sales_review", "SYNTHETIC_TARGET", afterSales.case.id],
    ] as const;
    for (const [kind, q, id] of cases) {
      const result = await page(query(kind, q, 100)); expect(result.items.map(row => row.id)).toContain(id);
      expect(new Set(result.items.map(row => row.id)).size).toBe(result.items.length);
      expect(result.items.map(row => row.id)).toEqual(result.items.map(row => row.id).sort().reverse());
    }
    const procurement = await page(query("procurement_review", "Synthetic exact material", 100));
    for (const locationId of stock.locations) expect(procurement.items.filter(row => row.id === `${stock.stockItemId}:${locationId}`)).toHaveLength(1);
    const knowledge = await page(query("knowledge_answer"));
    expect(knowledge).toMatchObject({ items: [], total: 0, readCount: 0, complete: true, nextCursor: null });
    expect(JSON.stringify(await page(query("after_sales_review", "SYNTHETIC_TARGET")))).not.toContain("Synthetic private contact text");
    expect(await f.state()).toEqual(before);
  });

  it("rejects a changed collection and treats wildcard characters literally, with empty sets and full re-reads remaining honest", async () => {
    const label = `Synthetic literal ${createEntityId()}%_`;
    await f.orderLines(2, f.base.a, label); await f.orderLines(1, f.base.a, label.slice(0, -2) + "xx");
    const requested = query("order_review", label, 1), first = await page(requested);
    expect(first.total).toBe(2); expect(first.nextCursor).not.toBeNull();
    await f.orderLines(1, f.base.a, label);
    const before = await f.state();
    await expect(page({ ...requested, cursor: first.nextCursor! })).rejects.toMatchObject(changed);
    const restarted = await page({ ...requested, pageSize: 100 }); expect(restarted.total).toBe(3); expect(restarted.complete).toBe(true);
    const empty = await page(query("order_review", `No synthetic object ${createEntityId()}`));
    expect(empty).toMatchObject({ total: 0, readCount: 0, complete: true, nextCursor: null, items: [] });
    expect(await f.state()).toEqual(before);
  });

  it("binds opaque cursors to the original actor, tenant, query, page size and fixed non-sliding deadline", async () => {
    const source = await f.orderLines(4), requested = query("order_review", source.label, 1), first = await page(requested), cursor = first.nextCursor!;
    const before = await f.state();
    for (const [context, selected] of [
      [f.base.second.context, requested], [f.base.foreign.context, requested],
      [f.base.a.context, { ...requested, q: "other" }], [f.base.a.context, { ...requested, pageSize: 2 }],
      [f.base.a.context, { ...requested, kind: "artwork_preflight" }],
    ] as const) await expect(page({ ...selected, cursor }, context)).rejects.toMatchObject(changed);
    await expect(page({ ...requested, cursor: cursor.slice(0, -3) + "xxx" })).rejects.toMatchObject(changed);
    const next = await page({ ...requested, cursor }); expect(next.nextCursor).not.toBeNull();
    const payload = (token: string) => f.base.integrationVault.withSecret(token, raw => JSON.parse(raw) as { expiresAt: string });
    const original = await payload(cursor); expect((await payload(next.nextCursor!)).expiresAt).toBe(original.expiresAt);
    try {
      vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(Date.parse(original.expiresAt) + 1));
      await expect(page({ ...requested, cursor: next.nextCursor! })).rejects.toMatchObject(changed);
    } finally { vi.useRealTimers(); }
    expect(await f.state()).toEqual(before);
  });

  it("requires current per-bit tenant source authority and the caller ceiling rather than borrowing an unrelated global tenant grant", async () => {
    const source = await f.orderLines(1), before = await f.state();
    for (const bit of [Permission.OrderRead, Permission.OrderPiiRead]) {
      const actor = await f.base.actor(f.base.a.tenantId, { ...scopes(), [bit]: "self" });
      expect(actor.context.dataScope).toBe("tenant");
      for (const kind of ["order_review", "artwork_preflight", "after_sales_review"] as const)
        await expect(page(query(kind, source.label), actor.context)).rejects.toBeInstanceOf(ForbiddenError);
    }
    const ceiling: TenantContext = { ...f.base.a.context, permissionScopes: { ...f.base.a.context.permissionScopes, [Permission.OrderPiiRead]: "self" } };
    await expect(page(query("order_review", source.label), ceiling)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await page(query("order_review", source.label), f.base.foreign.context)).items).toEqual([]);
    const live = await f.base.actor(f.base.a.tenantId);
    await f.base.memberActive(live, false);
    await expect(page(query("order_review", source.label), live.context)).rejects.toThrow();
    expect(await f.state()).toEqual(before);
  });

  it("filters real catalog and template objects by each actual owner and asset bit, including empty teams and a different template parser actor", async () => {
    const label = `Synthetic scoped target ${createEntityId()}`;
    const ownCanvas = await f.creative(f.base.a, label + " A"), foreignCanvas = await f.creative(f.base.second, label + " B");
    const ownCatalog = await f.catalog(f.base.a, label + " A"), foreignCatalog = await f.catalog(f.base.second, label + " B");
    const owned = await f.template(f.base.a, f.base.second, label + " A"), parsed = await f.template(f.base.second, f.base.a, label + " B");
    const before = await f.state();
    try {
      const self = await f.base.scopes(f.base.a, { ...scopes(), [Permission.DesignRead]: "self", [Permission.AssetRead]: "self", [Permission.ProductRead]: "self", [Permission.ListingRead]: "self" });
      expect(self.teamIds ?? []).toEqual([]);
      expect((await page(query("creative", label), self)).items.map(row => row.id)).toEqual([ownCanvas.id]);
      expect((await page(query("sku_package", label), self)).items.map(row => row.id)).toEqual([ownCatalog.listing.listing.id]);
      expect((await page(query("template_config", label), self)).items.map(row => row.id)).toEqual([owned.id]);
      for (const [bit, kind, accepted, denied] of [
        [Permission.AssetRead, "template_config", owned.id, parsed.id],
        [Permission.ProductRead, "sku_package", ownCatalog.listing.listing.id, foreignCatalog.listing.listing.id],
      ] as const) {
        const mixed = await f.base.scopes(f.base.a, { ...scopes(), [bit]: "self" });
        const result = await page(query(kind, label), mixed); expect(result.items.map(row => row.id)).toContain(accepted); expect(result.items.map(row => row.id)).not.toContain(denied);
      }
      const team = await f.base.scopes(f.base.a, { ...scopes(), [Permission.DesignRead]: "team", [Permission.AssetRead]: "team" });
      expect((await page(query("template_config", label), team)).items.map(row => row.id)).toEqual([owned.id]);
      expect((await page(query("creative", label), team)).items.map(row => row.id)).not.toContain(foreignCanvas.id);
      expect(await f.state()).toEqual(before);
    } finally { await f.base.scopes(f.base.a, scopes()); }
  });

  it("fences an actual owner result after current source scope changes and honors an aborted owner read without side effects", async () => {
    const source = await f.orderLines(1), reached = deferred(), release = deferred(), original = f.owner.read.bind(f.owner);
    const spy = vi.spyOn(f.owner, "read").mockImplementationOnce(async (...args) => {
      const result = await original(...args); reached.resolve(); await bounded(release.promise, "Target owner release gate missing"); return result;
    });
    const pending = page(query("order_review", source.label)); void pending.catch(() => {});
    try {
      await bounded(reached.promise, "Actual target owner did not finish its authorized read");
      await f.base.scopes(f.base.a, { ...scopes(), [Permission.OrderPiiRead]: "self" });
      const before = await f.state(); release.resolve();
      await expect(pending).rejects.toMatchObject({ status: 409, response: { code: "authority_changed" } });
      expect(await f.state()).toEqual(before);
    } finally { release.resolve(); await pending.catch(() => {}); spy.mockRestore(); await f.base.scopes(f.base.a, scopes()); }
    const controller = new AbortController(); controller.abort();
    const before = await f.state(); await expect(f.owner.read(f.base.a.context, query("order_review"), null, controller.signal)).rejects.toThrow();
    expect(await f.state()).toEqual(before);
  });

  it("serves the exact personal HTTP page with ERP authority, bounded query validation and no delegated-client or paid-task admission", async () => {
    const source = await f.orderLines(1), reflector = new Reflector(); let app: INestApplication | undefined;
    @Module({ controllers: [AssistTargetPageController], providers: [{ provide: AssistTargetPageService, useValue: f.gateway() }] })
    class TargetHttpFixture {}
    const keys = await generateKeyPair("RS256"), issuer = "https://synthetic-agent-entry.invalid", audience = "synthetic-target-api";
    const jwt = await new SignJWT({ tenant_id: f.base.a.tenantId }).setProtectedHeader({ alg: "RS256" }).setIssuer(issuer).setAudience(audience)
      .setSubject(f.base.a.subject).setIssuedAt().setExpirationTime("5m").sign(keys.privateKey);
    try {
      app = await NestFactory.create(TargetHttpFixture, { logger: false });
      app.useGlobalGuards(new TenantContextGuard(new OidcJwtStrategy({ issuer, audience, verificationKey: keys.publicKey }), new DatabaseMembershipContextLoader(database), f.base.loader, reflector),
        new PermissionsGuard(reflector), new ApiClientRouteGuard(reflector));
      app.useGlobalInterceptors(new ApiClientAuthorityInterceptor(f.base.loader));
      await app.listen(0, "127.0.0.1"); const origin = await app.getUrl(), endpoint = origin + "/v1/ai-assists/task-target-pages";
      const before = await f.state();
      const read = (suffix: string, token = jwt) => fetch(endpoint + suffix, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
      const response = await read("?kind=order_review&q=" + encodeURIComponent(source.label) + "&pageSize=1");
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
      const result = AssistTargetPageViewSchema.parse(await response.json()); expect(result.items[0]?.id).toBe(source.lines[0]!.id);
      expect(result.contextAuthority).toBe(erpSessionAuthority(erpPermissionContext(await f.base.current(f.base.a))));
      for (const suffix of ["?kind=order_review&kind=creative", "?kind=order_review&pageSize=101", "?kind=order_review&sql=select"])
        expect((await read(suffix)).status).toBe(400);
      expect(await f.state()).toEqual(before);
      const created = await f.base.integration.createApiClient(f.base.a.context, { label: "Synthetic target metadata client", scopes: ["order:read"], expiresAt: null,
        idempotencyKey: randomUUID(), scopeLimits: { "order:read": "tenant" }, teamIds: [] });
      if (!created.bearerToken) throw new Error("Synthetic delegated client missing its one-time credential");
      const delegatedBefore = await f.state(); expect((await read("?kind=order_review", created.bearerToken)).status).toBe(403);
      expect(await f.state()).toEqual(delegatedBefore);
    } finally { await app?.close(); }
  });
});
