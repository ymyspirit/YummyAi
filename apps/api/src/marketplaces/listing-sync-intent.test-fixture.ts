import "reflect-metadata";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { Permission } from "@yummyai/authz";
import { CreateMarketplaceListingSyncInputSchema, TenantContextSchema, createEntityId, type TenantContext } from "@yummyai/contracts";
import { listingSyncIntentRequestText } from "@yummyai/contracts/marketplace/listing-sync-intent";
import { memberships, membershipRoles, roles, productPlans, spus, listings, listingVersions, marketplaceAccounts, marketplaceCapabilitySnapshots,
  marketplacePublicationRequests, marketplacePublicationEvents, marketplaceListingSyncRequests, marketplaceListingSyncEvents,
  marketplaceListingSyncIntents, loadCurrentMembershipContext, withTenant, type DatabaseConnection } from "@yummyai/database";
import { createQueue, QueueName } from "@yummyai/jobs";
import { createMarketplaceSecretVault } from "@yummyai/marketplace-connectors";
import { requireListingSyncIntentEnvironment } from "../../../../tools/testing/require-listing-sync-intent-environment.mjs";
import { startFactoryIdentityFixture } from "../../../../tools/testing/factory-identity-fixture.mjs";
import { DATABASE_CONNECTION, MARKETPLACE_LISTING_SYNC_ENQUEUER } from "../platform.tokens.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { DrizzleListingSyncExecutionRepository } from "../../../worker/src/processors/marketplace-listing-sync.processor.js";
import { DrizzleChannelMutationReconciliationWriter } from "../../../worker/src/processors/channel-inventory-reconciliation.repository.js";
import { MarketplaceListingSyncService, type MarketplaceListingSyncEnqueuer } from "./marketplace-listing-sync.service.js";

export const listingSyncIntentRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const listingSyncIntentLane = resolve(listingSyncIntentRoot, "tmp/listing-sync-intent-20261022-b7d3e8f2/qa");
export const intentSha = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const intentPermissions = [Permission.ListingRead, Permission.ListingPublish, Permission.ListingWrite, Permission.ListingReview, Permission.ProductRead, Permission.StoreRead];
export type IntentActor = { tenantId: string; userId: string; roleId: string; membershipId: string; subject: string; ceiling: TenantContext };
export type IntentSource = { id: string; planId: string; spuId: string; listingId: string; versionId: string; accountId: string; publicationId: string; secondPublicationId: string; title: string };
export function intentContent(title: string) {
  return { platform: "amazon" as const, locale: "en-US", title, description: "Synthetic original historical Listing", bullets: ["Synthetic fixture only"],
    tags: [], mediaAssetIds: [], variants: [{ skuId: createEntityId(), skuCode: "SYNTHETIC-INTENT-SKU", optionValues: {} }],
    attributes: {}, compliance: { countryOfOrigin: "CN" }, publication: { platform: "amazon" as const, productType: "HOME", attributes: {
      item_name: [{ value: title, marketplace_id: "ATVPDKIKX0DER" }], purchasable_offer: [{ currency: "USD", our_price: [{ schedule: [{ value_with_tax: 12.34 }] }] }],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }] } } };
}
/** Synthetic historical prerequisites are not evidence of platform publication.
 * Only the actual ListingSync owner creates its requests and locators below. */
export function listingSyncIntentFixture(database: DatabaseConnection, options: { actor?: Omit<IntentActor, "ceiling">; apiPort?: number; ready?: () => boolean } = {}) {
  requireListingSyncIntentEnvironment();
  const localListings = new ListingService(new DrizzleListingRepository(database)), owned: Array<{ source: IntentSource; actor: IntentActor }> = [];
  let a: IntentActor, peer: IntentActor, foreign: IntentActor, app: INestApplication | undefined, appDatabase: DatabaseConnection | undefined;
  let service: MarketplaceListingSyncService, identity: Awaited<ReturnType<typeof startFactoryIdentityFixture>> | undefined, origin = "", closed = false;
  let queue: ReturnType<typeof createQueue> | undefined, restoreEnqueue: (() => void) | undefined, restoreEnv: (() => void) | undefined, restoreFetch: (() => void) | undefined;
  const evidence = { enqueueCalls: [] as string[], queueFailures: 0, providerAttempts: 0, apiClosed: false, identityClosed: false, queueClosed: false, retainedSyntheticHistory: 0 };
  let failNext = false;
  async function actor(tenantId = createEntityId()): Promise<IntentActor> {
    const userId = createEntityId(), roleId = createEntityId(), membershipId = createEntityId(), subject = "synthetic-intent-" + userId;
    const ceiling: TenantContext = { tenantId, userId, permissions: [...intentPermissions], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic intent tenant',$2)on conflict(id)do nothing", [tenantId, "intent-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic intent member')", [userId, subject, userId + "@example.invalid"]);
    await withTenant(database.db, ceiling, async tx => {
      await tx.insert(memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId, name: "Synthetic intent " + roleId, permissions: [...intentPermissions], dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId });
    });
    return { tenantId, userId, roleId, membershipId, subject, ceiling };
  }
  async function current(who = a) { return TenantContextSchema.parse(await withTenant(database.db, who.ceiling,
    tx => loadCurrentMembershipContext(tx, { tenantId: who.tenantId, userId: who.userId }))); }
  async function rights(who = a, permissions: readonly string[] = intentPermissions, scope: "tenant" | "self" = "tenant") {
    await withTenant(database.db, who.ceiling, tx => tx.update(roles).set({ permissions: [...permissions], dataScope: scope }).where(eq(roles.id, who.roleId)));
  }
  async function initialize() {
    try {
      const [count] = await database.client.unsafe("select count(*)::int value from drizzle.__drizzle_migrations");
      if (count?.value !== 181) throw new Error("listing_sync_intent_fixture_requires_current181");
      await mkdir(listingSyncIntentLane, { recursive: true });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (raw, init) => {
        const hostname = new URL(raw instanceof Request ? raw.url : String(raw)).hostname;
        if (["api.amazon.com", "sellingpartnerapi-na.amazon.com", "sellingpartnerapi-eu.amazon.com", "sellingpartnerapi-fe.amazon.com", "api.etsy.com", "openapi.etsy.com"].includes(hostname)) {
          evidence.providerAttempts++; return Promise.reject(new Error("listing_sync_intent_platform_io_forbidden"));
        }
        return originalFetch(raw, init);
      };
      restoreFetch = () => { globalThis.fetch = originalFetch; };
      a = options.actor ? { ...options.actor, ceiling: { tenantId: options.actor.tenantId, userId: options.actor.userId, permissions: [...intentPermissions], dataScope: "tenant" } } : await actor();
      peer = await actor(a.tenantId); foreign = await actor();
      if (!options.actor) {
        identity = await startFactoryIdentityFixture(a.tenantId, a.subject, "http://localhost:3130", { application: "erp", clientId: "yummyai-web", accounts: {
          operator: { subject: a.subject, name: "Synthetic intent operator" }, peer: { subject: peer.subject, name: "Synthetic intent peer" },
          foreign: { subject: foreign.subject, name: "Synthetic foreign member", tenantId: foreign.tenantId } } });
        const values = { OIDC_ISSUER: identity.baseUrl, OIDC_AUDIENCE: "yummyai-api", OIDC_JWKS_URI: identity.baseUrl + "/protocol/openid-connect/certs" };
        const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]])); Object.assign(process.env, values);
        restoreEnv = () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
      }
      const { AppModule } = await import("../app.module.js"); app = await NestFactory.create(AppModule, { logger: false });
      appDatabase = app.get<DatabaseConnection>(DATABASE_CONNECTION); service = app.get(MarketplaceListingSyncService);
      const enqueuer = app.get<MarketplaceListingSyncEnqueuer>(MARKETPLACE_LISTING_SYNC_ENQUEUER), original = enqueuer.enqueue.bind(enqueuer);
      enqueuer.enqueue = async input => { evidence.enqueueCalls.push(input.syncRequestId); if (failNext) { failNext = false; evidence.queueFailures++; throw new Error("synthetic_enqueue_transport_failure"); } await original(input); };
      restoreEnqueue = () => { enqueuer.enqueue = original; };
      app.getHttpAdapter().get("/__listing_sync_intent_fixture_ready", (_request: unknown, response: { status(value: number): { json(value: object): void } }) => response.status(options.ready?.() === false ? 503 : 200).json({ ready: options.ready?.() ?? true }));
      await app.listen(options.apiPort ?? 0, "127.0.0.1"); origin = await app.getUrl(); queue = createQueue(QueueName.ListingSync);
    } catch (error) { try { await close(); } catch (cleanup) { throw new AggregateError([error, cleanup], "Intent fixture initialization failed"); } throw error; }
  }
  async function seed(who = a): Promise<IntentSource> {
    const id = createEntityId(), source: IntentSource = { id, planId: createEntityId(), spuId: createEntityId(), listingId: createEntityId(), versionId: createEntityId(),
      accountId: createEntityId(), publicationId: createEntityId(), secondPublicationId: createEntityId(), title: "Synthetic original intent " + id };
    const context = await current(who), content = intentContent(source.title), previewId = createEntityId(), capId = createEntityId();
    await withTenant(database.db, context, async tx => {
      await tx.insert(productPlans).values({ id: source.planId, tenantId: who.tenantId, name: source.title, status: "approved", customization: { version: 1, fields: [] }, createdBy: who.userId });
      await tx.insert(spus).values({ id: source.spuId, tenantId: who.tenantId, productPlanId: source.planId, code: "INTENT-" + id, name: source.title, status: "listing", customization: { version: 1, fields: [] } });
      await tx.insert(listings).values({ id: source.listingId, tenantId: who.tenantId, spuId: source.spuId, platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", status: "approved", createdBy: who.userId });
      await tx.insert(listingVersions).values({ id: source.versionId, tenantId: who.tenantId, listingId: source.listingId, versionNumber: 1, ruleVersion: "amazon-2026.07", status: "approved", source: "human", content,
        validation: { completeness: 100, blockers: [], warnings: [] }, createdBy: who.userId, approvedBy: who.userId, approvedAt: new Date() });
      await tx.update(listings).set({ primaryVersionId: source.versionId }).where(eq(listings.id, source.listingId));
      const [account] = await tx.insert(marketplaceAccounts).values({ id: source.accountId, tenantId: who.tenantId, platform: "amazon", displayName: source.title + " store", externalAccountId: "SYNTHETIC-SELLER-" + id,
        region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", status: "active", requestedScopes: ["product-listing"], grantedScopes: ["product-listing"],
        capabilities: ["listing_read", "listing_write", "inventory_write"], credentialStatus: "valid", healthStatus: "healthy", capabilityExpiresAt: new Date(Date.now() + 86_400_000), createdBy: who.userId }).returning();
      await tx.insert(marketplaceCapabilitySnapshots).values({ id: capId, tenantId: who.tenantId, accountId: source.accountId, version: 1, platform: "amazon", externalAccountId: account!.externalAccountId!, marketplaceIds: ["ATVPDKIKX0DER"],
        capabilities: ["listing_read", "listing_write", "inventory_write"], sourceVersion: "synthetic-historical-prerequisite", sourceChecksum: intentSha(id), data: {}, syncedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000),
        authorizationGeneration: account!.authorizationGeneration, createdBy: who.userId });
      const payload = { platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", sku: "SYNTHETIC-INTENT-SKU", attributes: content.publication.attributes };
      for (const [requestId, action, parentRequestId] of [[previewId, "amazon_validation_preview", null], [source.publicationId, "amazon_submit", previewId], [source.secondPublicationId, "amazon_submit", previewId]] as const)
        await tx.insert(marketplacePublicationRequests).values({ id: requestId, tenantId: who.tenantId, accountId: source.accountId, capabilitySnapshotId: capId, listingId: source.listingId, listingVersionId: source.versionId,
          platform: "amazon", marketplaceId: "ATVPDKIKX0DER", action, parentRequestId, idempotencyKey: intentSha(requestId), payload, payloadChecksum: intentSha(JSON.stringify(payload)), assetManifest: [], createdBy: who.userId });
      for (const requestId of [source.publicationId, source.secondPublicationId]) await tx.insert(marketplacePublicationEvents).values({ id: createEntityId(), tenantId: who.tenantId, requestId, sequence: 1,
        status: "published", externalListingId: "SYNTHETIC-INTENT-SKU", externalState: "SYNTHETIC-HISTORICAL-ONLY", actorUserId: who.userId });
    });
    owned.push({ source, actor: who }); return source;
  }
  function input(source: IntentSource, overrides: Partial<z.infer<typeof CreateMarketplaceListingSyncInputSchema>> = {}) {
    return CreateMarketplaceListingSyncInputSchema.parse({ accountId: source.accountId, listingId: source.listingId, listingVersionId: source.versionId,
      sourcePublicationRequestId: source.publicationId, action: "read_full_content", requestKey: createEntityId(), ...overrides });
  }
  function lookup(value: z.infer<typeof CreateMarketplaceListingSyncInputSchema>) {
    if (!value.requestKey) throw new Error("listing_sync_intent_fixture_key_required"); return { requestKey: value.requestKey, requestChecksum: intentSha(listingSyncIntentRequestText(value)) };
  }
  async function token(who = a) {
    if (!identity) throw new Error("listing_sync_intent_browser_uses_original_oidc");
    const account = who.userId === a.userId ? "operator" : who.userId === peer.userId ? "peer" : "foreign";
    const response = await fetch(identity.baseUrl + "/_fixture/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "x-fixture-control": identity.controlKey },
      body: new URLSearchParams({ account, client_id: "yummyai-web" }), signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error("listing_sync_intent_token_boundary_failed"); return z.object({ access_token: z.string().min(1) }).parse(await response.json()).access_token;
  }
  async function http(path: string, options: { method?: string; body?: unknown; actor?: IntentActor; accessToken?: string } = {}) {
    if (!/^\/v1\/marketplace-listing-syncs(?:\/[^?#]*)?(?:\?[^#]*)?$/.test(path)) throw new Error("listing_sync_intent_http_path_invalid");
    const response = await fetch(origin + path, { method: options.method ?? "GET", headers: { authorization: "Bearer " + (options.accessToken ?? await token(options.actor)), "content-type": "application/json" },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }), redirect: "error", signal: AbortSignal.timeout(20_000) });
    return { status: response.status, body: await response.json() as unknown };
  }
  async function rows(who = a) { return withTenant(database.db, who.ceiling, async tx => ({ requests: await tx.select().from(marketplaceListingSyncRequests),
    events: await tx.select().from(marketplaceListingSyncEvents), intents: await tx.select().from(marketplaceListingSyncIntents) })); }
  async function jobs(ids: readonly string[]) { if (!queue) throw new Error("listing_sync_intent_queue_not_ready");
    return (await Promise.all(ids.map(id => queue!.getJob(id)))).filter(value => value !== undefined).map(value => ({ id: value!.id, requestId: value!.data.payload.syncRequestId })); }
  async function offlineResult(id: string, who = a) {
    const repository = new DrizzleListingSyncExecutionRepository(database, createMarketplaceSecretVault(), new DrizzleChannelMutationReconciliationWriter());
    const context = await current(who), pinned = await repository.claim(context, id, 0); if (!pinned) throw new Error("listing_sync_intent_original_claim_missing");
    const snapshot = { externalState: "SYNTHETIC-HISTORICAL-ONLY", content: { title: "Synthetic offline observation" }, price: { amount: 12.34, currency: "USD" }, inventory: { quantity: 7 }, observedAt: new Date().toISOString() };
    await repository.complete(context, pinned, { issues: [], snapshot }); return snapshot;
  }
  async function business(who = a) { return withTenant(database.db, who.ceiling, async tx => (await tx.execute<{ paid: number; publications: number; syncs: number }>(sql`select
    (select count(*)::int from ai_budget_ledger) paid,(select count(*)::int from marketplace_publication_requests) publications,(select count(*)::int from marketplace_listing_sync_requests) syncs`))[0]!); }
  async function close() {
    if (closed) return; closed = true; const errors: unknown[] = [];
    for (const who of [a, peer, foreign].filter(Boolean)) try { await rights(who); } catch (error) { errors.push(error); }
    const ids = a ? (await rows()).requests.filter(row => owned.some(value => value.source.listingId === row.listingId)).map(row => row.id) : [];
    for (const id of ids) try { await (await queue?.getJob(id))?.remove(); } catch (error) { errors.push(error); }
    evidence.retainedSyntheticHistory = ids.length; restoreEnqueue?.();
    try { await queue?.close(); evidence.queueClosed = true; } catch (error) { errors.push(error); }
    try { await app?.close(); evidence.apiClosed = true; } catch (error) { errors.push(error); }
    try { if (appDatabase && appDatabase !== database) await appDatabase.client.end(); } catch (error) { errors.push(error); }
    try { await identity?.close(); evidence.identityClosed = true; } catch (error) { errors.push(error); } restoreEnv?.(); restoreFetch?.();
    if (errors.length) throw new AggregateError(errors, "listing_sync_intent_fixture_cleanup_failed");
  }
  return { initialize, close, current, rights, seed, input, lookup, token, http, rows, jobs, offlineResult, business, evidence, listings: localListings,
    failNextEnqueue: () => { failNext = true; }, get service() { return service; }, get a() { return a; }, get peer() { return peer; }, get foreign() { return foreign; } };
}
