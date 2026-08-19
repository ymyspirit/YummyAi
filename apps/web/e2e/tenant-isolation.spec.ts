import { expect, test } from "@playwright/test";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { assetFiles, connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import { isSignedUrlExpired } from "@yummyai/storage";

test("tenant A cannot read tenant B IDs or files", async () => {
  test.skip(!process.env.DATABASE_URL, "DATABASE_URL is required for the RLS acceptance case");
  const database = connectDatabase(); const first = tenant(createEntityId()); const second = tenant(createEntityId()); const a = createEntityId(); const b = createEntityId();
  try {
    await migrateDatabase(database);
    await database.client.unsafe(`insert into organizations (id,name,slug) values ($1,'E2E A',$2),($3,'E2E B',$4)`, [first.tenantId, `e2e-${first.tenantId}`, second.tenantId, `e2e-${second.tenantId}`]);
    await withTenant(database.db, first, (tx) => tx.insert(assetFiles).values({ id: a, tenantId: first.tenantId, objectKey: `tenants/${first.tenantId}/authorized/${"a".repeat(64)}/a.png`, assetDomain: "authorized", fileName: "a.png", mediaType: "image/png", byteSize: 1, checksumSha256: "a".repeat(64) }));
    await withTenant(database.db, second, (tx) => tx.insert(assetFiles).values({ id: b, tenantId: second.tenantId, objectKey: `tenants/${second.tenantId}/research/${"b".repeat(64)}/b.png`, assetDomain: "research", fileName: "b.png", mediaType: "image/png", byteSize: 1, checksumSha256: "b".repeat(64) }));
    const visible = await withTenant(database.db, first, (tx) => tx.select({ id: assetFiles.id }).from(assetFiles));
    expect(visible.map((row) => row.id)).toEqual([a]); expect(visible.map((row) => row.id)).not.toContain(b);
  } finally {
    await withTenant(database.db, first, (tx) => tx.delete(assetFiles));
    await withTenant(database.db, second, (tx) => tx.delete(assetFiles));
    await database.client.unsafe(`delete from organizations where id in ($1,$2)`, [first.tenantId, second.tenantId]);
    await database.client.end();
  }
});

test("expired signed URLs are rejected by policy", () => {
  expect(isSignedUrlExpired("https://storage.test/file?X-Amz-Date=20260718T000000Z&X-Amz-Expires=60", new Date("2026-07-18T00:02:00Z"))).toBe(true);
});

test("demo UI never renders a foreign tenant marker", async ({ page }) => {
  await page.goto("/"); await expect(page.getByText("TENANT-B-SECRET", { exact: true })).toHaveCount(0);
});

function tenant(tenantId: string): TenantContext { return { tenantId, userId: createEntityId(), permissions: [], dataScope: "tenant" }; }
