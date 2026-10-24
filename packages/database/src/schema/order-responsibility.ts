import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { orderWorkItems } from "./order-workspace.js";

/** Operational follow-up arrangement only. Business completion stays in its owners. */
export const orderLineResponsibilities = pgTable(
  "order_line_responsibilities",
  {
    workItemId: uuid("work_item_id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id),
    assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "set null" }),
    internalDueAt: timestamp("internal_due_at", { mode: "date", withTimezone: true }),
    escalationUserId: uuid("escalation_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    escalationDelayMinutes: integer("escalation_delay_minutes"),
    revision: integer("revision").notNull(),
    reasonCode: text("reason_code").notNull(),
    updatedBy: uuid("updated_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
    attentionCycle: integer("attention_cycle").notNull().default(1),
    observedSourceChecksum: text("observed_source_checksum").notNull(),
    attentionNextAt: timestamp("attention_next_at", { mode: "date", withTimezone: true }),
    attentionLastError: text("attention_last_error"),
    assignmentNotifiedAt: timestamp("assignment_notified_at", { mode: "date", withTimezone: true }),
    dueNotifiedAt: timestamp("due_notified_at", { mode: "date", withTimezone: true }),
    escalationNotifiedAt: timestamp("escalation_notified_at", { mode: "date", withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.workItemId],
      foreignColumns: [orderWorkItems.tenantId, orderWorkItems.id],
      name: "order_line_responsibilities_work_fk",
    }).onDelete("cascade"),
    index("order_line_responsibilities_attention_idx").on(table.tenantId, table.attentionNextAt),
    index("order_line_responsibilities_assignee_due_idx").on(
      table.tenantId,
      table.assignedUserId,
      table.internalDueAt,
      table.workItemId,
    ),
    check("order_line_responsibilities_revision_check", sql`${table.revision}>0`),
    check(
      "order_line_responsibilities_observed_source_checksum_check",
      sql`${table.observedSourceChecksum} ~ '^[a-f0-9]{64}$'`,
    ),
    check("order_line_responsibilities_attention_cycle_check", sql`${table.attentionCycle}>0`),
    check(
      "order_line_responsibilities_reason_code_check",
      sql`${table.reasonCode} in ('initial_assignment','handoff','deadline_update','correction')`,
    ),
    check(
      "order_line_responsibilities_attention_last_error_check",
      sql`${table.attentionLastError} is null or ${table.attentionLastError} in ('RECIPIENT_UNAVAILABLE','ESCALATION_UNAVAILABLE','SOURCE_UNAVAILABLE','DISPATCH_FAILED')`,
    ),
    check(
      "order_line_responsibilities_escalation_check",
      sql`(${table.escalationUserId} is null and ${table.escalationDelayMinutes} is null) or (${table.escalationUserId} is not null and ${table.assignedUserId} is not null and ${table.internalDueAt} is not null and ${table.escalationUserId}<>${table.assignedUserId} and ${table.escalationDelayMinutes} between 1 and 10080)`,
    ),
  ],
);
