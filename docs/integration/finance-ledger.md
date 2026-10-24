# Finance and payable ledger reading

This slice adds a read-only history reader to the existing Finance and Payables
owners. It does not replace their writes, establish a new cost store, execute a
bank action or implement expense allocation. The existing bounded workspaces
remain compatible. The new reader is independent of their 100/500-row previews.
Targeted local acceptance passed:215 unit,120 distinct isolated and3 compiled personal browser cases. This is not ordinary-runtime or full-platform acceptance; see [the current checkpoint](../project-control/FINANCE_LEDGER_PROGRESS_20261021.md).

## Records and relationships

The fixed kind allowlist covers the seven Finance tables (statements, facts,
FX rates, metric headers, metric versions, profit runs and contributions), the
seven Payables tables (bills, payments, allocation batches, allocations,
releases and both adjustment ledgers), and actual approved procurement-source
projections. Batch evidence preserves its original allocation order. Procurement
format diagnostics preserve the actual record/review IDs instead of manufacturing
an amount or a selectable source.

`GET /v1/finance/ledger/:kind` accepts only `limit` (default25, max100), an opaque
`cursor`, and a supported `parentId`. `GET /v1/finance/ledger/:kind/:id` accepts
only a supported `parentId`. Query duplicates and caller-selected tenant/user
fields are rejected. The shared contracts and parent matrix are defined in
`@yummyai/contracts/finance/ledger`. Procurement requires the actual bill as its
parent and includes the authorized original `billCurrency` in detail.

Statement detail contains its original header and a paginated facts relation.
Profit detail first uses the existing complete verification owner, including
legacy monetary/source withdrawal, then projects a header without contributions.
Its contributions have a separate paginated relation. A header is not passed
to the client-side full-run verifier or reconstructed from currently loaded
child pages. List summaries do not repeat old stored profit status or totals.

## Cursor and live data

Records use strict descending original UUID order, explicitly labelled as
registration-ID order rather than business-time order. This reuses existing
unique IDs and avoids losing legacy PostgreSQL microseconds through JavaScript
Date conversion. Each continuation fixes the initial upper ID bound and its
last actual row. The list never uses offset or a caller-provided table name.

The internal versioned cursor is canonical base64url JSON with a query-scope
digest, upper ID and last ID. Its scope binds current tenant, person, kind,
parent and page size; anchors must exist in that authorized query. It is an
unsigned pagination position, not an authorization token or cryptographically
tamper-proof claim. Every request rechecks current membership, the session/current
permission intersection, tenant-scoped FinanceRead and forced RLS independently.

Pages are live, not a retained MVCC/export snapshot. Records committed during
browsing can require a refresh, including a later insertion with a lower ID.
The UI does not invent a total or claim that the loaded rows represent all
current data. A failed continuation retains the same original cursor for retry;
changing the collection or parent starts a new traversal.

## Money, privacy and UI

Bill/payment balances and source gates use the full ledger inside the current
authorized transaction. A release, credit or refund outside the visible page
still affects current capacity. Adjustment `balanceAfter` remains the original
execution snapshot and is never replaced by a current balance. Original source
money and contribution evidence do not by themselves establish verified profit.

The personal ERP exposes `/finance/ledger` and a GET-only same-origin BFF at
`/api/finance/ledger/...`. The BFF validates query/result identity, parent,
page size, strict ordering and children, bounds upstream JSON, checks continuation upper/last positions and the exact next-row anchor, and returns
private/no-store responses. Source bodies, request identities, keys and audit
internals are not spread into responses. The UI fences list/detail requests
and animations by authority and query generation and clears private state on
identity or permission changes. Long IDs wrap at desktop and390 widths.

## Verification and adoption

Dedicated disposable suites are `finance-ledger-integration` and
`finance-ledger-browser`, guarded by `E2E_FINANCE_LEDGER_ISOLATED`. They reuse
the actual approved-source fixture guards. They do not start ordinary services.
No database migration or new production environment variable is required by
this read-only slice; the existing155 owner/ledger schema is its dependency.
Ordinary148 and its stopped applications remain unchanged. The previous
rejected ordinary Web startup is not retried.

Open-source implementation reference: [Drizzle keyset pagination](https://orm.drizzle.team/docs/guides/cursor-based-pagination).
The implementation uses the installed Drizzle and existing ERP components;
it adds no pagination library or parallel financial fact model.
