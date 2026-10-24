param(
  [Parameter(Mandatory = $true)][string]$BackupDirectory,
  [string]$VerificationDatabase,
  [string]$VerificationBucket,
  [string]$ReportPath,
  [switch]$Cleanup
)
$ErrorActionPreference = "Stop"
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
$tool = Join-Path $workspace "tools/scripts/backup-restore.mjs"
$environment = Join-Path $workspace ".env"
if (-not (Test-Path -LiteralPath $environment)) { throw "Restore environment is missing" }
$toolArguments = @("--env-file=$environment", $tool, "restore", "--backup", $BackupDirectory)
if ($VerificationDatabase) { $toolArguments += @("--database", $VerificationDatabase) }
if ($VerificationBucket) { $toolArguments += @("--bucket", $VerificationBucket) }
if ($ReportPath) { $toolArguments += @("--report", $ReportPath) }
if ($Cleanup) { $toolArguments += "--cleanup" }
& node @toolArguments
if ($LASTEXITCODE -ne 0) { throw "Restore drill failed; inspect its safe report and cleanup status" }
