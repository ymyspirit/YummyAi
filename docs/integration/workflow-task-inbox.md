# Workflow tasks in the business workspace

R36 / B26 reuses `/business-tasks` and existing workflow node runs. One row is
one real node task. Opening, searching, sorting and paging the inbox are read
operations; they do not dispatch work, migrate a legacy run, assign responsibility
or complete a task. This is the workflow part of B26; other business objects
still need their own responsibility, deadline and exception integration.

The parallel order-item integration is documented in
[order follow-up](order-line-responsibility.md). Both reuse common inbox filters
and operator components while retaining their own actual business states/counts.

## Entry and navigation

The bare `/business-tasks` opens workflow tasks. The business-object selector
preserves explicit `object=order` and `object=sales_plan` entry points. Existing
links with `target` but no object continue to open orders. Unsupported object
values show an error instead of silently selecting a different business object.

Workflow links target `/workflows/runs/:id?task=:nodeRunId`, with prefetch disabled.
The owning run rereads current authorization and selects the actual node. Returning
keeps URL filters and page; a completion that removes the last row of a page shows
the new total and a first-page action without silently changing the saved location.

## Read contract and scope

`GET /v1/workflow-runs/tasks` and the private/no-store Web BFF
`GET /api/workflow-runs/tasks` share `WorkflowTaskInboxQuerySchema`. The static
API route is registered before `/:id`. Unknown keys, duplicate keys and invalid
combinations are rejected; no query can supply a tenant or assignee identity.

| Query | Allowed values and defaults |
| --- | --- |
| assignment | `mine` (default), `unassigned`, `visible` |
| status | `open` (default), `closed`, `all` |
| due | `any` (default), `overdue`, `today`, `unset`; specific due filters require open status |
| q | Trimmed literal text, at most 200 characters; task/run/product/assignee titles only |
| page / pageSize | Positive page at most 1,000,000; size 1–100, default 25 |
| sort | `deadline` (default) or `updated`, with stable node-ID tie ordering |
| timeZone | Supported IANA zone, default UTC; browser entry records the local zone in the URL |

The reader checks the existing `WORKFLOW_CENTER_TENANT_IDS` feature scope and
both workflow/product read grants. Inside `withTenant()` it reloads current
membership and intersects the caller's permissions/scope. Self/team scope retains
the existing workflow owner's product scope. Assignment never expands visibility
or grants execution/approval. A withdrawn grant produces denial and clears Web
rows/counts on the next response. Visible pages refresh every 30 seconds, on focus,
visibility restoration and history navigation; this is not push revocation.

## Counts, dates and business truth

The shared reader in `packages/workflow-core` executes counts and rows in one
read-only repeatable-read tenant transaction. Totals and summary use the entire
current filter before paging. They count workflow nodes only, not orders or sales
plans. Summary categories can overlap. The response pins database `asOf`; overdue
uses that timestamp and today uses the selected zone's calendar-day bounds. An
internal due date is separate from marketplace shipping promises.

Start/end graph nodes are excluded. Open/closed comes from actual node and run
states, including run cancellation/completion. Product archival is shown separately
and never invents a completed task. Missing pinned node definitions remain explicit.
Legacy responsibility revision zero stays visibly unconfigured. Responses omit
parameters, reasons, buyer evidence and raw object URLs.

Migration `0113_workflow_task_inbox_index.sql` adds only an assignment/deadline
index to the existing node table. It creates no task store, facts, role grants or
historical backfill. Normal database migration and rollout require their own backup
and acceptance; isolated fixture migrations do not prove deployment.

## Verification

Use `pnpm test:e2e:order-daily --suite=workflow-task-inbox-integration` for actual
PostgreSQL/RLS, full-filter paging/counts, literal search, timezone bounds, current
scope/grants, closed/archived behavior and definition diagnostics. The existing
`--suite=workflow-operator` also exercises the inbox through real auth/API/Web:
filters, actual node completion and return, read-only assignment, revocation and
the retained order/sales entry points, at desktop/tablet/phone widths.

Only disposable runner resources are used. No normal full Worker, paid model,
external message or marketplace action is required for inbox reads. See
[responsibility and reminders](workflow-responsibility.md) for write/delivery
semantics and [local development](../operations/local-development.md) for runtime
and cleanup procedures. Passing this slice does not complete B26 or a release.
