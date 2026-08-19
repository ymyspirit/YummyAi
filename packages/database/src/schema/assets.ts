import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";

export const assetFiles = pgTable(
  "asset_files",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    objectKey: text("object_key").notNull(),
    assetDomain: text("asset_domain").notNull(),
    fileName: text("file_name").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    rightsStatus: text("rights_status").default("unverified").notNull(),
    rightsMetadata: jsonb("rights_metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    version: integer("version").default(1).notNull(),
    aiGenerated: boolean("ai_generated").default(false).notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    check("asset_files_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("asset_files_domain_check", sql`${table.assetDomain} in ('research', 'authorized', 'order')`),
    check("asset_files_byte_size_check", sql`${table.byteSize} >= 0`),
    check("asset_files_checksum_check", sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    check("asset_files_rights_status_check", sql`${table.rightsStatus} in ('unverified', 'approved', 'rejected')`),
    check("asset_files_version_check", sql`${table.version} > 0`),
    uniqueIndex("asset_files_tenant_object_key_unique").on(table.tenantId, table.objectKey),
    uniqueIndex("asset_files_tenant_id_unique").on(table.tenantId, table.id),
    index("asset_files_tenant_created_at_idx").on(table.tenantId, table.createdAt),
    index("asset_files_owner_user_id_idx").on(table.ownerUserId),
  ],
);
