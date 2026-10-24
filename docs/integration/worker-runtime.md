# Standard Worker lifecycle and recovery

PRD 1.1.112 adds a separate ephemeral observation for the two Agent queues only.
The existing task owners, queue payloads and immutable executor versions remain
unchanged. A connected BullMQ client alone is insufficient: the observation
requires a running, unpaused consumer, both live public connections, and an
actually completed recovery dispatch cycle from the same process instance.
Stopping withdraws the proof before draining; an unreachable observer relies on
the 15 second Redis lease. Missing telemetry never authorizes work or declares a
task successful. See [Agent runtime observations](agent-runtime-readiness.md).
Scoped runtime acceptance and daily adoption passed; this batch's owned outputs and five disposable resource groups were independently cleared. Ordinary consumers remain off; real provider execution and full-platform acceptance are separate.

The standard entry point is `apps/worker/src/run.ts`. It reuses BullMQ and the
existing business processors, durable task intents, leases, response checkpoints
and fee ledger. Lifecycle supervision owns transports, never business approval or
task completion. No new execution database or automatic migration is introduced.

## Startup and readiness

Before consuming, the process checks the complete local SQL migration sequence
against `drizzle.__drizzle_migrations`, performs a private-bucket `HeadBucket`, and
checks Redis connectivity. Migration count, checksums and timestamps must match.
Missing or mismatched resources reject startup; the Worker neither migrates the
database nor creates buckets. Apply deployment migrations through the documented
backup/migration flow, using matching API/Web/Worker sources. Current code requires
the complete migration chain through 0140 and, for selected POD work, the checkpoint encryption configuration
in [POD response recovery](pod-response-recovery.md).
The 0120 method owner and compatibility boundary are described in
[native method governance](agent-methods.md).
Migration 0121 and the workflow/POD method/provenance guards are described in
[execution methods](execution-methods.md). Readiness validates the complete chain;
it never adds a missing snapshot to an old task.
An existing local environment with reviewed historical checksum drift uses the
immutable schema-adoption contract in [legacy upgrade](legacy-runtime-upgrade.md);
readiness verifies the actual ledger and current schema rather than rewriting history.

Consumers are constructed with BullMQ `autorun: false`, registered immediately
with error handling, and all awaited before any dispatcher or consumer starts.
A late constructor/configuration failure closes already registered resources.
The `worker.lifecycle` JSON event with `state: ready` is the readiness signal;
creating a Redis connection or starting the operating-system process is insufficient.
Events contain queue/scheduler names and static diagnostic codes, never credentials,
raw jobs, model bodies or database error details. IPC mirrors these events when
a supervisor attached an IPC channel; no public management endpoint is added.

With the existing optional capabilities enabled, acceptance verifies 27 consumer
queues and ten dispatchers. `ai-analysis`, `capture`, `export`, `metrics`, and
`order-ingestion` remain reserved queue declarations without a confirmed active
producer; no placeholder consumers are installed. Optional capability flags retain
their existing meaning and do not grant tenant permissions.

## Explicit consumer and scheduler selection

The existing pinned BullMQ implementation is retained; no new execution framework
or dependency is added. `WORKER_QUEUES` accepts `all`, `none`, or comma-separated
active consumer names. Unset and `all` retain every currently enabled consumer;
an explicitly named optional consumer must already be enabled by its existing
capability flags. Reserved names, unknown names, duplicates, empty values and
partially parsed lists reject startup before opening PostgreSQL.

`WORKER_SCHEDULERS` accepts `all`, `none`, or exact scheduler names. With the full
consumer default, the absent value retains all eligible timers. With an explicit
queue list, the absent value includes only those queues' dispatchers. The three
global attention/follow-up timers require explicit selection in that case.
Dispatchers require their own consumer; the global timers may run with
`WORKER_QUEUES=none`. A process with neither consumers nor timers is invalid.

| Scheduler | Required consumer |
| --- | --- |
| workflowNodeScheduler | workflow-node |
| captureMediaScheduler | media |
| aiAssistScheduler | ai-assist |
| knowledgeMaintenanceScheduler | knowledge-maintenance |
| productionRenderDispatcher | production-editor-render |
| orderDesignDispatcher | order-design |
| podArtworkScheduler | pod-artwork |
| workflowAttentionScheduler, orderLineAttentionScheduler, businessFollowupScheduler | Explicit global timers; no consumer required |
| materialCommandRetentionScheduler | Explicit privacy maintenance; no consumer required |

Only selected domain factories are constructed. For example, media-only startup
does not initialize model, marketplace, order-PII or logistics secret vaults.
The existing common database, private-storage and Redis readiness checks remain.
The fixed local material-retention entry point and aggregate batch events are
specified in [independent input retention](material-input-retention-runtime.md).
The Redis transport probe does not construct an unrelated queue. Assembly must
exactly fulfill the selected plan before any consumer or timer starts, and ready
events report the actual installed names.

Selection controls process capabilities, not business authority or production
approval. Original actor, scope, version, budget and external-submission checks
remain with the owning modules. A selected workflow or publication processor may
legitimately publish a dependent job to another queue; selection does not start
that other consumer or authorize its work. Review queued and durable work before
enabling consumers in an existing environment.

`pnpm worker:inspect --include-durable` adds an offline, loopback-only PostgreSQL
inventory to the read-only Redis snapshot. The database uses a repeatable-read,
read-only transaction and returns state counts from the declared execution-domain
columns, never row bodies. Redis and database snapshots are not atomic together.
Counts are not dispatch eligibility: owner-specific predicates, legacy missing
snapshots, current permissions and uncertain submissions still require review.
The inventory never grants startup or clears/replays work. See
[local personal runtime](local-personal-runtime.md).

## Bounded shutdown

`SIGINT`, `SIGTERM`, or a supervisor IPC message `shutdown` / `{type:
"worker.shutdown"}` initiate the same idempotent stop. Stop all timers and stop
consumers accepting work before waiting for any active job. The capture and
knowledge dispatchers also wait for their active dispatch before closing their
publisher. Shared publishers and PostgreSQL remain available during draining;
the database closes last.

`WORKER_STARTUP_TIMEOUT_MS` defaults to 15000 and bounds each startup preflight or
the all-consumer readiness wait. `WORKER_SHUTDOWN_TIMEOUT_MS` defaults to 30000
and is one total shutdown deadline. Both accept integer milliseconds 1000–300000.
Deployment supervisors should allow a termination grace period longer than the
configured shutdown deadline. BullMQ's
[graceful close](https://docs.bullmq.io/guide/workers/graceful-shutdown) itself has
no deadline, so the runtime bounds its wait and disconnects consumers on timeout.
It does not call `close(true)` after an existing `close()` and assume that the
earlier promise was forced.

A clean requested stop exits 0. Startup failure, consumer transport/loop failure,
resource-close failure or timeout exits 1 for the supervisor to observe. Reaching
the deadline does not mark any business task successful, cancel a submitted model
request, release an uncertain charge, or approve an output. Restart recovery is
still determined by each owning module's original durable intent and checkpoint.

## Disposable full-process verification

Run `pnpm test:integration:worker-runtime` with local infrastructure healthy.
The dedicated runner migrates its own guarded database, explicitly provisions its
own private bucket and starts its own Redis container. It never uses normal
business resources. It starts the actual standard entry point in ten child
processes in the original recovery cases, plus five selected/invalid-plan
processes, with local synthetic model HTTP and real isolated SQL/Redis/S3:

| Case | Required behavior |
| --- | --- |
| W01 | Migration drift rejects readiness without changing the migration record |
| W02 | Missing bucket rejects readiness without creating it |
| W03 | A late assembly failure leaves a queued job unconsumed and closes earlier resources |
| W04 | All enabled queues/dispatchers report ready; shutdown drains an in-flight POD response and its real stored artifact |
| W05 | Shutdown timeout exits uncleanly; restart retains submission uncertainty without repeating the model request |
| W06 | Kill the standard process after output upload; another standard process adopts the original response, artifact and fee |
| W07 | Real Redis connection loss is handled and exits under lifecycle supervision |
| W08 | Unreachable Redis never reports ready and startup has a deadline |
| W09 | Media-only startup ignores unrelated invalid keys and leaves an unselected workflow queued |
| W10 | A selected POD consumer with no timers produces the checked artifact exactly once |
| W11 | One explicit global timer starts no consumers or unrelated encrypted domains |
| W12 | Unowned timers and unavailable optional consumers reject before database connection |
| W13 | The read-only durable inventory preserves retained work and exposes no row payloads |

The suite is standalone because the complete Worker could consume another suite's
fixture queues. Do not import it into parallel API integration files. Four local
synthetic model requests are expected, with one request per original task and no
paid provider call. Outputs remain pending review with unverified rights.
The runner confirms child termination and removes its database, bucket and Redis
in `finally`. Raw logs and fixtures are inspected, summarized, independently
audited and deleted under the delivery protocol. This is a local standard-process
drill; production supervisor rollout, real providers, CI and backup/restore remain
separate acceptance requirements.

Each run defaults to a new owned output directory. For an explicitly owned fresh
boundary, use `pnpm test:integration:worker-runtime --output-dir=tmp/<new-run>`.
Existing directories, linked ancestors and workspace traversal are rejected.
Never reuse retained artifacts from a prior rejected cleanup. The concise frozen
results and actual cleanup status are recorded in
[the selected-runtime delivery](../project-control/WORKER_SELECTION_DELIVERY_20261019.md).


## Creative owner dispatch · 2026-10-19

The five creative dispatchers follow existing domain selection and only dispatch already-staged original execution records. Database leases and dispatch generations fence concurrent instances; old queued business rows are not backfilled with current authority. Actual Redis and killed-process recovery are covered by [creative execution](creative-execution.md). The normal Worker was kept off during this slice, preserving the original backlog. Deployment, execution views and business acceptance remain open.
