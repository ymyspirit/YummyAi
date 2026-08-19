import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { CaptureDraft } from "@yummyai/contracts";
import { organizations, users } from "./identity.js";

export const researchItems = pgTable(
  "research_items",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    platform: text("platform").notNull(),
    marketplace: text("marketplace").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    latestTitle: text("latest_title"),
    latestStatus: text("latest_status").default("normalizing").notNull(),
    productTypeName: text("product_type_name"),
    productTypeKey: text("product_type_key"),
    classificationStatus: text("classification_status").default("unclassified").notNull(),
    classificationSource: text("classification_source"),
    classificationEvidenceSource: text("classification_evidence_source"),
    classificationEvidenceKey: text("classification_evidence_key"),
    classificationEvidenceLabel: text("classification_evidence_label"),
    classificationUpdatedBy: uuid("classification_updated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    classificationUpdatedAt: timestamp("classification_updated_at", {
      mode: "date",
      withTimezone: true,
    }),
    tags: jsonb("tags").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
    projectId: uuid("project_id"),
    firstCapturedAt: timestamp("first_captured_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
    lastCapturedAt: timestamp("last_captured_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("research_items_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("research_items_platform_check", sql`${table.platform} in ('amazon', 'etsy')`),
    check("research_items_status_check", sql`${table.latestStatus} in ('normalizing', 'complete', 'partial', 'failed')`),
    check(
      "research_items_classification_status_check",
      sql`${table.classificationStatus} in ('unclassified', 'suggested', 'confirmed')`,
    ),
    check(
      "research_items_classification_source_check",
      sql`${table.classificationSource} is null or ${table.classificationSource} in ('marketplace_taxonomy', 'ehunt_category', 'amazon_bsr', 'manual')`,
    ),
    check(
      "research_items_classification_evidence_source_check",
      sql`${table.classificationEvidenceSource} is null or ${table.classificationEvidenceSource} in ('marketplace_taxonomy', 'ehunt_category', 'amazon_bsr')`,
    ),
    check(
      "research_items_classification_evidence_pair_check",
      sql`(${table.classificationEvidenceSource} is null and ${table.classificationEvidenceKey} is null and ${table.classificationEvidenceLabel} is null) or (${table.classificationEvidenceSource} is not null and ${table.classificationEvidenceKey} is not null and ${table.classificationEvidenceLabel} is not null)`,
    ),
    check(
      "research_items_product_type_pair_check",
      sql`(${table.classificationStatus} = 'unclassified' and ${table.productTypeName} is null and ${table.productTypeKey} is null) or (${table.classificationStatus} in ('suggested', 'confirmed') and ${table.productTypeName} is not null and ${table.productTypeKey} is not null)`,
    ),
    uniqueIndex("research_items_tenant_url_unique").on(table.tenantId, table.normalizedUrl),
    uniqueIndex("research_items_tenant_id_unique").on(table.tenantId, table.id),
    index("research_items_tenant_last_captured_idx").on(table.tenantId, table.lastCapturedAt),
    index("research_items_filter_idx").on(table.tenantId, table.platform, table.marketplace, table.latestStatus),
    index("research_items_product_type_idx").on(
      table.tenantId,
      table.productTypeKey,
      table.lastCapturedAt,
    ),
    index("research_items_classification_idx").on(
      table.tenantId,
      table.classificationStatus,
      table.lastCapturedAt,
    ),
  ],
);

export const researchProductTypeAliases = pgTable(
  "research_product_type_aliases",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    platform: text("platform").notNull(),
    evidenceSource: text("evidence_source").notNull(),
    evidenceKey: text("evidence_key").notNull(),
    evidenceLabel: text("evidence_label").notNull(),
    productTypeKey: text("product_type_key").notNull(),
    productTypeName: text("product_type_name").notNull(),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.tenantId, table.platform, table.evidenceSource, table.evidenceKey],
      name: "research_product_type_aliases_pk",
    }),
    check(
      "research_product_type_aliases_platform_check",
      sql`${table.platform} in ('amazon', 'etsy')`,
    ),
    check(
      "research_product_type_aliases_source_check",
      sql`${table.evidenceSource} in ('marketplace_taxonomy', 'ehunt_category', 'amazon_bsr')`,
    ),
    index("research_product_type_aliases_product_type_idx").on(
      table.tenantId,
      table.productTypeKey,
    ),
  ],
);

export const captureSnapshots = pgTable(
  "capture_snapshots",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    researchItemId: uuid("research_item_id").notNull(),
    capturedBy: uuid("captured_by").references(() => users.id, { onDelete: "set null" }),
    sourceUrl: text("source_url").notNull(),
    title: text("title"),
    priceAmount: numeric("price_amount", { precision: 14, scale: 2 }),
    priceCurrency: text("price_currency"),
    rating: numeric("rating", { precision: 3, scale: 2 }),
    status: text("status").default("normalizing").notNull(),
    domain: text("domain").notNull(),
    draft: jsonb("draft").$type<CaptureDraft>().notNull(),
    capturedAt: timestamp("captured_at", { mode: "date", withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("capture_snapshots_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("capture_snapshots_status_check", sql`${table.status} in ('normalizing', 'complete', 'partial', 'failed')`),
    check("capture_snapshots_domain_check", sql`${table.domain} in ('research', 'authorized')`),
    foreignKey({
      columns: [table.tenantId, table.researchItemId],
      foreignColumns: [researchItems.tenantId, researchItems.id],
      name: "capture_snapshots_research_item_fk",
    }).onDelete("cascade"),
    uniqueIndex("capture_snapshots_tenant_id_unique").on(table.tenantId, table.id),
    index("capture_snapshots_item_captured_idx").on(table.tenantId, table.researchItemId, table.capturedAt),
  ],
);

export const captureMedia = pgTable(
  "capture_media",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    snapshotId: uuid("snapshot_id").notNull(),
    sourceUrl: text("source_url").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    failureReason: text("failure_reason"),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("capture_media_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("capture_media_kind_check", sql`${table.kind} in ('image', 'video')`),
    check("capture_media_status_check", sql`${table.status} in ('queued', 'excluded', 'failed')`),
    foreignKey({
      columns: [table.tenantId, table.snapshotId],
      foreignColumns: [captureSnapshots.tenantId, captureSnapshots.id],
      name: "capture_media_snapshot_fk",
    }).onDelete("cascade"),
    index("capture_media_snapshot_idx").on(table.tenantId, table.snapshotId),
  ],
);
