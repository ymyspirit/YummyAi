param([ValidateSet('cpu', 'cu128')][string]$Runtime = 'cpu')
$ErrorActionPreference = 'Stop'
$segmentRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$segmentDir = Join-Path $segmentRoot 'output/segmentation'
$segmentPython = Join-Path $segmentDir 'venv/Scripts/python.exe'
$segmentSource = Join-Path $segmentDir 'sam2'
$segmentCheckpoint = Join-Path $segmentDir 'sam2.1_hiera_tiny.pt'
$segmentCommit = '2b90b9f5ceec907a1c18123530e92e794ad901a4'
$checkpointHash = '7402e0d864fa82708a20fbd15bc84245c2f26dff0eb43a4b5b93452deb34be69'
New-Item -ItemType Directory -Path $segmentDir -Force | Out-Null
if (!(Test-Path -LiteralPath $segmentPython)) {
  python -m venv (Join-Path $segmentDir 'venv')
  if ($LASTEXITCODE -ne 0) { throw 'Python 3.13 is required for this pinned Windows installation.' }
}
$pythonTag = & $segmentPython -c 'import sys; print(str(sys.version_info.major) + str(sys.version_info.minor))'
if ($pythonTag -ne '313') { throw 'Use Python 3.13 for the pinned Windows wheels.' }
# Direct official wheel URLs avoid an alternate host selected by the package index.
$torchWheel = Join-Path $segmentDir "torch-2.8.0+$Runtime-cp313-cp313-win_amd64.whl"
if (!(Test-Path -LiteralPath $torchWheel)) {
  curl.exe --fail --location --connect-timeout 20 --max-time 1800 -o "$torchWheel.partial" "https://download.pytorch.org/whl/$Runtime/torch-2.8.0%2B$Runtime-cp313-cp313-win_amd64.whl"
  if ($LASTEXITCODE -ne 0) { throw 'PyTorch download failed; no runtime was activated.' }
  Move-Item -LiteralPath "$torchWheel.partial" -Destination $torchWheel
}
& $segmentPython -m pip install $torchWheel "https://download.pytorch.org/whl/$Runtime/torchvision-0.23.0%2B$Runtime-cp313-cp313-win_amd64.whl" setuptools wheel
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed.' }
if (!(Test-Path -LiteralPath $segmentSource)) {
  git clone https://github.com/facebookresearch/sam2.git $segmentSource
  if ($LASTEXITCODE -ne 0) { throw 'SAM 2 checkout failed.' }
  git -C $segmentSource checkout --detach $segmentCommit
}
if ((git -C $segmentSource rev-parse HEAD) -ne $segmentCommit) { throw 'Existing SAM 2 checkout differs from the tested revision; review it before upgrading.' }
$env:SAM2_BUILD_CUDA = '0'
& $segmentPython -m pip install --no-build-isolation $segmentSource
if ($LASTEXITCODE -ne 0) { throw 'SAM 2 installation failed.' }
if (!(Test-Path -LiteralPath $segmentCheckpoint)) {
  curl.exe --fail --location --connect-timeout 20 --max-time 900 -o "$segmentCheckpoint.partial" 'https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_tiny.pt'
  if ($LASTEXITCODE -ne 0) { throw 'Checkpoint download failed.' }
  Move-Item -LiteralPath "$segmentCheckpoint.partial" -Destination $segmentCheckpoint
}
if ((Get-FileHash -LiteralPath $segmentCheckpoint -Algorithm SHA256).Hash.ToLowerInvariant() -ne $checkpointHash) { throw 'Checkpoint checksum mismatch.' }
& $segmentPython (Join-Path $segmentRoot 'tools/segmentation/check.py') $segmentCheckpoint
if ($LASTEXITCODE -ne 0) { throw 'Local segmentation smoke check failed.' }
Write-Output 'Local segmentation is ready. Reopen the cutout editor to refresh availability.'
