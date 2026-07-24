# YummyAI ERP P1 Implementation Plan

**Date:** 2026-07-19

**Goal:** Add authorized Amazon/Etsy store connections and a controlled path from an approved Listing version to marketplace draft creation, publication, and state writeback.

**Boundary:** P1 uses supported marketplace APIs. It does not automate Seller Central or Etsy seller pages, ingest orders, or expand into P2 fulfillment.

## Official Integration Baseline

Amazon:

- Register an SP-API application with the Product Listing role.
- Store the LWA refresh token and application credentials as encrypted server-side secrets.
- Resolve current requirements from Product Type Definitions instead of hard-coding marketplace attributes.
- Use Listings Items for individual SKU create/update/read/delete and JSON Listings Feed for bulk work.
- Reconcile issues and availability through Listings Items data and listing notifications.

References:

- [Manage Product Listings](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide)
- [Authorize Private Applications](https://developer-docs.amazon.com/sp-api/docs/self-authorization)
- [Retrieve Product Type Definitions](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/retrieve-a-product-type-definition)
- [Retrieve Listing Details](https://developer-docs.amazon.com/sp-api/docs/retrieve-details-about-a-listing)

Etsy:

- Every request uses the application API key; store-writing endpoints also require OAuth 2.0.
- Request the minimum scopes, initially `listings_r listings_w shops_r`.
- Create a draft, upload/associate media and inventory, then explicitly activate the Listing.
- Read QPS/QPD headers and honor `retry-after` on `429` responses.

References:

- [Authentication](https://developers.etsy.com/documentation/essentials/authentication/)
- [Listings Tutorial](https://developers.etsy.com/documentation/tutorials/listings/)
- [Rate Limits](https://developers.etsy.com/documentation/essentials/rate-limits/)

## Cross-Platform Invariants

1. Credentials are encrypted at rest, decrypted only inside the connector execution boundary, and never returned to a browser or job payload.
2. Every store record, credential, capability snapshot, publish job, and event is tenant scoped and protected by forced RLS.
3. Publishing pins one approved Listing version and its authorized asset versions.
4. Idempotency is based on tenant, marketplace account, Listing version, and requested action.
5. A retry never creates a second external Listing after an external ID has been recorded.
6. Rate-limit responses schedule delayed work; they never use tight retry loops.
7. Platform responses are normalized but retained in redacted diagnostic metadata for audit.
8. Store authorization can be revoked or disabled without preventing users from viewing historical publication records.

## Unified States

Marketplace account:

`pending_authorization -> active -> degraded -> revoked / disabled`

Publication:

`queued -> validating -> creating_draft -> uploading_media -> activating -> syncing -> published`

Terminal/side states:

`failed_retryable / failed_terminal / cancelled / deactivated`

## Delivery Phases

| Phase | Scope | Gate |
| --- | --- | --- |
| P1-A | Store account model, permissions, connector contracts | Tenant-scoped account metadata and health state pass integration tests |
| P1-B | Amazon/Etsy authorization | Encrypted credentials can be created, rotated, revoked, and never returned |
| P1-C | Capability synchronization | Marketplace/product-type/taxonomy/shipping data is versioned and cached |
| P1-D | Publication pipeline | Approved Listing version creates one idempotent external draft |
| P1-E | Media, activation, and state writeback | Draft becomes active and external status/issues are reconciled |
| P1-F | Store and publication UI | Users can authorize, diagnose, publish, retry, and inspect audit history |
| P1-G | Scheduling, bulk publishing, and release | Delayed/bulk work respects quotas and the full P1 E2E matrix passes |

## Phase P1-A: Store Account and Connector Foundation

Implementation status:

- [x] Marketplace account contracts and platform-specific validation
- [x] Provider-neutral connector and deterministic error contracts
- [x] Tenant-scoped `marketplace_accounts` migration with forced RLS
- [x] Store permissions and redacted account metadata API
- [x] Tenant isolation, account lifecycle, audit, retry-header, and schema tests

### Contracts

- Add marketplace platform, authorization mode, account status, health status, region, capability, and public account schemas.
- Add create/update inputs that cannot contain credential values.
- Add `StoreRead`, `StoreManage`, `StoreAuthorize`, and `ListingPublish` permissions.

### Persistence

- Add `marketplace_accounts` with tenant, platform, display name, external account ID, region, marketplace IDs, authorization mode, status, scopes, capabilities, and health metadata.
- Enforce UUIDv7, platform/status checks, tenant uniqueness, indexes, forced RLS, and application-role grants.
- Do not add plaintext credential columns to this table.

### Connector boundary

- Add a provider-neutral connector package shared by API and worker.
- Define authorization, health, capability sync, draft creation, media upload, activation, status read, and rate-limit result contracts.
- Add deterministic connector errors: authorization, validation, rate limit, conflict, retryable upstream, and terminal upstream.

### API

- `GET /v1/marketplace-accounts`
- `GET /v1/marketplace-accounts/:id`
- `POST /v1/marketplace-accounts`
- `PATCH /v1/marketplace-accounts/:id`
- Responses expose `hasCredential` and health metadata only; never encrypted or plaintext secrets.

### Verification

- Schema tests reject invalid platform/status and credential-shaped input.
- Connector tests normalize health and rate-limit behavior.
- API integration tests cover tenant isolation, duplicate account identity, redacted responses, disable/re-enable, and audit events.

## Phase P1-B: Authorization

Implementation status:

- [x] Separate tenant-scoped encrypted credential storage with versioned rotation
- [x] One-time, expiring OAuth state storage with encrypted Etsy PKCE verifier
- [x] Amazon private refresh-token verification and credential rotation endpoint
- [x] Amazon public regional authorization URL and LWA code exchange
- [x] Etsy Authorization Code with S256 PKCE and exact redirect URI reuse
- [x] Local revocation with ciphertext deletion, account lockout, and audit trail
- [x] Integration tests for encryption, redaction, RLS, replay, expiry, frozen scopes, rotation, and revocation
- [ ] Real Amazon/Etsy authorization smoke tests with approved non-production accounts

Amazon private application path:

- Accept a refresh token only over the authenticated API.
- Encrypt LWA refresh token, client ID, and client secret separately or in a versioned secret envelope.
- Exchange refresh token server-side and verify seller/marketplace identity before activation.

Amazon public application path:

- Generate state-bound authorization URLs and validate OAuth callback state.
- Exchange the authorization code server-side and bind the returned seller identity.

Etsy path:

- Implement Authorization Code with PKCE and exact redirect URI validation.
- Request minimum scopes and persist granted scopes from the token response.
- Reauthorization is required when scopes change.

Gate:

- Token values do not appear in responses, logs, audit metadata, URLs, or job payloads.
- Rotation and revocation are covered by integration tests.

Code gate passed on 2026-07-19. External smoke evidence remains a P1 release gate and requires registered applications and authorized stores.

## Phase P1-C: Capability Synchronization

Implementation status:

- [x] Immutable, tenant-scoped capability snapshots with forced RLS and monotonic versions
- [x] Account capability freshness, expiry, health, and activation metadata
- [x] Amazon LWA refresh, regional marketplace participation, and targeted Product Type Definition/schema synchronization
- [x] Etsy OAuth refresh, shop identity, sections, shipping profiles, readiness profiles, return policies, seller taxonomy, and targeted taxonomy properties
- [x] Connector rate-limit/error normalization and refreshed-token rotation
- [x] API read/sync routes with cross-platform input and stale-result validation
- [x] Integration tests for activation, degradation, immutability, RLS, versioning, rotation, and authorization lockout
- [ ] Real Amazon/Etsy capability smoke tests with approved non-production accounts

- Amazon: regions, marketplaces, seller-specific Product Type Definitions, restrictions, and schema checksums.
- Etsy: shop identity, taxonomy, properties, shipping/readiness profiles, sections, and return policies.
- Version capability snapshots and retain source timestamps/checksums.
- Expired or stale capabilities block publishing with a precise refresh action.

Code gate passed on 2026-07-19. Product Type Definitions and Etsy taxonomy properties are synchronized on demand for bounded target lists; broad background refresh remains part of P1-G scheduling. External smoke evidence remains a P1 release gate.

## Phase P1-D/E: Publication and Writeback

P1-D implementation status:

- [x] Immutable tenant-scoped publication requests and append-only events with forced RLS
- [x] Deterministic idempotency across account, Listing version, marketplace, and external action
- [x] API preflight for account health, current approval, capability freshness, target configuration, and asset rights
- [x] BullMQ publication queue with server-side payload storage and credential-free job envelopes
- [x] Amazon `putListingsItem` validation preview with normalized issue evidence and no live Listing mutation
- [x] Etsy draft creation using current shipping/readiness profile IDs and refresh-token rotation
- [x] Worker runtime revalidation, immutable status writeback, retry classification, and uncertain-outcome reconciliation lock
- [x] Contract, connector, worker, RLS, immutability, idempotency, and preflight tests
- [ ] Real Amazon validation-preview and Etsy draft smoke tests with approved non-production accounts

P1-D stops after Amazon validation preview or Etsy draft creation. Amazon does not expose an Etsy-style draft state, so `validation_passed` must never be presented as a created Listing. Etsy media upload, inventory/personalization updates, activation, provider notifications, and final state writeback remain P1-E.

P1-D code gate passed on 2026-07-19. External smoke evidence remains a P1 release gate and requires approved non-production Amazon/Etsy accounts.

P1-E implementation status:

- [x] Follow-up publication actions are separate immutable child requests linked to the successful P1-D request
- [x] Amazon live `putListingsItem` submission followed by Listings Items status/issue reconciliation
- [x] Etsy inventory and current personalization configuration before activation
- [x] Etsy private authorized-media reads, checksum verification, stable rank upload, and external media ID evidence
- [x] Etsy activation followed by active/deactivated/status reconciliation
- [x] Step-level recovery skips recorded mutations and blocks only genuinely uncertain in-flight mutations
- [x] Pending provider state uses bounded BullMQ retries and remains explicitly `sync_pending` when attempts are exhausted
- [x] Contract, connector, Worker, migration, idempotency, tenant-isolation, and continuation API tests
- [ ] Real Amazon submit/status and Etsy configure/upload/activate/status smoke tests with approved non-production accounts

P1-E code gate passed on 2026-07-19. Provider notifications and scheduled/background reconciliation remain P1-G work; current P1-E status reads use bounded polling fallback. External smoke evidence remains a P1 release gate.

- Add immutable publish requests and events linked to one approved Listing version.
- Validate rights, approval state, platform rules, current capabilities, and account health before enqueueing.
- Use one idempotency key for every external action and persist the external ID before retryable follow-up work.
- Amazon: choose Listings Items for individual work and JSON Listings Feed for bulk work.
- Etsy: create draft, update inventory/personalization, upload media in pinned order, and activate.
- Normalize external issues to blocker/warning/info while retaining platform code and redacted detail.
- Poll only as fallback; prefer platform notifications where supported.

## Phase P1-F/G: UI and Automation

- Add a quiet operational Store Management workspace with account health, scopes, last sync, quotas, and authorization actions.
- Add publish controls only for approved Listing versions.
- Show the exact pinned version, target store/marketplace, validation state, progress, external ID, and failure classification.
- Batch and scheduled publishing use BullMQ delayed jobs, per-account concurrency, quota headers, and cancellation.
- No automatic rule may bypass Listing approval or asset-rights checks.

P1-F implementation status:

- [x] Tenant-scoped Store Management workspace with account readiness, capability freshness, authorization, synchronization, disable, and revocation actions
- [x] Server-side Amazon private authorization and OAuth callback handling without exposing provider credentials to client components
- [x] Real Listing index plus approved-version publication controls for initial preview/draft and eligible activation/submission continuation
- [x] Immutable publication request ledger with status tracks, external identifiers, normalized issues, and append-only event history
- [x] Responsive desktop and narrow-width layouts with stable navigation, explicit empty/error states, and component coverage
- [x] Current-approved-version replication into a distinct same-platform marketplace/locale draft with immutable lineage
- [x] Online Listing price/inventory read and approved-state push requests with append-only reconciliation events
- [x] Amazon Listings Items and Etsy listing/inventory connector operations with normalized provider snapshots
- [x] `listing_approved` automation rules with listing/platform/locale/completeness conditions, enable/disable state, and immutable runs
- [x] Listing `Channels` workspace for site copies, online reconciliation, and approval-trigger rules
- [x] Future publication scheduling with immutable `scheduled_for`, BullMQ delayed jobs, waiting-state cancellation, and Worker-side terminal-state enforcement
- [x] Cross-replica per-tenant/account publication concurrency enforced before Worker claim through a session advisory lease
- [x] Provider `Retry-After` enforcement through bounded provider-aware BullMQ backoff
- [x] Successful-response quota telemetry with normalized Amazon/Etsy windows, immutable tenant snapshots, and safe Store Management projection
- [x] Store and Listing UI controls for local-time publication scheduling and eligible waiting-state cancellation
- [x] CI release-candidate artifact automation with commit/migration/toolchain metadata and checksummed Chrome/Edge packages
- [x] Bounded background publication reconciliation with identifier-only jobs, safe status reads, per-account serialization, and manual-reconciliation exhaustion
- [ ] Real Store Management and publication smoke evidence with approved non-production Amazon/Etsy accounts

The extended P1-F implementation landed on 2026-07-20. P1-G now includes scheduling and cancellation UI, cross-replica per-account execution leases, provider `Retry-After` enforcement, successful-response quota telemetry, bounded background publication reconciliation, and commit-bound release-candidate artifact automation. Real provider smoke evidence remains a P1 release gate. P1-G online content synchronization, bulk publishing/JSON Listings Feed, provider notifications, and broader automation triggers/actions remain open.

Background reconciliation code gate passed on 2026-07-25. The Worker unit suite covers background admission, queue failure, retry-window exhaustion, and conclusive status pass-through. PostgreSQL integration covers safe status resumption after the original capability snapshot expires and the approved Listing changes, while retaining append-only events and the tenant/account execution lease. This evidence is deterministic local coverage and does not replace an authorized Amazon/Etsy status-writeback smoke test.

## P1 Acceptance Matrix

1. Tenant A cannot read, update, authorize, publish to, or observe Tenant B accounts/jobs.
2. Revoked, degraded, or disabled accounts cannot start new publications.
3. The same idempotency key cannot create two external Listings.
4. A changed Listing version requires a new review and a new publication request.
5. Research-domain media is rejected before connector invocation.
6. Amazon validation uses a recorded Product Type Definition checksum/version.
7. Etsy active publication includes required media and current profile IDs.
8. `401/403`, validation errors, conflicts, `429`, and `5xx` map to deterministic retry behavior.
9. Platform tokens and application secrets are absent from logs, responses, jobs, and exported diagnostics.
10. Mock connectors pass CI; real test accounts complete draft, publish, and status-writeback smoke tests before P1 release.
11. A site replica pins the approved source version, creates a distinct draft channel, and cannot inherit approval or overwrite either version.
12. Online price/inventory reads distinguish `completed` from `drift_detected`; an uncertain mutation becomes `reconciliation_required` and is not retried automatically.
13. Automation rules cannot bypass approval, authorization, capability, rights, validation, or connector idempotency checks, and every trigger produces one immutable run result.

## External Readiness Checklist

- Amazon professional selling account, SP-API developer/application registration, Product Listing role, LWA credentials, and authorized seller account.
- Etsy developer application, approved redirect URIs, API key/shared secret, and an authorized shop owner.
- Dedicated non-production SKUs/Listings, media, shipping profiles, and rollback/deactivation procedure.
- Written approval for the target stores and marketplace scopes.

Missing external credentials block real integration acceptance, not P1-A through P1-C development with mock connectors.
