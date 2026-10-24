import type { ManufacturingRecipeContent, ManufacturingRecipeVersionView } from "@yummyai/contracts/catalog/manufacturing";
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { spus } from "./catalog.js";
import { productSpecifications, productSpecificationVersions } from "./product-development.js";
import { inventoryStockItems } from "./inventory.js";

const scope = () => ({ id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).defaultNow().notNull() });

export const manufacturingRecipes = pgTable("manufacturing_recipes", {
  ...scope(), spuId: uuid("spu_id").notNull(), specificationId: uuid("specification_id").notNull(), code: text("code").notNull(),
  versionNumber: integer("version_number").default(1).notNull(), archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
}, t => [
  uniqueIndex("manufacturing_recipes_scope").on(t.tenantId, t.id),
  uniqueIndex("manufacturing_recipes_spec_scope").on(t.tenantId, t.id, t.specificationId),
  uniqueIndex("manufacturing_recipes_code").on(t.tenantId, t.spuId, sql`lower(${t.code})`),
  check("manufacturing_recipes_number", sql`${t.versionNumber}>0`),
  foreignKey({ columns: [t.tenantId, t.spuId], foreignColumns: [spus.tenantId, spus.id] }),
  foreignKey({ columns: [t.tenantId, t.spuId, t.specificationId], foreignColumns: [productSpecifications.tenantId, productSpecifications.spuId, productSpecifications.id] }),
]);
export const manufacturingRecipeVersions = pgTable("manufacturing_recipe_versions", {
  ...scope(), recipeId: uuid("recipe_id").notNull(), specificationId: uuid("specification_id").notNull(),
  specificationVersionId: uuid("specification_version_id").notNull(), versionNumber: integer("version_number").notNull(),
  creationTransaction: bigint("creation_transaction", { mode: "bigint" }).default(sql`txid_current()`).notNull(),
  name: text("name").notNull(), outputQuantity: integer("output_quantity").notNull(), outputUnit: text("output_unit").notNull(), notes: text("notes").notNull(),
}, t => [
  uniqueIndex("manufacturing_recipe_versions_scope").on(t.tenantId, t.id),
  uniqueIndex("manufacturing_recipe_versions_recipe_scope").on(t.tenantId, t.recipeId, t.id),
  uniqueIndex("manufacturing_recipe_versions_number").on(t.tenantId, t.recipeId, t.versionNumber),
  check("manufacturing_recipe_versions_quantity", sql`${t.versionNumber}>0 and ${t.outputQuantity} between 1 and 1000000 and ${t.outputUnit} in ('each','pair','set')`),
  foreignKey({ columns: [t.tenantId, t.recipeId, t.specificationId], foreignColumns: [manufacturingRecipes.tenantId, manufacturingRecipes.id, manufacturingRecipes.specificationId] }),
  foreignKey({ columns: [t.tenantId, t.specificationId, t.specificationVersionId], foreignColumns: [productSpecificationVersions.tenantId, productSpecificationVersions.specificationId, productSpecificationVersions.id] }),
]);
export const manufacturingOperations = pgTable("manufacturing_operations", {
  ...scope(), versionId: uuid("version_id").notNull(), position: integer("position").notNull(), code: text("code").notNull(),
  payload: jsonb("payload").$type<ManufacturingRecipeContent["operations"][number]>().notNull(),
}, t => [
  uniqueIndex("manufacturing_operations_code").on(t.tenantId, t.versionId, t.code),
  uniqueIndex("manufacturing_operations_position").on(t.tenantId, t.versionId, t.position),
  check("manufacturing_operations_payload", sql`${t.position} between 1 and 200 and ${t.payload}->>'code'=${t.code}`),
  foreignKey({ columns: [t.tenantId, t.versionId], foreignColumns: [manufacturingRecipeVersions.tenantId, manufacturingRecipeVersions.id] }),
]);
export const manufacturingBomLines = pgTable("manufacturing_bom_lines", {
  ...scope(), versionId: uuid("version_id").notNull(), position: integer("position").notNull(), code: text("code").notNull(),
  stockItemId: uuid("stock_item_id"), operationCode: text("operation_code"),
  payload: jsonb("payload").$type<ManufacturingRecipeContent["materials"][number]>().notNull(),
}, t => [
  uniqueIndex("manufacturing_bom_lines_code").on(t.tenantId, t.versionId, t.code),
  uniqueIndex("manufacturing_bom_lines_position").on(t.tenantId, t.versionId, t.position),
  check("manufacturing_bom_lines_payload", sql`${t.position} between 1 and 200 and ${t.payload}->>'code'=${t.code}
    and coalesce(${t.payload}->>'stockItemId','')=coalesce(${t.stockItemId}::text,'') and coalesce(${t.payload}->>'operationCode','')=coalesce(${t.operationCode},'')`),
  foreignKey({ columns: [t.tenantId, t.versionId], foreignColumns: [manufacturingRecipeVersions.tenantId, manufacturingRecipeVersions.id] }),
  foreignKey({ columns: [t.tenantId, t.stockItemId], foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id] }),
  foreignKey({ columns: [t.tenantId, t.versionId, t.operationCode], foreignColumns: [manufacturingOperations.tenantId, manufacturingOperations.versionId, manufacturingOperations.code] }),
]);
export const manufacturingRecipeReviews = pgTable("manufacturing_recipe_reviews", {
  ...scope(), recipeId: uuid("recipe_id").notNull(), versionId: uuid("version_id").notNull(), decision: text("decision").notNull(), note: text("note").notNull(),
}, t => [
  uniqueIndex("manufacturing_recipe_reviews_version").on(t.tenantId, t.versionId),
  uniqueIndex("manufacturing_recipe_reviews_scope").on(t.tenantId, t.versionId, t.id),
  check("manufacturing_recipe_reviews_decision", sql`${t.decision} in ('approved','rejected') and length(trim(${t.note}))>0`),
  foreignKey({ columns: [t.tenantId, t.recipeId, t.versionId], foreignColumns: [manufacturingRecipeVersions.tenantId, manufacturingRecipeVersions.recipeId, manufacturingRecipeVersions.id] }),
]);
export const manufacturingRecipeCommands = pgTable("manufacturing_recipe_commands", {
  ...scope(), requestKey: text("request_key").notNull(), requestChecksum: text("request_checksum").notNull(), operation: text("operation").notNull(),
  recipeId: uuid("recipe_id").notNull(), versionId: uuid("version_id").notNull(),
  response: jsonb("response").$type<ManufacturingRecipeVersionView>().notNull(),
}, t => [
  uniqueIndex("manufacturing_recipe_commands_key").on(t.tenantId, t.requestKey),
  check("manufacturing_recipe_commands_operation", sql`${t.operation} in ('create','revise','review') and ${t.requestChecksum}~'^[a-f0-9]{64}$'`),
  foreignKey({ columns: [t.tenantId, t.recipeId, t.versionId], foreignColumns: [manufacturingRecipeVersions.tenantId, manufacturingRecipeVersions.recipeId, manufacturingRecipeVersions.id] }),
]);
