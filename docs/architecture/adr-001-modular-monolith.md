# ADR-001: P0 modular monolith

- Status: Accepted
- Date: 2026-07-18

## Context

YummyAI P0 spans capture, research, AI analysis, catalog, design, Listing, review, export, notifications, and operations. The team needs transactional consistency and fast iteration more than independent service scaling.

## Decision

Use a TypeScript monorepo and deploy three process boundaries: Next.js web, Nest-compatible API modules, and BullMQ workers. Business boundaries remain explicit packages/modules with typed contracts. PostgreSQL is the source of truth; Redis carries transient queues; private S3-compatible storage carries immutable files. Modules communicate through service contracts and jobs, not direct cross-module table writes.

## Consequences

- One migration stream and one tenant/RLS policy are easier to audit.
- API and worker can scale independently without premature microservices.
- Long-running work must use jobs and idempotency keys.
- A future extraction requires keeping package contracts stable and eliminating hidden table coupling first.
