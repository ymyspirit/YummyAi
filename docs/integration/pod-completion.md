# POD processor results and original completion evidence

2026-10-18 · PRD 1.1 · R04/R20/R22/R39 · B14/B28/B32.

## Stable boundaries

`PodProcessorResultV1Schema` in contracts owns the existing processor response
shape. HTTP bodies and `pod-response-checkpoint-v1` keep their original format;
this change does not ask a provider to adopt a new wire field. The worker still
owns bounded/base64 decoding, receipt capture, per-tool quality checks, physical
file validation, current authority and recovery. Schema extraction changes none
of those checks or product manufacturing parameters.

New code methods use `pod-method-2026-10-18-v2` and output schema
`pod.completion-v1`. Operator `PodArtworkTaskView` fields are no longer their
execution output contract. `PodCompletionV1` is a technical handoff containing
original task/design IDs, tool, input fingerprint, original method checksum,
response checksum/decoder, result-version ID, initial result state, original
quality-snapshot checksum, and ordered file IDs/versions/checksums/sizes/types/
roles. Business review is required and automatic production approval is false.
No raw response, bytes, private object key or provider secret is exposed.

## Atomic persistence and reading

Migration `0122_pod_completion_contract` adds nullable completion evidence/checksum
to the original execution row. After original response recovery and storage
readback, the existing owner creates the assets, version/file relationships,
initial task state, invocation completion and sealed completion in one guarded
tenant transaction. Failure rolls back that metadata; the staged original
response, artifact manifest and known processor fee remain recoverable.

SQL requires paired evidence/checksum and a completion for code-v2 finished rows.
The initial evidence must match its original task, input/method/response,
pending-review design version and every authorized output exactly once, including
order, role and physical metadata. Existing completion JSON/checksum is immutable.
Already terminal historical rows cannot gain a reconstructed completion. Original
response retention may still purge its bytes without changing the completion.

Reads validate the record checksum and original task/execution/result bindings;
malformed present evidence returns an explicit conflict rather than reconstruction.
The receipt describes the original technical handoff, so a later business review
does not rewrite its original state or quality checksum. `blocked` rights-risk
results may retain technical completion while business execution stays blocked.
Technical completion never substitutes operator review, factory acceptance or
production release.

`GET /v1/pod/tasks/:id/completion` requires current design:read and asset:read,
task scope and, for a published method, workflow:read. Missing original evidence
returns 404. The Web download BFF performs this fresh authorized read, validates
identity and returns private/no-store JSON. The task view shows original file
count and handoff state; retryable download failures remain visible and current
denial clears the downloadable evidence view. This is an evidence download, not
a production package or marketplace publication.

## Supported original code-v1 methods

The 31 original definitions and their original input/UI-output schemas are frozen
in `packages/pod-core/src/compat/pod-methods-v1.json`. The loader verifies the
archive digest, original contracts/descriptors/skill bodies and schema hashes.
Compatibility also requires the native input schema to match the frozen input.
Unknown or modified code contracts stop; documents cannot load executable code.

An actively published original code-v1 remains selected until the operator saves,
reviews and explicitly publishes the current code-v2. Publication then affects
new inputs only. Existing tasks retain the exact old publication and checksums,
subject to current permissions, provenance and withdrawal generations. No
publication is silently upgraded merely by starting new application code.
Code protocol versions and tenant publication numbers are independent; a notes
revision can advance the publication number without changing its code protocol.

Completion validation distinguishes `native_completion`, `legacy_owner_view`
and `legacy_missing`. The legacy mode retains the original UI-output contract as
audit metadata, applies the existing owner quality checks plus the stable handoff
gate, and does not claim native code-v2 output validation. Historical terminal
tasks remain missing; an actually executed nonterminal legacy recovery may record
its new technical handoff without inventing a method snapshot.

## Deployment and acceptance

Ship matching API/Web/Worker/contracts and apply the full migration chain through
0122 using the established backup/migration procedure. No new package, service,
queue, encryption secret, permission, fee ledger or ordinary-database publication
is added. Disposable acceptance never migrates the ordinary database.

Run `pnpm test:e2e:order-daily --suite=execution-methods-integration` for original
owner, recovery, method and SQL coverage. Run `--suite=execution-methods` for the
method/workflow browser paths and completion download/current-denial flow, using
Web 3130 and API 8128. External processor transport is synthetic. The concrete
native execution sample is pattern_crop; catalog/schema coverage across all 31
tools does not prove real-provider quality or every tool's manufacturing output.
Retire raw acceptance artifacts under the delivery protocol and report actual
cleanup refusals separately from disposable service teardown.
