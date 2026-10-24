import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts/tenant/tenant-context";
import type { ProductionCommandKind, ProductionCommandView } from "@yummyai/contracts/order/production-command";
import { organizations, users } from "./identity.js";
import { orders } from "./order.js";

export const productionCommandIntents = pgTable("production_command_intents", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  createdBy: uuid("created_by").notNull().references(() => users.id), orderId: uuid("order_id").notNull(),
  kind: text("kind").$type<ProductionCommandKind>().notNull(), targetId: uuid("target_id").notNull(),
  lineIds: jsonb("line_ids").$type<string[]>().notNull(), requestKey: text("request_key").notNull(),
  requestChecksum: text("request_checksum").notNull(), ownerChecksum: text("owner_checksum").notNull(),
  authoritySnapshot: jsonb("authority_snapshot").$type<TenantContext>().notNull(),
  admissionKind: text("admission_kind").$type<"new_request" | "existing_receipt">().notNull().default("new_request"),
  encryptedInput: text("encrypted_input"), contractVersion: text("contract_version").notNull().default("production-command-v1"),
  status: text("status").$type<ProductionCommandView["status"]>().notNull().default("prepared"),
  generation: integer("generation").notNull().default(0), leaseToken: uuid("lease_token"),
  leaseExpiresAt: timestamp("lease_expires_at", { mode: "date", withTimezone: true }),
  resultIds: jsonb("result_ids").$type<string[]>(),
  errorCode: text("error_code").$type<ProductionCommandView["errorCode"]>(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { mode: "date", withTimezone: true }),
  redactedAt: timestamp("redacted_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
}, table => [
  uniqueIndex("production_command_intents_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("production_command_intents_actor_key_unique").on(table.tenantId, table.createdBy, table.kind, table.targetId, table.requestKey),
  index("production_command_intents_business_key_idx").on(table.tenantId, table.kind, table.targetId, table.requestKey),
  index("production_command_intents_source_idx").on(table.tenantId, table.orderId),
  index("production_command_intents_owner_open_idx").on(table.tenantId, table.createdBy, table.orderId, table.acknowledgedAt, table.createdAt),
  foreignKey({ columns: [table.tenantId, table.orderId], foreignColumns: [orders.tenantId, orders.id], name: "production_command_intents_order_fk" }),
  check("production_command_intents_kind_check", sql`${table.kind} in ('approved_design','reviewed_line','reviewed_order')`),
  check("production_command_intents_admission_check", sql`${table.admissionKind} in ('new_request','existing_receipt')`),
  check("production_command_intents_status_check", sql`${table.status} in ('prepared','executing','succeeded','rejected','uncertain','cancelled','expired')`),
  check("production_command_intents_checksum_check", sql`${table.requestChecksum}~'^[a-f0-9]{64}$' and ${table.ownerChecksum}~'^[a-f0-9]{64}$'`),
  check("production_command_intents_identity_check", sql`substring(${table.id}::text from 15 for 1)='7' and length(${table.requestKey}) between 8 and 200 and ${table.generation}>=0`),
  check("production_command_intents_lease_check", sql`(${table.leaseToken} is null)=(${table.leaseExpiresAt} is null)`),
  check("production_command_intents_lines_check", sql`jsonb_typeof(${table.lineIds})='array' and jsonb_array_length(${table.lineIds}) between 1 and 100`),
  check("production_command_intents_expiry_check", sql`${table.expiresAt}>${table.createdAt}`),
]);

export const productionCommandAttempts = pgTable("production_command_attempts", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull(), intentId: uuid("intent_id").notNull(),
  generation: integer("generation").notNull(), leaseToken: uuid("lease_token").notNull(),
  status: text("status").$type<"executing" | "succeeded" | "rejected" | "uncertain" | "superseded">().notNull().default("executing"),
  resultIds: jsonb("result_ids").$type<string[]>(), errorCode: text("error_code"),
  startedAt: timestamp("started_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { mode: "date", withTimezone: true }),
}, table => [
  foreignKey({ columns: [table.tenantId, table.intentId], foreignColumns: [productionCommandIntents.tenantId, productionCommandIntents.id], name: "production_command_attempts_intent_fk" }),
  uniqueIndex("production_command_attempts_generation_unique").on(table.tenantId, table.intentId, table.generation),
  check("production_command_attempts_identity_check", sql`substring(${table.id}::text from 15 for 1)='7' and ${table.generation}>0`),
  check("production_command_attempts_status_check", sql`${table.status} in ('executing','succeeded','rejected','uncertain','superseded')`),
  check("production_command_attempts_finished_check", sql`(${table.status}='executing')=(${table.finishedAt} is null)`),
]);
