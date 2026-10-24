import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { productPlans } from "./catalog.js";
import { organizations } from "./identity.js";

// Immutable owner receipts pin new profile mutations and package exports. Existing
// live profiles are not backfilled with invented historical versions.
export const catalogOperationReceipts = pgTable(
  "catalog_operation_receipts",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    productPlanId: uuid("product_plan_id").notNull(),
    operation: text("operation").$type<"profile" | "package">().notNull(),
    inputChecksum: text("input_checksum").notNull(),
    outputChecksum: text("output_checksum").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check(
      "catalog_operation_receipts_id_check",
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      "catalog_operation_receipts_operation_check",
      sql`${table.operation} in ('profile','package')`,
    ),
    check(
      "catalog_operation_receipts_checksums_check",
      sql`${table.inputChecksum} ~ '^[a-f0-9]{64}$' and ${table.outputChecksum} ~ '^[a-f0-9]{64}$'`,
    ),
    foreignKey({
      columns: [table.tenantId, table.productPlanId],
      foreignColumns: [productPlans.tenantId, productPlans.id],
      name: "catalog_operation_receipts_plan_fk",
    }).onDelete("cascade"),
    uniqueIndex("catalog_operation_receipts_tenant_id_unique").on(table.tenantId, table.id),
    index("catalog_operation_receipts_plan_idx").on(
      table.tenantId,
      table.productPlanId,
      table.createdAt,
    ),
  ],
);
