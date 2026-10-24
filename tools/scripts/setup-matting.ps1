$ErrorActionPreference = 'Stop'
$mattingRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$mattingPython = Join-Path $mattingRoot 'output/segmentation/venv/Scripts/python.exe'
$mattingModelDir = Join-Path $mattingRoot 'output/segmentation/vitmatte-small'
$mattingCommit = '6a58ad7646403c1df626fbd746900aec7361ea1d'
$mattingHash = 'bda9289db1bb6762d978b42d1c62ae3f34daf7497171a347a1d09657efd788cb'
if (!(Test-Path -LiteralPath $mattingPython)) { throw 'Run tools/scripts/setup-segmentation.ps1 first to install the local Python and PyTorch runtime.' }
New-Item -ItemType Directory -Path $mattingModelDir -Force | Out-Null
$mattingReady = Join-Path $mattingModelDir '.ready'
if (Test-Path -LiteralPath $mattingReady) { Remove-Item -LiteralPath $mattingReady }
& $mattingPython -m pip install --index-url https://pypi.org/simple 'transformers==4.57.6'
if ($LASTEXITCODE -ne 0) { throw 'Matting dependencies failed to install.' }
# Pin immutable official files, and never load the pickle checkpoint or remote code.
foreach ($mattingFile in @('config.json', 'preprocessor_config.json', 'README.md', 'model.safetensors')) {
  $mattingTarget = Join-Path $mattingModelDir $mattingFile
  if (!(Test-Path -LiteralPath $mattingTarget)) {
    & curl.exe --fail --location --retry 2 --connect-timeout 20 --max-time 900 --output "$mattingTarget.partial" "https://huggingface.co/hustvl/vitmatte-small-composition-1k/resolve/$mattingCommit/$mattingFile"
    if ($LASTEXITCODE -ne 0) { throw "Matting model download failed: $mattingFile" }
    Move-Item -LiteralPath "$mattingTarget.partial" -Destination $mattingTarget
  }
}
if ((Get-FileHash -LiteralPath (Join-Path $mattingModelDir 'model.safetensors') -Algorithm SHA256).Hash.ToLowerInvariant() -ne $mattingHash) { throw 'Matting checkpoint checksum mismatch; no runtime was activated.' }
& $mattingPython (Join-Path $mattingRoot 'tools/segmentation/check-matting.py') $mattingModelDir
if ($LASTEXITCODE -ne 0) { throw 'Offline matting smoke check failed.' }
Write-Output 'Local hair refinement is ready. Reopen the cutout editor to refresh availability.'
