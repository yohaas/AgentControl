#!/usr/bin/env bash
set -euo pipefail

version=""
from_version=""
release_tag=""
output_dir=""
manifest_base_url=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) version="${2:-}"; shift 2 ;;
    --from-version) from_version="${2:-}"; shift 2 ;;
    --release-tag) release_tag="${2:-}"; shift 2 ;;
    --output-dir) output_dir="${2:-}"; shift 2 ;;
    --manifest-base-url) manifest_base_url="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
app_version="${version:-$(node -p "require('$repo_root/package.json').version")}"
installer_manifest_path="$repo_root/installer/manifest.json"
if [[ -z "$from_version" && -f "$installer_manifest_path" ]]; then
  from_version="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); process.stdout.write(m.version || '');" "$installer_manifest_path")"
fi
if [[ -z "$from_version" ]]; then
  echo "from-version is required. Pass --from-version or keep installer/manifest.json at the currently published version." >&2
  exit 2
fi
if [[ "$from_version" == "$app_version" ]]; then
  echo "from-version must be older than the patch version." >&2
  exit 2
fi

tag="${release_tag:-v$app_version}"
commit_sha="$(git -C "$repo_root" rev-parse HEAD)"
built_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
artifacts_dir="${output_dir:-$repo_root/artifacts}"
work_dir="$artifacts_dir/agent-hero-$from_version-to-$app_version-app-patch"
zip_path="$artifacts_dir/agent-hero-$from_version-to-$app_version-app-patch.zip"
manifest_asset_path="$artifacts_dir/patch-asset.json"

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

cat > "$work_dir/version.json" <<JSON
{
  "version": "$app_version",
  "releaseTag": "$tag",
  "commitSha": "$commit_sha",
  "platform": "any",
  "arch": "any",
  "builtAt": "$built_at"
}
JSON

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

cat > "$manifest_asset_path" <<JSON
{
  "type": "patch",
  "platform": "any",
  "arch": "any",
  "fromVersion": "$from_version",
  "version": "$app_version",
  "url": "$asset_url",
  "sha256": "$sha256",
  "size": $asset_size
}
JSON

echo "Created $zip_path"
echo "SHA256 $sha256"
echo "Patch asset $manifest_asset_path"
