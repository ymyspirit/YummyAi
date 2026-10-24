# Order design original calls, fees and private retention

2026-10-18 · R20 / R39 / H06 · B28 / B32. This extends the existing
[order design completion](order-design-completion.md) and original budget ledger.
It does not add a payment connector, verified provider bill or production approval.

## Original submission and receipt

Migration `0124_order_design_model_cost_receipts.sql` adds
`order_design_model_calls`. In the original guarded submission transaction, each
paid step records its run, step, request, actual database attempt, claim token,
requester and original reserved budget row. No request bytes, buyer information,
prompt, image hash, object key or private encryption key belongs in this table.
Tenant RLS and composite references remain mandatory. Historical calls are not
backfilled from estimates or inferred from a finished task.

When the original provider call returns, the worker first records its minimal
fee receipt in a separate owning transaction. The original run/request/step/token
and budget identity must match. A matching duplicate is a read-only replay;
conflicting amounts or another claim's receipt are rejected. The original call
identity and received report are immutable, including through SQL updates.

This financial receipt remains recordable after takeover, execution permission
withdrawal or private-key destruction. It does not restore a lease, revive a
cancelled task, adopt a late image or authorize another request. Private response
capture and result adoption keep their original retention, source, lease,
method, membership and current permission checks. Rejected response buffers are
cleared; no private response checkpoint is created after private retention ends.

## Amounts and budget ownership

Provider reports and the run's actual-cost projection retain up to eight USD
decimal places. Missing reports are `unknown`; invalid, negative, non-finite,
over-limit or more precise reports are `invalid`, never a fabricated zero.
An explicit reported zero is a known zero. These are service reports, not
independently verified invoices.

The existing budget ledger uses six decimal places. Positive amounts round
upwards for budget occupancy: a report of `0.00000001 USD` remains exactly that
report and occupies `0.000001 USD`. A first valid original receipt commits the
same original reservation, including a legitimately released reservation; only
the tied receipt transaction may use this settlement path. Original creation
time, requester and monthly attribution do not change. Ordinary terminal budget
updates remain forbidden; the prior assist manual-reconciliation path remains.

The run's known total sums incurred original calls, independently of planned
future calls. An incurred call without a known report keeps the total unknown.
An unsubmitted future step does not erase an already known fee. Before another
paid call, the worker rechecks original per-order, current task and monthly
limits using existing reservations and committed costs. A report exceeding the
original cap is retained, but the next request is blocked; resuming cannot raise
the pinned cap or buy the same result again.

## Private history and financial reads

`GET /v1/order-centers/lines/:id/design-agent` keeps the full representation.
`?view=financial` explicitly requests the existing status and minimal fee
representation without decrypting private snapshots or requiring method-library
read access. Both require current tenant-scoped `order:read` and
`order:pii:read`; neither query parameters nor a claimed tenant select authority.
Unknown/duplicate query fields are rejected by API and Web BFF. The view option
is not accepted on recovery, resume or takeover writes.

The DTO exposes only original call IDs, attempt, timestamps, report state,
eight-place report and six-place budget state/amount. It never includes the
internal claim token or private content. At most the latest 1,000 calls are
returned, with an explicit truncation flag. The run total remains authoritative.

Full reads check the database clock, current work key and order anonymization,
then recheck private availability before returning. Expired/anonymized and
financial-only responses omit method/rule snapshots, technical completion,
step history, quality details and response-recovery data. Resume and takeover
are unavailable in that representation. No raw artwork is recovered for a fee
read. Published method history still separately requires `workflow:read`.

If the normal private order detail cannot be read, the artwork drawer offers
the read-only status/fee panel through the financial representation. It refreshes
under current permissions and clears prior content after a failed read. Request
generation and transition cancellation prevent an older successful response or
visual snapshot from restoring content after denial.

## Verification and deployment boundaries

Model configuration revisions now use PostgreSQL `clock_timestamp()`, matching
the clock used by template authority instead of mixing API-host dates with
database-created versions. A controlled application-clock-ahead regression
first reproduced a future configuration timestamp and then passed with database
timestamps. The existing post-template configuration-change gate is unchanged;
this does not approve or replace a changed model route.

- Unit source: `packages/order-design/src/model-costs.test.ts` and the order BFF
  route tests cover precise totals, budget rounding and restricted view queries.
- Integration source: `apps/api/src/orders/order-design-agent.integration.test.ts`
  covers real key purge, reported zero/tiny/unknown/invalid amounts, duplicate and
  conflicting receipts, original budget/SQL guards, takeover, incomplete future
  calls, financial-only reads, tenant/permission isolation and current expiry.
- Browser source: `apps/web/e2e/design-agent.spec.ts` checks expired artwork,
  exact fee evidence, desktop/mobile layout, reload, denied reads and a withheld
  old success response through the real local authenticated API/Worker/UI path.

The acceptance runner owns disposable databases/buckets/Redis namespaces. Model
transport and fee values are synthetic; no paid provider or historical billing
API has been verified. Ordinary development/business databases are not migrated
by these tests. Deployment, provider verification and full B28/B32/business
acceptance remain separate requirements. Frozen verification results belong in
the current delivery report, not inferred from these source descriptions.
