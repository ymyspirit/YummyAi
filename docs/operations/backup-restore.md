# Backup and restore

## Scope and objectives

Back up PostgreSQL and the private MinIO bucket as one release checkpoint. Target RPO is 24 hours for P0 and target RTO is four hours. Audit events, immutable snapshots, approved versions, export manifests, object checksums, inventory projections, profit runs, forecast runs, and Webhook attempt history are mandatory restore evidence.

## Create a backup

```powershell
pwsh -File tools/scripts/backup.ps1 -OutputDirectory .artifacts/backups/p0-drill
```

The script uses `pg_dump --format=custom`, mirrors the private bucket through `mc`, and writes `backup-manifest.json` with SHA-256 checksums. Copy the directory to encrypted off-host storage.

## Non-destructive restore drill

```powershell
pwsh -File tools/scripts/restore-drill.ps1 -BackupDirectory .artifacts/backups/p0-drill -Cleanup
```

The drill restores into `yummyai_restore_verify` and `yummyai-restore-verify`; it never overwrites the configured database or bucket. It compares dump and object checksums, restores schema/data, and reports counts for organizations, capture snapshots, assets, inventory balances, profit runs, forecast runs, Webhook attempts, and audit events before mirroring objects. `-Cleanup` removes only those strictly prefixed verification resources after the checks pass; omit it only when an operator needs to inspect them manually.

## Production recovery

1. Freeze writes and record the incident time.
2. Restore into a new PostgreSQL database and a new versioned S3 bucket.
3. Run migrations only if the restored schema is older than the selected application release.
4. Verify tenant counts, sample snapshot/report/audit IDs, RLS behavior, object checksums, a sample export manifest, rebuilt inventory/operating projections, pinned profit/forecast checksums, and Webhook delivery-attempt lineage.
5. Point a canary API/worker at the restored resources; run acceptance tests.
6. Switch traffic after two-person approval. Keep original resources read-only until retention expires.

Never test restore by deleting the only copy of local or production data.
