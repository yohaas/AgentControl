param(
  [string]$Version = "",
  [string]$FromVersion = "",
  [string]$ReleaseTag = "",
  [string]$OutputDir = "",
  [string]$ManifestBaseUrl = ""
)

$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..\..")
$packageJson = Get-Content -Raw -Path (Join-Path $repoRoot "package.json") | ConvertFrom-Json
$appVersion = if ($Version.Trim()) { $Version.Trim() } else { [string]$packageJson.version }
$installerManifestPath = Join-Path $repoRoot "installer\manifest.json"
if (-not $FromVersion.Trim() -and (Test-Path $installerManifestPath)) {
  $currentManifest = Get-Content -Raw -Path $installerManifestPath | ConvertFrom-Json
  if ($currentManifest.version) { $FromVersion = [string]$currentManifest.version }
}
if (-not $FromVersion.Trim()) { throw "FromVersion is required. Pass -FromVersion or keep installer\manifest.json at the currently published version." }
if ($FromVersion.Trim() -eq $appVersion) { throw "FromVersion must be older than the patch Version." }

$tag = if ($ReleaseTag.Trim()) { $ReleaseTag.Trim() } else { "v$appVersion" }
$commitSha = (git -C $repoRoot rev-parse HEAD).Trim()
$builtAt = (Get-Date).ToUniversalTime().ToString("o")
$artifactsDir = if ($OutputDir.Trim()) { $OutputDir.Trim() } else { Join-Path $repoRoot "artifacts" }
$workDir = Join-Path $artifactsDir "agent-hero-$($FromVersion.Trim())-to-$appVersion-app-patch"
$zipPath = Join-Path $artifactsDir "agent-hero-$($FromVersion.Trim())-to-$appVersion-app-patch.zip"
$manifestAssetPath = Join-Path $artifactsDir "patch-asset.json"

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
  "assets",
  ".agent-hero"
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
  platform = "any"
  arch = "any"
  builtAt = $builtAt
}
$versionJson | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $workDir "version.json") -Encoding UTF8

Compress-Archive -Path (Join-Path $workDir "*") -DestinationPath $zipPath -Force
$hash = Get-Sha256FileHash $zipPath
$assetName = Split-Path -Leaf $zipPath
$assetUrl = if ($ManifestBaseUrl.Trim()) { "$($ManifestBaseUrl.TrimEnd('/'))/$assetName" } else { $assetName }
$asset = [ordered]@{
  type = "patch"
  platform = "any"
  arch = "any"
  fromVersion = $FromVersion.Trim()
  version = $appVersion
  url = $assetUrl
  sha256 = $hash
  size = (Get-Item $zipPath).Length
}
$asset | ConvertTo-Json -Depth 5 | Set-Content -Path $manifestAssetPath -Encoding UTF8

Write-Host "Created $zipPath"
Write-Host "SHA256 $hash"
Write-Host "Patch asset $manifestAssetPath"
