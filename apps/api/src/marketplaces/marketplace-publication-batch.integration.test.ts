import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  marketplacePublicationBatches,
  marketplacePublicationEvents,
  marketplacePublicationIntents,
  marketplacePublicationRequests,
  marketplaceStoreNodeExecutions,
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
import { publicationNodePreviewFixture } from "./publication-node-preview.test-fixture.js";

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
  const fixture = publicationNodePreviewFixture(database);
  const publicationEnqueuer = new FakePublicationEnqueuer();
  const batchEnqueuer = new FakeBatchEnqueuer();
  const audit = new AuditService(database);
  let service: MarketplacePublicationBatchService;
  let tenantId: string;
  let userId: string;
  let context: TenantContext;
  let otherContext: TenantContext;
  let accountId: string;
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
    await fixture.initialize();
    tenantId = fixture.a.tenantId;
    userId = fixture.a.userId;
    const permissions = [Permission.ListingPublish, Permission.ListingRead, Permission.StoreRead];
    context = { tenantId, userId, permissions, dataScope: "tenant" };
    otherContext = { tenantId: fixture.foreign.tenantId, userId: fixture.foreign.userId, permissions, dataScope: "tenant" };
    const original = await fixture.bootstrapStore();
    accountId = original.store.id;
    const publications = new MarketplacePublicationService(database, publicationEnqueuer, audit, fixture.service);
    service = new MarketplacePublicationBatchService(database, publications, publicationEnqueuer, batchEnqueuer, audit);
    const heartbeat = await fixture.runNode(original.node.keys);
    const workspace = await fixture.service.workspace(await fixture.current(), accountId);
    await fixture.waitSavedHeartbeat(original.node.keys, heartbeat, {
      accountId, nodeId: original.node.nodeId, bindingRevision: workspace.binding.revision,
    });
    const planId = createEntityId();
    const spuId = createEntityId();
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
    const secondEtsyPlanId = createEntityId();
    const secondEtsySpuId = createEntityId();
    await database.client.unsafe(
      `insert into product_plans (id, tenant_id, name, status, source_report_ids, customization, created_by)
       values ($1, $2, 'Second Etsy batch plan', 'approved', '[]'::jsonb, '{"version":1,"fields":[]}'::jsonb, $3)`,
      [secondEtsyPlanId, tenantId, userId],
    );
    await database.client.unsafe(
      `insert into spus (id, tenant_id, product_plan_id, code, name, status, customization)
       values ($1, $2, $3, 'BATCH-ETSY-2', 'Second Etsy batch product', 'listing', '{"version":1,"fields":[]}'::jsonb)`,
      [secondEtsySpuId, tenantId, secondEtsyPlanId],
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
  }, 120_000);

  afterAll(async () => {
    try { await fixture.close(); }
    finally { await database.client.end(); }
  }, 120_000);

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
    expect(publicationEnqueuer.enqueue).not.toHaveBeenCalled();
    const intents = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationIntents)
      .where(inArray(marketplacePublicationIntents.requestId, requests.map((request) => request.id))));
    expect(intents).toHaveLength(2);
    expect(intents.every((intent) => intent.route === "node_preview" && intent.createdBy === userId &&
      intent.membershipId === fixture.a.membershipId && intent.authorityCeiling.permissions.includes(Permission.StoreRead))).toBe(true);
    expect(new Set(intents.map((intent) => intent.nodeExecutionId)).size).toBe(2);
    const executions = await withTenant(database.db, context, (tx) => tx.select().from(marketplaceStoreNodeExecutions)
      .where(inArray(marketplaceStoreNodeExecutions.id, intents.map((intent) => intent.nodeExecutionId!))));
    expect(executions).toHaveLength(2);
    for (const intent of intents) expect(executions.find((execution) => execution.id === intent.nodeExecutionId)).toMatchObject({
      accountId, createdBy: userId, membershipId: fixture.a.membershipId, state: "waiting_node",
      requestId: intent.requestKey, requestChecksum: intent.requestChecksum, input: { publicationRequestId: intent.requestId },
    });
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
    const intents = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationIntents)
      .where(inArray(marketplacePublicationIntents.requestId, first.items.map((item) => item.id))));
    expect(intents).toHaveLength(2);
    expect(intents.every((intent) => intent.route === "central" && intent.membershipId === fixture.a.membershipId)).toBe(true);
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
    for (const item of batch.items) expect((await fixture.publications.getPreview(context, item.id)).execution?.state).toBe("cancelled");
  });

  it("recovers idempotently after partial queue admission failure", async () => {
    const input = batchInput(variantIds[4]!, variantIds[5]!);
    const initial = await service.create(context, input);
    // Preserve the original historical provider-event boundary: this case tests
    // Feed admission recovery, not a synthetic claim of node validation I/O.
    await withTenant(database.db, context, (tx) => tx.insert(marketplacePublicationEvents).values(
      initial.items.map((item) => ({
        id: createEntityId(), tenantId, requestId: item.id, sequence: 2,
        status: "validation_passed" as const, externalListingId: item.id, externalState: "VALID", actorUserId: userId,
      })),
    ));
    const before = await withTenant(database.db, context, (tx) => tx.select({ id: marketplacePublicationBatches.id })
      .from(marketplacePublicationBatches));
    const batchCalls = batchEnqueuer.enqueue.mock.calls.length;
    const publicationCalls = publicationEnqueuer.enqueue.mock.calls.length;
    batchEnqueuer.enqueue.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(service.continue(context, initial.id)).rejects.toMatchObject({ status: 503 });
    const recovered = await service.continue(context, initial.id);
    const after = await withTenant(database.db, context, (tx) => tx.select({ id: marketplacePublicationBatches.id })
      .from(marketplacePublicationBatches));

    expect(after).toHaveLength(before.length + 1);
    expect(recovered.items).toHaveLength(2);
    expect(recovered).toMatchObject({ action: "continue", parentBatchId: initial.id, platform: "amazon" });
    expect(recovered.items.every((item) => item.action === "amazon_feed_submit")).toBe(true);
    expect(recovered.items.some((item) => item.current.status === "retry_pending")).toBe(true);
    expect(batchEnqueuer.enqueue).toHaveBeenCalledTimes(batchCalls + 2);
    expect(publicationEnqueuer.enqueue).toHaveBeenCalledTimes(publicationCalls);
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
