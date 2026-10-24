# Payable corrections and recorded supplier refunds

Migration `0155_finance_payable_adjustments` extends the original 0153 ledger
with two immutable tenant tables: `finance_bill_adjustments` and
`finance_payment_adjustments`. It never changes original principal, procurement
documents, receipt occupation, inventory or FinanceFacts. The original invoice
recognition and the later movement or allocation of payment remain distinct.

## Amounts and lifecycle

The original `amountMinor` always remains visible. Bill net equals original
principal plus debit adjustments minus credits and the principal explicitly
voided. Payment net equals original principal minus recorded refunds or an
explicit void of an erroneous payment record. Active allocations plus the
remaining balance must equal that net. SQL derives these totals from the full
ledger; bounded history lists never determine capacity.

All monetary quantities use the existing fixed currency precision and safe
integer minor units. Owners use BigInt, SQL uses numeric, and neither rounds,
clamps a negative remainder nor silently releases an allocation. A credit or
refund that would consume occupied funds requires explicit full release of
affected allocations, followed by a new allocation of the correct amount.
Releasing an allocation creates no refund evidence.

Each command fixes `expectedNetAmountMinor`. A changed current net gives a
conflict; the operator refreshes and checks a new command. Void terminates the
record. A payment with actual refund evidence cannot also be voided as an
entirely erroneous original payment. A real refund cannot predate the original
payment; void can correct an erroneous future-dated record. A fully credited
bill or fully refunded payment has zero net and remains distinguishable from
payment settlement or void.

`externalDocumentId` identifies a supplier correction or refund document (or
its actual separately identifiable component). Within the tenant and supplier,
the same kind and document cannot be registered again on another bill; a refund
document cannot be reused on another payment. Different suppliers may use the
same document number. References are bounded, preserve Unicode, reject C0/DEL
and use the exact shared trim/UTF16 rules. Never use bank credentials or account
details as a reference.

## Genuine procurement evidence

For a procurement bill, manual credits and debits are rejected. The command
`kind=procurement_sync` pins the real 0151 `adjustment_record` and its actual
approved `adjustment_review`. Both must belong to the same original invoice,
supplier, currency, 0149 proof, purchase order and purchase-order version. The
financial amount is the exact sum of approved original lines, never an
operator replacement, the whole invoice balance or an inferred variance.
Original document number, reference and issue instant are retained.

A zero-money quantity change appends `source_acknowledgement`, rather than a
fabricated credit. Each approved source maps once, including these zero-money
records. Every approved source must be mapped before the bill can become
`current`; a pending review, unmatched balance or procurement net differing
from the financial net still holds allocations. A genuine original bill can
be registered after procurement adjustments were approved, with its original
amount and an explicit pending-sync source gate. This avoids a circular
dependency between bill registration and source mapping.

Legacy dates with nonzero sub-millisecond precision or evidence references
that the new contract cannot represent are not truncated or cleaned. The
workspace returns their real bill/record/review IDs in
`procurementAdjustmentDiagnostics`, and synchronization fails explicitly.
The original source remains unchanged. Procurement void requires all actual
quantity/money corrections to be approved, mapped and reconciled to zero,
with zero active allocation. It cannot erase an outstanding procurement debt.

## Authenticated owners and API

| Method | Route under `/v1/finance/payables` | Current permission | Result |
| --- | --- | --- | --- |
| POST | `/bills/:billId/adjustments` | `finance:review`, tenant scope | One immutable bill adjustment and its original execution balance |
| POST | `/payments/:paymentId/adjustments` | `finance:review`, tenant scope | One immutable refund/void evidence record and its execution balance |
| GET | `/workspace` | `finance:read`, tenant scope | Original/net balances, histories, approved procurement candidates and explicit diagnostics |

Every operation uses `withTenant()` and the non-owner application role,
intersects caller grants with current locked membership, and enforces the
individual permission's tenant scope. Review authority consumes previously
approved procurement evidence; it does not substitute for procurement approval.
Write-only reviewers can receive their own execution receipt without borrowing
FinanceRead. Revoked or disabled membership cannot replay a stored command.

The request key binds normalized operation, target, original body, expected net
and actor. Replay returns the original event and immutable `balanceAfter`, with
no new success audit. It does not replace that snapshot with today's balance.
Locks follow request identity, source/document identity, supplier/currency
scope, then sorted procurement-order locks. Procurement never acquires a
financial scope lock in reverse order for automatic synchronization.

SQL independently recomputes the input checksum, approved source, exact net
change, capacity and stored result. Per-row balance/source functions see prior
new rows for guarded capacity checks. Same-transaction success audits bind the
actual event, actor, kind, target, supplier, currency, amount and procurement
record/review IDs. Forced RLS and insert/select-only grants protect both new
tables, and mutation triggers retain immutable history.

## Personal UI and recovery

The existing `/finance/payables` keeps original bill/payment registration,
allocation and release controls. It adds correction drawers, lifecycle labels,
net balances and event histories. The BFF allowlists the two new paths, checks
same-origin bounded JSON, and validates result identity, original fields,
source pins and the expected net delta. Responses remain private/no-store.

The UI labels stored `balanceAfter` as the balance at that execution. Current
balances come from a successful workspace refresh. Unknown submission results
retain the exact original body and key for same-key retry in the current page;
this is not a durable cross-session command. Current authority changes clear
editing state and fence late responses. The complete durable financial command
workflow remains separate work.

A selected procurement credit exceeding the current unallocated bill balance
shows its exact amount and the available balance before submission, disables the
new command, and directs explicit release before synchronization and reallocation.
Approved debits and zero-money source acknowledgements are not blocked by that
credit-only check. Type changes clear the old entry; old controls are disabled
and excluded from FormData during exit/entry, with immediate reduced-motion
switches and cancellation of stale transition timers. On first successful
receipt mount, the component restores its dialog top and focuses the receipt
heading before paint. Later workspace refreshes do not repeat that focus move.

New histories and approved-source lists are bounded to 500 with explicit
truncation. Totals and gates use all ledger rows. Full searchable ledger
pagination, cross-invoice document-component allocation, external document
authenticity checks, a general ledger and actual bank reconciliation remain
part of the full financial roadmap.

## Verification and adoption

Use the dedicated disposable suites `finance-payables-adjustments-integration`,
`finance-payables-adjustments-upgrade-integration` and
`finance-payables-adjustments-browser`. Upgrade requires the byte-verified
actual154 source and `E2E_FINANCE_PAYABLES_ADJUSTMENTS_LEGACY_SOURCE`; it creates
real old owner evidence before migration. All suites require the disposable
environment and their `E2E_FINANCE_PAYABLES_ADJUSTMENTS_ISOLATED` guard. Browser
acceptance uses a sealed compiled candidate and personal fixture identity.
These are test-only flags, with no new production environment variables.

Ordinary database148 and its stopped applications remain unchanged. Do not
start current155 source against148. Fresh business pairing/backup, independent
restore and upgrade, and personal acceptance remain prerequisites to adoption;
the previous rejected ordinary Web startup has not been retried. Actual results
and cleanup are recorded in [the progress record](../project-control/FINANCE_ADJUSTMENTS_PROGRESS_20261021.md).

Open-source design references: [ERPNext Payment Entry](https://docs.frappe.io/erpnext/payment-entry)
and [Debit Note](https://docs.frappe.io/erpnext/debit-note). Their separation of
invoice recognition, payment allocation and supplier credit/refund informs the
workflow; the implementation uses YummyAI's existing immutable evidence owners.
