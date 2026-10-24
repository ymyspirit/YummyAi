# Native method governance

2026-10-16 · PRD 1.1 · R04/R20 · B14/B28. Persistence, owner APIs, assistant
enforcement and the native method workbench are implemented and locally exercised.
Real business-object/provider acceptance remains separate. See the
[architecture decision](../architecture/agent-method-governance.md).

## Publication and authority

The catalog contains nine assistants plus their distinct artwork-audit method,
and the original workflow/POD owner methods described in
[execution methods](execution-methods.md).
The two original order-design owners additionally use
[fixed methods and technical handoff](order-design-completion.md), preserving
the existing private order, template, recipe, provider, budget and review gates.
POD code-v2 output, frozen original code-v1 compatibility and immutable original
file handoff are described in [POD completion](pod-completion.md). Active old
publications remain selected until explicit review/publication of the upgrade.
Instructions, steps, tool descriptors and hashes come from the same code-owned
HarnessRegistry used at execution. Callers select a registered key and provide
working notes and up to four general knowledge-version IDs; they cannot supply
executable instructions, tools, contracts or publication pins.

Notes enter ordinary source data in `operatingMethod`; system instructions do not
change. Bibliography is procedure provenance, not extra task fact citations.
Platform/market/product/store facts retain existing scopes and owners. Method-wide
provenance initially requires published general knowledge (`all` platform, `ALL`
market, no SPU), with the existing evidence, expiry and conflict checks. Product/
store method scopes remain future integration. Workflow/POD publications use the
same provenance owner and separate immutable execution pins; notes do not become
processor parameters or manufacturing authority.

Save creates an immutable draft; submit places it in review. Publication requires
workflow:approve, current revision and exact reviewed checksum. Reject returns
the latest draft; drafts/rejections leave an older active version usable. GET does
not seed/publish. History preserves bodies, steps, tools, provenance, reasons and
actors. There is no hard-delete endpoint.

Before first adoption, built-in behavior is explicitly unadopted; drafts do not
block ordinary work. After adoption there is no fallback when disabled. Disable
increments a withdrawal generation; re-enable does not revive old selections.
Publishing v2 without withdrawal does not rewrite or invalidate usable v1 inputs.

## Execution and reads

New inputs seal `agent-method-selection-v1` inside existing encrypted assistant
input. Creation resolves publication and provenance, holding a shared method lock
through commit. A shared advisory lock covers the absent-row race with first draft
creation. Worker checks the pin before images/submission and before adopting new
or recovered responses. Completion holds method and current role grants while
committing. Publication grants no business/execution role.

Legacy inputs without a publication snapshot stop once the tenant adopted that
method; they cannot borrow today's approval. Inputs are not backfilled. Explicit
old built-in selections can continue until a withdrawal. Unsupported contracts,
changed bodies, disabled methods and invalid provenance stop execution.

Withdrawal before submission makes no model purchase and releases the reservation.
Withdrawal in flight keeps the original encrypted response and known charge and
rejects adoption. The original ledger's `committed` state retains that charge;
there is no parallel budget/fee ledger.

Published notes require workflow:read even with zero normal search hits. Creation,
retry, history reads, conversation continuation, Worker submission and final
adoption share this rule. Bibliography does not expand actor scope or ordinary
search results.

## API and persistence

Tenant operations use withTenant/non-owner role and forced RLS. Migration 0120 adds
agent_methods, immutable agent_method_versions and immutable agent_method_events.
Composite tenant relations protect pointers. A trigger rejects foreign/scoped
knowledge provenance, including direct owner inserts. Identity/adoption timestamps
are immutable; revisions/generations cannot decrease. Idempotency returns original
event results and rejects changed data.

| Route | Permission and behavior |
| --- | --- |
| GET `/v1/agent-methods/workspace` | workflow:read; catalog and draft/active versions |
| GET `/v1/agent-methods/sources?query=&after=` | workflow:read; published general sources, 50 per page and stable entry-ID cursor |
| GET `/v1/agent-methods/:id/history` | workflow:read; immutable versions/events |
| POST `/v1/agent-methods/save` | workflow:read + manage; create/revise registered method |
| POST `/v1/agent-methods/:id/:action` | workflow:read + manage for submit; approve for publish/reject/disable |

Strict bounded DTOs, private/no-store reads and bounded audit metadata apply.
Notes/credentials/raw prompts are not logged. Histories over 1000 versions or
5000 events reject explicitly; history pagination above these bounds remains future work.

## Native workbench

Open Knowledge and rules → Methods (`/knowledge/methods`). Search and status
filters keep current adoption separate from the latest draft. Details expose
current status, editable notes/sources, review differences and immutable history.
`?method=<registered key>&version=<number>` opens the selected historical version.
History and source links retain their exact versions; creating a new draft does
not replace the active method. First adoption requires save, submit, current
checksum review and explicit publish. Notes never edit the registered executable.

Source selection uses current published general knowledge, literal search text
and seek pagination. Availability is recomputed from the owning knowledge policy,
including older pinned versions; neither a new publication nor workspace refresh
rewrites immutable method references. Invalid sources and unsupported execution
contracts prevent submission/publication. Partial read failures remain explicit.

The Web BFF permits only these read/write routes, rejects foreign-origin writes,
unknown query fields and oversized bodies, preserves safe 400/409 diagnostics and
403 permission failures, and makes no automatic mutation retry. The drawer keeps
unsaved text after a stale-revision conflict; refresh shows the conflict and discard
loads the new revision. Published review consent is bound to revision and both
compared checksums. Losing manage rights clears edit controls; losing read rights
clears details, selections and unsent notes. Thirty-second/focus checks fence
older successful reads. Network failures pause writes until a successful refresh.

Reuse the existing TaskDrawer, Lucide icons, ERP tokens and native transitions;
checkbox selection updates immediately. Desktop/mobile, actual theme switching
and reduced-motion views are covered by the real browser suite.

## Rollout and verification

Ship matching API/Web/Worker/contracts and apply migrations through 0120 using the
backup/migration procedure. Standard Worker readiness requires this chain. Tests
do not migrate the ordinary DB, adopt methods there or import/publish the user's
PDF. No new secret/switch or expanded role is introduced.

Run `pnpm test:e2e:order-daily --suite=method-governance-integration`. Method,
knowledge-governance and assistant tests cover catalog/commands, injection, draft/
active versions, RLS/immutable provenance, actual input pins, withdrawal before/
during requests, generation fencing, source invalidation and a SQL lock/disable
race. Model HTTP is synthetic; publication, RLS, checkpoints and budget are real.

Runner DB/bucket/Redis deletion is verified in finally. Retain tests and concise
evidence; delete raw logs and identified caches after review. This is not real
provider quality, business approval, manufacturing or full-platform acceptance.

Governed execution proof now covers all nine assistant kinds and the separate
artwork audit. The six additional kinds and audit use their actual business
services, RLS and processor with synthetic business records/model HTTP; they pin
v1 through v2 publication, prepare new inputs with v2 and deny reads without
current knowledge permission. Existing fact, privacy, template and manufacturing
gates remain asserted. See [the additional owner-path verification](../project-control/REMAINING_METHODS_DELIVERY_20261017.md).
Browser evidence remains specific to knowledge/order/SKU and the method workbench.
Workflow/POD publication now has its own native integration and original-version
browser paths; real-provider/business acceptance remains separate. See
[execution methods](execution-methods.md) for the 0121 rollout and legacy boundary.
`pnpm test:e2e:order-daily --suite=methods` runs real authentication/API/RLS and
browser save/review/publish, v1 task execution after v2 publication, source
withdrawal, optimistic conflict, read-only 403 and late-response revocation.
External model HTTP alone is synthetic. Its isolated Web snapshot runs on 3130,
API on 8128; the runner removes its database, bucket, Redis and Web snapshot.

`--suite=business-methods` uses the same isolated server ports and proves that
old order/SKU tasks execute v1 after v2 is published, stale inspected bases return
409 before another model intent, queued withdrawal releases the reservation and
in-flight withdrawal preserves the response cost while rejecting adoption.
The task basis exposes the server method selection outside request input. Preview
and result show their respective versions and open exact immutable history.
Shared results and the task workspace recheck completed reads, clear private
state on denied reads and fence earlier successes. The browser holds actual 200
run/workspace responses across a real permission change, waits for those specific
responses to finish, then confirms they cannot restore the private view.
