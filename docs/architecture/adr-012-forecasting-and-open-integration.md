# ADR-012: Forecast evidence, operating projections, and open integration

- Status: Accepted
- Date: 2026-07-24

## Context

P3-G must turn order, inventory, and finance evidence into forecasts and an
operating cockpit without making analytical output authoritative. It must also
let tenant-owned systems read selected projections and receive outbound events
without exposing tenant selection, signing secrets, payloads, provider
responses, or mutable history.

## Decision

Forecast runs are immutable. A run pins its metric, scope, grain, input window,
evidence cutoff, horizon, model and model version, quantiles, source points, and
input checksum. Forecast points, accuracy evaluations, and override versions are
append-only. Overrides use optimistic version numbers and do not mutate the
original quantiles or any inventory, purchasing, Listing, advertising, or
finance record.

Operating metric definitions have mutable identities and append-only definition
versions. Metric snapshots pin a definition version, observation time,
completeness, source references, drill-through path, and checksum. The current
metric table is a rebuildable projection. Stale, incomplete, unavailable, or
drifted state opens a reconciliation identity with append-only events.

API clients are tenant-owned principals with an ID, one-time random secret,
SHA-256 digest, expiry, status, and an allowlist of read-only scopes. The token
format is `yai_<client-id>.<secret>`. Authentication computes the digest and
calls a locked-down `SECURITY DEFINER` database function as `yummyai_app`; the
function returns tenant, creator, and scopes only for an exact active match. It
does not return the stored digest and does not accept a caller-selected tenant.

Webhook endpoint signing secrets are encrypted with the dedicated
`INTEGRATION_SECRET_ENCRYPTION_KEY` domain and returned only when created or
rotated. Events and attempts are immutable. Deliveries are mutable scheduling
projections. Jobs carry only delivery and tenant correlation identifiers. The
Worker signs `timestamp.eventId.canonicalBody` with HMAC-SHA256 and sends
`X-YummyAI-Event-Id`, `X-YummyAI-Timestamp`, and
`X-YummyAI-Signature: v1=<hex>`. Network errors, 408, 425, 429, and 5xx retry
with a persisted attempt budget; other 4xx responses are terminal. Response
bodies are never persisted.

Manual replay creates a new delivery linked to a dead letter. It never mutates
the original attempt history and is rejected after event payload retention has
redacted the payload. Endpoint URLs require HTTPS except for explicit loopback
development targets.

Event creation and queue admission are separated by a process-failure window.
An exact idempotent publish replay therefore resubmits every original delivery
that is still `pending`. BullMQ uses the delivery ID as its job ID, so this
recovery is duplicate-safe while completed or dead-letter deliveries are not
silently restarted.

## Invariants

1. Forecast and metric source IDs must resolve inside the authenticated tenant.
2. Forecasts and cockpit projections never initiate operational mutations.
3. API client scopes cannot exceed the creating member's permissions.
4. API client and signing secrets are never returned by workspace reads, logs,
   audit metadata, or job payloads.
5. One event/endpoint pair has one original delivery; manual replay has explicit
   lineage and its own idempotency key.
6. Event checksums survive payload redaction so delivery evidence remains
   auditable without retaining the body.
7. Current projections may be rebuilt from immutable snapshots and their before
   and after checksums are recorded.
8. An interrupted publish can recover pending queue admission by replaying the
   original request with the same idempotency key and unchanged payload.

## Consequences

- Operational readers can distinguish current, stale, incomplete, unavailable,
  and unreconciled values instead of seeing fabricated zeroes.
- Integrators must store API tokens and signing secrets when first issued;
  YummyAI cannot recover their plaintext later.
- Webhook consumers must verify the signature, timestamp tolerance, and event ID
  before accepting a delivery, and must deduplicate by event ID.
- Exact-candidate backup/restore, CI, browser, and outstanding authorized
  marketplace/provider gates remain release evidence rather than implementation
  claims.
