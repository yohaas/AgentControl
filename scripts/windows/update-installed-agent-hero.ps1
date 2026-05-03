param(
  [string]$InstallDir = "",
  [string]$ManifestUrl = "",
  [string]$TaskName = "AgentHero",
  [int]$Port = 4317
)

$ErrorActionPreference = "Stop"
$resolvedInstallDir = if ($InstallDir.Trim()) { (Resolve-Path $InstallDir).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
$manifestUri = if ($ManifestUrl.Trim()) { $ManifestUrl.Trim() } elseif ($env:AGENTHERO_UPDATE_MANIFEST_URL) { $env:AGENTHERO_UPDATE_MANIFEST_URL } else { "" }
$stateDir = Join-Path $env:LOCALAPPDATA "AgentHero"
$logDir = Join-Path $stateDir "logs"
$pidPath = Join-Path $stateDir "agent-hero.pid"
$downloadDir = Join-Path $stateDir "updates"
$backupDir = Join-Path $stateDir "rollback"
$logPath = Join-Path $logDir "installed-update.log"

function Write-UpdateLog {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$timestamp] $Message"
  Write-Host $line
  Add-Content -Path $logPath -Value $line
}

function Get-Sha256FileHash {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha256.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Stop-AgentHero {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  }
  if (Test-Path $pidPath) {
    $pidValue = Get-Content -Path $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($pidValue) {
      $process = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
      if ($process) {
        Stop-Process -Id $process.Id -Force
        $process.WaitForExit(15000)
      }
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  }
  $installDirLower = $resolvedInstallDir.TrimEnd("\").ToLowerInvariant()
  $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and (
      ([string]$_.ExecutablePath).ToLowerInvariant().StartsWith($installDirLower) -or
      ([string]$_.CommandLine).ToLowerInvariant().Contains($installDirLower)
    )
  }
  foreach ($processInfo in $processes) {
    Write-UpdateLog "Stopping process $($processInfo.ProcessId): $($processInfo.Name)"
    Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

function Start-AgentHero {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Start-ScheduledTask -TaskName $TaskName
  } else {
    & (Join-Path $resolvedInstallDir "scripts\windows\start-installed-agent-hero.ps1") -InstallDir $resolvedInstallDir -ManifestUrl $manifestUri -Port $Port
  }
}

function Test-AgentHeroHealth {
  $deadline = (Get-Date).AddSeconds(45)
  do {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -eq 200) { return $true }
    } catch {
      Start-Sleep -Seconds 2
    }
  } while ((Get-Date) -lt $deadline)
  return $false
}

if (-not $manifestUri) {
  throw "ManifestUrl is required. Set AGENTHERO_UPDATE_MANIFEST_URL or pass -ManifestUrl."
}

New-Item -ItemType Directory -Path $logDir, $downloadDir, $backupDir -Force | Out-Null
Write-UpdateLog "AgentHero installed update started in $resolvedInstallDir"
Write-UpdateLog "Manifest $manifestUri"

$manifestPath = Join-Path $downloadDir "manifest.json"
Invoke-WebRequest -Uri $manifestUri -OutFile $manifestPath -UseBasicParsing
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$asset = $manifest.assets | Where-Object { $_.platform -eq "windows" -and (-not $_.arch -or $_.arch -eq "x64") } | Select-Object -First 1
if (-not $asset) { throw "Manifest does not contain a Windows update asset." }

$assetUrl = [string]$asset.url
if (-not ([Uri]$assetUrl).IsAbsoluteUri) {
  $assetUrl = [Uri]::new([Uri]$manifestUri, $assetUrl).AbsoluteUri
}
$zipPath = Join-Path $downloadDir (Split-Path -Leaf ([Uri]$assetUrl).LocalPath)
$stageDir = Join-Path $downloadDir "stage"

Write-UpdateLog "Downloading $assetUrl"
Invoke-WebRequest -Uri $assetUrl -OutFile $zipPath -UseBasicParsing
$actualHash = Get-Sha256FileHash $zipPath
$expectedHash = ([string]$asset.sha256).ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw "Checksum mismatch. Expected $expectedHash but got $actualHash."
}

if (Test-Path $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $stageDir -Force

$backupPath = Join-Path $backupDir ("agent-hero-" + (Get-Date -Format "yyyyMMddHHmmss"))
Write-UpdateLog "Stopping AgentHero"
Stop-AgentHero

Write-UpdateLog "Backing up current install to $backupPath"
Move-Item -LiteralPath $resolvedInstallDir -Destination $backupPath
New-Item -ItemType Directory -Path $resolvedInstallDir -Force | Out-Null
Copy-Item -Path (Join-Path $stageDir "*") -Destination $resolvedInstallDir -Recurse -Force

Write-UpdateLog "Starting AgentHero"
Start-AgentHero
if (-not (Test-AgentHeroHealth)) {
  Write-UpdateLog "Health check failed; rolling back."
  Stop-AgentHero
  Remove-Item -LiteralPath $resolvedInstallDir -Recurse -Force
  Move-Item -LiteralPath $backupPath -Destination $resolvedInstallDir
  Start-AgentHero
  throw "AgentHero failed to start after update; rollback was attempted."
}

Write-UpdateLog "AgentHero installed update complete."
Write-UpdateLog "Log written to $logPath"
