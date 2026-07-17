import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { organizations, users } from "./identity.js";

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "restrict" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    traceId: text("trace_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default(sql`'{}'::jsonb`).notNull(),
    occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check("audit_events_id_uuidv7_check", sql`substring(${table.id}::text from 15 for 1) = '7'`),
    index("audit_events_tenant_occurred_at_idx").on(table.tenantId, table.occurredAt),
    index("audit_events_actor_user_id_idx").on(table.actorUserId),
    index("audit_events_entity_idx").on(table.tenantId, table.entityType, table.entityId),
  ],
);
