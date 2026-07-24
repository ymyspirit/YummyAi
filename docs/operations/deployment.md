# Deployment runbook

## Release inputs

- Immutable application commit and image digests
- reviewed environment configuration from `.env.example`
- PostgreSQL migration plan and current backup evidence
- Keycloak realm/client configuration
- private S3 bucket with versioning and lifecycle policy
- private ClamAV/`clamd` service with persisted, refreshed signature database
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
- `MARKETPLACE_CREDENTIAL_ENCRYPTION_KEY`, `ORDER_PII_ENCRYPTION_KEY`, and `INTEGRATION_SECRET_ENCRYPTION_KEY` are distinct 32-byte secrets with independent rotation scopes. API and Worker receive the same integration key.
- `ORDER_PII_RETENTION_DAYS` is reviewed against the tenant retention policy before order ingestion is enabled.
- S3 buckets are private and CORS is limited to deployed origins.
- Signed URLs expire in at most 600 seconds.
- `CLAMAV_HOST` resolves only on the private worker network; TCP `3310` is never Internet-facing, and the deployed scanner image is pinned to a reviewed supported release/digest.
- Worker memory and restart policy accommodate ClamAV signature reloads; a scanner outage fails closed and alerts on the customization-file scan queue.
- Webhook egress is restricted to approved HTTPS destinations with DNS/IP egress controls; loopback HTTP is development-only. Monitor retry and dead-letter counts without logging request bodies, tokens, or signing secrets.

## Rollback

Roll back application images first. Database migrations are forward-only by default; restore to a new database when data rollback is required, validate it, then switch connection configuration. Do not run destructive down migrations against the only production copy.

## Acceptance evidence

Attach CI URL, commit SHA, migration version, backup manifest/checksum, browser extension versions, smoke-test results, PII retention/anonymization evidence when orders are enabled, ClamAV engine/signature evidence plus clean/infected fixture results, forecast/projection rebuild evidence, signed Webhook retry/dead-letter/replay evidence, and the approver to the release record.
