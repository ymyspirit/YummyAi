import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ProductionPhysicalQuantities, ProductionQuantityReportInput, ProductionQuantityReviewInput } from "@yummyai/contracts/order/production-quantity";
import { organizations, users } from "./identity.js";
import { productionOrders, productionOrderVersions } from "./order-production.js";
import { factoryCapacityReservations } from "./factory-capacity.js";

export const productionQuantityReports = pgTable("production_quantity_reports", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(),
  previousReviewId: uuid("previous_review_id"), basisFingerprint: text("basis_fingerprint").notNull(),
  input: jsonb("input").$type<ProductionQuantityReportInput>().notNull(),
  idempotencyKey: text("idempotency_key").notNull(), requestCanonical: text("request_canonical").notNull(), requestChecksum: text("request_checksum").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("production_quantity_reports_scope").on(table.tenantId, table.id),
  uniqueIndex("production_quantity_reports_parent").on(table.tenantId, table.id, table.productionOrderId, table.productionVersionId),
  uniqueIndex("production_quantity_reports_request").on(table.tenantId, table.idempotencyKey),
  foreignKey({ columns: [table.tenantId, table.productionOrderId], foreignColumns: [productionOrders.tenantId, productionOrders.id] }),
  foreignKey({ columns: [table.tenantId, table.productionVersionId, table.productionOrderId], foreignColumns: [productionOrderVersions.tenantId, productionOrderVersions.id, productionOrderVersions.productionOrderId] }),
  check("production_quantity_reports_hash", sql`${table.basisFingerprint}~'^[a-f0-9]{64}$' and ${table.requestChecksum}=encode(sha256(convert_to(${table.requestCanonical},'UTF8')),'hex')`),
]);

export const productionQuantityReviews = pgTable("production_quantity_reviews", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(),
  reportId: uuid("report_id").notNull(), sequence: integer("sequence").notNull(), previousReviewId: uuid("previous_review_id"),
  input: jsonb("input").$type<ProductionQuantityReviewInput>().notNull(),
  quantities: jsonb("quantities").$type<ProductionPhysicalQuantities>().notNull(),
  stoppedDelta: integer("stopped_delta").notNull(), cumulativeStoppedQuantity: integer("cumulative_stopped_quantity").notNull(),
  idempotencyKey: text("idempotency_key").notNull(), requestCanonical: text("request_canonical").notNull(), requestChecksum: text("request_checksum").notNull(),
  creationTransactionId: text("creation_transaction_id").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("production_quantity_reviews_scope").on(table.tenantId, table.id),
  uniqueIndex("production_quantity_reviews_parent").on(table.tenantId, table.id, table.productionOrderId, table.productionVersionId),
  uniqueIndex("production_quantity_reviews_report").on(table.tenantId, table.reportId),
  uniqueIndex("production_quantity_reviews_sequence").on(table.tenantId, table.productionOrderId, table.sequence),
  uniqueIndex("production_quantity_reviews_request").on(table.tenantId, table.idempotencyKey),
  foreignKey({ columns: [table.tenantId, table.reportId, table.productionOrderId, table.productionVersionId], foreignColumns: [productionQuantityReports.tenantId, productionQuantityReports.id, productionQuantityReports.productionOrderId, productionQuantityReports.productionVersionId] }),
  foreignKey({ columns: [table.tenantId, table.productionVersionId, table.productionOrderId], foreignColumns: [productionOrderVersions.tenantId, productionOrderVersions.id, productionOrderVersions.productionOrderId] }),
  check("production_quantity_reviews_count", sql`${table.sequence}>0 and ${table.stoppedDelta} between 0 and 100000 and ${table.cumulativeStoppedQuantity} between 0 and 100000`),
  check("production_quantity_reviews_hash", sql`${table.requestChecksum}=encode(sha256(convert_to(${table.requestCanonical},'UTF8')),'hex')`),
]);

/** One immutable paired reduction/release for each original resource reservation. */
export const factoryCapacityStopEffects = pgTable("factory_capacity_stop_effects", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  reviewId: uuid("review_id").notNull(), reservationId: uuid("reservation_id").notNull(),
  stoppedQuantity: integer("stopped_quantity").notNull(), releasedUnits: bigint("released_units", { mode: "number" }).notNull(),
  commitReductionUnits: bigint("commit_reduction_units", { mode: "number" }).notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("factory_capacity_stop_effects_scope").on(table.tenantId, table.id),
  uniqueIndex("factory_capacity_stop_effects_review").on(table.tenantId, table.reviewId, table.reservationId),
  foreignKey({ columns: [table.tenantId, table.reviewId], foreignColumns: [productionQuantityReviews.tenantId, productionQuantityReviews.id] }),
  foreignKey({ columns: [table.tenantId, table.reservationId], foreignColumns: [factoryCapacityReservations.tenantId, factoryCapacityReservations.id] }),
  check("factory_capacity_stop_effects_count", sql`${table.stoppedQuantity} between 1 and 100000 and ${table.releasedUnits} between 1 and 1000000000 and ${table.commitReductionUnits} between 0 and ${table.releasedUnits}`),
]);
