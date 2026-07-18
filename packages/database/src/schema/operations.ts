import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";

export const jobProgressEvents = pgTable("job_progress_events", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull(),
  requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
  state: text("state").notNull(),
  progress: integer("progress").notNull(),
  message: text("message"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("job_progress_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("job_progress_events_job_uuidv7_check", sql`substring(${table.jobId}::text from 15 for 1) = '7'`),
  check("job_progress_events_state_check", sql`${table.state} in ('queued','running','completed','failed','cancelled')`),
  check("job_progress_events_progress_check", sql`${table.progress} between 0 and 100`),
  uniqueIndex("job_progress_events_tenant_id_unique").on(table.tenantId, table.id),
  index("job_progress_events_job_idx").on(table.tenantId, table.jobId, table.occurredAt),
  index("job_progress_events_resume_idx").on(table.tenantId, table.occurredAt, table.id),
]);

export const notifications = pgTable("notifications", {
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  resourceType: text("resource_type"),
  resourceId: uuid("resource_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
  readAt: timestamp("read_at", { mode: "date", withTimezone: true }),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  check("notifications_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
  check("notifications_kind_check", sql`${table.kind} in ('job_completed','job_failed','review_requested','review_decided','design_overdue','system')`),
  uniqueIndex("notifications_tenant_id_unique").on(table.tenantId, table.id),
  index("notifications_inbox_idx").on(table.tenantId, table.userId, table.readAt, table.createdAt),
]);
