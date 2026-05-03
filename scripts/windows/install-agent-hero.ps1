param(
  [string]$ManifestUrl,
  [string]$InstallDir = "",
  [string]$TaskName = "AgentHero",
  [int]$Port = 4317,
  [string]$LogPath = "",
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"
if (-not $ManifestUrl.Trim()) { throw "ManifestUrl is required." }

$resolvedInstallDir = if ($InstallDir.Trim()) { $InstallDir.Trim() } else { Join-Path $env:LOCALAPPDATA "Programs\AgentHero" }
$stateDir = Join-Path $env:LOCALAPPDATA "AgentHero"
$downloadDir = Join-Path $stateDir "installer"
$logDir = Join-Path $stateDir "logs"
$manifestPath = Join-Path $downloadDir "manifest.json"
$resolvedLogPath = if ($LogPath.Trim()) { $LogPath.Trim() } else { Join-Path $logDir "setup.log" }
$transcriptStarted = $false

function Write-InstallStep {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-InstallDetail {
  param([string]$Message)
  Write-Host "    $Message"
}

function PowerShellSingleQuoted {
  param([string]$Value)
  return "'$($Value -replace "'", "''")'"
}

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

function Stop-ExistingAgentHero {
  Write-InstallStep "Stopping existing AgentHero"
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Write-InstallDetail "Stopped scheduled task: $TaskName"
  }

  $pidPath = Join-Path $stateDir "agent-hero.pid"
  if (Test-Path $pidPath) {
    $pidValue = Get-Content -Path $pidPath -ErrorAction SilentlyContinue | Select-Object -First 1
    $parsedPid = 0
    if ($pidValue -and [int]::TryParse([string]$pidValue, [ref]$parsedPid)) {
      $process = Get-Process -Id $parsedPid -ErrorAction SilentlyContinue
      if ($process) {
        Write-InstallDetail "Stopping AgentHero PID $parsedPid"
        Stop-Process -Id $parsedPid -Force
        $process.WaitForExit(15000)
      }
    }
    Remove-Item -LiteralPath $pidPath -Force -ErrorAction SilentlyContinue
  }

  $installDirLower = $resolvedInstallDir.TrimEnd("\").ToLowerInvariant()
  $processes = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessId -ne $PID -and (
      ([string]$_.ExecutablePath).ToLowerInvariant().StartsWith($installDirLower) -or
      ([string]$_.CommandLine).ToLowerInvariant().Contains($installDirLower)
    )
  }
  foreach ($processInfo in $processes) {
    Write-InstallDetail "Stopping process $($processInfo.ProcessId): $($processInfo.Name)"
    Stop-Process -Id $processInfo.ProcessId -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

Write-Host ""
Write-Host "AgentHero Setup" -ForegroundColor Green
Write-Host "This installer will install AgentHero for the current Windows user."
Write-Host ""

Write-InstallStep "Preparing folders"
Write-InstallDetail "Install directory: $resolvedInstallDir"
Write-InstallDetail "Installer state: $downloadDir"
New-Item -ItemType Directory -Path $resolvedInstallDir, $downloadDir, $logDir -Force | Out-Null
try {
  Start-Transcript -Path $resolvedLogPath -Append | Out-Null
  $transcriptStarted = $true
  Write-InstallDetail "Installer log: $resolvedLogPath"
} catch {
  Write-Warning "Could not start installer transcript at $resolvedLogPath. $($_.Exception.Message)"
}

$manifestIsLocal = Test-Path $ManifestUrl
Write-InstallStep "Loading release manifest"
if ($manifestIsLocal) {
  Write-InstallDetail "Using bundled manifest."
  Copy-Item -LiteralPath $ManifestUrl -Destination $manifestPath -Force
  $manifestBasePath = Split-Path -Parent (Resolve-Path $ManifestUrl).Path
} else {
  Write-InstallDetail "Downloading $ManifestUrl"
  Invoke-WebRequest -Uri $ManifestUrl -OutFile $manifestPath -UseBasicParsing
  $manifestBasePath = ""
}
$manifest = Get-Content -Raw -Path $manifestPath | ConvertFrom-Json
Write-InstallDetail "Version: $($manifest.version)"
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

Write-InstallStep "Getting release bundle"
if (Test-Path $assetUrl) {
  Write-InstallDetail "Using bundled asset $assetLeaf"
  Copy-Item -LiteralPath $assetUrl -Destination $zipPath -Force
} else {
  Write-InstallDetail "Downloading $assetUrl"
  Invoke-WebRequest -Uri $assetUrl -OutFile $zipPath -UseBasicParsing
}

Write-InstallStep "Verifying checksum"
$actualHash = Get-Sha256FileHash $zipPath
$expectedHash = ([string]$asset.sha256).ToLowerInvariant()
if ($actualHash -ne $expectedHash) {
  throw "Checksum mismatch. Expected $expectedHash but got $actualHash."
}
Write-InstallDetail "SHA256 verified."

Write-InstallStep "Extracting files"
if (Test-Path $stageDir) { Remove-Item -LiteralPath $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir -Force | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $stageDir -Force

Stop-ExistingAgentHero

Write-InstallStep "Installing AgentHero"
Copy-Item -Path (Join-Path $stageDir "*") -Destination $resolvedInstallDir -Recurse -Force

Write-InstallStep "Registering startup task"
$startScript = Join-Path $resolvedInstallDir "scripts\windows\start-installed-agent-hero.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$startScript`" -InstallDir `"$resolvedInstallDir`" -ManifestUrl `"$ManifestUrl`" -Port $Port"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Starts AgentHero for the interactive Windows user."
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Host
Write-InstallDetail "Scheduled task: $TaskName"

Write-InstallStep "Creating shortcuts"
$iconPath = Join-Path $resolvedInstallDir "assets\AgentHero.ico"
$shortcutContent = "[InternetShortcut]`r`nURL=http://127.0.0.1:$Port`r`n"
if (Test-Path $iconPath) {
  $shortcutContent += "IconFile=$iconPath`r`nIconIndex=0`r`n"
  Write-InstallDetail "Icon: $iconPath"
}
$shortcutPath = Join-Path ([Environment]::GetFolderPath("Desktop")) "AgentHero.url"
$shortcutContent | Set-Content -Path $shortcutPath -Encoding ASCII
Write-InstallDetail "Desktop: $shortcutPath"
$startMenuDir = Join-Path ([Environment]::GetFolderPath("Programs")) "AgentHero"
$startMenuShortcutPath = Join-Path $startMenuDir "AgentHero.url"
New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null
$shortcutContent | Set-Content -Path $startMenuShortcutPath -Encoding ASCII
Write-InstallDetail "Start Menu: $startMenuShortcutPath"

Write-InstallStep "Registering uninstall entry"
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentHero"
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name "DisplayName" -Value "AgentHero"
Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $resolvedInstallDir
Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion" -Value ([string]$manifest.version)
$uninstallCommand = @(
  "Unregister-ScheduledTask -TaskName $(PowerShellSingleQuoted $TaskName) -Confirm:`$false -ErrorAction SilentlyContinue",
  "Remove-Item -LiteralPath $(PowerShellSingleQuoted $resolvedInstallDir) -Recurse -Force -ErrorAction SilentlyContinue",
  "Remove-Item -LiteralPath $(PowerShellSingleQuoted $shortcutPath) -Force -ErrorAction SilentlyContinue",
  "Remove-Item -LiteralPath $(PowerShellSingleQuoted $startMenuDir) -Recurse -Force -ErrorAction SilentlyContinue",
  "Remove-Item -Path $(PowerShellSingleQuoted $uninstallKey) -Recurse -Force -ErrorAction SilentlyContinue"
) -join "; "
Set-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"$uninstallCommand`""

if (-not $NoStart) {
  Write-InstallStep "Starting AgentHero"
  Start-ScheduledTask -TaskName $TaskName
} else {
  Write-InstallStep "Skipping startup"
  Write-InstallDetail "Setup was built with -NoStart."
}

Write-Host ""
Write-Host "AgentHero setup complete." -ForegroundColor Green
Write-Host "AgentHero installed to $resolvedInstallDir"
Write-Host "Startup task: $TaskName"
Write-Host "Open http://127.0.0.1:$Port"
Write-Host "Installer log: $resolvedLogPath"
Write-Host "Close this setup window when you are done."
if ($transcriptStarted) {
  Stop-Transcript | Out-Null
}
