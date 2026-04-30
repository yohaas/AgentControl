param(
  [string]$ServiceName = "AgentHero",
  [string]$UpdateTaskName = "AgentHeroUpdate",
  [string]$ServiceDir = "",
  [switch]$KeepUpdateTask,
  [switch]$RemoveFiles
)

$ErrorActionPreference = "Stop"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Administrator)) {
  throw "Run this script from an elevated PowerShell window."
}

$installDir = if ($ServiceDir.Trim()) { $ServiceDir } else { Join-Path $env:USERPROFILE "Services\$ServiceName" }
$serviceExe = Join-Path $installDir "$ServiceName.exe"

if (Test-Path $serviceExe) {
  & $serviceExe stop | Out-Host
  & $serviceExe uninstall | Out-Host
} else {
  $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
  if ($service) {
    sc.exe stop $ServiceName | Out-Host
    sc.exe delete $ServiceName | Out-Host
  } else {
    Write-Host "Service $ServiceName is not installed."
  }
}

if (-not $KeepUpdateTask) {
  $task = Get-ScheduledTask -TaskName $UpdateTaskName -ErrorAction SilentlyContinue
  if ($task) {
    Unregister-ScheduledTask -TaskName $UpdateTaskName -Confirm:$false
    Write-Host "Removed scheduled update task $UpdateTaskName"
  }
}

if ($RemoveFiles -and (Test-Path $installDir)) {
  Remove-Item -LiteralPath $installDir -Recurse -Force
  Write-Host "Removed $installDir"
}
