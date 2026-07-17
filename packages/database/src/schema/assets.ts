import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  index,
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
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp("deleted_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    check("asset_files_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    check("asset_files_domain_check", sql`${table.assetDomain} in ('research', 'authorized')`),
    check("asset_files_byte_size_check", sql`${table.byteSize} >= 0`),
    check("asset_files_checksum_check", sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
    uniqueIndex("asset_files_tenant_object_key_unique").on(table.tenantId, table.objectKey),
    index("asset_files_tenant_created_at_idx").on(table.tenantId, table.createdAt),
    index("asset_files_owner_user_id_idx").on(table.ownerUserId),
  ],
);
