import { sql } from "drizzle-orm";
import { bigint, check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { ShiposOrderEvidence, ShiposCarrierMapping } from "@yummyai/contracts/suppliers/shipos";
import { organizations, users } from "./identity.js";
import { fulfillmentSuppliers } from "./order-routing.js";
import { orders, orderLines } from "./order.js";

export const shiposConnections = pgTable("shipos_connections", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), supplierId: uuid("supplier_id").notNull(),
  name: text("name").notNull(), status: text("status").notNull(), version: integer("version").notNull(), encryptedCredentials: text("encrypted_credentials"), appKeyHint: text("app_key_hint"),
  syncSequence: bigint("sync_sequence", { mode: "bigint" }).default(0n).notNull(),
  channelMappings: jsonb("channel_mappings").$type<ShiposCarrierMapping[]>().default([]).notNull(),
  lastRequestKey: uuid("last_request_key").notNull(), lastRequestChecksum: text("last_request_checksum").notNull(),
  lastTestAt: timestamp("last_test_at", { withTimezone: true }), lastTestResult: text("last_test_result"),
  createdBy: uuid("created_by").notNull().references(() => users.id), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("shipos_connections_tenant_id_unique").on(t.tenantId, t.id), uniqueIndex("shipos_connections_supplier_unique").on(t.tenantId, t.supplierId),
  check("shipos_connections_sequence_check", sql`${t.syncSequence} >= 0`),
  foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "shipos_connections_supplier_fk" }),
]);
export const shiposSyncRuns = pgTable("shipos_sync_runs", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), connectionId: uuid("connection_id").notNull(), connectionVersion: integer("connection_version").notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(), orderNumbers: jsonb("order_numbers").$type<string[]>().notNull(),
  syncSequence: bigint("sync_sequence", { mode: "bigint" }),
  status: text("status").notNull(), diagnostic: text("diagnostic"), createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), completedAt: timestamp("completed_at", { withTimezone: true }),
}, t => [
  uniqueIndex("shipos_sync_runs_tenant_id_unique").on(t.tenantId, t.id), uniqueIndex("shipos_sync_runs_request_unique").on(t.tenantId, t.idempotencyKey),
  uniqueIndex("shipos_sync_runs_sequence_unique").on(t.tenantId, t.connectionId, t.syncSequence),
  check("shipos_sync_runs_sequence_check", sql`${t.syncSequence} IS NULL OR ${t.syncSequence} > 0`),
  foreignKey({ columns: [t.tenantId, t.connectionId], foreignColumns: [shiposConnections.tenantId, shiposConnections.id], name: "shipos_sync_runs_connection_fk" }),
  index("shipos_sync_runs_connection_idx").on(t.tenantId, t.connectionId, t.createdAt),
]);
export const shiposOrderSnapshots = pgTable("shipos_order_snapshots", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), runId: uuid("run_id").notNull(),
  evidence: jsonb("evidence").$type<ShiposOrderEvidence>().notNull(), localOrderId: uuid("local_order_id"), localLineId: uuid("local_line_id"), match: text("match").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("shipos_order_snapshots_tenant_id_unique").on(t.tenantId, t.id),
  index("shipos_snapshots_order_run_idx").on(t.tenantId, t.localOrderId, t.runId),
  foreignKey({ columns: [t.tenantId, t.runId], foreignColumns: [shiposSyncRuns.tenantId, shiposSyncRuns.id], name: "shipos_order_snapshots_run_fk" }),
  foreignKey({ columns: [t.tenantId, t.localOrderId], foreignColumns: [orders.tenantId, orders.id], name: "shipos_order_snapshots_order_fk" }),
  foreignKey({ columns: [t.tenantId, t.localOrderId, t.localLineId], foreignColumns: [orderLines.tenantId, orderLines.orderId, orderLines.id], name: "shipos_order_snapshots_line_fk" }),
]);
