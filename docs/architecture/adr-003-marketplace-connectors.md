# ADR-003: Marketplace connector boundary

- Status: Accepted
- Date: 2026-07-19

## Context

P1 must publish approved Listing versions to Amazon and Etsy without leaking vendor-specific authorization, payload, error, or rate-limit behavior across the ERP. API credentials and marketplace tokens are higher-risk than P0 public-page evidence and must not enter client responses or generic job payloads.

## Decision

Use `@yummyai/marketplace-connectors` as the provider-neutral boundary shared by API and worker code. Each connector implements health, capability sync, draft creation, media upload, activation, and status read operations. Vendor SDK/HTTP details remain inside platform adapters.

Store public account metadata in `marketplace_accounts`. Store the current account grant in `marketplace_credentials` as one authenticated, versioned encrypted envelope per account. Store only digested OAuth state and encrypted PKCE verifiers in short-lived `marketplace_authorization_sessions`. All three tables are tenant scoped with forced RLS. The metadata table exposes only credential state and connection health.

Platform authorization HTTP behavior lives in `@yummyai/marketplace-connectors`, while the API owns tenant checks, session consumption, encryption, persistence, and audit. A successful token exchange leaves the account in `pending_authorization`; P1-C identity and capability synchronization is the only path to `active`.

Capability synchronization writes immutable versions to `marketplace_capability_snapshots`. The account row carries only the latest normalized capabilities, health, sync time, and expiry time. Amazon schema download documents are retained with checksums, but their temporary signed download links are discarded. Etsy refresh-token rotation is persisted inside the same transaction as its capability snapshot.

Publication work runs asynchronously in the worker. The API validates permission, account health, approved Listing version, asset rights, and idempotency before enqueueing. Connector errors are normalized into authorization, validation, rate limit, conflict, retryable upstream, and terminal upstream categories.

Publication commands are immutable rows in `marketplace_publication_requests`; execution state, external IDs, and normalized issues are append-only `marketplace_publication_events`. Jobs contain only the publication request ID and tenant/user correlation metadata. Amazon P1-D uses `putListingsItem` with `mode=VALIDATION_PREVIEW`, because Amazon has no non-persisting draft equivalent. Etsy P1-D creates a provider draft.

P1-E actions are separate child commands rather than mutations of the P1-D request. Amazon submission runs only after a recorded successful preview. Etsy inventory/personalization configuration, media upload, activation, and status reads run only after a recorded draft ID. Each conclusive external step is appended before the next begins, allowing a Worker retry to resume without duplicating completed mutations. A lost mutation response, an interruption while a mutation is in flight, or a failed mutation-result writeback enters `reconciliation_required` and is never retried automatically.

Online price/inventory reconciliation uses separate immutable `marketplace_listing_sync_requests` and append-only `marketplace_listing_sync_events`. A request pins the approved Listing version and the published request that owns the account, marketplace, and external Listing ID. Provider reads are normalized to the same writable price/inventory shape as the approved version before checksum comparison. Provider-generated IDs and Money wrappers are not treated as business drift. Mutations with an unknown outcome require reconciliation and cannot be replayed automatically.

Same-platform site/language copies create a new draft Listing/version plus immutable `listing_replications` lineage; approval never propagates. `marketplace_automation_rules` are mutable tenant configuration, while each trigger outcome is an immutable `marketplace_automation_runs` row. Rules delegate to the normal publication or sync service so authorization, capability, rights, validation, and idempotency checks remain authoritative.

## Invariants

1. Connector execution receives credentials through a scoped callback and cannot serialize them into job data.
2. A publication pins one tenant, account, Listing version, marketplace, and idempotency key.
3. External Listing IDs are recorded before retryable follow-up work.
4. Rate-limit delays come from provider headers and use delayed jobs, never tight loops.
5. Platform payloads and diagnostics are redacted before storage or audit.
6. Mock connectors are the CI boundary; real account smoke tests are release evidence.
7. OAuth scopes are frozen when an authorization session starts; later account edits cannot expand the grant recorded at callback time.
8. Revocation deletes the encrypted envelope and prevents the credential accessor from serving disabled or revoked accounts.
9. A healthy, non-expired capability snapshot is required before an account becomes active or publishable.
10. Capability snapshot rows are insert/select only for the application role; historical versions cannot be updated or deleted.
11. Publication request and event rows are insert/select only for the application role; state changes append a new event.
12. An Amazon validation preview is evidence, not an external Listing ID or a created draft.
13. A provider mutation with an uncertain outcome cannot be retried until reconciliation establishes whether it succeeded.
14. Follow-up publication actions pin their parent request and cannot change its payload, Listing version, marketplace, or asset versions.
15. Marketplace media is read through authorized private storage, checksum verified, and uploaded in the pinned Listing order; research assets are never eligible.
16. Online sync pins an already published request; callers cannot select an arbitrary external Listing ID.
17. Price/inventory push uses only the current approved Listing version and compares normalized provider state by deterministic checksum.
18. Site replication creates a draft with immutable source/target lineage and never carries approval across channels.
19. Automation configuration may change, but one rule/version trigger key produces at most one immutable run outcome and actions still pass normal service preflight.

## Consequences

- P1-A can be developed without live credentials.
- Amazon Product Type Definitions and Etsy taxonomy/profile synchronization remain platform adapters behind one capability contract.
- Credential rotation and OAuth callbacks can evolve without changing public account APIs.
- Publishing cannot be considered complete until real authorized accounts verify draft creation, activation, and status writeback.
