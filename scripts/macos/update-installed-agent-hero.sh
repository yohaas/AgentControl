#!/usr/bin/env bash
set -euo pipefail

manifest_url="${AGENTHERO_UPDATE_MANIFEST_URL:-}"
install_dir="$HOME/Applications/AgentHero"
label="com.agenthero"
port="4317"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-url) manifest_url="${2:-}"; shift 2 ;;
    --install-dir) install_dir="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$manifest_url" ]] || { echo "--manifest-url or AGENTHERO_UPDATE_MANIFEST_URL is required" >&2; exit 2; }

state_dir="$HOME/Library/Application Support/AgentHero"
download_dir="$state_dir/updates"
backup_dir="$state_dir/rollback"
log_dir="$HOME/Library/Logs/AgentHero"
plist_path="$HOME/Library/LaunchAgents/$label.plist"
manifest_path="$download_dir/manifest.json"
stage_dir="$download_dir/stage"
log_path="$log_dir/installed-update.log"

mkdir -p "$download_dir" "$backup_dir" "$log_dir"

log() {
  local line
  line="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$line"
  echo "$line" >> "$log_path"
}

health_check() {
  local deadline=$((SECONDS + 45))
  while [[ $SECONDS -lt $deadline ]]; do
    if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

stop_agenthero() {
  launchctl bootout "gui/$UID" "$plist_path" >/dev/null 2>&1 || true
}

start_agenthero() {
  launchctl bootstrap "gui/$UID" "$plist_path"
  launchctl kickstart -k "gui/$UID/$label"
}

local_version() {
  node -e "
const fs = require('fs');
const path = require('path');
const root = process.argv[1];
for (const file of ['version.json', 'package.json']) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    if (parsed.version) {
      process.stdout.write(String(parsed.version));
      process.exit(0);
    }
  } catch {}
}
" "$install_dir"
}

log "AgentHero installed update started in $install_dir"

if [[ -f "$manifest_url" ]]; then
  cp "$manifest_url" "$manifest_path"
  manifest_base="$(cd "$(dirname "$manifest_url")" && pwd)"
else
  curl -fsSL "$manifest_url" -o "$manifest_path"
  manifest_base=""
fi

installed_version="$(local_version)"
asset_json="$(node -e "
const fs = require('fs');
const m = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const localVersion = process.argv[2] || '';
const targetVersion = m.version || '';
const matchesRuntime = (asset) => {
  const platform = String(asset.platform || '').toLowerCase();
  const arch = String(asset.arch || '').toLowerCase();
  return (platform === 'macos' || platform === 'any') && (!arch || arch === process.arch || arch === 'any');
};
const assetVersion = (asset) => asset.version || targetVersion;
const matching = (m.assets || []).filter(matchesRuntime);
let selected;
if (localVersion) {
  selected = matching.find((asset) =>
    (asset.type || 'full') === 'patch' &&
    asset.fromVersion === localVersion &&
    (!targetVersion || assetVersion(asset) === targetVersion)
  );
}
selected ||= matching.find((asset) =>
  (asset.type || 'full') === 'full' &&
  (!targetVersion || !asset.version || assetVersion(asset) === targetVersion)
);
if (!selected) process.exit(2);
process.stdout.write(JSON.stringify(selected));
" "$manifest_path" "$installed_version")" || {
  echo "Manifest does not contain a matching macOS asset." >&2
  exit 1
}
asset_url="$(node -e "const a=JSON.parse(process.argv[1]); console.log(a.url);" "$asset_json")"
expected_sha="$(node -e "const a=JSON.parse(process.argv[1]); console.log(a.sha256);" "$asset_json")"
asset_type="$(node -e "const a=JSON.parse(process.argv[1]); console.log(a.type || 'full');" "$asset_json")"
log "Selected $asset_type update asset for installed version $installed_version"

if [[ -n "$manifest_base" && "$asset_url" != http://* && "$asset_url" != https://* ]]; then
  asset_url="$manifest_base/$asset_url"
fi

zip_path="$download_dir/$(basename "$asset_url")"
if [[ -f "$asset_url" ]]; then
  cp "$asset_url" "$zip_path"
else
  curl -fsSL "$asset_url" -o "$zip_path"
fi

actual_sha="$(shasum -a 256 "$zip_path" | awk '{print $1}')"
if [[ "$actual_sha" != "$expected_sha" ]]; then
  echo "Checksum mismatch. Expected $expected_sha but got $actual_sha." >&2
  exit 1
fi

rm -rf "$stage_dir"
mkdir -p "$stage_dir"
unzip -q "$zip_path" -d "$stage_dir"

backup_path="$backup_dir/agent-hero-$(date '+%Y%m%d%H%M%S')"
log "Stopping AgentHero"
stop_agenthero
log "Backing up current install to $backup_path"
mv "$install_dir" "$backup_path"
mkdir -p "$install_dir"
if [[ "$asset_type" == "patch" ]]; then
  log "Applying patch files"
  rsync -a "$backup_path/" "$install_dir/"
  rsync -a "$stage_dir/" "$install_dir/"
else
  log "Applying full release files"
  rsync -a --delete "$stage_dir/" "$install_dir/"
fi

log "Starting AgentHero"
start_agenthero
if ! health_check; then
  log "Health check failed; rolling back."
  stop_agenthero
  rm -rf "$install_dir"
  mv "$backup_path" "$install_dir"
  start_agenthero
  echo "AgentHero failed to start after update; rollback was attempted." >&2
  exit 1
fi

log "AgentHero installed update complete."
