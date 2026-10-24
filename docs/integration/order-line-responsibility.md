# Order-line fulfillment follow-up, responsibility and inbox

R36 / B26 reuses existing order lines, order work, production, physical shipment,
after-sales and immutable exception events. One arrangement follows one existing
order item through its current fulfillment step. It is not a separate business
completion state or a per-exception case assignment. Workflow responsibility
continues through [its owning module](workflow-responsibility.md).

## Ownership and controlled rollout

`packages/order-core` owns the shared canonical order read projection and this
follow-up coordination for API/Worker. The API's earlier workspace-query module
re-exports the same projection. Whole-order progress still aggregates every item
before search/paging; label creation and marketplace acknowledgement do not prove
physical handover. Actual business commands stay in their original services.

Migration `0114_order_line_responsibility.sql` adds a tenant-isolated sidecar
`order_line_responsibilities`, keyed by the existing work-item ID. It stores only
assignee, internal deadline, escalation, revision, reason code and technical
notification checkpoints. There is no completion/status column, order backfill,
automatic assignment or retrospective role grant. Forced RLS and composite tenant
foreign keys apply under the non-owner application role and `withTenant()`.

API and standard Worker both use `ORDER_RESPONSIBILITY_TENANT_IDS`. Empty/unset
disables this new feature. Set explicit comma-separated tenant UUIDs, or `*` only
for a deliberately approved all-tenant rollout. Apply migrations, back up/verify
restore, review actual roles and restart the relevant processes before normal
rollout. Disposable acceptance migrations do not prove normal deployment.

`order:assign` is separate from order editing. Read/management requires current
`order:read`, `order:pii:read` and tenant scope; management also needs
`order:assign`. An assignee needs current order write/read/PII and notification
read, with tenant scope. An escalation recipient needs current read/PII and
notification access. Assignment never grants these permissions. Current role
grants intersect authenticated request grants; membership/role locks serialize
updates and delivery with revocation.

## Arrangement API and operator flow

- `GET /v1/order-centers/lines/:id/responsibility?q=...` reads the current
  arrangement, actual task, source checksum, business versions, current eligible
  candidates and delivery checkpoints. The member query is literal and at most
  100 characters; candidates are bounded, with selected names retained separately.
- `POST` on the same path requires `expectedRevision` (zero before configuration),
  `expectedSourceChecksum`, nullable assignee/deadline/escalation/delay, and one
  reason code: `initial_assignment`, `handoff`, `deadline_update`, `correction`.
  There is no arbitrary buyer/free-text reason field. A lock on the original work
  record serializes arrangements. Stale arrangement or business evidence returns
  409; identical arrangements do not create another revision or notification.
- Arrangement and audit commit atomically, without updating the parent's business
  revision, manufacturing deadline, projection version or fulfillment status.
  Closed/archived/cancelled work and expired/unavailable work cannot be assigned.
  An existing open order-level exception becomes “核对订单级异常”; its resolution
  still belongs to the existing order exception API and immutable event history.
- In **工作台 → 业务任务 → 订单与履约**, open the actual item and expand
  **本件履约跟进安排**. The existing guarded drawer handles member lookup, local
  deadline input, reason selection, unsaved edits and explicit conflict reload.
  The shared editor is also used by workflow responsibility. Internal deadlines
  stay separate from manufacturing and marketplace ship-by dates.

Escalation needs an assignee, internal deadline, different recipient and delay of
1–10,080 minutes. It neither reassigns the task nor approves production. Current
permission denial clears sensitive editor data; conflict preserves the draft.
No new identity or key material is supplied by browser input.

## Read-only task inbox

`GET /v1/order-centers/tasks` and private/no-store `GET /api/order-centers/tasks`
use `OrderTaskInboxQuerySchema`, reusing the common task filter contract with
workflow tasks. Assignment is `mine` (default), `unassigned` or `visible`; status
is `open`, `closed` or `all`. Due filters `overdue`, `today` and `unset` require
open status; `any` is unrestricted. Search is literal, at most 200 characters,
over order/line IDs, product title, shop, SKU and assignee. Page is 1–1,000,000,
page size 1–100 (default 25), sort deadline/updated with stable item-ID ties.
`timeZone` is validated in both JavaScript and PostgreSQL; the browser records its
zone in the URL. Unknown/duplicate parameters and caller-selected tenant/assignee
scope are rejected.

After reloading current membership, a read-only repeatable-read tenant transaction
uses one materialized filtered projection for both page rows and full-filter
counts. Database time pins `asOf`; calendar-day bounds follow the selected zone.
Counts cover order items, not whole orders, workflow nodes or sales plans, and
summary categories can overlap. Open/closed comes from current business progress
and real exceptions. Archived/cancelled items appear under closed without claiming
successful fulfillment. Expiry does not complete a task: unavailable or not-yet
prepared work remains explicit and no work record is created by reading.

The list links to `/business-tasks?object=order&target=:lineId` while retaining
filters/page. Returning rereads current data. If the page is empty, the existing
first-page action is shown. Old bare `target` links remain supported, as do the
original order center and sales-plan mode. The order center remains reachable
when the new feature is disabled. Shared filters, table/mobile layout, timezone,
page controls and transitions are reused with the workflow inbox.

Visible lists refresh every 30 seconds and on restored focus/visibility/history.
An authorization rejection clears rows/counts on the next response; this is not
push-based immediate revocation. Browser reads never dispatch, assign, manufacture,
ship, resolve an exception or migrate historical records. Both responsibility
and inbox BFFs validate strict success payloads and return sanitized failures.

## Durable reminders, recovery and privacy

The standard Worker registers `OrderLineAttentionScheduler` at a 60-second
interval with overlapping runs prevented and graceful shutdown. The dispatcher
checks enabled tenants and at most 100 due arrangements per tenant, locking the
original work rows with `SKIP LOCKED`. It batch-reads actual business projections.
Standing arrangements become eligible for another check after five minutes to
observe changes or restoration; actual delivery depends on scheduler availability
and the per-pass bound. This is bounded polling, not immediate notification.

Each source-projection change advances a technical reminder cycle; it does not
change business state. Assignment is sent before the deadline; overdue dispatch
sends the due stage directly, with escalation after the configured delay. A late
dispatcher does not send obsolete assignment notices. Generic error codes/backoff
keep unavailable recipients from monopolizing the page.

Current recipients are reauthorized on delivery. Notification insertion and
checkpoint changes commit together. Persistent deduplication keys include item,
arrangement revision, cycle and stage, surviving scheduler/process retries. A
per-item savepoint rolls back both notification and marker on failure while other
valid items continue. Full transaction failure is reported by the scheduler.

Messages contain generic text and IDs/revision/cycle/stage only. No product title,
buyer data, free-text reason, key or raw prompt enters notifications. Links derive
from validated local resource IDs, never a URL in notification metadata. The
business task toolbar shares the existing durable notification inbox, including
users without dashboard permission. Read status does not complete a task.

Work-key unavailability or expiry stops new notifications and scheduling. Existing
notification history stays generic; opening any link rechecks current access.
Automatic resume after legitimate privacy-source reimport is not claimed by this
slice and still requires its own explicit recovery contract. No external message,
marketplace publication, paid model call or production approval is performed.

## Verification and remaining scope

Use `pnpm test:e2e:order-daily --suite=order-responsibility-integration` and
`--suite=order-responsibility`. Fixtures provision synthetic source data only;
browser responsibility, exception and archival actions use actual authenticated
API paths. The isolated runner owns migration, database/bucket/Redis and separate
Web cache lifecycle. It tears down immutable synthetic history with the whole
disposable database. Full normal Worker startup, production migration and real
store/factory acceptance remain separate.

Verify workflow browser regression after changing shared editor/inbox components.
Other B26 business objects, specific exception ownership, actual role admission,
full Harness, external services and release gates remain incomplete. This
integration is a further part of the original 48-requirement/54-package plan.
