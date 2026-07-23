import { createHash } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  CancelInventoryTransferInputSchema,
  CreateInventoryLocationInputSchema,
  CreateInventoryLotInputSchema,
  CreateInventoryReservationInputSchema,
  CreateInventoryTransferInputSchema,
  CreateStockItemInputSchema,
  CreateWarehouseInputSchema,
  DispatchInventoryTransferInputSchema,
  RebuildInventoryProjectionInputSchema,
  ReceiveInventoryTransferInputSchema,
  RecordInventoryMovementInputSchema,
  ReleaseInventoryReservationInputSchema,
  createEntityId,
  type CancelInventoryTransferInput,
  type CreateInventoryLocationInput,
  type CreateInventoryLotInput,
  type CreateInventoryReservationInput,
  type CreateInventoryTransferInput,
  type CreateStockItemInput,
  type CreateWarehouseInput,
  type DispatchInventoryTransferInput,
  type InventoryBucket,
  type InventoryUnit,
  type RebuildInventoryProjectionInput,
  type ReceiveInventoryTransferInput,
  type RecordInventoryMovementInput,
  type ReleaseInventoryReservationInput,
  type TenantContext,
} from "@yummyai/contracts";
import {
  inventoryBalances,
  inventoryLocations,
  inventoryLots,
  inventoryMovements,
  inventoryProjectionRebuilds,
  inventoryReservationEvents,
  inventoryReservations,
  inventoryStockItems,
  inventoryTransferEvents,
  inventoryTransfers,
  inventoryWarehouses,
  skus,
  type DatabaseConnection,
  type TenantTransaction,
  withTenant,
} from "@yummyai/database";
import { and, asc, desc, eq, sql } from "drizzle-orm";

import { AuditService } from "../audit/audit.service.js";
import { DATABASE_CONNECTION } from "../platform.tokens.js";

type BalanceRow = typeof inventoryBalances.$inferSelect;
type MovementRow = typeof inventoryMovements.$inferSelect;

export interface ReceiveProcurementStockInput {
  receiptId: string;
  stockItemId: string;
  locationId: string;
  lotCode: string;
  quantity: number;
  unit: InventoryUnit;
  unitCostMinor: number;
  currency: string;
  receivedAt: string;
  expiresAt: string | null;
  idempotencyKey: string;
}

@Injectable()
export class InventoryService {
  constructor(
    @Inject(DATABASE_CONNECTION) private readonly database: DatabaseConnection,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async createWarehouse(context: TenantContext, rawInput: CreateWarehouseInput) {
    const input = CreateWarehouseInputSchema.parse(rawInput);
    const warehouse = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `inventory-warehouse-code:${context.tenantId}:${input.code}`);
      const [existing] = await tx.select({ id: inventoryWarehouses.id }).from(inventoryWarehouses)
        .where(eq(inventoryWarehouses.code, input.code)).limit(1);
      if (existing) throw new ConflictException("Warehouse code already exists");
      const [created] = await tx.insert(inventoryWarehouses).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        ...input,
        createdBy: context.userId,
      }).returning();
      return created!;
    });
    await this.audit.record(context, {
      action: "inventory.warehouse.create",
      resourceType: "inventory_warehouse",
      resourceId: warehouse.id,
      result: "success",
      metadata: { code: warehouse.code, type: warehouse.type },
    });
    return warehouse;
  }

  listWarehouses(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) =>
      tx.select().from(inventoryWarehouses).orderBy(asc(inventoryWarehouses.name)));
  }

  async createLocation(context: TenantContext, rawInput: CreateInventoryLocationInput) {
    const input = CreateInventoryLocationInputSchema.parse(rawInput);
    const location = await withTenant(this.database.db, context, async (tx) => {
      await requireWarehouse(tx, input.warehouseId);
      await lock(tx, `inventory-location-code:${context.tenantId}:${input.warehouseId}:${input.code}`);
      const [existing] = await tx.select({ id: inventoryLocations.id }).from(inventoryLocations)
        .where(and(eq(inventoryLocations.warehouseId, input.warehouseId), eq(inventoryLocations.code, input.code))).limit(1);
      if (existing) throw new ConflictException("Location code already exists in this warehouse");
      const [created] = await tx.insert(inventoryLocations).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        ...input,
        createdBy: context.userId,
      }).returning();
      return created!;
    });
    await this.audit.record(context, {
      action: "inventory.location.create",
      resourceType: "inventory_location",
      resourceId: location.id,
      result: "success",
      metadata: { warehouseId: location.warehouseId, code: location.code },
    });
    return location;
  }

  listLocations(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) =>
      tx.select().from(inventoryLocations).orderBy(asc(inventoryLocations.warehouseId), asc(inventoryLocations.name)));
  }

  async createStockItem(context: TenantContext, rawInput: CreateStockItemInput) {
    const input = CreateStockItemInputSchema.parse(rawInput);
    const stockItem = await withTenant(this.database.db, context, async (tx) => {
      if (input.skuId) {
        const [sku] = await tx.select({ id: skus.id }).from(skus).where(eq(skus.id, input.skuId)).limit(1);
        if (!sku) throw new NotFoundException("SKU not found");
      }
      await lock(tx, `inventory-stock-code:${context.tenantId}:${input.code}`);
      const [existing] = await tx.select({ id: inventoryStockItems.id }).from(inventoryStockItems)
        .where(eq(inventoryStockItems.code, input.code)).limit(1);
      if (existing) throw new ConflictException("Stock item code already exists");
      const [created] = await tx.insert(inventoryStockItems).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        ...input,
        createdBy: context.userId,
      }).returning();
      return created!;
    });
    await this.audit.record(context, {
      action: "inventory.stock_item.create",
      resourceType: "inventory_stock_item",
      resourceId: stockItem.id,
      result: "success",
      metadata: { code: stockItem.code, skuId: stockItem.skuId },
    });
    return stockItem;
  }

  listStockItems(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) =>
      tx.select().from(inventoryStockItems).orderBy(asc(inventoryStockItems.name)));
  }

  async createLot(context: TenantContext, rawInput: CreateInventoryLotInput) {
    const input = CreateInventoryLotInputSchema.parse(rawInput);
    const lot = await withTenant(this.database.db, context, async (tx) => {
      await requireStockItem(tx, input.stockItemId);
      await lock(tx, `inventory-lot-code:${context.tenantId}:${input.stockItemId}:${input.code}`);
      const [existing] = await tx.select({ id: inventoryLots.id }).from(inventoryLots)
        .where(and(eq(inventoryLots.stockItemId, input.stockItemId), eq(inventoryLots.code, input.code))).limit(1);
      if (existing) throw new ConflictException("Lot code already exists for this stock item");
      const [created] = await tx.insert(inventoryLots).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        ...input,
        receivedAt: input.receivedAt ? new Date(input.receivedAt) : null,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: context.userId,
      }).returning();
      return created!;
    });
    await this.audit.record(context, {
      action: "inventory.lot.create",
      resourceType: "inventory_lot",
      resourceId: lot.id,
      result: "success",
      metadata: { stockItemId: lot.stockItemId, sourceType: lot.sourceType },
    });
    return lot;
  }

  listLots(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) =>
      tx.select().from(inventoryLots).orderBy(desc(inventoryLots.createdAt)));
  }

  async receiveProcurementStock(
    tx: TenantTransaction,
    context: TenantContext,
    input: ReceiveProcurementStockInput,
  ) {
    await requireDimension(tx, input.stockItemId, input.locationId, null, input.unit);
    await lock(tx, `inventory-lot-code:${context.tenantId}:${input.stockItemId}:${input.lotCode}`);
    const [existingLot] = await tx.select({ id: inventoryLots.id }).from(inventoryLots)
      .where(and(
        eq(inventoryLots.stockItemId, input.stockItemId),
        eq(inventoryLots.code, input.lotCode),
      )).limit(1);
    if (existingLot) throw new ConflictException("Procurement lot code already exists for this stock item");
    const [lot] = await tx.insert(inventoryLots).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      stockItemId: input.stockItemId,
      code: input.lotCode,
      sourceType: "receipt",
      sourceId: input.receiptId,
      unitCostMinor: input.unitCostMinor,
      unitCostCurrency: input.currency,
      receivedAt: new Date(input.receivedAt),
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdBy: context.userId,
    }).returning();
    const result = await applyMovement(tx, context, {
      stockItemId: input.stockItemId,
      locationId: input.locationId,
      lotId: lot!.id,
      bucket: "physical",
      type: "receipt",
      quantityDelta: input.quantity,
      unit: input.unit,
      sourceType: "receipt",
      sourceId: input.receiptId,
      reasonCode: "PROCUREMENT_RECEIPT",
      occurredAt: input.receivedAt,
      idempotencyKey: input.idempotencyKey,
    });
    return { lot: lot!, movement: result.movement, balance: toBalanceView(result.balance) };
  }

  async recordMovement(context: TenantContext, rawInput: RecordInventoryMovementInput) {
    const input = RecordInventoryMovementInputSchema.parse(rawInput);
    const result = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `inventory-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventoryMovements)
        .where(eq(inventoryMovements.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        assertMovementReplay(replayed, input);
        return { movement: replayed, balance: await requireBalance(tx, dimensionKey(input.stockItemId, input.locationId, input.lotId)) };
      }
      return applyMovement(tx, context, input);
    });
    await this.audit.record(context, {
      action: "inventory.movement.record",
      resourceType: "inventory_movement",
      resourceId: result.movement.id,
      result: "success",
      metadata: {
        bucket: result.movement.bucket,
        sourceType: result.movement.sourceType,
        stockItemId: result.movement.stockItemId,
      },
    });
    return { movement: result.movement, balance: toBalanceView(result.balance) };
  }

  listMovements(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) =>
      tx.select().from(inventoryMovements).orderBy(desc(inventoryMovements.occurredAt), desc(inventoryMovements.id)).limit(250));
  }

  async createReservation(context: TenantContext, rawInput: CreateInventoryReservationInput) {
    const input = CreateInventoryReservationInputSchema.parse(rawInput);
    const reservationId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `inventory-reservation-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventoryReservations)
        .where(eq(inventoryReservations.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        assertReservationReplay(replayed, input);
        return replayed.id;
      }
      const key = dimensionKey(input.stockItemId, input.locationId, input.lotId);
      await lock(tx, `inventory-dimension:${context.tenantId}:${key}`);
      await requireDimension(tx, input.stockItemId, input.locationId, input.lotId, input.unit);
      const balance = await requireBalance(tx, key);
      if (balance.physicalQuantity - balance.reservedQuantity < input.quantity) {
        throw new ConflictException("Insufficient available stock for reservation");
      }
      const id = createEntityId();
      await tx.insert(inventoryReservations).values({
        id,
        tenantId: context.tenantId,
        ...input,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdBy: context.userId,
      });
      await tx.insert(inventoryReservationEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        reservationId: id,
        sequence: 1,
        action: "reserved",
        fromStatus: null,
        toStatus: "active",
        reasonCode: "RESERVATION_CREATED",
        idempotencyKey: input.idempotencyKey,
        actorUserId: context.userId,
      });
      await tx.update(inventoryBalances).set({
        reservedQuantity: balance.reservedQuantity + input.quantity,
        projectionVersion: balance.projectionVersion + 1,
        updatedAt: new Date(),
      }).where(eq(inventoryBalances.id, balance.id));
      return id;
    });
    await this.audit.record(context, {
      action: "inventory.reservation.create",
      resourceType: "inventory_reservation",
      resourceId: reservationId,
      result: "success",
      metadata: { sourceType: input.sourceType, stockItemId: input.stockItemId },
    });
    return this.getReservation(context, reservationId);
  }

  async releaseReservation(context: TenantContext, reservationId: string, rawInput: ReleaseInventoryReservationInput) {
    const input = ReleaseInventoryReservationInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `inventory-reservation:${context.tenantId}:${reservationId}`);
      const [reservation] = await tx.select().from(inventoryReservations)
        .where(eq(inventoryReservations.id, reservationId)).limit(1);
      if (!reservation) throw new NotFoundException("Inventory reservation not found");
      const [replayed] = await tx.select({ id: inventoryReservationEvents.id }).from(inventoryReservationEvents)
        .where(and(
          eq(inventoryReservationEvents.reservationId, reservationId),
          eq(inventoryReservationEvents.idempotencyKey, input.idempotencyKey),
        )).limit(1);
      if (replayed) return;
      if (reservation.version !== input.expectedVersion) throw new ConflictException("Inventory reservation version changed");
      if (reservation.status !== "active") throw new ConflictException("Only active inventory reservations can be released");
      const key = dimensionKey(reservation.stockItemId, reservation.locationId, reservation.lotId);
      await lock(tx, `inventory-dimension:${context.tenantId}:${key}`);
      const balance = await requireBalance(tx, key);
      if (balance.reservedQuantity < reservation.quantity) throw new ConflictException("Reservation projection is inconsistent");
      await tx.insert(inventoryReservationEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        reservationId,
        sequence: reservation.version + 1,
        action: input.outcome,
        fromStatus: reservation.status,
        toStatus: input.outcome,
        reasonCode: input.reasonCode,
        idempotencyKey: input.idempotencyKey,
        actorUserId: context.userId,
      });
      await tx.update(inventoryReservations).set({
        status: input.outcome,
        version: reservation.version + 1,
        updatedAt: new Date(),
      }).where(eq(inventoryReservations.id, reservationId));
      await tx.update(inventoryBalances).set({
        reservedQuantity: balance.reservedQuantity - reservation.quantity,
        projectionVersion: balance.projectionVersion + 1,
        updatedAt: new Date(),
      }).where(eq(inventoryBalances.id, balance.id));
    });
    await this.audit.record(context, {
      action: "inventory.reservation.release",
      resourceType: "inventory_reservation",
      resourceId: reservationId,
      result: "success",
      metadata: { outcome: input.outcome },
    });
    return this.getReservation(context, reservationId);
  }

  listReservations(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) =>
      tx.select().from(inventoryReservations).orderBy(desc(inventoryReservations.createdAt)).limit(250));
  }

  async getReservation(context: TenantContext, reservationId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [reservation] = await tx.select().from(inventoryReservations)
        .where(eq(inventoryReservations.id, reservationId)).limit(1);
      if (!reservation) throw new NotFoundException("Inventory reservation not found");
      const events = await tx.select().from(inventoryReservationEvents)
        .where(eq(inventoryReservationEvents.reservationId, reservationId))
        .orderBy(asc(inventoryReservationEvents.sequence));
      return { reservation, events };
    });
  }

  async createTransfer(context: TenantContext, rawInput: CreateInventoryTransferInput) {
    const input = CreateInventoryTransferInputSchema.parse(rawInput);
    const transferId = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `inventory-transfer-idempotency:${context.tenantId}:${input.idempotencyKey}`);
      const [replayed] = await tx.select().from(inventoryTransfers)
        .where(eq(inventoryTransfers.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) {
        assertTransferReplay(replayed, input);
        return replayed.id;
      }
      await requireDimension(tx, input.stockItemId, input.sourceLocationId, input.lotId, input.unit);
      await requireDimension(tx, input.stockItemId, input.destinationLocationId, input.lotId, input.unit);
      const id = createEntityId();
      await tx.insert(inventoryTransfers).values({
        id,
        tenantId: context.tenantId,
        ...input,
        createdBy: context.userId,
      });
      await tx.insert(inventoryTransferEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        transferId: id,
        sequence: 1,
        action: "created",
        fromStatus: null,
        toStatus: "draft",
        reasonCode: "TRANSFER_CREATED",
        idempotencyKey: input.idempotencyKey,
        actorUserId: context.userId,
      });
      return id;
    });
    await this.audit.record(context, {
      action: "inventory.transfer.create",
      resourceType: "inventory_transfer",
      resourceId: transferId,
      result: "success",
      metadata: { stockItemId: input.stockItemId },
    });
    return this.getTransfer(context, transferId);
  }

  async dispatchTransfer(context: TenantContext, transferId: string, rawInput: DispatchInventoryTransferInput) {
    const input = DispatchInventoryTransferInputSchema.parse(rawInput);
    await this.transitionTransfer(context, transferId, input, "dispatched");
    return this.getTransfer(context, transferId);
  }

  async receiveTransfer(context: TenantContext, transferId: string, rawInput: ReceiveInventoryTransferInput) {
    const input = ReceiveInventoryTransferInputSchema.parse(rawInput);
    await this.transitionTransfer(context, transferId, input, "received");
    return this.getTransfer(context, transferId);
  }

  async cancelTransfer(context: TenantContext, transferId: string, rawInput: CancelInventoryTransferInput) {
    const input = CancelInventoryTransferInputSchema.parse(rawInput);
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `inventory-transfer:${context.tenantId}:${transferId}`);
      const transfer = await requireTransfer(tx, transferId);
      if (await hasTransferEvent(tx, transferId, input.idempotencyKey)) return;
      if (transfer.version !== input.expectedVersion) throw new ConflictException("Inventory transfer version changed");
      if (transfer.status !== "draft") throw new ConflictException("Only draft transfers can be cancelled");
      await tx.insert(inventoryTransferEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        transferId,
        sequence: transfer.version + 1,
        action: "cancelled",
        fromStatus: transfer.status,
        toStatus: "cancelled",
        reasonCode: input.reasonCode,
        idempotencyKey: input.idempotencyKey,
        actorUserId: context.userId,
        occurredAt: new Date(input.occurredAt),
      });
      await tx.update(inventoryTransfers).set({
        status: "cancelled",
        version: transfer.version + 1,
        updatedAt: new Date(),
      }).where(eq(inventoryTransfers.id, transferId));
    });
    await this.audit.record(context, {
      action: "inventory.transfer.cancel",
      resourceType: "inventory_transfer",
      resourceId: transferId,
      result: "success",
      metadata: {},
    });
    return this.getTransfer(context, transferId);
  }

  listTransfers(context: TenantContext) {
    return withTenant(this.database.db, context, (tx) =>
      tx.select().from(inventoryTransfers).orderBy(desc(inventoryTransfers.updatedAt)).limit(250));
  }

  async getTransfer(context: TenantContext, transferId: string) {
    return withTenant(this.database.db, context, async (tx) => {
      const [transfer] = await tx.select().from(inventoryTransfers)
        .where(eq(inventoryTransfers.id, transferId)).limit(1);
      if (!transfer) throw new NotFoundException("Inventory transfer not found");
      const events = await tx.select().from(inventoryTransferEvents)
        .where(eq(inventoryTransferEvents.transferId, transferId))
        .orderBy(asc(inventoryTransferEvents.sequence));
      return { transfer, events };
    });
  }

  async listBalances(context: TenantContext) {
    const rows = await withTenant(this.database.db, context, (tx) =>
      tx.select().from(inventoryBalances).orderBy(asc(inventoryBalances.stockItemId), asc(inventoryBalances.locationId)));
    return rows.map(toBalanceView);
  }

  async workspace(context: TenantContext) {
    return withTenant(this.database.db, context, async (tx) => {
      const [
        warehouses,
        locations,
        stockItems,
        lots,
        balanceRows,
        reservations,
        transfers,
        movements,
      ] = await Promise.all([
        tx.select().from(inventoryWarehouses).orderBy(asc(inventoryWarehouses.name)),
        tx.select().from(inventoryLocations).orderBy(asc(inventoryLocations.name)),
        tx.select().from(inventoryStockItems).orderBy(asc(inventoryStockItems.name)),
        tx.select().from(inventoryLots).orderBy(desc(inventoryLots.createdAt)).limit(250),
        tx.select().from(inventoryBalances).orderBy(asc(inventoryBalances.stockItemId), asc(inventoryBalances.locationId)),
        tx.select().from(inventoryReservations).orderBy(desc(inventoryReservations.createdAt)).limit(100),
        tx.select().from(inventoryTransfers).orderBy(desc(inventoryTransfers.updatedAt)).limit(100),
        tx.select().from(inventoryMovements).orderBy(desc(inventoryMovements.occurredAt)).limit(100),
      ]);
      return {
        warehouses: warehouses.map((warehouse) => ({
          id: warehouse.id,
          code: warehouse.code,
          name: warehouse.name,
          type: warehouse.type,
          countryCode: warehouse.countryCode,
          timeZone: warehouse.timeZone,
          status: warehouse.status,
        })),
        locations: locations.map((location) => ({
          id: location.id,
          warehouseId: location.warehouseId,
          code: location.code,
          name: location.name,
          status: location.status,
        })),
        stockItems: stockItems.map((stockItem) => ({
          id: stockItem.id,
          skuId: stockItem.skuId,
          code: stockItem.code,
          name: stockItem.name,
          baseUnit: stockItem.baseUnit,
          status: stockItem.status,
        })),
        lots: lots.map((lot) => ({
          id: lot.id,
          stockItemId: lot.stockItemId,
          code: lot.code,
          sourceType: lot.sourceType,
          sourceId: lot.sourceId,
          unitCostMinor: lot.unitCostMinor,
          unitCostCurrency: lot.unitCostCurrency,
          receivedAt: lot.receivedAt?.toISOString() ?? null,
          expiresAt: lot.expiresAt?.toISOString() ?? null,
          createdAt: lot.createdAt.toISOString(),
        })),
        balances: balanceRows.map(toBalanceView),
        reservations: reservations.map((reservation) => ({
          id: reservation.id,
          stockItemId: reservation.stockItemId,
          locationId: reservation.locationId,
          lotId: reservation.lotId,
          quantity: reservation.quantity,
          unit: reservation.unit,
          sourceType: reservation.sourceType,
          sourceId: reservation.sourceId,
          status: reservation.status,
          version: reservation.version,
          expiresAt: reservation.expiresAt?.toISOString() ?? null,
          createdAt: reservation.createdAt.toISOString(),
          updatedAt: reservation.updatedAt.toISOString(),
        })),
        transfers: transfers.map((transfer) => ({
          id: transfer.id,
          stockItemId: transfer.stockItemId,
          lotId: transfer.lotId,
          sourceLocationId: transfer.sourceLocationId,
          destinationLocationId: transfer.destinationLocationId,
          quantity: transfer.quantity,
          unit: transfer.unit,
          status: transfer.status,
          version: transfer.version,
          createdAt: transfer.createdAt.toISOString(),
          updatedAt: transfer.updatedAt.toISOString(),
        })),
        movements: movements.map((movement) => ({
          id: movement.id,
          stockItemId: movement.stockItemId,
          locationId: movement.locationId,
          lotId: movement.lotId,
          bucket: movement.bucket,
          type: movement.type,
          quantityDelta: movement.quantityDelta,
          unit: movement.unit,
          sourceType: movement.sourceType,
          sourceId: movement.sourceId,
          reasonCode: movement.reasonCode,
          occurredAt: movement.occurredAt.toISOString(),
          recordedAt: movement.recordedAt.toISOString(),
        })),
      };
    });
  }

  async rebuildProjection(context: TenantContext, rawInput: RebuildInventoryProjectionInput) {
    const input = RebuildInventoryProjectionInputSchema.parse(rawInput);
    const rebuild = await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `inventory-projection-rebuild:${context.tenantId}`);
      const [replayed] = await tx.select().from(inventoryProjectionRebuilds)
        .where(eq(inventoryProjectionRebuilds.idempotencyKey, input.idempotencyKey)).limit(1);
      if (replayed) return replayed;
      const [movements, reservations] = await Promise.all([
        tx.select().from(inventoryMovements).orderBy(asc(inventoryMovements.recordedAt), asc(inventoryMovements.id)),
        tx.select().from(inventoryReservations).where(eq(inventoryReservations.status, "active")),
      ]);
      const projections = buildProjection(movements, reservations);
      await tx.delete(inventoryBalances);
      if (projections.length) {
        await tx.insert(inventoryBalances).values(projections.map((projection) => ({
          id: createEntityId(),
          tenantId: context.tenantId,
          ...projection,
        })));
      }
      const aggregateChecksum = checksum(JSON.stringify(projections));
      const [created] = await tx.insert(inventoryProjectionRebuilds).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        idempotencyKey: input.idempotencyKey,
        balanceCount: projections.length,
        aggregateChecksum,
        initiatedBy: context.userId,
      }).returning();
      return created!;
    });
    await this.audit.record(context, {
      action: "inventory.projection.rebuild",
      resourceType: "inventory_projection",
      resourceId: rebuild.id,
      result: "success",
      metadata: { balanceCount: rebuild.balanceCount, aggregateChecksum: rebuild.aggregateChecksum },
    });
    return { rebuild, balances: await this.listBalances(context) };
  }

  private async transitionTransfer(
    context: TenantContext,
    transferId: string,
    input: DispatchInventoryTransferInput | ReceiveInventoryTransferInput,
    action: "dispatched" | "received",
  ) {
    await withTenant(this.database.db, context, async (tx) => {
      await lock(tx, `inventory-transfer:${context.tenantId}:${transferId}`);
      const transfer = await requireTransfer(tx, transferId);
      if (await hasTransferEvent(tx, transferId, input.idempotencyKey)) return;
      if (transfer.version !== input.expectedVersion) throw new ConflictException("Inventory transfer version changed");
      const expectedStatus = action === "dispatched" ? "draft" : "in_transit";
      if (transfer.status !== expectedStatus) throw new ConflictException(`Only ${expectedStatus} transfers can be ${action}`);
      const sourceKey = dimensionKey(transfer.stockItemId, transfer.sourceLocationId, transfer.lotId);
      const destinationKey = dimensionKey(transfer.stockItemId, transfer.destinationLocationId, transfer.lotId);
      for (const key of [sourceKey, destinationKey].sort()) {
        await lock(tx, `inventory-dimension:${context.tenantId}:${key}`);
      }
      const occurredAt = new Date(input.occurredAt);
      const movementBase = {
        stockItemId: transfer.stockItemId,
        lotId: transfer.lotId,
        unit: transfer.unit as InventoryUnit,
        sourceType: "transfer" as const,
        sourceId: transfer.id,
        occurredAt: occurredAt.toISOString(),
      };
      const debitInput: RecordInventoryMovementInput = action === "dispatched"
        ? {
            ...movementBase,
            locationId: transfer.sourceLocationId,
            bucket: "physical",
            type: "transfer_outbound",
            quantityDelta: -transfer.quantity,
            reasonCode: "TRANSFER_DISPATCH",
            idempotencyKey: childKey(input.idempotencyKey, "source-debit"),
          }
        : {
            ...movementBase,
            locationId: transfer.destinationLocationId,
            bucket: "in_transit",
            type: "transfer_inbound",
            quantityDelta: -transfer.quantity,
            reasonCode: "TRANSFER_RECEIPT",
            idempotencyKey: childKey(input.idempotencyKey, "transit-debit"),
          };
      const creditInput: RecordInventoryMovementInput = action === "dispatched"
        ? {
            ...movementBase,
            locationId: transfer.destinationLocationId,
            bucket: "in_transit",
            type: "transfer_outbound",
            quantityDelta: transfer.quantity,
            reasonCode: "TRANSFER_DISPATCH",
            idempotencyKey: childKey(input.idempotencyKey, "transit-credit"),
          }
        : {
            ...movementBase,
            locationId: transfer.destinationLocationId,
            bucket: "physical",
            type: "transfer_inbound",
            quantityDelta: transfer.quantity,
            reasonCode: "TRANSFER_RECEIPT",
            idempotencyKey: childKey(input.idempotencyKey, "destination-credit"),
          };
      const debit = await applyMovement(tx, context, debitInput);
      const credit = await applyMovement(tx, context, creditInput);
      const toStatus = action === "dispatched" ? "in_transit" : "received";
      await tx.insert(inventoryTransferEvents).values({
        id: createEntityId(),
        tenantId: context.tenantId,
        transferId,
        sequence: transfer.version + 1,
        action,
        fromStatus: transfer.status,
        toStatus,
        reasonCode: action === "dispatched" ? "TRANSFER_DISPATCHED" : "TRANSFER_RECEIVED",
        debitMovementId: debit.movement.id,
        creditMovementId: credit.movement.id,
        idempotencyKey: input.idempotencyKey,
        actorUserId: context.userId,
        occurredAt,
      });
      await tx.update(inventoryTransfers).set({
        status: toStatus,
        version: transfer.version + 1,
        updatedAt: new Date(),
      }).where(eq(inventoryTransfers.id, transferId));
    });
    await this.audit.record(context, {
      action: `inventory.transfer.${action}`,
      resourceType: "inventory_transfer",
      resourceId: transferId,
      result: "success",
      metadata: {},
    });
  }
}

async function applyMovement(
  tx: TenantTransaction,
  context: TenantContext,
  input: RecordInventoryMovementInput,
) {
  const key = dimensionKey(input.stockItemId, input.locationId, input.lotId);
  await lock(tx, `inventory-dimension:${context.tenantId}:${key}`);
  await requireDimension(tx, input.stockItemId, input.locationId, input.lotId, input.unit);
  const current = await findBalance(tx, key);
  const next = nextBalance(current, input.bucket, input.quantityDelta);
  if (next.physicalQuantity < next.reservedQuantity) throw new ConflictException("Movement would make available stock negative");
  if (
    next.physicalQuantity < 0
    || next.inTransitQuantity < 0
    || next.providerQuantity < 0
    || next.virtualQuantity < 0
  ) {
    throw new ConflictException("Movement would make an inventory bucket negative");
  }
  const [movement] = await tx.insert(inventoryMovements).values({
    id: createEntityId(),
    tenantId: context.tenantId,
    ...input,
    occurredAt: new Date(input.occurredAt),
    recordedBy: context.userId,
  }).returning();
  let balance: BalanceRow;
  if (current) {
    const [updated] = await tx.update(inventoryBalances).set({
      ...next,
      projectionVersion: current.projectionVersion + 1,
      updatedAt: new Date(),
    }).where(eq(inventoryBalances.id, current.id)).returning();
    balance = updated!;
  } else {
    const [created] = await tx.insert(inventoryBalances).values({
      id: createEntityId(),
      tenantId: context.tenantId,
      dimensionKey: key,
      stockItemId: input.stockItemId,
      locationId: input.locationId,
      lotId: input.lotId,
      unit: input.unit,
      ...next,
    }).returning();
    balance = created!;
  }
  return { movement: movement!, balance };
}

function nextBalance(current: BalanceRow | undefined, bucket: InventoryBucket, quantityDelta: number) {
  const next = {
    physicalQuantity: current?.physicalQuantity ?? 0,
    reservedQuantity: current?.reservedQuantity ?? 0,
    inTransitQuantity: current?.inTransitQuantity ?? 0,
    providerQuantity: current?.providerQuantity ?? 0,
    virtualQuantity: current?.virtualQuantity ?? 0,
  };
  const column = bucketColumn(bucket);
  next[column] += quantityDelta;
  return next;
}

function buildProjection(
  movements: MovementRow[],
  reservations: Array<typeof inventoryReservations.$inferSelect>,
) {
  const values = new Map<string, {
    dimensionKey: string;
    stockItemId: string;
    locationId: string;
    lotId: string | null;
    unit: string;
    physicalQuantity: number;
    reservedQuantity: number;
    inTransitQuantity: number;
    providerQuantity: number;
    virtualQuantity: number;
  }>();
  for (const movement of movements) {
    const key = dimensionKey(movement.stockItemId, movement.locationId, movement.lotId);
    const value = values.get(key) ?? emptyProjection(key, movement.stockItemId, movement.locationId, movement.lotId, movement.unit);
    value[bucketColumn(movement.bucket as InventoryBucket)] += movement.quantityDelta;
    values.set(key, value);
  }
  for (const reservation of reservations) {
    const key = dimensionKey(reservation.stockItemId, reservation.locationId, reservation.lotId);
    const value = values.get(key) ?? emptyProjection(key, reservation.stockItemId, reservation.locationId, reservation.lotId, reservation.unit);
    value.reservedQuantity += reservation.quantity;
    values.set(key, value);
  }
  const result = [...values.values()].sort((a, b) => a.dimensionKey.localeCompare(b.dimensionKey));
  for (const value of result) {
    if (
      value.physicalQuantity < value.reservedQuantity
      || value.physicalQuantity < 0
      || value.reservedQuantity < 0
      || value.inTransitQuantity < 0
      || value.providerQuantity < 0
      || value.virtualQuantity < 0
    ) {
      throw new ConflictException("Inventory evidence cannot produce a valid projection");
    }
  }
  return result;
}

function emptyProjection(dimension: string, stockItemId: string, locationId: string, lotId: string | null, unit: string) {
  return {
    dimensionKey: dimension,
    stockItemId,
    locationId,
    lotId,
    unit,
    physicalQuantity: 0,
    reservedQuantity: 0,
    inTransitQuantity: 0,
    providerQuantity: 0,
    virtualQuantity: 0,
  };
}

function toBalanceView(row: BalanceRow) {
  return {
    stockItemId: row.stockItemId,
    locationId: row.locationId,
    lotId: row.lotId,
    unit: row.unit,
    physicalQuantity: row.physicalQuantity,
    reservedQuantity: row.reservedQuantity,
    availableQuantity: row.physicalQuantity - row.reservedQuantity,
    inTransitQuantity: row.inTransitQuantity,
    providerQuantity: row.providerQuantity,
    virtualQuantity: row.virtualQuantity,
    projectionVersion: row.projectionVersion,
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function requireDimension(
  tx: TenantTransaction,
  stockItemId: string,
  locationId: string,
  lotId: string | null,
  unit: string,
) {
  const stockItem = await requireStockItem(tx, stockItemId);
  if (stockItem.baseUnit !== unit) throw new ConflictException("Inventory unit does not match stock item base unit");
  const [location] = await tx.select().from(inventoryLocations).where(eq(inventoryLocations.id, locationId)).limit(1);
  if (!location) throw new NotFoundException("Inventory location not found");
  if (location.status !== "active") throw new ConflictException("Inventory location is inactive");
  if (lotId) {
    const [lot] = await tx.select({ id: inventoryLots.id }).from(inventoryLots)
      .where(and(eq(inventoryLots.id, lotId), eq(inventoryLots.stockItemId, stockItemId))).limit(1);
    if (!lot) throw new NotFoundException("Inventory lot not found");
  }
}

async function requireWarehouse(tx: TenantTransaction, warehouseId: string) {
  const [warehouse] = await tx.select().from(inventoryWarehouses).where(eq(inventoryWarehouses.id, warehouseId)).limit(1);
  if (!warehouse) throw new NotFoundException("Inventory warehouse not found");
  if (warehouse.status !== "active") throw new ConflictException("Inventory warehouse is inactive");
  return warehouse;
}

async function requireStockItem(tx: TenantTransaction, stockItemId: string) {
  const [stockItem] = await tx.select().from(inventoryStockItems).where(eq(inventoryStockItems.id, stockItemId)).limit(1);
  if (!stockItem) throw new NotFoundException("Inventory stock item not found");
  if (stockItem.status !== "active") throw new ConflictException("Inventory stock item is inactive");
  return stockItem;
}

async function requireTransfer(tx: TenantTransaction, transferId: string) {
  const [transfer] = await tx.select().from(inventoryTransfers).where(eq(inventoryTransfers.id, transferId)).limit(1);
  if (!transfer) throw new NotFoundException("Inventory transfer not found");
  return transfer;
}

async function findBalance(tx: TenantTransaction, key: string) {
  const [balance] = await tx.select().from(inventoryBalances).where(eq(inventoryBalances.dimensionKey, key)).limit(1);
  return balance;
}

async function requireBalance(tx: TenantTransaction, key: string) {
  const balance = await findBalance(tx, key);
  if (!balance) throw new ConflictException("Inventory balance does not exist for this dimension");
  return balance;
}

async function hasTransferEvent(tx: TenantTransaction, transferId: string, idempotencyKey: string) {
  const [event] = await tx.select({ id: inventoryTransferEvents.id }).from(inventoryTransferEvents)
    .where(and(
      eq(inventoryTransferEvents.transferId, transferId),
      eq(inventoryTransferEvents.idempotencyKey, idempotencyKey),
    )).limit(1);
  return Boolean(event);
}

function assertMovementReplay(row: MovementRow, input: RecordInventoryMovementInput) {
  if (
    row.stockItemId !== input.stockItemId
    || row.locationId !== input.locationId
    || row.lotId !== input.lotId
    || row.bucket !== input.bucket
    || row.type !== input.type
    || row.quantityDelta !== input.quantityDelta
    || row.unit !== input.unit
    || row.sourceType !== input.sourceType
    || row.sourceId !== input.sourceId
    || row.reasonCode !== input.reasonCode
    || row.occurredAt.toISOString() !== input.occurredAt
  ) {
    throw new ConflictException("Inventory movement idempotency key was reused with different input");
  }
}

function assertReservationReplay(
  row: typeof inventoryReservations.$inferSelect,
  input: CreateInventoryReservationInput,
) {
  if (
    row.stockItemId !== input.stockItemId
    || row.locationId !== input.locationId
    || row.lotId !== input.lotId
    || row.quantity !== input.quantity
    || row.unit !== input.unit
    || row.sourceType !== input.sourceType
    || row.sourceId !== input.sourceId
  ) {
    throw new ConflictException("Inventory reservation idempotency key was reused with different input");
  }
}

function assertTransferReplay(
  row: typeof inventoryTransfers.$inferSelect,
  input: CreateInventoryTransferInput,
) {
  if (
    row.stockItemId !== input.stockItemId
    || row.lotId !== input.lotId
    || row.sourceLocationId !== input.sourceLocationId
    || row.destinationLocationId !== input.destinationLocationId
    || row.quantity !== input.quantity
    || row.unit !== input.unit
  ) {
    throw new ConflictException("Inventory transfer idempotency key was reused with different input");
  }
}

function bucketColumn(bucket: InventoryBucket) {
  return {
    physical: "physicalQuantity",
    in_transit: "inTransitQuantity",
    provider: "providerQuantity",
    virtual: "virtualQuantity",
  }[bucket] as "physicalQuantity" | "inTransitQuantity" | "providerQuantity" | "virtualQuantity";
}

function dimensionKey(stockItemId: string, locationId: string, lotId: string | null) {
  return `${stockItemId}:${locationId}:${lotId ?? "-"}`;
}

function childKey(parent: string, label: string) {
  return `inventory:${checksum(`${parent}:${label}`)}`;
}

function checksum(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function lock(tx: TenantTransaction, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
