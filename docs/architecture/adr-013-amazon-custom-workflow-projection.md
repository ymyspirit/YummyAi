# ADR-013: Amazon Custom workflow projection and immutable events

## Status

Superseded by [ADR-014](./adr-014-native-workflow-center.md). The legacy
projection remains read-only for one release cycle so existing product plans
can be migrated without losing notes, blockers, timestamps, or revisions.

## Context

The product-plan lifecycle is intentionally coarse. It describes catalog state
such as researching, developing, listing, and ready, but it cannot show which
employee is currently executing the fourteen-step Amazon Custom SOP. Reusing
the product status for task progress would mix catalog approval with operational
execution and would lose blocker and handoff history.

## Decision

Amazon Custom execution uses a separate tenant-owned workflow:

- `amazon_custom_workflows` stores the current workflow status, current step,
  optimistic revision, and product-plan association.
- `amazon_custom_workflow_steps` stores the current projection for each of the
  fourteen ordered contract-defined tasks.
- `amazon_custom_workflow_events` appends every start, completion, blocker,
  unblock, and reopen transition.

The shared contract is the only source of step order and step keys. Commands
must include the expected revision and must run through `withTenant()`.
Transitions are sequential. A blocker requires a reason. Only the latest
completed step may reopen, and only before later work starts.

The projection is mutable because it answers current operational status. Events
are immutable and provide the audit trail. Workflow completion does not perform
marketplace authorization, browser automation, or Seller Central publication.

## Consequences

- Employees can view all products and open one product's exact task position.
- Concurrent updates fail instead of silently overwriting another employee.
- Product lifecycle and SOP execution remain independently understandable.
- New SOP versions require an explicit contract and migration decision; step
  keys cannot be reordered silently once workflows exist.
- Forced PostgreSQL RLS, composite tenant foreign keys, restricted grants, and
  an immutability trigger protect the workflow history.
