import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { FactoryCapacityPoolProfile } from "@yummyai/contracts/suppliers/factory-capacity";
import { organizations, users } from "./identity.js";
import { fulfillmentFactories, fulfillmentFactoryVersions, factoryCapabilityVersions } from "./factory-directory.js";
import { productionOrders, productionOrderVersions, productionMilestoneEvents } from "./order-production.js";

export const factoryCapacityPools = pgTable("factory_capacity_pools", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(),
  factoryVersionId: uuid("factory_version_id").notNull(), code: text("code").notNull(), timeZone: text("time_zone").notNull(), unit: text("unit").notNull(),
  currentVersionNumber: integer("current_version_number").notNull(), createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("factory_capacity_pools_scope").on(table.tenantId, table.id), uniqueIndex("factory_capacity_pools_parent").on(table.tenantId, table.factoryId, table.id),
  uniqueIndex("factory_capacity_pools_code").on(table.tenantId, table.factoryId, table.code),
  foreignKey({ columns: [table.tenantId, table.factoryId], foreignColumns: [fulfillmentFactories.tenantId, fulfillmentFactories.id], name: "factory_capacity_pool_factory_fk" }),
  foreignKey({ columns: [table.tenantId, table.factoryId, table.factoryVersionId], foreignColumns: [fulfillmentFactoryVersions.tenantId, fulfillmentFactoryVersions.factoryId, fulfillmentFactoryVersions.id], name: "factory_capacity_pool_factory_version_fk" }),
  check("factory_capacity_pool_base", sql`${table.unit} in ('each','minute') and ${table.currentVersionNumber}>0`),
]);
export const factoryCapacityVersions = pgTable("factory_capacity_versions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(), poolId: uuid("pool_id").notNull(),
  versionNumber: integer("version_number").notNull(), profile: jsonb("profile").$type<FactoryCapacityPoolProfile>().notNull(),
  idempotencyKey: uuid("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("factory_capacity_versions_scope").on(table.tenantId, table.id), uniqueIndex("factory_capacity_versions_parent").on(table.tenantId, table.poolId, table.id),
  uniqueIndex("factory_capacity_versions_number").on(table.tenantId, table.poolId, table.versionNumber), uniqueIndex("factory_capacity_versions_request").on(table.tenantId, table.idempotencyKey),
  foreignKey({ columns: [table.tenantId, table.factoryId, table.poolId], foreignColumns: [factoryCapacityPools.tenantId, factoryCapacityPools.factoryId, factoryCapacityPools.id], name: "factory_capacity_version_pool_fk" }),
  check("factory_capacity_version_fields", sql`${table.versionNumber}>0 and ${table.requestChecksum}~'^[a-f0-9]{64}$' and jsonb_typeof(${table.profile})='object'`),
]);
export const factoryCapacityReservations = pgTable("factory_capacity_reservations", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), factoryId: uuid("factory_id").notNull(), poolId: uuid("pool_id").notNull(), poolVersionId: uuid("pool_version_id").notNull(),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id").notNull(), capabilityVersionId: uuid("capability_version_id").notNull(),
  localDate: date("local_date", { mode: "string" }).notNull(), timeZone: text("time_zone").notNull(), unit: text("unit").notNull(),
  quantity: integer("quantity").notNull(), unitsPerItem: integer("units_per_item").notNull(), totalUnits: bigint("total_units", { mode: "number" }).notNull(),
  workStartsAt: timestamp("work_starts_at", { withTimezone: true }).notNull(), workEndsAt: timestamp("work_ends_at", { withTimezone: true }).notNull(),
  creationTransactionId: text("creation_transaction_id").default(sql`pg_current_xact_id()::text`).notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("factory_capacity_reservations_scope").on(table.tenantId, table.id), uniqueIndex("factory_capacity_reservations_production_pool").on(table.tenantId, table.productionVersionId, table.poolId),
  foreignKey({ columns: [table.tenantId, table.factoryId, table.poolId], foreignColumns: [factoryCapacityPools.tenantId, factoryCapacityPools.factoryId, factoryCapacityPools.id], name: "factory_capacity_reservation_pool_fk" }),
  foreignKey({ columns: [table.tenantId, table.poolId, table.poolVersionId], foreignColumns: [factoryCapacityVersions.tenantId, factoryCapacityVersions.poolId, factoryCapacityVersions.id], name: "factory_capacity_reservation_version_fk" }),
  foreignKey({ columns: [table.tenantId, table.productionOrderId], foreignColumns: [productionOrders.tenantId, productionOrders.id], name: "factory_capacity_reservation_production_fk" }),
  foreignKey({ columns: [table.tenantId, table.productionVersionId, table.productionOrderId, table.quantity], foreignColumns: [productionOrderVersions.tenantId, productionOrderVersions.id, productionOrderVersions.productionOrderId, productionOrderVersions.quantity], name: "factory_capacity_reservation_production_version_fk" }),
  foreignKey({ columns: [table.tenantId, table.factoryId, table.capabilityVersionId], foreignColumns: [factoryCapabilityVersions.tenantId, factoryCapabilityVersions.factoryId, factoryCapabilityVersions.id], name: "factory_capacity_reservation_capability_fk" }),
  check("factory_capacity_reservation_amount", sql`${table.quantity} between 1 and 100000 and ${table.unitsPerItem} between 1 and 1000000 and ${table.totalUnits}=${table.quantity}::bigint*${table.unitsPerItem} and ${table.totalUnits} between 1 and 1000000000`),
  check("factory_capacity_reservation_time", sql`${table.workEndsAt}>${table.workStartsAt}`),
  index("factory_capacity_reservations_day").on(table.tenantId, table.poolId, table.localDate), index("factory_capacity_reservations_production").on(table.tenantId, table.productionOrderId),
]);
export const factoryCapacityEvents = pgTable("factory_capacity_events", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id), reservationId: uuid("reservation_id").notNull(),
  sequence: integer("sequence").notNull(), kind: text("kind").notNull(), units: bigint("units", { mode: "number" }).notNull(), milestoneEventId: uuid("milestone_event_id"),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("factory_capacity_events_sequence").on(table.tenantId, table.reservationId, table.sequence), uniqueIndex("factory_capacity_events_milestone").on(table.tenantId, table.reservationId, table.milestoneEventId),
  foreignKey({ columns: [table.tenantId, table.reservationId], foreignColumns: [factoryCapacityReservations.tenantId, factoryCapacityReservations.id], name: "factory_capacity_event_reservation_fk" }),
  foreignKey({ columns: [table.tenantId, table.milestoneEventId], foreignColumns: [productionMilestoneEvents.tenantId, productionMilestoneEvents.id], name: "factory_capacity_event_milestone_fk" }),
  check("factory_capacity_event_kind", sql`${table.kind} in ('reserve','commit','release') and ${table.units}>0 and ${table.sequence}>0 and ((${table.kind}='reserve')=(${table.milestoneEventId} is null))`),
]);

/** Minted by actual INSERT triggers only; historical facts never acquire a new birth. */
export const factoryCapacityOwnerProofs = pgTable("factory_capacity_owner_proofs", {
  tenantId: uuid("tenant_id").notNull().references(() => organizations.id), ownerKind: text("owner_kind").notNull(), ownerId: uuid("owner_id").notNull(),
  productionOrderId: uuid("production_order_id").notNull(), productionVersionId: uuid("production_version_id"), milestoneEventId: uuid("milestone_event_id"),
  quantity: integer("quantity"), milestoneType: text("milestone_type"), creationTransactionId: text("creation_transaction_id").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id), createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, table => [
  uniqueIndex("factory_capacity_owner_proofs_identity").on(table.tenantId, table.ownerKind, table.ownerId),
  foreignKey({ columns: [table.tenantId, table.productionOrderId], foreignColumns: [productionOrders.tenantId, productionOrders.id], name: "factory_capacity_owner_production_fk" }),
  foreignKey({ columns: [table.tenantId, table.productionVersionId, table.productionOrderId, table.quantity], foreignColumns: [productionOrderVersions.tenantId, productionOrderVersions.id, productionOrderVersions.productionOrderId, productionOrderVersions.quantity], name: "factory_capacity_owner_version_fk" }),
  foreignKey({ columns: [table.tenantId, table.milestoneEventId], foreignColumns: [productionMilestoneEvents.tenantId, productionMilestoneEvents.id], name: "factory_capacity_owner_milestone_fk" }),
  check("factory_capacity_owner_proof_shape", sql`(${table.ownerKind}='version' and ${table.ownerId}=${table.productionVersionId} and ${table.quantity}>0 and ${table.milestoneEventId} is null and ${table.milestoneType} is null) or (${table.ownerKind}='milestone' and ${table.ownerId}=${table.milestoneEventId} and ${table.productionVersionId} is null and ${table.quantity} is null and ${table.milestoneType} is not null)`),
]);
