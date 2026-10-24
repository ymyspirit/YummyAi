import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  memberships,
  roles,
  membershipRoles,
  researchItems,
  developmentEvents,
  assetFiles,
  creativeDesignBatches,
} from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { SalesPlanService } from "./sales-plan.service.js";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw Error("Disposable reference fixture required");
describe("current reference options through native RLS and business owners", () => {
  const db = connectDatabase(),
    loader = new DatabaseMembershipContextLoader(db),
    catalog = new ProductDevelopmentService(db, createStorageFromEnvironment()),
    service = new SalesPlanService(db, new ListingService(new DrizzleListingRepository(db)));
  beforeAll(() => migrateDatabase(db));
  afterAll(() => db.client.end());
  async function fixture() {
    const tenantId = createEntityId(),
      userId = createEntityId(),
      otherId = createEntityId(),
      member = createEntityId(),
      role = createEntityId(),
      sub = randomUUID();
    const bootstrap: TenantContext = {
      tenantId,
      userId,
      permissions: Object.values(Permission),
      dataScope: "tenant",
    };
    await db.client.unsafe(
      "insert into organizations(id,name,slug) values($1,'Synthetic reference resolution',$2)",
      [tenantId, randomUUID()],
    );
    await db.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic reference owner'),($4,$5,$6,'Synthetic other owner')",
      [
        userId,
        sub,
        `${userId}@example.invalid`,
        otherId,
        randomUUID(),
        `${otherId}@example.invalid`,
      ],
    );
    await withTenant(db.db, bootstrap, async (tx) => {
      await tx.insert(memberships).values([
        { id: member, tenantId, userId, status: "active" },
        { id: createEntityId(), tenantId, userId: otherId, status: "active" },
      ]);
      await tx.insert(roles).values({
        id: role,
        tenantId,
        name: randomUUID(),
        permissions: Object.values(Permission),
        dataScope: "tenant",
      });
      await tx.insert(membershipRoles).values({ tenantId, membershipId: member, roleId: role });
    });
    const current = async () => {
      const c = await loader.load({ sub, tenant_id: tenantId });
      if (!c) throw Error("Missing membership");
      return c;
    };
    const actor = await current(),
      { spu } = await catalog.createSpu(actor, {
        code: `REF-${randomUUID().slice(0, 8)}`,
        name: "Synthetic reference product",
        idempotencyKey: randomUUID(),
      });
    const { plan } = await service.create(actor, {
      spuId: spu.id,
      fields: { name: "Synthetic reference plan", mode: "custom", fulfillment: "fbm" },
      idempotencyKey: randomUUID(),
    });
    return { actor, otherId, member, role, current, spu, plan };
  }
  it("resolves selected research beyond the default 500 without mutating a saved plan or event ledger", async () => {
    const f = await fixture(),
      ids = Array.from({ length: 501 }, () => createEntityId()),
      old = ids[0]!;
    await withTenant(db.db, f.actor, (tx) =>
      tx.insert(researchItems).values(
        ids.map((id, i) => ({
          id,
          tenantId: f.actor.tenantId,
          ownerUserId: f.actor.userId,
          platform: "amazon",
          marketplace: "US",
          normalizedUrl: `https://example.invalid/${id}`,
          latestTitle: `Synthetic research ${i}`,
          lastCapturedAt: new Date(1_600_000_000_000 + i * 1000),
        })),
      ),
    );
    const before = await withTenant(db.db, f.actor, (tx) =>
      tx.select({ id: developmentEvents.id }).from(developmentEvents),
    );
    expect((await service.options(f.actor)).researchItems.some((r) => r.id === old)).toBe(false);
    const resolved = await service.referenceOptions(f.actor, f.plan.id, { researchItemIds: [old] });
    expect(resolved.researchItems.find((r) => r.id === old)?.title).toBe("Synthetic research 0");
    expect(resolved.selection.researchItemIds).toEqual([old]);
    expect((await service.get(f.actor, f.plan.id)).plan.revision).toBe(1);
    expect(
      await withTenant(db.db, f.actor, (tx) =>
        tx.select({ id: developmentEvents.id }).from(developmentEvents),
      ),
    ).toEqual(before);
  });
  it("returns an accessible original artwork version after a later revision without replacing its reference", async () => {
    const f = await fixture(),
      payload = {
        code: `REF-ART-${randomUUID().slice(0, 8)}`,
        name: "Synthetic original artwork",
        mode: "personalized_text",
        customization: {
          version: 1,
          fields: [{ key: "name", type: "short_text", label: "Name", required: true }],
        },
        instructions: "Synthetic template",
        expectedVersion: 0,
        idempotencyKey: randomUUID(),
      };
    const { artwork: v1 } = await catalog.registerArtwork(f.actor, payload);
    const { artwork: v2 } = await catalog.registerArtwork(f.actor, {
      ...payload,
      name: "Synthetic revised artwork",
      expectedVersion: 1,
      idempotencyKey: randomUUID(),
    });
    expect(v2.version).toBe(2);
    expect((await service.options(f.actor)).artworks.map((a) => a.versionId)).not.toContain(
      v1.versionId,
    );
    const resolved = await service.referenceOptions(f.actor, f.plan.id, {
      artworkVersionIds: [v1.versionId],
    });
    expect(resolved.artworks.map((a) => a.versionId)).toContain(v1.versionId);
    expect(resolved.selection.artworkVersionIds).toEqual([v1.versionId]);
  });
  it("resolves selected asset and project metadata outside their default candidate windows", async () => {
    const f = await fixture(),
      ids = Array.from({ length: 501 }, () => createEntityId()),
      old = ids[0]!;
    await withTenant(db.db, f.actor, async (tx) => {
      await tx
        .insert(assetFiles)
        .values(
          ids.map((id, i) => ({
            id,
            tenantId: f.actor.tenantId,
            ownerUserId: f.actor.userId,
            objectKey: `authorized/synthetic/${id}`,
            assetDomain: "authorized",
            rightsStatus: "approved",
            fileName: `Synthetic ${i}.png`,
            mediaType: "image/png",
            byteSize: 1,
            checksumSha256: "f".repeat(64),
            createdAt: new Date(1_600_000_000_000 + i * 1000),
          })),
        );
      await tx
        .insert(creativeDesignBatches)
        .values(
          ids.map((id, i) => ({
            id,
            tenantId: f.actor.tenantId,
            createdBy: f.actor.userId,
            name: `Synthetic project ${i}`,
            itemCount: 1,
            status: "cancelled" as const,
            requestChecksum: id.replaceAll("-", "").padEnd(64, "0"),
            createdAt: new Date(1_600_000_000_000 + i * 1000),
          })),
        );
    });
    const base = await service.options(f.actor);
    expect(base.assets.some((a) => a.id === old)).toBe(false);
    expect(base.projects.some((p) => p.id === old)).toBe(false);
    const resolved = await service.referenceOptions(f.actor, f.plan.id, {
      assetIds: [old],
      creativeProjectId: old,
    });
    expect(resolved.assets.find((a) => a.id === old)?.fileName).toBe("Synthetic 0.png");
    expect(resolved.projects.find((p) => p.id === old)?.name).toBe("Synthetic project 0");
    // Metadata resolution does not create source bytes, a model job, or production approval.
    expect((await service.get(f.actor, f.plan.id)).plan.revision).toBe(1);
  });
  it("does not turn supplied IDs into private source permission and permits an explicit repair", async () => {
    const f = await fixture(),
      id = createEntityId();
    await withTenant(db.db, f.actor, (tx) =>
      tx.insert(researchItems).values({
        id,
        tenantId: f.actor.tenantId,
        ownerUserId: f.otherId,
        platform: "amazon",
        marketplace: "US",
        normalizedUrl: `https://example.invalid/${id}`,
        latestTitle: "Synthetic confidential reference",
      }),
    );
    const { plan } = await service.save(f.actor, f.plan.id, {
      fields: { ...f.plan.fields, researchItemIds: [id] },
      expectedRevision: 1,
      idempotencyKey: randomUUID(),
    });
    await withTenant(db.db, f.actor, async (tx) => {
      await tx
        .update(roles)
        .set({
          permissions: Object.values(Permission).filter((p) => p !== Permission.ResearchRead),
        })
        .where(eq(roles.id, f.role));
      const r = createEntityId();
      await tx.insert(roles).values({
        id: r,
        tenantId: f.actor.tenantId,
        name: randomUUID(),
        permissions: [Permission.ResearchRead],
        dataScope: "self",
      });
      await tx
        .insert(membershipRoles)
        .values({ tenantId: f.actor.tenantId, membershipId: f.member, roleId: r });
    });
    const resolved = await service.referenceOptions(f.actor, plan.id, { researchItemIds: [id] });
    expect(resolved.researchItems).toEqual([]);
    expect(JSON.stringify(resolved)).not.toContain("Synthetic confidential reference");
    expect((await service.get(f.actor, plan.id)).plan.fields.researchItemIds).toEqual([id]);
    await expect(
      service.save(f.actor, plan.id, {
        fields: plan.fields,
        expectedRevision: plan.revision,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    const repaired = await service.save(f.actor, plan.id, {
      fields: { ...plan.fields, researchItemIds: [] },
      expectedRevision: plan.revision,
      idempotencyKey: randomUUID(),
    });
    expect(repaired.plan.fields.researchItemIds).toEqual([]);
  });
  it("denies cross-tenant parent access and rejects execution parameters in a read-only selection request", async () => {
    const a = await fixture(),
      b = await fixture();
    await expect(service.referenceOptions(b.actor, a.plan.id, {})).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.referenceOptions(a.actor, a.plan.id, { executionContract: { permissions: ["*"] } }),
    ).rejects.toThrow();
  });
});
