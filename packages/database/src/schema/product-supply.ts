import type { SupplyTerms } from "@yummyai/contracts/catalog/product-supply";
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { productPlans, skus } from "./catalog.js";
import { organizations, users } from "./identity.js";
import { inventoryStockItems } from "./inventory.js";
import { fulfillmentSuppliers } from "./order-routing.js";

export const productSupplyLinks = pgTable("product_supply_links", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  productPlanId: uuid("product_plan_id").notNull(), supplierId: uuid("supplier_id").notNull(), skuId: uuid("sku_id"),
  currentVersion: integer("current_version").default(1).notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("product_supply_links_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("product_supply_links_identity_unique").on(table.tenantId, table.productPlanId, table.supplierId, sql`coalesce(${table.skuId}, '00000000-0000-0000-0000-000000000000'::uuid)`),
  foreignKey({ columns: [table.tenantId, table.productPlanId], foreignColumns: [productPlans.tenantId, productPlans.id], name: "product_supply_product_fk" }),
  foreignKey({ columns: [table.tenantId, table.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "product_supply_supplier_fk" }),
  foreignKey({ columns: [table.tenantId, table.skuId], foreignColumns: [skus.tenantId, skus.id], name: "product_supply_sku_fk" }),
  check("product_supply_version_check", sql`${table.currentVersion} > 0`),
]);

export const productSupplyVersions = pgTable("product_supply_versions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  linkId: uuid("link_id").notNull(), versionNumber: integer("version_number").notNull(),
  stockItemId: uuid("stock_item_id"), terms: jsonb("terms").$type<SupplyTerms>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(), requestHash: text("request_hash").notNull(),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique("product_supply_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("product_supply_versions_number_unique").on(table.tenantId, table.linkId, table.versionNumber),
  uniqueIndex("product_supply_versions_request_unique").on(table.tenantId, table.idempotencyKey),
  foreignKey({ columns: [table.tenantId, table.linkId], foreignColumns: [productSupplyLinks.tenantId, productSupplyLinks.id], name: "product_supply_versions_link_fk" }),
  foreignKey({ columns: [table.tenantId, table.stockItemId], foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id], name: "product_supply_versions_stock_fk" }),
  check("product_supply_versions_number_check", sql`${table.versionNumber} > 0`),
  check("product_supply_versions_stock_check", sql`(${table.terms}->>'stockItemId')::uuid is not distinct from ${table.stockItemId}`),
]);
