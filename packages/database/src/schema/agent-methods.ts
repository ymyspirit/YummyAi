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
import type { AgentMethodDefinition } from "@yummyai/contracts/harness/methods";
import { organizations, users } from "./identity.js";

const scope = () => ({
  id: uuid("id").primaryKey(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => organizations.id),
});
export const agentMethods = pgTable(
  "agent_methods",
  {
    ...scope(),
    methodKey: text("method_key").notNull(),
    revision: integer("revision").notNull().default(1),
    latestVersion: integer("latest_version").notNull().default(1),
    activeVersion: integer("active_version"),
    state: text("state").$type<"draft" | "in_review" | "published">().notNull().default("draft"),
    withdrawalGeneration: integer("withdrawal_generation").notNull().default(0),
    adoptedAt: timestamp("adopted_at", { withTimezone: true }),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_methods_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("agent_methods_key_unique").on(t.tenantId, t.methodKey),
  ],
);
export const agentMethodVersions = pgTable(
  "agent_method_versions",
  {
    ...scope(),
    methodId: uuid("method_id").notNull(),
    version: integer("version").notNull(),
    definition: jsonb("definition").$type<AgentMethodDefinition>().notNull(),
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
    uniqueIndex("agent_method_versions_tenant_id_unique").on(t.tenantId, t.id),
    uniqueIndex("agent_method_versions_number_unique").on(t.tenantId, t.methodId, t.version),
    uniqueIndex("agent_method_versions_request_unique").on(t.tenantId, t.requestId),
    foreignKey({
      columns: [t.tenantId, t.methodId],
      foreignColumns: [agentMethods.tenantId, agentMethods.id],
    }),
  ],
);
export const agentMethodEvents = pgTable(
  "agent_method_events",
  {
    ...scope(),
    methodId: uuid("method_id").notNull(),
    version: integer("version").notNull(),
    revision: integer("revision").notNull(),
    action: text("action")
      .$type<"create" | "revise" | "submit" | "publish" | "reject" | "disable">()
      .notNull(),
    reason: text("reason").notNull(),
    requestId: uuid("request_id").notNull(),
    requestChecksum: text("request_checksum").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("agent_method_events_request_unique").on(t.tenantId, t.requestId),
    foreignKey({
      columns: [t.tenantId, t.methodId, t.version],
      foreignColumns: [
        agentMethodVersions.tenantId,
        agentMethodVersions.methodId,
        agentMethodVersions.version,
      ],
    }),
  ],
);
