import { ConflictException, NotFoundException } from "@nestjs/common";
import { createEntityId, type TenantContext } from "@yummyai/contracts";
import {
  connectDatabase,
  inventoryBalances,
  inventoryLots,
  inventoryMovements,
  inventoryProjectionRebuilds,
  inventoryReservationEvents,
  inventoryTransferEvents,
  migrateDatabase,
  withTenant,
} from "@yummyai/database";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuditService } from "../audit/audit.service.js";
import { InventoryService } from "./inventory.service.js";

describe.sequential("inventory kernel", () => {
  const database = connectDatabase();
  const tenantA = createEntityId();
  const tenantB = createEntityId();
  const userA = createEntityId();
  const userB = createEntityId();
  const contextA = tenantContext(tenantA, userA);
  const contextB = tenantContext(tenantB, userB);
  const occurredAt = "2026-07-23T02:00:00.000Z";
  const service = new InventoryService(database, new AuditService(database));

  let warehouseId: string;
  let sourceLocationId: string;
  let destinationLocationId: string;
  let stockItemId: string;
  let lotId: string;

  beforeAll(async () => {
    await migrateDatabase(database);
    await database.client.unsafe(
      `insert into organizations (id, name, slug) values ($1,$2,$3),($4,$5,$6)`,
      [
        tenantA,
        "Inventory Tenant A",
        `inventory-a-${tenantA}`,
        tenantB,
        "Inventory Tenant B",
        `inventory-b-${tenantB}`,
      ],
    );
    await database.client.unsafe(
      `insert into app_users (id, oidc_subject, email, display_name) values ($1,$2,$3,$4),($5,$6,$7,$8)`,
      [
        userA,
        `inventory-user-a-${userA}`,
        `a-${userA}@example.test`,
        "Inventory A",
        userB,
        `inventory-user-b-${userB}`,
        `b-${userB}@example.test`,
        "Inventory B",
      ],
    );

    const warehouse = await service.createWarehouse(contextA, {
      code: "MAIN",
      name: "Main warehouse",
      type: "owned",
      countryCode: "US",
      timeZone: "America/Los_Angeles",
    });
    warehouseId = warehouse.id;
    sourceLocationId = (await service.createLocation(contextA, {
      warehouseId,
      code: "PICK-A",
      name: "Pick face A",
    })).id;
    destinationLocationId = (await service.createLocation(contextA, {
      warehouseId,
      code: "PICK-B",
      name: "Pick face B",
    })).id;
    stockItemId = (await service.createStockItem(contextA, {
      skuId: null,
      code: "BLANK-PILLOW",
      name: "Blank pillow cover",
      baseUnit: "each",
    })).id;
    lotId = (await service.createLot(contextA, {
      stockItemId,
      code: "LOT-20260723",
      sourceType: "opening",
      sourceId: "opening-20260723",
      unitCostMinor: 450,
      unitCostCurrency: "USD",
      receivedAt: occurredAt,
      expiresAt: null,
    })).id;
  });

  afterAll(async () => {
    await database.client.end();
  });

  it("records opening stock once and rejects changed idempotent input", async () => {
    const input = movementInput({
      quantityDelta: 10,
      idempotencyKey: "inventory-opening-0001",
    });
    const first = await service.recordMovement(contextA, input);
    const replay = await service.recordMovement(contextA, input);

    expect(replay.movement.id).toBe(first.movement.id);
    expect(replay.balance).toMatchObject({
      physicalQuantity: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
    });
    const rows = await withTenant(database.db, contextA, (tx) =>
      tx.select().from(inventoryMovements)
        .where(eq(inventoryMovements.idempotencyKey, input.idempotencyKey)),
    );
    expect(rows).toHaveLength(1);
    await expect(service.recordMovement(contextA, {
      ...input,
      quantityDelta: 9,
    })).rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects unit mismatches and movements that would consume reserved stock", async () => {
    await expect(service.recordMovement(contextA, {
      ...movementInput({
        quantityDelta: 1,
        idempotencyKey: "inventory-unit-mismatch-0001",
      }),
      unit: "pair",
    })).rejects.toBeInstanceOf(ConflictException);

    const reservation = await service.createReservation(contextA, reservationInput({
      quantity: 2,
      idempotencyKey: "inventory-protection-reservation-0001",
    }));
    await expect(service.recordMovement(contextA, {
      ...movementInput({
        quantityDelta: -9,
        idempotencyKey: "inventory-negative-availability-0001",
      }),
      type: "adjustment",
      sourceType: "adjustment",
      sourceId: "adjustment-negative-availability",
      reasonCode: "STOCKTAKE",
    })).rejects.toBeInstanceOf(ConflictException);
    await service.releaseReservation(contextA, reservation.reservation.id, {
      expectedVersion: 1,
      outcome: "released",
      reasonCode: "TEST_RELEASE",
      idempotencyKey: "inventory-protection-release-0001",
    });
  });

  it("serializes concurrent reservations and never oversells available stock", async () => {
    const attempts = Array.from({ length: 12 }, (_, index) =>
      service.createReservation(contextA, reservationInput({
        quantity: 1,
        idempotencyKey: `inventory-concurrent-${String(index).padStart(4, "0")}`,
        sourceId: `concurrent-order-${index}`,
      })),
    );
    const results = await Promise.allSettled(attempts);
    const successes = results.filter((result) => result.status === "fulfilled");
    const failures = results.filter((result) => result.status === "rejected");

    expect(successes).toHaveLength(10);
    expect(failures).toHaveLength(2);
    expect(failures.every((result) =>
      result.status === "rejected" && result.reason instanceof ConflictException,
    )).toBe(true);
    expect(await service.listBalances(contextA)).toEqual([
      expect.objectContaining({
        stockItemId,
        locationId: sourceLocationId,
        lotId,
        physicalQuantity: 10,
        reservedQuantity: 10,
        availableQuantity: 0,
      }),
    ]);

    const first = successes[0];
    if (!first || first.status !== "fulfilled") throw new Error("Expected one reservation");
    const reservationId = first.value.reservation.id;
    const release = {
      expectedVersion: 1,
      outcome: "released" as const,
      reasonCode: "ORDER_CANCELLED",
      idempotencyKey: "inventory-concurrent-release-0001",
    };
    const released = await service.releaseReservation(contextA, reservationId, release);
    const replay = await service.releaseReservation(contextA, reservationId, release);
    expect(replay.reservation).toMatchObject({ id: reservationId, status: "released", version: 2 });
    expect(released.events).toHaveLength(2);
    expect(replay.events).toHaveLength(2);
    expect((await service.listBalances(contextA))[0]).toMatchObject({
      reservedQuantity: 9,
      availableQuantity: 1,
    });
  });

  it("dispatches and receives a transfer with paired immutable movements", async () => {
    const transfer = await service.createTransfer(contextA, {
      stockItemId,
      lotId,
      sourceLocationId,
      destinationLocationId,
      quantity: 1,
      unit: "each",
      idempotencyKey: "inventory-transfer-0001",
    });
    const dispatchInput = {
      expectedVersion: 1,
      occurredAt: "2026-07-23T03:00:00.000Z",
      idempotencyKey: "inventory-transfer-dispatch-0001",
    };
    const dispatched = await service.dispatchTransfer(contextA, transfer.transfer.id, dispatchInput);
    const dispatchReplay = await service.dispatchTransfer(contextA, transfer.transfer.id, dispatchInput);
    expect(dispatched.transfer).toMatchObject({ status: "in_transit", version: 2 });
    expect(dispatchReplay.events).toHaveLength(2);
    expect(dispatchReplay.events[1]).toMatchObject({
      action: "dispatched",
      fromStatus: "draft",
      toStatus: "in_transit",
    });
    expect(dispatchReplay.events[1]!.debitMovementId).toBeTruthy();
    expect(dispatchReplay.events[1]!.creditMovementId).toBeTruthy();

    const afterDispatch = await service.listBalances(contextA);
    expect(findBalance(afterDispatch, sourceLocationId)).toMatchObject({
      physicalQuantity: 9,
      reservedQuantity: 9,
      availableQuantity: 0,
    });
    expect(findBalance(afterDispatch, destinationLocationId)).toMatchObject({
      physicalQuantity: 0,
      inTransitQuantity: 1,
    });

    const received = await service.receiveTransfer(contextA, transfer.transfer.id, {
      expectedVersion: 2,
      occurredAt: "2026-07-23T04:00:00.000Z",
      idempotencyKey: "inventory-transfer-receive-0001",
    });
    expect(received.transfer).toMatchObject({ status: "received", version: 3 });
    expect(received.events).toHaveLength(3);
    expect(received.events[2]).toMatchObject({
      action: "received",
      fromStatus: "in_transit",
      toStatus: "received",
    });
    expect(findBalance(await service.listBalances(contextA), destinationLocationId)).toMatchObject({
      physicalQuantity: 1,
      inTransitQuantity: 0,
      availableQuantity: 1,
    });

    const transferMovements = await withTenant(database.db, contextA, (tx) =>
      tx.select().from(inventoryMovements)
        .where(and(
          eq(inventoryMovements.sourceType, "transfer"),
          eq(inventoryMovements.sourceId, transfer.transfer.id),
        )),
    );
    expect(transferMovements).toHaveLength(4);
  });

  it("cancels a draft transfer without recording stock movements", async () => {
    const transfer = await service.createTransfer(contextA, {
      stockItemId,
      lotId,
      sourceLocationId,
      destinationLocationId,
      quantity: 1,
      unit: "each",
      idempotencyKey: "inventory-transfer-cancel-0001",
    });
    const cancelled = await service.cancelTransfer(contextA, transfer.transfer.id, {
      expectedVersion: 1,
      reasonCode: "PLAN_CHANGED",
      occurredAt: "2026-07-23T05:00:00.000Z",
      idempotencyKey: "inventory-transfer-cancel-event-0001",
    });
    expect(cancelled.transfer).toMatchObject({ status: "cancelled", version: 2 });
    expect(cancelled.events).toHaveLength(2);
    const movements = await withTenant(database.db, contextA, (tx) =>
      tx.select().from(inventoryMovements)
        .where(eq(inventoryMovements.sourceId, transfer.transfer.id)),
    );
    expect(movements).toHaveLength(0);
  });

  it("keeps ledger, lots, and lifecycle events append-only for the application role", async () => {
    const movement = (await service.listMovements(contextA))[0]!;
    const reservation = (await service.listReservations(contextA))[0]!;
    const transfer = (await service.listTransfers(contextA))[0]!;

    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(inventoryMovements).set({ reasonCode: "TAMPERED" })
        .where(eq(inventoryMovements.id, movement.id)),
    )).rejects.toThrow();
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(inventoryLots).set({ sourceId: "tampered" })
        .where(eq(inventoryLots.id, lotId)),
    )).rejects.toThrow();
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(inventoryReservationEvents).set({ reasonCode: "TAMPERED" })
        .where(eq(inventoryReservationEvents.reservationId, reservation.id)),
    )).rejects.toThrow();
    await expect(withTenant(database.db, contextA, (tx) =>
      tx.update(inventoryTransferEvents).set({ reasonCode: "TAMPERED" })
        .where(eq(inventoryTransferEvents.transferId, transfer.id)),
    )).rejects.toThrow();
  });

  it("isolates inventory data and foreign identifiers across tenants", async () => {
    await expect(service.listWarehouses(contextB)).resolves.toHaveLength(0);
    await expect(service.listBalances(contextB)).resolves.toHaveLength(0);
    await expect(service.createLocation(contextB, {
      warehouseId,
      code: "FOREIGN",
      name: "Foreign location",
    })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.recordMovement(contextB, movementInput({
      quantityDelta: 1,
      idempotencyKey: "inventory-cross-tenant-0001",
    }))).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rebuilds a corrupted projection from immutable evidence exactly once", async () => {
    const expected = await service.listBalances(contextA);
    await withTenant(database.db, contextA, (tx) =>
      tx.update(inventoryBalances).set({
        physicalQuantity: 99,
        projectionVersion: 77,
      }).where(and(
        eq(inventoryBalances.stockItemId, stockItemId),
        eq(inventoryBalances.locationId, destinationLocationId),
      )),
    );
    expect(findBalance(await service.listBalances(contextA), destinationLocationId))
      .toMatchObject({ physicalQuantity: 99 });

    const input = { idempotencyKey: "inventory-rebuild-0001" };
    const rebuilt = await service.rebuildProjection(contextA, input);
    const replay = await service.rebuildProjection(contextA, input);
    expect(normalizeBalances(rebuilt.balances)).toEqual(normalizeBalances(expected));
    expect(normalizeBalances(replay.balances)).toEqual(normalizeBalances(expected));
    expect(replay.rebuild.id).toBe(rebuilt.rebuild.id);
    const evidence = await withTenant(database.db, contextA, (tx) =>
      tx.select().from(inventoryProjectionRebuilds)
        .where(eq(inventoryProjectionRebuilds.idempotencyKey, input.idempotencyKey)),
    );
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      balanceCount: expected.length,
      aggregateChecksum: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  function movementInput({
    quantityDelta,
    idempotencyKey,
  }: {
    quantityDelta: number;
    idempotencyKey: string;
  }) {
    return {
      stockItemId,
      locationId: sourceLocationId,
      lotId,
      bucket: "physical" as const,
      type: "opening" as const,
      quantityDelta,
      unit: "each" as const,
      sourceType: "opening" as const,
      sourceId: "opening-20260723",
      reasonCode: "OPENING_BALANCE",
      occurredAt,
      idempotencyKey,
    };
  }

  function reservationInput({
    quantity,
    idempotencyKey,
    sourceId = "test-order",
  }: {
    quantity: number;
    idempotencyKey: string;
    sourceId?: string;
  }) {
    return {
      stockItemId,
      locationId: sourceLocationId,
      lotId,
      quantity,
      unit: "each" as const,
      sourceType: "order" as const,
      sourceId,
      expiresAt: null,
      idempotencyKey,
    };
  }
});

function tenantContext(tenantId: string, userId: string): TenantContext {
  return {
    tenantId,
    userId,
    permissions: ["inventory:read", "inventory:write"],
    dataScope: "tenant",
  };
}

function findBalance<T extends { locationId: string }>(balances: T[], locationId: string) {
  return balances.find((balance) => balance.locationId === locationId);
}

function normalizeBalances<T extends {
  stockItemId: string;
  locationId: string;
  lotId: string | null;
  unit: string;
  physicalQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  inTransitQuantity: number;
  providerQuantity: number;
  virtualQuantity: number;
}>(balances: T[]) {
  return balances.map((balance) => ({
    stockItemId: balance.stockItemId,
    locationId: balance.locationId,
    lotId: balance.lotId,
    unit: balance.unit,
    physicalQuantity: balance.physicalQuantity,
    reservedQuantity: balance.reservedQuantity,
    availableQuantity: balance.availableQuantity,
    inTransitQuantity: balance.inTransitQuantity,
    providerQuantity: balance.providerQuantity,
    virtualQuantity: balance.virtualQuantity,
  })).sort((left, right) => left.locationId.localeCompare(right.locationId));
}
