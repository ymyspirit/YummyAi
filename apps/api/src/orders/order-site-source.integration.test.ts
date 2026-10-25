import { randomUUID } from "node:crypto";
import { NotFoundException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { SecretVault } from "@yummyai/ai-core";
import { Permission } from "@yummyai/authz";
import { createEntityId, type NormalizeOrderInput, type TenantContext } from "@yummyai/contracts";
import { OrderWorkDraftSchema } from "@yummyai/contracts/order/workspace";
import { normalizeAmazonOrder, normalizeEtsyReceipt, type MarketplaceOrderIngestionAdapter } from "@yummyai/marketplace-connectors";
import {
  amazonOrderReportBatches, amazonOrderReportBatchItems, artworkMasters, artworkMasterVersions,
  connectDatabase, listingVersions, listings, loadCurrentMembershipContext, marketplaceAccounts,
  memberships, membershipRoles, migrateDatabase, orderSourceSnapshots, orders, productStyles,
  roles, salesChannelBindings, salesPackageVersions, salesRecipeVersions, salesSkuDefinitions, skus, withTenant,
} from "@yummyai/database";
import { requireDisposableIntegrationEnvironment } from "../../../../tools/testing/require-disposable-integration.mjs";
import { AuditService } from "../audit/audit.service.js";
import { fingerprint } from "../catalog/development-data.js";
import { manufacturingBasis } from "../catalog/manufacturing.test-fixture.js";
import { resolveOrderSalesBasis, validateOrderSalesBasis } from "../catalog/order-sales-basis.js";
import { AmazonOrderReportService } from "./amazon-order-report.service.js";
import { OrderIngestionService } from "./order-ingestion.service.js";
import { OrderService } from "./order.service.js";
import { OrderSyncCoordinator } from "./order-sync-coordinator.js";

// The acceptance runner owns and removes the complete disposable database.
// This file never creates artwork, object-storage files, queues or model calls.
requireDisposableIntegrationEnvironment();

const us = "ATVPDKIKX0DER", ca = "A2EUQ1WTGCTBG2", asin = "B0SITE0001";
const at = "2026-02-01T12:00:00.000Z";
type Basis = Awaited<ReturnType<typeof manufacturingBasis>>;
type Actor = {
  context: TenantContext; amazon: string; otherAmazon: string; etsy: string; basis: Basis;
  artworkVersionId: string; skuId: string; recipeId: string;
  listings: Map<string, { id: string; versionId: string; packageNumber: number }>;
};
type Intake = { orderId: string; lineId: string; input: NormalizeOrderInput };

describe.sequential("order site provenance and exact channel resolution", () => {
  const db = connectDatabase(), audit = new AuditService(db), vault = new SecretVault(Buffer.alloc(32, 89));
  const service = new OrderService(db, vault, audit);
  const coordinator = new OrderSyncCoordinator(new OrderIngestionService(db, audit), service);
  const reports = new AmazonOrderReportService(db, vault, service, audit, {
    download: async () => { throw Error("No remote attachments in site fixtures"); },
    scan: async () => ({ result: "clean" as const, engine: "synthetic", signatureVersion: "synthetic", scannedAt: new Date().toISOString() }),
  }, { schedule: async () => undefined }, { schedule: async () => undefined });
  let a: Actor, b: Actor;
  let usPackage: string, caPackage: string, newerUsPackage: string, controlledPackage: string, etsyPackage: string, foreignPackage: string;

  beforeAll(async () => {
    await migrateDatabase(db);
    a = await actor(); b = await actor();
    usPackage = await pack(a, "amazon", us);
    caPackage = await pack(a, "amazon", ca);
    newerUsPackage = await pack(a, "amazon", us);
    controlledPackage = await pack(a, "amazon", us, true);
    etsyPackage = await pack(a, "etsy", "etsy");
    foreignPackage = await pack(b, "amazon", us);
  }, 60_000);
  afterAll(() => db.client.end());

  async function actor(): Promise<Actor> {
    const seed: TenantContext = { tenantId: createEntityId(), userId: createEntityId(), permissions: Object.values(Permission), dataScope: "tenant" };
    await db.client.unsafe("insert into organizations(id,name,slug) values($1,'Synthetic order sites',$2)", [seed.tenantId, randomUUID()]);
    await db.client.unsafe("insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Synthetic site operator')", [seed.userId, randomUUID(), `${seed.userId}@example.invalid`]);
    const memberId = createEntityId(), roleId = createEntityId();
    const amazon = createEntityId(), otherAmazon = createEntityId(), etsy = createEntityId();
    await withTenant(db.db, seed, async tx => {
      await tx.insert(memberships).values({ id: memberId, tenantId: seed.tenantId, userId: seed.userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId: seed.tenantId, name: randomUUID(), permissions: seed.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId: seed.tenantId, membershipId: memberId, roleId });
      await tx.insert(marketplaceAccounts).values([
        { id: amazon, tenantId: seed.tenantId, platform: "amazon", displayName: "Synthetic multi-site shop", region: "NA", authorizationMode: "amazon_private", marketplaceIds: [us, ca], createdBy: seed.userId },
        { id: otherAmazon, tenantId: seed.tenantId, platform: "amazon", displayName: "Synthetic single-site shop", region: "NA", authorizationMode: "amazon_private", marketplaceIds: [us], createdBy: seed.userId },
        { id: etsy, tenantId: seed.tenantId, platform: "etsy", displayName: "Synthetic Etsy shop", region: "GLOBAL", authorizationMode: "etsy_oauth", marketplaceIds: ["etsy"], createdBy: seed.userId },
      ]);
    });
    const context = await withTenant(db.db, seed, tx => loadCurrentMembershipContext(tx, seed));
    const basis = await manufacturingBasis(db, context);
    const artId = createEntityId(), artworkVersionId = createEntityId(), styleId = createEntityId(), skuId = createEntityId(), recipeId = createEntityId();
    await withTenant(db.db, context, async tx => {
      await tx.insert(artworkMasters).values({ id: artId, tenantId: context.tenantId, createdBy: context.userId, code: randomUUID() });
      await tx.insert(artworkMasterVersions).values({ id: artworkVersionId, tenantId: context.tenantId, createdBy: context.userId, artworkId: artId,
        versionNumber: 1, name: "Synthetic customer-image method metadata", mode: "customer_image", tags: [], researchItemIds: [],
        customization: { version: 1, fields: [] }, materials: [], layout: [], instructions: "No production image or release" });
      await tx.insert(productStyles).values({ id: styleId, tenantId: context.tenantId, createdBy: context.userId, spuId: basis.spuId, artworkId: artId });
      await tx.insert(skus).values({ id: skuId, tenantId: context.tenantId, spuId: basis.spuId, code: `SYNTHETIC-${randomUUID()}`, attributes: {} });
      await tx.insert(salesSkuDefinitions).values({ id: createEntityId(), tenantId: context.tenantId, createdBy: context.userId, skuId, spuId: basis.spuId, styleId, specificationId: basis.specificationId });
      await tx.insert(salesRecipeVersions).values({ id: recipeId, tenantId: context.tenantId, createdBy: context.userId, skuId, versionNumber: 1,
        artworkVersionId, specificationVersionId: basis.specificationVersionId, status: "ready_for_customization" });
    });
    return { context, amazon, otherAmazon, etsy, basis, artworkVersionId, skuId, recipeId, listings: new Map() };
  }

  async function pack(owner: Actor, platform: "amazon" | "etsy", site: string, controlled = false) {
    const c = owner.context, key = `${platform}:${site}`;
    let listing = owner.listings.get(key);
    if (!listing) {
      listing = { id: createEntityId(), versionId: createEntityId(), packageNumber: 0 };
      const row = listing;
      await withTenant(db.db, c, async tx => {
        await tx.insert(listings).values({ id: row.id, tenantId: c.tenantId, spuId: owner.basis.spuId, platform, marketplaceId: site, locale: "en-US", createdBy: c.userId });
        await tx.insert(listingVersions).values({ id: row.versionId, tenantId: c.tenantId, listingId: row.id, versionNumber: 1, ruleVersion: "synthetic-site-fixture", createdBy: c.userId,
          content: { platform, locale: "en-US", title: "Synthetic site metadata", description: "", bullets: [], tags: [], mediaAssetIds: [], variants: [], attributes: {}, compliance: {} },
          validation: { completeness: 0, blockers: [], warnings: [] } });
      });
      owner.listings.set(key, listing);
    }
    const id = createEntityId();
    // Referential packages exercise resolution only, never seal or publication.
    // The controlled marker is intentionally not a releasable delivery snapshot;
    // only its existence is used by the missing-package fail-closed counterexample.
    const snapshot = controlled ? { synthetic: true, salesPlanDelivery: {} } : { synthetic: true };
    await withTenant(db.db, c, tx => tx.insert(salesPackageVersions).values({ id, tenantId: c.tenantId, createdBy: c.userId,
      skuId: owner.skuId, recipeId: owner.recipeId, versionNumber: ++listing.packageNumber, listingId: listing.id, listingVersionId: listing.versionId,
      platform, marketplaceId: site, locale: "en-US", snapshot, checksum: fingerprint(snapshot) }));
    return id;
  }

  const sku = () => `SITE-${randomUUID()}`;
  async function bind(owner: Actor, code: string, packageId: string, site: string, options: { accountId?: string; listingId?: string; effectiveFrom?: string; choice?: Record<string, string> } = {}) {
    await withTenant(db.db, owner.context, tx => tx.insert(salesChannelBindings).values({ id: createEntityId(), tenantId: owner.context.tenantId, createdBy: owner.context.userId,
      accountId: options.accountId ?? owner.amazon, packageId, marketplaceId: site, externalSku: code, externalListingId: options.listingId ?? asin,
      effectiveFrom: new Date(options.effectiveFrom ?? "2026-01-01T00:00:00.000Z"), customChoice: options.choice ?? {},
      customChoiceKey: fingerprint(options.choice ?? {}), evidence: "Synthetic site matching only" }));
  }

  function input(owner: Actor, code: string, options: { site?: string; accountId?: string; placedAt?: string; externalOrderId?: string; source?: Record<string, unknown> } = {}) {
    const id = options.externalOrderId ?? `SYNTHETIC-${randomUUID()}`;
    const record = normalizeAmazonOrder(options.accountId ?? owner.amazon, randomUUID(), {
      orderId: id, createdTime: options.placedAt ?? at, lastUpdatedTime: options.placedAt ?? at, fulfillmentStatus: "UNSHIPPED",
      salesChannel: { marketplaceId: options.site ?? us }, orderTotal: { amount: "20.00", currencyCode: "USD" },
      orderItems: [{ orderItemId: "LINE-1", product: { asin, sellerSku: code, title: "Synthetic site item" }, quantityOrdered: 1, unitPrice: { amount: "20.00", currencyCode: "USD" } }],
    });
    if (options.source) record.order.redactedSource = options.source;
    return record.order;
  }
  async function intake(owner: Actor, code: string, options: Parameters<typeof input>[2] = {}): Promise<Intake> {
    const order = input(owner, code, options), result = await service.materializeNormalized(owner.context, order);
    return { orderId: result.order.id, lineId: result.order.lines[0]!.id, input: order };
  }
  const resolve = (owner: Actor, lineId: string, choice: Record<string, string> = {}) =>
    withTenant(db.db, owner.context, tx => resolveOrderSalesBasis(tx, lineId, choice));
  const unmatched = (result: Awaited<ReturnType<typeof resolve>>, status: "missing" | "conflict") => {
    expect(result).toMatchObject({ site: { status, marketplaceId: null }, status: "unmatched", packageId: null, recipe: null, matchingPackageIds: [] });
  };
  function manual(owner: Actor) {
    return OrderWorkDraftSchema.parse({ salesRecipeVersionId: owner.recipeId, salesPackageId: null,
      artworkVersionId: owner.artworkVersionId, specificationVersionId: owner.basis.specificationVersionId, printProfileVersionId: owner.basis.profileVersionId,
      fields: [], images: [], instructions: "Synthetic manual method", designExecutor: "human", dueAt: null, customerApprovalRequired: false });
  }
  async function reportBatch(owner: Actor, order: Intake, site: string, options: { status?: "imported" | "duplicate" | "failed"; accountId?: string; externalOrderId?: string } = {}) {
    const id = createEntityId(), status = options.status ?? "imported";
    await withTenant(db.db, owner.context, async tx => {
      await tx.insert(amazonOrderReportBatches).values({ id, tenantId: owner.context.tenantId, createdBy: owner.context.userId, accountId: options.accountId ?? owner.amazon,
        marketplaceId: site, fileName: "synthetic-site-only.tsv", reportChecksum: fingerprint(id), rowCount: 1, orderCount: 1,
        newOrderCount: status === "imported" ? 1 : 0, duplicateOrderCount: status === "duplicate" ? 1 : 0, failedOrderCount: status === "failed" ? 1 : 0,
        status: status === "failed" ? "failed" : "completed", expiresAt: new Date(Date.now() + 86_400_000) });
      await tx.insert(amazonOrderReportBatchItems).values({ id: createEntityId(), tenantId: owner.context.tenantId, batchId: id, orderId: order.orderId,
        externalOrderId: options.externalOrderId ?? order.input.externalOrderId, status });
    });
  }

  it.each([us, ca])("coordinates provider normalization and selects only the exact %s package", async site => {
    const code = sku(); await bind(a, code, usPackage, us); await bind(a, code, caPackage, ca);
    const normalized = input(a, code, { site });
    const adapter: MarketplaceOrderIngestionAdapter = { platform: "amazon", fetchPage: async () => ({
      records: [{ order: normalized, providerUpdatedAt: at }], fetchedAt: "2026-04-01T00:00:00.000Z", highWaterAt: "2026-04-01T00:00:00.000Z",
      nextCursor: null, reportedCount: 1, sourceVersion: "synthetic-formal-amazon-api" }) };
    const result = await coordinator.run(a.context, { adapter, stream: randomUUID(), connectorContext: { accountId: a.amazon, tenantId: a.context.tenantId,
      platform: "amazon", externalAccountId: "synthetic-seller", region: "NA", marketplaceIds: [us, ca] }, credentials: { withCredential: callback => callback({ refreshToken: "synthetic-unused" }) },
      request: { checkpoint: { cursor: null, highWaterAt: null, version: 1 }, updatedAfter: "2026-01-01T00:00:00.000Z", updatedBefore: "2026-04-01T00:00:00.000Z", pageSize: 50, maxPages: 1 } }, new AbortController().signal);
    expect(result.status).toBe("completed");
    const stored = (await service.list(a.context, { limit: 100 })).find(order => order.externalOrderId === normalized.externalOrderId);
    expect(stored).toBeDefined();
    const detail = await service.get(a.context, stored!.id), basis = await resolve(a, detail.lines[0]!.id);
    const selected = site === us ? usPackage : caPackage;
    expect(basis).toMatchObject({ status: "matched", site: { status: "resolved", marketplaceId: site }, packageId: selected });
    expect(basis.matchingPackageIds).toEqual([selected]);
    await withTenant(db.db, a.context, async tx => {
      const [role] = await tx.execute<{ name: string }>(sql`select current_user as name`);
      expect(role?.name).toBe("yummyai_app");
    });
  });

  it("rejects the sole candidate when it belongs to a different site", async () => {
    const code = sku(); await bind(a, code, caPackage, ca);
    const order = await intake(a, code), result = await resolve(a, order.lineId);
    expect(result).toMatchObject({ site: { status: "resolved", marketplaceId: us }, status: "unmatched", packageId: null, recipe: null, matchingPackageIds: [] });
  });

  it("does not infer a missing site from a single-site account or its one binding", async () => {
    const code = sku(); await bind(a, code, usPackage, us, { accountId: a.otherAmazon });
    const order = await intake(a, code, { accountId: a.otherAmazon, source: { source: "synthetic-legacy-without-site" } });
    unmatched(await resolve(a, order.lineId), "missing");
  });

  it("uses a late formal source without rewriting the initial immutable source pin", async () => {
    const code = sku(); await bind(a, code, usPackage, us);
    const firstInput = input(a, code); delete firstInput.redactedSource.marketplaceId;
    const first = await service.materializeNormalized(a.context, firstInput), lineId = first.order.lines[0]!.id;
    const [before] = await withTenant(db.db, a.context, tx => tx.select().from(orders).where(eq(orders.id, first.order.id)));
    const [snapshot] = await withTenant(db.db, a.context, tx => tx.select().from(orderSourceSnapshots).where(eq(orderSourceSnapshots.id, before!.sourceSnapshotId)));
    unmatched(await resolve(a, lineId), "missing");
    await service.materializeNormalized(a.context, input(a, code, { externalOrderId: firstInput.externalOrderId }));
    expect(await resolve(a, lineId)).toMatchObject({ status: "matched", packageId: usPackage });
    const [after] = await withTenant(db.db, a.context, tx => tx.select().from(orders).where(eq(orders.id, first.order.id)));
    const [original] = await withTenant(db.db, a.context, tx => tx.select().from(orderSourceSnapshots).where(eq(orderSourceSnapshots.id, snapshot!.id)));
    expect(after?.sourceSnapshotId).toBe(before?.sourceSnapshotId); expect(original).toEqual(snapshot);
  });

  it("treats two explicit API sites as conflict instead of silently preferring the later update", async () => {
    const code = sku(); await bind(a, code, usPackage, us); await bind(a, code, caPackage, ca);
    const order = await intake(a, code);
    await service.materializeNormalized(a.context, input(a, code, { externalOrderId: order.input.externalOrderId, site: ca }));
    unmatched(await resolve(a, order.lineId), "conflict");
  });

  it.each(["same", "conflict"] as const)("reconciles a real report import with an API source: %s", async mode => {
    const code = sku(); await bind(a, code, usPackage, us); await bind(a, code, caPackage, ca);
    const order = await intake(a, code);
    await reports.importReport(a.context, { accountId: a.amazon, marketplaceId: mode === "same" ? us : ca, fileName: "synthetic-site-report.tsv",
      content: "order-id\torder-item-id\tpurchase-date\tsku\tproduct-name\tquantity-purchased\tcurrency\titem-price\n" +
        `${order.input.externalOrderId}\tLINE-1\t${at}\t${code}\tSynthetic site item\t1\tUSD\t20.00` });
    const result = await resolve(a, order.lineId);
    if (mode === "same") expect(result).toMatchObject({ status: "matched", packageId: usPackage, site: { status: "resolved", marketplaceId: us } });
    else unmatched(result, "conflict");
  });

  it.each(["imported", "duplicate"] as const)("accepts a successful %s report batch as the missing site source", async status => {
    const code = sku(); await bind(a, code, usPackage, us);
    const order = await intake(a, code, { source: { source: "synthetic-legacy-without-site" } });
    await reportBatch(a, order, us, { status });
    expect(await resolve(a, order.lineId)).toMatchObject({ status: "matched", packageId: usPackage, site: { status: "resolved", marketplaceId: us } });
  });

  it.each(["failed", "wrong_account", "wrong_external_order"] as const)("ignores an unrelated report site: %s", async kind => {
    const code = sku(); await bind(a, code, usPackage, us);
    const order = await intake(a, code);
    // No valid manual-report source is inserted: only this rejected batch row.
    await reportBatch(a, order, ca, { ...(kind === "failed" ? { status: "failed" as const } : {}),
      ...(kind === "wrong_account" ? { accountId: a.otherAmazon } : {}), ...(kind === "wrong_external_order" ? { externalOrderId: "SYNTHETIC-OTHER-ORDER" } : {}) });
    expect(await resolve(a, order.lineId)).toMatchObject({ status: "matched", packageId: usPackage, site: { status: "resolved", marketplaceId: us } });
  });

  it("does not select any package when two successful report batches disagree", async () => {
    const code = sku(); await bind(a, code, usPackage, us); await bind(a, code, caPackage, ca);
    const order = await intake(a, code, { source: { source: "synthetic-legacy-without-site" } });
    await reportBatch(a, order, us); await reportBatch(a, order, ca);
    unmatched(await resolve(a, order.lineId), "conflict");
  });

  it.each(["account", "platform", "external_order", "normalized_order", "payload_order"] as const)("filters source snapshots by the entire identity: %s", async dimension => {
    const code = sku(); await bind(a, code, usPackage, us);
    const order = await intake(a, code), otherOrder = await intake(a, sku(), { site: ca });
    // Deliberately malformed relational source counterexamples; no customer data.
    const payload = { apiVersion: "2026-01-01", orderId: dimension === "payload_order" ? otherOrder.input.externalOrderId : order.input.externalOrderId, marketplaceId: ca };
    await withTenant(db.db, a.context, tx => tx.insert(orderSourceSnapshots).values({ id: createEntityId(), tenantId: a.context.tenantId,
      accountId: dimension === "account" ? a.otherAmazon : a.amazon, platform: dimension === "platform" ? "etsy" : "amazon",
      externalEventId: randomUUID(), normalizedOrderId: dimension === "normalized_order" ? otherOrder.orderId : order.orderId,
      externalOrderId: dimension === "external_order" ? otherOrder.input.externalOrderId : order.input.externalOrderId, redactedPayload: payload, payloadChecksum: fingerprint(payload) }));
    expect(await resolve(a, order.lineId)).toMatchObject({ status: "matched", packageId: usPackage, site: { status: "resolved", marketplaceId: us } });
  });

  it("does not treat nested marketplace IDs or an unknown adapter's top-level field as facts", async () => {
    const code = sku(); await bind(a, code, usPackage, us);
    const nested = await intake(a, code, { source: { source: "synthetic-unknown", marketplaceId: us, nested: { marketplaceId: us } } });
    unmatched(await resolve(a, nested.lineId), "missing");
    const formal = input(a, code); delete formal.redactedSource.marketplaceId;
    formal.redactedSource.nested = { marketplaceId: us };
    const stored = await service.materializeNormalized(a.context, formal);
    unmatched(await resolve(a, stored.order.lines[0]!.id), "missing");
  });

  it("matches inclusive effective dates at the order timestamp within the resolved site", async () => {
    const code = sku();
    await bind(a, code, usPackage, us); await bind(a, code, newerUsPackage, us, { effectiveFrom: "2026-03-01T00:00:00.000Z" });
    await bind(a, code, caPackage, ca);
    for (const [placedAt, expected] of [["2025-12-31T23:59:59.999Z", null], ["2026-01-01T00:00:00.000Z", usPackage],
      ["2026-02-28T23:59:59.999Z", usPackage], ["2026-03-01T00:00:00.000Z", newerUsPackage]] as const) {
      const order = await intake(a, code, { placedAt });
      expect((await resolve(a, order.lineId)).packageId).toBe(expected);
    }
  });

  it("keeps custom choices scoped to the exact site", async () => {
    const code = sku(); await bind(a, code, usPackage, us, { choice: { pattern: "a" } });
    await bind(a, code, newerUsPackage, us, { choice: { pattern: "b" } }); await bind(a, code, caPackage, ca, { choice: { pattern: "a" } });
    const order = await intake(a, code);
    expect((await resolve(a, order.lineId, { pattern: "a" })).packageId).toBe(usPackage);
    expect((await resolve(a, order.lineId, { pattern: "b" })).packageId).toBe(newerUsPackage);
    expect((await resolve(a, order.lineId)).status).toBe("unmatched");
  });

  it("isolates same-SKU/ASIN packages and rejects a foreign tenant's line", async () => {
    const code = sku(); await bind(b, code, foreignPackage, us);
    const own = await intake(a, code), foreign = await intake(b, code);
    expect(await resolve(a, own.lineId)).toMatchObject({ status: "unmatched", matchingPackageIds: [] });
    expect((await resolve(b, foreign.lineId)).packageId).toBe(foreignPackage);
    await expect(resolve(b, own.lineId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("preserves Etsy matching through its real receipt normalizer without Amazon site evidence", async () => {
    const code = sku(), id = 1234567897;
    await bind(a, code, etsyPackage, "etsy", { accountId: a.etsy, listingId: "12345" });
    const normalized = normalizeEtsyReceipt(a.etsy, { receipt_id: id, status: "paid", created_timestamp: Date.parse(at) / 1000, updated_timestamp: Date.parse(at) / 1000,
      grandtotal: { amount: 2000, divisor: 100, currency_code: "USD" }, transactions: [{ transaction_id: id, listing_id: 12345, title: "Synthetic Etsy item", quantity: 1, sku: code, price: { amount: 2000, divisor: 100, currency_code: "USD" } }] }).order;
    const order = await service.materializeNormalized(a.context, normalized);
    expect(await resolve(a, order.order.lines[0]!.id)).toMatchObject({ site: { status: "resolved", marketplaceId: "etsy" }, status: "matched", packageId: etsyPackage });
  });

  it.each(["missing", "conflict"] as const)("cannot bypass a controlled channel by omitting the package when site is %s", async status => {
    const code = sku(); await bind(a, code, controlledPackage, us);
    const order = await intake(a, code, status === "missing" ? { source: { source: "synthetic-legacy-without-site" } } : {});
    if (status === "conflict") await service.materializeNormalized(a.context, input(a, code, { site: ca, externalOrderId: order.input.externalOrderId }));
    const resolved = await resolve(a, order.lineId); unmatched(resolved, status); expect(resolved.controlledDelivery).toBe(true);
    const checked = await withTenant(db.db, a.context, tx => validateOrderSalesBasis(tx, manual(a), false, order.lineId));
    expect(checked?.deliveryIssues).toEqual(expect.arrayContaining([expect.objectContaining({ code: `order_site_${status}` }), expect.objectContaining({ code: "missing_delivery_reference" })]));
  });

  it.each(["missing", "conflict"] as const)("retains a genuine manual recipe with no controlled channel when site is %s", async status => {
    const code = sku(), order = await intake(a, code, status === "missing" ? { source: { source: "synthetic-legacy-without-site" } } : {});
    if (status === "conflict") await service.materializeNormalized(a.context, input(a, code, { site: ca, externalOrderId: order.input.externalOrderId }));
    const checked = await withTenant(db.db, a.context, tx => validateOrderSalesBasis(tx, manual(a), false, order.lineId));
    expect(checked?.recipe?.id).toBe(a.recipeId); expect(checked?.deliveryIssues).toEqual([]);
  });

  it.each(["future", "other_account", "other_sku"] as const)("does not mistake an unrelated controlled binding for this manual order: %s", async kind => {
    const code = sku(); await bind(a, kind === "other_sku" ? sku() : code, controlledPackage, us, {
      ...(kind === "future" ? { effectiveFrom: "2026-03-01T00:00:00.000Z" } : {}), ...(kind === "other_account" ? { accountId: a.otherAmazon } : {}) });
    const order = await intake(a, code, { source: { source: "synthetic-legacy-without-site" } });
    expect((await resolve(a, order.lineId)).controlledDelivery).toBe(false);
    const checked = await withTenant(db.db, a.context, tx => validateOrderSalesBasis(tx, manual(a), false, order.lineId));
    expect(checked?.deliveryIssues).toEqual([]);
  });
});
