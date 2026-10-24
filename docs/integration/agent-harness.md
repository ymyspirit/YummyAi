# Incremental agent execution harness

Three production adapters now use [durable command recovery](production-command-recovery.md): original encrypted inputs and authority ceilings, owner commit receipts and transaction-held fencing. Migration0136 is only exercised in disposable databases; ordinary adoption and the full harness remain pending. This is separate from paid-provider recovery below.

Owner-derived invocation views and original POD processor-fee receipts are now
specified in [invocation evidence](harness-invocations.md). They reuse existing
read boundaries; migration 0117 persists bounded POD submission/response metadata
before artwork validation. New original POD tasks additionally use migration 0119
for [encrypted response and artifact recovery](pod-response-recovery.md). Provider
invoices, actual full-Worker crash drills and financial reconciliation remain
separate acceptance requirements.

Product contract: [three-layer/Harness specification](../erp-blueprint/15-agent-harness-specification.md).
This document describes the implementation that is actually shared, not the full target harness.

## Shared paid-request recovery policy

`@yummyai/ai-core` exports `assessPaidRequestRecovery`. It is a pure decision over
trusted persisted evidence. A response checkpoint takes precedence over a receipt;
a receipt takes precedence over a claim that submission did not happen. Missing
submission evidence means reconcile, never permission to submit again.

The decision distinguishes submit, reuse_response and reconcile, plus whether an
uncommitted reservation may be released. It does not authorize a tool, validate
checkpoint bytes, change a database row, call a provider or approve a result.
Existing module services retain those responsibilities.

Order-design recovery, exception handling and manual takeover use this policy.
Takeover of a durable response skips further processing, retaining its checkpoint
and billing evidence. Takeover with a receipt but no durable response keeps the
step uncertain with `agent_model_response_uncheckpointed`. A recorded charge is
preserved; unknown billing retains the reservation. A genuinely in-flight request
still becomes uncertain and late worker results cannot commit after takeover.

There are no new routes, environment variables or database migrations for this
slice. No model routes, supplier specifications, approval gates or old snapshots
are changed. New AI assist execution records now use the same policy as described
below; other execution modules still require their own migration and verification.

## Validation

- `pnpm --filter @yummyai/ai-core test`: recovery decision and existing core tests.
- `pnpm --filter @yummyai/order-design test`: existing recipe and contour regression.
- `pnpm test:integration:design-agent`: isolated PostgreSQL/RLS, recovery, budget,
  takeover, existing editor/creative/order paths; model transport is synthetic.
- `pnpm typecheck` and lint: repository consumer compatibility.

Read [custom pillow workflow](../operations/custom-pillow-workflow.md) before
running shaped-pillow tests. Tests pin synthetic fixture versions and never send
real customer artwork, approve production, or call a paid provider. The isolated
runner destroys its database, bucket and Redis in finally and writes a cleanup
manifest under ignored `tmp/`; copy the relevant non-sensitive result into the
delivery evidence. Integration fixtures do not prove real-provider quality or
factory acceptance.

## Shared assist admission (2026-10-16)

The nine assist kinds use `@yummyai/authz`'s `requiredAssistPermissions`,
`requiredAssistRequestPermissions` and `authorizeAssistRequest` in API admission,
history reads, business previews and Worker execution. Run permissions include
read permissions. Attached knowledge requires workflow read access for every
assist kind. Product scope, sales plans, account evidence and evaluation add
their own current permissions.

New encrypted inputs pin `accessPolicy` with version, requiredPermissions and
dataScope. `GET /v1/ai-assists/runs/:id` returns the optional/nullable audit
snapshot. Clients cannot supply it in CreateAssist. The historical permission
list is not an authorization grant: execution always uses the current code policy
and active membership. Reduced data scope cannot reuse a broader pinned input.
Legacy inputs remain unchanged and return null; without a pinned scope, current
tenant-wide access is required rather than guessing a narrower original scope.

Worker rechecks current task status/expiry, member permissions/scope, provider and
route before preparing external images and immediately before provider submission.
A permission/route change during image download blocks the call and releases only
the unsubmitted reservation. The worker validates the request and stored task kind.
Replaying an existing queued request also rechecks current read/run permissions
before dispatch; a rejected replay cannot enqueue work as a side effect.
There is no new database migration, environment variable or marketplace write.

Business preview fingerprints exclude access-policy audit metadata; the complete
immutable input fingerprint still includes it. Changes to facts, sources, pixels
or goals continue to invalidate the business preview.

The shared scope schema is exported at
`@yummyai/contracts/tenant/tenant-context`, including a browser-resolvable import
path. Repository typecheck alone does not prove frontend bundle resolution.
Validation uses authz unit tests, real tenant assist/knowledge integration suites,
and the existing disposable desktop/phone AI task browser suite. Provider/model
transport remains synthetic in those suites.

The admission slice itself did not add leases/outbox. The subsequent execution
slice below adds those for new assist runs; tool registration, current business-
object revalidation and provider reconciliation across all modules remain open.

## Durable assist execution and response recovery (2026-10-16)

Migration `0116_ai_assist_execution_recovery` adds tenant-RLS execution metadata
owned by the original assist module. A new run, budget reservation and execution
intent commit together. Redis enqueue failure leaves that original run queued,
with its reservation; it no longer reports a failed task and asks for another
purchase. `AiAssistScheduler` in the standard Worker dispatches at startup and
every minute, in bounded tenant batches. Its queue envelopes contain IDs only.
No new scheduler service or Agent framework is required.

New executions pin the input fingerprint, execution contract, prompt version,
instructions/output-schema/output-limit checksum and existing model snapshot.
Unsupported versions stop before submission. Old runs have no invented execution
records: their original conservative interrupted-request behavior remains.

Each execution claim has a token and a five-minute lease. Duplicate delivery
leaves a live claim running. A stale unsubmitted claim can resume; a submitted
claim with no durable response becomes uncertain and keeps its reservation.
The submission marker commits before the provider request. A late old-token
result cannot commit. There is one model submission per execution; local
continuation has at most three claims and a one-minute retry delay.

OpenAI and OpenAI-compatible adapters await an encrypted checkpoint before
interpreting structured output. The checkpoint includes original response JSON,
usage, receipt, image evidence and diagnostics; checksum and model/input/version
checks apply on reuse. Saved responses are bounded to 8 MiB, share the original
assist's expiry, never enter queue payloads and are purged by existing expiry
jobs or the minute dispatcher. Non-sensitive response checksums and accounting
metadata remain. Current permissions and route checks still gate continuation.

Known usage and configured-price costs settle before output validation. Invalid
JSON or unsupported evidence can therefore fail while retaining a known charge.
Unknown usage/pricing keeps the reservation and null cost. Settlement updates
only reserved ledger entries; repeat local processing cannot rewrite a terminal
bill. A recoverable local output failure resumes the stored response rather than
calling the model again. External uncertainty requires provider-side or manual
reconciliation; this slice does not add a provider reconciliation API or approve
business outcomes.

Validation uses provider checkpoint unit tests, the real tenant assist integration
suite (including Redis delivery and failure injection), knowledge flows and the
existing desktop/mobile AI task browser. External model transport is synthetic.
Normal databases are not migrated by the disposable acceptance runner.

## Assist input authority (2026-10-16)

All nine assist kinds seal `assist-input-authority-v1` in their existing encrypted
input. The trusted API captures a bounded dependency projection before and after
the owning services prepare the context. Admission may add resolved knowledge
pins, but cannot accept changed business resources or an unavailable required
resource. This metadata never grants permissions or changes business facts.

`@yummyai/database` computes deterministically ordered, scoped SQL summaries under
`withTenant()` and the non-owner role, using repeatable-read/read-only transactions.
Each resource has a static key, required flag, count and SHA-256 checksum. More
than 10,000 rows per resource stops admission; a truncated result is never accepted.
The encrypted graph is capped at 64 resources. Public `AssistView.inputAuthority`
contains version, capturedAt and the root fingerprint only; historical inputs
return null. CreateAssist is strict and does not accept caller-provided authority.
Business preview fingerprints exclude this audit metadata; the immutable full
input fingerprint still covers it. No new table, migration, dependency or key is
introduced by this extension.

Projections follow each selected object: research/project/specification versions,
canonical order and current work/source/editor, template inspection/source asset,
Listing/recipe/SKU/specification/artwork/media, selected inventory/location and
related purchasing/quotes, selected finance runs and related workflow summaries,
and the selected after-sales case/evidence. Search caches, viewport state and
unrelated stock movements do not change the corresponding business dependency.
An unsaved revision-zero order remains valid without a work row; its canonical
order is mandatory. Retention booleans detect expiry even without a database write.
The shared reader does not reproduce business calculations or write other modules.

Knowledge availability stays with `@yummyai/knowledge-core`, reusing its existing
evidence and blocking-conflict checks. A pinned published v1 is not replaced or
invalidated merely by publishing v2. Disable/archive, invalid sources, review
expiry or blocking conflicts stop use of that pin. Confirmed redacted account
evidence retains its separate store/current-permission checks; expiry of the raw
original alone does not invalidate approved redacted evidence.

The Worker rechecks current permissions, route and dependencies before image
preparation, immediately before submission, when resuming a response and before
adopting its result. A queued original-request replay also checks the pinned
authority before dispatch; a changed source returns 409 without a second enqueue.
Legacy inputs without the snapshot stop before a new model request and explain
that current evidence must be read for a new task. Submitted legacy uncertainty
keeps the original conservative handling; no historical snapshot is invented.

Before submission, a mismatch produces a failed result and releases only the
unsubmitted reservation. A source withdrawn during the model request leaves the
encrypted response checkpoint and known bill intact, with no usable result and
no automatic second model call. Diagnostics identify static resource categories
without exposing private rows. These checks do not add business approval or a
provider-side reconciliation API. Full Tool/Skill resource contracts and other
execution modules still need their own verification.

`AssistView.budgetState` is an optional nullable read of the original tenant budget
ledger (reserved/committed/released), joined to that run without a second financial
state. The panel displays a released reservation explicitly. Null cost and absent
ledger still do not mean zero provider charges. The source-change error preserves
any charge that actually occurred rather than implying every stopped task was paid.

Regression sources are `assist-input-authority.test.ts`, the original assist
integration suite, knowledge governance and the actual AI task browser. They
cover changed order revisions, selected versus unrelated inventory, after-sales
evidence versus search cache, both legacy execution paths, withdrawn knowledge
before submission and withdrawal during a response with billing preserved.
The original pinned-v1/new-v2 case remains required. Final results and remaining
checks are recorded in the current delivery report and H01–H12 matrix.

## Native Tool and Skill contracts (2026-10-16)

The code-contract slice below required no migration. Subsequent tenant method
publication adds migration 0120, immutable adoption versions/events and the
`agent-method-selection-v1` input pin. Its current assistant scope, legacy handling,
source/read checks and the locally verified native workbench are documented in
[native method governance](agent-methods.md). Earlier code-contract evidence stays
unchanged; the method owner does not introduce executable Skill-file imports.

Workflow attempts now seal publication selections, and their POD operation pins
the child's separate selection at activation. Migration 0121 adds an immutable
POD method snapshot to the original execution/fingerprint. Native admission and
adoption recheck parent/child methods, current roles and knowledge provenance;
shared source/method locks cover the owning write. Original response and fee
recovery do not replace those pins. See [execution methods](execution-methods.md)
for DTO/read boundaries, legacy handling and local verification commands.

The existing ai-core hosts a code-owned `HarnessRegistry`. It pins a reviewed
method body, ordered steps and allowed tool versions, together with input/output
Schema hashes, required owner permissions, resource policy, data domains, effect,
byte limits, timeout strategy and recovery policy. Canonical JSON hashing survives
JSONB object-key reordering. Stored refs must match the supported code registry;
a client-supplied checksum is not authorization.

Current bindings cover nine assist kinds (plus an automatic artwork-audit method),
two catalog operations and the existing POD executable tool keys. workflow-core
adds one internal ai-core workspace dependency. API definition validation and the
Workflow Worker share those workflow bindings; owner enable flags still apply.
External dependencies are unchanged. No table, migration or new engine is added.

New inputs seal executionContract in the original encrypted assist input or
workflow attempt snapshot: executorKey, skill ref, allowed tool refs and checksum.
Read views expose optional nullable refs; legacy inputs remain unchanged.
CreateAssist rejects caller-provided contracts and invalid parameters with a safe
400 before inserting a task or budget. Business-preview fingerprints exclude this
server protocol; the immutable full-input fingerprint includes it.

Assist execution checks the exact binding and logical request before images,
submission and local continuation. It obtains actual instructions from the method,
uses its 120-second abort signal and validates the structured result. Protocol refs
stay out of model source data. Current permission/scope, route, input authority,
evidence and budget gates remain in the owner path. Knowledge dialogue exposes no
business execution tools to the model.

Workflow activation seals refs after owner preparation; claims, owner guards and
completion recheck them. Schemas reuse the prepared catalog/POD contracts with
literal operation/tool discrimination. Logical inputs are bounded to 1 MiB and
normalized outcome metadata to 4 KiB. Five-minute leases fence commits rather
than claiming to cancel an external request. POD retains its original child.

| Recovery policy | Enforced identity and reconciliation |
| --- | --- |
| owner_receipt | Tenant + original operationId; immutable catalog receipt reuse |
| response_or_reconcile | Original assist, submission marker and encrypted response; unknown submission is not resent |
| original_child_task | Original POD key/child ID; status and uncertainty gate reconfiguration |

Effect/domain labels describe a code-owned contract. Owners still check actual
parameters, permissions, resources and effects. Skill text cannot grant access.
Descriptor permissions are a minimum; current request and resource policies may
require more. A historical permission list never grants current access.
approval=owning_business_flow preserves existing review; it adds no per-call
confirmation window. Published workflow versions remain the orchestration source;
code methods define node protocols. Arbitrary executable Skill-file import remains
outside this implementation.

Missing/unsupported/mismatched contracts stop before another model or owner call.
Old records are not backfilled. Explicit repair creates a new attempt after checking
the original receipt/child; uncertain paid children keep their replacement block.
An old parent lacking a contract stops its queued POD child before the gateway.

An owner may commit before returning malformed metadata. Output validation then
stops node advancement, retaining the real receipt without claiming rollback or
approval. Repeated delivery skips the terminal failed attempt. Node inspection
returns safe optional refs and known diagnostics without raw snapshots/object keys.

The implementation reuses Zod and the local stack, informed by the
[OpenAI Agents JS tool contract](https://openai.github.io/openai-agents-js/guides/tools/)
and [MCP's annotation/contract distinction](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).
It is not an SDK compatibility or real-provider claim. Final checks and remaining
scope are in [the delivery report](../project-control/HARNESS_TOOL_SKILL_DELIVERY_20261016.md).

## Workflow owner execution (2026-10-16)

The standard Worker now uses `@yummyai/workflow-core` and the shared catalog/POD
owners for fixed-input internal nodes. Durable activation, bounded fenced claims,
current membership, immutable owner receipts and waiting on the actual POD child
are implemented as a further slice. See [workflow execution](workflow-node-execution.md).
Its attempt ledger does not replace assist/order-design state or confer approval.
POD gateway uncertainty is terminal until reconciled; a complete shared external
response checkpoint and budget recovery path is still required.

## Assist lease clock and fee reconciliation (2026-10-16)

Assist dispatch throttles, claim/ownership lease checks, renewal and local retry
deadlines use PostgreSQL time under the existing tenant transaction. The Worker
and scheduler therefore compare the same authority when host and database clocks
differ. Run privacy expiry and source/current-permission checks retain their own
gates. Tests exercise a process clock one minute behind and ten minutes ahead;
an active lease must remain fenced, and an expired unsubmitted lease can recover.
This follows the distinction between transaction time and actual current time in
[PostgreSQL date/time functions](https://www.postgresql.org/docs/current/functions-datetime.html#FUNCTIONS-DATETIME-CURRENT).

Manual [model fee reconciliation](model-billing.md) adds immutable evidence to
original calls and corrects the original budget projection in the same transaction.
It preserves configured cost, processor reports, UTC budget period and owner
results. Operator attestation does not claim a provider API verified the invoice.


## Five original creative consumers · 2026-10-19

Candidate generation, geometry adaptation/outpaint, PSD compile, mockup render and Studio now use [their original durable execution records](creative-execution.md). Original authority/method/source, budget, submission, response and completion are pinned in their owners; current permissions are rechecked before actual effects and adoption. Redis redelivery, native rendering and killed-process recovery have local evidence; current-authority read views, original-method links, manual recovery, normal 0129 rollout and business acceptance continue.
