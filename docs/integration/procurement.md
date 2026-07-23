# Procurement integration

P3-B provides tenant-isolated inventory procurement, receipt-to-stock posting,
supplier invoice reconciliation, and policy-based replenishment suggestions. It
does not place provider orders or ingest provider invoices automatically.

## Domain boundary

Inventory procurement is separate from the P2 customer-fulfillment
`purchase_orders` domain. It reuses active tenant supplier identities but owns
its own requisitions, RFQs, quote versions, inventory purchase orders, receipts,
invoices, and replenishment policies.

All tables use forced PostgreSQL RLS and composite tenant foreign keys. Content
versions, purchase-order events, receipts and lines, invoices and lines, and
replenishment suggestions are append-only for `yummyai_app`. Identity rows are
mutable only where a current status or version projection must advance.

Amounts use integer minor units with an ISO currency. Quantities use an explicit
base unit. Workspace responses exclude tenant IDs, actor IDs, checksums, and
idempotency keys.

## API

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/procurement/workspace` | `procurement:read` | Read the safe procurement, receipt, invoice, and replenishment workspace |
| `POST` | `/v1/procurement/requisitions` | `procurement:write` | Create an idempotent requisition version |
| `POST` | `/v1/procurement/requisitions/:id/rfqs` | `procurement:write` | Open an RFQ pinned to the expected requisition version |
| `POST` | `/v1/procurement/rfqs/:id/quotes` | `procurement:write` | Append a supplier quote version |
| `POST` | `/v1/procurement/purchase-orders` | `procurement:write` | Create a versioned inventory purchase order |
| `POST` | `/v1/procurement/purchase-orders/:id/revisions` | `procurement:write` | Append a purchase-order revision using optimistic versioning |
| `POST` | `/v1/procurement/purchase-orders/:id/reviews` | `procurement:approve` | Approve or reject the current purchase-order version |
| `POST` | `/v1/procurement/purchase-orders/:id/receipts` | `procurement:write` | Append receipt/rejection evidence and post accepted stock |
| `POST` | `/v1/procurement/purchase-orders/:id/invoices` | `procurement:write` | Append a supplier invoice and calculate match variance |
| `POST` | `/v1/procurement/replenishment-policies` | `procurement:write` | Create or append a policy version |
| `POST` | `/v1/procurement/replenishment-policies/:id/suggestions` | `procurement:write` | Append a suggestion pinned to current policy and stock facts |

## Version and replay rules

Every command has a tenant-scoped idempotency key. Replaying an accepted command
returns the existing identity or evidence. Purchase-order revisions and reviews
also require `expectedVersion`; stale versions return a conflict and must be
refreshed before another decision.

RFQs pin a requisition version. Supplier quotes retain supplier, currency,
validity, MOQ, unit cost, and lead time. Inventory purchase orders retain their
own currency, expected arrival, line quantities, destination locations, and unit
costs.

## Receipt and invoice reconciliation

An approved receipt transaction:

1. Locks the purchase order and validates its current version.
2. Appends receipt and accepted/rejected line evidence.
3. Creates one inventory lot and immutable receipt movement for each accepted
   line through `InventoryService`.
4. Advances the purchase-order status to received, partially received, or
   `reconciliation_required`.

Rejected quantity, over-receipt, and other receipt variance preserve accepted
stock but require reconciliation. Invoice matching compares invoice currency,
line set, quantity received, and ordered unit price. A mismatch stores the
invoice and variance, then moves the purchase order to
`reconciliation_required`; it does not edit the receipt or order version.

## Replenishment suggestions

A policy version pins reorder point, safety stock, MOQ, lead time, service level,
and review interval. Suggestions use:

`position = available physical stock + in-transit stock`

When position is at or below the reorder point, suggested quantity is the
greater of MOQ and `(reorder point + safety stock - position)`. The suggestion
records the exact policy version and stock inputs. It never creates, approves,
or submits a purchase order.
