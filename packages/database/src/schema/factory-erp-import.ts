import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, type PgTableExtraConfigValue } from "drizzle-orm/pg-core";
import type { ApplyFactoryErpImport, FactoryErpApplyResult } from "@yummyai/contracts/order/factory-erp-import";
import type { ChangeFactoryErpBinding, FactoryErpBindingChangeResult } from "@yummyai/contracts/order/factory-erp-binding";
import type { ReviewFactoryErpVoid, FactoryErpVoidReviewResult } from "@yummyai/contracts/order/factory-erp-void-review";
import { organizations, users } from "./identity.js";
import { fulfillmentFactories } from "./factory-directory.js";
import { productionDeliveryItems } from "./order-production-delivery.js";
export type FactoryErpSourceClaim = { rowNumber: number; rowChecksum: string; externalKey: string; quantity: number; rawStatus: "已审核" | "已出库" | "已作废" | null };

export const factoryErpImports = pgTable("factory_erp_imports", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(),
  fileChecksum: text("file_checksum").notNull(), byteSize: integer("byte_size").notNull(), objectKey: text("object_key").notNull(), storedChecksum: text("stored_checksum").notNull(),
  previewChecksum: text("preview_checksum").notNull(), encryptedPayload: text("encrypted_payload"), privateRedactedAt: timestamp("private_redacted_at", { withTimezone: true }),
  sourceClaims: jsonb("source_claims").$type<FactoryErpSourceClaim[]>().notNull(), sourceProof: text("source_proof").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), creationTransactionId: text("creation_transaction_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex("factory_erp_imports_scope").on(t.tenantId, t.id), uniqueIndex("factory_erp_imports_request").on(t.tenantId, t.idempotencyKey),
  index("factory_erp_imports_factory").on(t.tenantId, t.factoryId, t.createdAt, t.id),
  index("factory_erp_imports_retention").on(t.tenantId, t.expiresAt, t.id).where(sql`${t.privateRedactedAt} is null`),
  foreignKey({ columns: [t.tenantId, t.factoryId], foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.id], name: "factory_erp_imports_factory_fk" }),
  check("factory_erp_imports_bytes", sql`${t.byteSize} between 1 and 5242880`),
  check("factory_erp_imports_private_pair", sql`(${t.encryptedPayload} is null)=(${t.privateRedactedAt} is not null)`),
]);
export const factoryErpApplications = pgTable("factory_erp_applications", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), importId: uuid("import_id").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(), requestCanonical: text("request_canonical").notNull(), requestChecksum: text("request_checksum").notNull(),
  input: jsonb("input").$type<ApplyFactoryErpImport>().notNull(), result: jsonb("result").$type<FactoryErpApplyResult>().notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), creationTransactionId: text("creation_transaction_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex("factory_erp_applications_scope").on(t.tenantId, t.id), uniqueIndex("factory_erp_applications_request").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("factory_erp_applications_birth").on(t.tenantId, t.creationTransactionId),
  index("factory_erp_applications_import").on(t.tenantId, t.importId, t.id),
  foreignKey({ columns: [t.tenantId, t.importId], foreignColumns: [factoryErpImports.tenantId, factoryErpImports.id], name: "factory_erp_applications_import_fk" }),
  check("factory_erp_applications_hash", sql`${t.requestChecksum}=encode(sha256(convert_to(${t.requestCanonical},'UTF8')),'hex')`),
]);
export const factoryErpBindings = pgTable("factory_erp_bindings", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(),
  externalKey: text("external_key").notNull(), encryptedPayload: text("encrypted_payload"), privateRedactedAt: timestamp("private_redacted_at", { withTimezone: true }), itemsChecksum: text("items_checksum").notNull(),
  quantity: integer("quantity").notNull(), applicationId: uuid("application_id").notNull(),
  revision: integer("revision").notNull().default(1), previousBindingId: uuid("previous_binding_id"), releasedBy: uuid("released_by"),
  createdBy: uuid("created_by").notNull().references(() => users.id), creationTransactionId: text("creation_transaction_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex("factory_erp_bindings_scope").on(t.tenantId, t.id),
  uniqueIndex("factory_erp_bindings_external").on(t.tenantId, t.factoryId, t.externalKey).where(sql`${t.releasedBy} is null`),
  uniqueIndex("factory_erp_bindings_revision").on(t.tenantId, t.factoryId, t.externalKey, t.revision),
  uniqueIndex("factory_erp_bindings_previous").on(t.tenantId, t.previousBindingId).where(sql`${t.previousBindingId} is not null`),
  index("factory_erp_bindings_application").on(t.tenantId, t.applicationId, t.id),
  foreignKey({ columns: [t.tenantId, t.factoryId], foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.id], name: "factory_erp_bindings_factory_fk" }),
  foreignKey({ columns: [t.tenantId, t.applicationId], foreignColumns: [factoryErpApplications.tenantId, factoryErpApplications.id], name: "factory_erp_bindings_application_fk" }),
  foreignKey({ columns: [t.tenantId, t.previousBindingId], foreignColumns: [t.tenantId, t.id], name: "factory_erp_bindings_previous_fk" }),
  foreignKey({ columns: [t.tenantId, t.releasedBy], foreignColumns: [factoryErpBindingChanges.tenantId, factoryErpBindingChanges.id], name: "factory_erp_bindings_release_fk" }),
  check("factory_erp_bindings_quantity", sql`${t.quantity} between 1 and 100000`),
  check("factory_erp_bindings_private_pair", sql`(${t.encryptedPayload} is null)=(${t.privateRedactedAt} is not null)`),
  check("factory_erp_bindings_revision_shape", sql`${t.revision} between 1 and 1000000 and ((${t.revision}=1)=(${t.previousBindingId} is null))`),
]);
export const factoryErpBindingItems = pgTable("factory_erp_binding_items", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), bindingId: uuid("binding_id").notNull(), deliveryItemId: uuid("delivery_item_id").notNull(),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(),
  fileChecksum: text("file_checksum").notNull(), manufacturingChecksum: text("manufacturing_checksum").notNull(), quantity: integer("quantity").notNull(),
  releasedBy: uuid("released_by"),
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex("factory_erp_binding_items_scope").on(t.tenantId, t.id),
  uniqueIndex("factory_erp_binding_items_delivery").on(t.tenantId, t.deliveryItemId).where(sql`${t.releasedBy} is null`),
  uniqueIndex("factory_erp_binding_items_version").on(t.tenantId, t.productionOrderId, t.productionVersionId).where(sql`${t.releasedBy} is null`),
  foreignKey({ columns: [t.tenantId, t.bindingId], foreignColumns: [factoryErpBindings.tenantId, factoryErpBindings.id], name: "factory_erp_binding_items_binding_fk" }),
  foreignKey({ columns: [t.tenantId, t.deliveryItemId], foreignColumns: [productionDeliveryItems.tenantId, productionDeliveryItems.id], name: "factory_erp_binding_items_delivery_fk" }),
  foreignKey({ columns: [t.tenantId, t.releasedBy], foreignColumns: [factoryErpBindingChanges.tenantId, factoryErpBindingChanges.id], name: "factory_erp_binding_items_release_fk" }),
]);
export const factoryErpBindingChanges = pgTable("factory_erp_binding_changes", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(),
  bindingId: uuid("binding_id").notNull(), sourceImportId: uuid("source_import_id").notNull(), sourceRowNumber: integer("source_row_number").notNull(),
  action: text("action").notNull(), replacementBindingId: uuid("replacement_binding_id"), replacementApplicationId: uuid("replacement_application_id"),
  idempotencyKey: uuid("idempotency_key").notNull(), requestCanonical: text("request_canonical").notNull(), requestChecksum: text("request_checksum").notNull(),
  input: jsonb("input").$type<ChangeFactoryErpBinding>().notNull(), result: jsonb("result").$type<FactoryErpBindingChangeResult>().notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), creationTransactionId: text("creation_transaction_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex("factory_erp_binding_changes_scope").on(t.tenantId, t.id),
  uniqueIndex("factory_erp_binding_changes_request").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("factory_erp_binding_changes_binding").on(t.tenantId, t.bindingId),
  uniqueIndex("factory_erp_binding_changes_birth").on(t.tenantId, t.creationTransactionId),
  index("factory_erp_binding_changes_factory").on(t.tenantId, t.factoryId, t.id),
  foreignKey({ columns: [t.tenantId, t.factoryId], foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.id], name: "factory_erp_binding_changes_factory_fk" }),
  foreignKey({ columns: [t.tenantId, t.bindingId], foreignColumns: [factoryErpBindings.tenantId, factoryErpBindings.id], name: "factory_erp_binding_changes_binding_fk" }),
  foreignKey({ columns: [t.tenantId, t.sourceImportId], foreignColumns: [factoryErpImports.tenantId, factoryErpImports.id], name: "factory_erp_binding_changes_source_fk" }),
  foreignKey({ columns: [t.tenantId, t.replacementBindingId], foreignColumns: [factoryErpBindings.tenantId, factoryErpBindings.id], name: "factory_erp_binding_changes_replacement_fk" }),
  foreignKey({ columns: [t.tenantId, t.replacementApplicationId], foreignColumns: [factoryErpApplications.tenantId, factoryErpApplications.id], name: "factory_erp_binding_changes_application_fk" }),
  check("factory_erp_binding_changes_action", sql`${t.action} in ('release','correct') and (${t.action}='correct')=(${t.replacementBindingId} is not null) and (${t.action}='correct')=(${t.replacementApplicationId} is not null)`),
  check("factory_erp_binding_changes_row", sql`${t.sourceRowNumber} between 2 and 5001`),
  check("factory_erp_binding_changes_hash", sql`${t.requestChecksum}=encode(sha256(convert_to(${t.requestCanonical},'UTF8')),'hex')`),
]);
export const factoryErpObservations = pgTable("factory_erp_observations", {
  id: uuid("id").primaryKey(), sequence: bigint("sequence", { mode: "number" }).generatedAlwaysAsIdentity().notNull(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id), bindingId: uuid("binding_id").notNull(), applicationId: uuid("application_id").notNull(), importId: uuid("import_id").notNull(),
  rowNumber: integer("row_number").notNull(), rowChecksum: text("row_checksum").notNull(), rawStatus: text("raw_status").notNull(),
  encryptedPayload: text("encrypted_payload"), privateRedactedAt: timestamp("private_redacted_at", { withTimezone: true }), createdBy: uuid("created_by").notNull().references(() => users.id),
  creationTransactionId: text("creation_transaction_id").notNull(), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("factory_erp_observations_scope").on(t.tenantId, t.id), uniqueIndex("factory_erp_observations_fact").on(t.tenantId, t.bindingId, t.rowChecksum),
  index("factory_erp_observations_history").on(t.tenantId, t.bindingId, t.sequence),
  index("factory_erp_observations_import").on(t.tenantId, t.importId, t.id),
  foreignKey({ columns: [t.tenantId, t.bindingId], foreignColumns: [factoryErpBindings.tenantId, factoryErpBindings.id], name: "factory_erp_observations_binding_fk" }),
  foreignKey({ columns: [t.tenantId, t.applicationId], foreignColumns: [factoryErpApplications.tenantId, factoryErpApplications.id], name: "factory_erp_observations_application_fk" }),
  foreignKey({ columns: [t.tenantId, t.importId], foreignColumns: [factoryErpImports.tenantId, factoryErpImports.id], name: "factory_erp_observations_import_fk" }),
  check("factory_erp_observations_status", sql`${t.rawStatus} in ('已审核','已出库','已作废') and ${t.rowNumber} between 2 and 5001`),
  check("factory_erp_observations_private_pair", sql`(${t.encryptedPayload} is null)=(${t.privateRedactedAt} is not null)`),
]);
export const factoryErpApplicationRows = pgTable("factory_erp_application_rows", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), applicationId: uuid("application_id").notNull(),
  rowNumber: integer("row_number").notNull(), bindingId: uuid("binding_id").notNull(), observationId: uuid("observation_id").notNull(), disposition: text("disposition").notNull(),
}, t => [
  uniqueIndex("factory_erp_application_rows_number").on(t.tenantId, t.applicationId, t.rowNumber),
  foreignKey({ columns: [t.tenantId, t.applicationId], foreignColumns: [factoryErpApplications.tenantId, factoryErpApplications.id], name: "factory_erp_application_rows_application_fk" }),
  foreignKey({ columns: [t.tenantId, t.bindingId], foreignColumns: [factoryErpBindings.tenantId, factoryErpBindings.id], name: "factory_erp_application_rows_binding_fk" }),
  foreignKey({ columns: [t.tenantId, t.observationId], foreignColumns: [factoryErpObservations.tenantId, factoryErpObservations.id], name: "factory_erp_application_rows_observation_fk" }),
  check("factory_erp_application_rows_disposition", sql`${t.disposition} in ('advanced','unchanged','exception')`),
]);

export const factoryErpVoidReviews = pgTable("factory_erp_void_reviews", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(),
  bindingId: uuid("binding_id").notNull(), observationId: uuid("observation_id").notNull(),
  reviewRevision: integer("review_revision").notNull(), previousReviewId: uuid("previous_review_id"),
  sourceImportId: uuid("source_import_id").notNull(), sourceRowNumber: integer("source_row_number").notNull(),
  outcome: text("outcome").notNull(), reasonCode: text("reason_code").notNull(), idempotencyKey: uuid("idempotency_key").notNull(),
  requestCanonical: text("request_canonical").notNull(), requestChecksum: text("request_checksum").notNull(),
  input: jsonb("input").$type<ReviewFactoryErpVoid>().notNull(), result: jsonb("result").$type<FactoryErpVoidReviewResult>().notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), creationTransactionId: text("creation_transaction_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t): PgTableExtraConfigValue[] => [
  uniqueIndex("factory_erp_void_reviews_scope").on(t.tenantId, t.id),
  uniqueIndex("factory_erp_void_reviews_request").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("factory_erp_void_reviews_revision").on(t.tenantId, t.observationId, t.reviewRevision),
  uniqueIndex("factory_erp_void_reviews_previous").on(t.tenantId, t.previousReviewId).where(sql`${t.previousReviewId} is not null`),
  uniqueIndex("factory_erp_void_reviews_birth").on(t.tenantId, t.creationTransactionId),
  index("factory_erp_void_reviews_binding").on(t.tenantId, t.bindingId, t.id),
  foreignKey({ columns: [t.tenantId, t.factoryId], foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.id], name: "factory_erp_void_reviews_factory_fk" }),
  foreignKey({ columns: [t.tenantId, t.bindingId], foreignColumns: [factoryErpBindings.tenantId, factoryErpBindings.id], name: "factory_erp_void_reviews_binding_fk" }),
  foreignKey({ columns: [t.tenantId, t.observationId], foreignColumns: [factoryErpObservations.tenantId, factoryErpObservations.id], name: "factory_erp_void_reviews_observation_fk" }),
  foreignKey({ columns: [t.tenantId, t.previousReviewId], foreignColumns: [factoryErpVoidReviews.tenantId, factoryErpVoidReviews.id], name: "factory_erp_void_reviews_previous_fk" }),
  foreignKey({ columns: [t.tenantId, t.sourceImportId], foreignColumns: [factoryErpImports.tenantId, factoryErpImports.id], name: "factory_erp_void_reviews_source_fk" }),
  check("factory_erp_void_reviews_id", sql`substring(${t.id}::text from 15 for 1)='7'`),
  check("factory_erp_void_reviews_revision_shape", sql`${t.reviewRevision} between 1 and 1000000 and ((${t.reviewRevision}=1)=(${t.previousReviewId} is null))`),
  check("factory_erp_void_reviews_row", sql`${t.sourceRowNumber} between 2 and 5001`),
  check("factory_erp_void_reviews_outcome", sql`${t.outcome} in ('confirmed_active','confirmed_voided','export_record_incorrect','followup_required')
    and ${t.reasonCode} in ('factory_contact','corrected_export','conflicting_records','binding_mismatch','needs_factory_confirmation')
    and ((${t.outcome}='followup_required')=(${t.reasonCode} in ('conflicting_records','binding_mismatch','needs_factory_confirmation')))`),
  check("factory_erp_void_reviews_hash", sql`${t.requestChecksum}=encode(sha256(convert_to(${t.requestCanonical},'UTF8')),'hex')`),
]);

export const factoryErpSourcePurges = pgTable("factory_erp_source_purges", {
  importId: uuid("import_id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  objectKey: text("object_key").notNull(), storedChecksum: text("stored_checksum").notNull(),
  redactedAt: timestamp("redacted_at", { withTimezone: true }).notNull(), creationTransactionId: text("creation_transaction_id").notNull(),
  leaseToken: uuid("lease_token"), leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }), attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(), lastFailureCode: text("last_failure_code"),
  purgedAt: timestamp("purged_at", { withTimezone: true }), deletedVersions: integer("deleted_versions"), completionTransactionId: text("completion_transaction_id"),
}, t => [
  uniqueIndex("factory_erp_source_purges_scope").on(t.tenantId, t.importId),
  uniqueIndex("factory_erp_source_purges_token").on(t.leaseToken).where(sql`${t.leaseToken} is not null`),
  index("factory_erp_source_purges_due").on(t.tenantId, t.nextAttemptAt, t.importId).where(sql`${t.purgedAt} is null`),
  foreignKey({ columns: [t.tenantId, t.importId], foreignColumns: [factoryErpImports.tenantId, factoryErpImports.id], name: "factory_erp_source_purges_source_fk" }),
  check("factory_erp_source_purges_lease_pair", sql`(${t.leaseToken} is null)=(${t.leaseExpiresAt} is null)`),
  check("factory_erp_source_purges_counts", sql`${t.attempts}>=0 and (${t.deletedVersions} is null or ${t.deletedVersions} between 0 and 100000)`),
  check("factory_erp_source_purges_failure", sql`${t.lastFailureCode} is null or ${t.lastFailureCode} in ('storage_delete_failed','absence_unconfirmed')`),
  check("factory_erp_source_purges_completed", sql`(${t.purgedAt} is null)=(${t.completionTransactionId} is null) and (${t.purgedAt} is null)=(${t.deletedVersions} is null)
    and (${t.purgedAt} is null or (${t.leaseToken} is not null and ${t.lastFailureCode} is null and ${t.purgedAt}>=${t.redactedAt}))`),
]);
