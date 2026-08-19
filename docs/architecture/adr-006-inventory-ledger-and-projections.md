# ADR-006: Inventory ledger and rebuildable projections

**Status:** Accepted for P3-A local implementation

## Context

Inventory must support owned, third-party, FBA, supplier, and virtual warehouses without treating a mutable balance as evidence. Concurrent order reservations and transfers can otherwise oversell a location or leave one side of a movement missing. Historical inventory must remain explainable after projection repair.

## Decision

- `inventory_movements` is the append-only quantity source of truth. Every movement has one stock item, location, optional lot, bucket, integer base-unit delta, source type/ID, reason code, occurred time, recorded time, and tenant-scoped idempotency key.
- `inventory_balances` is a mutable projection partitioned by stock item, location, and optional lot. It stores physical, reserved, in-transit, provider, and virtual buckets; available stock is derived as physical minus reserved.
- Reservations use an identity projection plus append-only lifecycle events. A transaction advisory lock serializes one tenant/dimension before checking and updating available stock.
- Transfers use an identity projection plus append-only events. Dispatch records a physical debit and destination in-transit credit; receipt records a destination in-transit debit and physical credit. Dispatch/receipt events reference both movement IDs.
- Lots and all movement, reservation-event, transfer-event, and projection-rebuild evidence are insert-only for `yummyai_app`. Identity and projection tables receive only the update/delete privileges required by their service workflows.
- Projection rebuild deletes only the current tenant's balance rows under forced RLS, replays the movement ledger and active reservations, validates non-negative buckets and availability, then appends a checksum-bearing rebuild record.
- The workspace transport omits tenant IDs, actor IDs, and idempotency keys. Missing values remain missing; the UI never invents stock.

## Consequences

Balance reads are fast but never authoritative by themselves. Replay and repair are deterministic from immutable facts. Reservation and transfer commands can return conflicts under concurrent or stale input, which clients must treat as a required refresh rather than retry with changed payload under the same key. Provider inventory and channel allocation remain later P3-C facts and cannot be inferred from physical stock.
