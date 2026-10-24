import { randomUUID } from "node:crypto";
import { Permission } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  migrateDatabase,
  withTenant,
  memberships,
  roles,
  membershipRoles,
  productPlans,
  spus,
  researchItems,
} from "@yummyai/database";
import type { ListingDraft } from "@yummyai/platform-rules";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseMembershipContextLoader } from "../auth/tenant-context.guard.js";
import { DrizzleListingRepository, ListingService } from "./listing.service.js";
import { SalesPlanService } from "../catalog/sales-plan.service.js";
import { SalesPlanFieldsSchema } from "@yummyai/contracts/catalog/sales-plan";

if (
  process.env.E2E_ISOLATED_DAILY !== "1" ||
  !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(new URL(process.env.DATABASE_URL!).pathname)
)
  throw Error("Disposable listing authority fixture required");

describe("native Listing ownership, current permissions and review transactions", () => {
  const database = connectDatabase(),
    repository = new DrizzleListingRepository(database),
    dispatchListingApproved = vi.fn(async () => {}),
    service = new ListingService(repository, undefined, { dispatchListingApproved }),
    loader = new DatabaseMembershipContextLoader(database);
  beforeAll(() => migrateDatabase(database));
  afterAll(() => database.client.end());
  const content = (title = "Synthetic Listing"): ListingDraft => ({
    platform: "amazon",
    locale: "en-US",
    title,
    description: "Synthetic authority fixture",
    bullets: ["Synthetic owned content"],
    tags: [],
    mainImageId: "synthetic-main",
    mediaAssetIds: ["synthetic-main"],
    variants: [{ skuId: "synthetic-sku", skuCode: "SYNTHETIC", optionValues: {} }],
    attributes: { brand: "Synthetic" },
    compliance: { countryOfOrigin: "CN" },
  });

  async function fixture() {
    const tenantId = createEntityId(),
      userId = createEntityId(),
      otherId = createEntityId(),
      memberId = createEntityId(),
      subject = randomUUID();
    const admin: TenantContext = {
        tenantId,
        userId,
        dataScope: "tenant",
        permissions: Object.values(Permission),
      },
      other = { ...admin, userId: otherId };
    await database.client.unsafe(
      "insert into organizations(id,name,slug)values($1,'Synthetic Listing authority',$2)",
      [tenantId, randomUUID()],
    );
    await database.client.unsafe(
      "insert into app_users(id,oidc_subject,email,display_name)values($1,$2,$3,'Synthetic Listing A'),($4,$5,$6,'Synthetic Listing B')",
      [
        userId,
        subject,
        `${userId}@example.invalid`,
        otherId,
        randomUUID(),
        `${otherId}@example.invalid`,
      ],
    );
    const ownSpu = createEntityId(),
      foreignSpu = createEntityId(),
      ownPlan = createEntityId(),
      foreignPlan = createEntityId();
    await withTenant(database.db, admin, async (tx) => {
      await tx.insert(memberships).values([
        { id: memberId, tenantId, userId, status: "active" },
        { id: createEntityId(), tenantId, userId: otherId, status: "active" },
      ]);
      await tx.insert(productPlans).values([
        {
          id: ownPlan,
          tenantId,
          name: "Synthetic own product",
          customization: { version: 1, fields: [] },
          createdBy: userId,
        },
        {
          id: foreignPlan,
          tenantId,
          name: "Synthetic confidential product name",
          customization: { version: 1, fields: [] },
          createdBy: otherId,
        },
      ]);
      await tx.insert(spus).values([
        {
          id: ownSpu,
          tenantId,
          productPlanId: ownPlan,
          code: "OWN",
          name: "Synthetic own product",
          customization: { version: 1, fields: [] },
        },
        {
          id: foreignSpu,
          tenantId,
          productPlanId: foreignPlan,
          code: "PRIVATE",
          name: "Synthetic confidential product name",
          customization: { version: 1, fields: [] },
        },
      ]);
    });
    const own = await service.create(admin, {
        spuId: ownSpu,
        platform: "amazon",
        marketplaceId: "OWN-US",
        locale: "en-US",
        content: content("Owned Listing snapshot"),
      }),
      foreign = await service.create(other, {
        spuId: foreignSpu,
        platform: "amazon",
        marketplaceId: "FOREIGN-US",
        locale: "en-US",
        content: content("Other Listing snapshot"),
      });
    const grant = async (permissions: string[], scope: "self" | "team" | "tenant") => {
      const id = createEntityId();
      await withTenant(database.db, admin, async (tx) => {
        await tx
          .insert(roles)
          .values({ id, tenantId, name: randomUUID(), permissions, dataScope: scope });
        await tx.insert(membershipRoles).values({ tenantId, membershipId: memberId, roleId: id });
      });
      return id;
    };
    const current = async () => {
      const context = await loader.load({ sub: subject, tenant_id: tenantId });
      if (!context) throw Error("Synthetic current membership missing");
      return context;
    };
    const scope = (id: string, next: "self" | "tenant") =>
      withTenant(database.db, admin, (tx) =>
        tx.update(roles).set({ dataScope: next }).where(eq(roles.id, id)),
      );
    const revoke = (id: string) =>
      withTenant(database.db, admin, (tx) =>
        tx.delete(membershipRoles).where(eq(membershipRoles.roleId, id)),
      );
    return { admin, other, own, foreign, ownSpu, foreignSpu, grant, current, scope, revoke };
  }

  it("preserves company reads without borrowing them for foreign writes or reviews", async () => {
    const f = await fixture();
    await f.grant([Permission.ProductRead, Permission.ListingRead], "tenant");
    await f.grant([Permission.ListingWrite, Permission.ListingReview], "self");
    const actor = await f.current();
    expect((await service.list(actor)).map((item) => item.id).sort()).toEqual(
      [f.own.listing.id, f.foreign.listing.id].sort(),
    );
    expect((await service.getWorkspace(actor, f.foreign.listing.id)).version.id).toBe(
      f.foreign.version.id,
    );
    for (const operation of [
      () =>
        service.saveVersion(
          actor,
          f.foreign.listing.id,
          content("Forbidden"),
          "human",
          f.foreign.version.id,
        ),
      () => service.archive(actor, f.foreign.listing.id),
      () => service.approveVersion(actor, f.foreign.listing.id, f.foreign.version.id),
    ])
      await expect(operation()).rejects.toMatchObject({ status: 404 });
    const saved = await service.saveVersion(
      actor,
      f.own.listing.id,
      content("Allowed own edit"),
      "human",
      f.own.version.id,
    );
    await expect(service.approveVersion(actor, f.own.listing.id, saved.id)).resolves.toMatchObject({
      id: saved.id,
      status: "approved",
    });
    expect((await service.getWorkspace(f.admin, f.foreign.listing.id)).history).toHaveLength(1);
  });

  it("filters catalog, versions and direct reads by the specific Listing permission", async () => {
    const f = await fixture();
    await f.grant([Permission.ListingRead], "self");
    await f.grant([Permission.ProductRead, Permission.CaptureRead], "tenant");
    const actor = await f.current();
    expect(
      (
        await service.catalog(actor, {
          q: "",
          completeness: "all",
          blockers: "all",
          sort: "updatedAt",
          direction: "desc",
          page: 1,
          limit: 25,
        })
      ).total,
    ).toBe(1);
    await expect(service.getWorkspace(actor, f.foreign.listing.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(service.listVersions(actor, f.foreign.listing.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(repository.listVersions(actor, f.foreign.listing.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(repository.get(actor, f.foreign.listing.id)).resolves.toBeUndefined();
  });

  it("does not reveal current private product labels through a broad Listing catalog", async () => {
    const f = await fixture();
    await f.grant([Permission.ListingRead], "tenant");
    await f.grant([Permission.ProductRead], "self");
    const actor = await f.current();
    const catalog = await service.catalog(actor, {
        q: "",
        completeness: "all",
        blockers: "all",
        sort: "updatedAt",
        direction: "desc",
        page: 1,
        limit: 25,
      }),
      foreign = catalog.items.find((item) => item.id === f.foreign.listing.id)!;
    expect(foreign).toMatchObject({
      productAccess: false,
      spuName: "",
      spuCode: "",
      title: "Other Listing snapshot",
    });
    expect(catalog.items.find((item) => item.id === f.own.listing.id)?.productAccess).toBe(true);
  });

  it("checks the actual parent when a writer creates a local Listing", async () => {
    const f = await fixture();
    await f.grant([Permission.ListingWrite, Permission.ProductRead], "self");
    await f.grant([Permission.CaptureRead], "tenant");
    const actor = await f.current();
    await expect(
      service.create(actor, {
        spuId: f.foreignSpu,
        platform: "amazon",
        marketplaceId: "DENIED",
        locale: "en-US",
        content: content(),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.create(actor, {
        spuId: f.ownSpu,
        platform: "amazon",
        marketplaceId: "ALLOWED",
        locale: "en-US",
        content: content(),
      }),
    ).resolves.toMatchObject({ listing: { ownerUserId: actor.userId } });
  });

  it("reloads narrowed and revoked writer grants inside the actual mutation path", async () => {
    const f = await fixture();
    await f.grant([Permission.ListingRead, Permission.ProductRead], "tenant");
    const writer = await f.grant([Permission.ListingWrite], "tenant"),
      stale = await f.current();
    await f.scope(writer, "self");
    await expect(
      service.saveVersion(
        stale,
        f.foreign.listing.id,
        content("Stale scope"),
        "human",
        f.foreign.version.id,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await f.revoke(writer);
    await expect(
      service.saveVersion(stale, f.own.listing.id, content("Revoked"), "human", f.own.version.id),
    ).rejects.toMatchObject({ status: 403 });
    expect((await service.getWorkspace(f.admin, f.own.listing.id)).history).toHaveLength(1);
  });

  it("rejects foreign and superseded approval targets before changing parent state", async () => {
    const f = await fixture();
    await expect(
      repository.approveVersion(f.admin, f.own.listing.id, f.foreign.version.id),
    ).rejects.toMatchObject({ status: 409 });
    const next = await service.saveVersion(
      f.admin,
      f.own.listing.id,
      content("New current draft"),
      "human",
      f.own.version.id,
    );
    await expect(
      service.approveVersion(f.admin, f.own.listing.id, f.own.version.id),
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.getWorkspace(f.admin, f.own.listing.id)).listing.status).toBe("draft");
    await expect(service.approveVersion(f.admin, f.own.listing.id, next.id)).resolves.toMatchObject(
      { id: next.id, status: "approved" },
    );
    expect((await service.getWorkspace(f.admin, f.foreign.listing.id)).listing.status).toBe(
      "draft",
    );
  });

  it("does not dispatch approval automation after the review grant is withdrawn", async () => {
    const f = await fixture();
    await f.grant([Permission.ListingRead], "tenant");
    const review = await f.grant([Permission.ListingReview], "tenant"),
      stale = await f.current();
    await f.revoke(review);
    dispatchListingApproved.mockClear();
    await expect(
      service.approveVersion(stale, f.own.listing.id, f.own.version.id),
    ).rejects.toMatchObject({ status: 403 });
    expect(dispatchListingApproved).not.toHaveBeenCalled();
    expect((await service.getWorkspace(f.admin, f.own.listing.id)).listing.status).toBe("draft");
  });

  it("replicates only a readable current approval and filters inaccessible target history", async () => {
    const f = await fixture();
    await service.approveVersion(f.admin, f.own.listing.id, f.own.version.id);
    await service.replicate(f.other, f.own.listing.id, {
      sourceVersionId: f.own.version.id,
      targetMarketplaceId: "OTHER-UK",
      targetLocale: "en-GB",
      overrides: { title: "Private target edit" },
    });
    await f.grant([Permission.ListingRead], "self");
    await f.grant([Permission.ListingWrite, Permission.ProductRead], "tenant");
    const actor = await f.current();
    expect(await service.listReplications(actor, f.own.listing.id)).toEqual([]);
    const own = await service.replicate(actor, f.own.listing.id, {
      sourceVersionId: f.own.version.id,
      targetMarketplaceId: "OWN-UK",
      targetLocale: "en-GB",
      overrides: { title: "Own target" },
    });
    expect(
      (await service.listReplications(actor, f.own.listing.id)).map((item) => item.id),
    ).toEqual([own.id]);
    const changed = await service.saveVersion(
      f.admin,
      f.own.listing.id,
      content("Approval replaced"),
      "human",
      f.own.version.id,
    );
    await expect(
      repository.createReplica(actor, {
        sourceListingId: f.own.listing.id,
        sourceVersionId: f.own.version.id,
        spuId: f.ownSpu,
        platform: "amazon",
        targetMarketplaceId: "STALE-UK",
        targetLocale: "en-GB",
        overrides: {},
        content: { ...content(), locale: "en-GB" },
        validation: changed.validation,
        ruleVersion: changed.ruleVersion,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("rechecks sales-plan source ownership before returning cached create or save results", async () => {
    const f = await fixture(),
      researchId = createEntityId();
    await withTenant(database.db, f.admin, (tx) =>
      tx.insert(researchItems).values({
        id: researchId,
        tenantId: f.admin.tenantId,
        ownerUserId: f.other.userId,
        platform: "amazon",
        marketplace: "US",
        normalizedUrl: `https://www.amazon.com/dp/${randomUUID()}`,
        latestTitle: "Synthetic confidential research",
      }),
    );
    await f.grant([Permission.ProductRead, Permission.ProductWrite], "tenant");
    const role = await f.grant([Permission.ResearchRead], "tenant"),
      actor = await f.current();
    const sales = new SalesPlanService(database, service);
    const create = {
      spuId: f.ownSpu,
      fields: SalesPlanFieldsSchema.parse({
        name: "Synthetic sales plan",
        mode: "custom",
        fulfillment: "fbm",
        researchItemIds: [researchId],
      }),
      idempotencyKey: randomUUID(),
    };
    const created = await sales.create(actor, create);
    expect((await sales.create(actor, create)).plan.id).toBe(created.plan.id);
    const save = {
      fields: { ...create.fields, positioning: "Synthetic saved positioning" },
      expectedRevision: created.plan.revision,
      idempotencyKey: randomUUID(),
    };
    const saved = await sales.save(actor, created.plan.id, save);
    expect((await sales.save(actor, created.plan.id, save)).plan.revision).toBe(
      saved.plan.revision,
    );
    await f.scope(role, "self");
    await expect(sales.create(actor, create)).rejects.toMatchObject({ status: 404 });
    await expect(sales.save(actor, created.plan.id, save)).rejects.toMatchObject({ status: 404 });
    expect((await sales.get(f.admin, created.plan.id)).plan.revision).toBe(saved.plan.revision);
  });

  it("checks the exact original Listing write scope before replaying a sales-plan draft receipt", async () => {
    const f = await fixture(),
      sales = new SalesPlanService(database, service);
    const created = await sales.create(f.admin, {
      spuId: f.ownSpu,
      fields: SalesPlanFieldsSchema.parse({
        name: "Synthetic sync plan",
        mode: "custom",
        fulfillment: "fbm",
        marketplaceId: "SYNC-US",
      }),
      idempotencyKey: randomUUID(),
    });
    const first = await sales.draft(f.other, created.plan.id, {
      expectedRevision: created.plan.revision,
      expectedListingVersionId: null,
      idempotencyKey: randomUUID(),
    });
    await f.grant([Permission.ProductRead, Permission.ListingRead], "tenant");
    const writer = await f.grant([Permission.ListingWrite], "tenant"),
      actor = await f.current();
    const input = {
      expectedRevision: created.plan.revision,
      expectedListingVersionId: first.listingVersionId,
      idempotencyKey: randomUUID(),
    };
    const receipt = await sales.draft(actor, created.plan.id, input);
    expect(await sales.draft(actor, created.plan.id, input)).toEqual(receipt);
    expect(await service.listVersions(f.admin, receipt.listingId)).toHaveLength(2);
    await f.scope(writer, "self");
    await expect(sales.draft(actor, created.plan.id, input)).rejects.toMatchObject({ status: 404 });
    expect(await service.listVersions(f.admin, receipt.listingId)).toHaveLength(2);
  });

  it("rechecks current sales-plan source reads before replaying a successful draft receipt", async () => {
    const f = await fixture(),
      researchId = createEntityId(),
      sales = new SalesPlanService(database, service);
    await withTenant(database.db, f.admin, (tx) =>
      tx
        .insert(researchItems)
        .values({
          id: researchId,
          tenantId: f.admin.tenantId,
          ownerUserId: f.other.userId,
          platform: "amazon",
          marketplace: "US",
          normalizedUrl: `https://www.amazon.com/dp/${randomUUID()}`,
          latestTitle: "Synthetic sync source",
        }),
    );
    await f.grant(
      [
        Permission.ProductRead,
        Permission.ProductWrite,
        Permission.ListingRead,
        Permission.ListingWrite,
      ],
      "tenant",
    );
    const research = await f.grant([Permission.ResearchRead], "tenant"),
      actor = await f.current();
    const { plan } = await sales.create(actor, {
      spuId: f.ownSpu,
      fields: SalesPlanFieldsSchema.parse({
        name: "Synthetic source sync",
        mode: "custom",
        fulfillment: "fbm",
        marketplaceId: "SOURCE-US",
        researchItemIds: [researchId],
      }),
      idempotencyKey: randomUUID(),
    });
    const input = {
      expectedRevision: plan.revision,
      expectedListingVersionId: null,
      idempotencyKey: randomUUID(),
    };
    const receipt = await sales.draft(actor, plan.id, input);
    expect(await sales.draft(actor, plan.id, input)).toEqual(receipt);
    await f.scope(research, "self");
    await expect(sales.draft(actor, plan.id, input)).rejects.toMatchObject({ status: 404 });
    expect(await service.listVersions(f.admin, receipt.listingId)).toHaveLength(1);
  });
});
