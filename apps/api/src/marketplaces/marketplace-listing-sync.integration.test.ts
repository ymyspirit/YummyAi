import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  marketplaceListingSyncEvents,
  marketplaceListingSyncRequests,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import type { ChannelInventoryService } from "../channel-inventory/channel-inventory.service.js";
import {
  MarketplaceListingSyncService,
  type MarketplaceListingSyncEnqueuer,
} from "./marketplace-listing-sync.service.js";

describe.sequential("marketplace online Listing sync requests", () => {
  const database = connectDatabase();
  const tenantId = createEntityId();
  const otherTenantId = createEntityId();
  const userId = createEntityId();
  const accountId = createEntityId();
  const capabilityId = createEntityId();
  const listingId = createEntityId();
  const firstVersionId = createEntityId();
  const secondVersionId = createEntityId();
  const previewRequestId = createEntityId();
  const publicationRequestId = createEntityId();
  const initialBatchId = createEntityId();
  const continuationBatchId = createEntityId();
  const feedPublicationRequestId = createEntityId();
  const etsyAccountId = createEntityId();
  const etsyCapabilityId = createEntityId();
  const etsyListingId = createEntityId();
  const etsyVersionId = createEntityId();
  const etsyDraftRequestId = createEntityId();
  const etsyActivationRequestId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.ListingPublish, Permission.ListingRead],
    dataScope: "tenant",
  };
  const otherContext: TenantContext = { ...context, tenantId: otherTenantId };
  const enqueuer: MarketplaceListingSyncEnqueuer = { enqueue: vi.fn(async () => undefined) };
  const assertMarketplaceAllocations = vi.fn(async () => undefined);
  const channelInventory = { assertMarketplaceAllocations } as unknown as ChannelInventoryService;
  const service = new MarketplaceListingSyncService(
    database,
    enqueuer,
    new AuditService(database),
    channelInventory,
  );

  beforeAll(async () => {
    await migrateDatabase(database);
    const productPlanId = createEntityId();
    const spuId = createEntityId();
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1,$2,$3),($4,$5,$6)`,
      [tenantId, "Listing sync tenant", `listing-sync-${tenantId}`, otherTenantId, "Other sync tenant", `other-listing-sync-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1,$2,$3,$4)`,
      [userId, `listing-sync-${userId}`, `${userId}@example.test`, "Listing Sync Admin"],
    );
    await database.client.unsafe(
      `insert into product_plans (id, tenant_id, name, status, source_report_ids, customization, created_by)
       values ($1,$2,$3,'approved','[]'::jsonb,'{"version":1,"fields":[]}'::jsonb,$4)`,
      [productPlanId, tenantId, "Listing sync plan", userId],
    );
    await database.client.unsafe(
      `insert into spus (id, tenant_id, product_plan_id, code, name, status, customization)
       values ($1,$2,$3,$4,$5,'listing','{"version":1,"fields":[]}'::jsonb)`,
      [spuId, tenantId, productPlanId, `SYNC-${spuId}`, "Listing sync product"],
    );
    await database.client.unsafe(
      `insert into listings (id, tenant_id, spu_id, platform, marketplace_id, locale, status, created_by)
       values ($1,$2,$3,'amazon','ATVPDKIKX0DER','en-US','approved',$4)`,
      [listingId, tenantId, spuId, userId],
    );
    await insertApprovedVersion(firstVersionId, 1, "Original pillow");
    await database.client.unsafe(
      `insert into marketplace_accounts
       (id, tenant_id, platform, display_name, external_account_id, region, marketplace_ids, authorization_mode,
        status, requested_scopes, granted_scopes, capabilities, credential_status, health_status,
        last_capability_sync_at, capability_expires_at, created_by)
       values ($1,$2,'amazon','Sync Amazon','A1SELLER','NA','["ATVPDKIKX0DER"]'::jsonb,
        'amazon_private','active','["product-listing"]'::jsonb,'["product-listing"]'::jsonb,
        '["listing_read","listing_write","inventory_write"]'::jsonb,'valid','healthy',now(),now() + interval '24 hours',$3)`,
      [accountId, tenantId, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_capability_snapshots
       (id, tenant_id, account_id, version, platform, external_account_id, marketplace_ids, capabilities,
        source_version, source_checksum, data, synced_at, expires_at, created_by)
       values ($1,$2,$3,1,'amazon','A1SELLER','["ATVPDKIKX0DER"]'::jsonb,
        '["listing_read","listing_write","inventory_write"]'::jsonb,'amazon-test','capability-checksum',
        '{}'::jsonb,now(),now() + interval '24 hours',$4)`,
      [capabilityId, tenantId, accountId, userId],
    );
    const sourcePayload = JSON.stringify(amazonPayload("Published pillow"));
    await database.client.unsafe(
      `insert into marketplace_publication_requests
       (id, tenant_id, account_id, capability_snapshot_id, listing_id, listing_version_id, platform,
        marketplace_id, action, parent_request_id, idempotency_key, payload, payload_checksum, asset_manifest, created_by)
       values
       ($1,$2,$3,$4,$5,$6,'amazon','ATVPDKIKX0DER','amazon_validation_preview',null,$7,$8::jsonb,$9,'[]'::jsonb,$10),
       ($11,$2,$3,$4,$5,$6,'amazon','ATVPDKIKX0DER','amazon_submit',$1,$12,$8::jsonb,$13,'[]'::jsonb,$10)`,
      [
        previewRequestId, tenantId, accountId, capabilityId, listingId, firstVersionId,
        "1".repeat(64), sourcePayload, "2".repeat(64), userId,
        publicationRequestId, "3".repeat(64), "4".repeat(64),
      ],
    );
    await database.client.unsafe(
      `insert into marketplace_publication_events
       (id, tenant_id, request_id, sequence, status, external_listing_id, external_state, actor_user_id)
       values ($1,$2,$3,1,'published','SKU-1','BUYABLE',$4)`,
      [createEntityId(), tenantId, publicationRequestId, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_publication_batches
       (id, tenant_id, account_id, capability_snapshot_id, platform, marketplace_id, action,
        parent_batch_id, idempotency_key, item_count, created_by)
       values
       ($1,$2,$3,$4,'amazon','ATVPDKIKX0DER','initial',null,$5,2,$6),
       ($7,$2,$3,$4,'amazon','ATVPDKIKX0DER','continue',$1,$8,2,$6)`,
      [initialBatchId, tenantId, accountId, capabilityId, "9".repeat(64), userId, continuationBatchId, "a".repeat(64)],
    );
    await database.client.unsafe(
      `insert into marketplace_publication_requests
       (id, tenant_id, account_id, capability_snapshot_id, listing_id, listing_version_id, platform,
        marketplace_id, action, batch_id, parent_request_id, idempotency_key, payload, payload_checksum,
        asset_manifest, created_by)
       values ($1,$2,$3,$4,$5,$6,'amazon','ATVPDKIKX0DER','amazon_feed_submit',$7,$8,$9,$10::jsonb,$11,'[]'::jsonb,$12)`,
      [feedPublicationRequestId, tenantId, accountId, capabilityId, listingId, firstVersionId,
        continuationBatchId, previewRequestId, "b".repeat(64), sourcePayload, "c".repeat(64), userId],
    );
    await database.client.unsafe(
      `insert into marketplace_publication_events
       (id, tenant_id, request_id, sequence, status, external_listing_id, external_state, actor_user_id)
       values ($1,$2,$3,1,'published','SKU-FEED-1','BUYABLE',$4)`,
      [createEntityId(), tenantId, feedPublicationRequestId, userId],
    );
    await database.client.unsafe(
      `insert into listings (id, tenant_id, spu_id, platform, marketplace_id, locale, status, created_by)
       values ($1,$2,$3,'etsy','etsy','en-US','approved',$4)`,
      [etsyListingId, tenantId, spuId, userId],
    );
    await database.client.unsafe(
      `insert into listing_versions
       (id, tenant_id, listing_id, version_number, rule_version, status, source, content, validation,
        created_by, approved_by, approved_at)
       values ($1,$2,$3,1,'etsy-2026.07','approved','human',$4::jsonb,
        '{"completeness":100,"blockers":[],"warnings":[]}'::jsonb,$5,$5,now())`,
      [etsyVersionId, tenantId, etsyListingId, JSON.stringify(etsyListingContent()), userId],
    );
    await database.client.unsafe(
      `update listings set primary_version_id = $1 where id = $2`,
      [etsyVersionId, etsyListingId],
    );
    await database.client.unsafe(
      `insert into marketplace_accounts
       (id, tenant_id, platform, display_name, external_account_id, region, marketplace_ids, authorization_mode,
        status, requested_scopes, granted_scopes, capabilities, credential_status, health_status,
        last_capability_sync_at, capability_expires_at, created_by)
       values ($1,$2,'etsy','Sync Etsy','9001','GLOBAL','["etsy"]'::jsonb,
        'etsy_oauth','active','["listings_r","listings_w"]'::jsonb,'["listings_r","listings_w"]'::jsonb,
        '["listing_read","listing_write","inventory_write"]'::jsonb,'valid','healthy',now(),now() + interval '24 hours',$3)`,
      [etsyAccountId, tenantId, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_capability_snapshots
       (id, tenant_id, account_id, version, platform, external_account_id, marketplace_ids, capabilities,
        source_version, source_checksum, data, synced_at, expires_at, created_by)
       values ($1,$2,$3,1,'etsy','9001','["etsy"]'::jsonb,
        '["listing_read","listing_write","inventory_write"]'::jsonb,'etsy-test','etsy-capability-checksum',
        '{}'::jsonb,now(),now() + interval '24 hours',$4)`,
      [etsyCapabilityId, tenantId, etsyAccountId, userId],
    );
    const etsySourcePayload = JSON.stringify(etsyPayload({
      title: "Originally published pillow",
      description: "Original description",
      tags: ["original"],
    }));
    await database.client.unsafe(
      `insert into marketplace_publication_requests
       (id, tenant_id, account_id, capability_snapshot_id, listing_id, listing_version_id, platform,
        marketplace_id, action, parent_request_id, source_external_listing_id, idempotency_key, payload,
        payload_checksum, asset_manifest, created_by)
       values
       ($1,$2,$3,$4,$5,$6,'etsy','etsy','etsy_create_draft',null,null,$7,$8::jsonb,$9,'[]'::jsonb,$10),
       ($11,$2,$3,$4,$5,$6,'etsy','etsy','etsy_activate',$1,'456',$12,$8::jsonb,$13,'[]'::jsonb,$10)`,
      [
        etsyDraftRequestId, tenantId, etsyAccountId, etsyCapabilityId, etsyListingId, etsyVersionId,
        "5".repeat(64), etsySourcePayload, "6".repeat(64), userId,
        etsyActivationRequestId, "7".repeat(64), "8".repeat(64),
      ],
    );
    await database.client.unsafe(
      `insert into marketplace_publication_events
       (id, tenant_id, request_id, sequence, status, external_listing_id, external_state, actor_user_id)
       values ($1,$2,$3,1,'published','456','active',$4)`,
      [createEntityId(), tenantId, etsyActivationRequestId, userId],
    );
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("pins content-aware checksums while preserving price/inventory-only semantics", async () => {
    const base = {
      accountId,
      listingId,
      listingVersionId: firstVersionId,
      sourcePublicationRequestId: publicationRequestId,
      requestKey: "stable-sync-request",
    };
    const priceOnly = await service.create(context, { ...base, action: "read" });
    const full = await service.create(context, { ...base, action: "read_full_content" });
    expect(full.id).not.toBe(priceOnly.id);
    expect(full.desiredChecksum).not.toBe(priceOnly.desiredChecksum);

    const stored = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceListingSyncRequests).where(eq(marketplaceListingSyncRequests.id, full.id)),
    );
    expect(stored[0]?.desiredState).toMatchObject({
      content: {
        productType: "HOME",
        attributes: { item_name: [{ value: "Original pillow", marketplace_id: "ATVPDKIKX0DER" }] },
      },
      price: [{ currency: "USD" }],
      inventory: [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }],
    });

    const feedSource = await service.create(context, {
      ...base,
      sourcePublicationRequestId: feedPublicationRequestId,
      requestKey: "batch-feed-source",
      action: "read",
    });
    expect(feedSource.sourcePublicationRequestId).toBe(feedPublicationRequestId);
    expect(feedSource.externalListingId).toBe("SKU-FEED-1");

    await insertApprovedVersion(secondVersionId, 2, "Updated pillow");
    const updatedBase = { ...base, listingVersionId: secondVersionId };
    const repeatedPriceOnly = await service.create(context, { ...updatedBase, action: "read" });
    const updatedFull = await service.create(context, { ...updatedBase, action: "read_full_content" });
    expect(repeatedPriceOnly.id).toBe(priceOnly.id);
    expect(updatedFull.id).not.toBe(full.id);
    expect(updatedFull.desiredChecksum).not.toBe(full.desiredChecksum);
    expect(updatedFull.idempotencyKey).not.toBe(full.idempotencyKey);
  });

  it("guards both write actions, appends events, and isolates tenants", async () => {
    const input = {
      accountId,
      listingId,
      listingVersionId: secondVersionId,
      sourcePublicationRequestId: publicationRequestId,
    };
    const pricePush = await service.create(context, { ...input, action: "push_price_inventory", requestKey: "push-price" });
    const fullPush = await service.create(context, { ...input, action: "push_full_content", requestKey: "push-full" });
    expect(assertMarketplaceAllocations).toHaveBeenCalledTimes(2);
    expect(assertMarketplaceAllocations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      accountId,
      listingId,
      desired: [{ skuCode: "SKU-1", quantity: 7 }],
    }));
    expect((await service.events(context, fullPush.id)).map((event) => event.status)).toEqual(["queued"]);
    await expect(withTenant(database.db, context, (tx) =>
      tx.update(marketplaceListingSyncEvents).set({ status: "failed" }).where(eq(marketplaceListingSyncEvents.requestId, pricePush.id)),
    )).rejects.toThrow();
    await expect(service.get(otherContext, fullPush.id)).rejects.toMatchObject({ status: 404 });
    expect(await service.list(otherContext, { listingId, limit: 50 })).toEqual([]);
  });

  it("rebuilds full Etsy content from the current approved version", async () => {
    const request = await service.create(context, {
      accountId: etsyAccountId,
      listingId: etsyListingId,
      listingVersionId: etsyVersionId,
      sourcePublicationRequestId: etsyActivationRequestId,
      action: "read_full_content",
      requestKey: "etsy-current-approved-content",
    });
    const stored = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplaceListingSyncRequests).where(eq(marketplaceListingSyncRequests.id, request.id)),
    );
    expect(stored[0]?.desiredState).toMatchObject({
      content: {
        title: "Current approved pillow",
        description: "Current approved description",
        tags: ["current", "personalized"],
        taxonomyId: 42,
        shippingProfileId: 43,
        readinessStateId: 44,
        personalization: {
          instructions: "Enter the current approved name",
          required: true,
          maxAllowedCharacters: 24,
        },
      },
      price: { amount: 28.5, currency: "USD" },
      inventory: { quantity: 6 },
    });
  });

  async function insertApprovedVersion(versionId: string, versionNumber: number, title: string): Promise<void> {
    await database.client.unsafe(
      `insert into listing_versions
       (id, tenant_id, listing_id, version_number, rule_version, status, source, content, validation,
        created_by, approved_by, approved_at)
       values ($1,$2,$3,$4,'amazon-2026.07','approved','human',$5::jsonb,
        '{"completeness":100,"blockers":[],"warnings":[]}'::jsonb,$6,$6,now())`,
      [versionId, tenantId, listingId, versionNumber, JSON.stringify(listingContent(title)), userId],
    );
    await database.client.unsafe(
      `update listings set primary_version_id = $1, status = 'approved', updated_at = now() where id = $2`,
      [versionId, listingId],
    );
  }
});

function listingContent(title: string) {
  return {
    platform: "amazon",
    locale: "en-US",
    title,
    description: "Gift-ready pillow",
    bullets: ["Custom name"],
    tags: [],
    mainImageId: null,
    mediaAssetIds: [],
    variants: [{ skuId: createEntityId(), skuCode: "SKU-1", optionValues: {} }],
    attributes: {},
    compliance: { countryOfOrigin: "CN" },
    publication: {
      platform: "amazon",
      productType: "HOME",
      attributes: amazonPayload(title).attributes,
    },
  };
}

function amazonPayload(title: string) {
  return {
    platform: "amazon",
    marketplaceId: "ATVPDKIKX0DER",
    locale: "en-US",
    productType: "HOME",
    sku: "SKU-1",
    attributes: {
      item_name: [{ value: title, marketplace_id: "ATVPDKIKX0DER" }],
      purchasable_offer: [{ currency: "USD" }],
      fulfillment_availability: [{ fulfillment_channel_code: "DEFAULT", quantity: 7 }],
    },
  };
}

function etsyListingContent() {
  return {
    platform: "etsy",
    locale: "en-US",
    title: "Current approved pillow",
    description: "Current approved description",
    bullets: [],
    tags: ["personalized", "current"],
    mediaAssetIds: [],
    variants: [{ skuId: createEntityId(), skuCode: "ETSY-SKU-1", optionValues: {} }],
    attributes: {},
    compliance: { countryOfOrigin: "CN" },
    personalization: {
      enabled: true,
      instructions: "Enter the current approved name",
      required: true,
      maxAllowedCharacters: 24,
    },
    publication: {
      platform: "etsy",
      price: { amount: 28.5, currency: "USD" },
      quantity: 6,
      whoMade: "i_did",
      whenMade: "2020_2026",
      taxonomyId: 42,
      shippingProfileId: 43,
      readinessStateId: 44,
      isSupply: false,
    },
  };
}

function etsyPayload(overrides: { title: string; description: string; tags: string[] }) {
  return {
    platform: "etsy",
    marketplaceId: "etsy",
    locale: "en-US",
    ...overrides,
    price: { amount: 20, currency: "USD" },
    quantity: 2,
    whoMade: "someone_else",
    whenMade: "made_to_order",
    taxonomyId: 1,
    shippingProfileId: 2,
    readinessStateId: 3,
    isSupply: true,
  };
}
