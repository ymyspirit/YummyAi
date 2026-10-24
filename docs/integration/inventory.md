# Inventory integration

149隔离验收增加采购批次unitCostQuantity：整数unitCostMinor对应明确数量的库存基本单位，例1200 minor/1000克，不能把每克1.2 minor取整。旧批次新列保持NULL，不能从今天规则回填历史。采购收货同时留原采购及实际库存数量，补货助手连续单位保留小数；详见[计量设计](../architecture/procurement-measurement-and-invoices.md)和[本批验证/清理](../project-control/PROCUREMENT_PRECISION_PROGRESS_20261020.md)。

P3-A provides a tenant-isolated inventory ledger with rebuildable balances, serialized reservations, paired transfers, and a safe operational workspace. It does not ingest provider inventory or synchronize marketplace Listing quantities; those are P3-C integration gates.

## Data boundary

Every warehouse, location, stock item, lot, movement, balance, reservation, transfer, and rebuild record is tenant scoped under forced PostgreSQL RLS. Tenant context comes from authenticated membership.

Movement, lot, reservation-event, transfer-event, and rebuild rows are append-only for the application role. Balance, reservation, and transfer rows are current projections backed by immutable evidence. The workspace response excludes `tenantId`, actor IDs, and idempotency keys.

Quantities use one explicit base unit: `each`, `pair`, `set`, `meter`, `gram`, or `kilogram`. Historical integer JSON stays integral; fractional quantities use exact decimal strings with up to nine places, and each/pair/set remain whole counts. Money on lots uses integer minor units and an ISO currency code.

## API

All routes use `inventory:read` or `inventory:write`:

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/inventory/workspace` | `inventory:read` | Safe warehouse, stock, balance, reservation, transfer, and recent-ledger view |
| `GET/POST` | `/v1/inventory/warehouses` | read/write | List or create a warehouse |
| `GET/POST` | `/v1/inventory/locations` | read/write | List or create a warehouse location |
| `GET/POST` | `/v1/inventory/stock-items` | read/write | List or create a stock identity with one base unit |
| `GET` | `/v1/inventory/stock-items/:id/classifications?beforeVersion=N` | `inventory:read` | Current safe stock and immutable classification history, 25 revisions per page |
| `POST` | `/v1/inventory/stock-items/:id/classifications` | `inventory:write` | Append a classification against the explicitly reviewed previous revision |
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

Before taking any `inventory-dimension` lock, a balance writer takes a transaction-scoped shared advisory lock on `inventory-projection-rebuild:<authenticated tenant>`. Rebuild takes that same key exclusively before reading evidence and keeps it until the replacement projection commits. The tenant comes from `withTenant()`; there is no caller-selected maintenance tenant or global table lock. Ordinary writers retain their existing command/idempotency locks, then take the shared rebuild key, then dimension locks. Rebuild never waits for those command locks, avoiding an inverse lock order.

This applies to direct movements, reservation creation/release, both transfer legs and procurement's inventory receipt owner. Another tenant's writers remain independent. The six controlled concurrency scenarios use a real blocked balance deletion, inspect database lock waits and compare the final ledger and projection. See the [current inventory audit](../project-control/INVENTORY_REBUILD_AUDIT_20261020.md).

Transfer lifecycle commands also require the current `expectedVersion`. Dispatch and receive are replay safe and append exactly two linked movements plus one event. Do not repair one side by editing ledger rows; append reconciliation facts or run projection rebuild after the evidence is complete.

## Projection rebuild

`POST /v1/inventory/projections/rebuild`:

1. Acquires the tenant rebuild lock exclusively; balance writers acquire the same key in shared mode.
2. Reads ordered movement evidence and active reservations.
3. Recomputes every inventory dimension.
4. Rejects invalid negative or oversold evidence.
5. Replaces only the tenant's balance projection under RLS.
6. Appends the balance count and SHA-256 aggregate checksum.

The rebuild key is replay safe. A replay returns the original rebuild evidence and current balances without appending another record.

## Exact quantities and production consumption

Migration 0138 preserves historical integer JSON while accepting exact fractional decimal strings with up to nine places. Unconstrained PostgreSQL numeric plus explicit CHECK constraints reject unsupported precision rather than rounding it first. Each, pair and set remain integral. Balances, partial reservations, both transfer legs and rebuild share this arithmetic.

The 0139 production owner adds actual consumption and correction receipts against the sealed manufacturing binding. An active reservation contributes only its remaining quantity after immutable consumption events; legacy fulfilled events do not imply physical consumption. See [production material execution](production-material-execution.md) for ownership, source responsibility and recovery. The ordinary local ERP adopted 0138–0140 on 2026-10-20 after a fresh paired backup, independent restoration and upgrade rehearsal.

The inventory page now reads the shared `InventoryWorkspaceViewSchema` instead of a number-only local validator. It preserves exact strings such as `0.123456789` and rejects internal tenant/actor/idempotency fields before schema normalization. Four boundary tests and the same compiled personal browser confirmed actual fractional stock on the procurement and inventory routes at 1440/390 widths. See [the adoption checkpoint](../project-control/MATERIAL_ADOPTION_PROGRESS_20261020.md).

## Material classification revision

Migration 0141 introduces a separate append-only classification history. Its five
kinds are `blank`, `material`, `packaging`, `work_in_progress` and `finished_good`.
An existing or newly unclassified stock identity remains explicitly unknown; the
migration does not infer a kind from names, units, previous orders or balances.
Changing a kind appends the reason and next revision, without rewriting the stock
identity, base unit, BOM pins or historical quantities. Classification is an
operational category, not evidence of inspection, ownership, production or release.

Each write checks current membership and the intersection with the requesting
context's permission-specific scope. A company-wide read grant does not expand a
self-only write grant. A stock without a trusted team binding cannot be reached
merely by claiming team scope. The key binds stock, actor and original parsed body;
replay returns the original classification fact alongside the current stock view.
Competing revisions serialize on the stock row. The non-owner database role can
only select/insert, and its guard checks the actual actor, next revision and server
recording time. Initial classification, stock creation and their audits commit
together; subsequent classification and its audit also commit together.

The personal UI exposes classification/history from the stock master list. Focus
refresh preserves an unsaved draft and disables saving when the original revision
has changed until the operator explicitly reviews the new basis. Read loss clears
private history/draft; write loss leaves history readable with no editing form.
An actual submission returning an access denial or changed session authority also
clears the private form/history immediately and invalidates older in-flight reads;
it does not wait for a focus event. A normal version conflict or unknown transport
result preserves the original draft instead. Temporary read failure preserves the
draft but blocks saving until recovery. No
private classification draft is stored persistently in the browser.

The ordinary local database adopted 0141/0142 on 2026-10-20 after a fresh paired
business backup, independent restore/upgrade rehearsal and non-owner readiness.
Current source/candidate, validation and cleanup are recorded in the
[inventory and receiving checkpoint](../project-control/INVENTORY_RECEIVING_PROGRESS_20261020.md).
Other deployments require their own coordinated backup and adoption. Incoming inspection is a separate unfinished workflow;
see [its architecture and acceptance boundary](../architecture/incoming-material-inspection.md).
