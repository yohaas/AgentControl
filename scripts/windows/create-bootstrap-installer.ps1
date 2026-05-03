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
if (Test-Path $targetPath) { Remove-Item -LiteralPath $targetPath -Force }
New-Item -ItemType Directory -Path $buildDir, (Split-Path -Parent $targetPath) -Force | Out-Null

$embeddedInstaller = Join-Path $buildDir "install-agent-hero.ps1"
$launcher = Join-Path $buildDir "install.cmd"
$sedPath = Join-Path $buildDir "AgentHeroSetup.sed"
Copy-Item -LiteralPath $installerScript -Destination $embeddedInstaller -Force
$embeddedFiles = @("install.cmd", "install-agent-hero.ps1")
$launcherManifestUrl = $ManifestUrl
$minimumTargetSize = 1

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
    $embeddedAssetPath = Join-Path $buildDir (Split-Path -Leaf $assetPath)
    Copy-Item -LiteralPath $assetPath -Destination $embeddedAssetPath -Force
    $embeddedFiles += (Split-Path -Leaf $assetPath)
    $minimumTargetSize = [Math]::Max(1048576, [int64]((Get-Item -LiteralPath $embeddedAssetPath).Length * 0.5))
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
title AgentHero Setup Launcher
echo.
echo AgentHero Setup
echo ===============
echo.
echo Installing AgentHero for the current Windows user.
echo Opening the setup progress window...
echo.
start "AgentHero Setup" /wait powershell.exe -NoExit $($installerArgs -join " ")
set EXIT_CODE=%ERRORLEVEL%
if not "%EXIT_CODE%"=="0" (
  echo.
  echo AgentHero setup failed with exit code %EXIT_CODE%.
  pause
  exit /b %EXIT_CODE%
)
exit /b 0
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

$iexpressProcess = Start-Process -FilePath $iexpress -ArgumentList @("/N", $sedPath) -Wait -PassThru -WindowStyle Hidden
for ($attempt = 0; $attempt -lt 20 -and -not (Test-Path $targetPath); $attempt += 1) {
  Start-Sleep -Milliseconds 500
}
if (Test-Path $targetPath) {
  $lastLength = -1
  $stableCount = 0
  for ($attempt = 0; $attempt -lt 120 -and $stableCount -lt 3; $attempt += 1) {
    $currentLength = (Get-Item -LiteralPath $targetPath).Length
    if ($currentLength -eq $lastLength -and $currentLength -ge $minimumTargetSize) {
      $stableCount += 1
    } else {
      $stableCount = 0
      $lastLength = $currentLength
    }
    Start-Sleep -Milliseconds 500
  }
}
if (-not (Test-Path $targetPath)) {
  if ($null -ne $iexpressProcess.ExitCode -and $iexpressProcess.ExitCode -ne 0) {
    throw "IExpress failed with exit code $($iexpressProcess.ExitCode)"
  }
  throw "IExpress did not create $targetPath"
}

Write-Host "Created $targetPath"
