# Native knowledge workbench and governance

**知识中心 → 运营知识库** (/knowledge) provides document import, reviewed cards,
retrieval checks, knowledge dialogue and governance. The adjacent Rule Center
retains /settings/rules, production snapshots and execution bindings. Model
configuration stays in Settings. Publication activates an AI knowledge card;
ERP-approved specifications, finance, orders and manufacturing rules remain
owned by their business modules. Knowledge cannot grant permissions, execute
tools, publish marketplace Listings or approve production.

## Import and review

Upload accepts UTF-8 TXT/Markdown/CSV, text PDF and DOCX: 5 MiB per file and
200,000 extracted characters. ClamAV scans before parsing. Legacy DOC, corrupt
or encrypted files, unsafe ZIP/XML and image-only PDFs return diagnostics.
OCR is not built in. Document content/relationships are never executed/fetched.
Originals are encrypted, with checksum, metadata, retention and source scope.
Candidates are deterministically split by headings/bounded chunks, with original
line/excerpt locators; extraction does not claim an AI semantic summary.

Operators edit, accept or reject each candidate. Accept creates a draft/new
revision and atomically links its original. Identical retries reuse the result.
Save → submit → review the knowledge diff → explicitly publish is required.
Drafts never enter retrieval; later drafts leave the old active version intact.
Disable/archive exclude new retrieval while preserving immutable history/pins.
Stale revisions return 409. Source scope must contain card scope; private account
evidence cannot be linked into ordinary cards. Dates use Asia/Shanghai.

## Six governance functions

| Function | Behavior |
| --- | --- |
| 变更审核 | Public official URLs have immutable snapshots/checks. Changed normalized text creates a linked review, including cards referencing an older unchanged snapshot. Source diff → edit knowledge → knowledge diff → publish. Completing review verifies that selected cards published the new snapshot. |
| 覆盖矩阵 | Confirm explicit needs and scope. Status is covered, missing, expired, in review, scope mismatch or conflict. Only usable published cards count; empty needs have no coverage percentage. |
| 时效监控 | Card/document review dates, source validity/success and raw retention are independent. Failures never refresh successful evidence. Invalid evidence or blocking conflicts impede publication/new retrieval. |
| 质量评测 | Fixed questions define expected facts, required citations, forbidden phrases and refusal expectations. Run invokes the selected analysis model through the real worker/budget ledger. Reports pin case, scope, answer, source/model/prompt; preserve recall, assertions, failures, human reviews and comparisons. |
| 账户证据 | Store, market/platform, period, currency and attribution are explicit. Raw text is quarantined. Editable redaction requires three operator checks and a reason before authorized store-scoped retrieval. |
| 冲突风险 | Differing values/units for the same registered claim in overlapping scope/dates create conflicts with pinned sources/conditions. Human resolution records conditional applicability, missing evidence or supersession. Open blocking conflicts impede publication/retrieval; a superseded inactive version cannot reactivate while its opposite remains active. |

Conflict discovery uses registered critical claims; arbitrary prose still needs
human review. Answer checks use inspectable phrase/citation/refusal assertions,
not a fabricated accuracy score. Factual correctness is separately human-reviewed.

## Public-source monitoring

HTTPS domains only: no credentials/secret queries, private/local destinations,
fragments or custom ports. Every DNS answer/redirect is validated; connections
pin the validated address. DNS/HTTP share 12 seconds, three same-domain redirects,
2 MB response and 200,000 text characters. Only HTML/plain text is accepted;
navigation/script/header noise is removed before hashing. Text change is a review
candidate, not automatic policy judgment. No authenticated crawler is supported.

Manual checks have a one-minute minimum interval. Monitoring is off by default,
configurable for 6–720 hours and 1–365 freshness days. The normal Worker registers
knowledge-maintenance; a minute dispatcher queues due sources using IDs only.
Current membership/management permissions are rechecked. Permission/network
failures are visible and never refresh successful times/hashes or card dates.
Unchanged successful content extends source freshness without rewriting pins;
changed content preserves the previous snapshot deadline. Archived sources stop
monitoring. The dispatcher purges expired encrypted originals/quarantine. No
external messages or automatic publication are sent.

## Retrieval and knowledge dialogue

The Agent reader and native v2/v3/v4 binding editor default to general knowledge.
Operators may select one actual authorized SPU to include its published knowledge.
`GET /v1/knowledge/product-options?q=` (personal Web BFF
`GET /api/knowledge/product-options?q=`) returns at most 40 ID/code/name candidates,
`hasMore`, a fixed `limit:40` and the current `contextAuthority`. Search treats `%`,
`_` and backslash literally, accepts no caller tenant/scope/limit and rejects
duplicate parameters. Both WorkflowRead and ProductRead apply through current
membership intersected with the original session and the catalog object's scope.
The BFF requires and returns `x-yummyai-context-authority`, checks it again before
returning, uses private no-store, and bounds the complete UTF-8 JSON to 128 KiB.
Changing search or selection clears prior results and unsubmitted bindings;
already pinned bindings are not silently rewritten. No-product mode never means
all products. Archived SPUs/plans are omitted from new product candidates.

The same current object scope applies to cards and their entire version history,
imported originals, extraction candidates, governance references, needs and fixed
evaluation cases. Account evidence checks StoreRead and FinanceRead separately
against both document author and store owner; a broader WorkflowRead grant must
not turn a self-scoped finance grant into tenant access. Source monitoring checks
current authority inside each original transaction before and after the network
read; it never holds an outer transaction while awaiting that read.

An operator's unchanged self/team permission rank is insufficient when the
original SPU moves outside that scope. Original answers and evaluation reports
recheck current product ownership, recent conversations hide the inaccessible
scope, and report/review paths cannot expose the old case snapshot. Immutable
pins, results and ledger amounts are retained; read failures do not run a model,
rewrite history or manufacture a refund.
This includes evaluation cases with an empty SPU search but product-scoped
required references: start, replay and reads check the original case snapshot's
references. Account questions similarly recheck the original store and document
owners; a stale result is not a substitute for denying lost object access.

Citation links use the returned entry ID and immutable version, not a free-form
external href. `/knowledge?entry=<id>&version=<n>` displays that exact authorized
history version and never falls back to the latest. When an original answer is
stale, the UI hides its body, findings and references, explains the changed
evidence and retains original cost metadata. It does not resubmit a model job.

Keyword retrieval uses Unicode-aware Chinese/Latin ranking after tenant, scope,
active publication, dates, evidence and conflict filtering. Topic all spans topics;
platform all / market ALL / no SPU retrieve general knowledge. Up to six immutable
version/checksum/excerpt references are pinned; card corpus cap is 500. There is
no embedding/vector service. Knowledge dialogue uses knowledge_answer: configured
model selection and an explicit send are required. Opening pages makes no paid
calls. Recognizable question secrets/identity fields are rejected.

Confirmed redacted account evidence is explicitly selected by authorized store;
ordinary card search never returns it. With account evidence: at most four card
plus two account references. No-evidence answers must report the gap; unsupported
factual findings fail validation. History belongs to the operator. Scope changes
start a conversation; follow-ups fetch current references and use prior question/
summary as conversation context only. Evaluation-purpose tasks stay out of chat.

Recent-conversation listing and previous-run continuation use the same shared
AI read policy as individual run reads, including the pinned data-scope rank.
The latest inaccessible dialogue hides that entire scope rather than falling
back to an older question that cannot be resumed safely. Previous-run output is
authorized before being decrypted into new conversation context; evaluation
records cannot be used as dialogue history, including by manually supplied IDs.
Existing immutable pins remain unchanged.

Completed chat records are re-read every 30 seconds and on focus/visibility;
running records keep their existing three-second progress reads. Denied/missing/
expired reads clear the old answer, pending question and selected account,
rotate the conversation, and discard earlier late responses. A failed history
switch clears the previous answer before loading its destination. These reads
never submit a model job. Functional coverage and remaining real-provider/manual
validation are recorded in the [K01–K12 matrix](../project-control/KNOWLEDGE_ACCEPTANCE_MATRIX.md).

SKU assistants use actual platform/market/recipe SPU. Finance, procurement,
after-sales and creative assistants attach general reviewed guidance while ERP
facts remain authoritative. Order/production checks retain Rule Center inputs.
Encrypted input pins references with existing budget/expiry/current-permission
gates. Later edits/publish/archive never replace historical inputs. Prompt
version erp-assist-2026-10-06-v6 states the knowledge/business-fact boundary.

## Evidence access and retention

KNOWLEDGE_EVIDENCE_ENCRYPTION_KEY is a dedicated production 32-byte base64url
secret, independent of model/order/marketplace/integration keys. Local fallback
uses a domain-specific OIDC-secret derivation. Never log raw or decrypted reports.
Original retention defaults to seven days (1–30 configurable). Original downloads
are audited POSTs requiring manage + approve + uploader; account access additionally
needs current finance/store permission and actual store/uploader scope. Early
purge/expiry leaves confirmed redacted evidence and history. Expired pending
quarantine requires re-import. Archive stops new retrieval; historical task
pins follow their own expiry. Redaction is a heuristic aid: editable preview
and explicit human confirmation are mandatory. Account cases cannot overwrite
current ERP financial values or establish global policy.

## API and persistence

Migrations 0096–0098 add entries/immutable versions/events, documents/candidates,
sources/immutable snapshots/checks/reviews, needs/conflicts, evaluation cases/
immutable runs/events, and immutable evidence links with composite tenant FKs,
deferred provenance checks and original immutability. Every tenant operation
uses withTenant() and the non-owner app role under forced RLS.

/v1/knowledge: read/history/search need workflow:read; create/revise/submit need
manage; publish/reject/disable need approve; archive needs manage and approve if
active. /v1/knowledge-governance: import/candidate/redaction/source/need/evaluation
maintenance need manage; reviews/adjudication/human checks need approve. Account
access additionally needs finance:read + store:read; SPU access needs product:read.
Audit requires read + approve and retains authorized archived-record access.
Dialogue uses /v1/ai-assists and needs read + run; evaluation also needs manage.

Web BFFs /api/knowledge and /api/knowledge-governance enforce method/path allowlists,
same-origin JSON writes, private/no-store reads and transport limits. Governance
uploads allow 7.4 MB JSON for a 5 MiB base64 file; other writes allow 1 MB. See
controllers/contracts for exact routes. Input IDs never select a tenant.

## Acceptance and cleanup

Use the isolated runner with --suite=knowledge-integration and --suite=knowledge.
Browser suite: API 8112, Web 3122, demo flags disabled, healthy ClamAV (pnpm
infra:file-scanning). The runner snapshots current Web sources into an isolated
scratch checkout with independent Next cache/lock, sharing dependencies read-only
and copying no environment files. It removes and verifies the scratch directory
in finally. Other same-worktree suites still require stopping their shared Next
dev server; restore local Web after any maintenance.

Only external source/model transport is fixture-controlled: real auth/API,
scanning, RLS, worker, pins and budgets are exercised. No paid calls or business
fixtures. The runner verifies full DB/bucket/Redis deletion in finally, including
originals and immutable synthetic history. Browser checks import/review/diffs,
redaction, dialogue/evaluation, conflicts and desktop/390px overflow. See the
[acceptance specification](../superpowers/specs/2026-10-06-knowledge-center-governance.md).
