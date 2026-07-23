import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  marketplacePublicationEvents,
  marketplacePublicationRequests,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import {
  MarketplacePublicationService,
  type MarketplacePublicationEnqueuer,
} from "./marketplace-publication.service.js";

class FakeEnqueuer implements MarketplacePublicationEnqueuer {
  enqueue = vi.fn(async () => undefined);
}

describe("marketplace publication requests", () => {
  const database = connectDatabase();
  const enqueuer = new FakeEnqueuer();
  const service = new MarketplacePublicationService(database, enqueuer, new AuditService(database));
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
  const variantSkuId = createEntityId();
  const secondVariantSkuId = createEntityId();
  let validatedPreviewRequestId = "";
  let queuedPreviewRequestId = "";

  beforeAll(async () => {
    await migrateDatabase(database);
    const planId = createEntityId();
    const spuId = createEntityId();
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Publication tenant', $2), ($3, 'Other publication tenant', $4)`,
      [tenantId, `publication-${tenantId}`, otherTenantId, `other-publication-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Publication Admin')`,
      [userId, `publication-${userId}`, `${userId}@example.test`],
    );
    await database.client.unsafe(
      `insert into product_plans (id, tenant_id, name, status, source_report_ids, customization, created_by)
       values ($1, $2, 'Publication plan', 'approved', '[]'::jsonb, '{"version":1,"fields":[]}'::jsonb, $3)`,
      [planId, tenantId, userId],
    );
    await database.client.unsafe(
      `insert into spus (id, tenant_id, product_plan_id, code, name, status, customization)
       values ($1, $2, $3, 'PUB-1', 'Publication product', 'listing', '{"version":1,"fields":[]}'::jsonb)`,
      [spuId, tenantId, planId],
    );
    await database.client.unsafe(
      `insert into asset_files
       (id, tenant_id, owner_user_id, object_key, asset_domain, file_name, media_type, byte_size, checksum_sha256, rights_status)
       values ($1, $2, $3, $4, 'authorized', 'pillow.jpg', 'image/jpeg', 100, $5, 'approved')`,
      [assetId, tenantId, userId, `tenants/${tenantId}/authorized/${assetId}.jpg`, "a".repeat(64)],
    );
    await database.client.unsafe(
      `insert into marketplace_accounts
       (id, tenant_id, platform, display_name, external_account_id, region, marketplace_ids, authorization_mode,
        status, requested_scopes, granted_scopes, capabilities, credential_status, health_status,
        last_capability_sync_at, capability_expires_at, created_by)
       values ($1, $2, 'amazon', 'Publication Amazon', 'A1SELLER', 'NA', '["ATVPDKIKX0DER"]'::jsonb,
        'amazon_private', 'active', '["product-listing"]'::jsonb, '["product-listing"]'::jsonb,
        '["listing_read","listing_write"]'::jsonb, 'valid', 'healthy', now(), now() + interval '24 hours', $3)`,
      [accountId, tenantId, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_capability_snapshots
       (id, tenant_id, account_id, version, platform, external_account_id, marketplace_ids, capabilities,
        source_version, source_checksum, data, synced_at, expires_at, created_by)
       values ($1, $2, $3, 1, 'amazon', 'A1SELLER', '["ATVPDKIKX0DER"]'::jsonb,
        '["listing_read","listing_write"]'::jsonb, 'amazon-sellers-v1:2026-07', 'capability-checksum',
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
    await insertApprovedVersion(listingVersionId, 1);
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("pins one immutable tenant-scoped request and is idempotent before enqueue", async () => {
    const input = { accountId, listingId, listingVersionId, marketplaceId: "ATVPDKIKX0DER", variantSkuId };
    const first = await service.create(context, input);
    const second = await service.create(context, input);
    const secondVariant = await service.create(context, { ...input, variantSkuId: secondVariantSkuId });
    validatedPreviewRequestId = first.id;
    queuedPreviewRequestId = secondVariant.id;
    expect(second.id).toBe(first.id);
    expect(secondVariant.id).not.toBe(first.id);
    expect(secondVariant.idempotencyKey).not.toBe(first.idempotencyKey);
    expect(first).toMatchObject({
      accountId,
      capabilitySnapshotId: capabilityId,
      listingVersionId,
      action: "amazon_validation_preview",
      assetCount: 1,
      current: { status: "queued" },
    });
    expect(first.idempotencyKey).toMatch(/^[a-f0-9]{64}$/);
    expect(enqueuer.enqueue).toHaveBeenCalledTimes(3);
    expect(enqueuer.enqueue).toHaveBeenLastCalledWith({
      publicationRequestId: secondVariant.id,
      requestedBy: userId,
      tenantId,
    });

    const requests = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationRequests));
    const events = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationEvents));
    expect(requests).toHaveLength(2);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain("refreshToken");
    await expect(withTenant(database.db, context, (tx) =>
      tx.update(marketplacePublicationRequests).set({ marketplaceId: "mutated" }).where(eq(marketplacePublicationRequests.id, first.id)),
    )).rejects.toThrow();
    await expect(withTenant(database.db, context, (tx) =>
      tx.update(marketplacePublicationEvents).set({ status: "failed" }).where(eq(marketplacePublicationEvents.requestId, first.id)),
    )).rejects.toThrow();
    await expect(service.get(otherContext, first.id)).rejects.toMatchObject({ status: 404 });
  });

  it("creates one immutable Amazon submit child only after validation passes", async () => {
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(marketplacePublicationEvents).values({
        id: createEntityId(),
        tenantId,
        requestId: validatedPreviewRequestId,
        sequence: 2,
        status: "validation_passed",
        externalListingId: "PILLOW-1",
        externalState: "VALID",
        actorUserId: userId,
      });
    });

    const first = await service.continue(context, validatedPreviewRequestId);
    const second = await service.continue(context, validatedPreviewRequestId);
    expect(second.id).toBe(first.id);
    expect(first).toMatchObject({
      action: "amazon_submit",
      parentRequestId: validatedPreviewRequestId,
      sourceExternalListingId: null,
      capabilitySnapshotId: capabilityId,
      current: { status: "queued" },
    });
    const [stored] = await withTenant(database.db, context, (tx) =>
      tx.select().from(marketplacePublicationRequests)
        .where(eq(marketplacePublicationRequests.id, first.id))
        .limit(1),
    );
    expect(stored?.assetManifest).toEqual([expect.objectContaining({
      assetId,
      publicationRole: "listing_media",
      rank: 1,
    })]);
    const listingPublications = await service.list(context, { listingId, limit: 50 });
    expect(listingPublications.map((publication) => publication.id)).toEqual(expect.arrayContaining([
      validatedPreviewRequestId,
      queuedPreviewRequestId,
      first.id,
    ]));
    expect(await service.list(otherContext, { listingId, limit: 50 })).toEqual([]);
    await expect(service.continue(context, queuedPreviewRequestId)).rejects.toMatchObject({ status: 409 });
    await expect(service.continue(otherContext, validatedPreviewRequestId)).rejects.toMatchObject({ status: 404 });
  });

  it("rejects research-domain media before another publication is enqueued", async () => {
    const nextVersionId = createEntityId();
    await database.client.unsafe(`update asset_files set asset_domain = 'research' where id = $1`, [assetId]);
    await insertApprovedVersion(nextVersionId, 2);
    const calls = enqueuer.enqueue.mock.calls.length;
    await expect(service.create(context, {
      accountId,
      listingId,
      listingVersionId: nextVersionId,
      marketplaceId: "ATVPDKIKX0DER",
      variantSkuId,
    })).rejects.toMatchObject({ status: 422 });
    expect(enqueuer.enqueue).toHaveBeenCalledTimes(calls);
  });

  async function insertApprovedVersion(versionId: string, versionNumber: number): Promise<void> {
    const content = {
      platform: "amazon",
      locale: "en-US",
      title: "Personalized pillow",
      description: "Gift-ready pillow",
      bullets: ["Custom name"],
      tags: [],
      mainImageId: assetId,
      mediaAssetIds: [assetId],
      variants: [
        { skuId: variantSkuId, skuCode: "PILLOW-1", optionValues: { size: "small" } },
        { skuId: secondVariantSkuId, skuCode: "PILLOW-2", optionValues: { size: "large" } },
      ],
      attributes: { brand: "YummyAI" },
      compliance: { countryOfOrigin: "CN" },
      publication: {
        platform: "amazon",
        productType: "HOME",
        attributes: { item_name: [{ value: "Personalized pillow", marketplace_id: "ATVPDKIKX0DER" }] },
      },
    };
    await database.client.unsafe(
      `insert into listing_versions
       (id, tenant_id, listing_id, version_number, rule_version, status, source, content, validation, created_by, approved_by, approved_at)
       values ($1, $2, $3, $4, 'amazon-2026.07', 'approved', 'human', $5::jsonb,
        '{"completeness":100,"blockers":[],"warnings":[]}'::jsonb, $6, $6, now())`,
      [versionId, tenantId, listingId, versionNumber, JSON.stringify(content), userId],
    );
    await database.client.unsafe(
      `update listings set status = 'approved', primary_version_id = $1, updated_at = now() where id = $2`,
      [versionId, listingId],
    );
  }
});
