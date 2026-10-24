import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts/tenant/tenant-context";
import type { MaterialCommandView } from "@yummyai/contracts/order/material-command";
import { organizations, users } from "./identity.js";
import { productionMaterialEntries } from "./production-material.js";
import { productionManufacturingBindings } from "./production-manufacturing.js";

/** Durable original input for one bounded, atomic database operation. No external lease. */
export const productionMaterialCommands = pgTable("production_material_commands", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  productionOrderId: uuid("production_order_id").notNull(), bindingId: uuid("binding_id").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  requestKey: text("request_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  authoritySnapshot: jsonb("authority_snapshot").$type<TenantContext>().notNull(), encryptedInput: text("encrypted_input"),
  contractVersion: text("contract_version").notNull().default("material-command-v1"),
  status: text("status").$type<MaterialCommandView["status"]>().notNull().default("prepared"),
  entryId: uuid("entry_id"), errorCode: text("error_code").$type<MaterialCommandView["errorCode"]>(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { mode: "date", withTimezone: true }),
  redactedAt: timestamp("redacted_at", { mode: "date", withTimezone: true }),
}, t => [
  uniqueIndex("production_material_commands_scope").on(t.tenantId, t.id),
  uniqueIndex("production_material_commands_key").on(t.tenantId, t.productionOrderId, t.requestKey),
  uniqueIndex("production_material_commands_unacknowledged").on(t.tenantId, t.productionOrderId, t.createdBy).where(sql`${t.acknowledgedAt} is null`),
  index("production_material_commands_retention").on(t.tenantId, t.expiresAt).where(sql`${t.encryptedInput} is not null`),
  foreignKey({ columns: [t.tenantId, t.bindingId, t.productionOrderId], foreignColumns: [productionManufacturingBindings.tenantId, productionManufacturingBindings.id, productionManufacturingBindings.productionOrderId] }),
  foreignKey({ columns: [t.tenantId, t.entryId], foreignColumns: [productionMaterialEntries.tenantId, productionMaterialEntries.id] }),
  check("production_material_commands_status", sql`${t.status} in ('prepared','succeeded','rejected','cancelled','expired')`),
  check("production_material_commands_result", sql`(${t.status}='succeeded')=(${t.entryId} is not null)`),
]);
