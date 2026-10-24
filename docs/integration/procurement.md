# Procurement integration

0151隔离实现供应商凭证核准与后到货匹配。原149发票分配保持，原发票及新发票共同按原分配+consume−已核准release计算收货占用；数量贷项先减未分配量。新本人命令仍经prepare/execute/get/ack，GET实际详情与分页独立授权。见[接口规格](procurement-invoice-reconciliation.md)；普通148未采用151。

新实际发票UI使用既有commands prepare/execute/get/list/cancel/ack入口，input.expectedVersion必填；view.invoiceResult从真实149 proof读取，发票结果版本为NULL。raw invoice原接口及149省略version输入继续兼容，不能用raw绕过已绑定命令。分配/金额状态独立，差异核销另行实现；见[发票命令](../architecture/procurement-invoice-commands.md)。

新增149在隔离路径验证采购九位数量、明确单位和priceBasisQuantity、PO stockBasis、批次unitCostQuantity及不可重复的部分发票分配。POST purchase-orders/:id/invoices可传expectedVersion并固定实际版本，返回ProcurementInvoiceView；varianceMinor可NULL，allocation complete与status matched独立。个人BFF为/api/procurement-invoices/:id；细节、真实旧148兼容及未完成项见[计量设计](../architecture/procurement-measurement-and-invoices.md)与[实际验收](../project-control/PROCUREMENT_PRECISION_PROGRESS_20261020.md)。普通不迁149。

The ordinary local runtime is adopted through 0145. Worktree migration 0146 adds
private same-transaction evidence for six front-cycle procurement operations; it
has not been adopted ordinarily. Current permissions, canonical replay, quote
validity/source/price/MOQ and the separate pending durable-input work are specified
in [original procurement requests](procurement-original-requests.md).

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

Legacy receipts retain the operator's declared accepted/rejected quantities.
Migrations 0143–0145 add separate arrival, inspection, approval, accepted-stock
posting and actual-return facts, plus durable original inputs. New purchase orders
use that explicit inspection boundary; historical declarations are not rewritten
as inspected. See [incoming inspection](incoming-inspection.md) and its
[design](../architecture/incoming-material-inspection.md) for the implemented and
remaining B40 boundary.

A receipt transaction for an approved purchase order:

1. Locks the purchase order and validates its current version.
2. Appends receipt and accepted/rejected line evidence.
3. Creates one inventory lot and immutable receipt movement for each accepted
   line through `InventoryService`.
4. Advances the purchase-order status to received, partially received, or
   `reconciliation_required`.
5. Appends minimal original-request evidence and the success audit in that same
   transaction. A failed final audit rolls back the receipt, stock and order changes.

Rejected quantity, over-receipt, and other receipt variance preserve accepted
stock but require reconciliation. Invoice matching compares invoice currency,
line set, quantity received, and ordered unit price. A mismatch stores the
invoice and variance, then moves the purchase order to
`reconciliation_required`; it does not edit the receipt or order version.

### Original receipt request evidence

Migration 0142 adds private, immutable version-1 request evidence. The
normalized purchase-order identity, original actor and canonical parsed input
(including normalized ISO dates) bind a successful receipt key. A changed body or
purchase order conflicts with `receipt_request_mismatch`; reusing a key does not
turn a different receipt into success. Current membership and permission-specific
ownership are rechecked for new work and replay, using the narrower of the original
request context and current grants. The original stock movement is never repeated.

The receipt header and its request evidence must commit together. A deferred
constraint rejects a new header without matching evidence; the insert guard binds
the real transaction actor and same-transaction header, preventing later claims
about an old receipt's unknown request. Existing rows and migration hashes remain
unchanged. Replaying an old receipt without evidence returns
`receipt_input_unavailable` and requires the operator to inspect the old record.
It never manufactures a checksum from today's input. Checksums, actor IDs and
request keys are excluded from public workspace responses.

This evidence is a successful-request binding, not a durable prepared command or
proof of inspection. Purchase-order quantities and MOQ currently use whole base
units; receipts and incoming inspection preserve up to nine decimal places.
Fractional purchasing and purchasing-to-stock conversion remain explicit future
work. The ordinary local database historically adopted 0142 with the verified API/Web source
on 2026-10-20 after a fresh paired business backup and independent restore/upgrade
rehearsal. See [the current checkpoint](../project-control/INVENTORY_RECEIVING_PROGRESS_20261020.md).
It now runs 0145 as recorded in [incoming adoption](../project-control/ARRIVAL_INSPECTION_PROGRESS_20261020.md).
Other environments still need their own coordinated adoption.

## Replenishment suggestions

A policy version pins reorder point, safety stock, MOQ, lead time, service level,
and review interval. Suggestions use:

`position = available physical stock + in-transit stock`

When position is at or below the reorder point, suggested quantity is the
greater of MOQ and `(reorder point + safety stock - position)`. The suggestion
records the exact policy version and stock inputs. It never creates, approves,
or submits a purchase order.
