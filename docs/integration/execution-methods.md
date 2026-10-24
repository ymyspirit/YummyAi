# Workflow and POD published methods

2026-10-18 · PRD 1.1 · R04/R20/R39 · B14/B28/B32. This extends the existing
[method owner](agent-methods.md); it does not add a framework, dynamic tools,
business facts, approval state or a second fee ledger.

## Registered owners and inputs

The catalog covers ten assistant/audit definitions, two catalog workflow actions,
one workflow binding for each of the 31 executable POD tools, their 31 POD
processor methods, and two [order-design methods](order-design-completion.md).
Workflow and processor publications are separate. Shared
Chinese tool labels come from contracts; the compact task labels keep their
existing wording. Reading the catalog creates no rows or adoption.

Workflow attempts seal their server-selected method in the existing immutable
input/checksum. A delegated POD operation also seals the child's method at node
activation. Creating the child later reuses that selection; publishing v2 in
between does not replace either original pin. Explicit repair selects new current
inputs; ordinary recovery reuses the original attempt/child and its original bill.

POD migration 0121 adds nullable `pod_artwork_executions.method_snapshot`. New
original tasks pin the native execution contract and publication selection, both
included in their input fingerprint. The database protects the snapshot from
replacement and checks its original task/tool/contract identity. Existing rows
stay NULL and tasks without an execution row stay legacy. No backfill is performed.
Public creation DTOs accept business inputs only, never governance selections.

POD code-v2 now returns the stable technical completion rather than the task-view
DTO. Frozen original code-v1 definitions remain supported with explicit legacy
validation; active old publications do not auto-upgrade. Migration 0122, atomic
file handoff, download/current-rights checks and the exact compatibility boundary
are specified in [POD completion](pod-completion.md).

Reviewed notes are manual working guidance. Deterministic workflow and POD paths
do not execute those notes, send them as processor parameters, change graph edges,
change numerical manufacturing rules, expand tool permissions, or create approval.
Procedure references remain provenance rather than extra product/store facts.

## Current authority and recovery

New admission locks and rechecks the selected publication. Execution and final
adoption validate original version/checksum, withdrawal generation, registered
contract and current knowledge provenance. v2 publication keeps usable v1 inputs;
disable/re-enable never revives an older withdrawal generation. Explicit builtin
selections remain builtin until withdrawal. Missing historical pins cannot borrow
an adopted method's current approval.

The native write guard holds shared method and knowledge-entry locks, in stable
source order, through the owning transaction. Current membership grants are
reloaded/locked before workflow/POD writes. Source withdrawal serializes with the
guard; expired, archived or conflicted provenance fails the existing knowledge
policy. Published POD history also requires current workflow:read, including a
method without bibliography. Every other business/resource permission still applies.

A workflow-derived POD task rechecks its originating attempt, current permissions,
scope, checksum and method before an external submission and before adoption.
Pausing/cancelling or withdrawing the parent cannot leave a free-standing paid
child authorized only by its own method.

Response capture deliberately precedes the final authority decision. A withdrawal
in flight preserves the original encrypted response and processor-reported cost,
then blocks adoption. Original response recovery keeps the same method/child/
invocation and never asks the gateway to purchase a replacement. Missing response
bytes and submitted-but-unknown results retain the existing reconciliation rules.
Processor-reported cost is not a verified provider invoice.

## Operator view and rollout

Workflow attempt inspection and POD task views expose the exact original
selection. Their existing method evidence component opens the immutable historical
version in `/knowledge/methods`, while current adoption and latest draft remain
separate. A missing version is labelled explicitly. Task technical completion,
operator approval, factory acceptance and production release remain independent.

Ship API/Web/Worker/contracts together and migrate through 0122 using the normal
backup/migration procedure. The POD workflow input schema/descriptor changed; old
incompatible bindings stop explicitly rather than being rehashed with today's
contract. Reconfiguration still requires original-child/uncertain-cost checks.
No new secret, ordinary-database adoption or automatic PDF publication is introduced.

Run `pnpm test:e2e:order-daily --suite=execution-methods-integration` for native
owner/processor/SQL tests. Run `--suite=execution-methods` for the method workbench,
workflow operator and original-version browser paths (Web 3130, API 8128).
The runner owns disposable DB/bucket/Redis and a Web snapshot; it never migrates
the ordinary database. External model HTTP is synthetic; the completion browser
case also executes an original task through a synthetic result gateway. Retire
reviewed logs/screenshots/downloads/caches according
to the [delivery protocol](../project-control/DELIVERY_PROTOCOL.md), recording any
actual policy refusal separately from service-resource cleanup.

The concrete local results, source identity and remaining scope are recorded in
[execution-method delivery](../project-control/EXECUTION_METHODS_DELIVERY_20261018.md).
