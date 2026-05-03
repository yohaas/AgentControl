#!/usr/bin/env bash
set -euo pipefail

version=""
release_tag=""
output_dir=""
manifest_base_url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 ;;
    --release-tag) release_tag="${2:-}"; shift 2 ;;
    --output-dir) output_dir="${2:-}"; shift 2 ;;
    --manifest-base-url) manifest_base_url="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS bundles must be built on macOS so native dependencies are built for Darwin." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_version="${version:-$(node -p "require('$repo_root/package.json').version")}"
tag="${release_tag:-v$app_version}"
commit_sha="$(git -C "$repo_root" rev-parse HEAD)"
platform="macos"
arch="$(node -p "process.arch")"
built_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
artifacts_dir="${output_dir:-$repo_root/artifacts}"
work_dir="$artifacts_dir/agent-hero-$app_version-$platform-$arch"
zip_path="$artifacts_dir/agent-hero-$app_version-$platform-$arch.zip"
manifest_path="$artifacts_dir/manifest.json"

mkdir -p "$artifacts_dir"
rm -rf "$work_dir" "$zip_path"
mkdir -p "$work_dir"

(
  cd "$repo_root"
  npm run build
)

copy_path() {
  local source="$repo_root/$1"
  local target="$work_dir/$1"
  [[ -e "$source" ]] || return 0
  mkdir -p "$(dirname "$target")"
  cp -R "$source" "$target"
}

copy_path "package.json"
copy_path "package-lock.json"
copy_path "server/package.json"
copy_path "server/dist"
copy_path "shared/package.json"
copy_path "shared/dist"
copy_path "web/package.json"
copy_path "web/dist"
copy_path "assets"
copy_path ".agent-hero"
copy_path "scripts/macos/install-agent-hero.sh"
copy_path "scripts/macos/update-installed-agent-hero.sh"

cat > "$work_dir/version.json" <<JSON
{
  "version": "$app_version",
  "releaseTag": "$tag",
  "commitSha": "$commit_sha",
  "platform": "$platform",
  "arch": "$arch",
  "builtAt": "$built_at"
}
JSON

(
  cd "$work_dir"
  npm ci --omit=dev --workspace server
)

(
  cd "$work_dir"
  zip -qry "$zip_path" .
)

sha256="$(shasum -a 256 "$zip_path" | awk '{print $1}')"
asset_name="$(basename "$zip_path")"
if [[ -n "$manifest_base_url" ]]; then
  asset_url="${manifest_base_url%/}/$asset_name"
else
  asset_url="$asset_name"
fi
asset_size="$(wc -c < "$zip_path" | tr -d ' ')"

cat > "$manifest_path" <<JSON
{
  "version": "$app_version",
  "releaseTag": "$tag",
  "commitSha": "$commit_sha",
  "platform": "$platform",
  "arch": "$arch",
  "builtAt": "$built_at",
  "releaseNotesUrl": "",
  "assets": [
    {
      "platform": "$platform",
      "arch": "$arch",
      "url": "$asset_url",
      "sha256": "$sha256",
      "size": $asset_size
    }
  ]
}
JSON

echo "Created $zip_path"
echo "SHA256 $sha256"
echo "Manifest $manifest_path"
