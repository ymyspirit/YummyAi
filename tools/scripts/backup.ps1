param(
  [string]$OutputDirectory = ".artifacts/backups/$(Get-Date -Format 'yyyyMMdd-HHmmss')"
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
$compose = Join-Path $root "infra/docker-compose.yml"
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { throw "Missing $envFile" }
$output = [System.IO.Path]::GetFullPath((Join-Path $root $OutputDirectory))
$workspacePrefix = $root.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
if (-not $output.StartsWith($workspacePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw "Backup output must stay inside the workspace" }
New-Item -ItemType Directory -Force -Path $output | Out-Null

$stamp = Get-Date -Format "yyyyMMddHHmmss"
$containerDump = "/tmp/yummyai-$stamp.dump"
& docker compose --env-file $envFile -f $compose exec -T postgres sh -c "pg_dump -U `"`$POSTGRES_USER`" -d `"`$POSTGRES_DB`" --format=custom --no-owner --no-acl --file=$containerDump"
if ($LASTEXITCODE -ne 0) { throw "PostgreSQL backup failed" }
& docker compose --env-file $envFile -f $compose cp "postgres:$containerDump" (Join-Path $output "postgres.dump")
if ($LASTEXITCODE -ne 0) { throw "Could not copy PostgreSQL dump" }

$minioContainer = "yummyai-backup-minio-$stamp"
try {
  & docker compose --env-file $envFile -f $compose --profile tools run --name $minioContainer -T minio-client 'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null && mc mb --ignore-existing "local/$S3_PRIVATE_BUCKET" >/dev/null && mkdir -p /backup && mc mirror --overwrite "local/$S3_PRIVATE_BUCKET" /backup'
  if ($LASTEXITCODE -ne 0) { throw "MinIO backup failed" }
  $minioOutput = Join-Path $output "minio"
  New-Item -ItemType Directory -Force -Path $minioOutput | Out-Null
  & docker cp "${minioContainer}:/backup/." $minioOutput
  if ($LASTEXITCODE -ne 0) { throw "Could not copy MinIO backup" }
} finally {
  & docker rm -f $minioContainer 2>$null | Out-Null
}

$postgresHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $output "postgres.dump")).Hash.ToLowerInvariant()
$objects = @(Get-ChildItem -LiteralPath (Join-Path $output "minio") -File -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
  [ordered]@{ path = [System.IO.Path]::GetRelativePath($output, $_.FullName).Replace('\','/'); sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash.ToLowerInvariant(); bytes = $_.Length }
})
$manifest = [ordered]@{ version = 1; createdAt = (Get-Date).ToUniversalTime().ToString("o"); postgres = [ordered]@{ path = "postgres.dump"; sha256 = $postgresHash }; objects = $objects }
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output "backup-manifest.json") -Encoding utf8
Write-Output "backup complete: $output"
Write-Output "postgres sha256: $postgresHash"
Write-Output "minio objects: $($objects.Count)"
