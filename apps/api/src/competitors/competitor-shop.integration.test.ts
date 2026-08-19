import { Permission } from "@yummyai/authz";
import {
  createEntityId,
  type CompetitorShopDraft,
  type TenantContext,
} from "@yummyai/contracts";
import { connectDatabase, migrateDatabase } from "@yummyai/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { CompetitorShopService } from "./competitor-shop.service.js";

describe("competitor shop snapshots", () => {
  const database = connectDatabase();
  const tenantId = createEntityId();
  const userId = createEntityId();
  const otherTenantId = createEntityId();
  const otherUserId = createEntityId();
  const context: TenantContext = {
    tenantId,
    userId,
    permissions: [Permission.CaptureWrite, Permission.ResearchRead],
    dataScope: "tenant",
  };
  const otherContext: TenantContext = {
    ...context,
    tenantId: otherTenantId,
    userId: otherUserId,
  };
  const service = new CompetitorShopService(database, new AuditService(database));

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1, 'Competitor tenant', $2), ($3, 'Other competitor tenant', $4)`,
      [tenantId, `competitor-${tenantId}`, otherTenantId, `competitor-${otherTenantId}`],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1, $2, $3, 'Competitor User'), ($4, $5, $6, 'Other Competitor User')`,
      [
        userId,
        `competitor-${userId}`,
        `${userId}@example.test`,
        otherUserId,
        `competitor-${otherUserId}`,
        `${otherUserId}@example.test`,
      ],
    );
  });

  afterAll(async () => database.client.end());

  it("persists ordered sections in immutable snapshots and keeps them tenant isolated", async () => {
    const first = await service.createSnapshot(context, shopDraft());
    const second = await service.createSnapshot(
      context,
      shopDraft({
        activeListingCount: 430,
        capturedAt: "2026-07-29T00:05:00.000Z",
        ehuntAnalysis: ehuntShopAnalysis(),
        shopSections: sections(430, 266),
        yearsOnPlatform: 1.5,
      }),
    );

    expect(second.competitorShopId).toBe(first.competitorShopId);
    expect(second.snapshotId).not.toBe(first.snapshotId);

    const listed = await service.list(context);
    expect(listed.items[0]?.latestSnapshot?.shopSections).toEqual(sections(430, 266));
    expect(listed.items[0]?.latestSnapshot?.yearsOnPlatform).toBe(1.5);
    const latestDraft = listed.items[0]?.latestSnapshot?.draft;
    expect(latestDraft && "parserVersion" in latestDraft ? latestDraft.ehuntAnalysis : undefined)
      .toMatchObject({
        provider: "ehunt",
        weeklySales: { raw: "231", value: 231 },
        activeSection: { kind: "popular_categories" },
      });

    const timeline = await service.timeline(context, first.competitorShopId);
    expect(timeline.snapshots.map((snapshot) => snapshot.shopSections[0]?.listingCount)).toEqual([
      430,
      426,
    ]);
    expect(
      timeline.snapshots.map((snapshot) =>
        "parserVersion" in snapshot.draft ? snapshot.draft.ehuntAnalysis?.provider : undefined,
      ),
    ).toEqual(["ehunt", undefined]);

    await expect(service.list(otherContext)).resolves.toEqual({ items: [] });
    await expect(service.timeline(otherContext, first.competitorShopId)).rejects.toMatchObject({
      status: 404,
    });
  });
});

function shopDraft(overrides: Partial<CompetitorShopDraft> = {}): CompetitorShopDraft {
  return {
    platform: "etsy",
    externalId: "ThePineTroveGifts",
    name: "ThePineTroveGifts",
    sourceUrl: "https://www.etsy.com/shop/ThePineTroveGifts",
    location: "South Surrey, Canada",
    ownerName: "Kirti",
    rating: 4.8,
    reviewCount: 9900,
    salesCount: 71888,
    activeListingCount: 426,
    admirerCount: 5721,
    openedYear: 2022,
    yearsOnPlatform: 3,
    badges: ["Star Seller"],
    parserVersion: "etsy-shop@1.1.0",
    extensionVersion: "0.0.0",
    marketplace: "www.etsy.com",
    announcement: null,
    about: null,
    policies: null,
    members: [],
    productionPartners: [],
    shopSections: sections(426, 262),
    missingFields: [],
    diagnostics: [],
    captureStatus: "complete",
    capturedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function sections(
  allCount: number,
  categoryCount: number,
): CompetitorShopDraft["shopSections"] {
  return [
    {
      kind: "all",
      externalId: "0",
      name: "All",
      listingCount: allCount,
      sourceUrl: "https://www.etsy.com/shop/ThePineTroveGifts",
    },
    {
      kind: "sale",
      externalId: "1",
      name: "On sale",
      listingCount: allCount,
      sourceUrl: null,
    },
    {
      kind: "category",
      externalId: "39890899",
      name: "Punch Needle",
      listingCount: categoryCount,
      sourceUrl: "https://www.etsy.com/shop/ThePineTroveGifts?section_id=39890899",
    },
  ];
}

function ehuntShopAnalysis(): NonNullable<CompetitorShopDraft["ehuntAnalysis"]> {
  return {
    provider: "ehunt",
    sourceSelector: "#etsy-rank-tool-store-table .eh-store-detail",
    openedAt: "2026-06-25",
    primaryCategory: null,
    country: "美国",
    weeklySales: { raw: "231", value: 231 },
    weeklyRevenue: { raw: "5,430.81", amount: 5430.81 },
    weeklyReviews: { raw: "0", value: 0 },
    totalSales: { raw: "347", value: 347 },
    totalRevenue: { raw: "8,157.97", amount: 8157.97 },
    totalReviews: { raw: "0", value: 0 },
    weeklyFavorites: { raw: "100", value: 100 },
    listingCount: { raw: "58", value: 58 },
    rating: 0,
    totalFavorites: { raw: "146", value: 146 },
    starSeller: false,
    socialMedia: [],
    paymentMethods: ["Paypal", "Visa"],
    activeSection: {
      kind: "popular_categories",
      label: "热门类目",
      items: [
        {
          path: ["Home & Living", "Home Decor", "Wall Decor"],
          sharePercent: 50,
          raw: "Home & Living > Home Decor > Wall Decor (50%)",
        },
      ],
    },
  };
}
