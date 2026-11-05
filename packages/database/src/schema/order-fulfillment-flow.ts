import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, jsonb, timestamp, uniqueIndex, foreignKey, index, check } from "drizzle-orm/pg-core";
import type { TenantContext } from "@yummyai/contracts";
import type { FulfillmentRoute, FulfillmentFlowStage } from "@yummyai/contracts/order/fulfillment-flow";
import { organizations, users } from "./identity.js";
import { orders } from "./order.js";

export const fulfillmentRoutes = pgTable("fulfillment_routes", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  version: integer("version").notNull(), profile: jsonb("profile").$type<FulfillmentRoute>().notNull(),
  requestKey: uuid("request_key").notNull(), requestHash: text("request_hash").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [uniqueIndex("fulfillment_routes_scope").on(t.tenantId,t.id), uniqueIndex("fulfillment_routes_request").on(t.tenantId,t.requestKey),
  check("fulfillment_routes_version",sql`${t.version}>0`)]);

export const fulfillmentRouteVersions = pgTable("fulfillment_route_versions", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  routeId: uuid("route_id").notNull(), version: integer("version").notNull(),
  profile: jsonb("profile").$type<FulfillmentRoute>().notNull(),
  requestKey: uuid("request_key").notNull(), requestHash: text("request_hash").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [uniqueIndex("fulfillment_route_versions_scope").on(t.tenantId,t.id),
  uniqueIndex("fulfillment_route_versions_number").on(t.tenantId,t.routeId,t.version),
  uniqueIndex("fulfillment_route_versions_request").on(t.tenantId,t.requestKey),
  foreignKey({columns:[t.tenantId,t.routeId],foreignColumns:[fulfillmentRoutes.tenantId,fulfillmentRoutes.id]})]);

/** One durable continuation per order. This journal owns no production, payment
 * or dispatch facts; those always remain in the original domain owners. */
export const orderFulfillmentFlows = pgTable("order_fulfillment_flows", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  orderId: uuid("order_id").notNull(), requestedBy: uuid("requested_by").notNull().references(() => users.id),
  authority: jsonb("authority").$type<TenantContext>().notNull(),
  stage: text("stage").$type<FulfillmentFlowStage>().notNull().default("waiting_artwork"),
  routeId: uuid("route_id"), routeVersion: integer("route_version"),
  routeSnapshot: jsonb("route_snapshot").$type<FulfillmentRoute>(),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  productionOrderIds: jsonb("production_order_ids").$type<string[]>().notNull().default([]),
  logisticsTaskId: uuid("logistics_task_id"),
  productionExportId: uuid("production_export_id"),
  deliveryPackageIds: jsonb("delivery_package_ids").$type<string[]>().notNull().default([]),
  pendingCommand: jsonb("pending_command").$type<{ kind: string; input: unknown }>(),
  retryCount: integer("retry_count").notNull().default(0),
  nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  leaseToken: uuid("lease_token"), leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, t => [uniqueIndex("order_fulfillment_flows_scope").on(t.tenantId,t.id),
  uniqueIndex("order_fulfillment_flows_order").on(t.tenantId,t.orderId),
  foreignKey({columns:[t.tenantId,t.orderId],foreignColumns:[orders.tenantId,orders.id]}),
  foreignKey({columns:[t.tenantId,t.routeId],foreignColumns:[fulfillmentRoutes.tenantId,fulfillmentRoutes.id]}),
  index("order_fulfillment_flows_due").on(t.tenantId,t.nextRunAt),
  check("order_fulfillment_flows_stage",sql`${t.stage} in ('waiting_artwork','waiting_render','production','logistics','delivery','waiting_factory','waiting_dispatch','writeback','completed','exception','paused')`)]);

/** Discovery contains tenant IDs only, following production_render_dispatch_tenants.
 * All order, route and authority access still runs through forced tenant RLS. */
export const orderFlowDispatchTenants = pgTable("order_flow_dispatch_tenants", {
  tenantId: uuid("tenant_id").primaryKey().references(() => organizations.id),
});
