import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Permission, ForbiddenError } from "@yummyai/authz";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import { SalesPlanFieldsSchema } from "@yummyai/contracts/catalog/sales-plan";
import { connectDatabase, withTenant, developmentEvents } from "@yummyai/database";
import { createStorageFromEnvironment } from "@yummyai/storage";
import { and, eq } from "drizzle-orm";
import { ListingService, DrizzleListingRepository } from "../listings/listing.service.js";
import { ProductDevelopmentService } from "./product-development.service.js";
import { SalesPlanService } from "./sales-plan.service.js";
import { SalesPackageService } from "./sales-package.service.js";
import { SalesPlanDeliveryService } from "./sales-plan-delivery.service.js";

describe.sequential("controlled listing delivery authorization and source pins", () => {
  if (
    process.env.E2E_ISOLATED_DAILY !== "1" ||
    !/^\/order_daily_e2e_[a-f0-9]{32}$/.test(
      new URL(process.env.DATABASE_URL ?? "postgres://invalid/invalid").pathname,
    )
  )
    throw new Error("Delivery integration requires disposable runner");
  const db = connectDatabase(),
    storage = createStorageFromEnvironment(),
    listings = new ListingService(new DrizzleListingRepository(db)),
    plans = new SalesPlanService(db, listings),
    products = new ProductDevelopmentService(db, storage),
    packages = new SalesPackageService(db, listings, storage),
    delivery = new SalesPlanDeliveryService(db, packages);
  const a: TenantContext = {
      tenantId: createEntityId(),
      userId: createEntityId(),
      permissions: Object.values(Permission),
      dataScope: "tenant",
    },
    b: TenantContext = { ...a, tenantId: createEntityId(), userId: createEntityId() };
  let planId: string;
  beforeAll(async () => {
    for (const c of [a, b]) {
      await db.client.unsafe(
        "insert into organizations(id,name,slug) values($1,'Delivery fixture',$2)",
        [c.tenantId, `delivery-${c.tenantId}`],
      );
      await db.client.unsafe(
        "insert into app_users(id,oidc_subject,email,display_name) values($1,$2,$3,'Delivery fixture')",
        [c.userId, c.userId, `${c.userId}@example.test`],
      );
    }
    const { spu } = await products.createSpu(a, {
      code: `DEL-${a.tenantId.slice(-8)}`,
      name: "Incomplete isolated custom pillow",
      idempotencyKey: randomUUID(),
    });
    const { plan } = await plans.create(a, {
      spuId: spu.id,
      fields: SalesPlanFieldsSchema.parse({
        name: "Delivery fixture",
        mode: "custom",
        fulfillment: "fbm",
      }),
      idempotencyKey: randomUUID(),
    });
    planId = plan.id;
  });
  afterAll(async () => {
    await db.client.end();
  }); // Disposable runner destroys DB/bucket/Redis in finally.
  it("shows explicit incomplete states without exposing another tenant", async () => {
    const state = await delivery.get(a, planId);
    expect(state.supported).toBe(false);
    expect(state.issues.map((i) => i.path)).toContain("listing");
    expect(state.skus).toEqual([]);
    await expect(delivery.get(b, planId)).rejects.toMatchObject({status:404});
    const limited = await delivery.get({ ...a, permissions: [Permission.ProductRead] }, planId);
    expect(limited.access.read).toBe(false);
    expect(limited.fingerprint).toBe("");
    expect(limited.copy).toBeNull();
  });
  it("rejects unauthorized review and malformed attestation before writing", async () => {
    const d = await delivery.get(a, planId),
      body = {
        expectedRevision: d.revision,
        expectedFingerprint: d.fingerprint,
        listingVersionId: createEntityId(),
        imageEvidence: [{ assetId: createEntityId(), kind: "finished_photo" }],
        checks: { skuFacts: true, customization: true, images: true, copyClaims: true },
        note: "Synthetic",
        idempotencyKey: randomUUID(),
      };
    await expect(
      delivery.review(
        { ...a, permissions: a.permissions.filter((p) => p !== Permission.ListingReview) },
        planId,
        body,
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      delivery.review(a, planId, { ...body, checks: { ...body.checks, images: false } }),
    ).rejects.toThrow();
    await expect(delivery.review(a, planId, body)).rejects.toThrow("核对依据已变化");
    const rows = await withTenant(db.db, a, (tx) =>
      tx
        .select()
        .from(developmentEvents)
        .where(
          and(
            eq(developmentEvents.resourceId, planId),
            eq(developmentEvents.action, "sales_plan.delivery_review"),
          ),
        ),
    );
    expect(rows).toEqual([]);
  });
  it("invalidates pinned content after plan changes and refuses fabricated package/review IDs", async () => {
    const previous = await delivery.get(a, planId),
      { plan } = await plans.get(a, planId);
    await plans.save(a, planId, {
      expectedRevision: plan.revision,
      fields: { ...plan.fields, customInstructions: "Changed requirements" },
      idempotencyKey: randomUUID(),
    });
    const current = await delivery.get(a, planId);
    expect(current.fingerprint).not.toBe(previous.fingerprint);
    expect(current.revision).toBe(previous.revision + 1);
    await expect(
      delivery.seal(a, planId, {
        reviewId: createEntityId(),
        skuId: createEntityId(),
        expectedFingerprint: current.fingerprint,
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toThrow("不存在");
    await expect(delivery.export(b, planId, createEntityId())).rejects.toThrow("不存在");
  });
});
