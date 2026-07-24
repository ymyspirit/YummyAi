# YummyAI P3 implementation plan

**Date:** 2026-07-22

**Status:** P3-A through P3-G are implemented and have a pushed clean code candidate, green CI, fresh-database migration, backup/restore, and populated browser evidence. Outstanding P1/P2 and real-provider gates remain open, so P3 is not a release candidate for authorized marketplace operations.

**Goal:** Extend the tenant-isolated fulfillment system into a complete inventory, procurement, finance, advertising, forecasting, and operating-analysis loop without rewriting marketplace, order, or production evidence.

**Boundary:** P3 consumes approved catalog, Listing, order, supplier, production, shipment, and after-sales facts. It does not infer stock, settlement, advertising cost, exchange rates, tax, or profit when source evidence is missing. External writes use supported APIs, immutable commands, explicit authorization, and reconciliation for uncertain outcomes.

## P2 deferral ledger

- P2-E production-batch lifecycle and append-only recovery close/cancel evidence have passed local gates; authorized supplier acknowledgement remains an online acceptance item.
- P2-F shipment, tracking, and marketplace writeback have passed local gates; authorized marketplace/carrier acceptance remains pending.
- P2-G after-sales, operational workspaces, and scheduled automation recovery have passed local gates; release drills and real end-to-end provider acceptance remain pending.
- P1/P2 authorized Amazon, Etsy, Printify, Printful, and carrier smoke evidence remains pending.
- P1 online Listing synchronization now has local narrow and full-content actions with immutable reconciliation evidence; media replacement, bulk/JSON feed publishing, notifications, broader automation, and authorized provider acceptance remain pending.

Starting P3 does not waive these gates and does not make the incomplete fulfillment path a release candidate.

## Cross-module invariants

1. Every warehouse, stock item, lot, ledger entry, reservation, transfer, purchase, receipt, settlement, cost, advertisement, forecast, and metric fact is tenant scoped under forced PostgreSQL RLS.
2. Inventory quantity is derived from an append-only ledger. Balance rows are rebuildable projections and are never accepted as source evidence.
3. One stock movement uses integer base units, an explicit unit of measure, one event time, one recorded time, and a deterministic idempotency key.
4. Reservations cannot make available stock negative unless an explicitly versioned virtual-stock policy allows it. Virtual stock remains distinguishable from physical, in-transit, and provider-owned stock.
5. Lots preserve source, receipt, expiry where applicable, unit cost, currency, and immutable movement lineage.
6. Transfers use paired outbound/in-transit/inbound facts; losing one side creates reconciliation rather than silently changing balances.
7. Procurement versions, receipts, supplier invoices, marketplace settlements, fees, advertising spend, exchange rates, and taxes are immutable financial evidence.
8. Profit is calculated from pinned revenue and cost facts with a named metric version. Missing facts produce incomplete status, never zero-cost profit.
9. Forecasts pin input windows, model/rule version, horizon, generated time, and accuracy evidence. Forecast output never directly mutates stock or purchasing.
10. External API keys, provider payloads, bank data, customer PII, and unrestricted free text are excluded from ordinary projections, jobs, logs, and analytical exports.

## Delivery phases

| Phase | Scope | Local gate |
| --- | --- | --- |
| P3-A | Inventory kernel, warehouses, lots, ledger, balances, reservations, transfers | Replayed movements are idempotent; tenant isolation and non-negative availability hold under concurrency |
| P3-B | Procurement, receipts, replenishment, supplier invoices | One approved purchase version reconciles ordered, received, rejected, and invoiced quantities without rewriting history |
| P3-C | FBA, FBM, overseas, in-transit, virtual inventory, channel allocation | Every channel availability value is traceable to physical/provider/virtual facts and a policy version |
| P3-D | Settlements, commissions, ads, fulfillment/logistics cost, FX, tax, profit | Order/SKU profit is reproducible from pinned facts and incomplete inputs remain explicit |
| P3-E | Supplier quality, delivery, price, response, and capacity performance | Supplier scorecards reproduce from order/receipt/QC evidence and versioned KPI definitions |
| P3-F | Ads, keywords, reviews, VOC, and customer service | Spend and customer signals retain source/version/consent boundaries and cannot change Listing facts directly |
| P3-G | Forecasting, operating cockpit, open API/Webhook, automation, and release | Forecasts and dashboards reconcile to facts; outbound integrations are signed/idempotent; exact-candidate drills pass |

## Phase P3-A: inventory kernel

### Contracts

- Define warehouse type (`owned`, `third_party`, `fba`, `supplier`, `virtual`), location, stock item, unit, lot, movement, reservation, transfer, and balance views.
- Movement types cover opening, receipt, allocation, release, pick, ship, return, adjustment, transfer outbound/inbound, damage, and reconciliation.
- Require source type/ID, idempotency key, occurred time, and reason code. Free-text reason/evidence uses the protected operational boundary.

### Database

- Add tenant-scoped warehouse/location/stock-item/lot identities.
- Add append-only inventory ledger and reservation events plus rebuildable balance/reservation projections.
- Add transfer identity and immutable transfer events. Enforce composite tenant foreign keys, UUIDv7 checks, forced RLS, and append-only application grants.
- Use transaction advisory locks per stock-item/location/lot balance and database checks to prevent invalid unit or negative physical availability.

### API and service

- Create/list warehouses, locations, and stock items through authenticated tenant context.
- Record idempotent movements and reservations inside one tenant transaction; update projections only after immutable evidence inserts.
- Start/dispatch/receive/cancel transfers with optimistic versions and paired inventory facts.
- Provide safe balance and ledger reads with explicit physical, reserved, available, in-transit, provider, and virtual quantities.

### Tests and UI

- Cover duplicate movements, concurrent reservations, insufficient availability, transfer pairing, lot isolation, unit mismatch, cross-tenant IDs, immutable grants, and projection rebuild equivalence.
- Add a dense inventory workspace only after real API empty/error/unauthorized states exist; verify desktop and 390 px widths with frontend skills.

## Phase P3-B: procurement and replenishment

- Separate inventory procurement from P2 customer-fulfillment purchase orders while linking compatible supplier identities.
- Version requisitions, requests for quote, purchase orders, approvals, expected arrivals, receipts, rejections, and supplier invoices.
- Receipts create inventory lots and ledger entries; over-receipt, price variance, and invoice mismatch enter reconciliation.
- Version reorder point, safety stock, MOQ, lead time, service level, and review-calendar policies. Suggested replenishment never self-approves.

## Phase P3-C: fulfillment network and channel availability

- Model FBA, FBM, owned, overseas/3PL, supplier, in-transit, quarantine, damaged, and virtual stock as distinct ownership/availability dimensions.
- Normalize supported provider inventory reports and events behind connector contracts with checkpoints and immutable snapshots.
- Allocate channel availability through versioned policies, caps, buffers, and priority. Unknown provider mutations enter reconciliation.
- Prevent marketplace Listing inventory sync from exceeding the channel allocation projection.

## Phase P3-D: finance and profit

- Ingest marketplace settlements, commissions, advertising fees, FBA/storage fees, refunds, chargebacks, procurement, production, freight, carrier, FX, and tax facts.
- Keep provider statements and normalized lines immutable; corrections use reversal/replacement facts.
- Version exchange rates by source, pair, effective time, and retrieval time. Never silently use the latest rate for historical profit.
- Produce contribution margin and profit by order, line, SKU, Listing, store, platform, supplier, and period with completeness diagnostics.

## Phase P3-E: supplier performance

- Derive quality, on-time delivery, price variance, response time, acceptance, cancellation, and capacity adherence from P2/P3 evidence.
- Pin KPI definitions, windows, weighting, minimum sample, and missing-data policy.
- Scorecards are analytical output only; routing-policy changes require a separately approved version.

## P3-E implementation ledger

- [x] Strict seven-KPI definition, scorecard, metric, diagnostic, and workspace
  contracts.
- [x] Tenant-scoped definition identity/version, immutable run, and immutable
  metric schema and migration.
- [x] Forced RLS, composite tenant foreign keys, and append-only application
  grants.
- [x] Idempotent definition versioning and scorecard API with changed-payload
  conflicts.
- [x] KPI derivation from production, QC, capacity, RFQ/quote, receipt, purchase
  order, and supplier-invoice evidence.
- [x] Explicit `exclude`, `zero`, and `incomplete` missing-data policies with
  pinned raw numerator/denominator, sample count, references, cutoff, and input
  checksum.
- [x] Cross-tenant, replay, changed-payload, seven-KPI reproduction, missing
  sample, and privilege coverage.
- [x] Real-API supplier-performance workspace with explicit empty,
  unauthorized, forbidden, failed, complete, and incomplete states.
- [x] ADR, integration guide, local runbook, and threat-model updates.
- [x] Applied local migration and refreshed local permissions.
- [x] Populated desktop and 390 px browser evidence.
- [x] Current-worktree full local gates.
- [x] Exact-candidate clean commit, push, and CI.

Current local implementation evidence on 2026-07-23:

- Migration `0033_p3_supplier_performance` applies under PostgreSQL 17 and
  passes `drizzle-kit check`.
- The integration suite reproduces all seven KPIs from production, QC,
  capacity, RFQ/quote, receipt, purchase-order, and invoice evidence. It also
  covers exact replay, changed-payload conflict, cross-tenant isolation, and
  append-only privileges.
- `/supplier-performance` consumes the authenticated workspace API. Two real
  API-created incomplete scorecards pin the local definition, evaluation
  window, evidence cutoff, raw values, samples, and evidence references.
- The populated page was checked at 1280 px and 390 px. All fifteen navigation
  items remain present, document-level horizontal overflow is absent, table and
  navigation overflow stays inside their containers, and the browser console
  reports no warnings or errors.

## P3-D implementation ledger

- [x] Strict statement, fact, correction, FX, metric, run, contribution, diagnostic, and workspace contracts.
- [x] Amazon and Etsy settlement normalization boundary using supported provider data shapes.
- [x] Tenant-scoped statement/fact/FX/metric/run/contribution schema and migration.
- [x] Forced RLS, composite tenant foreign keys, and append-only application grants.
- [x] Idempotent statement, FX, metric-version, and profit-calculation API.
- [x] Exact reversal/replacement correction chain and deterministic rational FX conversion.
- [x] Complete and incomplete profit with order, line, SKU, Listing, store, platform, supplier, and period breakdowns.
- [x] Cross-tenant, replay, changed-payload, correction, exact-FX, completeness, and privilege integration coverage.
- [x] Real-API finance workspace with explicit empty, unauthorized, forbidden, failed, and incomplete states.
- [x] Current-worktree full gates plus populated desktop and 390 px browser evidence.
- [x] Exact-candidate clean commit, push, and CI.
- [ ] Authorized Amazon/Etsy settlement retrieval acceptance evidence.

## Phase P3-F: advertising, VOC, and service

- Normalize authorized advertising campaign/ad-group/keyword/search-term metrics and costs with source currencies and attribution windows.
- Link reviews, return reasons, support contacts, quality defects, and keyword evidence into versioned VOC themes without exposing customer identity.
- Keep advertising and content recommendations reviewable; they cannot directly edit approved Listings or budgets.

## Phase P3-G: forecasting, open integration, and release

- Pin sales/inventory/profit forecast inputs, horizons, model versions, quantiles, accuracy, and override evidence.
- Add an operating cockpit with metric definitions, freshness, completeness, drill-through, and reconciliation queues.
- Provide scoped API clients, signed Webhooks, replay protection, delivery attempts, dead letters, and manual replay.
- Run projection rebuild, backup/restore, tenant, concurrency, load, retention, provider-failure, and real authorized end-to-end drills on the exact clean candidate.

## P3-G implementation ledger

- [x] Strict forecast, accuracy, override, metric definition/snapshot,
  reconciliation, API client, Webhook, delivery, attempt, replay, retention, and
  workspace contracts.
- [x] Deterministic moving-average and seasonal-naive forecasts with pinned
  evidence windows, horizons, model versions, quantiles, checksums, and
  append-only evaluations/overrides.
- [x] Tenant-scoped schema and migration `0035_p3_forecasting_operations` with
  forced RLS, immutable evidence grants, rebuildable projections, and
  payload-only retention updates.
- [x] Restricted migration `0036_p3_api_client_authentication` for digest-based
  tenant/client resolution under the application role.
- [x] Versioned operating metrics, freshness/completeness state,
  drill-through, automatic reconciliation, and checksummed projection rebuild.
- [x] Least-privilege read API clients with one-time token disclosure, expiry,
  revocation, wrong-secret rejection, and no caller-selected tenant.
- [x] Encrypted endpoint secrets, canonical HMAC-SHA256 Webhooks, bounded retry,
  persisted attempts, dead letters, linked manual replay, and payload retention.
- [x] Real-API `/operating-cockpit` with parallel planning/integration reads,
  explicit partial states, and fifteen stable navigation items.
- [x] Focused contract, API guard, tenant/isolation, changed-payload,
  projection-rebuild, 100-run load, Worker persistence/exhaustion, Web render,
  navigation, type, lint, and migration checks.
- [x] ADR, integration guide, local/deployment/backup runbooks, PRD, and threat
  model aligned with the implementation.
- [x] Full-worktree unit, integration, E2E, production build, and rule gates.
- [x] Fresh-database migration plus current-worktree backup/restore and
  populated desktop/390 px browser evidence.
- [x] Exact-candidate clean commit, push, CI, and rerun of release drills.
- [ ] Outstanding P1/P2 and authorized inventory, settlement, advertising,
  supplier, carrier, and marketplace acceptance evidence.

Focused implementation evidence on 2026-07-24:

- Planning and integration API integration suites cover immutable source
  validation, exact replay, changed-payload conflict, cross-tenant isolation,
  wrong/expired/revoked API credentials, retention, manual replay, privilege
  restrictions, projection drift repair, and 100 concurrently populated
  forecast runs.
- The Worker database integration suite persists retry attempts and converts a
  retryable upstream failure into a dead letter when its attempt budget is
  exhausted. Response bodies and signing secrets remain outside safe views.
- A real local process restart between event persistence and queue admission
  left one delivery pending. Replaying the exact idempotent publish resubmitted
  that delivery, BullMQ retained the deterministic delivery job ID, and the
  Worker recorded two failed network attempts before dead-lettering it.
- The root lint, typecheck, unit, integration, Web/extension E2E, production
  build, project-rule, migration, and diff gates passed. A fresh PostgreSQL 17
  database applied all 36 migrations and exposed the restricted client
  authentication function. The backup/restore drill restored 44 private
  objects and verified forecasting and Webhook tables before cleanup.
- `/operating-cockpit` was checked with real authenticated local data at 1440 px
  and 390 px. It displayed one forecast, incomplete and unavailable metrics,
  three reconciliations, a scoped client, an endpoint, and the two-attempt dead
  letter. Both widths retained fifteen navigation items without document-level
  overflow or browser console errors; mobile table overflow remained inside
  each table container.
- These focused checks are supplemented by the exact-candidate evidence below.
  They do not satisfy the authorized-provider release gates listed above.

Exact-candidate evidence recorded on 2026-07-24:

- Clean code candidate `5e86e8bf33508f282088d6d98d442068e2eaa181` is pushed on
  `codex/p3-forecasting-operations`.
- GitHub Actions run
  `https://github.com/ymyspirit/YummyAi/actions/runs/30061088615` passed all 36
  migrations through `0036_p3_api_client_authentication`, `drizzle-kit check`,
  lint, typecheck, unit, integration, Web/extension E2E, production build,
  extension ZIP, and the tracked-file credential scan with Node 24.17.0 and
  pnpm 11.10.0.
- The candidate backup manifest recorded PostgreSQL SHA-256
  `1d8de221e84015487c01ca96ce0d0c694685c60e277744a311ff1611ff88e5fe`
  and 46 private objects. The non-destructive restore drill reproduced core
  counts `1526|640|303|69|64|511|8|6931` for organizations, captures, assets,
  inventory, profit, forecasts, Webhook attempts, and audits, restored all 46
  objects, and removed the verification database and bucket.
- A real non-demo development restart served `/operating-cockpit` at 1440x900
  and 390x844. Both widths retained 15 navigation links, zero main alerts, and
  zero document-level horizontal overflow. The page exposed the populated
  forecast and Webhook evidence, and the browser reported no page errors.

## P3-F implementation ledger

- [x] Strict advertising report, metric line, customer signal, VOC definition, analysis, theme, recommendation, and workspace contracts.
- [x] Tenant-scoped schema and migration `0034_p3_customer_intelligence` with forced RLS and append-only evidence grants.
- [x] Existing-source validation and identity-redacted structured signal boundary.
- [x] Idempotent advertising reports, signals, definitions, analyses, and recommendation reviews.
- [x] Pinned source currency, attribution window, analysis window, evidence cutoff, definition version, and signal IDs.
- [x] Review-only recommendations with no Listing, budget, campaign, product, or service mutation path.
- [x] Authenticated API and real-API Web workspace with fifteen stable navigation items.
- [x] ADR, integration guide, local runbook, and threat-model updates.
- [x] Focused contract, database integration, Web render, navigation, and type checks.
- [x] Full-worktree lint, unit, integration, E2E, build, and migration gates.
- [x] Populated desktop and 390 px browser verification.
- [x] Exact-candidate clean commit, push, and CI.
- [ ] Authorized Amazon Ads/Etsy Ads retrieval acceptance evidence.

## P3-A implementation ledger

- [x] Inventory contracts and invariant tests.
- [x] Warehouse, location, stock-item, lot, ledger, reservation, balance, and transfer schema.
- [x] Migration, forced RLS, append-only grants, and projection privilege coverage.
- [x] Idempotent movement/reservation/transfer service and API.
- [x] Concurrency, cross-tenant, immutability, and projection-rebuild integration tests.
- [x] Real-API inventory workspace with explicit operational states and responsive browser evidence.
- [x] Root lint, typecheck, unit, integration, E2E, build, migration, and documentation gates.

Local implementation evidence on 2026-07-23:

- Migration `0029_p3_inventory_kernel` applies under PostgreSQL 17 and passes `drizzle-kit check`.
- The inventory integration suite covers replay, changed-payload conflict, unit mismatch, negative availability, 12 concurrent reservations against 10 available units, release replay, paired transfer movements, cancellation, append-only grants, cross-tenant IDs, and projection rebuild equivalence.
- `/inventory` consumes `/v1/inventory/workspace` through the local OIDC service identity. Empty and populated states were checked at 1280 px and 390 px; the page has no document-level horizontal overflow and mobile table overflow remains scoped to its table container.
- Root lint, typecheck, unit, integration, Web and extension E2E, production
  build, project-rule, migration, and documentation checks passed locally. The
  later exact-candidate evidence is recorded above and does not close any
  deferred provider gate.

## P3-B implementation ledger

- [x] Procurement permissions and strict shared contracts.
- [x] Tenant-scoped requisition, RFQ, supplier quote, inventory purchase-order,
  approval, receipt, invoice, policy, and suggestion schema.
- [x] Migration, forced RLS, composite tenant foreign keys, and append-only
  application grants.
- [x] Idempotent versioned service and authenticated `/v1/procurement` API.
- [x] Atomic receipt-to-lot/movement posting through the inventory service.
- [x] Receipt, rejection, invoice, replay, optimistic-version, cross-tenant,
  immutability, and no-auto-order integration coverage.
- [x] Real-API procurement workspace with explicit operational states and
  responsive browser evidence.
- [x] Procurement ADR, integration guide, local runbook, and threat-model
  updates.
- [x] Root lint, typecheck, unit, integration, E2E, build, migration, rule, and
  diff checks.

Local implementation evidence on 2026-07-23:

- Migration `0030_p3_procurement_replenishment` applies under PostgreSQL 17 and
  passes `drizzle-kit check`.
- The procurement integration suite covers the full
  requisition/RFQ/quote/order/approval/receipt/invoice path, idempotent replay,
  immutable revisions, accepted stock posting, receipt and invoice variance,
  versioned replenishment policies, suggestions without order creation,
  cross-tenant isolation, and append-only privileges.
- `/procurement` consumes `/v1/procurement/workspace` through the local OIDC
  service identity. A populated reconciliation path was checked at 1440 px and
  390 px; the page now shares fifteen navigation items, no document-level horizontal
  overflow, table overflow is scoped to its container, and a fresh browser tab
  reports no console errors.
- Root lint, typecheck, unit, integration, Web and extension E2E, production
  build, project-rule, migration, and diff checks passed locally. The later
  exact-candidate evidence is recorded above and does not close P1/P2 provider
  authorization or P3-C provider inventory gates.

## P3-C implementation ledger

- [x] Strict network inventory, checkpoint, policy, run, projection, and
  reconciliation contracts.
- [x] Amazon, Etsy, and third-party inventory report normalization boundary.
- [x] Tenant-scoped immutable snapshots/lines/checkpoints and forced RLS.
- [x] Versioned allocation policies with source eligibility, virtual opt-in,
  safety buffers, channel caps, buffers, and priority.
- [x] Immutable traceable allocation runs and per-channel projections.
- [x] Approved Listing SKU mapping and current-projection quantity enforcement.
- [x] Stale projection rejection after new evidence or policy revision.
- [x] Interrupted/uncertain Listing mutations create append-only reconciliation.
- [x] Real-API channel inventory workspace with explicit operational states and
  stable fifteen-item navigation.
- [x] Current-worktree full local gates plus populated desktop and 390 px
  browser/E2E evidence.
- [x] Exact-candidate clean commit, push, and CI.
- [ ] Authorized Amazon/Etsy/3PL inventory-report acceptance evidence.

Current local implementation evidence on 2026-07-23:

- Migration `0031_p3_channel_inventory` passes `drizzle-kit check` and applies
  forced RLS with append-only application grants.
- The channel inventory integration suite covers replay conflict, monotonic
  checkpoints, source/condition separation, policy versions, caps, buffers,
  priority, no oversubscription, virtual opt-in, stale projection rejection,
  cross-tenant references, immutable grants, and reconciliation events.
- Connector tests normalize FBA/FBM ownership separately from sellable,
  quarantine, and damaged condition. Provider retrieval itself remains an
  authorized online acceptance gate.
- `/channel-inventory` consumes the authenticated workspace API and does not
  contain demo data. The populated local workspace was checked at 1440 px and
  the real API route passed a 390 px document-overflow assertion. Exact-candidate
  CI is recorded above; authorized provider evidence remains pending.

## P3 acceptance matrix

1. Tenant A cannot observe or mutate Tenant B inventory or financial facts.
2. Replaying the same source event cannot double stock, reservations, receipts, costs, revenue, spend, or Webhook delivery.
3. Physical, reserved, available, in-transit, provider, and virtual quantities reconcile by stock item, location, lot, and event cut-off.
4. Concurrent reservations cannot oversell policy-constrained availability.
5. Transfers, receipts, shipments, returns, damage, and adjustments retain paired source lineage.
6. Profit and supplier KPIs reproduce from immutable facts and named versions; missing facts are explicit.
7. Forecasts and recommendations never directly mutate inventory, purchasing, Listing, advertising, or finance state.
8. Unknown external mutation outcomes remain in reconciliation and are never blindly repeated.
9. Projection rebuild and backup/restore reproduce balances, financial summaries, and audit links.
10. P3 release requires the outstanding P1/P2 live acceptance gates plus authorized inventory/settlement/advertising evidence.
