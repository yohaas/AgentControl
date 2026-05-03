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
$artifactsDir = Join-Path $repoRoot "artifacts"
$buildDir = Join-Path $artifactsDir "installer-build"
$installerScript = Join-Path $PSScriptRoot "install-agent-hero.ps1"
$iconPath = Join-Path $repoRoot "assets\AgentHero.ico"
$targetPath = if ($OutputPath.Trim()) { $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath.Trim()) } else { Join-Path $artifactsDir "AgentHeroSetup.exe" }

function Resolve-InnoCompiler {
  $pathCommand = Get-Command ISCC.exe -ErrorAction SilentlyContinue
  if ($pathCommand) { return $pathCommand.Source }

  $candidates = @(
    "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
    "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
    "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path $candidate)) { return $candidate }
  }

  throw "Inno Setup compiler ISCC.exe was not found. Install it with: winget install --id JRSoftware.InnoSetup -e"
}

function InnoString {
  param([string]$Value)
  return $Value -replace '"', '""'
}

function PascalString {
  param([string]$Value)
  return $Value -replace "'", "''"
}

if (-not $ManifestUrl.Trim()) { throw "ManifestUrl is required." }
if (-not (Test-Path $installerScript)) { throw "Installer script was not found at $installerScript" }
if (-not (Test-Path $iconPath)) { throw "Installer icon was not found at $iconPath" }

$iscc = Resolve-InnoCompiler
$targetDir = Split-Path -Parent $targetPath
$targetBaseName = [System.IO.Path]::GetFileNameWithoutExtension($targetPath)
if (Test-Path $buildDir) { Remove-Item -LiteralPath $buildDir -Recurse -Force }
if (Test-Path $targetPath) { Remove-Item -LiteralPath $targetPath -Force }
New-Item -ItemType Directory -Path $buildDir, $targetDir -Force | Out-Null

$embeddedInstaller = Join-Path $buildDir "install-agent-hero.ps1"
$embeddedIcon = Join-Path $buildDir "AgentHero.ico"
Copy-Item -LiteralPath $installerScript -Destination $embeddedInstaller -Force
Copy-Item -LiteralPath $iconPath -Destination $embeddedIcon -Force

$launcherManifestUrl = $ManifestUrl
$files = @(
  @{ Source = $embeddedInstaller; DestName = "install-agent-hero.ps1" },
  @{ Source = $embeddedIcon; DestName = "AgentHero.ico" }
)
$appVersion = "0.1.0"

if (Test-Path $ManifestUrl) {
  $resolvedManifestPath = (Resolve-Path $ManifestUrl).Path
  $manifest = Get-Content -Raw -Path $resolvedManifestPath | ConvertFrom-Json
  if ($manifest.version) { $appVersion = [string]$manifest.version }

  $embeddedManifest = Join-Path $buildDir "manifest.json"
  Copy-Item -LiteralPath $resolvedManifestPath -Destination $embeddedManifest -Force
  $files += @{ Source = $embeddedManifest; DestName = "manifest.json" }
  $launcherManifestUrl = "{tmp}\manifest.json"

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
    $files += @{ Source = $embeddedAssetPath; DestName = (Split-Path -Leaf $assetPath) }
  }
}

$defaultInstallDir = if ($InstallDir.Trim()) { $InstallDir.Trim() } else { "{localappdata}\Programs\AgentHero" }
$installerArgs = @(
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  "`"{tmp}\install-agent-hero.ps1`"",
  "-ManifestUrl",
  "`"$launcherManifestUrl`"",
  "-InstallDir",
  "`"{app}`"",
  "-TaskName",
  "`"$TaskName`"",
  "-Port",
  "$Port"
)
if ($NoStart) {
  $installerArgs += "-NoStart"
}

$fileEntries = foreach ($file in $files) {
  "Source: ""$((InnoString $file.Source))""; DestDir: ""{tmp}""; DestName: ""$((InnoString $file.DestName))""; Flags: deleteafterinstall"
}
$runParameters = PascalString ($installerArgs -join " ")

$issPath = Join-Path $buildDir "AgentHeroSetup.iss"
@"
[Setup]
AppId={{C82E3682-41D8-4A44-A59D-EFB91A1057D7}
AppName=AgentHero
AppVersion=$appVersion
AppPublisher=AgentHero
DefaultDirName=$defaultInstallDir
DisableProgramGroupPage=yes
OutputDir=$targetDir
OutputBaseFilename=$targetBaseName
SetupIconFile=$embeddedIcon
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Uninstallable=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
$($fileEntries -join "`r`n")

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssInstall then
  begin
    WizardForm.StatusLabel.Caption := 'Installing AgentHero and registering startup...';
    if not Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), ExpandConstant('$runParameters'), '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
    begin
      MsgBox('AgentHero setup could not start PowerShell.', mbError, MB_OK);
      Abort;
    end;
    if ResultCode <> 0 then
    begin
      MsgBox('AgentHero setup failed. Check the installer logs under %LocalAppData%\AgentHero\logs.', mbError, MB_OK);
      Abort;
    end;
  end;
end;
"@ | Set-Content -Path $issPath -Encoding ASCII

$process = Start-Process -FilePath $iscc -ArgumentList @($issPath) -Wait -PassThru -NoNewWindow
if ($process.ExitCode -ne 0) {
  throw "Inno Setup failed with exit code $($process.ExitCode)"
}
if (-not (Test-Path $targetPath)) {
  throw "Inno Setup did not create $targetPath"
}

Write-Host "Created $targetPath"
