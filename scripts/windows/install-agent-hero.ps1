param(
  [string]$ManifestUrl,
  [string]$InstallDir = "",
  [string]$TaskName = "AgentHero",
  [int]$Port = 4317,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
if (-not $ManifestUrl.Trim()) { throw "ManifestUrl is required." }

$resolvedInstallDir = if ($InstallDir.Trim()) { $InstallDir.Trim() } else { Join-Path $env:LOCALAPPDATA "Programs\AgentHero" }
$stateDir = Join-Path $env:LOCALAPPDATA "AgentHero"
$downloadDir = Join-Path $stateDir "installer"
$logDir = Join-Path $stateDir "logs"
$manifestPath = Join-Path $downloadDir "manifest.json"

function Get-Sha256FileHash {
  param([string]$Path)
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      $bytes = $sha256.ComputeHash($stream)
      return ([System.BitConverter]::ToString($bytes) -replace "-", "").ToLowerInvariant()
    } finally {
      $sha256.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

New-Item -ItemType Directory -Path $resolvedInstallDir, $downloadDir, $logDir -Force | Out-Null

$manifestIsLocal = Test-Path $ManifestUrl
if ($manifestIsLocal) {
  Copy-Item -LiteralPath $ManifestUrl -Destination $manifestPath -Force
  $manifestBasePath = Split-Path -Parent (Resolve-Path $ManifestUrl).Path
} else {
  Invoke-WebRequest -Uri $ManifestUrl -OutFile $manifestPath -UseBasicParsing
  $manifestBasePath = ""
}
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
$asset = $manifest.assets | Where-Object { $_.platform -eq "windows" -and (-not $_.arch -or $_.arch -eq "x64") } | Select-Object -First 1
if (-not $asset) { throw "Manifest does not contain a Windows update asset." }

$assetUrl = [string]$asset.url
if ($manifestIsLocal -and -not ([Uri]$assetUrl).IsAbsoluteUri) {
  $assetUrl = Join-Path $manifestBasePath $assetUrl
} elseif (-not ([Uri]$assetUrl).IsAbsoluteUri) {
  $assetUrl = [Uri]::new([Uri]$ManifestUrl, $assetUrl).AbsoluteUri
}
$assetLeaf = if (Test-Path $assetUrl) { Split-Path -Leaf $assetUrl } else { Split-Path -Leaf ([Uri]$assetUrl).LocalPath }
$zipPath = Join-Path $downloadDir $assetLeaf
$stageDir = Join-Path $downloadDir "stage"

if (Test-Path $assetUrl) {
  Copy-Item -LiteralPath $assetUrl -Destination $zipPath -Force
} else {
  Invoke-WebRequest -Uri $assetUrl -OutFile $zipPath -UseBasicParsing
}
$actualHash = Get-Sha256FileHash $zipPath
$expectedHash = ([string]$asset.sha256).ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw "Checksum mismatch. Expected $expectedHash but got $actualHash."
}

if (Test-Path $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $stageDir -Force
Copy-Item -Path (Join-Path $stageDir "*") -Destination $resolvedInstallDir -Recurse -Force

$startScript = Join-Path $resolvedInstallDir "scripts\windows\start-installed-agent-hero.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -InstallDir `"$resolvedInstallDir`" -ManifestUrl `"$ManifestUrl`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Starts AgentHero for the interactive Windows user."
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Host

$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "AgentHero.url"
"[InternetShortcut]`r`nURL=http://127.0.0.1:$Port`r`n" | Set-Content -Path $shortcutPath -Encoding ASCII

$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentHero"
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name "DisplayName" -Value "AgentHero"
Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $resolvedInstallDir
Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion" -Value ([string]$manifest.version)
Set-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"Unregister-ScheduledTask -TaskName '$TaskName' -Confirm:`$false; Remove-Item -LiteralPath '$resolvedInstallDir' -Recurse -Force; Remove-Item -Path '$uninstallKey' -Recurse -Force`""

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
}

Write-Host "AgentHero installed to $resolvedInstallDir"
Write-Host "Startup task: $TaskName"
Write-Host "Open http://127.0.0.1:$Port"
