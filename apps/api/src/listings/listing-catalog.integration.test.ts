import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DrizzleListingRepository, ListingService } from "./listing.service.js";

describe("Listing catalog database aggregation", () => {
  const database = connectDatabase();
  const userId = createEntityId();
  const first = tenant(createEntityId(), userId);
  const second = tenant(createEntityId(), userId);
  const service = new ListingService(new DrizzleListingRepository(database));

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(`insert into organizations (id,name,slug) values ($1,'Listing A',$2),($3,'Listing B',$4)`, [first.tenantId, `listing-${first.tenantId}`, second.tenantId, `listing-${second.tenantId}`]);
    await database.client.unsafe(`insert into app_users (id,oidc_subject,email,display_name) values ($1,$2,$3,'Listing User')`, [userId, `listing-${userId}`, `${userId}@example.test`]);
    await seed(first, "MUG-A", "First tenant mug", 2);
    await seed(second, "MUG-B", "Second tenant mug", 1);
  });

  afterAll(async () => { await database.client.end(); });

  it("returns only the tenant's latest Listing version with real SPU and gate data", async () => {
    const result = await service.catalog(first, { q: "first tenant", locale: "en-US", completeness: "low", blockers: "with", sort: "versionNumber", direction: "desc", page: 1, limit: 25 });
    expect(result).toMatchObject({ total: 1, page: 1, pages: 1 });
    expect(result.items[0]).toMatchObject({ spuCode: "MUG-A", title: "First tenant mug V2", versionNumber: 2, completeness: 72, blockerCount: 1, hasMainImage: true });
    expect(result.items.some((item) => item.spuCode === "MUG-B")).toBe(false);
  });

  async function seed(context: TenantContext, code: string, title: string, versions: number) {
    const planId = createEntityId(); const spuId = createEntityId(); const listingId = createEntityId();
    await database.client.unsafe(`insert into product_plans (id,tenant_id,name,customization,created_by) values ($1,$2,$3,'{"fields":[]}'::jsonb,$4)`, [planId, context.tenantId, `${code} plan`, userId]);
    await database.client.unsafe(`insert into spus (id,tenant_id,product_plan_id,code,name,customization) values ($1,$2,$3,$4,$5,'{"fields":[]}'::jsonb)`, [spuId, context.tenantId, planId, code, `${code} product`]);
    await database.client.unsafe(`insert into listings (id,tenant_id,spu_id,platform,locale,created_by) values ($1,$2,$3,'amazon','en-US',$4)`, [listingId, context.tenantId, spuId, userId]);
    for (let version = 1; version <= versions; version += 1) {
      const content = { platform: "amazon", locale: "en-US", title: `${title} V${version}`, description: "Gift ready", bullets: ["Personalized"], tags: [], mainImageId: "asset-main", mediaAssetIds: ["asset-main"], variants: [], attributes: {}, compliance: {} };
      const validation = { completeness: version === 2 ? 72 : 100, blockers: version === 2 ? [{ severity: "blocker", code: "test.blocker", path: "attributes.brand", message: "Brand is required", ruleVersion: "amazon-test" }] : [], warnings: [] };
      await database.client.unsafe(`insert into listing_versions (id,tenant_id,listing_id,version_number,rule_version,content,validation,created_by) values ($1,$2,$3,$4,'amazon-test',$5::jsonb,$6::jsonb,$7)`, [createEntityId(), context.tenantId, listingId, version, JSON.stringify(content), JSON.stringify(validation), userId]);
    }
  }
});

function tenant(tenantId: string, userId: string): TenantContext { return { tenantId, userId, permissions: [], dataScope: "tenant" }; }
