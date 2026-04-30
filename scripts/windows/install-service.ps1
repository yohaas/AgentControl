param(
  [string]$ServiceName = "AgentHero",
  [string]$DisplayName = "AgentHero",
  [string]$RepoPath = "",
  [string]$ServiceDir = "",
  [string]$UpdateTaskName = "AgentHeroUpdate",
  [string]$WinSWPath = "",
  [string]$WinSWUrl = "https://github.com/winsw/winsw/releases/latest/download/WinSW-x64.exe",
  [switch]$RunAsCurrentUser,
  [System.Management.Automation.PSCredential]$Credential,
  [switch]$NoStart,
  [switch]$SkipUpdateTask,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Escape-Xml {
  param([string]$Value)
  return [Security.SecurityElement]::Escape($Value)
}

function Quote-PowerShellSingle {
  param([string]$Value)
  return "'$($Value.Replace("'", "''"))'"
}

if (-not (Test-Administrator)) {
  throw "Run this script from an elevated PowerShell window."
}

$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = if ($RepoPath.Trim()) { Resolve-Path $RepoPath } else { Resolve-Path (Join-Path $scriptRoot "..\..") }
$installDir = if ($ServiceDir.Trim()) { $ServiceDir } else { Join-Path $env:USERPROFILE "Services\$ServiceName" }
$templatePath = Join-Path $scriptRoot "AgentHero.xml.template"
$updateScriptPath = Resolve-Path (Join-Path $scriptRoot "..\update-agent-hero.ps1")
$serviceExe = Join-Path $installDir "$ServiceName.exe"
$serviceXml = Join-Path $installDir "$ServiceName.xml"
$logDir = Join-Path $installDir "logs"
$powershellPath = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npm) {
  $npm = Get-Command npm -ErrorAction SilentlyContinue
}
if (-not $npm) {
  throw "npm was not found on PATH. Install Node.js/npm or add npm to PATH before installing the service."
}

New-Item -ItemType Directory -Force -Path $installDir, $logDir | Out-Null

if (Test-Path $serviceExe) {
  if (-not $Force) {
    throw "$serviceExe already exists. Re-run with -Force to replace the service wrapper and XML."
  }
} elseif ($WinSWPath.Trim()) {
  Write-Host "Copying WinSW service wrapper from $WinSWPath"
  Copy-Item -LiteralPath $WinSWPath -Destination $serviceExe -Force
} else {
  Write-Host "Downloading WinSW service wrapper from $WinSWUrl"
  Write-Host "Saving service wrapper to $serviceExe"
  $previousProgressPreference = $ProgressPreference
  $ProgressPreference = "SilentlyContinue"
  try {
    Invoke-WebRequest -Uri $WinSWUrl -OutFile $serviceExe
  } finally {
    $ProgressPreference = $previousProgressPreference
  }
}

if ($WinSWPath.Trim() -and $Force) {
  Write-Host "Copying WinSW service wrapper from $WinSWPath"
  Copy-Item -LiteralPath $WinSWPath -Destination $serviceExe -Force
}

$repoForCommand = Quote-PowerShellSingle $repoRoot.Path
$npmForCommand = Quote-PowerShellSingle $npm.Source
$innerCommand = "Set-Location $repoForCommand; & $npmForCommand run start:server"
$arguments = "-NoProfile -ExecutionPolicy Bypass -Command `"$innerCommand`""
$template = Get-Content -LiteralPath $templatePath -Raw
$xml = $template.
  Replace("{{SERVICE_ID}}", (Escape-Xml $ServiceName)).
  Replace("{{SERVICE_NAME}}", (Escape-Xml $DisplayName)).
  Replace("{{POWERSHELL_PATH}}", (Escape-Xml $powershellPath)).
  Replace("{{POWERSHELL_ARGUMENTS}}", (Escape-Xml $arguments)).
  Replace("{{REPO_PATH}}", (Escape-Xml $repoRoot.Path)).
  Replace("{{LOG_PATH}}", (Escape-Xml $logDir))
Set-Content -LiteralPath $serviceXml -Value $xml -Encoding UTF8

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  if (-not $Force) {
    throw "Service $ServiceName already exists. Re-run with -Force to reinstall it."
  }
  & $serviceExe stop | Out-Host
  & $serviceExe uninstall | Out-Host
}

& $serviceExe install | Out-Host

if ($RunAsCurrentUser) {
  $defaultUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  if (-not $Credential) {
    $Credential = Get-Credential -UserName $defaultUser -Message "Enter the Windows credentials AgentHero should use to run the service."
  }
  $networkCredential = $Credential.GetNetworkCredential()
  if (-not $networkCredential.Password) {
    throw "A password is required to configure a Windows service account."
  }
  sc.exe config $ServiceName obj= $Credential.UserName password= $networkCredential.Password | Out-Host
}

if (-not $SkipUpdateTask) {
  $taskUser = if ($RunAsCurrentUser -and $Credential) { $Credential.UserName } else { [Security.Principal.WindowsIdentity]::GetCurrent().Name }
  $taskAction = New-ScheduledTaskAction `
    -Execute $powershellPath `
    -Argument "-NoExit -NoProfile -ExecutionPolicy Bypass -File `"$updateScriptPath`"" `
    -WorkingDirectory $repoRoot.Path
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Highest
  $task = New-ScheduledTask `
    -Action $taskAction `
    -Principal $taskPrincipal `
    -Description "Runs AgentHero updates in the interactive user session."
  Register-ScheduledTask -TaskName $UpdateTaskName -InputObject $task -Force | Out-Host
  Write-Host "Installed scheduled update task: $UpdateTaskName"
}

Write-Host "Installed $DisplayName as $ServiceName."
if ($RunAsCurrentUser) {
  Write-Host "Service logon account: $($Credential.UserName)"
}
Write-Host "Service directory: $installDir"
Write-Host "Logs: $logDir"

if ($NoStart) {
  Write-Host "Service installed but not started. Restart AgentHero or start the service after closing the current instance."
} else {
  & $serviceExe start | Out-Host
}
