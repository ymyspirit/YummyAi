# Order workbench verification

Artwork review acceptance (2026-09-15): `order-artwork-review.spec.ts` uses the real
orders and artwork pages with isolated in-memory transport. It covers immediate
current-sheet display, desktop/narrow layouts, fit/original-size viewing, rejection
reason validation and retention after failure, approval, stale/missing images,
failed image retry, white-background preview creation and resolution blockers.
`order-artwork-review-model.test.ts` covers sheet selection. The order workspace
integration suite covers version mismatch, tenant/review permissions, rejection
reason persistence, replay safety and invalidation of production approval. Run
integration tests against a disposable database and remove it after completion;
the UI fixture writes no business data or AI jobs.

Apply database migrations before starting the updated API and Web. Migration
`0083_order_workbench.sql` is additive; the first list query refreshes legacy
non-PII search metadata under tenant isolation. No model-provider configuration
or platform authorization changes are required.

Stop the active Next.js development server in this worktree, then run:

```powershell
pnpm exec playwright test --config apps/web/playwright.order-workbench.config.ts
```

The scoped suites run real ERP routes with test-owned in-memory order transport
and all demo flags off. They reuse the local authenticated API for the shell and
start Web on 3100; they never create customer orders, invoke paid AI, or submit
marketplace/factory actions. Screenshots and traces go to
`tmp/order-workbench-e2e`. Restart the ordinary Web development server afterward.

The configuration return regression holds a synthetic read request in flight and
verifies return to the exact order queue. Configuration reads can be cancelled
when leaving; writes, active model selection and unsaved drafts remain guarded.
The included configuration suite verifies that removal/save protections persist.

Backend coverage is in `order-workspace.integration.test.ts`: full-result counts,
exact batch searches, date boundaries, tenant isolation, current-version package
label coverage, reversible archival and immutable draft history. Run against an
isolated database/bucket with exact resource IDs tracked and failure-safe teardown.

Manual acceptance should check the normal `/orders` page and a narrow viewport:
queue counts, delayed store options, calendar bounds, no horizontal overflow,
continuous review, explicit missing-summary errors, and the current artwork
version's task/check status. Use only read-only actions on real orders.

List and option reads retry one transient network/502/503/504 failure after 300 ms,
within a shared 15-second browser deadline. The list proxy limits its upstream read
to 12 seconds and propagates browser cancellation. Writes are never automatically
replayed by this recovery path. An unavailable list shows an explicit error and a
reload action, not zero orders or an empty-result message. Queue switching, reset,
and independent filters remain usable after failure; a selected store stays in
the query even when its option list cannot be loaded.

Status cards, filters, pagination and review-drawer parameters use native browser
history for changes within the same workbench page. Next.js keeps `useSearchParams`
in sync without requesting the server page again. Opening report import or another
module still performs normal navigation. Browser back/forward restores the query.
Clicking the already selected status does nothing; use **刷新** to reread it.
While a list request is pending, the last known queue counts remain visible and
cards remain available so the operator can choose another queue. The superseded
request is aborted, and its result cannot replace the later selection. Selection
and primary processing actions stay disabled until the query finishes; unsaved
edits and active writes retain their existing navigation guards.

Local-switch verification on 2026-09-15: the 16 workbench/review browser cases
passed, including no document/RSC requests during queue changes, back/forward,
stable counts during a held request, duplicate-click suppression and cancellation
of a superseded request. The other 24 scoped browser cases passed in the broader
run. Web typecheck, scoped lint and the ten read-helper unit tests passed. These
tests used disposable in-memory order transport and created no business records.
The restored local browser switched nine pending items to one in-progress item and
back with counts continuously visible. Clicking the selected in-progress card again
issued no additional list request. The two queue changes requested only workspace
and summary data, without a new `/orders?stage=...` page request.

Recovery verification on 2026-09-15: 13 focused unit tests passed, along with the
35 existing browser regressions and two new gateway/retry browser scenarios. The
new scenarios use only the in-memory transport fixture; no business records or
model jobs are created.

On 2026-09-15 six exact historical `E2E-CENTERS-*` fixtures were archived through
the authenticated service. Verification found zero matching active items in all
five operational queues and ten remaining real order lines. Their original import
reports, account references and immutable fulfillment/file history were retained,
not deleted. The exact IDs and replay keys are in the local cleanup manifest at
`tmp/order-workbench-cleanup.json`; do not broaden cleanup by an ambiguous name
match. Restore is supported, and restored records remain paused.

Verified on 2026-09-15: 48 integration tests and 35 scoped browser tests passed.
API, Web, Worker, database and canvas-runtime typechecks, scoped lint, project-rule
checks and whitespace checks passed. Both light/dark desktop views and the
390-pixel layout were visually checked. This is a workbench verification, not a
full release-candidate check or a production-artwork approval.

## Order read performance

Apply `0084_order_report_read_models.sql` before the updated API/Worker. Its
encrypted summary and thumbnail projection is populated by new imports or the
first authorized read of an existing version. Initial backfill may take seconds;
subsequent summary reads do not load the document or ZIP. The existing versions,
customer files and artwork remain unchanged. The list requests 320 px thumbnails;
the image dialog requests the full file only when opened. Both paths retain
current-version checks, tenant/PII authorization, expiry and private/no-store.

The 2026-09-15 local comparison used the same nine pending order lines. Their
summary endpoint took 2,012–2,208 ms before the change and 122–128 ms after the
derived rows were populated; list queries took 44–46 ms. The ten active source
documents total 107,046,925 encrypted bytes and their ZIP envelopes 33,766,747
bytes. Their derived metadata totals 26,376 encrypted bytes. All 17 pending-list
thumbnails were fetched in 364 ms in the local API probe. These are local API
measurements, not a guarantee of browser loading time or remote deployment speed.
The first nine-row backfill took 3,064 ms; it runs once per source version.

Coverage includes warm reads avoiding source decryption, unchanged source bytes,
legacy backfill, thumbnail dimensions, stale versions, tenant/PII denial and erasure.
All 39 scoped service integration tests and seven report-proxy unit tests passed.
The isolated test database and bucket were removed in failure-safe teardown.
The 37 existing scoped browser cases passed, and the added thumbnail/dialog case
passed after its assertions were normalized for absolute browser URLs and repeated
development image requests. API/Web/Worker/database typechecks, scoped lint and
project-rule checks passed. The ordinary Web runtime was restored on port 3000.
Live browser switching showed 10 total, nine pending and one in-progress item;
the pending summary proxy returned in 158 ms after switching. Displayed thumbnails
used `thumbnail=1` and were at most 320 px; off-screen images remained lazy-loaded.
