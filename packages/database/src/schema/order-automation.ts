import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";

export const fulfillmentAutomationPolicies = pgTable("fulfillment_automation_policies", {
  tenantId: uuid("tenant_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  hourlyQuota: integer("hourly_quota").default(20).notNull(),
  maxAttempts: integer("max_attempts").default(3).notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("fulfillment_automation_policies_quota_check", sql`${table.hourlyQuota} between 1 and 1000`),
  check("fulfillment_automation_policies_attempts_check", sql`${table.maxAttempts} between 1 and 5`),
]);

export const fulfillmentAutomationTasks = pgTable("fulfillment_automation_tasks", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  status: text("status").default("scheduled").notNull(),
  runAt: timestamp("run_at", { mode: "date", withTimezone: true }).notNull(),
  attemptCount: integer("attempt_count").default(0).notNull(),
  maxAttempts: integer("max_attempts").notNull(),
  projectionVersion: integer("projection_version").default(1).notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestedBy: uuid("requested_by").notNull().references(() => users.id, { onDelete: "restrict" }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("fulfillment_automation_tasks_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("fulfillment_automation_tasks_type_check", sql`${table.type} in ('attention_scan','shipment_reconciliation_scan','pii_retention_scan')`),
  check("fulfillment_automation_tasks_status_check", sql`${table.status} in ('scheduled','running','completed','failed','cancelled','dead_letter','reconciliation_required')`),
  check("fulfillment_automation_tasks_attempts_check", sql`${table.attemptCount} >= 0 and ${table.maxAttempts} between 1 and 5 and ${table.attemptCount} <= ${table.maxAttempts}`),
  check("fulfillment_automation_tasks_version_check", sql`${table.projectionVersion} > 0`),
  uniqueIndex("fulfillment_automation_tasks_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("fulfillment_automation_tasks_idempotency_unique").on(table.tenantId, table.idempotencyKey),
  index("fulfillment_automation_tasks_queue_idx").on(table.tenantId, table.status, table.runAt),
  index("fulfillment_automation_tasks_quota_idx").on(table.tenantId, table.createdAt),
]);

export const fulfillmentAutomationEvents = pgTable("fulfillment_automation_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  taskId: uuid("task_id").notNull(),
  sequence: integer("sequence").notNull(),
  action: text("action").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status").notNull(),
  code: text("code"),
  summary: text("summary"),
  encryptedDetail: text("encrypted_detail"),
  detailChecksum: text("detail_checksum"),
  idempotencyKey: text("idempotency_key").notNull(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("fulfillment_automation_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("fulfillment_automation_events_sequence_check", sql`${table.sequence} > 0`),
  check("fulfillment_automation_events_action_check", sql`${table.action} in ('scheduled','claimed','completed','retry_scheduled','failed','dead_letter','cancelled','reconciliation_required','reconciled')`),
  check("fulfillment_automation_events_detail_check", sql`(${table.encryptedDetail} is null and ${table.detailChecksum} is null) or (${table.encryptedDetail} is not null and ${table.detailChecksum} ~ '^[0-9a-f]{64}$')`),
  foreignKey({ columns: [table.tenantId, table.taskId], foreignColumns: [fulfillmentAutomationTasks.tenantId, fulfillmentAutomationTasks.id], name: "fulfillment_automation_events_task_fk" }).onDelete("restrict"),
  uniqueIndex("fulfillment_automation_events_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("fulfillment_automation_events_sequence_unique").on(table.tenantId, table.taskId, table.sequence),
  uniqueIndex("fulfillment_automation_events_idempotency_unique").on(table.tenantId, table.taskId, table.idempotencyKey),
]);
