param(
  [string]$Version = "",
  [string]$ReleaseTag = "",
  [string]$OutputDir = "",
  [string]$ManifestBaseUrl = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$packageJson = Get-Content -Raw -Path (Join-Path $repoRoot "package.json") | ConvertFrom-Json
$appVersion = if ($Version.Trim()) { $Version.Trim() } else { [string]$packageJson.version }
$tag = if ($ReleaseTag.Trim()) { $ReleaseTag.Trim() } else { "v$appVersion" }
$commitSha = (git -C $repoRoot rev-parse HEAD).Trim()
$shortSha = (git -C $repoRoot rev-parse --short HEAD).Trim()
$platform = "windows"
$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { "x86" }
$builtAt = (Get-Date).ToUniversalTime().ToString("o")
$artifactsDir = if ($OutputDir.Trim()) { $OutputDir.Trim() } else { Join-Path $repoRoot "artifacts" }
$workDir = Join-Path $artifactsDir "agent-hero-$appVersion-$platform-$arch"
$zipPath = Join-Path $artifactsDir "agent-hero-$appVersion-$platform-$arch.zip"
$manifestPath = Join-Path $artifactsDir "manifest.json"

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

New-Item -ItemType Directory -Path $artifactsDir -Force | Out-Null
if (Test-Path $workDir) { Remove-Item -LiteralPath $workDir -Recurse -Force }
if (Test-Path $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
New-Item -ItemType Directory -Path $workDir -Force | Out-Null

Push-Location $repoRoot
try {
  npm run build
} finally {
  Pop-Location
}

$pathsToCopy = @(
  "package.json",
  "package-lock.json",
  "server\package.json",
  "server\dist",
  "shared\package.json",
  "shared\dist",
  "web\package.json",
  "web\dist",
  ".agent-hero",
  "scripts\windows\start-installed-agent-hero.ps1",
  "scripts\windows\start-installed-update.ps1",
  "scripts\windows\update-installed-agent-hero.ps1"
)

foreach ($relativePath in $pathsToCopy) {
  $source = Join-Path $repoRoot $relativePath
  if (-not (Test-Path $source)) { continue }
  $target = Join-Path $workDir $relativePath
  $targetParent = Split-Path -Parent $target
  New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
}

$versionJson = [ordered]@{
  version = $appVersion
  releaseTag = $tag
  commitSha = $commitSha
  platform = $platform
  arch = $arch
  builtAt = $builtAt
}
$versionJson | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $workDir "version.json") -Encoding UTF8

Push-Location $workDir
try {
  npm ci --omit=dev --workspace server
} finally {
  Pop-Location
}

Compress-Archive -Path (Join-Path $workDir "*") -DestinationPath $zipPath -Force
$hash = Get-Sha256FileHash $zipPath
$assetName = Split-Path -Leaf $zipPath
$assetUrl = if ($ManifestBaseUrl.Trim()) { "$($ManifestBaseUrl.TrimEnd('/'))/$assetName" } else { $assetName }
$manifest = [ordered]@{
  version = $appVersion
  releaseTag = $tag
  commitSha = $commitSha
  platform = $platform
  arch = $arch
  builtAt = $builtAt
  releaseNotesUrl = ""
  assets = @(
    [ordered]@{
      platform = $platform
      arch = $arch
      url = $assetUrl
      sha256 = $hash
      size = (Get-Item $zipPath).Length
    }
  )
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestPath -Encoding UTF8

Write-Host "Created $zipPath"
Write-Host "SHA256 $hash"
Write-Host "Manifest $manifestPath"
