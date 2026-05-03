param(
  [Parameter(Mandatory = $true)]
  [string]$ManifestUrl,
  [string]$OutputPath = "",
  [string]$InstallDir = "",
  [string]$TaskName = "AgentHero",
  [int]$Port = 4317,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$iexpress = (Get-Command iexpress.exe -ErrorAction Stop).Source
$artifactsDir = Join-Path $repoRoot "artifacts"
$buildDir = Join-Path $artifactsDir "installer-build"
$installerScript = Join-Path $PSScriptRoot "install-agent-hero.ps1"
$targetPath = if ($OutputPath.Trim()) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath.Trim()) } else { Join-Path $artifactsDir "AgentHeroSetup.exe" }

if (-not $ManifestUrl.Trim()) { throw "ManifestUrl is required." }
if (-not (Test-Path $installerScript)) { throw "Installer script was not found at $installerScript" }

if (Test-Path $buildDir) { Remove-Item -LiteralPath $buildDir -Recurse -Force }
New-Item -ItemType Directory -Path $buildDir, (Split-Path -Parent $targetPath) -Force | Out-Null

$embeddedInstaller = Join-Path $buildDir "install-agent-hero.ps1"
$launcher = Join-Path $buildDir "install.cmd"
$sedPath = Join-Path $buildDir "AgentHeroSetup.sed"
Copy-Item -LiteralPath $installerScript -Destination $embeddedInstaller -Force
$embeddedFiles = @("install.cmd", "install-agent-hero.ps1")
$launcherManifestUrl = $ManifestUrl

if (Test-Path $ManifestUrl) {
  $resolvedManifestPath = (Resolve-Path $ManifestUrl).Path
  $manifest = Get-Content -Raw -Path $resolvedManifestPath | ConvertFrom-Json
  $embeddedManifest = Join-Path $buildDir "manifest.json"
  Copy-Item -LiteralPath $resolvedManifestPath -Destination $embeddedManifest -Force
  $embeddedFiles += "manifest.json"
  $launcherManifestUrl = "%~dp0manifest.json"

  $manifestDir = Split-Path -Parent $resolvedManifestPath
  $asset = $manifest.assets | Where-Object { $_.platform -eq "windows" } | Select-Object -First 1
  if (-not $asset) { throw "Local manifest does not contain a Windows update asset." }
  $assetPath = [string]$asset.url
  if (-not ([Uri]$assetPath).IsAbsoluteUri) {
    $assetPath = Join-Path $manifestDir $assetPath
  }
  if (Test-Path $assetPath) {
    Copy-Item -LiteralPath $assetPath -Destination (Join-Path $buildDir (Split-Path -Leaf $assetPath)) -Force
    $embeddedFiles += (Split-Path -Leaf $assetPath)
  }
}

$installerArgs = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  "`"%~dp0install-agent-hero.ps1`"",
  "-ManifestUrl",
  "`"$launcherManifestUrl`"",
  "-TaskName",
  "`"$TaskName`"",
  "-Port",
  "$Port"
)
if ($InstallDir.Trim()) {
  $installerArgs += @("-InstallDir", "`"$InstallDir`"")
}
if ($NoStart) {
  $installerArgs += "-NoStart"
}

@"
@echo off
powershell.exe $($installerArgs -join " ")
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" (
  echo.
  echo AgentHero setup failed with exit code %EXIT_CODE%.
  pause
)
exit /b %EXIT_CODE%
"@ | Set-Content -Path $launcher -Encoding ASCII

$escapedBuildDir = $buildDir
$escapedTargetPath = $targetPath
$stringEntries = for ($index = 0; $index -lt $embeddedFiles.Count; $index += 1) {
  "FILE$index=`"$($embeddedFiles[$index])`""
}
$sourceEntries = for ($index = 0; $index -lt $embeddedFiles.Count; $index += 1) {
  "%FILE$index%="
}
@"
[Version]
Class=IEXPRESS
SEDVersion=3

[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=1
HideExtractAnimation=1
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=AgentHero setup complete.
TargetName=$escapedTargetPath
FriendlyName=AgentHero Setup
AppLaunched=install.cmd
PostInstallCmd=<None>
AdminQuietInstCmd=install.cmd
UserQuietInstCmd=install.cmd
SourceFiles=SourceFiles

[Strings]
$($stringEntries -join "`r`n")

[SourceFiles]
SourceFiles0=$escapedBuildDir

[SourceFiles0]
$($sourceEntries -join "`r`n")
"@ | Set-Content -Path $sedPath -Encoding ASCII

& $iexpress /N /Q $sedPath
if (-not (Test-Path $targetPath)) {
  if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    throw "IExpress failed with exit code $LASTEXITCODE"
  }
  throw "IExpress did not create $targetPath"
}

Write-Host "Created $targetPath"
