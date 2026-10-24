import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts/tenant/tenant-context";
import type { FulfillmentCommandKind, FulfillmentCommandView } from "@yummyai/contracts/order/fulfillment-command";
import { organizations, users } from "./identity.js";
import { orders } from "./order.js";

/** Execution identity only. Business success is always rebuilt from owner rows. */
export const orderFulfillmentCommandIntents = pgTable("order_fulfillment_command_intents", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  createdBy: uuid("created_by").notNull().references(() => users.id), requestId: uuid("request_id").notNull(),
  contractVersion: text("contract_version").notNull().default("fulfillment-command-v1"),
  orderId: uuid("order_id").notNull(), lineIds: jsonb("line_ids").$type<string[]>().notNull(),
  kind: text("kind").$type<FulfillmentCommandKind>().notNull(), targetId: uuid("target_id").notNull(),
  requestKey: text("request_key").notNull(), requestChecksum: text("request_checksum").notNull(), ownerChecksum: text("owner_checksum").notNull(),
  authoritySnapshot: jsonb("authority_snapshot").$type<TenantContext>().notNull(), encryptedInput: text("encrypted_input"),
  status: text("status").$type<"prepared" | "executing" | "uncertain" | "rejected" | "cancelled" | "expired">().notNull().default("prepared"),
  generation: integer("generation").notNull().default(0), leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { mode: "date", withTimezone: true }),
  errorCode: text("error_code").$type<FulfillmentCommandView["errorCode"]>(),
  acknowledgedAt: timestamp("acknowledged_at", { mode: "date", withTimezone: true }),
  redactedAt: timestamp("redacted_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
}, table => [
  uniqueIndex("order_fulfillment_command_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("order_fulfillment_command_request_unique").on(table.tenantId, table.createdBy, table.requestId),
  uniqueIndex("order_fulfillment_command_owner_key_unique").on(table.tenantId, table.kind, table.targetId, table.requestKey),
  index("order_fulfillment_command_open_idx").on(table.tenantId, table.createdBy, table.orderId, table.acknowledgedAt, table.createdAt),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "order_fulfillment_command_order_fk" }),
  check("order_fulfillment_command_kind_check", sql`${table.kind} in ('delivery_create','delivery_feedback','production_milestone','quality_inspection','quality_group_inspection','production_recovery','whole_production_milestone','whole_quality_inspection','shipment_create','whole_shipment_create','shipment_version','shipment_review','shipment_dispatch','shipment_platform_confirmation')`),
  check("order_fulfillment_command_status_check", sql`${table.status} in ('prepared','executing','uncertain','rejected','cancelled','expired')`),
  check("order_fulfillment_command_hash_check", sql`${table.requestChecksum}~'^[a-f0-9]{64}$' and ${table.ownerChecksum}~'^[a-f0-9]{64}$'`),
  check("order_fulfillment_command_identity_check", sql`substring(${table.id}::text from 15 for 1)='7' and length(${table.requestKey}) between 1 and 300 and ${table.generation}>=0`),
  check("order_fulfillment_command_lease_check", sql`(${table.leaseToken} is null)=(${table.leaseExpiresAt} is null)`),
  check("order_fulfillment_command_lines_check", sql`jsonb_typeof(${table.lineIds})='array' and jsonb_array_length(${table.lineIds}) between 1 and 100`),
  check("order_fulfillment_command_expiry_check", sql`${table.expiresAt}>${table.createdAt} and ${table.expiresAt}<=${table.createdAt}+interval '7 days'`),
]);
