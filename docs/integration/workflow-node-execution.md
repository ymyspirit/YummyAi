# Workflow node execution

Invocation evidence now links the original attempt to current authorized catalog
receipts and POD child calls. The operator interface exports bounded metadata for
reconciliation without changing business or billing state; delegated parent steps
do not duplicate child costs. See [invocation evidence](harness-invocations.md).

Updated: 2026-10-16. Implementation slice for B09/B26/B28; full Harness and
business acceptance remain open. The standard Worker now registers a real
`workflow-node` consumer. It uses the same catalog and POD owners as the API.

## Ownership and capabilities

| Boundary | Implementation and result |
| --- | --- |
| `@yummyai/catalog-core` | `CatalogPackageService` owns provisional product profiles, completeness and ZIP creation. Nest adapters retain the existing HTTP exceptions and routes. |
| `@yummyai/pod-core` | `PodArtworkOwner` owns the original POD task, immutable inputs and dispatch. Its shared dispatcher and deployment activation also serve the API. |
| `@yummyai/workflow-core` | `WorkflowNodeRuntime` prepares fixed inputs, claims attempts, coordinates owner commands and advances verified node results. It does not write catalog or design facts itself. |
| `@yummyai/database` | Shared current-membership loading and audit writing preserve the authenticated actor and existing redaction policy. Business reads/writes use `withTenant()` and the ordinary RLS role. |

Supported capability families are
`yummyai.custom_product.generate_provisional_facts`,
`yummyai.custom_product.export_package` and enabled generic `pod.*` tools.
Registry availability for POD follows the configured deployment and tool allowlist.
Orders/customer assets retain their separate order-context processing boundary.
Unsupported capabilities and incomplete parameters fail with diagnostics.

Provisional profiles preserve unknown values. Research references do not establish
materials, geometry, audiences or approved claims. The previous cake-topper and
birthday defaults have been removed; a provisional surface is explicitly unverified.

## Durable activation and queue recovery

Activation stores the attempt in the same transaction as the current node state.
Migration `0110_workflow_node_execution` extends the existing attempt table with
the original actor, immutable input/checksum, output references, lease and dispatch
metadata. No second workflow ledger is created. The execution snapshot fixes:

- executor version and capability from the pinned definition;
- code-owned required permissions and the original data scope;
- product plan checksum, selected research snapshot/classification and preparation time;
- exact asset ID/version/checksum/domain/rights/source and file metadata;
- validated POD SKU/tool/parameters, or catalog export mode/market.

Queue payloads contain only `runId`, `nodeRunId`, `attemptId`. A failed enqueue
leaves the durable intent queued. On startup and every minute the dispatcher
reserves due current attempts under `FOR UPDATE SKIP LOCKED`, then publishes
outside the database transaction. A dispatch generation guards failure updates.
Delivery identity can change; business operation identity remains fixed.

The consumer requires the original actor, tenant, current node and latest attempt.
It reloads active membership grants/scope and current product ownership. A
five-minute database-clock lease fences older workers. Local/expired-lease recovery
is bounded at three recoveries; attempts older than 24 hours fail for review.
Owner commit and workflow completion independently recheck the lease and access.

Legacy queued/running attempts without actor/input are marked
`WORKFLOW_LEGACY_INPUT_MISSING` with a system event. Current inputs are never used
to manufacture their historical snapshot. Migration does not activate or replay
business tasks. Review legacy work before enabling the normal Worker after migration.

## Owner receipts and POD delegation

Migration `0109_catalog_operation_receipts` adds tenant-isolated immutable catalog
receipts. Profile save and receipt commit atomically. A prepared operation reuses
its receipt after process loss instead of changing facts twice. Export fixes and
validates input files, stores the real private ZIP and records its byte checksum.
Draft and release completeness gates remain distinct.

Existing catalog routes remain available. Additional routes under
`/v1/products/plans/:planId/custom-package` are:

| Method/path | Access and result |
| --- | --- |
| `GET receipts/:receiptId` | Product read and object scope; research permission when pinned sources exist. Returns an inspectable receipt without private object keys. |
| `POST receipts/:receiptId/read-url` | Product/asset read plus source access, current plan/source/assets/rights. Returns an audited private URL valid for 60 seconds. |

POD delegation creates the real task once and atomically records its ID on the
parent attempt. The parent waits and polls that task, then links the actual design
version. It never substitutes a placeholder success or creates a new paid task
because a workflow message was retried. Technical completion can leave the child
`awaiting_review` and the artifact `pending` at a human approval node.

POD workers now reload the original member's actual DesignRead/DesignWrite/AssetRead
permissions, SKU/plan ownership, fixed asset provenance and originating workflow.
They check admission before reading/submitting and again before committing results.
Cancel, pause or revoked access prevents a queued child from calling its gateway.
An unsubmitted queued child encountered during a pause returns `deferred` and
remains queued. Resume redelivers that same task with a fresh transport identity;
the database claim and fixed task ID still prevent duplicate provider execution.
Cancelled or revoked work remains blocked. Terminal uncertainty diagnostics cannot
be overwritten by a later queue message or permission failure.
An in-flight external request cannot be recalled. While paused/cancelled/revoked,
result persistence is blocked and external billing/result reconciliation remains
necessary. Access loss after entering the gateway retains payment uncertainty.

Once gateway submission may have happened, an unclassified error becomes
`POD_RESULT_UNCERTAIN`. A terminal task cannot be claimed by BullMQ redelivery.
This prevents blind repeated charging. It is not a complete provider-response
checkpoint/reconciliation implementation: operator recovery, durable external
receipts, provider cancellation and budget integration remain B09/B28 work.

## Commands and approval

New attempts pin native-harness-v1 method/tool refs, Schema hashes and owner
policies. API capability validation and this Worker share the code registry.
Inputs and normalized outcomes are checked at actual calls; the original owner
retains calculations, current authorization and receipts. Missing/unsupported
contracts stop without backfilling old inputs. Invalid returned outcomes can leave
a real committed receipt; inspect it before explicit repair. A stopped historical
parent also blocks its queued POD child before gateway submission. Read inspection
returns optional safe protocol refs. See [Tool/Skill contracts](agent-harness.md#native-tool-and-skill-contracts-2026-10-16).

Generic `complete` cannot complete internal actions or approve human gates.
Cancel/reopen/reject fence outstanding attempts. Block/unblock retains the fixed
input and delegated task. Retry without parameters reuses a failed input for the
same actor; explicit repair parameters create a new fixed attempt. Existing
owner receipts/child tasks are reused when their operation identity is retained.
Run reads, commands and list projection enforce current product data scope.

Workflow completion, artifact reference, event and next-node activation commit
atomically. The artifact starts `pending`; a successful ZIP or model response does
not confer design approval, marketplace publication or production release.

## Validation and remaining acceptance

Use the disposable runner:

```powershell
pnpm test:e2e:order-daily --suite=workflow-execution-integration
pnpm test:e2e:order-daily --suite=workflow-integration
pnpm test:e2e:order-daily --suite=all-integration
```

Tests exercise real PostgreSQL/RLS, Redis/BullMQ, private object storage, owner
services and POD processor. External processing is synthetic; no provider quality,
paid billing or production acceptance is established. The runner verifies fixture
database/bucket/Redis deletion in `finally` and writes a cleanup manifest under
`tmp/order-daily-e2e-*.json`.

The operator UI and its acceptance scope are described below. Remaining work includes
all capability-specific contracts, provider checkpoints/reconciliation, reference-aware
orphan object cleanup, true process-termination drills and release-candidate CI/E2E/
restore verification. Do not infer full B26 or Harness completion from this slice.

Design reuses the existing open-source stack. See
[BullMQ idempotent jobs](https://docs.bullmq.io/patterns/idempotent-jobs) and
[PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html).
Application receipts and fenced owner transactions supply the business invariants;
queue deduplication alone cannot prove a business operation happened once.

## Operator workspace

The existing React Flow workspace now reads the actual run and selected node's
execution attempts. While active, it refreshes every five seconds when visible;
reads never enqueue work. Node selection survives a reload through `?node=`.
Unsubmitted notes stay local through refresh. A changed run revision requires
comparing the latest saved note, then explicitly retaining or replacing the draft.
Commands still use optimistic revision checks. Ordinary readers cannot command,
approve or repair, and loss of run read access clears the workspace.

These authenticated GET routes require workflow:read + product:read and current
product scope; capability-specific owner permissions also apply:

| Route under `/v1/workflow-runs/:id` | Read model |
| --- | --- |
| `nodes/:nodeId/execution` | Latest 30 attempts, operator, timestamps, recovery count, fixed-input availability and authorized POD child status; older history remains stored |
| `nodes/:nodeId/repair-options?q=` | Authorized research snapshots, export mode, or actual POD tool/SKUs/assets and existing parameter form defaults |
| `artifacts/:linkId` | The linked owner's immutable profile/package receipt or actual POD design version |
| `artifacts/:linkId/file` | Actual private ZIP bytes after owner validation and checksum verification; download additionally requires asset:read |

The Web BFF `/api/workflow-runs/[...path]` exposes only these reads and the run
detail, validates paths/query/output schemas, masks upstream diagnostics and
uses private/no-store responses. ZIPs are attachments, never signed-URL JSON or
browser navigation to private object storage. Raw execution snapshots, provider
errors, prompts and object keys are absent from the attempt projection. Legacy
unknown error codes use generic code-owned guidance.

The retry command accepts explicit repaired parameters only after the pinned
capability's strict schema validates them. The server action re-reads the pinned
node, derives the POD tool from it, and reuses existing POD form parsing and
owner services. A hidden tool/idempotency field cannot choose a different action.
POD options are restricted to the current product plan before the SKU limit.
Changes create a new immutable attempt; old attempts and receipts remain visible.
An uncertain/running original POD request cannot be replaced by editing inputs.
The UI links to the authorized original task and design review; the POD workbench
re-reads an explicitly selected task instead of relying on the recent-list limit.

Validate this flow with `pnpm test:e2e:order-daily --suite=workflow-operator`.
The suite uses API 8120 and Web 3124, real auth/API/RLS/Redis/storage and a selective
workflow-node Worker. It reuses the isolated Web snapshot helper with an independent
Next lock/cache; no environment files are copied. Only the POD transport is a
synthetic throwing gateway. The normal full Worker and real provider endpoints
are not started. The runner removes and verifies the disposable database,
bucket, Redis and Web snapshot in `finally`.

## Maintenance discovery selection

`WorkflowNodeScheduler` accepts an optional internal fourth constructor argument, a readonly list of tenant IDs. Omitted means the normal all-tenant discovery; an explicit empty list means no tenants. This narrows maintenance enumeration only. It is not an HTTP field, membership proof or execution permission: `withTenant()` retains RLS and the runtime resolves the original actor's current membership and tool authority.

Integration schedulers and their selective Workers use unique queue names and only their own fixture tenants. The negative regression first proved that the old scheduler dispatched an excluded tenant's intent. It now checks an excluded tenant, an empty selection, the included intent, the original actor, one owner receipt and the human review boundary. Do not lower full-suite concurrency or permit cross-fixture task consumption to make this test pass.
