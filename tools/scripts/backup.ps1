param(
  [string]$OutputDirectory = ".artifacts/backups/$(Get-Date -Format 'yyyyMMdd-HHmmss')-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
)
$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
$tool = Join-Path $workspace "tools/scripts/backup-restore.mjs"
$environment = Join-Path $workspace ".env"
if (-not (Test-Path -LiteralPath $environment)) { throw "Backup environment is missing" }
& node "--env-file=$environment" $tool backup --output $OutputDirectory
if ($LASTEXITCODE -ne 0) { throw "Backup failed; existing business data was not replaced" }
