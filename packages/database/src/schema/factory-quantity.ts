import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { FactoryQuantityReportInput } from "@yummyai/contracts/suppliers/factory-quantity";
import { organizations, users } from "./identity.js";
import { factoryTaskAssignments } from "./factory-collaboration.js";
import { productionDeliveryFeedback } from "./order-production-delivery.js";
import { productionQuantityReports } from "./production-quantity.js";
import { fulfillmentFactories } from "./factory-directory.js";

/** Immutable provenance of an original quantity report, never another quantity ledger. */
export const factoryQuantityReportOrigins = pgTable("factory_quantity_report_origins", {
  reportId: uuid("report_id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  assignmentId: uuid("assignment_id").notNull(), acceptedFeedbackId: uuid("accepted_feedback_id").notNull(),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(),
  factoryId: uuid("factory_id").notNull(), factoryName: text("factory_name").notNull(),
  input: jsonb("input").$type<FactoryQuantityReportInput>().notNull(), idempotencyKey: uuid("idempotency_key").notNull(),
  requestCanonical: text("request_canonical").notNull(), requestChecksum: text("request_checksum").notNull(),
  creationTransactionId: text("creation_transaction_id").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("factory_quantity_origins_scope").on(table.tenantId, table.reportId),
  uniqueIndex("factory_quantity_origins_request").on(table.tenantId, table.idempotencyKey),
  index("factory_quantity_origins_history").on(table.tenantId, table.assignmentId, table.createdBy, table.reportId),
  foreignKey({ columns: [table.tenantId, table.reportId, table.productionOrderId, table.productionVersionId],
    foreignColumns: [productionQuantityReports.tenantId, productionQuantityReports.id, productionQuantityReports.productionOrderId, productionQuantityReports.productionVersionId], name: "factory_quantity_origins_report_fk" }),
  foreignKey({ columns: [table.tenantId, table.assignmentId], foreignColumns: [factoryTaskAssignments.tenantId, factoryTaskAssignments.id], name: "factory_quantity_origins_assignment_fk" }),
  foreignKey({ columns: [table.tenantId, table.acceptedFeedbackId], foreignColumns: [productionDeliveryFeedback.tenantId, productionDeliveryFeedback.id], name: "factory_quantity_origins_accepted_fk" }),
  foreignKey({ columns: [table.tenantId, table.factoryId], foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.id], name: "factory_quantity_origins_factory_fk" }),
  check("factory_quantity_origins_hash", sql`${table.requestChecksum}=encode(sha256(convert_to(${table.requestCanonical},'UTF8')),'hex')`),
  check("factory_quantity_origins_name", sql`length(${table.factoryName}) between 1 and 500`),
]);
