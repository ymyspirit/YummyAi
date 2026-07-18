# Deployment runbook

## Release inputs

- Immutable application commit and image digests
- reviewed environment configuration from `.env.example`
- PostgreSQL migration plan and current backup evidence
- Keycloak realm/client configuration
- private S3 bucket with versioning and lifecycle policy
- OTLP endpoint and alert routing

## Sequence

1. Confirm CI passes lint, typecheck, unit, integration, E2E, build, and secret scanning.
2. Run `tools/scripts/backup.ps1` and retain the generated checksums outside the host.
3. Deploy infrastructure changes, then run database migrations with the migration credential.
4. Deploy API/worker before web when contracts are backward compatible. Keep old workers draining while new workers start.
5. Run `/`, OIDC login, tenant isolation, capture, AI budget, authorized-file, Listing review, and export checksum smoke checks.
6. Enable traffic gradually. Watch HTTP error rate, job failure rate, queue latency, PostgreSQL saturation, and OTLP collector health.

## Required environment safety

- `DEBUG` and all `*_DEMO_MODE` flags must be false/unset.
- Secrets come from the deployment secret manager, never images or GitHub logs.
- `DATABASE_URL` for the app uses `yummyai_app`; migration/backup credentials are separate.
- S3 buckets are private and CORS is limited to deployed origins.
- Signed URLs expire in at most 600 seconds.

## Rollback

Roll back application images first. Database migrations are forward-only by default; restore to a new database when data rollback is required, validate it, then switch connection configuration. Do not run destructive down migrations against the only production copy.

## Acceptance evidence

Attach CI URL, commit SHA, migration version, backup manifest/checksum, browser extension versions, smoke-test results, and the approver to the release record.
