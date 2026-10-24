# Advertising aggregation and profit coverage

This change makes the scope of operating numbers explicit. It does not add advertising execution, report downloads, automatic financial imports, or marketplace writes.

## Advertising

The advertising workspace groups source rows by provider, account, source scope, currency, attribution window, and entity level. A mixed campaign/keyword/search-term report is split by level. These groups must not be added together: different levels can describe the same spend, and keyword/search-term evidence need not cover the whole account.

Within a group, only reports with non-overlapping periods can be summed. Identical, nested, partially overlapping, and boundary-touching periods suppress the group total; source report rows remain visible. The system does not infer which overlapping report should win. Source period boundaries are treated conservatively as inclusive because the existing contract does not encode exclusive endpoints. Amounts in different currencies are never converted implicitly. Unsafe integer totals are withheld. ROAS is shown as a multiplier.

`AdvertisingReportView.totals` is nullable. It is null when a report contains more than one entity level or when its totals exceed the safe integer range. Consumers should use source rows and the shared `summarizeAdvertisingReports` function, rather than adding report totals. A report with no source rows is not trusted as an aggregatable number. Stored reports and source rows are unchanged.

## Profit calculations

`POST /v1/finance/profit-runs` accepts optional `coverageDimension`:

| Value | Coverage required |
| --- | --- |
| `order` (default) | Each represented order has every required fact type; all facts are assigned to an order |
| `order_line` | Same checks per order line |
| `sku` | Same checks per SKU |
| `listing` | Same checks per Listing |
| `aggregate` | Required fact types exist in the selected batch of statements; no claim of per-order or per-SKU completeness |

Choose the grain that matches the attribution of the source evidence. For example, a monthly unallocated advertising invoice can be included in an explicitly selected aggregate calculation, but cannot silently be apportioned across orders. Known zero costs can be recorded as explicit zero facts. Optional costs stay optional according to the immutable metric version; completeness is not a claim that every real-world cost has been discovered.

Coverage diagnostics contain the chosen dimension, checked entity count, required fact types missing from each entity, and unassigned fact IDs. The chosen dimension is included in the calculation checksum and persisted in the existing immutable diagnostics JSON. Reusing an idempotency key with another dimension fails. No database migration is required.

Coverage examines selected financial evidence, not all marketplace orders. Original facts reversed within the selected input no longer satisfy required types; a replacement can satisfy them. Reversal rows remain in monetary calculations. Every represented entity remains subject to coverage checks. Missing FX, unclassified facts, missing required types, missing entity coverage, or unattributed facts leave totals null for object-level calculations.

Only the verified dimension receives profit breakdowns. Aggregate calculations expose batch totals but no unverified entity breakdowns. Historical calculations without coverage diagnostics remain immutable in storage; API and UI withhold their old totals and label them for recalculation. This read-time safeguard is intentional: an old `complete` label did not establish object-level completeness.

The shared `isFinanceProfitVerified` guard is also used by business AI comparisons. Both reports must pass coverage and use the same grain, metric version, and currency. Business AI receives the coverage diagnostics and explicit limitations. Two pinned reports being comparable does not establish period growth or causation.

## AI budget settlement discovered during integration

The isolated integration run also exposed a pre-existing production mismatch: AI assist services updated budget reservations, but the initial ledger migration granted only SELECT and INSERT. Migration `0087_ai_budget_settlement_permissions` grants UPDATE only on `state` and `amount_usd`, preserving forced tenant RLS and the nonnegative amount constraint.

A database trigger allows `reserved -> committed` with confirmed actual cost or `reserved -> released` with the reservation amount unchanged. Replaying the exact same state and amount is a no-op. Terminal state changes, terminal amount changes, reservation resizing, and changes to identity/provenance fields are rejected. This does not grant DELETE, full-row UPDATE, or tenant bypass permissions. Tests exercise both the real worker path and permission/transition boundaries; no temporary test-only grants are used.

## Verification

Regression cases cover mixed currencies and entity levels, overlapping advertising periods, one order missing production cost while another has it, unassigned costs, reversals, explicit aggregate use, legacy results, and incompatible AI comparisons. Integration suites must run in the isolated test database; production or real business databases are not acceptable test targets. Existing immutable fixture history is removed by disposal of that isolated database.

Operational acceptance still requires reconciliation with real authorized reports: verify report scope and interval semantics, ensure costs are assigned to the intended objects, and compare each checked order with supplier and carrier evidence. This change does not invent allocation policies or replace that reconciliation.
