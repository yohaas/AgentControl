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
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  $tempScript,
  "-InstallDir",
  $resolvedInstallDir
)
$resolvedManifestUrl = if ($ManifestUrl.Trim()) { $ManifestUrl.Trim() } elseif ($env:AGENTHERO_UPDATE_MANIFEST_URL) { $env:AGENTHERO_UPDATE_MANIFEST_URL.Trim() } else { "" }
if ($resolvedManifestUrl) {
  $args += @("-ManifestUrl", $resolvedManifestUrl)
}

Start-Process powershell -WorkingDirectory $tempScriptDir -ArgumentList $args
Write-Host "Started AgentHero updater in $tempScriptDir"
