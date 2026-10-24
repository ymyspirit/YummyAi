import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  marketplacePublicationEvents,
  marketplacePublicationIntents,
  marketplacePublicationRequests,
  marketplaceQuotaSnapshots,
  marketplaceStoreNodeExecutions,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { MarketplaceAccountService } from "./marketplace-account.service.js";
import {
  MarketplacePublicationService,
  type MarketplacePublicationEnqueuer,
} from "./marketplace-publication.service.js";
import { publicationNodePreviewFixture } from "./publication-node-preview.test-fixture.js";

class FakeEnqueuer implements MarketplacePublicationEnqueuer {
  enqueue = vi.fn<MarketplacePublicationEnqueuer["enqueue"]>(async () => undefined);
  cancel = vi.fn<MarketplacePublicationEnqueuer["cancel"]>(async () => undefined);
}

describe("marketplace publication requests", () => {
  const database = connectDatabase();
  const fixture = publicationNodePreviewFixture(database);
  const enqueuer = new FakeEnqueuer();
  let service: MarketplacePublicationService;
  const accountService = new MarketplaceAccountService(database, new AuditService(database));
  let tenantId: string;
  let userId: string;
  let context: TenantContext;
  let otherContext: TenantContext;
  let accountId: string;
  let capabilityId: string;
  const listingId = createEntityId();
  const listingVersionId = createEntityId();
  const assetId = createEntityId();
  const variantSkuId = createEntityId();
  const secondVariantSkuId = createEntityId();
  const scheduledVariantSkuId = createEntityId();
  let validatedPreviewRequestId = "";
  let queuedPreviewRequestId = "";

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
    capabilityId = original.capabilityId;
    service = new MarketplacePublicationService(database, enqueuer, new AuditService(database), fixture.service);
    const heartbeat = await fixture.runNode(original.node.keys);
    const workspace = await fixture.service.workspace(await fixture.current(), accountId);
    await fixture.waitSavedHeartbeat(original.node.keys, heartbeat, {
      accountId, nodeId: original.node.nodeId, bindingRevision: workspace.binding.revision,
    });
    const planId = createEntityId();
    const spuId = createEntityId();
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
      `insert into listings (id, tenant_id, spu_id, platform, locale, status, created_by)
       values ($1, $2, $3, 'amazon', 'en-US', 'approved', $4)`,
      [listingId, tenantId, spuId, userId],
    );
    await insertApprovedVersion(listingVersionId, 1);
  }, 120_000);

  afterAll(async () => {
    try { await fixture.close(); }
    finally { await database.client.end(); }
  }, 120_000);

  it("pins one immutable tenant-scoped request and is idempotent before node dispatch", async () => {
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
    expect(enqueuer.enqueue).not.toHaveBeenCalled();

    const requests = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationRequests));
    const events = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationEvents));
    expect(requests).toHaveLength(2);
    expect(events).toHaveLength(2);
    const intents = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationIntents)
      .where(inArray(marketplacePublicationIntents.requestId, [first.id, secondVariant.id])));
    expect(intents).toHaveLength(2);
    expect(intents.every((intent) => intent.route === "node_preview" && intent.createdBy === userId &&
      intent.membershipId === fixture.a.membershipId && intent.authorityCeiling.permissions.includes(Permission.StoreRead))).toBe(true);
    expect(new Set(intents.map((intent) => intent.nodeExecutionId)).size).toBe(2);
    const executions = await withTenant(database.db, context, (tx) => tx.select().from(marketplaceStoreNodeExecutions)
      .where(inArray(marketplaceStoreNodeExecutions.id, intents.map((intent) => intent.nodeExecutionId!))));
    expect(executions).toHaveLength(2);
    for (const intent of intents) {
      expect(executions.find((execution) => execution.id === intent.nodeExecutionId)).toMatchObject({
        accountId, createdBy: userId, membershipId: fixture.a.membershipId, state: "waiting_node",
        requestId: intent.requestKey, requestChecksum: intent.requestChecksum,
        input: { publicationRequestId: intent.requestId },
      });
    }
    expect(JSON.stringify(requests)).not.toContain("refreshToken");
    await withTenant(database.db, context, async (tx) => {
      await tx.insert(marketplaceQuotaSnapshots).values([
        {
          id: createEntityId(),
          tenantId,
          accountId,
          platform: "amazon",
          operation: "validation_passed",
          publicationRequestId: first.id,
          listingSyncRequestId: null,
          windows: [{ scope: "second", limit: 4 }],
          observedAt: new Date("2026-07-24T10:00:00.000Z"),
        },
        {
          id: createEntityId(),
          tenantId,
          accountId,
          platform: "amazon",
          operation: "validation_passed",
          publicationRequestId: first.id,
          listingSyncRequestId: null,
          windows: [{ scope: "second", limit: 5.5 }],
          observedAt: new Date("2026-07-24T11:00:00.000Z"),
        },
      ]);
    });
    await expect(accountService.get(context, accountId)).resolves.toMatchObject({
      quota: {
        platform: "amazon",
        windows: [{ scope: "second", limit: 5.5 }],
        observedAt: "2026-07-24T11:00:00.000Z",
      },
    });
    expect((await accountService.list(context)).find((account) => account.id === accountId)?.quota)
      .toMatchObject({ windows: [{ limit: 5.5 }] });
    await expect(accountService.get(otherContext, accountId)).rejects.toMatchObject({ status: 404 });
    await expect(withTenant(database.db, context, (tx) =>
      tx.update(marketplacePublicationRequests).set({ marketplaceId: "mutated" }).where(eq(marketplacePublicationRequests.id, first.id)),
    )).rejects.toThrow();
    await expect(withTenant(database.db, context, (tx) =>
      tx.update(marketplacePublicationEvents).set({ status: "failed" }).where(eq(marketplacePublicationEvents.requestId, first.id)),
    )).rejects.toThrow();
    await expect(service.get(otherContext, first.id)).rejects.toMatchObject({ status: 404 });
  });

  it("delays a future publication and appends an immutable cancellation", async () => {
    const scheduledFor = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const scheduled = await service.create(context, {
      accountId,
      listingId,
      listingVersionId,
      marketplaceId: "ATVPDKIKX0DER",
      variantSkuId: scheduledVariantSkuId,
      scheduledFor,
    });
    expect(scheduled).toMatchObject({
      scheduledFor,
      current: { status: "scheduled" },
    });
    expect(enqueuer.enqueue).not.toHaveBeenCalled();
    const pending = await service.getPreview(context, scheduled.id);
    expect(pending.execution).toMatchObject({
      state: "waiting_node", expiresAt: new Date(Date.parse(scheduledFor) + 24 * 60 * 60 * 1_000).toISOString(),
    });

    const cancelled = await service.cancel(context, scheduled.id, { reason: "Campaign timing changed" });
    expect(cancelled.current).toMatchObject({
      status: "cancelled",
      code: "PUBLICATION_CANCELLED_BY_USER",
      message: "Campaign timing changed",
    });
    expect(enqueuer.cancel).toHaveBeenCalledWith(scheduled.id);
    expect((await service.getPreview(context, scheduled.id)).execution?.state).toBe("cancelled");
    expect((await service.events(context, scheduled.id)).map((event) => event.status))
      .toEqual(["scheduled", "cancelled"]);
    await expect(service.cancel(otherContext, scheduled.id, { reason: "Cross tenant" }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("creates one immutable Amazon submit child only after validation passes", async () => {
    // Historical provider event fixture: the real node preview HTTP path has its
    // own family; this case preserves the original owner's continuation gate.
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
    expect(enqueuer.enqueue).toHaveBeenCalledTimes(2);
    expect(enqueuer.enqueue).toHaveBeenLastCalledWith({
      delayMs: 0, publicationRequestId: first.id, requestedBy: userId, tenantId,
    });
    const [intent] = await withTenant(database.db, context, (tx) => tx.select().from(marketplacePublicationIntents)
      .where(eq(marketplacePublicationIntents.requestId, first.id)));
    expect(intent).toMatchObject({ route: "central", membershipId: fixture.a.membershipId, createdBy: userId });
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
        { skuId: scheduledVariantSkuId, skuCode: "PILLOW-3", optionValues: { size: "medium" } },
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
