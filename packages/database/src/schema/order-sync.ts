import { sql } from "drizzle-orm";
import { pgTable, uuid, integer, text, boolean, jsonb, timestamp, uniqueIndex, foreignKey, index } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts";
import type { OrderSyncRequest } from "@yummyai/contracts/order/sync";
import { organizations, users } from "./identity.js";
import { marketplaceAccounts } from "./marketplace.js";
import { orderIngestionRuns } from "./order.js";
import { marketplaceStoreNodeExecutions } from "./store-node-execution.js";
const instant = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const orderSyncSchedules = pgTable("order_sync_schedules", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), accountId: uuid("account_id").notNull(),
  version: integer("version").notNull(), enabled: boolean("enabled").notNull(), requestedBy: uuid("requested_by").notNull().references(() => users.id),
  authority: jsonb("authority").$type<TenantContext>().notNull(), authorizationGeneration: uuid("authorization_generation").notNull(),
  requestKey: uuid("request_key").notNull(), requestHash: text("request_hash").notNull(),
  request: jsonb("request").$type<OrderSyncRequest>(), cursorHashes: jsonb("cursor_hashes").$type<string[]>().notNull().default([]),
  activeExecutionId: uuid("active_execution_id"), lastRunId: uuid("last_run_id"),
  errorCode: text("error_code"), failureCount: integer("failure_count").notNull().default(0),
  nextRunAt: instant("next_run_at").notNull().defaultNow(), updatedAt: instant("updated_at").notNull().defaultNow(),
}, t => [uniqueIndex("order_sync_schedules_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("order_sync_schedules_account_unique").on(t.tenantId, t.accountId),
  uniqueIndex("order_sync_schedules_request_unique").on(t.tenantId, t.requestKey),
  index("order_sync_schedules_due").on(t.tenantId, t.nextRunAt).where(sql`${t.enabled}=true`),
  foreignKey({ columns: [t.tenantId, t.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id] }),
  foreignKey({ columns: [t.tenantId, t.activeExecutionId], foreignColumns: [marketplaceStoreNodeExecutions.tenantId, marketplaceStoreNodeExecutions.id] }),
  foreignKey({ columns: [t.tenantId, t.lastRunId], foreignColumns: [orderIngestionRuns.tenantId, orderIngestionRuns.id] }),
]);
export const orderSyncDispatchTenants = pgTable("order_sync_dispatch_tenants", {
  tenantId: uuid("tenant_id").primaryKey().references(() => organizations.id),
});
