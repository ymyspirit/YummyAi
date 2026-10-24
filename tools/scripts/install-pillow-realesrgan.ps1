param(
  [string]$Destination = (Join-Path $env:LOCALAPPDATA 'YummyAI\tools\realesrgan-ncnn-vulkan-20220424')
)
$ErrorActionPreference = 'Stop'
if (-not [System.IO.Path]::IsPathRooted($Destination)) { throw 'Runtime destination must be absolute' }
$runtimeTarget = [System.IO.Path]::GetFullPath($Destination).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
$runtimeParent = Split-Path -Parent $runtimeTarget
if (-not $runtimeParent -or $runtimeTarget -eq [System.IO.Path]::GetPathRoot($runtimeTarget)) { throw 'Invalid runtime destination' }
$runtimeFiles = [ordered]@{
  'realesrgan-ncnn-vulkan.exe' = '07e49f7cbb4ede01ae4dd4c399d3a7e5846e3d2085c3128eff881e55cb7b1a0c'
  'models/realesrgan-x4plus.bin' = '713ee713b0353afaa27976f0563a64a5043bd70b9bd8936c2e26e25ebcdbcddf'
  'models/realesrgan-x4plus.param' = '35330ececcea33b6c397a72548e788d5d53becee4734c50b7fada36e89f10a86'
  'vcomp140.dll' = '8f72ef2e483465444b2059fc6744d6cb22cd8d8a27f6fa56befd2a42dcd0f78b'
  'vcomp140d.dll' = '34980f5a28002967d4f2659b10a417b1b9a242e240195947c89195083d146c53'
}
function Test-RuntimeIntegrity([string]$Directory) {
  foreach ($runtimeFile in $runtimeFiles.GetEnumerator()) {
    $runtimePath = Join-Path $Directory $runtimeFile.Key
    if (-not (Test-Path -LiteralPath $runtimePath -PathType Leaf)) { throw 'Runtime file missing; choose an empty new installation directory' }
    if ((Get-FileHash -LiteralPath $runtimePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $runtimeFile.Value) {
      throw 'Runtime file hash mismatch; existing files were not overwritten'
    }
  }
}
if (Test-Path -LiteralPath $runtimeTarget) {
  Test-RuntimeIntegrity $runtimeTarget
  Write-Output 'Real-ESRGAN NCNN Vulkan 20220424 is installed and all five pinned files match.'
  exit 0
}

New-Item -ItemType Directory -Path $runtimeParent -Force | Out-Null
$runtimeStage = Join-Path $runtimeParent ('pillow-runtime-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runtimeStage | Out-Null
try {
  $runtimeArchivePath = Join-Path $runtimeStage 'official-runtime.zip'
  Invoke-WebRequest -Uri 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip' -OutFile $runtimeArchivePath
  if ((Get-FileHash -LiteralPath $runtimeArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne 'abc02804e17982a3be33675e4d471e91ea374e65b70167abc09e31acb412802d') {
    throw 'Official runtime archive hash mismatch'
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $runtimeArchive = [System.IO.Compression.ZipFile]::OpenRead($runtimeArchivePath)
  try {
    # Exact member allowlist prevents archive traversal and excludes demo input files.
    foreach ($runtimeFile in @($runtimeFiles.Keys) + @('README_windows.md')) {
      $runtimeEntry = $runtimeArchive.GetEntry($runtimeFile)
      if ($null -eq $runtimeEntry) { throw 'Official runtime archive is incomplete' }
      $runtimePath = Join-Path $runtimeStage $runtimeFile
      New-Item -ItemType Directory -Path (Split-Path -Parent $runtimePath) -Force | Out-Null
      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($runtimeEntry, $runtimePath, $false)
    }
  } finally { $runtimeArchive.Dispose() }
  Test-RuntimeIntegrity $runtimeStage
  $runtimeResolvedStage = [System.IO.Path]::GetFullPath($runtimeStage)
  if (-not $runtimeResolvedStage.StartsWith($runtimeParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe staging path' }
  if (Test-Path -LiteralPath $runtimeTarget) { throw 'Installation destination appeared during staging; nothing was overwritten' }
  Move-Item -LiteralPath $runtimeResolvedStage -Destination $runtimeTarget
  Write-Output 'Installed official Real-ESRGAN NCNN Vulkan 20220424 with the verified x4plus model.'
} finally {
  $runtimeResolvedStage = [System.IO.Path]::GetFullPath($runtimeStage)
  if ($runtimeResolvedStage.StartsWith($runtimeParent + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Split-Path -Leaf $runtimeResolvedStage).StartsWith('pillow-runtime-install-') -and
      (Test-Path -LiteralPath $runtimeResolvedStage)) {
    Remove-Item -LiteralPath $runtimeResolvedStage -Recurse -Force
  }
}
