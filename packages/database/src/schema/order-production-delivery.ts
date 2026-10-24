import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { productionOrders, productionOrderVersions } from "./order-production.js";
import { fulfillmentSuppliers } from "./order-routing.js";
import { fulfillmentFactories, fulfillmentFactoryVersions } from "./factory-directory.js";
import { orderWorkItems, orderWorkRevisions } from "./order-workspace.js";
import { productionEditorProjects, productionEditorVersions, productionEditorRenders } from "./production-editor.js";
import { productionManufacturingBindings } from "./production-manufacturing.js";

export const productionDeliveryPackages = pgTable("production_delivery_packages", {
  schemaVersion: integer("schema_version").notNull().default(1), factoryId: uuid("factory_id"), factoryVersionId: uuid("factory_version_id"),
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  supplierId: uuid("supplier_id").notNull(), supplierName: text("supplier_name").notNull(), idempotencyKey: uuid("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  checksum: text("checksum").notNull(), createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", {mode:"date",withTimezone:true}).notNull().defaultNow(),
}, t => [
  check("production_delivery_packages_uuidv7_check", sql`substring(${t.id}::text from 15 for 1) = '7'`),
  check("production_delivery_packages_checksum_check", sql`${t.checksum} ~ '^[a-f0-9]{64}$' and ${t.requestChecksum} ~ '^[a-f0-9]{64}$'`),
  uniqueIndex("production_delivery_packages_tenant_id_unique").on(t.tenantId,t.id),
  uniqueIndex("production_delivery_packages_request_unique").on(t.tenantId,t.idempotencyKey),
  foreignKey({columns:[t.tenantId,t.supplierId],foreignColumns:[fulfillmentSuppliers.tenantId,fulfillmentSuppliers.id],name:"production_delivery_packages_supplier_fk"}),
  index("production_delivery_packages_created_idx").on(t.tenantId,t.createdAt),
  foreignKey({ columns: [t.tenantId, t.supplierId, t.factoryId], foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.supplierId, fulfillmentFactories.id], name: "production_delivery_packages_factory_fk" }),
  foreignKey({ columns: [t.tenantId, t.factoryId, t.factoryVersionId], foreignColumns: [fulfillmentFactoryVersions.tenantId, fulfillmentFactoryVersions.factoryId, fulfillmentFactoryVersions.id], name: "production_delivery_packages_factory_version_fk" }),
]);
export const productionDeliveryItems = pgTable("production_delivery_items", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), packageId: uuid("package_id").notNull(),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(),
  workItemId: uuid("work_item_id").notNull(), workRevisionId: uuid("work_revision_id").notNull(),
  editorProjectId: uuid("editor_project_id").notNull(), editorVersionId: uuid("editor_version_id").notNull(), renderId: uuid("render_id").notNull(),
  fileChecksum: text("file_checksum").notNull(), byteSize: bigint("byte_size",{mode:"number"}).notNull(),
  encryptedSnapshot: text("encrypted_snapshot").notNull(),
  manufacturingBindingId: uuid("manufacturing_binding_id"), manufacturingContentChecksum: text("manufacturing_content_checksum"),
  manufacturingPlanChecksum: text("manufacturing_plan_checksum"),
}, t => [
  check("production_delivery_items_uuidv7_check",sql`substring(${t.id}::text from 15 for 1) = '7'`),
  check("production_delivery_items_file_check",sql`${t.fileChecksum} ~ '^[a-f0-9]{64}$' and ${t.byteSize} > 0`),
  uniqueIndex("production_delivery_items_tenant_id_unique").on(t.tenantId,t.id),
  uniqueIndex("production_delivery_items_order_unique").on(t.tenantId,t.packageId,t.productionOrderId),
  foreignKey({columns:[t.tenantId,t.packageId],foreignColumns:[productionDeliveryPackages.tenantId,productionDeliveryPackages.id],name:"production_delivery_items_package_fk"}),
  foreignKey({columns:[t.tenantId,t.productionOrderId],foreignColumns:[productionOrders.tenantId,productionOrders.id],name:"production_delivery_items_order_fk"}),
  foreignKey({columns:[t.tenantId,t.productionVersionId],foreignColumns:[productionOrderVersions.tenantId,productionOrderVersions.id],name:"production_delivery_items_version_fk"}),
  foreignKey({columns:[t.tenantId,t.workItemId],foreignColumns:[orderWorkItems.tenantId,orderWorkItems.id],name:"production_delivery_items_work_fk"}),
  foreignKey({columns:[t.tenantId,t.workItemId,t.workRevisionId],foreignColumns:[orderWorkRevisions.tenantId,orderWorkRevisions.workItemId,orderWorkRevisions.id],name:"production_delivery_items_revision_fk"}),
  foreignKey({columns:[t.tenantId,t.editorProjectId],foreignColumns:[productionEditorProjects.tenantId,productionEditorProjects.id],name:"production_delivery_items_project_fk"}),
  foreignKey({columns:[t.tenantId,t.editorProjectId,t.editorVersionId],foreignColumns:[productionEditorVersions.tenantId,productionEditorVersions.projectId,productionEditorVersions.id],name:"production_delivery_items_editor_version_fk"}),
  foreignKey({columns:[t.tenantId,t.renderId],foreignColumns:[productionEditorRenders.tenantId,productionEditorRenders.id],name:"production_delivery_items_render_fk"}),
  index("production_delivery_items_production_idx").on(t.tenantId,t.productionOrderId),
  foreignKey({ columns: [t.tenantId, t.manufacturingBindingId, t.productionVersionId], foreignColumns: [productionManufacturingBindings.tenantId, productionManufacturingBindings.id, productionManufacturingBindings.productionVersionId], name: "production_delivery_items_manufacturing_fk" }),
  check("production_delivery_items_manufacturing_check", sql`(${t.manufacturingBindingId} is null and ${t.manufacturingContentChecksum} is null and ${t.manufacturingPlanChecksum} is null)
    or (${t.manufacturingBindingId} is not null and ${t.manufacturingContentChecksum} is not null and ${t.manufacturingPlanChecksum} is not null
      and ${t.manufacturingContentChecksum}~'^[a-f0-9]{64}$' and ${t.manufacturingPlanChecksum}~'^[a-f0-9]{64}$')`),
]);
export const productionDeliveryFeedback = pgTable("production_delivery_feedback", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), itemId: uuid("item_id").notNull(),
  sequence: integer("sequence").notNull(), kind: text("kind").notNull(), idempotencyKey: uuid("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  encryptedEvidence: text("encrypted_evidence").notNull(), recordedBy: uuid("recorded_by").notNull().references(() => users.id),
  occurredAt: timestamp("occurred_at",{mode:"date",withTimezone:true}).notNull(), recordedAt: timestamp("recorded_at",{mode:"date",withTimezone:true}).notNull().defaultNow(),
}, t => [
  uniqueIndex("production_delivery_feedback_tenant_id_unique").on(t.tenantId,t.id),
  check("production_delivery_feedback_uuidv7_check",sql`substring(${t.id}::text from 15 for 1) = '7'`),
  check("production_delivery_feedback_state_check",sql`${t.sequence} > 0 and ${t.kind} in ('submitted','received','accepted','rejected','rework') and ${t.requestChecksum} ~ '^[a-f0-9]{64}$'`),
  foreignKey({columns:[t.tenantId,t.itemId],foreignColumns:[productionDeliveryItems.tenantId,productionDeliveryItems.id],name:"production_delivery_feedback_item_fk"}),
  uniqueIndex("production_delivery_feedback_sequence_unique").on(t.tenantId,t.itemId,t.sequence),
  uniqueIndex("production_delivery_feedback_request_unique").on(t.tenantId,t.itemId,t.idempotencyKey),
]);
