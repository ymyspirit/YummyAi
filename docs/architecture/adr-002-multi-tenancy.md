# ADR-002: Shared database with PostgreSQL RLS

- Status: Accepted
- Date: 2026-07-18

## Context

Every organization must be isolated across records, files, background jobs, notifications, and audit history. P0 does not need database-per-tenant operational overhead.

## Decision

Use a shared PostgreSQL database with `tenant_id` on every tenant-owned table. Each transaction runs as `yummyai_app` and sets `app.tenant_id` and `app.user_id`; forced RLS policies enforce the tenant boundary. Service authorization still checks permissions and data scope. Object keys begin with `tenants/{tenantId}/{domain}/`, and signed reads validate both tenant and asset domain.

## Invariants

1. No request repository query runs outside `withTenant()`.
2. Composite foreign keys include `tenant_id` where records cross tables.
3. Worker envelopes carry `tenantId`, `requestedBy`, `traceId`, `correlationId`, and an idempotency key.
4. Research-domain objects cannot be promoted without approved rights and cannot be exported.
5. RLS isolation tests run in CI against the non-owner application role.

## Consequences

Operational access uses a separate, audited migration/backup credential. Cross-tenant analytics require an explicit offline path; application code cannot bypass RLS.
