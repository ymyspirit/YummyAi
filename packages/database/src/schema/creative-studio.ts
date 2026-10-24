import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { StudioGenerate } from "@yummyai/contracts/pod/creative-studio";
import type { StudioTransferReceipt, StudioTransferRequest } from "@yummyai/contracts/pod/studio-document-transfer";
import { organizations, users } from "./identity.js";
import { assetFiles } from "./assets.js";

export const creativeStudioTransfers = pgTable("creative_studio_transfers", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  ownerId: uuid("owner_id").notNull().references(() => users.id), requestId: uuid("request_id").notNull(),
  scope: text("scope").notNull(), targetScope: text("target_scope").notNull(), manifestHash: text("manifest_hash").notNull(),
  request: jsonb("request").$type<StudioTransferRequest>().notNull(), manifest: jsonb("manifest").$type<unknown>().notNull(),
  receipt: jsonb("receipt").$type<StudioTransferReceipt>(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  committedAt: timestamp("committed_at", { withTimezone: true, mode: "date" }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
}, t => [
  uniqueIndex("creative_studio_transfer_request_unique").on(t.tenantId, t.ownerId, t.requestId),
  uniqueIndex("creative_studio_transfers_tenant_id_unique").on(t.tenantId, t.id),
  index("creative_studio_transfer_owner_idx").on(t.tenantId, t.ownerId, t.createdAt),
  index("creative_studio_transfer_scope_cursor_idx").on(t.tenantId, t.ownerId, t.scope, t.id),
  check("creative_studio_transfer_scope_check", sql`${t.scope} <> ${t.targetScope}`),
  check("creative_studio_transfer_hash_check", sql`${t.manifestHash} ~ '^[a-f0-9]{64}$'`),
  check("creative_studio_transfer_receipt_check", sql`(${t.receipt} is null) = (${t.committedAt} is null)`),
  check("creative_studio_transfer_terminal_check", sql`${t.cancelledAt} is null or ${t.receipt} is null`),
]);

export const creativeStudioEntries = pgTable("creative_studio_entries", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  ownerId: uuid("owner_id").notNull().references(() => users.id), scope: text("scope").notNull(),
  namespace: text("namespace").notNull(), key: text("key").notNull(), revision: integer("revision").notNull().default(1),
  value: jsonb("value").$type<unknown>(), assetId: uuid("asset_id"),
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [
  uniqueIndex("creative_studio_entries_address_unique").on(t.tenantId, t.ownerId, t.scope, t.namespace, t.key),
  uniqueIndex("creative_studio_entries_tenant_id_unique").on(t.tenantId, t.id),
  check("creative_studio_entries_revision_check", sql`${t.revision} > 0`),
  foreignKey({ columns: [t.tenantId, t.assetId], foreignColumns: [assetFiles.tenantId, assetFiles.id], name: "creative_studio_entries_asset_fk" }).onDelete("restrict"),
]);

export const creativeStudioRevisions = pgTable("creative_studio_revisions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  entryId: uuid("entry_id").notNull(), revision: integer("revision").notNull(),
  value: jsonb("value").$type<unknown>(), assetId: uuid("asset_id"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [
  uniqueIndex("creative_studio_revisions_number_unique").on(t.tenantId, t.entryId, t.revision),
  foreignKey({ columns: [t.tenantId, t.entryId], foreignColumns: [creativeStudioEntries.tenantId, creativeStudioEntries.id], name: "creative_studio_revisions_entry_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.tenantId, t.assetId], foreignColumns: [assetFiles.tenantId, assetFiles.id], name: "creative_studio_revisions_asset_fk" }).onDelete("restrict"),
]);

export const creativeStudioGenerations = pgTable("creative_studio_generations", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  ownerId: uuid("owner_id").notNull().references(() => users.id), scope: text("scope").notNull(),
  requestId: uuid("request_id").notNull(), input: jsonb("input").$type<StudioGenerate>().notNull(),
  modelSnapshot: jsonb("model_snapshot").$type<{ providerConfigId: string; model: string; capability: "image" | "video" | "text"; routeId?: string; providerFingerprint?: string; visualCeilingUsd?: number }>().notNull(),
  references: jsonb("references").$type<Array<{ assetId: string; version: number; checksum: string }>>().notNull(),
  status: text("status").$type<"queued" | "running" | "completed" | "failed">().notNull().default("queued"),
  providerTaskId: text("provider_task_id"), assetId: uuid("asset_id"), resultText: text("result_text"), error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [
  uniqueIndex("creative_studio_generation_request_unique").on(t.tenantId, t.ownerId, t.requestId),
  uniqueIndex("creative_studio_generations_tenant_id_unique").on(t.tenantId, t.id),
  index("creative_studio_generation_owner_idx").on(t.tenantId, t.ownerId, t.createdAt),
  check("creative_studio_generation_status_check", sql`${t.status} in ('queued','running','completed','failed')`),
  foreignKey({ columns: [t.tenantId, t.assetId], foreignColumns: [assetFiles.tenantId, assetFiles.id], name: "creative_studio_generation_asset_fk" }).onDelete("restrict"),
]);
