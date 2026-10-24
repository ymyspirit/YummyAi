import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import type { RecordProductionMaterial } from "@yummyai/contracts/order/material-execution";
import { stockQuantity, exactStockQuantity } from "../stock-quantity.js";
import { organizations, users } from "./identity.js";
import { productionManufacturingBindings } from "./production-manufacturing.js";
import { inventoryLocations, inventoryLots, inventoryMovements, inventoryReservations, inventoryStockItems } from "./inventory.js";

/** Immutable causal links; merchant quantities remain owned by the inventory ledger. */
export const productionMaterialEntries = pgTable("production_material_entries", {
  id: uuid("id").primaryKey(), tenantId: uuid("tenant_id").notNull().references(() => organizations.id),
  productionOrderId: uuid("production_order_id").notNull(), bindingId: uuid("binding_id").notNull(),
  materialCode: text("material_code").notNull(), stockItemId: uuid("stock_item_id").notNull(), unit: text("unit").notNull(),
  kind: text("kind").$type<RecordProductionMaterial["kind"]>().notNull(), quantity: stockQuantity("quantity").notNull(),
  locationId: uuid("location_id"), lotId: uuid("lot_id"), reservationId: uuid("reservation_id"), movementId: uuid("movement_id"), originalEntryId: uuid("original_entry_id"),
  reportReference: text("report_reference"), encryptedReason: text("encrypted_reason"),
  idempotencyKey: text("idempotency_key").notNull(), requestChecksum: text("request_checksum").notNull(),
  createdBy: uuid("created_by").notNull().references(() => users.id),
  occurredAt: timestamp("occurred_at", { mode: "date", withTimezone: true }).notNull(),
  recordedAt: timestamp("recorded_at", { mode: "date", withTimezone: true }).defaultNow().notNull(),
}, t => [
  uniqueIndex("production_material_entries_scope").on(t.tenantId, t.id),
  uniqueIndex("production_material_entries_request").on(t.tenantId, t.productionOrderId, t.idempotencyKey),
  uniqueIndex("production_material_entries_movement").on(t.tenantId, t.movementId),
  uniqueIndex("production_material_entries_reservation").on(t.tenantId, t.reservationId).where(sql`${t.kind}='reserve'`),
  index("production_material_entries_corrections").on(t.tenantId, t.originalEntryId, t.kind),
  index("production_material_entries_history").on(t.tenantId, t.productionOrderId, t.bindingId, t.id),
  check("production_material_entries_quantity", sql`${t.quantity}>0 and ${exactStockQuantity(t.quantity, t.unit)}`),
  check("production_material_entries_kind", sql`${t.kind} in ('reserve','consume','release','return','factory_report','factory_correction')`),
  foreignKey({ columns: [t.tenantId, t.bindingId, t.productionOrderId], foreignColumns: [productionManufacturingBindings.tenantId, productionManufacturingBindings.id, productionManufacturingBindings.productionOrderId] }),
  foreignKey({ columns: [t.tenantId, t.stockItemId], foreignColumns: [inventoryStockItems.tenantId, inventoryStockItems.id] }),
  foreignKey({ columns: [t.tenantId, t.locationId], foreignColumns: [inventoryLocations.tenantId, inventoryLocations.id] }),
  foreignKey({ columns: [t.tenantId, t.stockItemId, t.lotId], foreignColumns: [inventoryLots.tenantId, inventoryLots.stockItemId, inventoryLots.id] }),
  foreignKey({ columns: [t.tenantId, t.reservationId], foreignColumns: [inventoryReservations.tenantId, inventoryReservations.id] }),
  foreignKey({ columns: [t.tenantId, t.movementId], foreignColumns: [inventoryMovements.tenantId, inventoryMovements.id] }),
  foreignKey({ columns: [t.tenantId, t.originalEntryId], foreignColumns: [t.tenantId, t.id] }),
]);
