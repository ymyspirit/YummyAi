import { Permission } from "@yummyai/authz";
import { createEntityId, type CaptureDraft, type TenantContext } from "@yummyai/contracts";
import { auditEvents, connectDatabase, migrateDatabase, withTenant } from "@yummyai/database";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { ResearchClassificationService } from "../research/research-classification.service.js";
import { ResearchController } from "../research/research.controller.js";
import { ResearchRepository } from "../research/research.repository.js";
import { CaptureService, type CaptureMediaEnqueuer } from "./capture.service.js";

describe("capture ingestion and research library", () => {
  const database = connectDatabase();
  const tenantId = createEntityId();
  const userId = createEntityId();
  const otherTenantId = createEntityId();
  const otherUserId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.CaptureRead, Permission.CaptureWrite, Permission.ResearchRead],
    dataScope: "tenant",
  };
  const otherContext: TenantContext = { ...context, tenantId: otherTenantId, userId: otherUserId };
  const enqueuer: CaptureMediaEnqueuer = {
    async enqueue(input) {
      if (input.sourceUrl.includes("fail")) throw new Error("Synthetic media failure");
    },
  };
  const audit = new AuditService(database);
  const classifications = new ResearchClassificationService(database, audit);
  const service = new CaptureService(database, enqueuer, audit, classifications);
  const repository = new ResearchRepository(database);
  const controller = new ResearchController(repository, classifications);

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Capture tenant', $2), ($3, 'Other capture tenant', $4)`,
      [tenantId, `capture-${tenantId}`, otherTenantId, `capture-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Capture User'), ($4, $5, $6, 'Other Capture User')`,
      [
        userId,
        `capture-${userId}`,
        `${userId}@example.test`,
        otherUserId,
        `capture-${otherUserId}`,
        `${otherUserId}@example.test`,
      ],
    );
  });

  afterAll(async () => {
    try {
      await database.client.unsafe(
        `delete from audit_events where tenant_id in ($1, $2)`,
        [tenantId, otherTenantId],
      );
      await database.client.unsafe(
        `delete from organizations where id in ($1, $2)`,
        [tenantId, otherTenantId],
      );
      await database.client.unsafe(
        `delete from app_users where id in ($1, $2)`,
        [userId, otherUserId],
      );
    } finally {
      await database.client.end();
    }
  });

  it("creates an immutable second snapshot for the same normalized URL", async () => {
    const first = await service.createSnapshot(context, draft());
    const second = await service.createSnapshot(
      context,
      draft({
        sourceUrl: "https://www.amazon.com/dp/B000000001?ref=tracking#details",
        title: "Updated title",
        productInformation: [
          {
            name: "Item details",
            items: [{ label: "Brand Name", value: "Sample Studio", links: [] }],
          },
        ],
        shop: {
          platform: "amazon",
          externalId: "sample-studio",
          name: "Sample Studio",
          sourceUrl: "https://www.amazon.com/sp?seller=sample-studio",
          location: null,
          ownerName: null,
          rating: 4.8,
          reviewCount: 320,
          salesCount: null,
          activeListingCount: null,
          admirerCount: null,
          openedYear: null,
          yearsOnPlatform: null,
          badges: [],
        },
        capturedAt: new Date(Date.now() + 1_000).toISOString(),
      }),
    );

    expect(second.researchItemId).toBe(first.researchItemId);
    expect(second.snapshotId).not.toBe(first.snapshotId);
    await expect(repository.snapshotCount(context, first.researchItemId)).resolves.toBe(2);
    const timeline = await repository.timeline(context, first.researchItemId);
    expect(timeline.map((entry) => entry.title)).toEqual([
      "Updated title",
      "Personalized Sample Product",
    ]);
    expect(timeline[0]?.draft.shop?.name).toBe("Sample Studio");
    expect(timeline[0]?.draft.productInformation).toEqual([
      {
        name: "Item details",
        items: [{ label: "Brand Name", value: "Sample Studio", links: [] }],
      },
    ]);
    const library = await repository.list(context, { limit: 100 });
    expect(library.items.find((item) => item.id === first.researchItemId)?.shopName).toBe("Sample Studio");
  });

  it("records partial success when one included media job fails", async () => {
    const receipt = await service.createSnapshot(
      context,
      draft({
        sourceUrl: "https://www.etsy.com/listing/1729000001/sample",
        platform: "etsy",
        marketplace: "www.etsy.com",
        externalId: "1729000001",
        ehuntAnalysis: ehuntAnalysis(),
        media: [
          media("https://images.example.test/good.jpg", "good"),
          media("https://images.example.test/fail.jpg", "fail"),
        ],
      }),
    );
    expect(receipt.status).toBe("partial");
    const snapshot = await service.getSnapshot(context, receipt.snapshotId);
    expect(snapshot.media.map((entry) => entry.status)).toEqual(["queued", "failed"]);
    expect(snapshot.draft.ehuntAnalysis?.tags[0]?.label).toBe("custom tissue paper");
  });

  it("preserves a parser-declared partial capture when no media job fails", async () => {
    const receipt = await service.createSnapshot(
      context,
      draft({
        captureStatus: "partial",
        diagnostics: [
          {
            code: "selector_error",
            field: "livePageDom",
            message: "The source page blocked live parsing",
            severity: "warning",
          },
        ],
        media: [],
        missingFields: ["livePageDom"],
        sourceUrl: "https://www.etsy.com/listing/1729000002/blocked-sample",
      }),
    );

    expect(receipt.status).toBe("partial");
  });

  it("does not reveal snapshots across tenants", async () => {
    const receipt = await service.createSnapshot(
      context,
      draft({ sourceUrl: "https://amazon.com/dp/B000000099" }),
    );
    await expect(service.getSnapshot(otherContext, receipt.snapshotId)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("filters and cursor-paginates in the repository", async () => {
    const result = await repository.list(context, {
      platform: "etsy",
      captureStatus: "partial",
      limit: 1,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ platform: "etsy", latestStatus: "partial" });
  });

  it("filters unified types, learns aliases, cascades suggestions, and preserves confirmed choices", async () => {
    const taxonomy = [
      { label: "Home & Living", url: "https://example.test/home" },
      { label: "Integration Pillow Leaf", url: "https://example.test/pillows" },
    ];
    const first = await service.createSnapshot(
      context,
      draft({
        capturedAt: "2026-07-31T01:00:00.000Z",
        sourceUrl: "https://www.amazon.com/dp/B000000201",
        title: "Ocean pillow alpha",
        taxonomy,
      }),
    );
    const second = await service.createSnapshot(
      context,
      draft({
        capturedAt: "2026-07-31T01:01:00.000Z",
        sourceUrl: "https://www.amazon.com/dp/B000000202",
        title: "Ocean pillow beta",
        taxonomy,
      }),
    );

    const suggested = await repository.list(context, {
      classificationStatus: "suggested",
      productType: "integration pillow leaf",
      q: "OCEAN",
      limit: 100,
    });
    expect(suggested.total).toBe(2);
    expect(suggested.items.map((item) => item.id)).toEqual([
      second.researchItemId,
      first.researchItemId,
    ]);

    const assigned = await classifications.assign(
      { ...context, permissions: [...context.permissions, Permission.ResearchWrite] },
      { itemIds: [first.researchItemId], productTypeName: "Pillow Covers" },
    );
    expect(assigned).toMatchObject({ cascaded: 1, updated: 1 });

    const confirmed = await repository.list(context, {
      classificationStatus: "confirmed",
      productType: "pillow covers",
      q: "alpha",
    });
    expect(confirmed.total).toBe(1);
    expect(confirmed.items[0]?.classification).toMatchObject({
      productType: { key: "pillow covers", name: "Pillow Covers" },
      source: "manual",
      status: "confirmed",
    });
    const cascaded = await repository.list(context, {
      classificationStatus: "suggested",
      productType: "pillow covers",
      q: "beta",
    });
    expect(cascaded.total).toBe(1);
    expect(cascaded.items[0]?.id).toBe(second.researchItemId);

    await service.createSnapshot(
      context,
      draft({
        capturedAt: "2026-07-31T01:02:00.000Z",
        sourceUrl: "https://www.amazon.com/dp/B000000201?ref=recapture",
        title: "Ocean pillow alpha updated",
        taxonomy: [
          { label: "Home & Living", url: "https://example.test/home" },
          { label: "Wall Decor", url: "https://example.test/wall-decor" },
        ],
      }),
    );
    const afterRecapture = await repository.list(context, {
      productType: "pillow covers",
      q: "alpha updated",
    });
    expect(afterRecapture.items[0]?.classification.status).toBe("confirmed");
    await expect(repository.snapshotCount(context, first.researchItemId)).resolves.toBe(2);
    const timeline = await repository.timeline(context, first.researchItemId);
    expect(timeline.at(-1)?.draft.taxonomy.at(-1)?.label).toBe("Integration Pillow Leaf");

    const facets = await repository.productTypes(context);
    expect(facets.items).toContainEqual({
      confirmed: 1,
      key: "pillow covers",
      name: "Pillow Covers",
      suggested: 1,
      total: 2,
    });
    const events = await withTenant(database.db, context, (tx) =>
      tx
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.action, "research_item.product_type.assign")),
    );
    expect(events.some((event) => event.entityId === first.researchItemId)).toBe(true);
  });

  it("rejects cross-tenant assignment and missing research:write permission", async () => {
    const receipt = await service.createSnapshot(
      context,
      draft({
        sourceUrl: "https://www.amazon.com/dp/B000000203",
        title: "Tenant-owned mug",
      }),
    );
    await expect(
      classifications.assign(otherContext, {
        itemIds: [receipt.researchItemId],
        productTypeName: "Mugs",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(() =>
      controller.assignProductType(
        { tenantContext: context } as never,
        { itemIds: [receipt.researchItemId], productTypeName: "Mugs" },
      ),
    ).toThrow("Permission denied: research:write");
  });
});

function draft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    platform: "amazon",
    parserVersion: "amazon@1.0.0",
    extensionVersion: "0.0.0",
    marketplace: "www.amazon.com",
    sourceUrl: "https://www.amazon.com/dp/B000000001",
    externalId: "B000000001",
    title: "Personalized Sample Product",
    domain: "research",
    price: { raw: "$29.95", amount: 29.95, currency: "USD" },
    rating: 4.7,
    reviewCount: 138,
    taxonomy: [],
    listingPublishedAt: null,
    favoriteCount: null,
    shipping: null,
    shop: null,
    reviewSummary: null,
    reviews: [],
    reviewCollection: {
      collectedCount: 0,
      reportedTotal: 138,
      pageCount: 0,
      status: "visible",
      updatedAt: new Date().toISOString(),
    },
    bullets: ["Food safe"],
    media: [media("https://images.example.test/main.jpg", "main")],
    variants: [],
    productInformation: [],
    contentBlocks: [],
    missingFields: [],
    diagnostics: [],
    captureStatus: "complete",
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

function media(sourceUrl: string, id: string): CaptureDraft["media"][number] {
  return { id, kind: "image", sourceUrl, included: true };
}

function ehuntAnalysis(): NonNullable<CaptureDraft["ehuntAnalysis"]> {
  return {
    provider: "ehunt",
    sourceSelector: "#etsy-rank-tool-product-table",
    listingPublishedAt: "2021-06-24",
    totalSales: 12368,
    salesDelta: 47,
    totalRevenue: { raw: "209,513.92", amount: 209513.92, currency: "USD" },
    revenueDelta: { raw: "796.18", amount: 796.18, currency: "USD" },
    viewCount: 255481,
    reviewCount: 1800,
    reviewDelta: 2,
    favoriteCount: 11930,
    favoriteDelta: 44,
    conversionRatePercent: 4.84,
    reviewRatePercent: 14.55,
    price: { raw: "$ 16.94+", amount: 16.94, currency: "USD" },
    productTypes: ["Handmade", "Customizable"],
    shipsFrom: "美国",
    badges: ["BestSeller"],
    inventoryCount: 991,
    categoryPath: ["Paper & Party Supplies", "Paper", "Gift Wrapping"],
    tags: [
      { label: "custom tissue paper", metricRaw: "5.0M", metricValue: 5_000_000 },
    ],
    annualTrendUrl: "https://ehunt.ai/product-detail/1729000001",
    shopName: "Sample Studio",
    shopRating: 4.9,
    shopSalesCount: 174083,
    shopSalesDelta: 2048,
  };
}
