import { sql } from "drizzle-orm";
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts";
import type { AgentCommandBinding } from "@yummyai/contracts/ai/agent-command";
import { organizations, users } from "./identity.js";

/** Coordination only. The native owners retain every private original and business fact. */
export const agentCommandRequests = pgTable("agent_command_requests", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  ownerId: uuid("owner_id").notNull().references(() => users.id), requestId: uuid("request_id").notNull(),
  version: text("version").notNull().default("erp-agent-command-v1"),
  requestChecksum: text("request_checksum").notNull(), operation: text("operation").$type<"prepare" | "adopt">().notNull(),
  originalChecksum: text("original_checksum").notNull(), binding: jsonb("binding").$type<AgentCommandBinding>().notNull(),
  originCeiling: jsonb("origin_ceiling").$type<TenantContext>().notNull(), ownerCommandId: uuid("owner_command_id"),
  confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: "date" }), confirmationChecksum: text("confirmation_checksum"),
  creationTransactionId: text("creation_transaction_id"), confirmationTransactionId: text("confirmation_transaction_id"),
  linkTransactionId: text("link_transaction_id"), cancellationTransactionId: text("cancellation_transaction_id"),
  acknowledgementTransactionId: text("acknowledgement_transaction_id"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
}, table => [
  uniqueIndex("agent_command_requests_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("agent_command_requests_request_unique").on(table.tenantId, table.ownerId, table.requestId),
  index("agent_command_requests_owner_idx").on(table.tenantId, table.ownerId, table.id),
  check("agent_command_requests_version_check", sql`${table.version}='erp-agent-command-v1'`),
  check("agent_command_requests_operation_check", sql`${table.operation} in ('prepare','adopt')`),
  check("agent_command_requests_hash_check", sql`${table.requestChecksum}~'^[a-f0-9]{64}$' and ${table.originalChecksum}~'^[a-f0-9]{64}$'`),
  check("agent_command_requests_binding_check", sql`agent_command_binding_valid(${table.binding}) is true`),
  check("agent_command_requests_confirmation_check", sql`(${table.confirmedAt} is null and ${table.confirmationChecksum} is null and ${table.confirmationTransactionId} is null) or (${table.confirmedAt} is not null and ${table.confirmationChecksum}~'^[a-f0-9]{64}$' and ${table.confirmationTransactionId} is not null and ${table.ownerCommandId} is not null)`),
  check("agent_command_requests_time_check", sql`${table.expiresAt}>${table.createdAt} and ${table.updatedAt}>=${table.createdAt}`),
]);
