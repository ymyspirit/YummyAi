# Legacy runtime upgrade and operational adoption

Scope: R03/R07/R41/R43, B05/B18/B51. This contract covers preservation and verification of an existing local ERP database; it does not finish the full platform migration or production release gates.

## Preserve original business records

Migration 0128 adds an explicit `spus.legacy_plan_ambiguous` marker to every member of an existing multi-SPU plan group. It does not pick a winner, merge/delete a historical SPU, change the original plan ID or rewrite original monetary values. Unmarked new bindings remain unique. The application role cannot create legacy markers, clear them or add a new default child to an ambiguous plan.

The plan response returns all candidate IDs/codes/names rather than a default `spu`. The product page shows the original links and keeps shared plan edits read-only. Parent customization, stage, profile and SPU renaming reject ambiguous writes. Explicit original-SPU reads, specifications, SKU links and history keep their existing authorization. Resolving the historical relationship requires a separate audited business decision; names resembling tests are not deletion evidence.

0128 also restores the inspected forward guards and narrows budget-ledger updates to the required state/amount columns. Previously applied SQL files and Drizzle ledger hashes remain unchanged.

## One-connection migration

The runner uses Drizzle's `readMigrationFiles` journal, SQL statements and SHA-256 hashes. All pending statements and ledger appends execute inside one postgres.js transaction with `pg_advisory_xact_lock`. The lock and migration use the same physical connection, including a one-connection pool. Failure rolls back that transaction and automatically releases its lock. Startup readiness does not apply migrations.

## Rehearsal before applying

Use the operational migration/backup identity described in ADR-002. Application repositories continue to use authenticated tenant context, `withTenant()` and forced RLS.

```powershell
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs tools/scripts/database-upgrade.mts rehearse --backup .artifacts/backups/<checkpoint> --report docs/project-control/checkpoints/<candidate>-rehearsal.json
```

The tool validates the private backup checksums, captures current runtime source hashes, creates a fresh canonical database from the exact migration journal, and restores the actual backup into a separate fresh database/bucket. It applies pending migrations only to the restored copy, compares every original table/column's row-count/content checksum and original migration-ledger prefix, verifies private object bytes/metadata/tags and compares the complete public schema with the fresh canonical database. It retains no raw row values in its public report. The report records resource intent before creation and the finally paths remove owned resources.

### Migration 0164 system actor append

The 148-to-183 real-backup rehearsal exposed a legitimate append: 0164 inserts one fixed factory-source-retention system actor into `app_users`. The original users must still match the backup exactly. A versioned post-migration policy can account for this one row only when the original ledger predates ordinal 164 and a strict pre-migration read proves the fixed ID, subject and email absent. The original and current user columns must be the six known columns; the current user count must be exactly the original count plus one. The fixed row values, finite and exactly equal PostgreSQL timestamps, zero memberships, and the single ledger entry's pinned SQL hash and journal timestamp are required. Excluding only that hardcoded ID must reproduce the original projected row count and checksum; every other original table and the original ledger prefix remain strict.

The actor and the 0164 ledger tuple must have the same `xmin` immediately after this migration invocation, within the same repeatable-read verification snapshot. This is a bounded same-batch tuple-XID check: all pending migrations share a transaction. It is not a permanent transaction identity, a proof about an exclusive 0164 statement, or a reusable restored-row credential. PostgreSQL timestamps are compared inside PostgreSQL without JavaScript millisecond rounding. The final canonical schema comparison still requires the membership-rejection trigger. See [PostgreSQL system columns](https://www.postgresql.org/docs/17/ddl-system-columns.html).

The default backup, restore and pre-migration comparison have no exclusion. Backups already containing ordinal 164 use strict original-data comparison. No original row, backup checksum, historical migration SQL or historical ledger entry is rewritten. The safe report contains only policy/version, fixed system ID, migration pin, appended-row checksum and finite verification results.

### Original personal identity on an upgraded copy

The isolated API/Web smoke uses the original issuer, user subject and membership from the restored business copy. A fresh, public OIDC client with PKCE S256 and only the exact `http://127.0.0.1:3130/api/erp-auth/callback` redirect may be created in the existing realm for this check. The distinct loopback hostname isolates the clone's fixed-name host cookies from the daily `localhost:3000` cookies; a different port alone does not isolate cookies. Its tenant-attribute and audience mappers are explicit; implicit, password and service-account grants are disabled. The exact temporary resource ID and controlled-configuration checksum are recorded before use and checked again before deletion. The existing daily client, realm, user, tenant, password and browser session are preserved. A synthetic fixture login cannot count as original-user acceptance. Worker consumers remain stopped until the real queued paid/external work has been reviewed.

The source fingerprint covers current runtime files/configuration/lockfile, including untracked source and deletions; it excludes documents, ignored private backups and temporary acceptance files. It is a working-tree fingerprint, not a Git commit or CI certificate.

```powershell
node --env-file=.env --import ./apps/api/node_modules/tsx/dist/loader.mjs tools/scripts/database-upgrade.mts apply --backup .artifacts/backups/<checkpoint> --rehearsal docs/project-control/checkpoints/<candidate>-rehearsal.json --report docs/project-control/checkpoints/<candidate>-apply.json
```

Apply requires a successful rehearsal, verified cleanup, the identical backup and unchanged current runtime source. The normal application must be stopped. Current source database/bucket identity, original row contents, original history and every object are checked again before migration. A new canonical database verifies the resulting normal schema. No business rollback, paid model request, marketplace write or factory action is inferred from this command. If verification fails after migration, readiness remains closed and the retained backup is the recovery checkpoint; the tool never drops the normal database.

## Historical hash drift

Normal hash/timestamp/count checks remain strict. A historical hash mismatch can pass only with an immutable `schema_adoption_receipts` record bound to exact canonical and actual ledger digests, the freshly computed schema fingerprint, the private backup-manifest checksum and current runtime-source checksum. Operational insertion follows successful original-data, original-history, object and canonical-schema verification. The application role has read-only access to this global metadata and cannot create, modify or delete a receipt. Readiness recomputes the full public schema on every drifted check; missing/stale receipts and DDL or permission changes reject startup. The original SQL text is not claimed to have been recovered.

The fingerprint covers columns/defaults/types, table ownership/RLS, constraints, indexes, policies, triggers, routines/security-definer ownership and app execution rights, enum values, sequence definitions, table/column grants and schema creation rights. Live sequence counters and physical column positions are deliberately excluded; rows and original ledger are separately verified during adoption.

## Acceptance boundary

`pnpm test:e2e:order-daily --suite=database-upgrade --output-root=<fresh-owned-path>` exercises missing/stale proof, actual restore/upgrade, non-owner readiness, rejected receipt forgery, immutable audit, schema-drift rejection and original-data/history preservation. Its synthetic ledger drift exists only inside the disposable database. Catalog integration and real browser checks cover ambiguous plan presentation, original links and shared-edit rejection.

Inspect retained concise delivery/checkpoint records for actual results. A local restore, rehearsal or ready API does not prove paid-provider quality, factory acceptance, production DR, CI or completion of B05/B51. Review normal queued external/paid work before starting consumers. Temporary acceptance files are cleaned separately from the retained private business backup.

### Production browser origin normalization

A real same-realm original-user smoke request exposed Next's normalization of literal loopback hosts in `Request.url`, including production builds. An exact configured browser `WEB_ORIGIN` (or `FACTORY_PORTAL_ORIGIN` in factory-only mode), exact Host, matching protocol/port, and literal loopback on both sides are required for this narrow normalization case. Cross-site requests, unspecified or mismatched configuration, forwarded-host trust, and wildcard origins remain rejected. Runtime evidence contains only the path and finite origin/header metadata, never cookies, authorization or request bodies. Nine focused regressions cover positive and hostile inputs; source/candidate must be rebuilt before the browser result can be reconsidered.

Backup, restore, and post-migration preservation gates remain strict. Only the disposable browser copy may append `order_protected_access_events`: every pre-existing row hash remains exact, and each new UUIDv7 row must match the real original actor/tenant, an original report order, fulfillment/granted fields, and the database time window. Other tables, derived caches, retention changes, schema/RLS/grants and ledger still require exact equality; a read that changes them fails this browser check. Exact owned API/Web processes are stopped before the final snapshot. These browser effects never justify ignoring original business data during actual adoption.
