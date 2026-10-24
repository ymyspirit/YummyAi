import type { SalesPlanFields } from "@yummyai/contracts/catalog/sales-plan";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { spus } from "./catalog.js";

export const salesPlans = pgTable(
  "sales_plans",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    spuId: uuid("spu_id").notNull(),
    revision: integer("revision").notNull().default(1),
    fields: jsonb("fields").$type<SalesPlanFields>().notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
  },
  (t) => [
    uniqueIndex("sales_plans_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("sales_plans_spu_id_unique").on(t.tenantId, t.spuId, t.id),
    foreignKey({ columns: [t.tenantId, t.spuId], foreignColumns: [spus.tenantId, spus.id] }),
    index("sales_plans_spu_idx").on(t.tenantId, t.spuId, t.updatedAt),
    check(
      "sales_plans_mode_check",
      sql`${t.fields}->>'mode' in ('custom','standard') and ${t.fields}->>'fulfillment' in ('fbm','fba') and not (${t.fields}->>'mode' = 'custom' and ${t.fields}->>'fulfillment' = 'fba')`,
    ),
    check("sales_plans_revision_check", sql`${t.revision} > 0`),
  ],
);
