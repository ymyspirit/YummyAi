import type { CustomizationDefinition } from "@yummyai/contracts";
import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { assetFiles } from "./assets.js";
import { designVersions } from "./design.js";
import { organizations, users } from "./identity.js";
import { orderLines, orders } from "./order.js";

export const orderCustomizationRequirements = pgTable("order_customization_requirements", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  orderLineId: uuid("order_line_id").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  schemaSnapshot: jsonb("schema_snapshot").$type<CustomizationDefinition>().notNull(),
  fulfillmentPath: text("fulfillment_path").notNull(),
  status: text("status").notNull(),
  customerApprovalDueAt: timestamp("customer_approval_due_at", { mode: "date", withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_customization_requirements_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_customization_requirements_schema_version_check", sql`${table.schemaVersion} > 0`),
  check("order_customization_requirements_path_check", sql`${table.fulfillmentPath} in ('template_ready','designer_required','customer_approval_required')`),
  check("order_customization_requirements_status_check", sql`${table.status} in ('incomplete','ready','awaiting_design','awaiting_customer','approved','rejected','quarantined')`),
  check("order_customization_requirements_due_check", sql`${table.fulfillmentPath} <> 'customer_approval_required' or ${table.customerApprovalDueAt} is not null`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_customization_requirements_order_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.orderLineId], foreignColumns: [orderLines.tenantId, orderLines.id], name: "order_customization_requirements_line_fk" }).onDelete("restrict"),
  uniqueIndex("order_customization_requirements_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_customization_requirements_line_unique").on(table.tenantId, table.orderLineId),
  index("order_customization_requirements_status_idx").on(table.tenantId, table.status, table.updatedAt),
]);

export const orderCustomizationVersions = pgTable("order_customization_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  requirementId: uuid("requirement_id").notNull(),
  versionNumber: integer("version_number").notNull(),
  encryptedValues: text("encrypted_values").notNull(),
  valuesChecksum: text("values_checksum").notNull(),
  mappedFieldKeys: jsonb("mapped_field_keys").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  missingFieldKeys: jsonb("missing_field_keys").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  fileFieldKeys: jsonb("file_field_keys").$type<string[]>().default(sql`'[]'::jsonb`).notNull(),
  completeness: integer("completeness").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_customization_versions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_customization_versions_number_check", sql`${table.versionNumber} > 0`),
  check("order_customization_versions_checksum_check", sql`${table.valuesChecksum} ~ '^[0-9a-f]{64}$'`),
  check("order_customization_versions_completeness_check", sql`${table.completeness} between 0 and 100`),
  foreignKey({ columns: [table.tenantId, table.requirementId], foreignColumns: [orderCustomizationRequirements.tenantId, orderCustomizationRequirements.id], name: "order_customization_versions_requirement_fk" }).onDelete("restrict"),
  uniqueIndex("order_customization_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_customization_versions_number_unique").on(table.tenantId, table.requirementId, table.versionNumber),
  index("order_customization_versions_requirement_idx").on(table.tenantId, table.requirementId, table.createdAt),
]);

export const orderCustomizationFileIntakes = pgTable("order_customization_file_intakes", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customizationVersionId: uuid("customization_version_id").notNull(),
  fieldKey: text("field_key").notNull(),
  objectKey: text("object_key").notNull(),
  safeFileName: text("safe_file_name").notNull(),
  mediaType: text("media_type").notNull(),
  byteSize: bigint("byte_size", { mode: "number" }).notNull(),
  checksumSha256: text("checksum_sha256").notNull(),
  scanStatus: text("scan_status").default("pending").notNull(),
  authorizedAssetId: uuid("authorized_asset_id"),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_customization_file_intakes_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_customization_file_intakes_object_key_check", sql`${table.objectKey} like 'tenants/' || ${table.tenantId}::text || '/quarantine/%'`),
  check("order_customization_file_intakes_size_check", sql`${table.byteSize} > 0`),
  check("order_customization_file_intakes_checksum_check", sql`${table.checksumSha256} ~ '^[0-9a-f]{64}$'`),
  check("order_customization_file_intakes_scan_check", sql`${table.scanStatus} in ('pending','clean','infected','unsupported','failed','promoted')`),
  foreignKey({ columns: [table.tenantId, table.customizationVersionId], foreignColumns: [orderCustomizationVersions.tenantId, orderCustomizationVersions.id], name: "order_customization_file_intakes_version_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.authorizedAssetId], foreignColumns: [assetFiles.tenantId, assetFiles.id], name: "order_customization_file_intakes_asset_fk" }).onDelete("restrict"),
  uniqueIndex("order_customization_file_intakes_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_customization_file_intakes_object_unique").on(table.tenantId, table.objectKey),
  index("order_customization_file_intakes_scan_idx").on(table.tenantId, table.scanStatus, table.createdAt),
]);

export const orderCustomizationFileScanEvents = pgTable("order_customization_file_scan_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  intakeId: uuid("intake_id").notNull(),
  sequence: integer("sequence").notNull(),
  result: text("result").notNull(),
  engine: text("engine").notNull(),
  signatureVersion: text("signature_version").notNull(),
  scannedAt: timestamp("scanned_at", { mode: "date", withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_customization_file_scan_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_customization_file_scan_events_sequence_check", sql`${table.sequence} > 0`),
  check("order_customization_file_scan_events_result_check", sql`${table.result} in ('clean','infected','unsupported','failed')`),
  foreignKey({ columns: [table.tenantId, table.intakeId], foreignColumns: [orderCustomizationFileIntakes.tenantId, orderCustomizationFileIntakes.id], name: "order_customization_file_scan_events_intake_fk" }).onDelete("restrict"),
  uniqueIndex("order_customization_file_scan_events_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_customization_file_scan_events_sequence_unique").on(table.tenantId, table.intakeId, table.sequence),
  index("order_customization_file_scan_events_intake_idx").on(table.tenantId, table.intakeId, table.recordedAt),
]);

export const orderProofVersions = pgTable("order_proof_versions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  orderId: uuid("order_id").notNull(),
  orderLineId: uuid("order_line_id").notNull(),
  customizationVersionId: uuid("customization_version_id").notNull(),
  designVersionId: uuid("design_version_id"),
  versionNumber: integer("version_number").notNull(),
  dueAt: timestamp("due_at", { mode: "date", withTimezone: true }),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_proof_versions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_proof_versions_number_check", sql`${table.versionNumber} > 0`),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_proof_versions_order_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.orderLineId], foreignColumns: [orderLines.tenantId, orderLines.id], name: "order_proof_versions_line_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.customizationVersionId], foreignColumns: [orderCustomizationVersions.tenantId, orderCustomizationVersions.id], name: "order_proof_versions_customization_fk" }).onDelete("restrict"),
  foreignKey({ columns: [table.tenantId, table.designVersionId], foreignColumns: [designVersions.tenantId, designVersions.id], name: "order_proof_versions_design_fk" }).onDelete("restrict"),
  uniqueIndex("order_proof_versions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_proof_versions_number_unique").on(table.tenantId, table.orderLineId, table.versionNumber),
  index("order_proof_versions_due_idx").on(table.tenantId, table.dueAt, table.createdAt),
]);

export const orderProofDecisions = pgTable("order_proof_decisions", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  proofVersionId: uuid("proof_version_id").notNull(),
  decision: text("decision").notNull(),
  externalDecisionId: text("external_decision_id").notNull(),
  reasonCode: text("reason_code"),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("order_proof_decisions_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("order_proof_decisions_decision_check", sql`${table.decision} in ('approved','rejected','timed_out')`),
  check("order_proof_decisions_rejection_check", sql`${table.decision} <> 'rejected' or ${table.reasonCode} is not null`),
  foreignKey({ columns: [table.tenantId, table.proofVersionId], foreignColumns: [orderProofVersions.tenantId, orderProofVersions.id], name: "order_proof_decisions_proof_fk" }).onDelete("restrict"),
  uniqueIndex("order_proof_decisions_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_proof_decisions_external_unique").on(table.tenantId, table.proofVersionId, table.externalDecisionId),
  index("order_proof_decisions_proof_idx").on(table.tenantId, table.proofVersionId, table.occurredAt),
]);
