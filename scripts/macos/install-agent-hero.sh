#!/usr/bin/env bash
set -euo pipefail

manifest_url=""
install_dir="$HOME/Applications/AgentHero"
label="com.agenthero"
port="4317"
no_start="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-url) manifest_url="${2:-}"; shift 2 ;;
    --install-dir) install_dir="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    --no-start) no_start="1"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$manifest_url" ]] || { echo "--manifest-url is required" >&2; exit 2; }

state_dir="$HOME/Library/Application Support/AgentHero"
download_dir="$state_dir/installer"
log_dir="$HOME/Library/Logs/AgentHero"
launch_agents_dir="$HOME/Library/LaunchAgents"
plist_path="$launch_agents_dir/$label.plist"
manifest_path="$download_dir/manifest.json"
stage_dir="$download_dir/stage"
node_path="$(command -v node)"

mkdir -p "$install_dir" "$download_dir" "$log_dir" "$launch_agents_dir"

if [[ -f "$manifest_url" ]]; then
  cp "$manifest_url" "$manifest_path"
  manifest_base="$(cd "$(dirname "$manifest_url")" && pwd)"
else
  curl -fsSL "$manifest_url" -o "$manifest_path"
  manifest_base=""
fi

asset_url="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const a=(m.assets||[]).find((x)=>x.platform==='macos' && (!x.arch || x.arch===process.arch)); if(!a) process.exit(2); console.log(a.url);" "$manifest_path")" || {
  echo "Manifest does not contain a matching macOS asset." >&2
  exit 1
}
expected_sha="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const a=(m.assets||[]).find((x)=>x.platform==='macos' && (!x.arch || x.arch===process.arch)); console.log(a.sha256);" "$manifest_path")"
version="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(m.version || '');" "$manifest_path")"

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
rsync -a --delete "$stage_dir/" "$install_dir/"

cat > "$plist_path" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>WorkingDirectory</key>
  <string>$install_dir</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_path</string>
    <string>$install_dir/server/dist/index.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGENTHERO_INSTALL_MODE</key>
    <string>installed</string>
    <key>AGENTHERO_UPDATE_MANIFEST_URL</key>
    <string>$manifest_url</string>
    <key>HOST</key>
    <string>127.0.0.1</string>
    <key>PORT</key>
    <string>$port</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$log_dir/agent-hero.out.log</string>
  <key>StandardErrorPath</key>
  <string>$log_dir/agent-hero.err.log</string>
</dict>
</plist>
PLIST

if [[ "$no_start" != "1" ]]; then
  launchctl bootout "gui/$UID" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$plist_path"
  launchctl kickstart -k "gui/$UID/$label"
fi

echo "AgentHero installed to $install_dir"
echo "LaunchAgent: $plist_path"
echo "Version: $version"
echo "Open http://127.0.0.1:$port"
