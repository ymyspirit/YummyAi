import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts/tenant/tenant-context";
import { organizations, users } from "./identity.js";
import { agentCommandRequests } from "./agent-command.js";

/** Original coordination IDs and exact field checksums only. Owners retain all business bodies and facts. */
export const agentDependencyPlans = pgTable("agent_dependency_plans", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  ownerId: uuid("owner_id").notNull().references(() => users.id), requestId: uuid("request_id").notNull(),
  version: text("version").notNull().default("erp-agent-dependency-plan-v1"),
  kind: text("kind").notNull().default("procurement_invoice_to_finance_bill"), requestChecksum: text("request_checksum").notNull(),
  originCeiling: jsonb("origin_ceiling").$type<TenantContext>().notNull(), parentAgentCommandId: uuid("parent_agent_command_id").notNull(),
  childRequestId: uuid("child_request_id").notNull(), childNativeKey: uuid("child_native_key").notNull(),
  dueAt: timestamp("due_at", { withTimezone: true, mode: "date" }),
  sourceInvoiceId: uuid("source_invoice_id"), sourceChecksum: text("source_checksum"), childOriginalChecksum: text("child_original_checksum"),
  childPreparationRequestChecksum: text("child_preparation_request_checksum"), preparationRequestedAt: timestamp("preparation_requested_at", { withTimezone: true, mode: "date" }),
  childAgentCommandId: uuid("child_agent_command_id"), childOwnerCommandId: uuid("child_owner_command_id"),
  creationTransactionId: text("creation_transaction_id"), preparationTransactionId: text("preparation_transaction_id"), linkTransactionId: text("link_transaction_id"), cancellationTransactionId: text("cancellation_transaction_id"),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
}, table => [
  uniqueIndex("agent_dependency_plans_tenant_id_unique").on(table.tenantId, table.id),
  uniqueIndex("agent_dependency_plans_request_unique").on(table.tenantId, table.ownerId, table.requestId),
  uniqueIndex("agent_dependency_plans_child_request_unique").on(table.tenantId, table.ownerId, table.childRequestId),
  uniqueIndex("agent_dependency_plans_child_key_unique").on(table.tenantId, table.childNativeKey),
  index("agent_dependency_plans_owner_idx").on(table.tenantId, table.ownerId, table.id),
  foreignKey({ columns: [table.tenantId, table.parentAgentCommandId], foreignColumns: [agentCommandRequests.tenantId, agentCommandRequests.id], name: "agent_dependency_parent_fk" }),
  foreignKey({ columns: [table.tenantId, table.childAgentCommandId], foreignColumns: [agentCommandRequests.tenantId, agentCommandRequests.id], name: "agent_dependency_child_fk" }),
  check("agent_dependency_plans_version_check", sql`${table.version}='erp-agent-dependency-plan-v1' and ${table.kind}='procurement_invoice_to_finance_bill'`),
  check("agent_dependency_plans_hash_check", sql`${table.requestChecksum}~'^[a-f0-9]{64}$' and (${table.sourceChecksum} is null or ${table.sourceChecksum}~'^[a-f0-9]{64}$') and (${table.childOriginalChecksum} is null or ${table.childOriginalChecksum}~'^[a-f0-9]{64}$') and (${table.childPreparationRequestChecksum} is null or ${table.childPreparationRequestChecksum}~'^[a-f0-9]{64}$')`),
  check("agent_dependency_plans_preparation_check", sql`(${table.preparationRequestedAt} is null and ${table.sourceInvoiceId} is null and ${table.sourceChecksum} is null and ${table.childOriginalChecksum} is null and ${table.childPreparationRequestChecksum} is null and ${table.preparationTransactionId} is null) or (${table.preparationRequestedAt} is not null and ${table.sourceInvoiceId} is not null and ${table.sourceChecksum} is not null and ${table.childOriginalChecksum} is not null and ${table.childPreparationRequestChecksum} is not null and ${table.preparationTransactionId} is not null)`),
  check("agent_dependency_plans_link_check", sql`(${table.childAgentCommandId} is null or ${table.preparationRequestedAt} is not null) and (${table.childOwnerCommandId} is null or ${table.childAgentCommandId} is not null)`),
  check("agent_dependency_plans_time_check", sql`${table.expiresAt}>${table.createdAt} and ${table.updatedAt}>=${table.createdAt} and (${table.dueAt} is null or isfinite(${table.dueAt}) and ${table.dueAt}>='0001-01-01T00:00:00Z' and ${table.dueAt}<'10000-01-01T00:00:00Z' and date_trunc('milliseconds',${table.dueAt})=${table.dueAt})`),
]);
