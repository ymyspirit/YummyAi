# Finance integration

P3-D normalizes authorized financial statements into immutable facts and
calculates profit from explicit evidence. It does not authorize stores, retrieve
credentials, infer costs, or silently choose unsupplied exchange rates.

## Pinned currency units (0152)

Finance uses the fixed `iso4217-2026-09-17-v1` snapshot, rather than a host locale
or a universal two-decimal assumption. `amountMinor` stays an integer. JPY has
zero minor digits, KWD three, and CLF four. Unknown, historic-without-precision,
and N.A. entries stay unknown; they never become zero or an assumed two digits.

New FX input can explicitly provide `rateUnit: "major_to_major"`. The owner pins
both minor digits and table version. The exact per-fact conversion is
`round_half_away(A * numerator * 10^targetDigits / (denominator * 10^sourceDigits))`.
The original rational rate is retained. Latest effective time, then retrieval
time, then ascending immutable ID resolve rate selection within the supplied IDs.
No inverse, triangulated, or unsupplied rate is inferred.

Each new profit run pins `monetaryBasis` v2, the currency set and
`half_away_from_zero_per_fact`. Integer arithmetic and exact quotient/remainder
rounding protect JS safe-integer and PostgreSQL margin boundaries. SQL checks
the immutable statement set, rate, contribution and totals in the tenant's
transaction. Facts are imported with their parent statement in one transaction;
a profit run consumes committed imports. Late fact/contribution appends fail.

Migration 0152 only adds nullable basis columns to old rows. No old amount,
checksum, contribution, timestamp or migration hash is rewritten. Missing FX
units remain compatible only for two known equal precisions. A saved old
cross-precision or unknown-currency result is returned as incomplete with null
totals and no breakdown, while retaining the original contribution values.
Replay keeps its original input checksum; a correct result needs a new run and
explicit rate evidence. See [implementation progress](../project-control/FINANCE_MONETARY_PROGRESS_20261021.md).

The 0152 monetary slice does not itself establish a payment ledger. The separate
0153 [actual payables and payment-allocation owner](finance-payables.md) now
records supplier-scoped bills, operator payment evidence and reversible
allocations, with current authority and atomic audit. It never creates a second
cost. The 0154 [source-identity and owner-authority slice](finance-source-authority.md)
now adds real supplier/account scopes, stable cross-statement component identity,
current membership checks and four atomic audits. Every old run lacking this
source provenance is returned as incomplete even when its currency units are
compatible; original stored amounts and contributions remain unchanged.
The 0155 [payable-adjustment owner](finance-payable-adjustments.md) now records immutable bill corrections, genuine approved procurement mappings and actual supplier-refund evidence while preserving principal and allocations. Bank execution, durable cross-session financial commands, full B44/B45/B46 and real-source acceptance remain open.

## Provider boundary

`@yummyai/marketplace-connectors` exposes
`ProviderFinanceStatementSchema` and `normalizeProviderFinanceStatement`.
Supported Amazon and Etsy transaction categories map to sale/shipping revenue,
commission, advertising, fulfillment/storage fees, refunds, chargebacks, tax,
and other fees. A statement must use one source currency. Provider order
references remain external references until the authenticated ingestion layer
resolves them to tenant order/catalog dimensions.

## API

| Method | Route | Permission | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/finance/workspace` | `finance:read` | Read safe statements, rates, metric versions, runs, diagnostics, and breakdowns |
| `GET` | `/v1/finance/statements/:id` | `finance:read` | Read one immutable statement and its normalized facts |
| `GET` | `/v1/finance/profit-runs/:id` | `finance:read` | Read one pinned calculation and contributions |
| `POST` | `/v1/finance/statements` | `finance:write` | Append a statement or correction evidence |
| `POST` | `/v1/finance/fx-rates` | `finance:write` | Append a rational historical FX rate |
| `POST` | `/v1/finance/profit-metrics` | `finance:review` | Create a metric or append a definition version |
| `POST` | `/v1/finance/profit-runs` | `finance:review` | Calculate from explicit statement, FX, and metric versions |

The workspace excludes tenant IDs, actor IDs, idempotency keys, raw provider
payloads, credentials, and unrestricted financial text.

## Completeness and corrections

The calculation selects the latest supplied direct FX rate whose effective time
does not exceed the fact occurrence time. Same-currency facts require no rate.
Missing required fact types, FX pairs, or classifications keep all aggregate
totals `null`.

Corrections are append-only. Record an exact reversal first, then an optional
replacement referencing the original fact. Calculations retain original,
reversal, and replacement contributions, so the accounting effect is visible
and reproducible.

## Order fulfillment and profit review

The read-only order review joins scoped immutable financial evidence with saved
order versions, factory feedback, shipping and rework records. It reuses pinned
profit calculations only while every booked order fact is still included, requires
per-order cost coverage and preserves unknown fees. Whole-order shared costs do
not get spread into SKU profit. See [order profit review](order-profit-review.md)
for the read routes, permissions, attribution references and acceptance commands.
