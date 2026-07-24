import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzlePublicationExecutionRepository } from "./marketplace-publication.processor.js";

describe("marketplace publication account lease", () => {
  const database = connectDatabase();
  const tenantId = createEntityId();
  const userId = createEntityId();
  const accountId = createEntityId();
  const firstRequestId = createEntityId();
  const secondRequestId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [],
    dataScope: "tenant",
  };
  const repository = new DrizzlePublicationExecutionRepository(database, undefined as never, undefined as never);

  beforeAll(async () => {
    await migrateDatabase(database);
    const planId = createEntityId();
    const spuId = createEntityId();
    const listingId = createEntityId();
    const listingVersionId = createEntityId();
    const capabilityId = createEntityId();
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Publication lease tenant', $2)`,
      [tenantId, `publication-lease-${tenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Lease operator')`,
      [userId, `publication-lease-${userId}`, `${userId}@example.test`],
    );
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
        'amazon_private', 'active', '[]'::jsonb, '[]'::jsonb, '["listing_write"]'::jsonb,
        'valid', 'healthy', $4)`,
      [accountId, tenantId, `SELLER-${accountId}`, userId],
    );
    await database.client.unsafe(
      `insert into marketplace_capability_snapshots
       (id, tenant_id, account_id, version, platform, external_account_id, marketplace_ids, capabilities,
        source_version, source_checksum, data, synced_at, expires_at, created_by)
       values ($1, $2, $3, 1, 'amazon', $4, '["ATVPDKIKX0DER"]'::jsonb, '["listing_write"]'::jsonb,
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
    for (const [requestId, key] of [[firstRequestId, "a"], [secondRequestId, "b"]] as const) {
      await database.client.unsafe(
        `insert into marketplace_publication_requests
         (id, tenant_id, account_id, capability_snapshot_id, listing_id, listing_version_id, platform,
          marketplace_id, action, idempotency_key, payload, payload_checksum, asset_manifest, created_by)
         values ($1, $2, $3, $4, $5, $6, 'amazon', 'ATVPDKIKX0DER', 'amazon_validation_preview',
          $7, '{}'::jsonb, $8, '[]'::jsonb, $9)`,
        [requestId, tenantId, accountId, capabilityId, listingId, listingVersionId, key.repeat(64), key.repeat(64), userId],
      );
    }
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
});
