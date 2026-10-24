# Payable bills, recorded payment evidence and allocation

Migration 0153 introduces an independent ledger. It records operator-confirmed
evidence of an already occurred payment; it never initiates a bank transfer,
verifies a bank account, publishes to a marketplace, or creates a FinanceFact.
An allocation describes which payable the recorded payment covers. Releasing
an allocation restores its recorded capacity; it is not a bank refund.

## Ownership and storage

Five immutable tenant-owned tables store bills, recorded payments, allocation
batches, allocation rows and full allocation releases. `fulfillment_suppliers`
is the existing party identity. A supplier's archived procurement status does
not erase a debt or prevent recording its actual historical evidence.

Bill identity is `(tenant, supplier, externalBillId)` across kinds/currencies;
payment identity is `(tenant, supplier, externalPaymentId)`. One actual
procurement invoice can map to one payable. A changed body, applicant or target
cannot reuse its request key. Strict normalized originals keep lowercase UUIDs,
UTC millisecond timestamps, the original allocation array order and a canonical
SHA256 checksum. Internal keys, checksums, tenant IDs and actor IDs are not in
workspace views. References are bounded ASCII business identifiers; do not put
bank account details, credentials or payment-card data in them.

New money uses the existing fixed ISO precision, positive safe-integer minor
units and BigInt sums. JPY uses zero digits, KWD three and CLF four. The UI
accepts an exact decimal string and refuses excess precision without rounding.
No cross-currency allocation or implicit exchange rate is supported here.

## Actual procurement source

An actual procurement bill pins the original invoice and its genuine 0149
request proof. Supplier, currency, amount, invoice number and issue time must
match; proof version, original applicant/key and known creation/allocation
basis must be valid. A true old invoice, or a new proof whose underlying old
capacity remains `legacy_unknown`, cannot become a verified payable source.

An unmatched actual invoice may be registered as `source_unreconciled`, but
cannot receive a new allocation. The latest immutable 0151 matching balance
and pending supplier-adjustment review determine this gate. A real later
accepted receipt and matching event can return it to `current`.

Any approved adjustment not explicitly mapped to the financial ledger gives
`source_adjusted`. Migration0155 adds immutable credit/debit/void and recorded
refund evidence, and maps genuine approved0151 source records once. Original
principal and allocations stay visible. All approved records, pending reviews,
matched/fully-credited procurement state and exact net amount determine the
gate. Existing allocations can still be explicitly released. See
[the correction and refund contract](finance-payable-adjustments.md) for its
owners, source bindings, concurrency, UI and remaining full-finance work.

## Transaction boundaries

Every owner operation calls `withTenant()` with the non-owner role, intersects
the caller's authority with locked current membership/grants, and checks the
individual permission's tenant scope. Workspace uses a repeatable-read,
read-write transaction so the membership SHARE lock and complete-ledger totals
share one snapshot. The existing helper still preserves read-only callers.

Writes serialize request identity, external document identity, then the
tenant/supplier/currency balance. Procurement orders are locked in sorted ID
order using their existing owner lock before source revalidation. A payment
cannot allocate more than its unallocated amount, nor can a bill exceed its
outstanding amount. SQL checks both limits, including one multi-row INSERT.

An allocation batch fixes its complete input and creation transaction. Every
row must match that batch's payment, bill and amount in the same transaction;
deferred closure checks reject missing rows. `SET CONSTRAINTS IMMEDIATE` does
not permit later additions to a committed batch. A release is append-only and
unique per allocation. Four success audits use the same business transaction;
SQL verifies the exact entity, action, actor and current audit-row transaction.
RLS is forced on all five tables, with SELECT/INSERT grants only.

## Authenticated API and UI

| Method | Route below `/v1/finance/payables` | Permission | Result |
| --- | --- | --- | --- |
| GET | `/workspace` | `finance:read`, tenant scope | Safe balances, source gates, history and current write/review permissions |
| POST | `/bills` | `finance:write`, tenant scope | Immutable actual payable |
| POST | `/payments` | `finance:write`, tenant scope | Operator-recorded payment evidence |
| POST | `/allocations` | `finance:review`, tenant scope | One complete batch, possibly covering multiple bills |
| POST | `/allocations/:id/releases` | `finance:review`, tenant scope | Immutable full release of the original allocation |
| POST | `/bills/:id/adjustments` | `finance:review`, tenant scope | Immutable credit/debit/void or approved procurement source mapping |
| POST | `/payments/:id/adjustments` | `finance:review`, tenant scope | Recorded actual refund or void of an erroneous payment record |

The personal UI is `/finance/payables`, linked from Finance and navigation
search. Its BFF `/api/finance/payables/*` allowlists these paths, validates
bounded JSON, enforces same-origin writes, checks original/result identity and
uses existing personal `apiFetch`. No service credential is exposed to the
browser. Errors and successful responses are private/no-store.

Workspace pages bound bills/payments/allocations/releases to 500 and suppliers
to 1000. `truncated` makes this explicit. All displayed balances and release
flags use complete-ledger queries, not sums of those truncated lists.

An unconfirmed write freezes its original body/key for same-key retry in the
current page. This is not a durable cross-session command: after closing it,
operators must inspect actual records before another submission. Rights or
identity changes clear private drafts and discard late responses.

## Verification and ordinary adoption

Use the disposable acceptance runner suites `finance-payables-integration`,
`finance-payables-upgrade-integration` and `finance-payables-browser`. The last
uses personal fixture identity and a sealed compiled Web candidate. Upgrade
acceptance requires the byte-verified actual148 source and retained actual152
source; it does not fake legacy markers with current code. See the
[current progress and cleanup record](../project-control/FINANCE_PAYABLES_PROGRESS_20261021.md).

The ordinary database remains 0148 and its applications remain stopped. Never
start current 0153 code against it. Adoption still requires a fresh paired
business backup, independent restore/upgrade rehearsal and personal acceptance;
the prior rejected ordinary Web startup has not been retried.

Open-source references: [ERPNext Payment Entry](https://docs.frappe.io/erpnext/payment-entry)
and [Payment Reconciliation](https://docs.frappe.io/erpnext/payment-reconciliation).
Their independent payment/unallocated-balance concepts inform this boundary;
the existing YummyAI integer precision, tenant authority and immutable owners
remain the implementation basis.
