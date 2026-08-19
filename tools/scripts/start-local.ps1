[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
$RuntimeRoot = Join-Path $env:LOCALAPPDATA "YummyAI"
$LogRoot = Join-Path $RuntimeRoot "logs"
$StatePath = Join-Path $RuntimeRoot "startup-state.json"
$ComposeArgs = @(
  "compose", "--env-file", ".env",
  "-f", "infra/docker-compose.yml",
  "-f", "infra/docker-compose.one-click.yml"
)
$script:StartedProcesses = @{}

function Write-Step([string]$Message) {
  Write-Host "[YummyAI] $Message" -ForegroundColor Cyan
}

function Write-Ready([string]$Message) {
  Write-Host "[READY] $Message" -ForegroundColor Green
}

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$FilePath exited with code $LASTEXITCODE."
  }
}

function Test-DockerEngine {
  & docker info --format "{{.ServerVersion}}" *> $null
  return $LASTEXITCODE -eq 0
}

function Start-DockerEngine {
  if (Test-DockerEngine) { return }

  $candidates = @(
    "C:\Program Files\Docker\Docker\Docker Desktop.exe",
    (Join-Path $env:LOCALAPPDATA "Docker\Docker Desktop.exe")
  )
  $desktop = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $desktop) {
    throw "Docker Desktop is not running and its executable was not found."
  }

  Write-Step "Starting Docker Desktop..."
  if (-not (Get-Process -Name "Docker Desktop" -ErrorAction SilentlyContinue)) {
    Start-Process -FilePath $desktop -WindowStyle Hidden | Out-Null
  }

  $deadline = (Get-Date).AddMinutes(2)
  while ((Get-Date) -lt $deadline) {
    if (Test-DockerEngine) { return }
    Start-Sleep -Seconds 2
  }
  throw "Docker Desktop did not become ready within two minutes."
}

function Wait-ComposeHealthy {
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    $ids = @(& docker @ComposeArgs ps -q 2>$null | Where-Object { $_ })
    if ($ids.Count -ge 6) {
      $states = @(
        foreach ($id in $ids) {
          & docker inspect --format "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}" $id 2>$null
        }
      )
      if ($states.Count -eq $ids.Count -and @($states | Where-Object { $_ -notin @("healthy", "running") }).Count -eq 0) {
        return
      }
    }
    Start-Sleep -Seconds 2
  }
  throw "YummyAI infrastructure did not become healthy within three minutes."
}

function Get-PortOwner([int]$Port) {
  $connection = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $connection) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue
}

function Test-PortAvailable([int]$Port) {
  if (Get-PortOwner $Port) { return $false }
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
  try {
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    try { $listener.Stop() } catch {}
  }
}

function Test-AncestorMarker {
  param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [Parameter(Mandatory = $true)][string]$Marker
  )

  $seen = @{}
  $currentId = $ProcessId
  for ($depth = 0; $depth -lt 16 -and $currentId -gt 0; $depth++) {
    if ($seen.ContainsKey($currentId)) { break }
    $seen[$currentId] = $true
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$currentId" -ErrorAction SilentlyContinue
    if (-not $process) { break }
    if ([string]$process.CommandLine -like "*$Marker*") { return $true }
    $currentId = [int]$process.ParentProcessId
  }
  return $false
}

function Test-HttpOk([string]$Url) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 3
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 400
  } catch {
    return $false
  }
}

function Wait-HttpOk {
  param(
    [Parameter(Mandatory = $true)][string]$Url,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-HttpOk $Url) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Wait-PortListening {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Get-PortOwner $Port) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Wait-PortAvailable {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-PortAvailable $Port) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-NoProcessMarker {
  param(
    [Parameter(Mandatory = $true)][string]$Marker,
    [int]$TimeoutSeconds = 20
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $matches = @(Get-CimInstance Win32_Process | Where-Object {
      [string]$_.CommandLine -like "*$Marker*"
    })
    if ($matches.Count -eq 0) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Wait-ProcessMarkerStable {
  param(
    [Parameter(Mandatory = $true)][string]$Marker,
    [int]$TimeoutSeconds = 30,
    [int]$StableChecks = 4
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $consecutive = 0
  while ((Get-Date) -lt $deadline) {
    $match = Get-CimInstance Win32_Process | Where-Object {
      [string]$_.CommandLine -like "*$Marker*"
    } | Select-Object -First 1
    if ($match) {
      $consecutive += 1
      if ($consecutive -ge $StableChecks) { return $true }
    } else {
      $consecutive = 0
    }
    Start-Sleep -Seconds 1
  }
  return $false
}

function Set-TemporaryEnvironment {
  param([hashtable]$Values)

  $original = @{}
  foreach ($name in $Values.Keys) {
    $path = "Env:$name"
    if (Test-Path $path) {
      $original[$name] = (Get-Item $path).Value
    } else {
      $original[$name] = $null
    }
    Set-Item -Path $path -Value ([string]$Values[$name])
  }
  return $original
}

function Restore-Environment {
  param([hashtable]$Original)

  foreach ($name in $Original.Keys) {
    if ($null -eq $Original[$name]) {
      Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    } else {
      Set-Item "Env:$name" ([string]$Original[$name])
    }
  }
}

function Start-LoggedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [hashtable]$Environment = @{}
  )

  New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $stdout = Join-Path $LogRoot "$Name-$stamp.out.log"
  $stderr = Join-Path $LogRoot "$Name-$stamp.err.log"
  $original = Set-TemporaryEnvironment $Environment
  try {
    $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
      -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  } finally {
    Restore-Environment $original
  }
  $script:StartedProcesses[$Name] = $process.Id
  return [pscustomobject]@{ Process = $process; Stdout = $stdout; Stderr = $stderr }
}

function Get-RootForPortMarker {
  param(
    [Parameter(Mandatory = $true)][int]$Port,
    [Parameter(Mandatory = $true)][string]$Marker
  )

  $owner = Get-PortOwner $Port
  if (-not $owner) { return $null }
  if (-not (Test-AncestorMarker -ProcessId $owner.ProcessId -Marker $Marker)) { return $null }

  $current = $owner
  $root = $owner
  for ($depth = 0; $depth -lt 16; $depth++) {
    $parent = Get-CimInstance Win32_Process -Filter "ProcessId=$($current.ParentProcessId)" -ErrorAction SilentlyContinue
    if (-not $parent) { break }
    if ([string]$parent.CommandLine -like "*$Marker*") { $root = $parent }
    $current = $parent
  }
  return $root
}

function Stop-ProcessTree([int]$RootProcessId) {
  $all = @(Get-CimInstance Win32_Process)
  $queue = @([pscustomobject]@{ Id = $RootProcessId; Depth = 0 })
  $tree = @()
  $seen = @{}
  while ($queue.Count -gt 0) {
    $entry = $queue[0]
    if ($queue.Count -gt 1) { $queue = @($queue[1..($queue.Count - 1)]) } else { $queue = @() }
    if ($seen.ContainsKey($entry.Id)) { continue }
    $seen[$entry.Id] = $true
    $process = $all | Where-Object ProcessId -eq $entry.Id | Select-Object -First 1
    if (-not $process) { continue }
    $tree += [pscustomobject]@{ Id = $process.ProcessId; Depth = $entry.Depth }
    foreach ($child in @($all | Where-Object ParentProcessId -eq $entry.Id)) {
      $queue += [pscustomobject]@{ Id = $child.ProcessId; Depth = $entry.Depth + 1 }
    }
  }
  $tree | Sort-Object Depth -Descending | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
}

function Test-WorkerRunning {
  $workers = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "node.exe" -and
      [string]$_.CommandLine -like "*src/run.ts*" -and
      [string]$_.CommandLine -notlike "*--watch*"
  })
  foreach ($worker in $workers) {
    if (Test-AncestorMarker -ProcessId $worker.ProcessId -Marker "@yummyai/worker") { return $true }
  }
  return $false
}

function Test-ApiRunning([int]$Port) {
  $owner = Get-PortOwner $Port
  if (-not $owner) { return $false }
  if (-not (Test-AncestorMarker -ProcessId $owner.ProcessId -Marker "@yummyai/api")) { return $false }
  return Test-HttpOk "http://127.0.0.1:$Port/health"
}

function Get-ApiLauncherRoots {
  return @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq "cmd.exe" -and
      [string]$_.CommandLine -like "*pnpm.CMD*--filter @yummyai/api dev*"
  })
}

function Test-LocalRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$ApiBase,
    [Parameter(Mandatory = $true)][string]$WebBase,
    [switch]$Quiet
  )

  $original = Set-TemporaryEnvironment @{ API_BASE_URL = $ApiBase; WEB_BASE_URL = $WebBase }
  try {
    if ($Quiet) {
      & node --env-file=.env tools/scripts/check-local-runtime.mjs *> $null
    } else {
      & node --env-file=.env tools/scripts/check-local-runtime.mjs
    }
    return $LASTEXITCODE -eq 0
  } finally {
    Restore-Environment $original
  }
}

function Wait-LocalRuntime {
  param(
    [Parameter(Mandatory = $true)][string]$ApiBase,
    [Parameter(Mandatory = $true)][string]$WebBase,
    [int]$TimeoutSeconds = 45
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (Test-LocalRuntime -ApiBase $ApiBase -WebBase $WebBase -Quiet) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Sync-IsolatedWebRuntime {
  $webSource = Join-Path $RepoRoot "apps\web"
  $webRuntime = Join-Path $RuntimeRoot "isolated-web-3002"
  New-Item -ItemType Directory -Path $webRuntime -Force | Out-Null

  foreach ($item in Get-ChildItem -LiteralPath $webSource -Force) {
    if ($item.Name -in @("node_modules", ".next")) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $webRuntime -Recurse -Force
  }

  $modules = Join-Path $webRuntime "node_modules"
  if (-not (Test-Path -LiteralPath $modules)) {
    New-Item -ItemType Junction -Path $modules -Target (Join-Path $webSource "node_modules") | Out-Null
  }
  $runtimeEnv = Join-Path $webRuntime ".env"
  if (-not (Test-Path -LiteralPath $runtimeEnv)) {
    New-Item -ItemType HardLink -Path $runtimeEnv -Target (Join-Path $RepoRoot ".env") | Out-Null
  }
  return $webRuntime
}

try {
  Set-Location $RepoRoot
  New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null

  Write-Step "Checking prerequisites..."
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js is not installed." }
  if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw "pnpm is not installed." }
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw "Docker Desktop is not installed." }
  $nodeVersion = (& node --version).Trim()
  $pnpmVersion = (& pnpm --version).Trim()
  if ($nodeVersion -notlike "v24.17.*") { throw "Node.js 24.17.x is required; found $nodeVersion." }
  if ($pnpmVersion -notlike "11.10.*") { throw "pnpm 11.10.x is required; found $pnpmVersion." }

  if (-not (Test-Path -LiteralPath ".env")) {
    Copy-Item -LiteralPath ".env.example" -Destination ".env"
    Write-Step "Created .env from .env.example."
  }
  if (-not (Test-Path -LiteralPath "node_modules\.pnpm")) {
    Write-Step "Installing dependencies..."
    Invoke-Checked -FilePath "pnpm" -Arguments @("install", "--frozen-lockfile")
  }

  Start-DockerEngine
  $minioPort = @(19000, 19001, 19002, 19003) | Where-Object {
    (Test-HttpOk "http://127.0.0.1:$_/minio/health/live") -or (Test-PortAvailable $_)
  } | Select-Object -First 1
  if ($null -eq $minioPort) { throw "No safe fallback port is available for MinIO." }
  $minioPort = [int]$minioPort
  $env:YUMMYAI_MINIO_PORT = [string]$minioPort
  Write-Step "Starting YummyAI infrastructure without touching other containers..."
  Invoke-Checked -FilePath "docker" -Arguments ($ComposeArgs + @("up", "-d"))
  Wait-ComposeHealthy

  $minioFallback = "http://127.0.0.1:$minioPort/minio/health/live"
  if (-not (Wait-HttpOk -Url $minioFallback -TimeoutSeconds 60)) {
    throw "MinIO fallback endpoint did not become reachable on port $minioPort."
  }
  if (-not (Test-HttpOk "http://127.0.0.1:9000/minio/health/live")) {
    if (-not (Test-PortAvailable 9000)) {
      throw "Port 9000 is occupied but does not expose the YummyAI MinIO endpoint."
    }
    Write-Step "Restoring the standard MinIO endpoint on port 9000..."
    Start-LoggedProcess -Name "minio-proxy" -FilePath "node" `
      -Arguments @("tools/scripts/local-port-proxy.mjs") -WorkingDirectory $RepoRoot `
      -Environment @{ LISTEN_PORT = "9000"; TARGET_PORT = [string]$minioPort } | Out-Null
    if (-not (Wait-HttpOk -Url "http://127.0.0.1:9000/minio/health/live" -TimeoutSeconds 30)) {
      throw "The MinIO compatibility endpoint on port 9000 did not start."
    }
  }

  $apiCandidates = @(8000, 8200, 8201, 8202, 8203)
  $apiPort = $apiCandidates | Where-Object { Test-ApiRunning $_ } | Select-Object -First 1
  $existingApiLaunchers = @(Get-ApiLauncherRoots)
  if ($null -eq $apiPort -and $existingApiLaunchers.Count -gt 0) {
    Write-Step "Waiting for the existing API process to recover..."
    $apiRecoveryDeadline = (Get-Date).AddSeconds(30)
    while ($null -eq $apiPort -and (Get-Date) -lt $apiRecoveryDeadline) {
      Start-Sleep -Seconds 2
      $apiPort = $apiCandidates | Where-Object { Test-ApiRunning $_ } | Select-Object -First 1
    }
  }
  if ($null -eq $apiPort -and $existingApiLaunchers.Count -gt 0) {
    Write-Step "Removing inactive YummyAI API launchers..."
    foreach ($launcher in $existingApiLaunchers) {
      Stop-ProcessTree -RootProcessId $launcher.ProcessId
    }
    $existingApiLaunchers = @()
  }
  if ($null -ne $apiPort -and $existingApiLaunchers.Count -gt 1) {
    $activeApiRoot = Get-RootForPortMarker -Port ([int]$apiPort) -Marker "@yummyai/api"
    if ($activeApiRoot) {
      $duplicates = @($existingApiLaunchers | Where-Object { $_.ProcessId -ne $activeApiRoot.ProcessId })
      if ($duplicates.Count -gt 0) {
        Write-Step "Removing duplicate YummyAI API launchers..."
        foreach ($launcher in $duplicates) {
          Stop-ProcessTree -RootProcessId $launcher.ProcessId
        }
      }
    }
  }
  $apiWasRunning = $null -ne $apiPort
  if (-not $apiWasRunning) {
    $availableApiCandidates = $apiCandidates
    if ($existingApiLaunchers.Count -gt 0) {
      $availableApiCandidates = @($apiCandidates | Where-Object { $_ -ne 8000 })
    }
    $apiPort = $availableApiCandidates | Where-Object { Test-PortAvailable $_ } | Select-Object -First 1
    if ($null -eq $apiPort) { throw "No safe local API port is available." }
  }
  $apiPort = [int]$apiPort
  $apiBase = "http://127.0.0.1:$apiPort"

  if (-not $apiWasRunning) {
    Write-Step "Applying database migrations and refreshing the local extension account..."
    Invoke-Checked -FilePath "pnpm" -Arguments @("--filter", "@yummyai/database", "db:migrate")
    Invoke-Checked -FilePath "pnpm" -Arguments @("--filter", "@yummyai/api", "bootstrap:local")
    Write-Step "Starting API on port $apiPort..."
    Start-LoggedProcess -Name "api" -FilePath "pnpm.cmd" `
      -Arguments @("--filter", "@yummyai/api", "dev") -WorkingDirectory $RepoRoot `
      -Environment @{ PORT = [string]$apiPort } | Out-Null
    if (-not (Wait-HttpOk "$apiBase/health" 90)) { throw "API did not become healthy. Check $LogRoot." }
  } else {
    Write-Step "Reusing the running API on port $apiPort."
  }

  $webPort = 3000
  $webBase = "http://127.0.0.1:3000"
  $standardWebUsable = (Test-HttpOk "$webBase/") -and `
    (Wait-LocalRuntime -ApiBase $apiBase -WebBase $webBase -TimeoutSeconds 12)
  if (-not $standardWebUsable) {
    $standardWebRoot = Get-RootForPortMarker -Port 3000 -Marker "@yummyai/web"
    if ($standardWebRoot) {
      Write-Step "Restarting the YummyAI Web to use API port $apiPort..."
      Stop-ProcessTree -RootProcessId $standardWebRoot.ProcessId
      if (-not (Wait-PortAvailable -Port 3000)) {
        throw "The YummyAI Web did not release port 3000."
      }
    }
  }
  if (-not $standardWebUsable -and (Test-PortAvailable 3000)) {
    Write-Step "Starting Web on port 3000..."
    Start-LoggedProcess -Name "web" -FilePath "pnpm.cmd" `
      -Arguments @("--filter", "@yummyai/web", "dev") -WorkingDirectory $RepoRoot `
      -Environment @{ API_BASE_URL = $apiBase; PORT = "3000" } | Out-Null
    $standardWebUsable = (Wait-HttpOk "$webBase/" 90) -and `
      (Wait-LocalRuntime -ApiBase $apiBase -WebBase $webBase -TimeoutSeconds 45)
  }

  if (-not $standardWebUsable) {
    $webPort = 3002
    $webBase = "http://127.0.0.1:3002"
    $isolatedWebUsable = (Test-HttpOk "$webBase/") -and `
      (Wait-LocalRuntime -ApiBase $apiBase -WebBase $webBase -TimeoutSeconds 12)
    if (-not $isolatedWebUsable) {
      $isolatedWebRoot = Get-RootForPortMarker -Port 3002 -Marker $RepoRoot
      if ($isolatedWebRoot) {
        Write-Step "Restarting the isolated YummyAI Web to use API port $apiPort..."
        Stop-ProcessTree -RootProcessId $isolatedWebRoot.ProcessId
        if (-not (Wait-PortAvailable -Port 3002)) {
          throw "The isolated YummyAI Web did not release port 3002."
        }
      }
      if (-not (Test-PortAvailable $webPort)) {
        throw "Port 3002 is occupied and the existing service is not a usable YummyAI Web instance."
      }
      Write-Step "Port 3000 is busy; starting an isolated Web on port 3002..."
      $webRuntime = Sync-IsolatedWebRuntime
      Start-LoggedProcess -Name "web-3002" -FilePath "pnpm.cmd" `
        -Arguments @("exec", "next", "dev", "-p", "3002") -WorkingDirectory $webRuntime `
        -Environment @{ API_BASE_URL = $apiBase; PORT = "3002" } | Out-Null
      if (-not ((Wait-HttpOk "$webBase/" 90) -and `
        (Wait-LocalRuntime -ApiBase $apiBase -WebBase $webBase -TimeoutSeconds 45))) {
        throw "Isolated Web did not start with the active API. Check $LogRoot."
      }
    } else {
      Write-Step "Reusing the isolated Web on port 3002."
    }
  } else {
    Write-Step "Reusing the Web data path on port 3000."
  }

  if (-not (Test-WorkerRunning)) {
    Write-Step "Starting Worker..."
    Start-LoggedProcess -Name "worker" -FilePath "pnpm.cmd" `
      -Arguments @("--filter", "@yummyai/worker", "dev") -WorkingDirectory $RepoRoot | Out-Null
  } else {
    Write-Step "Reusing the running Worker."
  }

  $extensionWebBase = "http://localhost:$webPort"
  $extensionProfile = Join-Path $RuntimeRoot "extension-chrome-profile"
  New-Item -ItemType Directory -Path $extensionProfile -Force | Out-Null

  $extensionRoot = Get-RootForPortMarker -Port 3001 -Marker "@yummyai/extension"
  if ((Get-PortOwner 3001) -and -not $extensionRoot) {
    throw "Port 3001 is occupied by another process; it was left untouched."
  }
  if ($extensionRoot) {
    Write-Step "Reloading the YummyAI extension with the active Web proxy..."
    Stop-ProcessTree -RootProcessId $extensionRoot.ProcessId
  } else {
    Write-Step "Starting the YummyAI extension..."
  }
  if (-not (Wait-NoProcessMarker -Marker $extensionProfile)) {
    Write-Step "Closing a stale YummyAI Chrome process..."
    $staleChromeRoots = @(Get-CimInstance Win32_Process | Where-Object {
      $_.Name -eq "chrome.exe" -and
        [string]$_.CommandLine -like "*$extensionProfile*" -and
        [string]$_.CommandLine -notlike "*--type=*"
    })
    foreach ($chromeRoot in $staleChromeRoots) {
      Stop-ProcessTree -RootProcessId $chromeRoot.ProcessId
    }
    if (-not (Wait-NoProcessMarker -Marker $extensionProfile -TimeoutSeconds 10)) {
      throw "The previous YummyAI Chrome profile is still in use."
    }
  }

  Start-LoggedProcess -Name "extension" -FilePath "pnpm.cmd" `
    -Arguments @("--filter", "@yummyai/extension", "dev") -WorkingDirectory $RepoRoot `
    -Environment @{
      VITE_API_BASE_URL = $extensionWebBase
      VITE_LOCAL_EXTENSION_PROXY = "1"
      YUMMYAI_EXTENSION_PROFILE = $extensionProfile
    } | Out-Null
  if (-not (Wait-PortListening -Port 3001 -TimeoutSeconds 60)) {
    throw "Extension dev server did not start. Check $LogRoot."
  }
  if (-not (Wait-ProcessMarkerStable -Marker $extensionProfile -TimeoutSeconds 30)) {
    throw "The dedicated YummyAI Chrome window did not stay open. Check $LogRoot."
  }

  Write-Step "Running the Web/API consistency check..."
  if (-not (Wait-LocalRuntime -ApiBase $apiBase -WebBase $webBase)) {
    throw "Local runtime consistency check failed."
  }

  $extensionIdMatch = Select-String -LiteralPath "apps/web/src/local-extension-proxy.ts" `
    -Pattern 'const LOCAL_EXTENSION_ID = "([a-p]+)"' | Select-Object -First 1
  if (-not $extensionIdMatch) { throw "Could not read the local extension identity." }
  $extensionId = $extensionIdMatch.Matches[0].Groups[1].Value
  $headers = @{
    Origin = "chrome-extension://$extensionId"
    "x-yummyai-extension-id" = $extensionId
  }
  $preflight = Invoke-WebRequest -UseBasicParsing -Method Options -Uri "$webBase/v1/captures" `
    -Headers $headers -TimeoutSec 5
  if ($preflight.StatusCode -ne 204) { throw "Extension proxy preflight failed." }

  [pscustomobject]@{
    startedAt = (Get-Date).ToString("o")
    apiBase = $apiBase
    webBase = $webBase
    extensionBase = "http://localhost:3001"
    startedProcesses = $script:StartedProcesses
    logs = $LogRoot
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $StatePath -Encoding UTF8

  Write-Host ""
  Write-Ready "ERP Web: $webBase"
  Write-Ready "API: $apiBase"
  Write-Ready "Extension dev server: http://localhost:3001"
  Write-Ready "Use the newly opened Chrome window, refresh the Amazon/Etsy page, then open YummyAI Capture."
  Write-Host "Logs: $LogRoot"
} catch {
  Write-Host ""
  Write-Host "[FAILED] $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "Logs: $LogRoot"
  exit 1
}
