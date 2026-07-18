param(
  [Parameter(Mandatory = $true)][string]$BackupDirectory,
  [string]$VerificationDatabase = "yummyai_restore_verify",
  [string]$VerificationBucket = "yummyai-restore-verify",
  [switch]$Cleanup
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$compose = Join-Path $root "infra/docker-compose.yml"
$envFile = Join-Path $root ".env"
$backup = (Resolve-Path (Join-Path $root $BackupDirectory)).Path
$workspacePrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $backup.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Backup directory must stay inside the workspace" }
if ($VerificationDatabase -notmatch '^yummyai_restore_verify[_a-z0-9-]*$') { throw "Verification database name is outside the allowed temporary prefix" }
if ($VerificationBucket -notmatch '^yummyai-restore-verify[-a-z0-9]*$') { throw "Verification bucket name is outside the allowed temporary prefix" }
$manifest = Get-Content -LiteralPath (Join-Path $backup "backup-manifest.json") -Raw | ConvertFrom-Json
$dump = Join-Path $backup "postgres.dump"
$actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $dump).Hash.ToLowerInvariant()
if ($actualHash -ne $manifest.postgres.sha256) { throw "PostgreSQL dump checksum mismatch" }
foreach ($object in @($manifest.objects)) {
  $objectPath = Join-Path $backup $object.path
  if (-not (Test-Path -LiteralPath $objectPath)) { throw "Missing MinIO backup object: $($object.path)" }
  $objectHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $objectPath).Hash.ToLowerInvariant()
  if ($objectHash -ne $object.sha256) { throw "MinIO object checksum mismatch: $($object.path)" }
}

& docker compose --env-file $envFile -f $compose cp $dump "postgres:/tmp/yummyai-restore.dump"
if ($LASTEXITCODE -ne 0) { throw "Could not copy restore dump" }
& docker compose --env-file $envFile -f $compose exec -T postgres sh -c "dropdb -U `"`$POSTGRES_USER`" --if-exists '$VerificationDatabase' && createdb -U `"`$POSTGRES_USER`" '$VerificationDatabase' && pg_restore -U `"`$POSTGRES_USER`" -d '$VerificationDatabase' --no-owner --no-acl /tmp/yummyai-restore.dump"
if ($LASTEXITCODE -ne 0) { throw "PostgreSQL restore drill failed" }
$counts = & docker compose --env-file $envFile -f $compose exec -T postgres sh -c "psql -U `"`$POSTGRES_USER`" -d '$VerificationDatabase' -Atc 'select (select count(*) from organizations),(select count(*) from capture_snapshots),(select count(*) from asset_files),(select count(*) from audit_events)'"
if ($LASTEXITCODE -ne 0) { throw "Restored database verification query failed" }

$minioContainer = "yummyai-restore-minio-$VerificationBucket"
try {
  & docker compose --env-file $envFile -f $compose --profile tools run -d --name $minioContainer -T minio-client "sleep 300"
  if ($LASTEXITCODE -ne 0) { throw "Could not create MinIO restore container" }
  & docker exec $minioContainer mkdir -p /backup/minio
  & docker cp "$(Join-Path $backup 'minio')/." "${minioContainer}:/backup/minio"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy MinIO restore objects" }
  $objectCount = & docker exec $minioContainer sh -c "mc alias set local http://minio:9000 `"`$MINIO_ROOT_USER`" `"`$MINIO_ROOT_PASSWORD`" >/dev/null && (mc rb --force --dangerous 'local/$VerificationBucket' >/dev/null 2>&1 || true) && mc mb 'local/$VerificationBucket' >/dev/null && mc mirror --overwrite /backup/minio 'local/$VerificationBucket' >/dev/null && mc ls --recursive 'local/$VerificationBucket' | wc -l"
  if ($LASTEXITCODE -ne 0) { throw "MinIO restore drill failed" }
  if ($Cleanup) {
    & docker exec $minioContainer sh -c "mc alias set local http://minio:9000 `"`$MINIO_ROOT_USER`" `"`$MINIO_ROOT_PASSWORD`" >/dev/null && mc rb --force --dangerous 'local/$VerificationBucket' >/dev/null"
    if ($LASTEXITCODE -ne 0) { throw "Could not clean verification bucket" }
  }
} finally {
  & docker rm -f $minioContainer 2>$null | Out-Null
}

Write-Output "restore drill passed"
Write-Output "temporary database: $VerificationDatabase"
Write-Output "core counts (organizations,captures,assets,audits): $counts"
Write-Output "temporary bucket: $VerificationBucket"
Write-Output "restored object count: $objectCount"
if ($Cleanup) {
  & docker compose --env-file $envFile -f $compose exec -T postgres sh -c "dropdb -U `"`$POSTGRES_USER`" --if-exists '$VerificationDatabase'"
  if ($LASTEXITCODE -ne 0) { throw "Could not clean verification database" }
  Write-Output "verification resources removed"
} else {
  Write-Output "remove only these verification resources after recording evidence"
}
