import { createHash } from "node:crypto";
import { resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Database from "@yummyai/database";
import type * as Contracts from "@yummyai/contracts";
import type * as OriginalSync from "./marketplace-listing-sync.service.js";
import type * as OriginalQueue from "./redis-marketplace-listing-sync-enqueuer.js";
import type * as OriginalAudit from "../audit/audit.service.js";
import type * as OriginalInventory from "../channel-inventory/channel-inventory.service.js";
import type * as Drizzle from "drizzle-orm";
import { requireListingSyncIntentEnvironment } from "../../../../tools/testing/require-listing-sync-intent-environment.mjs";
import { assertListingSyncIntentOriginal180Graph } from "./listing-sync-intent-graph.test-fixture.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const send = (value: object) => new Promise<void>((done, fail) => { if (!process.send) return fail(new Error("listing_sync_intent_legacy_ipc_required")); process.send(value, error => error ? fail(error) : done()); });
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function diagnostic(error: unknown, phase: string) {
  const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
  const raw = error && typeof error === "object" && "code" in error ? error.code : cause && typeof cause === "object" && "code" in cause ? cause.code : null;
  const code = typeof raw === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)$/.test(raw) ? raw : null;
  let location: { file: string; line: number } | null = null;
  const stack = error instanceof Error ? error.stack ?? "" : "";
  for (const match of stack.matchAll(/(?:file:\/\/\/)?([A-Za-z]:[\\/][^\r\n()]+\.(?:[cm]?[jt]sx?)):(\d+):\d+/g)) {
    const file = relative(root, match[1]!).replaceAll("\\", "/"); if (!file.startsWith("..") && /^[A-Za-z0-9_./@+-]+$/.test(file)) { location = { file, line: Number(match[2]) }; break; }
  }
  const names = ["Error", "SyntaxError", "ReferenceError", "TypeError", "RangeError", "ZodError", "DrizzleQueryError", "DatabaseError", "ConflictException", "NotFoundException", "ServiceUnavailableException", "ForbiddenError"];
  const name = error && typeof error === "object" ? error.constructor?.name : undefined;
  return { type: "listing.sync.intent.failed180", phase, code, errorName: error instanceof Error && ["Error", "SyntaxError", "ReferenceError", "TypeError", "RangeError"].includes(error.name) ? error.name : "Other",
    constructorName: typeof name === "string" && names.includes(name) ? name : "Other", location };
}

/** All executable business imports below point inside the sealed genuine180 graph. */
async function original180() {
  let phase = "original180_entry", database: Database.DatabaseConnection | undefined, queue: InstanceType<typeof OriginalQueue.RedisMarketplaceListingSyncEnqueuer> | undefined;
  const close = async () => { try { await queue?.onModuleDestroy(); } finally { await database?.client.end(); } };
  try {
    const target = requireListingSyncIntentEnvironment(process.env, "pre-0181"), source = process.env.E2E_LISTING_SYNC_INTENT_LEGACY_SOURCE!;
    phase = "original180_graph"; await assertListingSyncIntentOriginal180Graph(source);
    const load = (path: string) => import(pathToFileURL(resolve(source, path)).href);
    const db = await load("packages/database/src/index.ts") as typeof Database;
    const contracts = await load("packages/contracts/src/index.ts") as typeof Contracts;
    const syncs = await load("apps/api/src/marketplaces/marketplace-listing-sync.service.ts") as typeof OriginalSync;
    const audits = await load("apps/api/src/audit/audit.service.ts") as typeof OriginalAudit;
    const queues = await load("apps/api/src/marketplaces/redis-marketplace-listing-sync-enqueuer.ts") as typeof OriginalQueue;
    const inventory = await load("apps/api/src/channel-inventory/channel-inventory.service.ts") as typeof OriginalInventory;
    phase = "original180_membership"; database = db.connectDatabase(target.url);
    const { sql } = await load("apps/api/node_modules/drizzle-orm/index.js") as typeof Drizzle;
    const tenantId = contracts.createEntityId(), userId = contracts.createEntityId(), roleId = contracts.createEntityId(), membershipId = contracts.createEntityId();
    const ceiling: Contracts.TenantContext = { tenantId, userId, permissions: ["listing:read", "listing:publish", "listing:write", "listing:review", "product:read", "store:read"], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic original180 Listing intent',$2)", [tenantId, "intent180-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic original180 member')", [userId, "intent180-" + userId, userId + "@example.invalid"]);
    await db.withTenant(database.db, ceiling, async tx => {
      await tx.insert(db.memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(db.roles).values({ id: roleId, tenantId, name: "Synthetic original180 " + roleId, permissions: [...ceiling.permissions], dataScope: "tenant" });
      await tx.insert(db.membershipRoles).values({ tenantId, membershipId, roleId });
    });
    const context = contracts.TenantContextSchema.parse(await db.withTenant(database.db, ceiling, tx => db.loadCurrentMembershipContext(tx, { tenantId, userId })));
    async function prerequisite() {
      const id = contracts.createEntityId(), planId = contracts.createEntityId(), spuId = contracts.createEntityId(), listingId = contracts.createEntityId(), versionId = contracts.createEntityId(), accountId = contracts.createEntityId(),
        capabilityId = contracts.createEntityId(), previewId = contracts.createEntityId(), publicationId = contracts.createEntityId();
      const attributes = { item_name: [{ value: "Synthetic original180 " + id, marketplace_id: "ATVPDKIKX0DER" }], purchasable_offer: [{ currency: "USD", our_price: [{ schedule: [{ value_with_tax: 12.34 }] }] }],
        fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }] };
      const content = { platform: "amazon" as const, locale: "en-US", title: "Synthetic historical original180 " + id, description: "Not a platform publication proof", bullets: [], tags: [], mediaAssetIds: [],
        variants: [{ skuId: contracts.createEntityId(), skuCode: "SYNTHETIC-LEGACY", optionValues: {} }], attributes: {}, compliance: {}, publication: { platform: "amazon" as const, productType: "HOME", attributes } };
      await db.withTenant(database!.db, context, async tx => {
        await tx.insert(db.productPlans).values({ id: planId, tenantId, name: "Synthetic historical plan", customization: { version: 1, fields: [] }, createdBy: userId });
        await tx.insert(db.spus).values({ id: spuId, tenantId, productPlanId: planId, code: "LEGACY-" + id, name: "Synthetic historical item", customization: { version: 1, fields: [] } });
        await tx.insert(db.listings).values({ id: listingId, tenantId, spuId, platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", status: "approved", createdBy: userId });
        await tx.insert(db.listingVersions).values({ id: versionId, tenantId, listingId, versionNumber: 1, ruleVersion: "amazon-2026.07", status: "approved", source: "human", content,
          validation: { completeness: 100, blockers: [], warnings: [] }, createdBy: userId, approvedBy: userId, approvedAt: new Date() });
        await tx.execute(sql`update listings set primary_version_id=${versionId} where id=${listingId}`);
        const [account] = await tx.insert(db.marketplaceAccounts).values({ id: accountId, tenantId, platform: "amazon", displayName: "Synthetic legacy store " + id, externalAccountId: "SYNTHETIC-LEGACY-" + id, region: "NA",
          marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", status: "active", credentialStatus: "valid", healthStatus: "healthy", capabilities: ["listing_read", "listing_write"], createdBy: userId }).returning();
        await tx.insert(db.marketplaceCapabilitySnapshots).values({ id: capabilityId, tenantId, accountId, version: 1, platform: "amazon", externalAccountId: "SYNTHETIC-LEGACY-" + id, marketplaceIds: ["ATVPDKIKX0DER"],
          capabilities: ["listing_read", "listing_write"], sourceVersion: "synthetic-history", sourceChecksum: sha(id), data: {}, syncedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), authorizationGeneration: account!.authorizationGeneration, createdBy: userId });
        const payload = { platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", productType: "HOME", sku: "SYNTHETIC-LEGACY", attributes };
        for (const [requestId, action, parentRequestId] of [[previewId, "amazon_validation_preview", null], [publicationId, "amazon_submit", previewId]] as const)
          await tx.insert(db.marketplacePublicationRequests).values({ id: requestId, tenantId, accountId, capabilitySnapshotId: capabilityId, listingId, listingVersionId: versionId, platform: "amazon", marketplaceId: "ATVPDKIKX0DER",
            action, parentRequestId, idempotencyKey: sha(requestId), payload, payloadChecksum: sha(JSON.stringify(payload)), assetManifest: [], createdBy: userId });
        await tx.insert(db.marketplacePublicationEvents).values({ id: contracts.createEntityId(), tenantId, requestId: publicationId, sequence: 1, status: "published", externalListingId: "SYNTHETIC-LEGACY", externalState: "SYNTHETIC-HISTORICAL-ONLY", actorUserId: userId });
      });
      return { accountId, listingId, listingVersionId: versionId, sourcePublicationRequestId: publicationId };
    }
    phase = "original180_first_prerequisite"; const first = await prerequisite(); phase = "original180_second_prerequisite"; const other = await prerequisite(), requestKey = contracts.createEntityId(), input = { ...first, action: "read" as const, requestKey };
    phase = "original180_producer"; queue = new queues.RedisMarketplaceListingSyncEnqueuer(); let enqueueCalls = 0; const enqueue = queue.enqueue.bind(queue); queue.enqueue = async value => { enqueueCalls++; await enqueue(value); };
    phase = "original180_constructor";
    const audit = new audits.AuditService(database), owner = new syncs.MarketplaceListingSyncService(database, queue, audit, new inventory.ChannelInventoryService(database, audit));
    phase = "original180_create_first"; const original = await owner.create(context, input); phase = "original180_create_alias"; const alias = await owner.create(context, { ...other, action: "read", requestKey });
    phase = "original180_read_rows";
    const rows = await db.withTenant(database.db, context, async tx => ({ accounts: await tx.select().from(db.marketplaceAccounts), capabilities: await tx.select().from(db.marketplaceCapabilitySnapshots),
      listings: await tx.select().from(db.listings), versions: await tx.select().from(db.listingVersions), publications: await tx.select().from(db.marketplacePublicationRequests), publicationEvents: await tx.select().from(db.marketplacePublicationEvents),
      requests: await tx.select().from(db.marketplaceListingSyncRequests), events: await tx.select().from(db.marketplaceListingSyncEvents) }));
    phase = "original180_wait_upgrade";
    const checked = new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new Error("listing_sync_intent_legacy_check_timeout")), 120_000);
      process.on("message", raw => { if (raw && typeof raw === "object" && "type" in raw && raw.type === "listing.sync.intent.check180" && "nonce" in raw && raw.nonce === target.nonce) { clearTimeout(timer); done(); } }); });
    await send({ type: "listing.sync.intent.seeded180", nonce: target.nonce, context, input, other: { ...other, action: "read", requestKey }, original, alias, rows, enqueueCalls, syntheticPublishedPrerequisites: true });
    await checked; phase = "original180_read_after_upgrade"; const before = enqueueCalls, reread = await owner.get(context, original.id), events = await owner.events(context, original.id);
    await send({ type: "listing.sync.intent.checked180", nonce: target.nonce, original: reread, events, additionalEnqueues: enqueueCalls - before });
    await close(); process.disconnect?.();
  } catch (error) {
    await send(diagnostic(error, phase)).catch(() => {}); await close().catch(() => {}); process.exitCode = 1; process.disconnect?.();
  }
}
if (process.argv.includes("--listing-sync-intent-original180-child")) void original180();
