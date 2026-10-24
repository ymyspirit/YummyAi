import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, foreignKey } from "drizzle-orm/pg-core";
import type { RuleDefinition } from "@yummyai/contracts/rules";
import { organizations, users } from "./identity.js";
import { spus } from "./catalog.js";

const scope = () => ({ id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id) });
export const businessRules = pgTable("business_rules", {
  ...scope(), code: text("code").notNull(), revision: integer("revision").notNull().default(1),
  latestVersion: integer("latest_version").notNull().default(1), activeVersion: integer("active_version"),
  createdBy: uuid("created_by").notNull().references(() => users.id), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("business_rules_tenant_id_unique").on(t.tenantId, t.id), uniqueIndex("business_rules_code_unique").on(t.tenantId, t.code)]);
export const businessRuleVersions = pgTable("business_rule_versions", {
  ...scope(), ruleId: uuid("rule_id").notNull(), version: integer("version").notNull(),
  definition: jsonb("definition").$type<RuleDefinition>().notNull(), scopeSpuId: uuid("scope_spu_id"),
  changeReason: text("change_reason").notNull(), idempotencyKey: uuid("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("business_rule_versions_tenant_id_unique").on(t.tenantId, t.id),
  uniqueIndex("business_rule_versions_number_unique").on(t.tenantId, t.ruleId, t.version),
  uniqueIndex("business_rule_versions_request_unique").on(t.tenantId, t.idempotencyKey),
  foreignKey({ columns: [t.tenantId, t.ruleId], foreignColumns: [businessRules.tenantId, businessRules.id] }),
  foreignKey({ columns: [t.tenantId, t.scopeSpuId], foreignColumns: [spus.tenantId, spus.id] }),
]);
export const businessRuleEvents = pgTable("business_rule_events", {
  ...scope(), ruleId: uuid("rule_id").notNull(), version: integer("version").notNull(),
  action: text("action").$type<"create" | "revise" | "publish" | "disable">().notNull(), reason: text("reason").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [foreignKey({ columns: [t.tenantId, t.ruleId, t.version], foreignColumns: [businessRuleVersions.tenantId, businessRuleVersions.ruleId, businessRuleVersions.version] })]);
