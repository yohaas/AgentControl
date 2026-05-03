param(
  [string]$InstallDir = "",
  [string]$ManifestUrl = ""
)

$ErrorActionPreference = "Stop"
$resolvedInstallDir = if ($InstallDir.Trim()) { (Resolve-Path $InstallDir).Path } else { (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path }
$updateScript = Join-Path $resolvedInstallDir "scripts\windows\update-installed-agent-hero.ps1"

if (-not (Test-Path $updateScript)) {
  throw "Installed updater was not found at $updateScript"
}

$tempScriptDir = Join-Path $env:TEMP "AgentHeroUpdater"
New-Item -ItemType Directory -Path $tempScriptDir -Force | Out-Null
$tempScript = Join-Path $tempScriptDir "update-installed-agent-hero.ps1"
Copy-Item -LiteralPath $updateScript -Destination $tempScript -Force

$args = @(
  "-NoExit",
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  $tempScript,
  "-InstallDir",
  $resolvedInstallDir
)
if ($ManifestUrl.Trim()) {
  $args += @("-ManifestUrl", $ManifestUrl.Trim())
}

Start-Process powershell -Verb RunAs -WorkingDirectory $tempScriptDir -ArgumentList $args
