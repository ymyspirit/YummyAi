# Workflow responsibility and durable in-app attention

R36 / B26 augments the existing workflow node and notification stores. It does
not create another business completion state. `/business-tasks` continues to
derive its business stages from the owning modules. Full cross-object task
assignment remains a separate B26 integration requirement.

The [workflow task inbox](workflow-task-inbox.md) now projects these existing
nodes into `/business-tasks`, with current assignment/scope, whole-filter counts,
timezone-aware deadlines and node navigation. It preserves order/sales modes;
other business objects still require B26 responsibility integration.

The [order-item follow-up slice](order-line-responsibility.md) now supplies the
order-owned responsibility/inbox contract. Other domains and full B26 admission
still require separate verification; the two domains share operator components.

## Ownership, authorization and deadlines

Migration `0112_workflow_responsibility.sql` adds an internal deadline, escalation
recipient/delay, responsibility revision and delivery checkpoints to existing
`workflow_node_runs`, plus notification deduplication keys and immutability guards.
Existing nodes keep responsibility revision zero and do not receive invented
deadlines or retrospective alerts. Normal business database rollout requires
its own migration/backup and acceptance; disposable test migrations are not a
production migration record.

`workflow:assign` is a separate permission. Review roles and grant it explicitly;
the migration does not expand any existing role. The operator also needs current
workflow/product read access and the product's actual data scope. Assigning a
node grants no permission. An assignee must have current workflow/product read,
notification read, workflow run, the node's declared permission and, for an
approval gate, workflow approval. Escalation recipients need current task scope
and read/notification access, without receiving execution authority.

The UI labels these dates as **internal** and accepts browser-local input,
converted to an offset-aware timestamp. Marketplace promises, production and
shipment dates remain owned by their business modules. An escalation needs an
assignee, deadline, a different recipient, and a delay of 1–10,080 minutes.
No escalation reassigns or completes a task.

## API and operator flow

- `GET /v1/workflow-runs/:runId/nodes/:nodeId/responsibility?q=...` returns the
  current arrangement, eligible member candidates and delivery checkpoints.
- `POST` on the same path requires `workflow:assign`, expected run revision,
  nullable assignee/deadline/escalation/delay and a reason. The run row is locked;
  stale updates return 409. Real changes append an immutable event and audit
  record and advance the responsibility revision. Identical arrangements are
  idempotent and do not issue another notification.
- The existing node inspector opens the existing guarded TaskDrawer. Member
  searches preserve selected IDs/labels; saving independently rechecks eligibility.
  Concurrent changes preserve the draft and require loading the current revision.
- Completed, skipped or cancelled nodes and completed/cancelled runs cannot be
  reassigned. Cancellation stops scheduling. Explicit rework increments an existing
  reminder cycle and preserves earlier notifications; legacy unconfigured tasks
  stay unconfigured.

The Web read BFF allowlists the responsibility path and a single bounded `q`.
Browser writes use the existing authenticated server action; no posted tenant or
candidate list can authorize an assignment.

Native page transitions observe readiness, completion and the DOM callback
separately. A skipped animation does not fail a successful update; actual callback
errors are still reported once and fail browser error checks. The same observer
is reused by workflow selection, dashboard attention, research media and the
sales-plan agent. See MDN on [readiness](https://developer.mozilla.org/en-US/docs/Web/API/ViewTransition/ready)
and [DOM callback completion](https://developer.mozilla.org/en-US/docs/Web/API/ViewTransition/updateCallbackDone).

## Delivery, recovery and privacy

The standard Worker owns `WorkflowAttentionScheduler` (60-second interval).
`WORKFLOW_CENTER_TENANT_IDS` is shared with the API: unset or `*` enables all;
an explicit comma-separated tenant list restricts execution. This is an existing
feature flag, not an off-by-default rollout switch.

The dispatcher loads eligible candidates by database time, locks workflow runs
with SKIP LOCKED, and limits each tenant pass to 100 nodes. Every recipient is
revalidated at delivery. Shared locks on current membership/role grants serialize
revocation with delivery. An approved standing arrangement survives its creator
leaving, but never bypasses the recipient's current scope.

Notification insertion and delivery markers commit atomically. A permanent
unique key `(tenant, recipient, workflow/node-run/responsibility-revision/stage)`
prevents duplicate inbox rows across process restarts. This follows the existing
[BullMQ idempotent job pattern](https://docs.bullmq.io/patterns/idempotent-jobs);
queue retry/deduplication alone is not the durable business receipt.

The current stage is delivered: before the deadline, assignment; at/past the
deadline, due; after the configured delay, a separate escalation recipient. A
late dispatcher does not send an obsolete assignment alert. Unavailable recipients
are retried after five minutes so they do not monopolize the oldest page.
Recoverable per-node failures roll back that node's insertion/markers, persist a
generic failure/backoff and leave other candidates available. Database-wide
failure rolls back the transaction and is reported by the standard scheduler.

Messages contain generic task text, workflow/node-run IDs, revision and stage.
They omit buyer data, product titles and the operator's reason. Task links reread
the current object through authorization. Previously delivered messages remain
historical records; current task access can still be revoked. No email, customer
message, marketplace publication or external transaction is sent by this feature.

## Notification inbox

`GET /v1/notifications/inbox` accepts strict `unreadOnly=true|false`, `limit=1..100`
(default 30) and an optional own-notification UUID cursor. Results expose filtered
total, current-user global unread count and next cursor. Paging uses the original
PostgreSQL timestamp and UUID tuple, without losing sub-millisecond precision.
Foreign-user/tenant cursors are rejected or hidden by RLS. Existing list API remains.

`PATCH /v1/notifications/:id/read` preserves the first read time; `PATCH .../read-all`
updates only the authenticated user's unread records. `/api/notifications` exposes
the inbox through a fixed private/no-store BFF, with same-origin empty JSON writes,
size/path/query validation and sanitized failures. Notification bodies cannot
supply arbitrary navigation URLs. Supported workflow links use
`/workflows/runs/:id?task=:nodeRunId`; the run resolves the node after authorization.

The dashboard and workflow run toolbar expose the same inbox, so a task operator
does not need dashboard permission to read notifications. It fetches authoritative counts and supports paging, unread filtering,
single/all read and refresh. Writes are reflected after server acknowledgement
and reread. Denial clears private rows; transient errors remain explicit. Demo
dashboard notifications cannot write to the live inbox. Reading a notification
never changes workflow completion or approval state.

## Verification

Use `pnpm test:e2e:order-daily --suite=workflow-responsibility-integration` for
real SQL/RLS, concurrent dispatch, current grants and inbox persistence. Use
`--suite=workflow-operator` for existing operator flows plus responsibility/inbox
browser tests (API 8120, Web 3124, demo disabled, independent Web cache). Only the
needed worker/dispatcher is used; no normal full Worker or external messenger.
The guarded runner owns and verifies deletion of every disposable DB, bucket,
Redis instance and Web snapshot, including failed test attempts. Delivery records
must distinguish integration, rendered UI, business acceptance and release.
