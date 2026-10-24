import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ProductionManufacturingFactoryBasis } from "@yummyai/contracts/order/production-manufacturing";
import { organizations, users } from "./identity.js";
import { productionOrders, productionOrderVersions } from "./order-production.js";
import { manufacturingRecipeVersions, manufacturingRecipeReviews } from "./manufacturing.js";
import { orderWorkRevisions } from "./order-workspace.js";
import { skus } from "./catalog.js";

/** New production evidence only; absence on an old production version stays explicit. */
export const productionManufacturingBindings = pgTable("production_manufacturing_bindings", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(), orderLineId: uuid("order_line_id").notNull(),
  recipeId: uuid("recipe_id").notNull(), manufacturingVersionId: uuid("manufacturing_version_id").notNull(), reviewId: uuid("review_id").notNull(),
  specificationVersionId: uuid("specification_version_id").notNull(), source: text("source").notNull(), sourceWorkRevisionId: uuid("source_work_revision_id"), originalBindingId: uuid("original_binding_id"),
  skuId: uuid("sku_id"),
  factoryBasis: jsonb("factory_basis").$type<ProductionManufacturingFactoryBasis>().notNull(),
  bindingVersion: integer("binding_version").default(1).notNull(), quantity: integer("quantity").notNull(), outputUnit: text("output_unit").notNull(), orderUnitConfirmed: boolean("order_unit_confirmed").notNull(),
  contentCanonical: text("content_canonical").notNull(), contentChecksum: text("content_checksum").notNull(),
  encryptedConfirmationNote: text("encrypted_confirmation_note"), confirmationNoteChecksum: text("confirmation_note_checksum"),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("production_manufacturing_scope").on(t.tenantId, t.id),
  uniqueIndex("production_manufacturing_material_ref").on(t.tenantId, t.id, t.productionOrderId),
  uniqueIndex("production_manufacturing_version").on(t.tenantId, t.productionVersionId),
  uniqueIndex("production_manufacturing_delivery_ref").on(t.tenantId, t.id, t.productionVersionId),
  check("production_manufacturing_count", sql`${t.bindingVersion}=1 and ${t.quantity}>0 and ${t.outputUnit} in ('each','pair','set') and ${t.orderUnitConfirmed}`),
  check("production_manufacturing_source", sql`(${t.source}='order_work_revision' and ${t.sourceWorkRevisionId} is not null and ${t.originalBindingId} is null and ${t.encryptedConfirmationNote} is null and ${t.confirmationNoteChecksum} is null)
    or (${t.source}='approved_product_confirmation' and ${t.sourceWorkRevisionId} is null and ${t.originalBindingId} is null and ${t.encryptedConfirmationNote} is not null and ${t.confirmationNoteChecksum} is not null
      and length(${t.encryptedConfirmationNote})>0 and ${t.confirmationNoteChecksum}~'^[a-f0-9]{64}$')
    or (${t.source}='original_production_binding' and ${t.originalBindingId} is not null and ${t.encryptedConfirmationNote} is null and ${t.confirmationNoteChecksum} is null)`),
  check("production_manufacturing_checksum", sql`${t.contentChecksum}=encode(sha256(convert_to(${t.contentCanonical},'UTF8')),'hex')`),
  foreignKey({ columns: [t.tenantId, t.productionOrderId, t.orderLineId], foreignColumns: [productionOrders.tenantId, productionOrders.id, productionOrders.orderLineId] }),
  foreignKey({ columns: [t.tenantId, t.productionVersionId, t.productionOrderId, t.quantity], foreignColumns: [productionOrderVersions.tenantId, productionOrderVersions.id, productionOrderVersions.productionOrderId, productionOrderVersions.quantity] }),
  foreignKey({ columns: [t.tenantId, t.recipeId, t.manufacturingVersionId], foreignColumns: [manufacturingRecipeVersions.tenantId, manufacturingRecipeVersions.recipeId, manufacturingRecipeVersions.id] }),
  foreignKey({ columns: [t.tenantId, t.manufacturingVersionId, t.reviewId], foreignColumns: [manufacturingRecipeReviews.tenantId, manufacturingRecipeReviews.versionId, manufacturingRecipeReviews.id] }),
  foreignKey({ columns: [t.tenantId, t.orderLineId, t.sourceWorkRevisionId], foreignColumns: [orderWorkRevisions.tenantId, orderWorkRevisions.workItemId, orderWorkRevisions.id] }),
  foreignKey({ columns: [t.tenantId, t.originalBindingId], foreignColumns: [t.tenantId, t.id] }),
  foreignKey({ columns: [t.tenantId, t.skuId], foreignColumns: [skus.tenantId, skus.id] }),
]);
