import type { AdCommandKind, AdCommandSummary } from "@yummyai/contracts/advertising/command";
import type { TenantContext } from "@yummyai/contracts/tenant/tenant-context";
import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organizations, users } from "./identity.js";
import { marketplaceAccounts } from "./marketplace.js";
import { auditEvents } from "./audit.js";

/** Future actual owner inserts only. No legacy fact is promoted into a command result. */
export const advertisingOriginalWriteProofs = pgTable("advertising_original_write_proofs", {
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  accountId: uuid("account_id").notNull(), kind: text("kind").$type<AdCommandKind>().notNull(),
  resultId: uuid("result_id").notNull(), commandId: uuid("command_id"), requestKey: text("request_key").notNull(),
  actorId: uuid("actor_id").notNull().references(() => users.id), targetId: uuid("target_id"), scopeKey: text("scope_key").notNull(),
  // Import children are inserted after their batch; the final binding is checked
  // from actual columns by the deferred outcome guard, not a caller's marker.
  ownerInputChecksum: text("owner_input_checksum"), creationTransactionId: text("creation_transaction_id").notNull(),
  parentId: uuid("parent_id"), version: integer("version"),
}, table => [
  primaryKey({ columns: [table.tenantId, table.kind, table.resultId] }),
  uniqueIndex("advertising_original_proof_command").on(table.tenantId, table.commandId).where(sql`${table.commandId} is not null`),
  uniqueIndex("advertising_original_proof_key").on(table.tenantId, table.accountId, table.kind,
    sql`case when ${table.kind} in ('action_transition','import_archive') then ${table.targetId}::text else 'root' end`, table.requestKey),
  foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id], name: "advertising_original_proof_account_fk" }),
]);

/** Database-minted mutable-parent transitions, never an application-owned fact. */
export const advertisingOwnerMutationEvidence = pgTable("advertising_owner_mutation_evidence", {
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id), accountId: uuid("account_id").notNull(),
  kind: text("kind").$type<"action_transition" | "import_archive">().notNull(), parentId: uuid("parent_id").notNull(),
  version: integer("version").notNull(), phase: text("phase").$type<"mutation" | "event">().notNull(), eventId: uuid("event_id"),
  actorId: uuid("actor_id").notNull().references(() => users.id),
  beforeState: jsonb("before_state").$type<Record<string, unknown>>().notNull(),
  afterState: jsonb("after_state").$type<Record<string, unknown>>().notNull(), creationTransactionId: text("creation_transaction_id").notNull(),
}, table => [primaryKey({ columns: [table.tenantId, table.kind, table.parentId, table.version, table.phase] }),
  foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id], name: "advertising_owner_mutation_account_fk" })]);

/** Actual audit INSERT transaction IDs, without copying the audit body. */
export const advertisingCommandAuditReceipts = pgTable("advertising_command_audit_receipts", {
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  auditId: uuid("audit_id").notNull().references(() => auditEvents.id), creationTransactionId: text("creation_transaction_id").notNull(),
}, table => [primaryKey({ columns: [table.tenantId, table.auditId] })]);

export const advertisingCommands = pgTable("advertising_commands", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  accountId: uuid("account_id").notNull(), createdBy: uuid("created_by").notNull().references(() => users.id),
  kind: text("kind").$type<AdCommandKind>().notNull(), targetId: uuid("target_id"), scopeKey: text("scope_key").notNull(),
  requestKey: text("request_key").notNull(), requestChecksum: text("request_checksum").notNull(), ownerInputChecksum: text("owner_input_checksum").notNull(),
  authoritySnapshot: jsonb("authority_snapshot").$type<TenantContext>().notNull(), encryptedInput: text("encrypted_input"),
  contractVersion: text("contract_version").notNull().default("advertising-command-v1"),
  status: text("status").$type<AdCommandSummary["status"]>().notNull().default("prepared"), resultId: uuid("result_id"),
  parentId: uuid("parent_id"), version: integer("version"), errorCode: text("error_code").$type<"input_unavailable">(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true, mode: "date" }),
  redactedAt: timestamp("redacted_at", { withTimezone: true, mode: "date" }),
}, table => [
  uniqueIndex("advertising_commands_scope").on(table.tenantId, table.id),
  uniqueIndex("advertising_commands_key").on(table.tenantId, table.accountId, table.kind,
    sql`case when ${table.kind} in ('action_transition','import_archive') then ${table.targetId}::text else 'root' end`, table.requestKey),
  uniqueIndex("advertising_commands_unacknowledged").on(table.tenantId, table.accountId, table.kind, table.createdBy, table.scopeKey)
    .where(sql`${table.acknowledgedAt} is null`),
  index("advertising_commands_retention").on(table.tenantId, table.expiresAt).where(sql`${table.encryptedInput} is not null`),
  foreignKey({ columns: [table.tenantId, table.accountId], foreignColumns: [marketplaceAccounts.tenantId, marketplaceAccounts.id], name: "advertising_command_account_fk" }),
  foreignKey({ columns: [table.tenantId, table.kind, table.resultId], foreignColumns: [advertisingOriginalWriteProofs.tenantId,
    advertisingOriginalWriteProofs.kind, advertisingOriginalWriteProofs.resultId], name: "advertising_command_actual_result_fk" }),
  check("advertising_commands_result", sql`(${table.status}='succeeded')=(${table.resultId} is not null) and (${table.status}='prepared')=(${table.completedAt} is null)`),
]);
