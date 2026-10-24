# Fulfillment attention in the operations dashboard

The home page's unified action center reads current logistics, production and
factory-receipt work independently of the historical dashboard date range. It
links to the original business record. A page load, refresh, focus or filter
change never creates a task, calls a carrier, changes an approval or buys a label.

## Read contract

`GET /v1/dashboard/fulfillment-attention?source=all&page=1` uses the shared
`@yummyai/contracts/operations/fulfillment-attention` contract. Sources are
`all`, `logistics`, `production` and `delivery`; pages contain 12 items. Counts
cover the entire eligible queue, not a sample of recent records. Ordering is
blocked work, overdue work, then pending work, with deterministic time/source/ID
ties. Each request reads counts and items from the same SQL statement/snapshot.
Concurrent business changes can move rows between pages; refresh starts from
the current state. An empty later page offers a return to page one.

The query runs in `withTenant()` using forced RLS. `DashboardRead` is mandatory.
All fulfillment sources require tenant scope, `OrderRead` and `OrderPiiRead`,
matching their destinations. Factory delivery additionally requires `DesignRead`
and `AssetRead`. Unavailable source counts are `null`, never a fabricated zero;
explicitly requesting such a source returns forbidden. The projection selects
only IDs, states and timestamps. It does not decrypt customer data, include
carrier error text or return production files, addresses or label URLs.

The same-origin Web proxy is `GET /api/dashboard/fulfillment-attention`.
Unknown/duplicate query keys are rejected, errors are sanitized and all results
use `Cache-Control: private, no-store`. Failed reads show a retry state and clear
old results. Home-page filters and pagination persist in `attention` and
`attentionPage` URL parameters. Visible pages refresh at most once a minute and
on focus; requests are aborted on navigation.

## Sources and resumption

| Source | Included work | Resume behavior |
| --- | --- | --- |
| Logistics | Pending/quoted, attention, uncertain purchase/label results, created orders awaiting labels | Opens `/logistics?task=<id>` through the task's direct GET, including tasks outside the recent-list limit; reloading cannot redispatch |
| Production | Past expected completion with an active stage, failed, quality hold, cancellation awaiting confirmation | Opens the original order and line in production; new factual milestones still use existing evidence and version gates |
| Factory receipt | Latest package for the current production version: pending submission, submitted, received or rejected | Opens the order drawer and exact package with `delivery=<package-id>`, loading it directly when outside recent history |

Logistics work with a live execution lease is excluded until the lease ends.
Completed/cancelled logistics tasks and accepted packages leave the queue.
Factory rejection is one actionable receipt item, not a second generic
production-failure item. Members who cannot read delivery retain the production
exception they are authorized to view. Changed drafts or production versions
cannot reappear as packages ready for submission.
Production records superseded by an active replacement, and delivery records
for cancelled, paused, archived or expired work, are excluded. Historical
packages and feedback remain immutable. Uncertain logistics records remain
visible for reconciliation even after an order cancellation; the queue exposes
no private snapshot. Logistics rows show their last update, not an inferred
deadline from the encrypted address/package snapshot. Exact shipping constraints
remain visible in the authorized task page.

The dense white/blue UI uses existing Lucide icons, keyboard focus states,
responsive rows, entry/exit transitions and native View Transitions when
supported. Reduced-motion preferences disable motion. There are no new database
tables, credentials or environment variables.

## Verification

- `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
- `pnpm test:e2e:order-daily --suite=logistics-integration`: tenant/domain scope,
  full counts and pagination, active-lease exclusion, private error suppression,
  overdue production, receipt progression and removal after acceptance.
- `pnpm test:e2e:order-daily --suite=logistics`: real authenticated Web/API paths,
  dashboard to original-task recovery, unavailable-read retry, desktop/narrow
  layouts, exact package reopening, label/ZIP integrity and no duplicate carrier
  order. The fixture represents uncertainty after a synthetic carrier commit.

Stop the normal Next/API processes before browser acceptance. These commands
own disposable database, bucket and Redis resources and clean them in `finally`.
Restore the normal runtime using `pnpm start:local` afterward.

### 2026-10-13 acceptance record

Verified with Node 24.17.0 and pnpm 11.10.0:

- Repository lint, typecheck, unit tests and build passed.
- Full integration run passed all five workspace tasks; the API run passed
  791 tests across 114 files. The focused logistics/delivery integration run
  passed 43 tests across three files.
- The authenticated logistics/production browser suite passed all five cases,
  including desktop and 390 px layouts, exact-task refresh/reconciliation,
  failed-read retry, exact-package reopening and separate front/back artwork.
- The isolated carrier recorded one created order and one lookup, with zero
  duplicate creates and zero forbidden requests. Labels and delivery ZIPs were
  verified using the synthetic transport; no live carrier purchase was made.
- The integration and browser runs deleted their disposable database, bucket
  and Redis resources with no cleanup errors. Earlier interrupted runs were
  also checked and cleaned. Screenshots and test logs remain under `tmp/` as
  local acceptance evidence, not business records.
- Normal local services were restored and `check:local-runtime` passed.
  The real home page loaded its authorized queue, and reloading preserved the
  selected logistics filter. Canvas uses the configured loopback port 4177 on
  this machine because port 4176 is occupied by another application.

This records local acceptance of the change. It does not certify upstream
Ivyea runtimes or account API compatibility, and it is not a CI/release result.
