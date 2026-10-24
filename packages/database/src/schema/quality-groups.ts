import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations } from "./identity.js";
import { productionOrders, productionOrderVersions, productionRecoveryCases, qualityDefects, qualityInspections } from "./order-production.js";

export const qualityInspectionGroups = pgTable("quality_inspection_groups", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(),
  inspectionId: uuid("inspection_id").notNull(), assessmentVersion: integer("assessment_version").default(3).notNull(),
  groupKey: text("group_key").notNull(), label: text("label").notNull(), quantity: integer("quantity").notNull(),
  segregationConfirmed: boolean("segregation_confirmed").notNull(),
  result: text("result").notNull(), scoreBps: integer("score_bps").notNull(),
  criterionResults: jsonb("criterion_results").$type<Array<{ code: string; scoreBps: number; passed: boolean; evidenceAssetIds: string[] }>>().notNull(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, table => [
  check("quality_groups_uuid_check", sql`substring(${table.id}::text from 15 for 1)='7'`),
  check("quality_groups_segregation_check", sql`${table.segregationConfirmed} is true`),
  check("quality_groups_values_check", sql`${table.quantity} between 1 and 100000 and ${table.assessmentVersion}=3 and ${table.result} in ('passed','failed') and ${table.scoreBps} between 0 and 10000 and length(btrim(${table.label})) between 1 and 160 and ${table.groupKey} ~ '^[A-Za-z0-9_-]{1,100}$' and jsonb_typeof(${table.criterionResults})='array' and jsonb_array_length(${table.criterionResults}) between 1 and 200`),
  foreignKey({ columns: [table.tenantId, table.inspectionId, table.productionOrderId, table.productionVersionId, table.assessmentVersion], foreignColumns: [qualityInspections.tenantId, qualityInspections.id, qualityInspections.productionOrderId, qualityInspections.productionVersionId, qualityInspections.assessmentVersion], name: "quality_groups_inspection_fk" }).onDelete("restrict"),
  uniqueIndex("quality_groups_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("quality_groups_key_unique").on(table.tenantId, table.inspectionId, table.groupKey),
  uniqueIndex("quality_groups_source_unique").on(table.tenantId, table.id, table.productionOrderId, table.productionVersionId),
  uniqueIndex("quality_groups_inspection_source_unique").on(table.tenantId, table.id, table.inspectionId, table.productionOrderId),
  uniqueIndex("quality_groups_quantity_proof_unique").on(table.tenantId, table.id, table.inspectionId, table.productionOrderId, table.quantity),
  uniqueIndex("quality_groups_passed_proof_unique").on(table.tenantId, table.id, table.productionOrderId, table.productionVersionId, table.inspectionId, table.result),
  index("quality_groups_production_idx").on(table.tenantId, table.productionOrderId, table.createdAt),
]);

export const qualityGroupDefects = pgTable("quality_group_defects", {
  defectId: uuid("defect_id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  qualityGroupId: uuid("quality_group_id").notNull(), productionOrderId: uuid("production_order_id").notNull(),
  inspectionId: uuid("inspection_id").notNull(), affectedQuantity: integer("affected_quantity").notNull(),
}, table => [
  check("quality_group_defects_quantity_check", sql`${table.affectedQuantity}>0`),
  foreignKey({ columns: [table.tenantId, table.defectId, table.inspectionId, table.productionOrderId], foreignColumns: [qualityDefects.tenantId, qualityDefects.id, qualityDefects.inspectionId, qualityDefects.productionOrderId], name: "quality_group_defects_defect_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.qualityGroupId, table.inspectionId, table.productionOrderId, table.affectedQuantity], foreignColumns: [qualityInspectionGroups.tenantId, qualityInspectionGroups.id, qualityInspectionGroups.inspectionId, qualityInspectionGroups.productionOrderId, qualityInspectionGroups.quantity], name: "quality_group_defects_quantity_fk" }).onDelete("restrict"),
]);

export const qualityGroupReinspections = pgTable("quality_group_reinspections", {
  parentGroupId: uuid("parent_group_id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  inspectionId: uuid("inspection_id").notNull(), productionOrderId: uuid("production_order_id").notNull(),
  productionVersionId: uuid("production_version_id").notNull(), assessmentVersion: integer("assessment_version").default(3).notNull(),
}, table => [
  check("quality_group_reinspections_format_check", sql`${table.assessmentVersion}=3`),
  uniqueIndex("quality_group_reinspections_inspection_unique").on(table.tenantId, table.inspectionId),
  foreignKey({ columns: [table.tenantId, table.parentGroupId, table.productionOrderId, table.productionVersionId], foreignColumns: [qualityInspectionGroups.tenantId, qualityInspectionGroups.id, qualityInspectionGroups.productionOrderId, qualityInspectionGroups.productionVersionId], name: "quality_group_reinspections_parent_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.inspectionId, table.productionOrderId, table.productionVersionId, table.assessmentVersion], foreignColumns: [qualityInspections.tenantId, qualityInspections.id, qualityInspections.productionOrderId, qualityInspections.productionVersionId, qualityInspections.assessmentVersion], name: "quality_group_reinspections_inspection_fk" }).onDelete("restrict"),
]);

export const productionRecoveryGroups = pgTable("production_recovery_groups", {
  recoveryCaseId: uuid("recovery_case_id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  qualityGroupId: uuid("quality_group_id").notNull(), productionOrderId: uuid("production_order_id").notNull(),
  productionVersionId: uuid("production_version_id").notNull(), replacementProductionOrderId: uuid("replacement_production_order_id").notNull(),
  replacementProductionVersionId: uuid("replacement_production_version_id").notNull(), quantity: integer("quantity").notNull(),
  selectionConfirmed: boolean("selection_confirmed").notNull(),
}, table => [
  check("production_recovery_groups_quantity_check", sql`${table.quantity}>0`),
  check("production_recovery_groups_selection_check", sql`${table.selectionConfirmed} is true`),
  foreignKey({ columns: [table.tenantId, table.recoveryCaseId, table.productionOrderId], foreignColumns: [productionRecoveryCases.tenantId, productionRecoveryCases.id, productionRecoveryCases.originalProductionOrderId], name: "recovery_groups_case_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.qualityGroupId, table.productionOrderId, table.productionVersionId], foreignColumns: [qualityInspectionGroups.tenantId, qualityInspectionGroups.id, qualityInspectionGroups.productionOrderId, qualityInspectionGroups.productionVersionId], name: "recovery_groups_source_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.replacementProductionOrderId, table.productionOrderId], foreignColumns: [productionOrders.tenantId, productionOrders.id, productionOrders.parentProductionOrderId], name: "recovery_groups_replacement_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.replacementProductionVersionId, table.replacementProductionOrderId, table.quantity], foreignColumns: [productionOrderVersions.tenantId, productionOrderVersions.id, productionOrderVersions.productionOrderId, productionOrderVersions.quantity], name: "recovery_groups_replacement_quantity_fk" }).onDelete("restrict"),
  index("recovery_groups_source_idx").on(table.tenantId, table.qualityGroupId),
]);
