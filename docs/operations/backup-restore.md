# Backup and restore

## Scope and objectives

Back up PostgreSQL and the private MinIO bucket as one release checkpoint. Target RPO is 24 hours for P0 and target RTO is four hours. Audit events, immutable snapshots, approved versions, export manifests, and object checksums are mandatory restore evidence.

## Create a backup

```powershell
pwsh -File tools/scripts/backup.ps1 -OutputDirectory .artifacts/backups/p0-drill
```

The script uses `pg_dump --format=custom`, mirrors the private bucket through `mc`, and writes `backup-manifest.json` with SHA-256 checksums. Copy the directory to encrypted off-host storage.

## Non-destructive restore drill

```powershell
pwsh -File tools/scripts/restore-drill.ps1 -BackupDirectory .artifacts/backups/p0-drill -Cleanup
```

The drill restores into `yummyai_restore_verify` and `yummyai-restore-verify`; it never overwrites the configured database or bucket. It compares the dump and object checksums, restores schema/data, checks core table counts, mirrors objects, and reports the evidence. `-Cleanup` removes only those strictly prefixed verification resources after the checks pass; omit it only when an operator needs to inspect them manually.

## Production recovery

1. Freeze writes and record the incident time.
2. Restore into a new PostgreSQL database and a new versioned S3 bucket.
3. Run migrations only if the restored schema is older than the selected application release.
4. Verify tenant counts, sample snapshot/report/audit IDs, RLS behavior, object checksums, and a sample export manifest.
5. Point a canary API/worker at the restored resources; run acceptance tests.
6. Switch traffic after two-person approval. Keep original resources read-only until retention expires.

Never test restore by deleting the only copy of local or production data.
