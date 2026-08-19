# ADR-007: Procurement versioning and three-way reconciliation

**Status:** Accepted for P3-B local implementation

## Context

Inventory procurement must not reuse the P2 customer-fulfillment `purchase_orders`
domain. Procurement changes stock and creates financial evidence, while fulfillment
purchase orders pin a supplier routing decision for one customer order. Combining
them would allow unrelated workflows to rewrite each other's versions and would
make receipt and invoice reconciliation ambiguous.

## Decision

- Inventory procurement owns requisitions, RFQs, supplier quote versions,
  inventory purchase orders, approval events, receipts, supplier invoices,
  replenishment policy versions, and replenishment suggestions.
- Existing tenant-scoped fulfillment suppliers are referenced by composite
  `(tenant_id, id)` foreign keys. Procurement never writes supplier routing tables.
- Requisition, quote, purchase-order, and replenishment-policy content is
  immutable. Mutable identity rows point to the current version and use optimistic
  version checks for review or revision.
- Purchase-order approval is a separate `procurement:approve` action. Requisition,
  RFQ, quote, purchase-order, receipt, invoice, and policy commands require
  `procurement:write`; the workspace requires `procurement:read`.
- A receipt and its accepted/rejected lines are appended in the same tenant
  transaction that creates accepted inventory lots and immutable receipt
  movements through `InventoryService`. Procurement does not write inventory
  tables directly.
- Over-receipt, rejection, or invoice quantity, unit-price, or currency mismatch
  moves the inventory purchase order into `reconciliation_required`. Existing
  evidence is never edited to force a match.
- Replenishment suggestions pin the policy version and the available/in-transit
  quantities used for the calculation. A suggestion never creates or approves a
  purchase order.
- The Web workspace consumes the strict shared procurement schema and omits
  tenant IDs, actors, checksums, and idempotency keys.

## Consequences

Procurement and customer fulfillment can share supplier identities without
sharing purchase-order state. Operators can reproduce an order/receipt/invoice
decision from immutable versions and quantity facts. Variances require an
explicit later reconciliation workflow; P3-B does not silently revise financial
evidence. Provider-native supplier ordering and invoice ingestion remain future
authorized connector gates.
