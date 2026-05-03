param(
  [string]$InstallDir = "",
  [string]$ManifestUrl = "",
  [string]$HostName = "127.0.0.1",
  [int]$Port = 4317
)

$ErrorActionPreference = "Stop"
$resolvedInstallDir = if ($InstallDir.Trim()) { (Resolve-Path $InstallDir).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
$stateDir = Join-Path $env:LOCALAPPDATA "AgentHero"
$logDir = Join-Path $stateDir "logs"
$pidPath = Join-Path $stateDir "agent-hero.pid"
$serverEntry = Join-Path $resolvedInstallDir "server\dist\index.js"

New-Item -ItemType Directory -Path $logDir -Force | Out-Null

if (-not (Test-Path $serverEntry)) {
  throw "AgentHero server entry was not found at $serverEntry"
}

if (Test-Path $pidPath) {
  $existingPid = (Get-Content -Path $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($existingPid) {
    $existing = Get-Process -Id ([int]$existingPid) -ErrorAction SilentlyContinue
    if ($existing) {
      Write-Host "AgentHero is already running as PID $existingPid"
      return
    }
  }
}

$env:AGENTHERO_INSTALL_MODE = "installed"
if ($ManifestUrl.Trim()) { $env:AGENTHERO_UPDATE_MANIFEST_URL = $ManifestUrl.Trim() }
$env:HOST = $HostName
$env:PORT = [string]$Port

$stdoutPath = Join-Path $logDir "agent-hero.out.log"
$stderrPath = Join-Path $logDir "agent-hero.err.log"
$process = Start-Process -FilePath "node" -ArgumentList @($serverEntry) -WorkingDirectory $resolvedInstallDir -WindowStyle Hidden -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath -PassThru
Set-Content -Path $pidPath -Value $process.Id -Encoding ASCII
Write-Host "Started AgentHero PID $($process.Id) at http://${HostName}:$Port"
