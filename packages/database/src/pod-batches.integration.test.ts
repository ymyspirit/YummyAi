import { randomBytes } from "node:crypto";

import type { TenantContext } from "@yummyai/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canvasPrintSpecVersions,
  connectDatabase,
  creativeDesignBatches,
  migrateDatabase,
  withTenant,
} from "./index.js";

function uuidV7() {
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

function context(tenantId: string): TenantContext {
  return { tenantId, userId: uuidV7(), permissions: ["design:read", "design:write", "design:review"], dataScope: "tenant" };
}

describe("POD batch workflow persistence", () => {
  const database = connectDatabase();
  const tenantA = context(uuidV7());
  const tenantB = context(uuidV7());
  const specAId = uuidV7();
  const specBId = uuidV7();
  const batchId = uuidV7();

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      "insert into organizations (id, name, slug) values ($1, $2, $3), ($4, $5, $6)",
      [tenantA.tenantId, "POD Tenant A", `pod-a-${tenantA.tenantId}`, tenantB.tenantId, "POD Tenant B", `pod-b-${tenantB.tenantId}`],
    );
    await withTenant(database.db, tenantA, (tx) => tx.insert(canvasPrintSpecVersions).values(spec(specAId, tenantA.tenantId)));
    await withTenant(database.db, tenantB, (tx) => tx.insert(canvasPrintSpecVersions).values(spec(specBId, tenantB.tenantId)));
    await withTenant(database.db, tenantA, (tx) => tx.insert(creativeDesignBatches).values({
      id: batchId,
      tenantId: tenantA.tenantId,
      name: "Locked creative input",
      itemCount: 1,
      requestChecksum: "a".repeat(64),
    }));
  });

  afterAll(async () => database.client.end());

  it("forces tenant isolation for new versioned entities", async () => {
    const visible = await withTenant(database.db, tenantA, (tx) => tx.select({ id: canvasPrintSpecVersions.id }).from(canvasPrintSpecVersions));
    expect(visible.map((row) => row.id)).toEqual([specAId]);

    const crossTenantUpdate = await withTenant(database.db, tenantA, (tx) => tx.update(canvasPrintSpecVersions)
      .set({ name: "Cross-tenant overwrite" })
      .where(eq(canvasPrintSpecVersions.id, specBId))
      .returning({ id: canvasPrintSpecVersions.id }));
    expect(crossTenantUpdate).toEqual([]);
  });

  it("keeps submitted batch inputs immutable while allowing progress fields", async () => {
    await expect(withTenant(database.db, tenantA, (tx) => tx.update(creativeDesignBatches)
      .set({ name: "Overwritten input" })
      .where(eq(creativeDesignBatches.id, batchId)))).rejects.toThrow();
    const [preserved] = await withTenant(database.db, tenantA, (tx) => tx.select({ name: creativeDesignBatches.name })
      .from(creativeDesignBatches).where(eq(creativeDesignBatches.id, batchId)));
    expect(preserved?.name).toBe("Locked creative input");

    const [updated] = await withTenant(database.db, tenantA, (tx) => tx.update(creativeDesignBatches)
      .set({ generatedCount: 1, status: "awaiting_review" })
      .where(eq(creativeDesignBatches.id, batchId))
      .returning());
    expect(updated?.generatedCount).toBe(1);
  });

  it("prevents overwriting an approved print specification version", async () => {
    await withTenant(database.db, tenantA, (tx) => tx.update(canvasPrintSpecVersions)
      .set({ status: "approved", reviewedAt: new Date() })
      .where(eq(canvasPrintSpecVersions.id, specAId)));

    await expect(withTenant(database.db, tenantA, (tx) => tx.update(canvasPrintSpecVersions)
      .set({ targetDpi: 150 })
      .where(eq(canvasPrintSpecVersions.id, specAId)))).rejects.toThrow();
    const [preserved] = await withTenant(database.db, tenantA, (tx) => tx.select({ targetDpi: canvasPrintSpecVersions.targetDpi })
      .from(canvasPrintSpecVersions).where(eq(canvasPrintSpecVersions.id, specAId)));
    expect(preserved?.targetDpi).toBe(300);
  });
});

function spec(id: string, tenantId: string) {
  return {
    id,
    tenantId,
    specId: uuidV7(),
    versionNumber: 1,
    name: "Canvas 4:3",
    aspectWidth: 4,
    aspectHeight: 3,
    targetDpi: 300,
    bleedMm: "30",
    safeZoneMm: "15",
    wrapMode: "extend" as const,
    physicalSizes: [{ key: "400x300", label: "400 × 300 mm", widthMm: 400, heightMm: 300 }],
  };
}
