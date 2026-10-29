# Private order design agent

The agent produces an editable order draft, a full-resolution private proof and quality diagnostics. A completed run still needs the existing artwork review, any required buyer proof confirmation, and production release. It cannot authorize those steps.

Orders now follow Agent-first drafting and operator review. Source-grouped customer
requirements are pinned to the original work revision. An operator can reject the
exact current Agent candidate with a reason and hand it to a human designer; the
original steps, costs and proof remain immutable. The current assignment remains
human during editing and resubmission. The list's `designCandidateReview` is a
read-only indication of an evidence-bound candidate, never production approval.
See [order requirements](order-requirements.md) for text, style, AI field binding
and legacy-version boundaries.

Original published methods, current knowledge/permission checks, response-cost
recovery and immutable technical handoff are specified in
[order design completion](order-design-completion.md). Missing legacy evidence
is identified explicitly; existing manufacturing and business-review gates remain.

## Configure a product

1. Create a production template in the existing editor. Select the product and enter the supplier's actual dimensions, DPI, safety regions and manufacturing rules.
2. In **自动制图配方**, explicitly choose template placement or the supported photo-pillow workflow. Legacy recipes retain their preserve/enhancement choice; pillow segmentation remains a model call. The new pillow pipeline below requires faithful enhancement and separate explicit opt-in.
3. For model operations, select a configured image model, confirm permission to transfer the order images to that provider, and enter the per-call estimate, order estimate cap and call count limit. Alternatively explicitly select unlimited spending; this records `costPolicy: "unlimited"` and a null task cap. Missing prices on a legacy/capped recipe still prevent execution. An estimate is not a provider bill; see [actual model usage](model-token-usage.md).
4. Save a new version, review the template and bind it through the existing process profile and sales recipe. Orders pin these versions; later template changes do not rewrite dispatched orders.
5. Review the order's field/image mappings, save preparation and dispatch it. The order/artwork detail shows persisted progress. Browser polling is read-only; closing the page does not own task execution.

Agent dispatch requires an automation recipe on the pinned template. A missing
recipe is an actionable configuration failure, not a successfully queued Agent
job. Historical pushed work without a durable run is shown explicitly and is not
silently restarted through the legacy image preparation path.

New explicitly configured pillow pipelines may pin
`pillow-subject-v2-2026-10-29` and the exact configured `gpt-image-2.5`,
`gpt-image-2.5-flare` or `gpt-image-2.5-sunburst` model. The runtime route must match
that pin. Old v1 pipelines still require their original exact model; aliases and
variants are never silently substituted during recovery. Supplier dimensions,
geometry checks and operator artwork review remain separate.

If a model route or provider configuration changes after a template version was saved, new paid runs using that version are blocked. Recheck the destination and estimate, save and review a new template version, and bind it for new orders. Existing pinned runs still validate their destination immediately before submission.

The first implementation supports tire-cover template placement, rectangular flat-print template placement and the existing structured photo-pillow workflow. A rectangular canvas is not certification for every rectangular product. New sizes within an existing manufacturing method should use specifications and reviewed templates; new cutting, sewing, curved-surface, engraving or embroidery methods require a product capability implementation and acceptance samples.

## Versioned pillow pipeline (2026-09-19)

For a new reviewed pillow template using factory standard `ps-pillow-2026-09-17`,
select **启用新版抱枕链：主体测量与按需超分**. This explicitly saves
`recipe.pillowPipeline.version = pillow-subject-v1-2026-09-19`; absence means the
legacy workflow and never triggers an automatic upgrade. The UI obtains the
verified tool/model fingerprints from the server and pins them in the new
template. Unknown, unavailable or changed runtime files block execution.
Review the new template and bind its version before dispatching new orders.

The recipe fixes the exact `gpt-image-2.5` route/provider, mandatory faithful
enhancement, prompt version `pillow-cutout-whiskers-v1`, and treatment of
protruding long whiskers during model cutout. Names such as
`gpt-image-2.5-preview` do not satisfy the exact model requirement. Later
geometry processing cannot redraw, trim or rescale the locked artwork to
make a cutting path pass.

After input validation and template composition, the fixed sequence is:

`enhance_image → cutout_subject → measure_subject → ensure_resolution → optimize_contour → preflight → render_proof → review_required`.

Visible subject measurement uses the inclusive bounds of alpha ≥ 32 for both
placement and contour geometry. The order's subject longest side determines
physical placement; transparent canvas margins, seam allowance and barcode tab
are excluded. Actual decoded pixels determine whether one fixed 4× upscale is
needed. Sufficient source pixels reuse the cutout, while a source that still
falls short after 4× stops for handling. Output pixels are not proof of native
detail. The independent contour uses a 200 px base allowance, at most 30 px
extra allowance and no fine-detail removal; bounded rounding corrections reuse
the same locked image. The proof is full-resolution factory JPG and remains
unapproved. Only enhancement and cutout consume model-call estimates.

The new rule-center identity `system:pillow-pipeline-v1-2026-09-19` is registered
as a draft and needs explicit publication. Existing `super_resolution` and
`subject_measurement` rules retain their unavailable status. A newly captured
task without the new recipe pins the new identity as manual if it is published;
existing snapshots are never reinterpreted or backfilled.

### Optional contour graph pilot (2026-09-20)

An eligible new pillow template may explicitly select **试用裁线检查与有限修正流程**
in **自动制图配方**. Save and review a new template version before binding it for
future orders. The saved value is
`recipe.pillowPipeline.contour.workflow = langgraph-contour-v1-2026-09-20`.
An absent value keeps the existing imperative contour loop; publishing a rule,
installing LangGraph or upgrading the worker does not enable it for historical
templates or runs. The order's encrypted snapshot pins the selection.

This pilot changes only the internal orchestration of `optimize_contour`:
calculate geometry, check it, and, if needed, try the existing 25 px and 30 px
rounding corrections after the initial 20 px pass. It does not add a model call,
broaden the correction allowance, change the source image or replace production
preflight. The source asset remains locked and its bytes must retain the same
checksum. Technical success still requires human review and is not production
approval. This loop already existed before the graph pilot; introducing a graph
does not establish a new manufacturing capability or additional automatic recovery.

The existing database run/step ledger, outbox and BullMQ remain authoritative.
The graph has no separate durable checkpoint, interrupt, automatic retry policy
or order-state writer. Safe recovery reuses completed steps under the existing
processor. A stopped uncommitted contour calculation may be recomputed locally;
it cannot cause enhancement or cutout to be submitted again.

Only an attempt index and technical pass flag enter graph state. Customer pixels,
documents and asset references remain in the invocation's private closure.
The pinned runtime uses an isolated zero-sampling tracing client, so host-level
LangSmith/OTEL settings or another traced task cannot export this graph's events.
Trace suppression is regression-tested without mutating process-wide settings.

The contour step stores encrypted evidence containing the workflow version,
source asset/checksums, bounded attempts and technical check results. The existing
authenticated task endpoint exposes only this validated evidence, including the
unchanged-artwork and required-human-review indicators. Private object keys,
encrypted step payloads and buyer content are not exposed. The evidence follows
the existing tenant access and order retention boundary; legacy steps are not
backfilled with graph evidence.

To stop enrolling new orders, save, review and bind a new template version without
the graph opt-in. Existing tasks retain their fixed selection and require a worker
that supports it, or explicit takeover. Do not rewrite their snapshots or silently
resume them through the legacy branch. Disabling order-design dispatch remains
available for an operational pause; this does not erase existing evidence.

The pilot's isolated checks cover legacy behavior, unchanged artwork, bounded
corrections, duplicate delivery, proof-failure recovery, takeover and evidence
privacy/expiry. Acceptance results must be recorded separately after execution;
this design description is not a test-pass, live-provider or supplier-acceptance
claim. Synthetic image responses verify orchestration only.

## Runtime and API

- Shared execution: `packages/order-design`, with deterministic geometry/rendering in `packages/production-editor`.
- Migration: `0088_order_design_agent.sql`. Runs, steps, dispatch outbox and idempotent commands use forced tenant RLS. Apply through the documented deployment migration process before starting the new worker; do not edit business tables manually.
- `order_design_dispatch_tenants` is a separate infrastructure index containing only routing tenant UUIDs. Registration is restricted to the current tenant; the worker may discover routing IDs under its application role, then opens individual `withTenant()` transactions for all business data. Organization and business-table RLS policies remain unchanged.
- Queue: `order-design`; payload contains only `runId`. The authenticated requester and tenant are carried in the job envelope and current membership is revalidated during execution.
- The normal worker dispatches persisted tasks every five seconds. `ORDER_DESIGN_AGENT_ENABLED=false` disables this queue and its dispatcher after worker restart. It does not erase tasks or authorize production.
- `GET /v1/order-centers/lines/:id/design-agent` returns progress and safe diagnostics.
- `POST /v1/creative-studio/rpc` with `{operation: "pillow-runtime", scope: "unassigned"}` is an authenticated read-only capability operation exposed through the existing same-origin studio BFF. It returns `{available, upscale, reason?}` with pinned parameters/fingerprints and no filesystem paths. Availability here verifies installed files; GPU readiness needs the separate smoke below.
- `POST /v1/order-centers/lines/:id/design-agent/resume` and `/takeover` accept `{runId, expectedRevision, idempotencyKey}`. Commands are version-checked and idempotent. The ordinary authenticated BFF exposes these routes under `/api/order-centers`.
- `POST /v1/order-centers/lines/:id/design-agent/restore-response` accepts the same command identity plus `stepId`, `requestId`, `contentBase64`, `providerReference`, `verificationNote` (10–1000 characters) and `verifiedOriginalResult: true`. Migration `0092_order_design_response_recovery.sql` extends the existing command check; no new queue, model route or permission domain is added. The same-origin BFF allows up to 28 MiB JSON for this route; decoded PNG/JPEG/WebP is bounded to 20 MiB and 100 million pixels, single frame.
- Existing `ORDER_PII_ENCRYPTION_KEY` and `MODEL_CREDENTIAL_ENCRYPTION_KEY` domains remain separate. No new provider credentials belong in a recipe, queue, prompt or diagnostic.

## Local pillow super-resolution runtime

This version supports the official Windows Real-ESRGAN NCNN Vulkan 20220424
binary, `realesrgan-x4plus`, 4×, tile 256 and threads `1:1:1`. Install and run the
synthetic GPU smoke as the same service user that will run Worker:

```powershell
& .\tools\scripts\install-pillow-realesrgan.ps1
pnpm --filter @yummyai/worker exec tsx ../../tools/scripts/smoke-pillow-super-resolution.mts 1254 1254
```

The installer downloads the [official Windows release archive](https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip)
and requires SHA-256
`abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d`.
It extracts only the allowlisted files, refuses to replace a different existing
installation, and does not execute downloaded scripts.

`PILLOW_REALESRGAN_DIR` is a server-only absolute directory used by API and
Worker. In non-production Windows it defaults to
`%LOCALAPPDATA%\YummyAI\tools\realesrgan-ncnn-vulkan-20220424`; production must
set it explicitly. Other operating systems have no approved binary fingerprints
in this version and stop with an unsupported-environment diagnostic. Keep the
path out of browser configuration, recipes and public logs. One assigned GPU
must have one Worker process: requests are serialized within a process with
eight waiting slots, but GPU allocation is not coordinated across processes.

`inspectPillowSuperResolutionRuntime()` hashes the executable, model bin/param
and both bundled OpenMP DLLs on every inspection. Before paid image work,
`validatePolicy()` checks installed bytes against the task's fixed policy.
Upscaling repeats verification, copies only those five approved files into a
unique private job directory, verifies the copies, and runs them with fixed
arguments. Child processes receive only required Windows/runtime/temp variables,
never provider credentials; native stdout/stderr are discarded. Failures use
fixed public codes, without paths or customer content.

Inputs must be static PNG with alpha and no EXIF rotation, at most 2048 px per
edge and 4,194,304 total pixels. Input and encoded output are capped at 64 MiB;
output dimensions must be exactly fourfold. The default native inference
deadline is 180 seconds, with explicit overrides capped at 300 seconds. Abort
or timeout terminates only the owned child, waits for exit and removes the job
directory; failed cleanup stops the task for administrator handling.

The pinned alpha strategy is `source-alpha-lanczos3-rgb-nearest-fill-v1`:
decode straight sRGB RGBA; keep source alpha and all RGB where alpha > 0;
extend RGB under fully transparent pixels using stable row-major Manhattan
propagation from the nearest nontransparent seed; infer opaque RGB with x4plus;
resize the original alpha exactly 4× using Sharp Lanczos3; join it to neural RGB
and encode sRGB RGBA PNG. The fill changes neither the source mask nor visible
source pixels and performs no segmentation or fur cleanup. The derived asset is
marked AI-super-resolved and still requires visual fidelity review.

Recorded technical evidence on 2026-09-19: real GPU synthetic smoke passed
64 × 48 → 256 × 192 and 1254 × 1254 → 5016 × 5016; the latter took 10.204 seconds
including staging and encoding. Source bytes remained unchanged, alpha matched
the fixed deterministic reference, neural RGB differed from plain Lanczos3
interpolation, and private job files were removed. These checks used no customer
images, external image-model calls or production approval. They do not establish
real-order acceptance: the identified ten orders (five shaped pillows and five
tire covers) have not been run or accepted as of this implementation note.

## Exceptions and costs

Original submitted calls and minimal fee receipts now have their own retained
identity, independent of private image keys. Exact provider reports, conservative
budget occupancy, privacy expiry, financial-only reads and original limit checks
are documented in [original model calls and fees](order-design-model-costs.md).
Model configuration timestamps use the database clock shared by template
authority; actual post-template route/provider changes still block submission.

### Operator-assisted original-response recovery (2026-10-05)

The order's design panel shows the current blocked step, most recent completed
step and next action. A single uncertain paid step may offer **核实模型结果并恢复**.
The operator must verify the provider's original request/result against the
pinned model, step and reference image, then import the untouched original
response and record its provider reference and verification basis. The current
image gateway has no supported historical-result query. The internal request
UUID, an operator checkbox or an imported image is not automatic provider
verification, billing evidence or a quality approval. If the original result
cannot be verified, use the existing takeover flow.

Recovery checks current tenant permissions and membership (including the original
requester), pinned source/revision, retention, order availability, unchanged editor,
step dependencies and the original budget reservation. Held, cancelled, archived,
expired, taken-over or changed work cannot be restored. A previously received
receipt requires exactly matching bytes/checksum and request identity; its known
cost remains unchanged. Uncertain calls retain their unknown cost and reservation.
The API rejects caller-supplied cost, route, snapshot or object-storage overrides.

Raw bytes are encrypted into the existing private response quarantine; the
idempotent command then pins the checkpoint and dispatches the existing outbox.
The Worker reuses completed steps and runs normal scan, decode, alpha, subject,
pixel, contour, preflight and full-size proof checks without resending this paid
step. Operator evidence survives both the completed step and the output asset's
encrypted provenance. Unscanned quarantine paths and raw bytes are never in the
progress response. Manual import does not permit replacing a committed checkpoint
or restarting exhausted/unsafe processing.

Takeover or concurrent source/editor changes during upload invalidate the command.
Uncommitted encrypted blobs are discarded only after confirming that the database
does not reference them. A lost commit acknowledgement cannot delete a committed
checkpoint. If reference verification or deletion fails, the API returns
`agent_response_cleanup_pending`; refresh progress and check private storage before
any further action. Do not infer that the command or provider call failed.

Successful recovery ends at the current version's **awaiting_review** state. The
operator compares original, current artwork and server-rendered full-size JPG,
then approves or records a rejection reason. Corrections create a new editor
version and repeat its checks/review; geometry corrections reuse locked artwork.
Factory acceptance and actual production release remain separate.

Completed steps have durable output references and are reused. Known local failures can be recovered within fixed retry limits. An externally submitted request with an unknown result is held for reconciliation, because an internal request ID does not guarantee provider deduplication. Do not click a different workflow to blindly repeat an uncertain paid operation.

Successful image-model responses are first pinned as encrypted private raw bytes
and an encrypted step checkpoint, before decoding, scanning, thumbnail creation
or registering an image asset. A failure while processing a verified checkpoint
can resume from those bytes, with at most three local attempts and no second
model request or budget reservation. A response that cannot be fully checkpointed
stops for reconciliation; checksum failure in a saved checkpoint also stops.
Neither case authorizes a second paid request. The API exposes no raw-checkpoint
path or unscanned image asset.

Recoverable local super-resolution failures reuse the completed cutout rather
than requesting another model image. The UI only offers recovery when the
durable run permits it. Runtime version/fingerprint failures require restoring
the pinned environment or dispatching a separately reviewed new template;
exhausted retries, inadequate source resolution and invalid output need explicit
handling. Existing work, source files and order size remain unchanged.

Taking over stops automatic ownership. Already completed files remain available. If no editor project exists yet, starting manual artwork preserves the original inputs and template while skipping automatic placement and enhancement, so an automation failure cannot trap the operator behind the same automation check. A late provider response cannot overwrite the operator's editor version. Check any uncertain provider call separately; stopping a worker cannot prove that the provider stopped processing or charging.

Takeover preserves an already durable response and recorded billing. If only a
receipt exists, the step stays uncertain with a response-not-checkpointed reason;
its reported charge is retained. Unknown billing keeps its reservation. Shared
recovery decisions are described in [incremental Harness](agent-harness.md).

The UI distinguishes configured estimates, reported actual costs, no model required, and unknown billing. The current image gateway does not return actual billing evidence, so a successful paid image operation may still have unknown actual cost. Tenant budget reservations stay in place for uncertain calls. No result is treated as free merely because a request timed out.

Technical quality checks cover source provenance/checksums, exact structured text, source versus output resolution, transparent pixels, file scans and manufacturing preflight. Generated pixel dimensions do not establish original detail or visual fidelity. Unknown crop correspondence preserves source PPI as unknown. Model identity/fidelity and supplier fit require manual inspection.

## Extension contract

Add a typed product definition, geometry, render dispatch and product preflight together. Keep browser-safe definitions free of server storage/encryption dependencies. Add representative pixel/physical-size regressions and verify that old documents render identically without regenerating their baselines. A new product may reuse an existing workflow only if its capabilities and supplier rules match; otherwise add a bounded tool/workflow rather than product-name conditionals or free-form executable prompts.

See [architecture decisions](../architecture/2026-09-17-design-agent.md) and [isolated acceptance](../operations/design-agent-acceptance.md).
