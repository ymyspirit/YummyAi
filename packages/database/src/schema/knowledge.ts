import {
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { KnowledgeAction, KnowledgeFields } from "@yummyai/contracts/knowledge";
import { organizations, users } from "./identity.js";
import { spus } from "./catalog.js";
const scope = () => ({
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => organizations.id),
});
export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    ...scope(),
    revision: integer("revision").notNull().default(1),
    latestVersion: integer("latest_version").notNull().default(1),
    activeVersion: integer("active_version"),
    state: text("state").$type<"draft" | "in_review" | "published">().notNull().default("draft"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("knowledge_entries_tenant_id_unique").on(t.tenantId, t.id)],
);
export const knowledgeVersions = pgTable(
  "knowledge_versions",
  {
    ...scope(),
    entryId: uuid("entry_id").notNull(),
    version: integer("version").notNull(),
    fields: jsonb("fields").$type<KnowledgeFields>().notNull(),
    scopeSpuId: uuid("scope_spu_id"),
    checksum: text("checksum").notNull(),
    reason: text("reason").notNull(),
    requestId: uuid("request_id").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("knowledge_versions_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("knowledge_versions_number_unique").on(t.tenantId, t.entryId, t.version),
    uniqueIndex("knowledge_versions_request_unique").on(t.tenantId, t.requestId),
    foreignKey({
      columns: [t.tenantId, t.entryId],
      foreignColumns: [knowledgeEntries.tenantId, knowledgeEntries.id],
    }),
    foreignKey({ columns: [t.tenantId, t.scopeSpuId], foreignColumns: [spus.tenantId, spus.id] }),
  ],
);
export const knowledgeEvents = pgTable(
  "knowledge_events",
  {
    ...scope(),
    entryId: uuid("entry_id").notNull(),
    version: integer("version").notNull(),
    action: text("action").$type<KnowledgeAction>().notNull(),
    reason: text("reason").notNull(),
    requestId: uuid("request_id").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("knowledge_events_request_unique").on(t.tenantId, t.requestId),
    foreignKey({
      columns: [t.tenantId, t.entryId, t.version],
      foreignColumns: [
        knowledgeVersions.tenantId,
        knowledgeVersions.entryId,
        knowledgeVersions.version,
      ],
    }),
  ],
);
