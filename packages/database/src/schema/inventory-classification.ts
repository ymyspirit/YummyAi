import { sql } from "drizzle-orm";
import { check, foreignKey, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { inventoryStockItems } from "./inventory.js";
import { organizations, users } from "./identity.js";

/** Classification changes append evidence; stock identity and historical facts stay intact. */
export const inventoryStockItemClassifications = pgTable("inventory_stock_item_classifications", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stockItemId: uuid("stock_item_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  kind: text("kind").notNull(),
  reason: text("reason").notNull(),
  requestChecksum: text("request_checksum").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull(),
}, table => [
  check("inventory_stock_classifications_id_check", sql`substring(${table.id}::text from 15 for 1)='7'`),
  check("inventory_stock_classifications_version_check", sql`${table.versionNumber}>0`),
  check("inventory_stock_classifications_kind_check", sql`${table.kind} in ('blank','material','packaging','work_in_progress','finished_good')`),
  check("inventory_stock_classifications_reason_check", sql`length(btrim(${table.reason})) between 1 and 1000`),
  check("inventory_stock_classifications_checksum_check", sql`${table.requestChecksum} ~ '^[a-f0-9]{64}$'`),
  check("inventory_stock_classifications_key_check", sql`length(${table.idempotencyKey}) between 8 and 200`),
  foreignKey({ columns: [table.tenantId, table.stockItemId], foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id], name: "inventory_stock_classifications_stock_fk" }).onDelete("restrict"),
  uniqueIndex("inventory_stock_classifications_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("inventory_stock_classifications_version_unique").on(table.tenantId, table.stockItemId, table.versionNumber),
  uniqueIndex("inventory_stock_classifications_key_unique").on(table.tenantId, table.idempotencyKey),
]);
