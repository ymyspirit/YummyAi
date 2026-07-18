import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { CapturedShopSummary, CompetitorShopDraft } from "@yummyai/contracts";
import { captureSnapshots, researchItems } from "./capture.js";
import { organizations, users } from "./identity.js";

export const competitorShops = pgTable(
  "competitor_shops",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    platform: text("platform").notNull(),
    marketplace: text("marketplace").notNull(),
    externalId: text("external_id"),
    normalizedUrl: text("normalized_url").notNull(),
    shopName: text("shop_name").notNull(),
    latestStatus: text("latest_status").default("partial").notNull(),
    firstCapturedAt: timestamp("first_captured_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    lastCapturedAt: timestamp("last_captured_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "competitor_shops_id_uuidv7_check",
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check("competitor_shops_platform_check", sql`${table.platform} in ('amazon', 'etsy')`),
    check(
      "competitor_shops_status_check",
      sql`${table.latestStatus} in ('complete', 'partial', 'failed')`,
    ),
    uniqueIndex("competitor_shops_tenant_url_unique").on(table.tenantId, table.normalizedUrl),
    uniqueIndex("competitor_shops_tenant_id_unique").on(table.tenantId, table.id),
    index("competitor_shops_tenant_captured_idx").on(table.tenantId, table.lastCapturedAt),
  ],
);

export const competitorShopSnapshots = pgTable(
  "competitor_shop_snapshots",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    competitorShopId: uuid("competitor_shop_id").notNull(),
    capturedBy: uuid("captured_by").references(() => users.id, { onDelete: "set null" }),
    sourceResearchItemId: uuid("source_research_item_id").references(() => researchItems.id, {
      onDelete: "set null",
    }),
    sourceCaptureSnapshotId: uuid("source_capture_snapshot_id").references(
      () => captureSnapshots.id,
      { onDelete: "set null" },
    ),
    sourceUrl: text("source_url").notNull(),
    snapshotKind: text("snapshot_kind").notNull(),
    location: text("location"),
    ownerName: text("owner_name"),
    rating: numeric("rating", { precision: 3, scale: 2 }),
    reviewCount: integer("review_count"),
    salesCount: integer("sales_count"),
    activeListingCount: integer("active_listing_count"),
    admirerCount: integer("admirer_count"),
    openedYear: integer("opened_year"),
    yearsOnPlatform: integer("years_on_platform"),
    badges: jsonb("badges")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    announcement: text("announcement"),
    about: text("about"),
    policies: text("policies"),
    members: jsonb("members")
      .$type<CompetitorShopDraft["members"]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    productionPartners: jsonb("production_partners")
      .$type<string[]>()
      .default(sql`'[]'::jsonb`)
      .notNull(),
    draft: jsonb("draft").$type<CompetitorShopDraft | CapturedShopSummary>().notNull(),
    capturedAt: timestamp("captured_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "competitor_shop_snapshots_id_uuidv7_check",
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      "competitor_shop_snapshots_kind_check",
      sql`${table.snapshotKind} in ('listing', 'shop')`,
    ),
    foreignKey({
      columns: [table.tenantId, table.competitorShopId],
      foreignColumns: [competitorShops.tenantId, competitorShops.id],
      name: "competitor_shop_snapshots_shop_fk",
    }).onDelete("cascade"),
    uniqueIndex("competitor_shop_snapshots_tenant_id_unique").on(table.tenantId, table.id),
    index("competitor_shop_snapshots_shop_captured_idx").on(
      table.tenantId,
      table.competitorShopId,
      table.capturedAt,
    ),
  ],
);
