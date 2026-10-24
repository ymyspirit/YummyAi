import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { FactoryProfile, FactoryCapabilityProfile } from "@yummyai/contracts/suppliers/factory-directory";
import { organizations, users } from "./identity.js";
import { fulfillmentSuppliers } from "./order-routing.js";

export const fulfillmentFactories = pgTable("fulfillment_factories", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), supplierId: uuid("supplier_id").notNull(),
  code: text("code").notNull(), name: text("name").notNull(), status: text("status").notNull(), currentVersionNumber: integer("current_version_number").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("fulfillment_factories_tenant_id_unique").on(t.tenantId, t.id), uniqueIndex("fulfillment_factories_parent_unique").on(t.tenantId, t.supplierId, t.id), uniqueIndex("fulfillment_factories_code_unique").on(t.tenantId, t.code),
  foreignKey({ columns: [t.tenantId, t.supplierId], foreignColumns: [fulfillmentSuppliers.tenantId, fulfillmentSuppliers.id], name: "fulfillment_factories_supplier_fk" }),
  check("fulfillment_factories_version_check", sql`${t.currentVersionNumber}>0`), index("fulfillment_factories_supplier_idx").on(t.tenantId, t.supplierId, t.status),
]);
export const fulfillmentFactoryVersions = pgTable("fulfillment_factory_versions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(), versionNumber: integer("version_number").notNull(),
  profile: jsonb("profile").$type<FactoryProfile>().notNull(), idempotencyKey: uuid("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("fulfillment_factory_versions_tenant_id_unique").on(t.tenantId, t.id), uniqueIndex("fulfillment_factory_versions_parent_unique").on(t.tenantId, t.factoryId, t.id),
  uniqueIndex("fulfillment_factory_versions_number_unique").on(t.tenantId, t.factoryId, t.versionNumber), uniqueIndex("fulfillment_factory_versions_request_unique").on(t.tenantId, t.idempotencyKey),
  foreignKey({ columns: [t.tenantId, t.factoryId], foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.id], name: "fulfillment_factory_versions_factory_fk" }),
]);
export const factoryCapabilities = pgTable("factory_capabilities", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(),
  name: text("name").notNull(), status: text("status").notNull(), currentVersionNumber: integer("current_version_number").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(), updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("factory_capabilities_tenant_id_unique").on(t.tenantId, t.id), uniqueIndex("factory_capabilities_parent_unique").on(t.tenantId, t.factoryId, t.id),
  foreignKey({ columns: [t.tenantId, t.factoryId], foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.id], name: "factory_capabilities_factory_fk" }), index("factory_capabilities_factory_idx").on(t.tenantId, t.factoryId, t.status),
]);
export const factoryCapabilityVersions = pgTable("factory_capability_versions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(), capabilityId: uuid("capability_id").notNull(), versionNumber: integer("version_number").notNull(),
  profile: jsonb("profile").$type<FactoryCapabilityProfile>().notNull(), idempotencyKey: uuid("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("factory_capability_versions_tenant_id_unique").on(t.tenantId, t.id), uniqueIndex("factory_capability_versions_parent_unique").on(t.tenantId, t.factoryId, t.id),
  uniqueIndex("factory_capability_versions_number_unique").on(t.tenantId, t.capabilityId, t.versionNumber), uniqueIndex("factory_capability_versions_request_unique").on(t.tenantId, t.idempotencyKey),
  foreignKey({ columns: [t.tenantId, t.factoryId, t.capabilityId], foreignColumns: [factoryCapabilities.tenantId, factoryCapabilities.factoryId, factoryCapabilities.id], name: "factory_capability_versions_capability_fk" }),
]);
