import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { AllocateQualityScrapInput } from "@yummyai/contracts/order/quality-scrap";
import { organizations, users } from "./identity.js";
import { productionOrders, productionOrderVersions, qualityInspections } from "./order-production.js";
import { qualityInspectionGroups } from "./quality-groups.js";
import { productionQuantityReviews } from "./production-quantity.js";

export const qualityScrapReviews = pgTable("quality_scrap_reviews", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(),
  rootInspectionId: uuid("root_inspection_id").notNull(), quantityReviewId: uuid("quantity_review_id").notNull(), previousReviewId: uuid("previous_review_id"),
  input: jsonb("input").$type<AllocateQualityScrapInput>().notNull(), idempotencyKey: text("idempotency_key").notNull(),
  requestCanonical: text("request_canonical").notNull(), requestChecksum: text("request_checksum").notNull(),
  creationTransactionId: text("creation_transaction_id").notNull(), createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("quality_scrap_reviews_scope").on(table.tenantId, table.id),
  uniqueIndex("quality_scrap_reviews_parent").on(table.tenantId, table.id, table.productionOrderId, table.productionVersionId),
  uniqueIndex("quality_scrap_reviews_request").on(table.tenantId, table.idempotencyKey),
  foreignKey({ columns: [table.tenantId, table.productionOrderId], foreignColumns: [productionOrders.tenantId, productionOrders.id] }),
  foreignKey({ columns: [table.tenantId, table.productionVersionId, table.productionOrderId], foreignColumns: [productionOrderVersions.tenantId, productionOrderVersions.id, productionOrderVersions.productionOrderId] }),
  foreignKey({ columns: [table.tenantId, table.quantityReviewId, table.productionOrderId, table.productionVersionId], foreignColumns: [productionQuantityReviews.tenantId, productionQuantityReviews.id, productionQuantityReviews.productionOrderId, productionQuantityReviews.productionVersionId] }),
  foreignKey({ columns: [table.tenantId, table.rootInspectionId], foreignColumns: [qualityInspections.tenantId, qualityInspections.id] }),
  foreignKey({ columns: [table.tenantId, table.previousReviewId, table.productionOrderId, table.productionVersionId], foreignColumns: [table.tenantId, table.id, table.productionOrderId, table.productionVersionId] }),
  check("quality_scrap_reviews_hash", sql`${table.requestChecksum}=encode(sha256(convert_to(${table.requestCanonical},'UTF8')),'hex')`),
]);

export const qualityScrapAllocations = pgTable("quality_scrap_allocations", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  reviewId: uuid("review_id").notNull(), productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(),
  qualityGroupId: uuid("quality_group_id").notNull(), sourceQuantityReviewId: uuid("source_quantity_review_id").notNull(), quantity: integer("quantity").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("quality_scrap_allocations_scope").on(table.tenantId, table.id),
  uniqueIndex("quality_scrap_allocations_line").on(table.tenantId, table.reviewId, table.qualityGroupId, table.sourceQuantityReviewId),
  index("quality_scrap_allocations_group").on(table.tenantId, table.qualityGroupId),
  index("quality_scrap_allocations_source").on(table.tenantId, table.sourceQuantityReviewId),
  foreignKey({ columns: [table.tenantId, table.reviewId, table.productionOrderId, table.productionVersionId], foreignColumns: [qualityScrapReviews.tenantId, qualityScrapReviews.id, qualityScrapReviews.productionOrderId, qualityScrapReviews.productionVersionId] }),
  foreignKey({ columns: [table.tenantId, table.qualityGroupId, table.productionOrderId, table.productionVersionId], foreignColumns: [qualityInspectionGroups.tenantId, qualityInspectionGroups.id, qualityInspectionGroups.productionOrderId, qualityInspectionGroups.productionVersionId] }),
  foreignKey({ columns: [table.tenantId, table.sourceQuantityReviewId, table.productionOrderId, table.productionVersionId], foreignColumns: [productionQuantityReviews.tenantId, productionQuantityReviews.id, productionQuantityReviews.productionOrderId, productionQuantityReviews.productionVersionId] }),
  check("quality_scrap_allocations_quantity", sql`${table.quantity} between 1 and 100000`),
]);
