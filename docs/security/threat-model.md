# YummyAI threat model

## Assets and trust boundaries

Protected assets are tenant records, private files, provider credentials, user sessions, AI prompts/results, export packages, and audit history. Trust boundaries exist at the browser extension, web/API edge, OIDC issuer, worker queue, PostgreSQL RLS role, Redis, S3/MinIO, external AI providers, and OTLP pipeline.

| Threat | Control | Verification |
|---|---|---|
| Cross-tenant IDOR | permission guard, tenant context, forced PostgreSQL RLS, tenant-prefixed object keys | integration and E2E RLS tests |
| Research media exported as production | separate asset domains, rights approval, processor-side recheck | export processor tests |
| Approved content mutated | immutable DB triggers and version creation | design/Listing integration tests |
| Prompt injection changes tools/budget/schema | untrusted source message separation, fixed tool policy, output schema, evidence validation | analysis processor fixtures |
| AI cost exhaustion | per-task and monthly budget ledger/caps | AI gateway tests |
| Credential/log leakage | secret vault, centralized recursive redaction, collector attribute removal | redaction tests and CI scan |
| Replay/duplicate jobs | UUIDv7 envelope, idempotency key, attempt cap | jobs contract/queue tests |
| Stale or stolen file URL | tenant/domain check and signed URL expiry ≤600s | storage policy/E2E tests |
| Malicious captured HTML | parser allowlist, public DOM extraction, no page-script instructions | extension parser tests |
| Backup disclosure or destructive restore | encrypted off-host retention, checksums, isolated restore target, two-person production switch | restore drill evidence |
| Customer PII exposed to ordinary order readers | separate encrypted detail table, `order:pii:read`, purpose-bound endpoint, access audit | API permission and integration tests |
| PII leaked through jobs, logs, diagnostics, or snapshots | identifier-only job schema, recursive redaction, redacted snapshot contract, no plaintext audit metadata | contract, redaction, and ingestion fixture tests |
| Duplicate or out-of-order provider deliveries | account-scoped external-event uniqueness, deterministic idempotency, append-only snapshots/events | replay and event-order integration tests |
| Concurrent workers advance one order checkpoint | per-stream advisory lock, one-active-run partial unique index, optimistic checkpoint version update | concurrent-start and checkpoint-regression integration tests |
| Provider count or catalog-match gaps are hidden | collected-versus-reported evidence, append-only static risks, immutable SKU/Listing-version pins | coordinator, risk projection, and catalog-pin integration tests |
| Unauthorized fulfillment transition | transaction lock, expected sequence, explicit transition graph, side-state and prerequisite guards | order state-machine tests |
| PII retained beyond purpose | retention timestamp, dedicated `order:pii:anonymize` permission, expiry/version checks, ciphertext removal without history deletion, checksum-only evidence | API integration test and retention drill before P2 release |
| Malicious or substituted customer file reaches production | tenant quarantine domain, safe generated filename, length/SHA-256 verification, ClamAV evidence, copy-only authorized promotion | storage, Worker, API integration, and RLS tests |
| Conflicting proof callbacks produce two outcomes | per-proof advisory lock, replay-safe external decision ID, append-only decision evidence | concurrent-decision integration test |
| Supplier data changes make allocation irreproducible | immutable capability/quote/capacity/policy versions, canonical input checksum, recorded candidates and scores | routing engine and persistence integration tests |
| Automated or manual allocation bypasses commercial risk | cost/quality approval thresholds, eligible-candidate-only override, actor/reason event, optimistic decision version | threshold, override, and stale-review integration tests |
| Production starts without a pinned purchase decision | latest-decision-per-line and current purchase-order-version gate in the order transition transaction | routing-to-production integration test |
| Supplier API error leaks token or recipient PII | scoped credentials, status-only connector errors, no raw response/error body | connector redaction test |
| Production notes or defect descriptions expose personalization/PII | encrypted instructions, milestone notes, defect details, and recovery reasons; safe checksum/code projections | production persistence and public-view integration tests |
| Quality evidence is replaced or evaluated against a moving rule | append-only standard/inspection/defect rows, pinned standard ID, authorized-asset verification | quality and RLS integration tests |
| A remake overwrites failed production history | child production order with immutable copied version and parent lineage; original remains on quality hold | remake-lineage integration test |
| A batch or recovery is closed without operational evidence | immutable batch membership/events, optimistic projection versions, all-members-complete gate, replacement-QC gate, and required external references | production batch/recovery integration and RLS tests |
| A stale or over-allocated shipment version is confirmed | immutable versions, current-version approval, package-line quantity aggregation, and approved-version writeback pin | shipment allocation and writeback integration tests |
| An uncertain shipment mutation is repeated | dispatched-before-call event, identifier-only queue job, interrupted-attempt reconciliation state, and no automatic mutation replay | Worker processor and writeback state-machine tests |
| Marketplace acceptance is mistaken for delivery | separate writeback and carrier event streams; order completion requires latest delivered evidence for every acknowledged package quantity | tracking delay/exception and delivery gate integration tests |
| Customer messages leak through after-sales views or audit | encrypted free text, checksum-only public projections, structured audit metadata | after-sales persistence and response integration tests |
| Refund amount or currency exceeds the normalized order | integer-minor-unit bounds, exact currency match, full/partial distinction | refund decision integration tests |
| Return or replacement closes without evidence | approved-current-decision gate, valid return tracking state machine, delivered resolution, acyclic replacement lineage | return/replacement integration and RLS tests |
| Runaway fulfillment automation exhausts workers/providers | tenant hourly quota, bounded attempts, delayed backoff, identifier-only jobs, database claim gate | scheduling, quota, cancellation, and Worker tests |
| Failed or uncertain automation is silently repeated | persisted attempt counter, dead-letter state, reconciliation-required state, operator notification, optimistic manual reconciliation | failure/retry/dead-letter integration tests |

## Abuse cases

- Disabled memberships must fail before tenant context creation.
- A user cannot select a tenant solely by request header; membership is resolved from the authenticated subject.
- Competitor/research files cannot be promoted by changing metadata; promotion copies through the policy service and creates a new authorized record.
- Job progress and notification streams are tenant scoped and resume only from visible event IDs.
- Raw prompts, authorization headers, tokens, cookies, and credentials are excluded from logs and telemetry.
- Buyer names, email addresses, phone numbers, address lines, postal codes, and protected provider payload fragments are excluded from public order views, queue payloads, notifications, exports, diagnostics, and audit metadata.
- Fulfillment-detail reads require an allowed purpose and append a tenant-scoped access event before returning plaintext.
- Missing protected fields remain explicit; services never infer or fabricate a customer address or contact value.
- Customer-provided filenames, file references, and customization values are excluded from queue payloads and ordinary order/customization projections.
- `clamd` TCP is bound to loopback/private infrastructure only; it has no transport authentication and is not an Internet-facing service.
- Printify/Printful draft creation never implies human approval or production submission. The charge/production endpoint is a separate explicit action owned by production orchestration.

## Residual risks

Public page layout changes may create partial captures; diagnostics and human review are the mitigation. P2 introduces encrypted customer PII, so application-host or database-migration administrator compromise remains a higher-impact operational risk addressed by dedicated keys, least privilege, access audit, backups, rotation, and retention drills. Marketplace protected-data approval and regional field availability remain external constraints; missing fields must block the relevant fulfillment step rather than be fabricated.
