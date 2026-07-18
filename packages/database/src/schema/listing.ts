import type { ListingDraft, ListingValidation } from "@yummyai/platform-rules";
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { spus } from "./catalog.js";
import { organizations, users } from "./identity.js";

export const listings = pgTable("listings", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  spuId: uuid("spu_id").notNull(),
  platform: text("platform").notNull(),
  locale: text("locale").notNull(),
  status: text("status").default("draft").notNull(),
  primaryVersionId: uuid("primary_version_id"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("listings_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("listings_platform_check", sql`${table.platform} in ('amazon','etsy')`),
  check("listings_status_check", sql`${table.status} in ('draft','in_review','approved','archived')`),
  foreignKey({ columns: [table.tenantId, table.spuId], foreignColumns: [spus.tenantId, spus.id], name: "listings_spu_fk" }).onDelete("restrict"),
  uniqueIndex("listings_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("listings_channel_unique").on(table.tenantId, table.spuId, table.platform, table.locale),
  index("listings_status_idx").on(table.tenantId, table.status, table.updatedAt),
]);

export const listingVersions = pgTable("listing_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  listingId: uuid("listing_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  ruleVersion: text("rule_version").notNull(),
  status: text("status").default("draft").notNull(),
  source: text("source").default("human").notNull(),
  content: jsonb("content").$type<ListingDraft>().notNull(),
  validation: jsonb("validation").$type<ListingValidation>().notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("listing_versions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("listing_versions_number_check", sql`${table.versionNumber} > 0`),
  check("listing_versions_status_check", sql`${table.status} in ('draft','approved','superseded')`),
  check("listing_versions_source_check", sql`${table.source} in ('human','ai')`),
  foreignKey({ columns: [table.tenantId, table.listingId], foreignColumns: [listings.tenantId, listings.id], name: "listing_versions_listing_fk" }).onDelete("cascade"),
  uniqueIndex("listing_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("listing_versions_number_unique").on(table.tenantId, table.listingId, table.versionNumber),
  index("listing_versions_listing_idx").on(table.tenantId, table.listingId, table.createdAt),
]);
