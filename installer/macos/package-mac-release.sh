#!/usr/bin/env bash
set -euo pipefail

manifest_base_url="${MANIFEST_BASE_URL:-https://raw.githubusercontent.com/yohaas/AgentHero/main/installer/releases}"
manifest_url="${MANIFEST_URL:-https://raw.githubusercontent.com/yohaas/AgentHero/main/installer/manifest.json}"
commit_message="${COMMIT_MESSAGE:-Add macOS full release}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script must be run on macOS." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
cd "$repo_root"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree must be clean before packaging." >&2
  git status --short >&2
  exit 1
fi

git pull --ff-only

node_major="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$node_major" != "20" ]]; then
  echo "macOS release bundles must be built with Node.js 20 LTS. Current Node: $(node -p "process.version")" >&2
  exit 1
fi

version="$(node -p "require('$repo_root/package.json').version")"
release_dir="installer/releases/v$version"
mkdir -p "$release_dir"

"$repo_root/scripts/macos/create-release-bundle.sh" \
  --manifest-base-url "$manifest_base_url/v$version"

mac_zip="$(find "$repo_root/artifacts" -maxdepth 1 -type f -name "agent-hero-$version-macos-*.zip" | sort | tail -n 1)"
if [[ -z "$mac_zip" ]]; then
  echo "macOS release bundle was not created." >&2
  exit 1
fi
cp "$mac_zip" "$repo_root/$release_dir/$(basename "$mac_zip")"

node <<'NODE'
const fs = require("fs");
const path = require("path");

const manifestPath = path.join(process.cwd(), "installer", "manifest.json");
const generatedPath = path.join(process.cwd(), "artifacts", "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const generated = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
const generatedAsset = generated.assets?.find((asset) => asset.platform === "macos");
if (!generatedAsset) throw new Error("Generated manifest does not contain a macOS asset.");

const asset = {
  type: "full",
  platform: generatedAsset.platform,
  arch: generatedAsset.arch,
  version: generated.version,
  url: generatedAsset.url,
  sha256: generatedAsset.sha256,
  size: generatedAsset.size
};

const currentAssets = Array.isArray(manifest.assets) ? manifest.assets : [];
manifest.assets = [
  asset,
  ...currentAssets.filter((existing) => {
    const type = existing.type || "full";
    return !(type === "full" && existing.platform === asset.platform && existing.arch === asset.arch && existing.version === asset.version);
  })
];

if (manifest.version !== generated.version) {
  manifest.version = generated.version;
  manifest.releaseTag = generated.releaseTag;
  manifest.commitSha = generated.commitSha;
  manifest.builtAt = generated.builtAt;
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE

"$repo_root/scripts/macos/create-pkg-installer.sh" \
  --manifest-url "$manifest_url" \
  --output-path "$repo_root/installer/AgentHeroSetup.pkg"

git add \
  installer/manifest.json \
  installer/AgentHeroSetup.pkg \
  "$release_dir/$(basename "$mac_zip")"

if git diff --cached --quiet; then
  echo "No macOS release changes to commit."
  exit 0
fi

git commit -m "$commit_message"
git push
