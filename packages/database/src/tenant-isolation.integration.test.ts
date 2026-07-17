import { randomBytes } from "node:crypto";

import type { TenantContext } from "@yummyai/contracts";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assetFiles,
  connectDatabase,
  migrateDatabase,
  withTenant,
} from "./index.js";

function uuidV7(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());

  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function tenantContext(tenantId: string): TenantContext {
  return {
    tenantId,
    userId: uuidV7(),
    permissions: ["assets:read", "assets:write"],
    dataScope: "tenant",
  };
}

describe("tenant isolation", () => {
  const database = connectDatabase();
  const tenantA = tenantContext(uuidV7());
  const tenantB = tenantContext(uuidV7());
  const assetAId = uuidV7();
  const assetBId = uuidV7();

  beforeAll(async () => {
    await migrateDatabase(database);

    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, $2, $3), ($4, $5, $6)`,
      [tenantA.tenantId, "Tenant A", `tenant-a-${tenantA.tenantId}`, tenantB.tenantId, "Tenant B", `tenant-b-${tenantB.tenantId}`],
    );

    await withTenant(database.db, tenantA, (tx) =>
      tx.insert(assetFiles).values({
        id: assetAId,
        tenantId: tenantA.tenantId,
        objectKey: `authorized/${assetAId}`,
        assetDomain: "authorized",
        fileName: "tenant-a.png",
        mediaType: "image/png",
        byteSize: 10,
        checksumSha256: "a".repeat(64),
      }),
    );

    await withTenant(database.db, tenantB, (tx) =>
      tx.insert(assetFiles).values({
        id: assetBId,
        tenantId: tenantB.tenantId,
        objectKey: `research/${assetBId}`,
        assetDomain: "research",
        fileName: "tenant-b.png",
        mediaType: "image/png",
        byteSize: 20,
        checksumSha256: "b".repeat(64),
      }),
    );
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("prevents tenant A from reading tenant B records", async () => {
    const rows = await withTenant(database.db, tenantA, (tx) => tx.select().from(assetFiles));

    expect(rows.map((row) => row.id)).toEqual([assetAId]);
  });

  it("rejects a cross-tenant insert", async () => {
    await expect(
      withTenant(database.db, tenantA, (tx) =>
        tx.insert(assetFiles).values({
          id: uuidV7(),
          tenantId: tenantB.tenantId,
          objectKey: `research/${uuidV7()}`,
          assetDomain: "research",
          fileName: "forbidden.png",
          mediaType: "image/png",
          byteSize: 30,
          checksumSha256: "c".repeat(64),
        }),
      ),
    ).rejects.toThrow();
  });

  it("cannot update another tenant's row", async () => {
    const updated = await withTenant(database.db, tenantA, (tx) =>
      tx
        .update(assetFiles)
        .set({ fileName: "stolen.png" })
        .where(eq(assetFiles.id, assetBId))
        .returning({ id: assetFiles.id }),
    );

    expect(updated).toEqual([]);
  });

  it("cannot delete another tenant's row", async () => {
    const deleted = await withTenant(database.db, tenantA, (tx) =>
      tx.delete(assetFiles).where(eq(assetFiles.id, assetBId)).returning({ id: assetFiles.id }),
    );

    expect(deleted).toEqual([]);
  });

  it("applies tenant isolation to raw SQL", async () => {
    const result = await withTenant(database.db, tenantA, (tx) =>
      tx.execute(sql`select id from asset_files order by id`),
    );

    expect(result.map((row) => row.id)).toEqual([assetAId]);
  });
});
