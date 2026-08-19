# Inventory integration

P3-A provides a tenant-isolated inventory ledger with rebuildable balances, serialized reservations, paired transfers, and a safe operational workspace. It does not ingest provider inventory or synchronize marketplace Listing quantities; those are P3-C integration gates.

## Data boundary

Every warehouse, location, stock item, lot, movement, balance, reservation, transfer, and rebuild record is tenant scoped under forced PostgreSQL RLS. Tenant context comes from authenticated membership.

Movement, lot, reservation-event, transfer-event, and rebuild rows are append-only for the application role. Balance, reservation, and transfer rows are current projections backed by immutable evidence. The workspace response excludes `tenantId`, actor IDs, and idempotency keys.

Quantities are signed or positive 32-bit integers in one explicit base unit: `each`, `pair`, `set`, `meter`, `gram`, or `kilogram`. Money on lots uses integer minor units and an ISO currency code.

## API

All routes use `inventory:read` or `inventory:write`:

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/inventory/workspace` | `inventory:read` | Safe warehouse, stock, balance, reservation, transfer, and recent-ledger view |
| `GET/POST` | `/v1/inventory/warehouses` | read/write | List or create a warehouse |
| `GET/POST` | `/v1/inventory/locations` | read/write | List or create a warehouse location |
| `GET/POST` | `/v1/inventory/stock-items` | read/write | List or create a stock identity with one base unit |
| `GET/POST` | `/v1/inventory/lots` | read/write | List or append immutable lot evidence |
| `GET/POST` | `/v1/inventory/movements` | read/write | Read recent movements or append one idempotent quantity fact |
| `GET` | `/v1/inventory/balances` | `inventory:read` | Read explicit physical/reserved/available/in-transit/provider/virtual projections |
| `GET/POST` | `/v1/inventory/reservations` | read/write | List or create a serialized reservation |
| `GET` | `/v1/inventory/reservations/:reservationId` | `inventory:read` | Read reservation identity and ordered lifecycle events |
| `POST` | `/v1/inventory/reservations/:reservationId/release` | `inventory:write` | Release, fulfill, or cancel an active reservation with optimistic version |
| `GET/POST` | `/v1/inventory/transfers` | read/write | List or create a draft transfer |
| `GET` | `/v1/inventory/transfers/:transferId` | `inventory:read` | Read transfer identity and ordered paired events |
| `POST` | `/v1/inventory/transfers/:transferId/dispatch` | `inventory:write` | Move source physical stock into destination in-transit |
| `POST` | `/v1/inventory/transfers/:transferId/receive` | `inventory:write` | Move destination in-transit stock into physical stock |
| `POST` | `/v1/inventory/transfers/:transferId/cancel` | `inventory:write` | Cancel a draft transfer without movements |
| `POST` | `/v1/inventory/projections/rebuild` | `inventory:write` | Rebuild tenant balances and append checksum evidence |

## Replay and concurrency

Movement, reservation creation, transfer creation, lifecycle commands, and projection rebuild require an idempotency key. Replaying the same payload returns the existing fact/projection. Reusing a creation key with changed quantity, dimension, unit, or source returns a conflict.

Reservation creation locks the tenant/dimension and rejects a request when physical minus reserved is insufficient. Movement recording uses the same lock and rejects a result where any bucket is negative or physical is below reserved.

Transfer lifecycle commands also require the current `expectedVersion`. Dispatch and receive are replay safe and append exactly two linked movements plus one event. Do not repair one side by editing ledger rows; append reconciliation facts or run projection rebuild after the evidence is complete.

## Projection rebuild

`POST /v1/inventory/projections/rebuild`:

1. Acquires the tenant rebuild lock.
2. Reads ordered movement evidence and active reservations.
3. Recomputes every inventory dimension.
4. Rejects invalid negative or oversold evidence.
5. Replaces only the tenant's balance projection under RLS.
6. Appends the balance count and SHA-256 aggregate checksum.

The rebuild key is replay safe. A replay returns the original rebuild evidence and current balances without appending another record.
