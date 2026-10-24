import { stockQuantityString, sumStockQuantities, type StockQuantity } from "@yummyai/contracts/inventory/quantity";
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
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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

  it("edits master metadata through tenant scope without changing identifiers or units", async () => {
    const warehouse = await service.createWarehouse(contextA, { code: "EDIT-WH", name: "Before", type: "owned", countryCode: "CN", timeZone: "Asia/Shanghai" });
    const location = await service.createLocation(contextA, { warehouseId: warehouse.id, code: "EDIT-LOC", name: "Before" });
    const item = await service.createStockItem(contextA, { code: "EDIT-MAT", name: "Before", skuId: null, baseUnit: "each" });
    await expect(service.updateWarehouse(contextB, warehouse.id, { name: "Wrong tenant", countryCode: "US", timeZone: "UTC" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateLocation(contextB, location.id, { name: "Wrong tenant" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateStockItem(contextB, item.id, { name: "Wrong tenant" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateWarehouse(contextA, warehouse.id, { name: "Updated warehouse", countryCode: "US", timeZone: "America/New_York" })).resolves.toMatchObject({ id: warehouse.id, code: "EDIT-WH", name: "Updated warehouse" });
    await expect(service.updateLocation(contextA, location.id, { name: "Updated location" })).resolves.toMatchObject({ id: location.id, warehouseId: warehouse.id, code: "EDIT-LOC" });
    await expect(service.updateStockItem(contextA, item.id, { name: "Updated stock" })).resolves.toMatchObject({ id: item.id, code: "EDIT-MAT", baseUnit: "each", name: "Updated stock" });
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

  it.each(["movement", "reservation", "release", "transfer_dispatch", "transfer_receive", "procurement_receipt"] as const)("keeps concurrent %s consistent with a projection rebuild", async kind => {
    const items = await Promise.all(["A", "B"].map(suffix => service.createStockItem(contextA, {
      skuId: null, code: `REBUILD-${kind.toUpperCase()}-${suffix}`, name: `Rebuild ${kind} ${suffix}`, baseUnit: "each",
    })));
    const first = items[0]!, second = items[1]!;
    const movement = (itemId: string, quantityDelta: number) => ({
      ...movementInput({ quantityDelta, idempotencyKey: createEntityId() }), stockItemId: itemId, lotId: null,
    });
    await service.recordMovement(contextA, movement(first.id, 10));
    await service.recordMovement(contextA, movement(second.id, 10));
    const reservation = { ...reservationInput({ quantity: 2, idempotencyKey: createEntityId() }), stockItemId: second.id, lotId: null };
    const existing = kind === "release" ? await service.createReservation(contextA, reservation) : undefined;
    const transfer = kind.startsWith("transfer_") ? await service.createTransfer(contextA, {
      stockItemId: second.id, lotId: null, sourceLocationId, destinationLocationId, quantity: 1, unit: "each", idempotencyKey: createEntityId(),
    }) : undefined;
    if (kind === "transfer_receive") await service.dispatchTransfer(contextA, transfer!.transfer.id, { expectedVersion: 1, occurredAt, idempotencyKey: createEntityId() });
    let otherMovement: (() => Promise<unknown>) | undefined;
    if (kind === "movement") {
      const warehouse = await service.createWarehouse(contextB, { code: "REBUILD-FOREIGN", name: "Foreign warehouse", type: "owned", countryCode: "US", timeZone: "UTC" });
      const location = await service.createLocation(contextB, { warehouseId: warehouse.id, code: "MAIN", name: "Foreign location" });
      const item = await service.createStockItem(contextB, { skuId: null, code: "REBUILD-FOREIGN", name: "Foreign stock", baseUnit: "each" });
      otherMovement = () => service.recordMovement(contextB, { ...movement(item.id, 1), locationId: location.id });
    }
    let unlock!: () => void, ready!: (pid: number) => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const locked = new Promise<number>(resolve => { ready = resolve; });
    const controller = withTenant(database.db, contextA, async tx => {
      await tx.select({ id: inventoryBalances.id }).from(inventoryBalances)
        .where(eq(inventoryBalances.stockItemId, first.id)).for("update");
      const [backend] = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      ready(backend!.pid);
      await release;
    });
    const outstanding: Promise<unknown>[] = [controller];
    try {
      const blockerPid = await Promise.race([locked, controller.then(() => { throw new Error("Controller ended before acquiring its row lock"); })]);
      const rebuild = service.rebuildProjection(contextA, { idempotencyKey: createEntityId() });
      outstanding.push(rebuild);
      let rebuildPid = 0;
      await vi.waitFor(async () => {
        const rows = await database.client<{ pid: number }[]>`
          select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
          and ${blockerPid} = any(pg_blocking_pids(pid)) and query like 'delete from "inventory_balances"%'
        `;
        expect(rows).toHaveLength(1);
        rebuildPid = rows[0]!.pid;
      }, { timeout: 10_000, interval: 10 });
      let writerSettled = false;
      const writer = kind === "movement" ? service.recordMovement(contextA, movement(second.id, 1))
        : kind === "reservation" ? service.createReservation(contextA, reservation)
          : kind === "release" ? service.releaseReservation(contextA, existing!.reservation.id, {
            expectedVersion: existing!.reservation.version, outcome: "released", reasonCode: "REBUILD_ACCEPTANCE", idempotencyKey: createEntityId(),
          }) : kind === "transfer_dispatch" ? service.dispatchTransfer(contextA, transfer!.transfer.id, { expectedVersion: 1, occurredAt, idempotencyKey: createEntityId() })
            : kind === "transfer_receive" ? service.receiveTransfer(contextA, transfer!.transfer.id, { expectedVersion: 2, occurredAt, idempotencyKey: createEntityId() })
              : withTenant(database.db, contextA, tx => service.receiveProcurementStock(tx, contextA, {
                stockItemId: second.id, locationId: sourceLocationId, receiptId: createEntityId(), lotCode: "CONCURRENT-RECEIPT", quantity: 2,
                unit: "each", unitCostMinor: 450, currency: "USD", receivedAt: occurredAt, expiresAt: null, idempotencyKey: createEntityId(),
              }));
      outstanding.push(writer);
      void writer.then(() => { writerSettled = true; }, () => { writerSettled = true; });
      let waitingEvent: string | undefined;
      await vi.waitFor(async () => {
        const waiting = await database.client<{ wait_event: string }[]>`
          select wait_event from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'
          and ${rebuildPid} = any(pg_blocking_pids(pid))
        `;
        waitingEvent = waiting[0]?.wait_event;
        expect(writerSettled || waiting.length > 0).toBe(true);
      }, { timeout: 10_000, interval: 10 });
      if (otherMovement) {
        let otherSettled = false;
        const unrelated = otherMovement();
        outstanding.push(unrelated);
        void unrelated.then(() => { otherSettled = true; }, () => { otherSettled = true; });
        await vi.waitFor(() => expect(otherSettled).toBe(true), { timeout: 10_000, interval: 10 });
        await unrelated;
      }
      unlock();
      const results = await Promise.allSettled([controller, rebuild, writer]);
      expect(results.map(result => result.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
      const balances = (await service.listBalances(contextA)).filter(row => row.stockItemId === second.id);
      const balance = balances.find(row => row.locationId === sourceLocationId && row.lotId === null)!;
      const sourceQuantity = kind.startsWith("transfer_") ? 9 : kind === "movement" ? 11 : 10;
      expect(balance).toMatchObject({
        physicalQuantity: sourceQuantity,
        reservedQuantity: kind === "reservation" ? 2 : 0,
        availableQuantity: kind === "reservation" ? 8 : sourceQuantity,
      });
      const ledger = await withTenant(database.db, contextA, tx => tx.select({
        quantity: sql<number>`sum(${inventoryMovements.quantityDelta})::integer`,
      }).from(inventoryMovements).where(and(eq(inventoryMovements.stockItemId, second.id), eq(inventoryMovements.bucket, "physical"))));
      const totalPhysical = kind === "procurement_receipt" ? 12 : kind === "transfer_receive" ? 10 : sourceQuantity;
      expect(ledger[0]!.quantity).toBe(totalPhysical);
      expect(sumStockQuantities(balances.map(row => row.physicalQuantity))).toBe(totalPhysical);
      if (kind.startsWith("transfer_")) expect(balances.find(row => row.locationId === destinationLocationId)).toMatchObject({
        physicalQuantity: kind === "transfer_receive" ? 1 : 0, inTransitQuantity: kind === "transfer_dispatch" ? 1 : 0,
      });
      expect(waitingEvent).toBe("advisory");
    } finally {
      unlock();
      await Promise.allSettled(outstanding);
    }
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
  it("keeps fractional stock exact through replay, reservation, paired transfer and rebuild", async () => {
    const item = await service.createStockItem(contextA, { code: "DECIMAL-FABRIC", name: "Synthetic fabric", skuId: null, baseUnit: "meter" });
    const input = { stockItemId: item.id, locationId: sourceLocationId, lotId: null, bucket: "physical" as const,
      type: "opening" as const, quantityDelta: "1.050000000", unit: "meter" as const, sourceType: "opening" as const,
      sourceId: "decimal-fabric-opening", reasonCode: "INITIAL_COUNT", occurredAt, idempotencyKey: "decimal-fabric-opening" };
    const first = await service.recordMovement(contextA, input);
    const replay = await service.recordMovement(contextA, { ...input, quantityDelta: "1.05" });
    expect(replay.movement.id).toBe(first.movement.id);
    expect(first.balance).toMatchObject({ physicalQuantity: "1.05", reservedQuantity: 0, availableQuantity: "1.05" });
    const reservation = await service.createReservation(contextA, { stockItemId: item.id, locationId: sourceLocationId,
      lotId: null, quantity: "0.7", unit: "meter", sourceType: "manual", sourceId: "decimal-reservation", expiresAt: null, idempotencyKey: "decimal-reservation" });
    const transfer = await service.createTransfer(contextA, { stockItemId: item.id, lotId: null, sourceLocationId,
      destinationLocationId, quantity: "0.35", unit: "meter", idempotencyKey: "decimal-transfer" });
    await service.dispatchTransfer(contextA, transfer.transfer.id, { expectedVersion: 1, occurredAt, idempotencyKey: "decimal-transfer-dispatch" });
    expect((await service.listBalances(contextA)).find(row => row.stockItemId === item.id && row.locationId === sourceLocationId))
      .toMatchObject({ physicalQuantity: "0.7", reservedQuantity: "0.7", availableQuantity: 0 });
    await service.receiveTransfer(contextA, transfer.transfer.id, { expectedVersion: 2, occurredAt, idempotencyKey: "decimal-transfer-receive" });
    await service.releaseReservation(contextA, reservation.reservation.id, { expectedVersion: 1, outcome: "released", reasonCode: "PLAN_RELEASED", idempotencyKey: "decimal-reservation-release" });
    await service.recordMovement(contextA, { ...input, type: "pick", quantityDelta: "-0.7", sourceType: "manual", sourceId: "decimal-material-issue", reasonCode: "MANUAL_PICK", idempotencyKey: "decimal-material-issue" });
    const before = (await service.listBalances(contextA)).filter(row => row.stockItemId === item.id);
    expect(before.find(row => row.locationId === sourceLocationId)).toMatchObject({ physicalQuantity: 0, reservedQuantity: 0, availableQuantity: 0 });
    expect(before.find(row => row.locationId === destinationLocationId)).toMatchObject({ physicalQuantity: "0.35", inTransitQuantity: 0 });
    const [ledger] = await withTenant(database.db, contextA, tx => tx.execute<{ amount: string }>(sql`select sum(quantity_delta)::text as amount from inventory_movements where stock_item_id=${item.id} and bucket='physical'`));
    expect(stockQuantityString(ledger!.amount)).toBe("0.35");
    const rebuild = await service.rebuildProjection(contextA, { idempotencyKey: "decimal-stock-rebuild" });
    expect(normalizeBalances(rebuild.balances.filter(row => row.stockItemId === item.id))).toEqual(normalizeBalances(before));
  });

  it("serializes reservations at one billionth of a base unit and preserves tenant isolation", async () => {
    const item = await service.createStockItem(contextA, { code: "NANO-MATERIAL", name: "Synthetic measured material", skuId: null, baseUnit: "gram" });
    const movement = { stockItemId: item.id, locationId: sourceLocationId, lotId: null, bucket: "physical" as const,
      type: "opening" as const, quantityDelta: "0.000000009", unit: "gram" as const, sourceType: "opening" as const,
      sourceId: "nano-opening", reasonCode: "INITIAL_COUNT", occurredAt, idempotencyKey: "nano-material-opening" };
    await service.recordMovement(contextA, movement);
    const reserve = (key: string) => service.createReservation(contextA, { stockItemId: item.id, locationId: sourceLocationId,
      lotId: null, quantity: "0.000000005", unit: "gram", sourceType: "manual", sourceId: key, expiresAt: null, idempotencyKey: key });
    const results = await Promise.allSettled([reserve("nano-reservation-a"), reserve("nano-reservation-b")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await service.listBalances(contextA)).find(row => row.stockItemId === item.id)).toMatchObject({ physicalQuantity: "0.000000009", reservedQuantity: "0.000000005", availableQuantity: "0.000000004" });
    await expect(service.recordMovement(contextB, { ...movement, idempotencyKey: "foreign-nano-material" })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.recordMovement(contextA, { ...movement, type: "adjustment", quantityDelta: "-0.000000005", idempotencyKey: "nano-over-reserved" })).rejects.toThrow("available stock negative");
  });

  it("rejects unsupported precision, nonfinite amounts and fractional counted units in PostgreSQL", async () => {
    const material = await service.createStockItem(contextA, { code: "SQL-PRECISION", name: "Synthetic precision probe", skuId: null, baseUnit: "meter" });
    const cases = [
      { item: material.id, unit: "meter", amount: "0.0000000001" },
      { item: material.id, unit: "meter", amount: "NaN" },
      { item: material.id, unit: "meter", amount: "Infinity" },
      { item: material.id, unit: "meter", amount: "2147483647.000000001" },
      { item: stockItemId, unit: "each", amount: "0.5" },
    ];
    for (const [index, value] of cases.entries()) {
      const rejected = await withTenant(database.db, contextA, tx => tx.execute(sql`insert into inventory_movements
        (id,tenant_id,stock_item_id,location_id,lot_id,bucket,type,quantity_delta,unit,source_type,source_id,reason_code,idempotency_key,recorded_by,occurred_at)
        values(${createEntityId()},${tenantA},${value.item},${sourceLocationId},null,'physical','adjustment',${value.amount}::numeric,${value.unit},'manual','precision-probe','PRECISION_TEST',${'precision-invalid-'+index},${userA},${occurredAt}::timestamptz)`))
        .then(() => null, error => error as { code?: string; cause?: { code?: string } });
      expect(rejected?.code ?? rejected?.cause?.code).toBe("23514");
    }
    const [count] = await withTenant(database.db, contextA, tx => tx.execute<{ count: number }>(sql`select count(*)::integer as count from inventory_movements where idempotency_key like 'precision-invalid-%'`));
    expect(count!.count).toBe(0);
  });
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
  physicalQuantity: StockQuantity;
  reservedQuantity: StockQuantity;
  availableQuantity: StockQuantity;
  inTransitQuantity: StockQuantity;
  providerQuantity: StockQuantity;
  virtualQuantity: StockQuantity;
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
