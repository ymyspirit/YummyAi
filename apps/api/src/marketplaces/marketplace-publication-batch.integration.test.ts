import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  marketplacePublicationBatches,
  marketplacePublicationEvents,
  marketplacePublicationRequests,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import {
  MarketplacePublicationBatchService,
  type MarketplacePublicationBatchEnqueuer,
} from "./marketplace-publication-batch.service.js";
import {
  MarketplacePublicationService,
  type MarketplacePublicationEnqueuer,
} from "./marketplace-publication.service.js";

class FakePublicationEnqueuer implements MarketplacePublicationEnqueuer {
  enqueue = vi.fn<MarketplacePublicationEnqueuer["enqueue"]>(async () => undefined);
  cancel = vi.fn<MarketplacePublicationEnqueuer["cancel"]>(async () => undefined);
}

class FakeBatchEnqueuer implements MarketplacePublicationBatchEnqueuer {
  enqueue = vi.fn<MarketplacePublicationBatchEnqueuer["enqueue"]>(async () => undefined);
  cancel = vi.fn<MarketplacePublicationBatchEnqueuer["cancel"]>(async () => undefined);
}

describe("marketplace publication batches", () => {
  const database = connectDatabase();
  const publicationEnqueuer = new FakePublicationEnqueuer();
  const batchEnqueuer = new FakeBatchEnqueuer();
  const audit = new AuditService(database);
  const publications = new MarketplacePublicationService(database, publicationEnqueuer, audit);
  const service = new MarketplacePublicationBatchService(
    database,
    publications,
    publicationEnqueuer,
    batchEnqueuer,
    audit,
  );
  const tenantId = createEntityId();
  const otherTenantId = createEntityId();
  const userId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.ListingPublish, Permission.ListingRead],
    dataScope: "tenant",
  };
  const otherContext: TenantContext = { ...context, tenantId: otherTenantId };
  const accountId = createEntityId();
  const capabilityId = createEntityId();
  const listingId = createEntityId();
  const listingVersionId = createEntityId();
  const assetId = createEntityId();
  const variantIds = Array.from({ length: 6 }, () => createEntityId());
  const etsyAccountId = createEntityId();
  const etsyCapabilityId = createEntityId();
  const etsyListingIds = [createEntityId(), createEntityId()];
  const etsyVersionIds = [createEntityId(), createEntityId()];

  beforeAll(async () => {
    await migrateDatabase(database);
    const planId = createEntityId();
    const spuId = createEntityId();
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Batch tenant', $2), ($3, 'Other batch tenant', $4)`,
      [tenantId, `batch-${tenantId}`, otherTenantId, `other-batch-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Batch Admin')`,
      [userId, `batch-${userId}`, `${userId}@example.test`],
    );
    await database.client.unsafe(
      `insert into product_plans (id, tenant_id, name, status, source_report_ids, customization, created_by)
       values ($1, $2, 'Batch plan', 'approved', '[]'::jsonb, '{"version":1,"fields":[]}'::jsonb, $3)`,
      [planId, tenantId, userId],
    );
    await database.client.unsafe(
      `insert into spus (id, tenant_id, product_plan_id, code, name, status, customization)
       values ($1, $2, $3, 'BATCH-1', 'Batch product', 'listing', '{"version":1,"fields":[]}'::jsonb)`,
      [spuId, tenantId, planId],
    );
    await database.client.unsafe(
      `insert into asset_files
       (id, tenant_id, owner_user_id, object_key, asset_domain, file_name, media_type, byte_size, checksum_sha256, rights_status)
       values ($1, $2, $3, $4, 'authorized', 'batch.jpg', 'image/jpeg', 100, $5, 'approved')`,
      [assetId, tenantId, userId, `tenants/${tenantId}/authorized/${assetId}.jpg`, "b".repeat(64)],
    );
    await database.client.unsafe(
      `insert into marketplace_accounts
       (id, tenant_id, platform, display_name, external_account_id, region, marketplace_ids, authorization_mode,
        status, requested_scopes, granted_scopes, capabilities, credential_status, health_status,
        last_capability_sync_at, capability_expires_at, created_by)
       values ($1, $2, 'amazon', 'Batch Amazon', 'A1BATCH', 'NA', '["ATVPDKIKX0DER"]'::jsonb,
        'amazon_private', 'active', '["product-listing"]'::jsonb, '["product-listing"]'::jsonb,
        '["listing_read","listing_write"]'::jsonb, 'valid', 'healthy', now(), now() + interval '24 hours', $3)`,
      [accountId, tenantId, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_capability_snapshots
       (id, tenant_id, account_id, version, platform, external_account_id, marketplace_ids, capabilities,
        source_version, source_checksum, data, synced_at, expires_at, created_by)
       values ($1, $2, $3, 1, 'amazon', 'A1BATCH', '["ATVPDKIKX0DER"]'::jsonb,
        '["listing_read","listing_write"]'::jsonb, 'amazon-sellers-v1:2026-07', 'batch-capability-checksum',
        $4::jsonb, now(), now() + interval '24 hours', $5)`,
      [capabilityId, tenantId, accountId, JSON.stringify({
        productDefinitions: [{ productType: "HOME", marketplaceIds: ["ATVPDKIKX0DER"], schemaChecksum: "schema-checksum" }],
      }), userId],
    );
    await database.client.unsafe(
      `insert into listings (id, tenant_id, spu_id, platform, locale, status, created_by)
       values ($1, $2, $3, 'amazon', 'en-US', 'approved', $4)`,
      [listingId, tenantId, spuId, userId],
    );
    const content = {
      platform: "amazon",
      locale: "en-US",
      title: "Batch personalized pillow",
      description: "Gift-ready pillow",
      bullets: ["Custom name"],
      tags: [],
      mainImageId: assetId,
      mediaAssetIds: [assetId],
      variants: variantIds.map((skuId, index) => ({
        skuId,
        skuCode: `BATCH-PILLOW-${index + 1}`,
        optionValues: { size: `${index + 1}` },
      })),
      attributes: { brand: "YummyAI" },
      compliance: { countryOfOrigin: "CN" },
      publication: {
        platform: "amazon",
        productType: "HOME",
        attributes: { item_name: [{ value: "Batch personalized pillow", marketplace_id: "ATVPDKIKX0DER" }] },
      },
    };
    await database.client.unsafe(
      `insert into listing_versions
       (id, tenant_id, listing_id, version_number, rule_version, status, source, content, validation, created_by, approved_by, approved_at)
       values ($1, $2, $3, 1, 'amazon-2026.07', 'approved', 'human', $4::jsonb,
        '{"completeness":100,"blockers":[],"warnings":[]}'::jsonb, $5, $5, now())`,
      [listingVersionId, tenantId, listingId, JSON.stringify(content), userId],
    );
    await database.client.unsafe(
      `update listings set primary_version_id = $1, updated_at = now() where id = $2`,
      [listingVersionId, listingId],
    );
    await database.client.unsafe(
      `insert into marketplace_accounts
       (id, tenant_id, platform, display_name, external_account_id, region, marketplace_ids, authorization_mode,
        status, requested_scopes, granted_scopes, capabilities, credential_status, health_status,
        last_capability_sync_at, capability_expires_at, created_by)
       values ($1, $2, 'etsy', 'Batch Etsy', '9001', 'GLOBAL', '["etsy"]'::jsonb,
        'etsy_oauth', 'active', '["listings_r","listings_w"]'::jsonb, '["listings_r","listings_w"]'::jsonb,
        '["listing_read","listing_write","media_write","inventory_write"]'::jsonb, 'valid', 'healthy', now(), now() + interval '24 hours', $3)`,
      [etsyAccountId, tenantId, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_capability_snapshots
       (id, tenant_id, account_id, version, platform, external_account_id, marketplace_ids, capabilities,
        source_version, source_checksum, data, synced_at, expires_at, created_by)
       values ($1, $2, $3, 1, 'etsy', '9001', '["etsy"]'::jsonb,
        '["listing_read","listing_write","media_write","inventory_write"]'::jsonb, 'etsy-openapi-v3:2026-07', 'etsy-batch-capability',
        $4::jsonb, now(), now() + interval '24 hours', $5)`,
      [etsyCapabilityId, tenantId, etsyAccountId, JSON.stringify({
        taxonomyProperties: [{ taxonomyId: 123 }],
        shippingProfiles: { results: [{ shipping_profile_id: 456 }] },
        readinessProfiles: { results: [{ readiness_state_definition_id: 789 }] },
      }), userId],
    );
    const secondEtsySpuId = createEntityId();
    await database.client.unsafe(
      `insert into spus (id, tenant_id, product_plan_id, code, name, status, customization)
       values ($1, $2, $3, 'BATCH-ETSY-2', 'Second Etsy batch product', 'listing', '{"version":1,"fields":[]}'::jsonb)`,
      [secondEtsySpuId, tenantId, planId],
    );
    for (const [index, etsyListingId] of etsyListingIds.entries()) {
      const etsyVersionId = etsyVersionIds[index]!;
      await database.client.unsafe(
        `insert into listings (id, tenant_id, spu_id, platform, locale, status, created_by)
         values ($1, $2, $3, 'etsy', 'en-US', 'approved', $4)`,
        [etsyListingId, tenantId, index === 0 ? spuId : secondEtsySpuId, userId],
      );
      const etsyContent = {
        platform: "etsy",
        locale: "en-US",
        title: `Personalized Etsy pillow ${index + 1}`,
        description: "Gift-ready personalized pillow",
        bullets: [],
        tags: ["personalized", "pillow"],
        mainImageId: assetId,
        mediaAssetIds: [assetId],
        variants: [{ skuId: createEntityId(), skuCode: `ETSY-PILLOW-${index + 1}`, optionValues: {} }],
        attributes: {},
        compliance: { countryOfOrigin: "CN" },
        publication: {
          platform: "etsy",
          price: { amount: 24.99, currency: "USD" },
          quantity: 10,
          whoMade: "i_did",
          whenMade: "2020_2026",
          taxonomyId: 123,
          shippingProfileId: 456,
          readinessStateId: 789,
        },
      };
      await database.client.unsafe(
        `insert into listing_versions
         (id, tenant_id, listing_id, version_number, rule_version, status, source, content, validation, created_by, approved_by, approved_at)
         values ($1, $2, $3, 1, 'etsy-2026.07', 'approved', 'human', $4::jsonb,
          '{"completeness":100,"blockers":[],"warnings":[]}'::jsonb, $5, $5, now())`,
        [etsyVersionId, tenantId, etsyListingId, JSON.stringify(etsyContent), userId],
      );
      await database.client.unsafe(
        `update listings set primary_version_id = $1, updated_at = now() where id = $2`,
        [etsyVersionId, etsyListingId],
      );
    }
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("creates child history atomically and reuses the deterministic batch", async () => {
    const input = batchInput(variantIds[0]!, variantIds[1]!);
    const first = await service.create(context, input);
    const second = await service.create(context, input);

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      accountId,
      action: "initial",
      itemCount: 2,
      status: "queued",
      counts: { total: 2, waiting: 2 },
    });
    expect(new Set(first.items.map((item) => item.id)).size).toBe(2);
    expect(first.items.every((item) => item.action === "amazon_validation_preview" && item.batchId === first.id)).toBe(true);

    const requests = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationRequests)
      .where(eq(marketplacePublicationRequests.batchId, first.id)));
    const events = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationEvents)
      .where(inArray(marketplacePublicationEvents.requestId, requests.map((request) => request.id))));
    expect(requests).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(publicationEnqueuer.enqueue).toHaveBeenCalledTimes(4);
    await expect(service.get(otherContext, first.id)).rejects.toMatchObject({ status: 404 });
    await expect(withTenant(database.db, context, (tx) => tx.update(marketplacePublicationBatches)
      .set({ marketplaceId: "mutated" }).where(eq(marketplacePublicationBatches.id, first.id)))).rejects.toThrow();
  });

  it("continues a validated Amazon batch as one JSON Feed batch", async () => {
    const initial = await service.create(context, batchInput(variantIds[0]!, variantIds[1]!));
    await withTenant(database.db, context, (tx) => tx.insert(marketplacePublicationEvents).values(
      initial.items.map((item) => ({
        id: createEntityId(),
        tenantId,
        requestId: item.id,
        sequence: 2,
        status: "validation_passed" as const,
        externalListingId: item.id,
        externalState: "VALID",
        actorUserId: userId,
      })),
    ));

    const first = await service.continue(context, initial.id);
    const second = await service.continue(context, initial.id);

    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      action: "continue",
      parentBatchId: initial.id,
      platform: "amazon",
      status: "queued",
    });
    expect(first.items.every((item) => item.action === "amazon_feed_submit" && item.parentRequestId)).toBe(true);
    expect(batchEnqueuer.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      publicationBatchId: first.id,
      tenantId,
      requestedBy: userId,
    }));
    expect(publicationEnqueuer.enqueue).not.toHaveBeenCalledWith(expect.objectContaining({
      publicationRequestId: first.items[0]!.id,
    }));
  });

  it("continues an Etsy draft batch as individual activation jobs", async () => {
    const initial = await service.create(context, {
      accountId: etsyAccountId,
      marketplaceId: "etsy",
      items: etsyListingIds.map((etsyListingId, index) => ({
        listingId: etsyListingId,
        listingVersionId: etsyVersionIds[index]!,
      })),
    });
    await withTenant(database.db, context, (tx) => tx.insert(marketplacePublicationEvents).values(
      initial.items.map((item, index) => ({
        id: createEntityId(),
        tenantId,
        requestId: item.id,
        sequence: 2,
        status: "draft_created" as const,
        externalListingId: `${900_100 + index}`,
        externalState: "draft",
        actorUserId: userId,
      })),
    ));
    const publicationCalls = publicationEnqueuer.enqueue.mock.calls.length;
    const batchCalls = batchEnqueuer.enqueue.mock.calls.length;

    const continued = await service.continue(context, initial.id);

    expect(continued.items.every((item) => item.action === "etsy_activate" && item.sourceExternalListingId)).toBe(true);
    expect(publicationEnqueuer.enqueue.mock.calls.length).toBe(publicationCalls + 2);
    expect(batchEnqueuer.enqueue).toHaveBeenCalledTimes(batchCalls);
  });

  it("cancels only a fully waiting batch by appending item events", async () => {
    const batch = await service.create(context, {
      ...batchInput(variantIds[2]!, variantIds[3]!),
      scheduledFor: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
    });
    const cancelled = await service.cancel(context, batch.id, { reason: "Campaign paused" });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.items.every((item) => item.current.status === "cancelled")).toBe(true);
    expect(publicationEnqueuer.cancel).toHaveBeenCalledTimes(2);
    expect(batchEnqueuer.cancel).toHaveBeenCalledWith(batch.id);
    const events = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationEvents)
      .where(inArray(marketplacePublicationEvents.requestId, batch.items.map((item) => item.id))));
    expect(events).toHaveLength(4);
  });

  it("recovers idempotently after partial queue admission failure", async () => {
    const input = batchInput(variantIds[4]!, variantIds[5]!);
    const before = await withTenant(database.db, context, (tx) => tx.select({ id: marketplacePublicationBatches.id })
      .from(marketplacePublicationBatches));
    publicationEnqueuer.enqueue.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(service.create(context, input)).rejects.toMatchObject({ status: 503 });
    const recovered = await service.create(context, input);
    const after = await withTenant(database.db, context, (tx) => tx.select({ id: marketplacePublicationBatches.id })
      .from(marketplacePublicationBatches));

    expect(after).toHaveLength(before.length + 1);
    expect(recovered.items).toHaveLength(2);
    expect(recovered.items.some((item) => item.current.status === "retry_pending")).toBe(true);
    const requests = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationRequests)
      .where(eq(marketplacePublicationRequests.batchId, recovered.id)));
    expect(requests).toHaveLength(2);
  });

  function batchInput(firstVariantSkuId: string, secondVariantSkuId: string) {
    return {
      accountId,
      marketplaceId: "ATVPDKIKX0DER",
      items: [firstVariantSkuId, secondVariantSkuId].map((variantSkuId) => ({
        listingId,
        listingVersionId,
        variantSkuId,
      })),
    };
  }
});
