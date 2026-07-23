# Finance integration

P3-D normalizes authorized financial statements into immutable facts and
calculates profit from explicit evidence. It does not authorize stores, retrieve
credentials, infer costs, or silently choose unsupplied exchange rates.

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
