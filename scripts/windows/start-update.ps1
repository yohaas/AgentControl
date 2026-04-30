param(
  [string]$TaskName = "AgentControlUpdate"
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Resolve-Path (Join-Path $scriptRoot "..\..")
$updateScript = Resolve-Path (Join-Path $scriptRoot "..\update-agent-control.ps1")

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
  Write-Host "Starting scheduled task $TaskName for interactive update output."
  Start-ScheduledTask -TaskName $TaskName
  return
}

Write-Host "Scheduled task $TaskName was not found; falling back to UAC PowerShell handoff."
$command = "Write-Host 'Starting AgentControl updater...'; & `"$updateScript`""
Start-Process powershell -Verb RunAs -WorkingDirectory $repoRoot.Path -ArgumentList @(
  "-NoExit",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  $command
)
