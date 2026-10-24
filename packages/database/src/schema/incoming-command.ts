import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts/tenant/tenant-context";
import type { IncomingCommandKind, IncomingCommandView } from "@yummyai/contracts/procurement/incoming-command";
import { organizations, users } from "./identity.js";

/** Encrypted originals and minimal fact references. Business facts remain in their owners. */
export const incomingCommands = pgTable("inventory_incoming_commands", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  kind: text("kind").$type<IncomingCommandKind>().notNull(), targetId: uuid("target_id").notNull(), postingId: uuid("posting_id"),
  requestKey: text("request_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  authoritySnapshot: jsonb("authority_snapshot").$type<TenantContext>().notNull(), encryptedInput: text("encrypted_input"),
  contractVersion: text("contract_version").notNull().default("incoming-command-v1"),
  status: text("status").$type<IncomingCommandView["status"]>().notNull().default("prepared"),
  resultId: uuid("result_id"), errorCode: text("error_code").$type<"input_unavailable">(),
  createdAt: timestamp("created_at", { mode: "date", withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { mode: "date", withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { mode: "date", withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { mode: "date", withTimezone: true }),
  redactedAt: timestamp("redacted_at", { mode: "date", withTimezone: true }),
}, t => [
  uniqueIndex("incoming_commands_scope").on(t.tenantId, t.id),
  uniqueIndex("incoming_commands_key").on(t.tenantId, t.kind, t.requestKey),
  uniqueIndex("incoming_commands_unacknowledged").on(t.tenantId, t.kind, t.targetId, t.createdBy).where(sql`${t.acknowledgedAt} is null`),
  index("incoming_commands_retention").on(t.tenantId, t.expiresAt).where(sql`${t.encryptedInput} is not null`),
  check("incoming_commands_status", sql`${t.status} in ('prepared','succeeded','rejected','cancelled','expired')`),
  check("incoming_commands_result", sql`(${t.status}='succeeded')=(${t.resultId} is not null) and (${t.status}='prepared')=(${t.completedAt} is null)`),
]);
