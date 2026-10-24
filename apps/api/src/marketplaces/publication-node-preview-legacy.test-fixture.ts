import "reflect-metadata";
import { createHash } from "node:crypto";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as Database from "@yummyai/database";
import type * as Contracts from "@yummyai/contracts";
import type * as OriginalPublication from "./marketplace-publication.service.js";
import type * as OriginalQueue from "./redis-marketplace-publication-enqueuer.js";
import type * as OriginalAudit from "../audit/audit.service.js";
import type * as Drizzle from "drizzle-orm";
import { requirePublicationNodePreviewEnvironment } from "../../../../tools/testing/publication-node-preview-environment.mjs";
import { assertPublicationNodePreviewOriginal181Graph } from "./publication-node-preview-graph.test-fixture.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const send = (value: object) => new Promise<void>((done, fail) => {
  if (!process.send) return fail(new Error("publication_preview_legacy_ipc_required"));
  process.send(value, error => error ? fail(error) : done());
});
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
function diagnostic(error: unknown, phase: string) {
  const cause = error && typeof error === "object" && "cause" in error ? error.cause : undefined;
  const raw = error && typeof error === "object" && "code" in error ? error.code : cause && typeof cause === "object" && "code" in cause ? cause.code : null;
  const code = typeof raw === "string" && /^(?:[A-Z0-9]{5}|ERR_[A-Z0-9_]{1,64}|ENOENT|EACCES)$/.test(raw) ? raw : null;
  let location: { file: string; line: number } | null = null;
  for (const match of (error instanceof Error ? error.stack ?? "" : "").matchAll(/(?:file:\/\/\/)?([A-Za-z]:[\\/][^\r\n()]+\.(?:[cm]?[jt]sx?)):(\d+):\d+/g)) {
    const file = relative(root, match[1]!).replaceAll("\\", "/");
    if (!file.startsWith("..") && /^[A-Za-z0-9_./@+-]+$/.test(file)) { location = { file, line: Number(match[2]) }; break; }
  }
  const names = ["Error", "SyntaxError", "ReferenceError", "TypeError", "RangeError", "ZodError", "DrizzleQueryError", "DatabaseError", "ConflictException", "NotFoundException", "ServiceUnavailableException", "ForbiddenError"];
  const name = error && typeof error === "object" ? error.constructor?.name : undefined;
  return { type: "publication.preview.failed181", phase, code, errorName: error instanceof Error && ["Error", "SyntaxError", "ReferenceError", "TypeError", "RangeError"].includes(error.name) ? error.name : "Other",
    constructorName: typeof name === "string" && names.includes(name) ? name : "Other", location };
}

/** Every executable business import resolves inside the sealed genuine181 graph. */
async function original181() {
  let phase = "original181_entry", database: Database.DatabaseConnection | undefined,
    producer: InstanceType<typeof OriginalQueue.RedisMarketplacePublicationEnqueuer> | undefined;
  const close = async () => { try { await producer?.onModuleDestroy(); } finally { await database?.client.end(); } };
  try {
    const target = requirePublicationNodePreviewEnvironment(process.env, "pre-0182"), source = process.env.E2E_PUBLICATION_NODE_PREVIEW_LEGACY_SOURCE!;
    phase = "original181_graph"; await assertPublicationNodePreviewOriginal181Graph(source);
    const load = (path: string) => import(pathToFileURL(resolve(source, path)).href);
    const db = await load("packages/database/src/index.ts") as typeof Database;
    const contracts = await load("packages/contracts/src/index.ts") as typeof Contracts;
    const owners = await load("apps/api/src/marketplaces/marketplace-publication.service.ts") as typeof OriginalPublication;
    const audits = await load("apps/api/src/audit/audit.service.ts") as typeof OriginalAudit;
    const queues = await load("apps/api/src/marketplaces/redis-marketplace-publication-enqueuer.ts") as typeof OriginalQueue;
    const { sql } = await load("apps/api/node_modules/drizzle-orm/index.js") as typeof Drizzle;
    phase = "original181_membership"; database = db.connectDatabase(target.url);
    const tenantId = contracts.createEntityId(), userId = contracts.createEntityId(), roleId = contracts.createEntityId(), membershipId = contracts.createEntityId();
    const ceiling: Contracts.TenantContext = { tenantId, userId, permissions: ["listing:read", "listing:publish", "listing:write", "listing:review", "product:read", "store:read"], dataScope: "tenant" };
    await database.client.unsafe("insert into organizations(id,name,slug)values($1,'Synthetic original181 Publication',$2)", [tenantId, "publication181-" + tenantId]);
    await database.client.unsafe("insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic original181 member')", [userId, "publication181-" + userId, userId + "@example.invalid"]);
    await db.withTenant(database.db, ceiling, async tx => {
      await tx.insert(db.memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(db.roles).values({ id: roleId, tenantId, name: "Synthetic original181 " + roleId, permissions: [...ceiling.permissions], dataScope: "tenant" });
      await tx.insert(db.membershipRoles).values({ tenantId, membershipId, roleId });
    });
    const context = contracts.TenantContextSchema.parse(await db.withTenant(database.db, ceiling, tx => db.loadCurrentMembershipContext(tx, { tenantId, userId })));
    const id = contracts.createEntityId(), planId = contracts.createEntityId(), spuId = contracts.createEntityId(), listingId = contracts.createEntityId(), versionId = contracts.createEntityId(),
      accountId = contracts.createEntityId(), capabilityId = contracts.createEntityId(), assetId = contracts.createEntityId(), variantSkuId = contracts.createEntityId(), secondSkuId = contracts.createEntityId();
    phase = "original181_prerequisites";
    const attributes = { item_name: [{ value: "Synthetic original181 approved source " + id, marketplace_id: "ATVPDKIKX0DER" }],
      purchasable_offer: [{ currency: "USD", our_price: [{ schedule: [{ value_with_tax: 12.34 }] }] }], fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }] };
    const content = { platform: "amazon" as const, locale: "en-US", title: "Synthetic historical original181 " + id, description: "Historical prerequisites are not a marketplace publication proof",
      bullets: ["Synthetic original181 only"], tags: [], mainImageId: assetId, mediaAssetIds: [assetId],
      variants: [{ skuId: variantSkuId, skuCode: "SYNTHETIC-LEGACY-" + id, optionValues: {} }, { skuId: secondSkuId, skuCode: "SYNTHETIC-LEGACY-SECOND-" + id, optionValues: {} }],
      attributes: { brand: "Synthetic" }, compliance: { countryOfOrigin: "CN" }, publication: { platform: "amazon" as const, productType: "HOME", attributes } };
    await db.withTenant(database.db, context, async tx => {
      await tx.insert(db.productPlans).values({ id: planId, tenantId, name: "Synthetic historical plan", customization: { version: 1, fields: [] }, createdBy: userId });
      await tx.insert(db.spus).values({ id: spuId, tenantId, productPlanId: planId, code: "LEGACY-PREVIEW-" + id, name: "Synthetic historical item", customization: { version: 1, fields: [] } });
      await tx.insert(db.assetFiles).values({ id: assetId, tenantId, ownerUserId: userId, objectKey: `tenants/${tenantId}/authorized/historical-${assetId}.jpg`,
        assetDomain: "authorized", fileName: "synthetic-historical.jpg", mediaType: "image/jpeg", byteSize: 100, checksumSha256: sha(id), rightsStatus: "approved" });
      await tx.insert(db.listings).values({ id: listingId, tenantId, spuId, platform: "amazon", marketplaceId: "ATVPDKIKX0DER", locale: "en-US", status: "approved", createdBy: userId });
      await tx.insert(db.listingVersions).values({ id: versionId, tenantId, listingId, versionNumber: 1, ruleVersion: "amazon-2026.07", status: "approved", source: "human", content,
        validation: { completeness: 100, blockers: [], warnings: [] }, createdBy: userId, approvedBy: userId, approvedAt: new Date() });
      await tx.execute(sql`update listings set primary_version_id=${versionId} where id=${listingId}`);
      const [account] = await tx.insert(db.marketplaceAccounts).values({ id: accountId, tenantId, platform: "amazon", displayName: "Synthetic original181 store " + id,
        externalAccountId: "SYNTHETIC-181-SELLER-" + id, region: "NA", marketplaceIds: ["ATVPDKIKX0DER"], authorizationMode: "amazon_private", status: "active",
        credentialStatus: "valid", healthStatus: "healthy", capabilities: ["listing_read", "listing_write"], createdBy: userId }).returning();
      await tx.insert(db.marketplaceCapabilitySnapshots).values({ id: capabilityId, tenantId, accountId, version: 1, platform: "amazon", externalAccountId: account!.externalAccountId!,
        marketplaceIds: ["ATVPDKIKX0DER"], capabilities: ["listing_read", "listing_write"], sourceVersion: "synthetic-historical181", sourceChecksum: sha(id),
        data: { productDefinitions: [{ productType: "HOME", marketplaceIds: ["ATVPDKIKX0DER"], schemaChecksum: sha("original181-schema") }] },
        syncedAt: new Date(), expiresAt: new Date(Date.now() + 86_400_000), authorizationGeneration: account!.authorizationGeneration, createdBy: userId });
    });
    phase = "original181_producer"; producer = new queues.RedisMarketplacePublicationEnqueuer();
    let enqueues = 0; const enqueue = producer.enqueue.bind(producer); producer.enqueue = async value => { enqueues++; await enqueue(value); };
    phase = "original181_owner_constructor"; const owner = new owners.MarketplacePublicationService(database, producer, new audits.AuditService(database));
    if (Reflect.has(owner, "createPreview")) throw new Error("publication_preview_current_owner_reached_original181");
    phase = "original181_create_queued";
    const input = { accountId, listingId, listingVersionId: versionId, marketplaceId: "ATVPDKIKX0DER", variantSkuId };
    const original = await owner.create(context, input);
    phase = "original181_create_scheduled"; const scheduled = await owner.create(context, { ...input, variantSkuId: secondSkuId, scheduledFor: new Date(Date.now() + 3_600_000).toISOString() });
    phase = "original181_read_rows";
    const rows = await db.withTenant(database.db, context, async tx => ({ accounts: await tx.select().from(db.marketplaceAccounts), capabilities: await tx.select().from(db.marketplaceCapabilitySnapshots),
      plans: await tx.select().from(db.productPlans), spus: await tx.select().from(db.spus), assets: await tx.select().from(db.assetFiles), listings: await tx.select().from(db.listings),
      versions: await tx.select().from(db.listingVersions), requests: await tx.select().from(db.marketplacePublicationRequests), events: await tx.select().from(db.marketplacePublicationEvents),
      executions: await tx.select().from(db.marketplaceStoreNodeExecutions), steps: await tx.select().from(db.marketplaceStoreNodeExecutionSteps) }));
    phase = "original181_wait_upgrade";
    const checked = new Promise<void>((done, fail) => { const timer = setTimeout(() => fail(new Error("publication_preview_legacy_check_timeout")), 120_000);
      process.on("message", raw => { if (raw && typeof raw === "object" && "type" in raw && raw.type === "publication.preview.check181" && "nonce" in raw && raw.nonce === target.nonce) { clearTimeout(timer); done(); } }); });
    await send({ type: "publication.preview.seeded181", nonce: target.nonce, context, original, scheduled, rows, enqueues, syntheticHistoricalPrerequisites: true });
    await checked; phase = "original181_read_after_upgrade";
    const before = enqueues, reread = await owner.get(context, original.id), events = await owner.events(context, original.id), oldList = await owner.list(context, { limit: 50, listingId });
    await send({ type: "publication.preview.checked181", nonce: target.nonce, original: reread, events, ids: oldList.map(value => value.id), additionalEnqueues: enqueues - before });
    await close(); process.disconnect?.();
  } catch (error) {
    await send(diagnostic(error, phase)).catch(() => {}); await close().catch(() => {}); process.exitCode = 1; process.disconnect?.();
  }
}
if (process.argv.includes("--publication-node-preview-original181-child")) void original181();
