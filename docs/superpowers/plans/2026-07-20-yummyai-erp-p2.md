# YummyAI ERP P2 Implementation Plan

**Date:** 2026-07-20

**Status:** P2-B through P2-F and the implementable P2-G local slices are complete. Current-worktree backup/restore, PII anonymization, concurrency/quota, queue-failure, E2E, and build drills pass. P1/P2 release closure remains deferred until a clean candidate, CI, exact-candidate reruns, and real-provider gates exist.

**Goal:** Build a tenant-isolated fulfillment path from a normalized marketplace order through customization, design approval, supplier allocation, production, quality control, shipment, platform writeback, and after-sales evidence.

**Boundary:** P2 uses supported marketplace, POD, and carrier APIs. It does not scrape seller consoles, infer missing buyer instructions, expose customer PII outside an authorized fulfillment purpose, or absorb P3 inventory/accounting scope.

## P1 Deferral Ledger

P1-A through P1-F have passed local code gates. The following work remains P1-owned and must not be silently relabeled as P2 completion:

- registered Amazon/Etsy applications, authorized non-production stores, and real provider smoke evidence;
- P1-G delayed and bulk publication, per-account concurrency/quota control, cancellation, provider notifications, background reconciliation, and release automation;
- online Listing content synchronization, delayed/bulk orchestration, and broader automation triggers/actions beyond the implemented price/inventory reconciliation, same-platform site replication, and `listing_approved` rules.

P2-A through P2-E may use deterministic connector fixtures in tests while store authorization is deferred. Real order ingestion, shipment writeback, and the P2 release gate still require authorized stores. Demo records are never acceptance evidence.

## Official Integration Baseline

Amazon:

- Target Orders API `v2026-01-01` for new order reads. Use `searchOrders` for bounded incremental backfill and `getOrder` with the minimum required `includedData` sets.
- Subscribe to `ORDER_CHANGE`; do not build new work on deprecated `ORDER_STATUS_CHANGE` notification types.
- Treat shipping address and buyer data as purpose-limited PII. Request only the roles needed by the fulfillment flow.
- Use supported shipment confirmation or shipment-status APIs selected for the seller fulfillment program. Record external acknowledgement before retryable follow-up work.

References:

- [Orders API v2026-01-01](https://developer-docs.amazon.com/sp-api/lang-de_DE/reference/orders-v2026-01-01)
- [Get order information](https://developer-docs.amazon.com/sp-api/docs/get-order-information)
- [ORDER_CHANGE tutorial](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/tutorial-subscribe-to-order-change-notification)

Etsy:

- Read receipts and receipt transactions with `transactions_r`, using modified-time checkpoints and bounded pagination.
- Submit shipment/tracking updates with `transactions_w` only after an immutable local shipment version is approved.
- Preserve Etsy receipt, transaction, listing, variation, personalization, and shipment identifiers as external references; never use display text as identity.
- Address availability varies by region and partner status. Missing protected fields remain explicit and cannot be fabricated.

Reference:

- [Etsy Open API v3 reference](https://developers.etsy.com/documentation/reference/)

## Cross-Module Invariants

1. Every order, line, customization, routing decision, production record, shipment, return, event, and connector checkpoint is tenant scoped and protected by forced RLS.
2. Provider payload snapshots and inbound events are immutable. Corrections append normalized versions or events.
3. Provider identity is unique by tenant, marketplace account, platform, external order ID, and external line ID where applicable.
4. Main fulfillment state and exception state are separate. Resolving an exception never rewrites fulfillment history.
5. Money uses integer minor units plus ISO currency. Quantities and dimensions use explicit units.
6. Customer PII is minimized, purpose limited, access audited, excluded from logs/jobs/diagnostics, and deleted or anonymized by retention policy without breaking financial or operational references.
7. No production command is allowed until customization requirements, asset rights, approval gates, and routing prerequisites pass.
8. Automated supplier allocation records candidates, inputs, scores, policy version, and the selected decision. A manual override appends a reason and actor.
9. A shipment or refund writeback pins one immutable local version and one idempotency key. Uncertain provider outcomes require reconciliation.
10. Research assets remain ineligible for design, production, shipment, or customer-message workflows.

## Unified State Model

Main order state:

`pending -> awaiting_customization -> awaiting_design -> awaiting_customer_approval -> awaiting_routing -> in_production -> awaiting_quality_control -> awaiting_shipment -> shipped -> completed`

Side/terminal state:

`on_hold / cancelled`

Independent exception categories:

`address / customization_missing / design_overdue / customer_timeout / sourcing / production / quality / logistics / cancellation_requested / refund / remake / reshipment`

Provider state is retained separately from normalized workflow state. A provider status update can propose a transition but cannot bypass local guards.

## Delivery Phases

| Phase | Scope | Gate |
| --- | --- | --- |
| P2-A | Order kernel, PII boundary, state/event model | Tenant isolation, immutability, idempotency, and transition tests pass |
| P2-B | Order ingestion, deduplication, checkpoints, risk inbox | Replayed fixture events create one normalized order and explicit diagnostics |
| P2-C | Customization, design, and customer approval | Required inputs and approved assets gate production eligibility |
| P2-D | Supplier sourcing, purchase, and routing | Deterministic allocation is explainable and manual override is audited |
| P2-E | Production, quality control, remake, and cancellation | Production lineage and exception recovery remain complete and immutable |
| P2-F | Shipment, tracking, and platform writeback | One shipment version writes back idempotently and reconciles uncertain outcomes |
| P2-G | After-sales, operational UI, automation, and release | Real authorized orders complete the full fulfillment and writeback matrix |

## Phase P2-A: Order Kernel

### Contracts

- Add normalized order, line, money, address reference, customization value, workflow state, exception, event, and transition command schemas.
- Keep public order views separate from privileged fulfillment views containing protected address or buyer fields.
- Define provider-neutral ingestion envelopes and deterministic idempotency keys without embedding tokens or raw PII in job data.

### Database

- Add tenant-scoped order, order-line, external-reference, immutable source-snapshot, event, exception, and connector-checkpoint tables.
- Force RLS and use the non-owner application role for all service operations.
- Store sensitive fulfillment fields in a dedicated encrypted envelope or separately protected table with access-purpose audit records.
- Prevent update/delete on immutable snapshots and events for the application role.

### API and Service

- Add read/list endpoints, explicit transition commands, exception open/resolve commands, and privileged fulfillment-detail reads.
- Validate every transition against current state and prerequisites inside one tenant transaction.
- Append audit and domain events with the state change; never make cross-module direct table writes.

### Worker and Tests

- Add connector-neutral ingestion jobs with replay-safe fixture adapters used only by tests.
- Cover transition validity, event ordering, duplicate delivery, cross-tenant IDs, PII redaction, encrypted-field access, and immutable-history enforcement.
- Add an order inbox UI only after the real API path and explicit empty/error/unauthorized states exist.

## Phase P2-B: Ingestion and Risk Inbox

- Add account-scoped incremental checkpoints, bounded backfill, pagination, event replay, and late-update handling.
- Normalize Amazon orders and `ORDER_CHANGE`, then Etsy receipts and transactions behind one connector contract.
- Link external lines to approved SKU/Listing versions without changing historical order facts when catalog data changes.
- Detect duplicates, address gaps, missing customization, unsupported mappings, cancellation requests, and stale provider data.
- Show collected-versus-reported counts and checkpoint freshness; never claim synchronization when protected fields are unavailable.

## Phase P2-C: Customization and Approval

- Map marketplace personalization, variation, buyer text, and buyer-provided files to the pinned `CustomizationSchema` version.
- Quarantine unsupported files and retain malware-scan evidence before authorized asset promotion.
- Support template-ready, designer-required, and customer-approval-required paths.
- Version proofs and customer decisions; timeouts create exceptions rather than implicit approval.

## Phase P2-D: Sourcing and Routing

- Add supplier quotes, capability snapshots, purchase orders, production-order candidates, capacity windows, and routing policy versions.
- Score capability, region, cost, lead time, capacity, quality, and priority with deterministic tie-breaking.
- Require human approval above configured cost/risk thresholds and for every manual override.
- Treat Printify/Printful as supplier connectors behind the same production-order contract.

## Phase P2-E: Production and Quality

- Track production batches, consumed design/production asset versions, milestones, operator evidence, and expected completion.
- Define quality standards, inspections, defects, responsibility, remake, reshipment, and cancellation compensation paths.
- Keep remake lineage linked to the original line and production order without overwriting either record.

## Phase P2-F: Shipment and Writeback

- Add package, label, carrier service, tracking event, promised/estimated delivery, and shipment-version models.
- Confirm shipment only from an approved immutable shipment version and record external acknowledgement before retries.
- Normalize tracking events, delivery exceptions, delay alerts, and split/combined shipment relationships.
- Reconcile provider status and local fulfillment status without treating provider acceptance as final delivery.

## Phase P2-G: After-Sales and Release

- Add customer contact records, refund/return decisions, return shipments, replacement orders, and responsibility evidence.
- Add dense operational workspaces for order inbox, customization, production, logistics, and exception queues.
- Add scheduled automation with quotas, cancellation, dead-letter handling, notification routing, and manual reconciliation.
- Execute backup/restore, PII retention/deletion, cross-tenant, load, failure, and real provider acceptance drills on the exact release candidate.

### P2-G implementation ledger

- [x] Tenant-scoped after-sales cases with encrypted summaries and safe queue projections.
- [x] Append-only encrypted customer contacts, optimistic refund/return/replacement decision versions, and responsibility evidence.
- [x] Refund amount/currency bounds, authorized evidence-asset checks, return tracking state machine, delivered resolution, and acyclic replacement lineage.
- [x] Migration `0026_p2_after_sales`, forced-RLS privileges, contract tests, API integration tests, and database isolation/append-only checks.
- [x] Dense operational workspaces for customization, production, logistics, and exception/after-sales queues, verified at 1280 px and 390 px without document overflow.
- [x] Scheduled automation quotas, cancellation, bounded retry/dead-letter handling, requester notification routing, identifier-only delayed jobs, and optimistic manual reconciliation.
- [x] Explicit expiry-gated PII anonymization with a separate permission, optimistic order/envelope versions, ciphertext removal, checksum-only evidence, replay safety, and cross-tenant tests.
- [x] Current-worktree backup/restore, PII retention, 25-way quota/concurrency, queue-failure/dead-letter, and E2E drills; exact clean-candidate rerun remains a release gate.
- [ ] Marketplace refund execution/reconciliation and real authorized Amazon/Etsy order-to-after-sales evidence. Amazon requires a correctly allocated Order Adjustments Feed; Etsy Open API payment/refund operations are read-only, so this cannot be reduced to store authorization alone.
- [ ] Exact-candidate backup/restore, PII retention/deletion, load/failure, CI, and clean-worktree release gates.

## First Execution Slice

P2 starts with P2-A only:

1. Write an order-domain ADR and extend the threat model for customer PII and inbound provider events.
2. Add contracts and transition tests before database or UI code.
3. Add tenant-scoped schema and migrations with immutable/RLS integration tests.
4. Add repository, service, and API commands through `withTenant()`.
5. Add deterministic ingestion fixtures and duplicate-delivery tests.
6. Add the read-only order inbox through real API paths.
7. Run lint, typecheck, unit, integration, E2E, build, migration check, and browser verification.

Do not start P2-B provider adapters until P2-A invariants and PII boundaries pass their gate.

### P2-A implementation ledger

- [x] Order-domain ADR and customer-PII/inbound-event threat-model extension.
- [x] Public and privileged order contracts, money/address/customization schemas, transition graph, and tests.
- [x] Tenant-scoped order schema, migration `0018_p2_order_kernel`, forced RLS, and append-only application grants.
- [x] Read/list, state transition, side-state, exception, event, and purpose-bound fulfillment APIs through `withTenant()`.
- [x] Dedicated encrypted PII envelope, retention metadata, protected-access events, and safe audit metadata.
- [x] Deterministic duplicate-delivery fixture coverage and identifier-only worker job boundary.
- [x] Real-API read-only `/orders` inbox with explicit empty, unauthorized, forbidden, and failed states.
- [x] Targeted contract, API, worker, Web, transition, encryption, replay, RLS, and cross-tenant tests.
- [x] Root lint, typecheck, unit, integration, E2E, build, migration check, and desktop/mobile browser verification on the current worktree.

This ledger records local implementation progress only. It is not a P2-A release declaration and does not satisfy the real-provider acceptance requirements assigned to later P2 phases.

### P2-B implementation ledger

- [x] Connector-neutral bounded backfill, pagination, checkpoint, freshness, and late-update overlap contract.
- [x] Monotonic checkpoint advancement that publishes a new high-water mark only after the final page.
- [x] PII-free diagnostics for duplicate delivery, address gaps, missing customization, unsupported mapping, cancellation requests, and stale provider data.
- [x] Deterministic tests for window bounds, replay overlap, cursor progression, checkpoint monotonicity, and risk coverage.
- [x] Amazon Orders `v2026-01-01` and `ORDER_CHANGE` 1.0 normalizers producing the shared order/enrichment records.
- [x] Etsy Open API v3 receipt/transaction normalizer producing the shared order record.
- [x] Amazon/Etsy HTTP page adapters, bounded orchestration, and normalized retry/rate-limit behavior under deterministic fixtures.
- [x] Immutable source materialization and late-update events, catalog-version line pins, serialized checkpoint repository, and collected-versus-reported risk inbox projection.
- [x] Local connector, contract, API integration, RLS/privilege, root lint/typecheck, and desktop/390 px browser checks for the P2-B slice.
- [ ] Authorized Amazon/Etsy live pagination, refresh-token rotation, and reconciliation evidence.
- [ ] Real authorized-store ingestion and reconciliation acceptance evidence.

Checked P2-B items describe connector-boundary code and fixture evidence only. They do not claim a live marketplace synchronization.

### P2-C implementation ledger

- [x] Marketplace personalization, variation, buyer text, and file references map to the order line's pinned `CustomizationSchema` snapshot.
- [x] Mapped values/file references remain encrypted; safe summaries expose only field keys, completeness, path, version, status, and deadline.
- [x] Optimistic remapping appends a new immutable customization version after late protected-provider updates and never repopulates anonymized PII.
- [x] Tenant quarantine intake, safe generated filenames, schema media/size policy, byte-length/SHA-256 integrity verification, and copy-only authorized promotion.
- [x] Identifier-only `customization-file-scan` jobs, ClamAV INSTREAM adapter, append-only engine/signature evidence, retry-safe final-state handling, and queue dispatch recovery.
- [x] Template-ready, designer-required, and customer-approval-required paths with approved-design, clean-file, proof, and production transition gates.
- [x] Immutable proof versions, serialized replay-safe customer decisions, and timeout-to-exception behavior without implicit approval.
- [x] Migration `0021_p2_customization_approval`, forced RLS, mutable-projection versus append-only grants, and cross-tenant/privilege integration coverage.
- [x] Real-API `/orders` customization/proof-gate queue with explicit empty/error states and desktop 1440 px plus mobile 390 px no-overflow browser evidence.
- [x] Local ClamAV 1.4.5 signature `28068` clean/EICAR acceptance, targeted contract/API/Worker/Web/RLS tests, lint, and typechecks on the current worktree.
- [ ] Authorized Amazon/Etsy protected file-reference retrieval and provider-specific customer-decision callback evidence.

Checked P2-C items are local implementation and fail-closed scanner evidence. They do not substitute for marketplace protected-data approval, authorized-store file retrieval, or a release-candidate CI result.

### P2-D implementation ledger

- [x] Tenant-scoped suppliers plus append-only capability, quote, capacity, and routing-policy versions.
- [x] Deterministic eligibility and integer-basis-point scoring across capability, region, cost, lead time, capacity, quality, and priority with the documented stable tie breaker.
- [x] Canonical input checksum, ranked candidate/exclusion/score persistence, idempotent line evaluation, and a sourcing exception when no supplier qualifies.
- [x] Cost/risk human-review thresholds, optimistic review versions, and eligible-candidate-only manual override with mandatory actor/reason evidence.
- [x] Supplier-grouped purchase-order projections backed by immutable versions that pin line quantity, unit cost, and routing-decision IDs.
- [x] `awaiting_routing -> in_production` transaction gate requiring every latest line decision and current purchase-order version.
- [x] Migration `0022_p2_supplier_routing`, forced RLS, append-only versus projection grants, cross-tenant coverage, and local migration verification.
- [x] Shared protected production-order contract plus separately confirmed Printify and Printful HTTP adapters under deterministic fixtures.
- [x] Contract, engine, connector, database, and full API integration/typecheck/lint gates for the P2-D slice.
- [ ] Authorized Printify/Printful draft, explicit production submission, acknowledgement, and reconciliation evidence.

Checked P2-D items prove local routing and connector behavior only. They do not claim that a supplier was charged, that a real production order was submitted, or that provider credentials have been authorized.

### P2-E implementation ledger (local complete)

- [x] Production-order projection and immutable versions pin routing decision, purchase-order version, quantity, design version, production assets, and expected completion.
- [x] Encrypted production instructions and milestone notes with a strict optimistic milestone state machine.
- [x] Immutable weighted quality-standard versions, inspections, defect responsibility/disposition, and authorized evidence-asset checks.
- [x] Production-to-QC and QC-to-shipment transaction gates based on latest production lineage and passed inspections.
- [x] Failed inspection opens an independent quality exception; remake creates a child production order without rewriting the failed original.
- [x] Explicit reship and cancellation-compensation recovery contracts and encrypted recovery identity records.
- [x] Migration `0023_p2_production_quality`, forced RLS, append-only grants, contract tests, and production/quality/remake integration coverage.
- [x] Production-batch grouping, immutable membership, optimistic supplier lifecycle evidence, and all-members-complete gate.
- [x] Append-only recovery resolution/cancellation events, remake completion/QC gate, and external-reference-gated compensation evidence.
- [x] Migration `0024_p2_production_batch_recovery`, forced RLS, append-only grants, controller routes, and batch/recovery integration coverage.
- [ ] Authorized Printify/Printful production acknowledgement and failure/reconciliation evidence.

P2-E is locally complete. Provider acknowledgement remains an online acceptance gate and is not replaced by fixture tests.

### P2-F implementation ledger (local complete)

- [x] Immutable shipment versions with ship/promised/estimated dates, carrier service, tracking, label evidence, and split/combined package-line allocation.
- [x] Current-version approval with encrypted reviewer reasons and cross-shipment quantity over-allocation prevention.
- [x] Identifier-only `shipment-writeback` jobs, dispatched-before-call evidence, and interrupted/uncertain mutation reconciliation without automatic replay.
- [x] Amazon `confirmShipment` and Etsy receipt tracking connectors under deterministic HTTP fixtures.
- [x] External-acknowledgement-gated `shipped` transition and full acknowledged-quantity coverage.
- [x] Append-only normalized tracking, provider-event replay handling, explicit delay/carrier exceptions, and all-package-delivered completion gate.
- [x] Migration `0025_p2_shipment_writeback`, forced RLS, append-only grants, API/Worker routes, and local contract/connector/API/Worker/database coverage.
- [ ] Authorized Amazon/Etsy shipment confirmation, provider reconciliation, and carrier tracking evidence.

P2-F is locally complete. Marketplace and carrier acceptance remains an online gate and is not replaced by fixture tests.

## P2 Acceptance Matrix

1. Tenant A cannot observe Tenant B order IDs, customer data, events, files, supplier routing, shipments, or exceptions.
2. Replaying the same provider event cannot create a second order, line, transition, shipment, refund, or external writeback.
3. Missing customization, address access, rights, approval, supplier capability, or shipment evidence blocks the relevant transition.
4. Customer PII is absent from logs, queue payloads, notification bodies, diagnostics, exports, and unprivileged API responses.
5. Provider updates arriving late or out of order preserve history and converge deterministically.
6. Main workflow and exception workflow remain independently queryable and auditable.
7. Automated allocation is reproducible from pinned inputs and every override records actor and reason.
8. Uncertain provider mutations enter reconciliation and are not automatically repeated.
9. Backup/restore preserves order history, encrypted references, events, and object relationships.
10. Real authorized Amazon/Etsy orders complete order intake through shipment/status writeback before P2 release.
