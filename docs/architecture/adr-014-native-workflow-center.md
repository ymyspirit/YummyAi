# ADR-014: Native workflow center and version-pinned execution

## Status

Accepted. Supersedes ADR-013.

## Context

Amazon Custom product development started as a fixed fourteen-step projection.
That made the first SOP executable, but it could not support team templates,
approval branches, reusable POD capabilities, or additional product workflows
without adding another bespoke engine. Completed work also needs to remain
editable without erasing the original audit history.

Embedding the n8n editor would split tenant authorization, product facts,
artifact rights, task state, and audit history across two products. It would
also make YummyAI dependent on a separately licensed editor and execution
monitor.

## Decision

YummyAI owns a generic native workflow center:

- `@xyflow/react` renders the template designer and read-only run topology;
  Dagre supplies deterministic top-to-bottom layout.
- PostgreSQL stores tenant-owned definitions, immutable definition versions,
  version-pinned runs, node projections, attempts, artifact links, and
  append-only events.
- Human tasks and approval gates wait for explicit commands. Internal actions
  use a registered capability and BullMQ. Queue payloads contain only tenant,
  run, and node-run identifiers.
- Conditions select registered rules. Templates cannot contain JavaScript,
  credentials, webhooks, or arbitrary URLs.
- Rejecting an approval reopens its configured historical target; it does not
  introduce an automatic graph loop.
- The external executor contract is present, but n8n is disabled in v1 and
  external nodes prevent publication.

Definitions have official, team, and personal scope. Official templates are
read-only and must be cloned. Publishing creates an immutable version, and a
run never changes the version to which it is pinned. Optimistic revisions are
required for all run and draft mutations.

## Amazon Custom migration

The existing fourteen stable step keys become the official `Amazon Custom
Product Development V1` graph between start and end nodes. Existing status,
notes, blocker reasons, timestamps, and revision are lazily projected into a
generic run. The legacy read APIs remain available for one release cycle; old
write APIs return HTTP 410 and all new writes use workflow commands. The old
tables are not deleted during rollout or rollback.

The feature can be exposed tenant by tenant with
`WORKFLOW_CENTER_TENANT_IDS` (comma-separated IDs, or `*` for all tenants).
Rollback hides the new navigation and restores the legacy read view; immutable
definitions, events, and migrated runs remain intact.

## Consequences

- Product workflows share one permission, validation, execution, and audit
  model while product data continues to live in its domain tables.
- Employees can update notes or reopen completed nodes; each change appends a
  new event instead of rewriting history.
- v1 deliberately excludes arbitrary code, graph cycles, parallel fan-out,
  dynamic expressions, Seller Central publication, and an n8n UI.
- New internal capabilities must declare schemas, permissions, rights policy,
  and an idempotent queue handler before templates can publish them.
