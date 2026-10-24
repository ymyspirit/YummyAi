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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { memberships, organizations, users } from "./identity.js";
import { inventoryPurchaseOrders } from "./inventory-procurement.js";
import { afterSalesCases } from "./order-after-sales.js";
import { orderExceptions } from "./order.js";

/** Strong domain foreign keys; arrangements never store business completion. */
function arrangement<Name extends string>(name: Name, parent: [AnyPgColumn, AnyPgColumn]) {
  return pgTable(
    name,
    {
      objectId: uuid("object_id").primaryKey(),
      tenantId: uuid("tenant_id")
        .notNull()
        .references(() => organizations.id),
      assignedUserId: uuid("assigned_user_id").references(() => users.id, { onDelete: "restrict" }),
      internalDueAt: timestamp("internal_due_at", { mode: "date", withTimezone: true }),
      escalationUserId: uuid("escalation_user_id").references(() => users.id, {
        onDelete: "restrict",
      }),
      escalationDelayMinutes: integer("escalation_delay_minutes"),
      revision: integer("revision").notNull(),
      reasonCode: text("reason_code").notNull(),
      updatedBy: uuid("updated_by")
        .notNull()
        .references(() => users.id),
      updatedAt: timestamp("updated_at", { mode: "date", withTimezone: true })
        .notNull()
        .defaultNow(),
      attentionCycle: integer("attention_cycle").notNull().default(1),
      observedSourceChecksum: text("observed_source_checksum").notNull(),
      attentionNextAt: timestamp("attention_next_at", { mode: "date", withTimezone: true }),
      attentionLastError: text("attention_last_error"),
      assignmentNotifiedAt: timestamp("assignment_notified_at", {
        mode: "date",
        withTimezone: true,
      }),
      dueNotifiedAt: timestamp("due_notified_at", { mode: "date", withTimezone: true }),
      escalationNotifiedAt: timestamp("escalation_notified_at", {
        mode: "date",
        withTimezone: true,
      }),
    },
    (t) => [
      foreignKey({
        columns: [t.tenantId, t.objectId],
        foreignColumns: parent,
        name: name + "_source_fk",
      }).onDelete("restrict"),
      ...[t.assignedUserId, t.escalationUserId, t.updatedBy].map((column, index) =>
        foreignKey({
          columns: [t.tenantId, column],
          foreignColumns: [memberships.tenantId, memberships.userId],
          name: name + "_member_" + index + "_fk",
        }).onDelete("restrict"),
      ),
      index(name + "_attention_idx").on(t.tenantId, t.attentionNextAt),
      index(name + "_assignee_due_idx").on(
        t.tenantId,
        t.assignedUserId,
        t.internalDueAt,
        t.objectId,
      ),
      check(name + "_revision_check", sql`${t.revision}>0`),
      check(name + "_cycle_check", sql`${t.attentionCycle}>0`),
      check(name + "_checksum_check", sql`${t.observedSourceChecksum} ~ '^[a-f0-9]{64}$'`),
      check(
        name + "_reason_check",
        sql`${t.reasonCode} in ('initial_assignment','handoff','deadline_update','correction')`,
      ),
      check(
        name + "_error_check",
        sql`${t.attentionLastError} is null or ${t.attentionLastError} in ('RECIPIENT_UNAVAILABLE','ESCALATION_UNAVAILABLE','SOURCE_UNAVAILABLE','DISPATCH_FAILED')`,
      ),
      check(
        name + "_escalation_check",
        sql`(${t.escalationUserId} is null and ${t.escalationDelayMinutes} is null) or (${t.escalationUserId} is not null and ${t.assignedUserId} is not null and ${t.internalDueAt} is not null and ${t.escalationUserId}<>${t.assignedUserId} and ${t.escalationDelayMinutes} between 1 and 10080)`,
      ),
    ],
  );
}
export const procurementOrderFollowups = arrangement("procurement_order_followups", [
  inventoryPurchaseOrders.tenantId,
  inventoryPurchaseOrders.id,
]);
export const afterSalesCaseFollowups = arrangement("after_sales_case_followups", [
  afterSalesCases.tenantId,
  afterSalesCases.id,
]);
export const orderExceptionFollowups = arrangement("order_exception_followups", [
  orderExceptions.tenantId,
  orderExceptions.id,
]);
