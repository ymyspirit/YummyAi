import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { Permission } from "@yummyai/authz";
import { connectDatabase, migrateDatabase, marketplaceAccounts, marketplacePublicationBatches, marketplacePublicationIntents,
  marketplacePublicationRequests, marketplacePublicationEvents,
  memberships, roles, membershipRoles, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import { DrizzlePublicationExecutionRepository } from "./marketplace-publication.processor.js";

describe.sequential("marketplace publication account lease", () => {
  const database = connectDatabase();
  const tenantId = createEntityId();
  const userId = createEntityId();
  const accountId = createEntityId();
  const firstRequestId = createEntityId();
  const secondRequestId = createEntityId();
  const scheduledRequestId = createEntityId();
  const reconciliationRequestId = createEntityId();
  const listingId = createEntityId();
  const listingVersionId = createEntityId();
  const capabilityId = createEntityId();
  const membershipId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.ListingRead, Permission.ListingPublish, Permission.StoreRead],
    dataScope: "tenant",
  };
  const repository = new DrizzlePublicationExecutionRepository(database, undefined as never, undefined as never);

  beforeAll(async () => {
    await migrateDatabase(database);
    const planId = createEntityId();
    const spuId = createEntityId();
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Publication lease tenant', $2)`,
      [tenantId, `publication-lease-${tenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Lease operator')`,
      [userId, `publication-lease-${userId}`, `${userId}@example.test`],
    );
    await withTenant(database.db, context, async tx => {
      const roleId = createEntityId();
      await tx.insert(memberships).values({ id: membershipId, tenantId, userId, status: "active" });
      await tx.insert(roles).values({ id: roleId, tenantId, name: `Synthetic publication authority ${roleId}`,
        permissions: context.permissions, dataScope: "tenant" });
      await tx.insert(membershipRoles).values({ tenantId, membershipId, roleId });
    });
    await database.client.unsafe(
      `insert into product_plans (id, tenant_id, name, status, source_report_ids, customization, created_by)
       values ($1, $2, 'Lease plan', 'approved', '[]'::jsonb, '{"version":1,"fields":[]}'::jsonb, $3)`,
      [planId, tenantId, userId],
    );
    await database.client.unsafe(
      `insert into spus (id, tenant_id, product_plan_id, code, name, status, customization)
       values ($1, $2, $3, $4, 'Lease product', 'listing', '{"version":1,"fields":[]}'::jsonb)`,
      [spuId, tenantId, planId, `LEASE-${spuId}`],
    );
    await database.client.unsafe(
      `insert into marketplace_accounts
       (id, tenant_id, platform, display_name, external_account_id, region, marketplace_ids, authorization_mode,
        status, requested_scopes, granted_scopes, capabilities, credential_status, health_status, created_by)
       values ($1, $2, 'amazon', 'Lease Amazon', $3, 'NA', '["ATVPDKIKX0DER"]'::jsonb,
        'amazon_private', 'active', '[]'::jsonb, '[]'::jsonb, '["listing_read","listing_write"]'::jsonb,
        'valid', 'healthy', $4)`,
      [accountId, tenantId, `SELLER-${accountId}`, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_capability_snapshots
       (id, tenant_id, account_id, version, platform, external_account_id, marketplace_ids, capabilities,
        source_version, source_checksum, data, synced_at, expires_at, created_by)
       values ($1, $2, $3, 1, 'amazon', $4, '["ATVPDKIKX0DER"]'::jsonb, '["listing_read","listing_write"]'::jsonb,
        'lease-test', 'lease-checksum', '{}'::jsonb, now(), now() + interval '1 hour', $5)`,
      [capabilityId, tenantId, accountId, `SELLER-${accountId}`, userId],
    );
    await database.client.unsafe(
      `insert into listings (id, tenant_id, spu_id, platform, locale, status, created_by)
       values ($1, $2, $3, 'amazon', 'en-US', 'approved', $4)`,
      [listingId, tenantId, spuId, userId],
    );
    await database.client.unsafe(
      `insert into listing_versions
       (id, tenant_id, listing_id, version_number, rule_version, status, source, content, validation, created_by, approved_by, approved_at)
       values ($1, $2, $3, 1, 'lease-test', 'approved', 'human',
        '{"platform":"amazon","locale":"en-US","title":"Lease","description":"Lease","bullets":[],"tags":[],"mediaAssetIds":[],"variants":[],"attributes":{},"compliance":{},"publication":{"platform":"amazon","productType":"HOME","attributes":{}}}'::jsonb,
        '{"completeness":100,"blockers":[],"warnings":[]}'::jsonb, $4, $4, now())`,
      [listingVersionId, tenantId, listingId, userId],
    );
    await database.client.unsafe(
      `update listings set primary_version_id = $1 where id = $2`,
      [listingVersionId, listingId],
    );
    // Validation preview belongs to the store node; this queue owns central submissions.
    const scheduledPayload = {
      attributes: {},
      locale: "en-US",
      marketplaceId: "ATVPDKIKX0DER",
      platform: "amazon",
      productType: "HOME",
      sku: "SCHEDULED-SKU",
    } as const;
    const payloadText = JSON.stringify(scheduledPayload);
    const payloadChecksum = createHash("sha256").update(payloadText).digest("hex");
    const reconciliationPayload = {
      attributes: {},
      locale: "en-US",
      marketplaceId: "ATVPDKIKX0DER",
      platform: "amazon",
      productType: "HOME",
      sku: "RECONCILE-SKU",
    } as const;
    const reconciliationPayloadText = JSON.stringify(reconciliationPayload);
    const reconciliationPayloadChecksum = createHash("sha256").update(reconciliationPayloadText).digest("hex");
    const missingAssetManifest = [{
      assetId: createEntityId(),
      assetVersion: 1,
      assetDomain: "authorized" as const,
      rightsStatus: "approved" as const,
      checksumSha256: "e".repeat(64),
      objectKey: `tenants/${tenantId}/authorized/missing.jpg`,
      fileName: "missing.jpg",
      mediaType: "image/jpeg",
      publicationRole: "listing_media" as const,
      rank: 1,
    }];
    await withTenant(database.db, context, async tx => {
      // Saved synthetic preview history is the immutable parent evidence;
      // none of these previews is dispatched by the central Worker.
      for (const [requestId, key, payload, assetManifest] of [
        [firstRequestId, "a", scheduledPayload, []],
        [secondRequestId, "b", reconciliationPayload, missingAssetManifest],
      ] as const) {
        await tx.insert(marketplacePublicationRequests).values({
          id: requestId, tenantId, accountId, capabilitySnapshotId: capabilityId, listingId, listingVersionId,
          platform: "amazon", marketplaceId: "ATVPDKIKX0DER", action: "amazon_validation_preview",
          idempotencyKey: key.repeat(64), payload,
          payloadChecksum: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
          assetManifest: [...assetManifest], createdBy: userId,
        });
        await tx.insert(marketplacePublicationEvents).values([
          { id: createEntityId(), tenantId, requestId, sequence: 1, status: "queued", actorUserId: userId },
          { id: createEntityId(), tenantId, requestId, sequence: 2, status: "processing", actorUserId: userId },
          { id: createEntityId(), tenantId, requestId, sequence: 3, status: "validation_passed",
            externalListingId: payload.sku, externalState: "VALID", actorUserId: userId },
        ]);
      }
    });
    await database.client.unsafe(
      `insert into marketplace_publication_requests
       (id, tenant_id, account_id, capability_snapshot_id, listing_id, listing_version_id, platform,
        marketplace_id, action, parent_request_id, idempotency_key, payload, payload_checksum, asset_manifest, scheduled_for, created_by)
       values ($1, $2, $3, $4, $5, $6, 'amazon', 'ATVPDKIKX0DER', 'amazon_submit',
        $7, $8, $9::jsonb, $10, '[]'::jsonb, now() - interval '1 second', $11)`,
      [scheduledRequestId, tenantId, accountId, capabilityId, listingId, listingVersionId, firstRequestId, "c".repeat(64), payloadText, payloadChecksum, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_publication_events
       (id, tenant_id, request_id, sequence, status, actor_user_id)
       values ($1, $2, $3, 1, 'scheduled', $4)`,
      [createEntityId(), tenantId, scheduledRequestId, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_publication_requests
       (id, tenant_id, account_id, capability_snapshot_id, listing_id, listing_version_id, platform,
        marketplace_id, action, parent_request_id, idempotency_key, payload, payload_checksum, asset_manifest, created_by)
       values ($1, $2, $3, $4, $5, $6, 'amazon', 'ATVPDKIKX0DER', 'amazon_submit', $7,
        $8, $9::jsonb, $10, $11::jsonb, $12)`,
      [
        reconciliationRequestId,
        tenantId,
        accountId,
        capabilityId,
        listingId,
        listingVersionId,
        secondRequestId,
        "d".repeat(64),
        reconciliationPayloadText,
        reconciliationPayloadChecksum,
        JSON.stringify(missingAssetManifest),
        userId,
      ],
    );
    await database.client.unsafe(
      `insert into marketplace_publication_events
       (id, tenant_id, request_id, sequence, status, external_listing_id, external_state, actor_user_id)
       values
        ($1, $2, $3, 1, 'submission_accepted', 'RECONCILE-SKU', 'ACCEPTED', $4),
        ($5, $2, $3, 2, 'sync_pending', 'RECONCILE-SKU', 'PROCESSING', $4)`,
      [createEntityId(), tenantId, reconciliationRequestId, userId, createEntityId()],
    );
    await withTenant(database.db, context, async tx => {
      const [account] = await tx.select({ authorizationGeneration: marketplaceAccounts.authorizationGeneration })
        .from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)).limit(1);
      if (!account) throw new Error("Synthetic publication account is missing");
      await tx.insert(marketplacePublicationIntents).values([scheduledRequestId, reconciliationRequestId].map(requestId => ({
        id: createEntityId(), tenantId, requestId, createdBy: userId, membershipId,
        authorityCeiling: context, authorizationGeneration: account.authorizationGeneration, route: "central" as const,
      })));
    });
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("serializes different requests for the same tenant account", async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });

    const first = repository.withAccountLease(context, firstRequestId, async () => {
      order.push("first:start");
      firstEntered();
      await firstGate;
      order.push("first:end");
    });
    await entered;
    const second = repository.withAccountLease(context, secondRequestId, async () => {
      order.push("second:start");
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second:start"]);
  });

  it("records queued before processing when a scheduled central submission starts", async () => {
    await repository.withAccountLease(context, scheduledRequestId, async () => {
      await expect(repository.claim(context, scheduledRequestId, 0)).resolves.toMatchObject({
        requestId: scheduledRequestId,
        action: "amazon_submit",
      });

      const events = await database.client.unsafe<{ status: string }[]>(
        `select status from marketplace_publication_events where request_id = $1 order by sequence`,
        [scheduledRequestId],
      );
      expect(events.map((event) => event.status)).toEqual(["scheduled", "queued", "processing"]);

      const observedAt = "2026-07-24T12:00:00.000Z";
      await repository.complete(context, scheduledRequestId, {
        externalState: "ACCEPTED", externalListingId: "SCHEDULED-SKU", externalSubmissionId: "SCHEDULED-SUBMISSION",
        issues: [], quota: { platform: "amazon", windows: [{ scope: "second", limit: 5.5 }], observedAt },
        status: "submission_accepted", submittedAt: new Date(observedAt),
      });
      const published = { status: "published" as const, externalState: "LIVE", externalListingId: "SCHEDULED-SKU",
        externalSubmissionId: "SCHEDULED-SUBMISSION", issues: [], submittedAt: new Date() };
      await expect(repository.complete(context, scheduledRequestId, {
        ...published, externalSubmissionId: "UNRELATED-SUBMISSION",
      })).rejects.toThrow("publication_source_changed");
      // The normal first execution submits and then reads status inside the
      // same lease and claim; its accepted event must not require a new claim.
      await repository.complete(context, scheduledRequestId, published);
      const completed = await database.client.unsafe<{ status: string }[]>(
        `select status from marketplace_publication_events where request_id = $1 order by sequence`, [scheduledRequestId],
      );
      expect(completed.map(event => event.status)).toEqual(["scheduled", "queued", "processing", "submission_accepted", "published"]);
      const [quota] = await database.client.unsafe<Array<{ operation: string; platform: string; windows: unknown }>>(
        `select operation, platform, windows from marketplace_quota_snapshots where publication_request_id = $1`,
        [scheduledRequestId],
      );
      expect(quota).toEqual({ operation: "submission_accepted", platform: "amazon", windows: [{ scope: "second", limit: 5.5 }] });
    });
  });

  it("binds Feed-only status results to a fresh real lease and the original Feed ID", async () => {
    const feedRequestId = createEntityId(), originalFeedId = "FEED-ONLY-ORIGINAL";
    const payload = { attributes: {}, locale: "en-US", marketplaceId: "ATVPDKIKX0DER", platform: "amazon",
      productType: "HOME", sku: "FEED-ONLY-SKU" } as const;
    const previewBatchId = createEntityId(), feedBatchId = createEntityId();
    const batchItems = [
      { previewId: createEntityId(), requestId: feedRequestId, key: "1", childKey: "f", payload },
      { previewId: createEntityId(), requestId: createEntityId(), key: "2", childKey: "5",
        payload: { ...payload, sku: "FEED-SIBLING-SKU" } },
    ];
    await withTenant(database.db, context, async tx => {
      // A Feed is a real follow-up batch with at least two validated parents.
      // Preview history is seeded, never run on the central queue.
      await tx.insert(marketplacePublicationBatches).values({
        id: previewBatchId, tenantId, accountId, capabilitySnapshotId: capabilityId,
        platform: "amazon", marketplaceId: "ATVPDKIKX0DER", action: "initial",
        idempotencyKey: "3".repeat(64), itemCount: batchItems.length, createdBy: userId,
      });
      for (const item of batchItems) {
        await tx.insert(marketplacePublicationRequests).values({
          id: item.previewId, tenantId, accountId, capabilitySnapshotId: capabilityId, listingId, listingVersionId,
          platform: "amazon", marketplaceId: "ATVPDKIKX0DER", action: "amazon_validation_preview", batchId: previewBatchId,
          idempotencyKey: item.key.repeat(64), payload: item.payload,
          payloadChecksum: createHash("sha256").update(JSON.stringify(item.payload)).digest("hex"), assetManifest: [], createdBy: userId,
        });
        await tx.insert(marketplacePublicationEvents).values([
          { id: createEntityId(), tenantId, requestId: item.previewId, sequence: 1, status: "queued", actorUserId: userId },
          { id: createEntityId(), tenantId, requestId: item.previewId, sequence: 2, status: "processing", actorUserId: userId },
          { id: createEntityId(), tenantId, requestId: item.previewId, sequence: 3, status: "validation_passed",
            externalListingId: item.payload.sku, externalState: "VALID", actorUserId: userId },
        ]);
      }
      await tx.insert(marketplacePublicationBatches).values({
        id: feedBatchId, tenantId, accountId, capabilitySnapshotId: capabilityId,
        platform: "amazon", marketplaceId: "ATVPDKIKX0DER", action: "continue", parentBatchId: previewBatchId,
        idempotencyKey: "4".repeat(64), itemCount: batchItems.length, createdBy: userId,
      });
      for (const item of batchItems) {
        await tx.insert(marketplacePublicationRequests).values({ id: item.requestId, tenantId, accountId,
          capabilitySnapshotId: capabilityId, listingId, listingVersionId, platform: "amazon", marketplaceId: "ATVPDKIKX0DER",
          action: "amazon_feed_submit", batchId: feedBatchId, parentRequestId: item.previewId, idempotencyKey: item.childKey.repeat(64),
          payload: item.payload, payloadChecksum: createHash("sha256").update(JSON.stringify(item.payload)).digest("hex"), assetManifest: [], createdBy: userId });
        await tx.insert(marketplacePublicationEvents).values([
          { id: createEntityId(), tenantId, requestId: item.requestId, sequence: 1, status: "processing", actorUserId: userId },
          { id: createEntityId(), tenantId, requestId: item.requestId, sequence: 2, status: "submission_accepted",
            externalSubmissionId: originalFeedId, actorUserId: userId },
          { id: createEntityId(), tenantId, requestId: item.requestId, sequence: 3, status: "sync_pending",
            externalSubmissionId: originalFeedId, actorUserId: userId },
        ]);
      }
      const [account] = await tx.select({ authorizationGeneration: marketplaceAccounts.authorizationGeneration })
        .from(marketplaceAccounts).where(eq(marketplaceAccounts.id, accountId)).limit(1);
      if (!account) throw new Error("Synthetic publication account is missing");
      await tx.insert(marketplacePublicationIntents).values(batchItems.map(item => ({ id: createEntityId(), tenantId, requestId: item.requestId,
        createdBy: userId, membershipId, authorityCeiling: context, authorizationGeneration: account.authorizationGeneration, route: "central" as const })));
    });
    const pending = { status: "sync_pending" as const, externalSubmissionId: originalFeedId,
      externalState: "IN_PROGRESS", issues: [], submittedAt: new Date() };
    const published = { ...pending, status: "published" as const, externalState: "DONE" };
    await expect(repository.complete(context, feedRequestId, pending)).rejects.toThrow("publication_source_changed");
    let releaseLate!: () => void;
    const lateGate = new Promise<void>(resolve => { releaseLate = resolve; });
    let lateCompletion: Promise<void> | undefined;
    try {
      await repository.withAccountLease(context, feedRequestId, async () => {
        // Merely entering a lease cannot borrow the seeded historical claim.
        await expect(repository.complete(context, feedRequestId, pending)).rejects.toThrow("publication_source_changed");
        const claimed = await repository.claim(context, feedRequestId, 1);
        expect(claimed).toMatchObject({ requestId: feedRequestId, action: "amazon_feed_submit", resumeStatus: "sync_pending" });
        expect(claimed?.externalListingId).toBeUndefined();
        await expect(repository.complete(context, feedRequestId, {
          ...pending, externalSubmissionId: "UNRELATED-FEED",
        })).rejects.toThrow("publication_source_changed");
        await expect(repository.complete(context, feedRequestId, {
          ...pending, externalListingId: "UNPINNED-SKU",
        })).rejects.toThrow("publication_source_changed");
        await repository.complete(context, feedRequestId, pending);
        lateCompletion = lateGate.then(() => repository.complete(context, feedRequestId, published));
        void lateCompletion.catch(() => undefined);
      });
    } finally { releaseLate(); }
    if (!lateCompletion) throw new Error("Synthetic late lease callback is missing");
    await expect(lateCompletion).rejects.toThrow("publication_source_changed");
    // The previous AsyncLocalStorage scope and processing event expire with
    // their lease, even though the immutable accepted Feed ID is still valid.
    await expect(repository.complete(context, feedRequestId, published)).rejects.toThrow("publication_source_changed");
    await repository.withAccountLease(context, feedRequestId, async () => {
      await expect(repository.claim(context, feedRequestId, 2)).resolves.toMatchObject({ requestId: feedRequestId });
      await repository.complete(context, feedRequestId, published);
    });
    const completed = await database.client.unsafe<Array<{ status: string; external_listing_id: string | null; external_submission_id: string | null }>>(
      `select status, external_listing_id, external_submission_id from marketplace_publication_events where request_id = $1 order by sequence`,
      [feedRequestId],
    );
    expect(completed.map(event => event.status)).toEqual(["processing", "submission_accepted", "sync_pending", "processing", "sync_pending", "processing", "published"]);
    expect(completed.every(event => event.external_listing_id === null)).toBe(true);
    expect(completed.filter(event => event.status !== "processing").every(event => event.external_submission_id === originalFeedId)).toBe(true);
  });

  it("keeps an accepted mutation eligible for safe status reconciliation", async () => {
    await database.client.unsafe(
      `update marketplace_capability_snapshots
       set synced_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
       where id = $1`,
      [capabilityId],
    );
    await database.client.unsafe(
      `update listings set status = 'draft' where id = $1`,
      [listingId],
    );

    await repository.withAccountLease(context, reconciliationRequestId, async () => {
      await expect(repository.claim(context, reconciliationRequestId, 1)).resolves.toMatchObject({
        action: "amazon_submit",
        externalListingId: "RECONCILE-SKU",
        resumeStatus: "sync_pending",
      });
      const events = await database.client.unsafe<{ status: string }[]>(
        `select status from marketplace_publication_events where request_id = $1 order by sequence`,
        [reconciliationRequestId],
      );
      expect(events.map((event) => event.status)).toEqual([
        "submission_accepted",
        "sync_pending",
        "processing",
      ]);
      const statusResult = { status: "published" as const, externalListingId: "RECONCILE-SKU", externalState: "LIVE",
        issues: [], submittedAt: new Date() };
      await expect(repository.complete(context, reconciliationRequestId, {
        ...statusResult, externalListingId: "UNRELATED-SKU",
      })).rejects.toThrow("publication_source_changed");
      await expect(repository.complete(context, reconciliationRequestId, {
        ...statusResult, status: "submission_accepted",
      })).rejects.toThrow("publication_source_changed");
      const unchanged = await database.client.unsafe<{ status: string }[]>(
        `select status from marketplace_publication_events where request_id = $1 order by sequence`,
        [reconciliationRequestId],
      );
      expect(unchanged.map(event => event.status)).toEqual(["submission_accepted", "sync_pending", "processing"]);
      await repository.complete(context, reconciliationRequestId, statusResult);
      const completed = await database.client.unsafe<Array<{ status: string; external_listing_id: string | null }>>(
        `select status, external_listing_id from marketplace_publication_events where request_id = $1 order by sequence`,
        [reconciliationRequestId],
      );
      expect(completed.map(event => event.status)).toEqual(["submission_accepted", "sync_pending", "processing", "published"]);
      expect(completed[3]?.external_listing_id).toBe("RECONCILE-SKU");
    });
  });
});
