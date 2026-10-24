# Explicit expense allocation and attributed profit

Operation87a6c2d9 starts from verified2702 source7727fadf and PRD1.1.63/state390.
Targeted local validation passed:191 unit,66 distinct isolated including actual155 upgrade, and4 compiled personal browser cases. Ordinary148 and the full platform are not accepted. The older full artwork fixture stops at image upload422 and remains unresolved. Original155 fixture, generated outputs and313 links were inspected and cleaned; concise evidence remains.

## Ownership and money

Existing Finance facts, aggregate profit runs, one-contribution-per-fact, FX,
source verification and checksums remain unchanged. New records are attributed
projections inside the same Finance owner, not additional cost facts or payment
allocations. A base run must pass the original complete verification owner and
have aggregate coverage. Each original reporting contribution is counted once.

An immutable approved allocation version pins an original aggregate run/checksum,
cost root families, a single dimension, actual targets, exact weights, algorithm,
reason and reviewer. Versions may be appended; original versions and historical
projections are not updated. Approval is an explicit FinanceReview action, not a
status inferred from preview. No pending draft is presented as approved.

The first explicit methods are `equal` and `manual_weights`. Weights are positive
canonical decimal strings with at most9 fractional places. They express the
operator's recorded allocation basis, not automatically retrieved sales, weight
or quantity. Convert once using the base run's original FX and rounding, then
split its reporting minor units using BigInt largest remainders. Equal remainders
use canonical target keys ascending. Zero shares remain explicit. Original effect
signs are preserved, including reversal mirrors. USD101/3 yields34,34,33;
EUR2minor at1/2USD becomes USD1minor before any split.

Sources are selected by root fact. The server expands the actual correction
family present in the original base and requires the complete current chain;
every family member uses the same target weights. A later correction requires
an explicit new base/version. It cannot silently move a reversal to another
target or overwrite an original occurrence date.

## Targets and calculation

Dimensions are `order`, `order_line`, `sku`, `listing`, `period`. Object targets
are resolved from actual tenant records to a minimal non-PII tuple and basis
checksum. A line pins its actual parent order, SKU/listing relationship. There
is no arbitrary caller-supplied order/line/SKU mapping. A period target is a
canonical UTC calendar month with explicit start/end; it is an analysis period,
not a change to the source occurrence date. Direct attribution on an object
dimension cannot also be allocated. Period allocation is an explicit analysis
rule and may differ from the original month.

Allocated profit runs pin the original run and an explicit version/checksum set.
One original contribution uses at most one selected version; selecting two
versions of a rule or overlapping source families is rejected. Direct evidence
is projected once. An unallocated contribution retains one full unknown-target
slice and makes the run incomplete. SQL independently checks the full original
contribution set, per-source sums, original amounts/signs, exact tail allocation,
real target lineage, version pins, total conservation and same-transaction audit.

Aggregate completeness is insufficient for a target profit claim. The projected
owner repeats required-fact and correction-aware coverage per real target.
Missing targets/costs keep totals and breakdown claims incomplete. History keeps
its original amounts and versions; separate current-basis diagnostics identify
new correction-chain facts, changed target links or superseding rule versions.
Order review must discover shared fees via actual allocation targets and group
SKU results by metric plus allocation-version-set checksum.

## Shared implementation contract

Main owns shared contracts/helpers, three-table Drizzle schema and migration156,
original-owner integration, page registration, runner, upgrade proof, docs and
final review. The backend agent owns the four new service/controller/read/target
files and the separate raw SQL guard suite. Frontend owns the new workspace
TSX/CSS, personal GET/POST BFF and the two existing order-review displays. QA owns
the new contract/API/UI/BFF/browser and order-allocation suites plus the two
explicitly authorized old source-identity fixtures. Each owner stopped writing
before the compiled source was sealed. Unrelated changes are preserved.

New tables are `finance_cost_allocation_versions`,
`finance_allocated_profit_runs`, `finance_allocated_profit_slices`; all are tenant
RLS and immutable with append-only versions. The first two bind the original
actor, canonical request/checksum and idempotency key. Protected source155 and
the ordinary148 database are not changed by isolated migration156 acceptance.

The `/v1/finance/cost-allocations` boundary exposes current FinanceRead for bases,
eligible source/root pages, minimal target pages, preview and history. Explicit
version approval and projection calculation require current tenant FinanceReview
and same-transaction audit. Preview computes no business write. Personal BFF and
UI retain identity/query generations, strict schema identity and bounded bodies.
Unknown write responses retain the original request/key; this is not yet a
cross-session financial command protocol.

## Open-source references

[ERPNext Cost Center Allocation](https://docs.frappe.io/erpnext/cost_center_allocation)
and its official allocation owner inform explicit allocation bases and preserved
rules. [ERPNext landed-cost implementation](https://github.com/frappe/erpnext/blob/develop/erpnext/stock/doctype/landed_cost_voucher/landed_cost_voucher.py)
illustrates quantity/amount allocation. No Python application or floating-point
allocation code is copied; the installed ERP owners and exact-money utilities
are reused.

## Validation and write locks

Application and SQL lock all selected rules, then source roots in stable order. Targets hold real orders/SKU/listing rows; append-only catalog links retain SELECT/INSERT grants. Their actual parent line is held FOR UPDATE, fencing concurrent FK-linked additions without expanding write privileges. Current tuples are resolved again after locks.

The same compiled source checked the changed order detail with real Finance and neutral order records. Original/attributed IDs remain separate and a new actual booked fee withdraws current profit verification. Verified financial evidence does not certify production or fulfillment. This does not substitute for the older full artwork fixture, real production, actual bank reconciliation or human acceptance. See the operation evidence and cleanup records linked from the progress page.
