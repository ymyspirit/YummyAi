import { sql } from "drizzle-orm";
import { check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./identity.js";
import { marketplaceListingSyncRequests } from "./marketplace.js";

/** A locator for the original owner request, not another business task or result store. */
export const marketplaceListingSyncIntents = pgTable("marketplace_listing_sync_intents", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  requestKey: uuid("request_key").notNull(), createdBy: uuid("created_by").notNull(),
  requestId: uuid("request_id").notNull(), requestChecksum: text("request_checksum").notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, table => [
  check("listing_sync_intent_ids_check", sql`substring(${table.id}::text from 15 for 1)='7' and substring(${table.requestKey}::text from 15 for 1)='7'`),
  check("listing_sync_intent_digest_check", sql`${table.requestChecksum}~'^[a-f0-9]{64}$'`),
  foreignKey({ columns: [table.tenantId, table.requestId], foreignColumns: [marketplaceListingSyncRequests.tenantId, marketplaceListingSyncRequests.id], name: "listing_sync_intent_request_fk" }),
  uniqueIndex("listing_sync_intent_actor_key_unique").on(table.tenantId, table.createdBy, table.requestKey),
  uniqueIndex("listing_sync_intent_request_unique").on(table.tenantId, table.requestId),
]);
