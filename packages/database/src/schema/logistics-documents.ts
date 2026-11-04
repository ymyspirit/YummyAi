import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex, foreignKey, index, check } from "drizzle-orm/pg-core";
import type { FactoryDocumentProfile, DocumentAdapter } from "@yummyai/contracts/logistics/documents";
import { organizations, users } from "./identity.js";
import { orders } from "./order.js";
import { fulfillmentFactories, fulfillmentFactoryVersions } from "./factory-directory.js";

const scope = () => ({ id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone:true, mode:"date" }).notNull().defaultNow() });
export const logisticsDocumentProfiles = pgTable("logistics_document_profiles", {
  ...scope(), factoryId: uuid("factory_id").notNull(), factoryVersionId: uuid("factory_version_id").notNull(),
  versionNumber: integer("version_number").notNull(), profile: jsonb("profile").$type<FactoryDocumentProfile>().notNull(),
  requestKey: uuid("request_key").notNull(), requestHash: text("request_hash").notNull(),
}, t => [ uniqueIndex("logistics_document_profiles_scope").on(t.tenantId,t.id),
  uniqueIndex("logistics_document_profiles_number").on(t.tenantId,t.factoryId,t.versionNumber),
  uniqueIndex("logistics_document_profiles_request").on(t.tenantId,t.requestKey),
  check("logistics_document_profiles_version_check",sql`${t.versionNumber}>0`),
  foreignKey({ columns:[t.tenantId,t.factoryId], foreignColumns:[fulfillmentFactories.tenantId,fulfillmentFactories.id] }),
  foreignKey({ columns:[t.tenantId,t.factoryId,t.factoryVersionId], foreignColumns:[fulfillmentFactoryVersions.tenantId,fulfillmentFactoryVersions.factoryId,fulfillmentFactoryVersions.id] }),
]);
/** An immutable file preparation receipt; never a shipment or a production event. */
export const logisticsDocumentExports = pgTable("logistics_document_exports", {
  ...scope(), profileVersionId: uuid("profile_version_id").notNull(), adapter: text("adapter").$type<DocumentAdapter>().notNull(),
  requestKey: uuid("request_key").notNull(), requestHash: text("request_hash").notNull(), sourceFingerprint: text("source_fingerprint").notNull(),
  encryptedSnapshot: text("encrypted_snapshot"), fileChecksum: text("file_checksum").notNull(),
  byteSize: integer("byte_size").notNull(), rowCount: integer("row_count").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone:true, mode:"date" }).notNull(),
}, t => [ uniqueIndex("logistics_document_exports_scope").on(t.tenantId,t.id),
  uniqueIndex("logistics_document_exports_request").on(t.tenantId,t.requestKey),
  uniqueIndex("logistics_document_exports_source").on(t.tenantId,t.profileVersionId,t.adapter,t.sourceFingerprint),
  foreignKey({ columns:[t.tenantId,t.profileVersionId], foreignColumns:[logisticsDocumentProfiles.tenantId,logisticsDocumentProfiles.id] }),
  index("logistics_document_exports_retention").on(t.tenantId,t.expiresAt),
  check("logistics_document_exports_size_check",sql`${t.byteSize}>0 and ${t.byteSize}<=10485760 and ${t.rowCount}>0`),
]);
export const logisticsDocumentOrders = pgTable("logistics_document_orders", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  exportId: uuid("export_id").notNull(), orderId: uuid("order_id").notNull(), sourceFingerprint:text("source_fingerprint").notNull(),
}, t => [ uniqueIndex("logistics_document_orders_scope").on(t.tenantId,t.id),
  uniqueIndex("logistics_document_orders_once").on(t.tenantId,t.exportId,t.orderId),
  index("logistics_document_orders_order").on(t.tenantId,t.orderId,t.exportId),
  foreignKey({ columns:[t.tenantId,t.exportId], foreignColumns:[logisticsDocumentExports.tenantId,logisticsDocumentExports.id] }),
  foreignKey({ columns:[t.tenantId,t.orderId], foreignColumns:[orders.tenantId,orders.id] }),
]);
/** Operator verified carrier evidence, not physical shipment confirmation. */
export const logisticsDocumentLabels = pgTable("logistics_document_labels", {
  ...scope(), exportId: uuid("export_id").notNull(), orderId: uuid("order_id").notNull(),
  requestKey: uuid("request_key").notNull(), requestHash: text("request_hash").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull(), encryptedSnapshot: text("encrypted_snapshot"),
  fileChecksum: text("file_checksum").notNull(), byteSize: integer("byte_size").notNull(),
  scanEvidence: jsonb("scan_evidence").$type<{ engine: string; signatureVersion: string; scannedAt: string }>().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone:true, mode:"date" }).notNull(),
}, t => [uniqueIndex("logistics_document_labels_scope").on(t.tenantId,t.id),
  uniqueIndex("logistics_document_labels_request").on(t.tenantId,t.requestKey),
  index("logistics_document_labels_order").on(t.tenantId,t.orderId,t.createdAt),
  foreignKey({columns:[t.tenantId,t.exportId,t.orderId],foreignColumns:[logisticsDocumentOrders.tenantId,logisticsDocumentOrders.exportId,logisticsDocumentOrders.orderId]}),
  check("logistics_document_labels_size",sql`${t.byteSize}>0 and ${t.byteSize}<=5242880`),
]);
