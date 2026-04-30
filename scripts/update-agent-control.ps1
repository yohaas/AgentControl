param(
  [string]$ServiceName = "AgentControl"
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$logPath = Join-Path $env:TEMP "agent-control-update.log"

function Write-UpdateLog {
  param([string]$Message)
  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  $line = "[$timestamp] $Message"
  Write-Host $line
  Add-Content -Path $logPath -Value $line
}

function Invoke-UpdateStep {
  param(
    [string]$Name,
    [scriptblock]$Step
  )
  Write-UpdateLog ""
  Write-UpdateLog "> $Name"
  & $Step
  if ($LASTEXITCODE -ne $null -and $LASTEXITCODE -ne 0) {
    throw "$Name failed with exit code $LASTEXITCODE"
  }
}

Set-Location $repoRoot
Write-UpdateLog "AgentControl update started in $repoRoot"

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue

Invoke-UpdateStep "git pull" { git pull }

if ($service) {
  Write-UpdateLog ""
  Write-UpdateLog "> Stop-Service $ServiceName"
  Stop-Service -Name $ServiceName -Force
  $service.WaitForStatus("Stopped", "00:00:30")
} else {
  Write-UpdateLog "Service $ServiceName was not found; continuing without service restart."
}

Invoke-UpdateStep "npm ci" { npm ci }
Invoke-UpdateStep "npm run build" { npm run build }

if ($service) {
  Write-UpdateLog ""
  Write-UpdateLog "> Start-Service $ServiceName"
  Start-Service -Name $ServiceName
}

Write-UpdateLog ""
Write-UpdateLog "AgentControl update complete."
Write-UpdateLog "Wait 30 seconds and refresh AgentControl."
Write-UpdateLog "Log written to $logPath"
Read-Host "Press Enter to close this window"
exit 0
