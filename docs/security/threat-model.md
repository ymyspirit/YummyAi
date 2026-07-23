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
| A mutable balance or caller-provided quantity replaces inventory evidence | append-only movement ledger, rebuildable balance projection, explicit source/reason/time/unit fields | inventory replay and projection-rebuild integration tests |
| Concurrent reservations oversell physical availability | tenant/dimension advisory lock, physical-minus-reserved check, non-negative database constraints | concurrent reservation integration test |
| A transfer records only one side or is replayed twice | paired debit/credit movement IDs, optimistic transfer version, lifecycle idempotency key | transfer pairing and replay integration tests |
| Inventory data or internal command keys cross tenant/UI boundaries | forced RLS, composite tenant foreign keys, safe workspace contract without tenant/actor/idempotency fields | cross-tenant API and workspace contract tests |
| Procurement overwrites a reviewed commercial decision | immutable requisition/quote/order versions, append-only approval events, optimistic expected version | procurement revision and stale-review integration tests |
| Receipt stock is posted without matching receipt evidence | one tenant transaction through the inventory service creates receipt lines, lots, and immutable movements | receipt-to-ledger integration test |
| Quantity, rejection, price, or currency variance is hidden | three-way comparison with explicit `reconciliation_required` state and immutable source evidence | receipt and invoice variance integration tests |
| A replenishment recommendation places an unapproved order | suggestion pins policy and stock inputs but has no purchase-order creation or approval side effect | replenishment no-order integration test |
| Provider inventory collapses ownership or condition into one mutable number | normalized source/condition dimensions, monotonic checkpoints, immutable snapshots and lines | connector normalization and snapshot integration tests |
| Channel policies oversubscribe shared stock | one active policy per stock item, serialized versioned calculation, ordered caps/buffers, database quantity checks | allocation priority and no-oversubscription integration tests |
| A caller bypasses allocation with its own Listing quantity limit | approved Listing SKU-to-stock mapping and server-derived current projection; missing or stale evidence fails closed | Listing allocation guard integration test |
| An uncertain marketplace inventory mutation is repeated | processing-before-call evidence, open channel reconciliation event, no automatic mutation replay | Worker processor and reconciliation integration tests |
| Missing financial evidence is treated as zero profit cost | required fact classifications, explicit missing-FX/unclassified diagnostics, nullable totals on incomplete runs | finance calculation integration tests |
| Historical profit changes when a new FX rate arrives | calculation accepts an explicit rate set and pins selected immutable rational-rate IDs | exact conversion and replay integration tests |
| A settlement or correction overwrites prior financial evidence | append-only statements/facts, exact reversal plus compatible replacement, application-role grant restrictions | correction and privilege integration tests |
| Financial facts or profit cross tenant boundaries | forced RLS, composite tenant foreign keys, authenticated membership permissions, safe workspace contract | cross-tenant finance integration tests |
| A supplier score is manually substituted for operational evidence | scorecards derive only from pinned production, QC, procurement, invoice, and capacity facts | seven-KPI derivation integration test |
| Missing supplier samples silently improve or reduce a score | versioned minimum samples and explicit `exclude`, `zero`, or `incomplete` policy with nullable incomplete totals | missing-policy unit and contract tests |
| A supplier scorecard changes routing or overwrites history | append-only definition versions/runs/metrics and no operational mutation path from the analytical service | privilege, replay, and routing-isolation tests |
| Supplier performance evidence crosses tenant or safe-view boundaries | forced RLS, composite tenant foreign keys, authenticated permissions, and redacted workspace contracts | cross-tenant and workspace tests |

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
- Inventory balance rows are projections, never acceptable audit evidence. Operators cannot update lots, movements, reservation events, transfer events, or rebuild records through the application role.
- Reusing an inventory idempotency key with changed quantity, unit, dimension, or source must return a conflict; clients must not generate a silent replacement command.
- Provider and virtual inventory cannot be inferred from physical stock. Missing provider facts remain explicit until the authorized P3-C connector path supplies evidence.
- Procurement receipts and invoices remain recorded when they disagree. Operators
  must reconcile with new evidence instead of editing accepted versions or
  repeating the external action.
- A replenishment suggestion is analytical evidence only. It cannot create,
  approve, or submit an inventory purchase order.
- Quarantine and damaged provider stock never become channel availability.
  In-transit, supplier, and virtual stock require explicit versioned policy
  inclusion; virtual stock also requires its dedicated opt-in flag.
- A new provider snapshot or policy version makes the previous channel
  projection ineligible for Listing inventory writes until allocation is rerun.
- Provider cursors, raw reports, credentials, and errors do not enter the safe
  Web workspace, audit metadata, or identifier-only queue payloads.
- Missing settlement, cost, tax, or FX evidence never becomes a zero-valued
  finance fact. Incomplete runs retain diagnostics and null aggregate totals.
- A correction cannot edit or delete the original fact. It appends an exact
  reversal before an optional compatible replacement.
- Supplier scorecards cannot accept caller-supplied scores or mutate routing.
  New evidence or a new KPI rule creates a new pinned scorecard run.
- Missing or insufficient supplier evidence follows the definition's explicit
  policy and remains visible in diagnostics; it is never silently imputed.

## Residual risks

Public page layout changes may create partial captures; diagnostics and human review are the mitigation. P2 introduces encrypted customer PII, so application-host or database-migration administrator compromise remains a higher-impact operational risk addressed by dedicated keys, least privilege, access audit, backups, rotation, and retention drills. Marketplace protected-data approval and regional field availability remain external constraints; missing fields must block the relevant fulfillment step rather than be fabricated. P3-C has no authorized Amazon/Etsy/3PL inventory-report acceptance evidence; provider quantities must remain absent until that live gate is run. P3-D has no authorized Amazon/Etsy settlement acceptance evidence; statement facts must remain absent until that gate is run. P3-E can only evaluate the production, quality, procurement, invoice, and capacity evidence currently available; sparse or delayed evidence can make a scorecard incomplete and must not be interpreted as supplier performance. P3-B supplier-order and supplier-invoice provider acceptance also remains pending.
