# Extensible private order design agent

Status: first implementation and isolated application acceptance completed, 2026-09-17; not deployed or certified for live-provider/supplier output. This is the design for the user-authorized order artwork automation. It builds on existing order preparation, approved sales recipes, private production documents and independent production release. See the [acceptance record](../operations/design-agent-acceptance.md) for exact scope and evidence.

## Outcome and scope

After reviewed order preparation is pushed, an eligible recipe runs in the background to produce a complete editable draft, server-rendered proof and diagnostic evidence. Supported first paths are template placement for tire covers and rectangular flat prints, plus the existing photo-pillow manufacturing path. The terminal outcome is `awaiting_review` or an actionable exception, never an invented customer confirmation or production approval.

The initial rectangular module demonstrates extensibility; it does not certify every rectangular product or supplier. Embroidery, engraving, curved-surface mapping, independent multi-panel garments and color-managed RIP output require dedicated capabilities and supplier validation before support can be advertised.

## Decisions

1. **Separate identity from manufacturing.** Reuse artwork masters, physical SPU specifications, process profiles and sales recipe versions. Platform field adapters provide normalized inputs while preserving source evidence. Do not create another competing SKU/asset catalog.
2. **Versioned, strict capabilities.** Keep existing production document V1 semantics. Product modules declare typed specifications, print geometry, rendering and validation. Remove implicit “not tire cover means pillow” fallbacks. Unsupported types fail explicitly. Browser-safe geometry/definitions must not import Sharp, encryption or server storage.
3. **Immutable recipe input.** A new optional automation recipe is fixed with the reviewed template/document and the order run. It declares the bounded workflow, image treatment and model limits. An absent recipe preserves historical behavior; it does not silently activate a new paid workflow. New recipes never modify existing orders, source files or render checksums.
4. **Durable execution.** A database run and step ledger is authoritative. Dispatch is recoverable through a persisted outbox. A separate infrastructure registry contains only tenant UUIDs for service discovery; registration occurs in the authenticated tenant transaction. Its narrow SELECT policy permits routing-ID discovery under the application role. Orders, outbox rows, runs, steps and files still require tenant-scoped RLS; the organizations policy is unchanged and no owner bypass is used. Queue messages contain identifiers only. Successful steps reuse persisted output; rendering can retry within limits. Browser closure and service restart do not erase progress.
5. **External-call uncertainty.** Persist intent and a request identity before an external model call. Internal request IDs do not imply provider idempotency. Preserve completed per-image results immediately. Unknown paid submission outcomes stop for reconciliation; they are not automatically re-submitted. Cost figures distinguish configured estimates, actual evidence and unknown values.
6. **Bounded tools and data.** Customer notes, source files and model responses are untrusted data. They cannot select credentials, alter tool definitions, change budgets, approve work or redefine manufacturing checks. Only supported structured fields enter automatic execution; ambiguous instructions are routed to review. No arbitrary code or remotely installed tool execution is permitted by a recipe.
7. **Independent quality.** Technical checks verify geometry, effective resolution, alpha, fonts, exact text and output completeness. Original resolution and generated output resolution are distinct evidence. Subject/identity preservation is not proven by a prompt, pixel count, model confidence or a checksum. Unverified visual fidelity remains a human review requirement.
8. **Controlled image policy.** Eligible new recipes can preserve original images or request explicit enhancement. Logos and flattened text need an original-preserving route. Originals remain private and immutable. Changes to this policy must also change the corresponding preflight expectation; do not leave an unconditional enhancement gate behind.
9. **Manufacturing contract.** Actual millimetres, measurement basis, output DPI, print regions, safety margins, sewing/cutting rules and front/back orientation belong to the approved supplier specification. Do not infer finished dimensions from a generic preview or assign pillow seam rules to other products. Existing confirmed V1 manufacturing rules stay intact.
10. **Human takeover and conflicts.** Order holds, cancellation, withdrawal, revision changes, permission revocation and retention expiry block further work. Takeover invalidates execution ownership. Late external responses cannot overwrite an operator's current editor version. No network calls occur while holding database locks; commits revalidate ownership and pinned versions.
11. **Privacy lifecycle.** Runs/steps use forced RLS and tenant-scoped references. Buyer content, prompts and private file links are encrypted under the order domain; logs and public diagnostics contain stable safe codes. Derived files inherit order retention. Reusable templates never ingest private buyer material. Test fixtures use disposable resources and verified cleanup.
12. **Separate approvals.** Agent output remains unreviewed. Existing design, customer proof and production release gates retain their own evidence and permissions. Automation cannot set `visualReview`, `narrowParts`, customer approval or production release merely to make a job complete.

## Operator experience

Keep the existing dense ERP design and navigation. Configure automation on a reusable template, then review/save it through the normal version flow. The order task shows the pinned policy, current step, completed outputs, failed/uncertain reason and relevant recovery action. Taking over opens the same editable work rather than duplicating the order. Unconfigured routes, unavailable models and absent prices remain explicit.

Use a single bounded orchestrator with a typed tool registry. Model calls are isolated image or analysis operations. Additional agents are not required for deterministic placement or manufacturing calculations. Broader automatic review may be introduced only after quality evidence supports a specific approved recipe; no global confidence threshold unlocks all products.

## Delivery and verification

- Capture legacy decoded-pixel/layout/preflight baselines before refactoring. Never regenerate the baseline merely to pass a failed compatibility check.
- Implement shared product definitions and a strict rectangular flat-print path; preserve old missing-field behavior and immutable documents.
- Add recipe contracts, durable run/steps, private checkpoints, dispatch recovery and takeover controls.
- Reuse existing pure pillow contour algorithms in both browser and worker. Keep image segmentation separate from manufacturing contour adjustment.
- Integrate operator configuration, run progress, quality diagnostics and recovery into current pages.
- Exercise worker redelivery, concurrent claims, paid uncertainty, saved-output recovery, takeover/late responses, stale versions, cross-tenant access and expiry with isolated integration tests.
- Verify actual browser paths for template configuration, dispatch, progress after reload, result inspection, exception handling and takeover at desktop/mobile widths. A declared synthetic model fixture tests orchestration, not production model image quality.
- Run lint, typecheck, meaningful unit/integration/E2E and build checks. Verify fixture database/storage/queue cleanup. Record results and remaining limits in the runbook.

## Rollout and rollback

New automated runs require a reviewed explicit recipe; unconfigured/historical work retains its original behavior. Begin with automatic draft generation and human review. Measure first-pass acceptance, operator minutes per order, exceptions, wrong-text/wrong-image incidents, and total cost per accepted output including retries and human rework. Model or recipe upgrades require representative evaluation before wider use.

Disabling dispatch must stop new runs while preserving existing evidence and allowing safe takeover. Do not delete immutable runs/files as a rollback strategy or restore expired customer content. Production deployment, real provider evaluation, supplier sample approval and automatic production release are separate readiness claims.

## Optional contour graph pilot (2026-09-20)

Rule Center continues to own versioned rule definitions, publication and fixed
task snapshots. It is not converted into executable natural-language rules.
The first LangGraph use is a bounded, deterministic implementation detail inside
the existing `optimize_contour` step. Its workflow version is
`langgraph-contour-v1-2026-09-20`, explicitly selected by the optional
`pillowPipeline.contour.workflow` field of a reviewed new template version.
Missing selection preserves the existing imperative branch and old snapshots.

The graph performs the same initial 20 px calculation and, only when technical
QA fails, the same 25 px and 30 px corrections. The geometry functions, source
asset, manufacturing contract and quality gates remain shared with the legacy
path. The graph cannot regenerate artwork, approve production, select a model,
increase spending or add a second retry budget. Its output is the ordinary
step result plus a validated contour evidence record.

The database processor exclusively owns run/step state, execution leases,
membership checks, idempotent commands, budget reservations and transactional
result commits. BullMQ owns delivery. This graph has no independent durable
checkpointer or interrupt/resume channel; its bounded local calculations may
be recomputed before the existing step commit. A completed step is reused.
Adding a durable graph for an entire order is a separate architecture decision
requiring explicit ownership and atomic/idempotent recovery between graph state
and business writes; this pilot does not establish that second state machine.

Source and output artwork checksums, correction attempts and technical results
are persisted in the encrypted step output. The API projects an allowlisted
evidence contract only while current tenant authorization and order retention
permit it. Raw object keys, documents and encrypted payloads remain private.
The evidence records human review as still required; an equal checksum proves
unchanged source bytes, not visual fidelity or factory acceptance.

Rollout affects future explicitly opted-in runs. Removing the opt-in requires a
new reviewed template; it does not mutate an active run. Deployments must retain
the version needed by pinned tasks or pause/take over those tasks explicitly.
Verification compares legacy and graph behavior and exercises bounded failure,
redelivery, recovery after a later step fails, takeover and evidence privacy.
Record executed acceptance results separately; implementation and synthetic
orchestration checks do not establish production release readiness.

## Method and completion extension (2026-10-18)

The original executor now participates in the shared code-method publication and
knowledge owner. It pins the selected method with the original business snapshot,
rechecks current execution authority, preserves received original responses and
fees before adoption, and seals actual unreviewed proof files in the original
completion transaction. See [method and completion contract](../integration/order-design-completion.md).
This is additive to the original recipe, recovery, privacy, manufacturing and
business-review decisions above; historical missing evidence is not backfilled.
