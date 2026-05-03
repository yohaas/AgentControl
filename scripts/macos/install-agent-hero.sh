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
apps_dir="$(dirname "$install_dir")"
app_bundle_path="$apps_dir/AgentHero.app"

mkdir -p "$install_dir" "$download_dir" "$log_dir" "$launch_agents_dir"
install_log_path="$log_dir/install.log"
exec > >(tee -a "$install_log_path") 2>&1
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

resolve_node_path() {
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  echo "Node.js was not found. Install Node.js 20 or newer and retry AgentHero setup." >&2
  exit 1
}

echo "AgentHero install started at $(date '+%Y-%m-%d %H:%M:%S')"
echo "Log: $install_log_path"
node_path="$(resolve_node_path)"
echo "Node: $node_path"

if [[ -f "$manifest_url" ]]; then
  cp "$manifest_url" "$manifest_path"
  manifest_base="$(cd "$(dirname "$manifest_url")" && pwd)"
else
  curl -fsSL "$manifest_url" -o "$manifest_path"
  manifest_base=""
fi

asset_url="$("$node_path" -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const a=(m.assets||[]).find((x)=>x.platform==='macos' && (!x.arch || x.arch===process.arch)); if(!a) process.exit(2); console.log(a.url);" "$manifest_path")" || {
  echo "Manifest does not contain a matching macOS asset." >&2
  exit 1
}
expected_sha="$("$node_path" -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const a=(m.assets||[]).find((x)=>x.platform==='macos' && (!x.arch || x.arch===process.arch)); console.log(a.sha256);" "$manifest_path")"
version="$("$node_path" -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); console.log(m.version || '');" "$manifest_path")"

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

mkdir -p "$app_bundle_path/Contents/MacOS"
mkdir -p "$app_bundle_path/Contents/Resources"
icon_file_entry=""
icon_png_path="$install_dir/assets/AgentHero.png"
if [[ -f "$icon_png_path" ]] && command -v sips >/dev/null 2>&1 && command -v iconutil >/dev/null 2>&1; then
  iconset_path="$download_dir/AgentHero.iconset"
  rm -rf "$iconset_path"
  mkdir -p "$iconset_path"
  sips -z 16 16 "$icon_png_path" --out "$iconset_path/icon_16x16.png" >/dev/null
  sips -z 32 32 "$icon_png_path" --out "$iconset_path/icon_16x16@2x.png" >/dev/null
  sips -z 32 32 "$icon_png_path" --out "$iconset_path/icon_32x32.png" >/dev/null
  sips -z 64 64 "$icon_png_path" --out "$iconset_path/icon_32x32@2x.png" >/dev/null
  sips -z 128 128 "$icon_png_path" --out "$iconset_path/icon_128x128.png" >/dev/null
  sips -z 256 256 "$icon_png_path" --out "$iconset_path/icon_128x128@2x.png" >/dev/null
  sips -z 256 256 "$icon_png_path" --out "$iconset_path/icon_256x256.png" >/dev/null
  sips -z 512 512 "$icon_png_path" --out "$iconset_path/icon_256x256@2x.png" >/dev/null
  sips -z 512 512 "$icon_png_path" --out "$iconset_path/icon_512x512.png" >/dev/null
  cp "$icon_png_path" "$iconset_path/icon_512x512@2x.png"
  if iconutil -c icns "$iconset_path" -o "$app_bundle_path/Contents/Resources/AgentHero.icns"; then
    icon_file_entry=$'  <key>CFBundleIconFile</key>\n  <string>AgentHero</string>\n'
    echo "Application icon: $app_bundle_path/Contents/Resources/AgentHero.icns"
  else
    echo "Application icon generation failed; continuing without an icon."
  fi
else
  echo "Application icon generation skipped; AgentHero.png, sips, or iconutil was not available."
fi
cat > "$app_bundle_path/Contents/Info.plist" <<APP_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>AgentHero</string>
  <key>CFBundleIdentifier</key>
  <string>com.agenthero.launcher</string>
  <key>CFBundleName</key>
  <string>AgentHero</string>
  <key>CFBundleDisplayName</key>
  <string>AgentHero</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
${icon_file_entry}  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>CFBundleVersion</key>
  <string>$version</string>
  <key>CFBundleShortVersionString</key>
  <string>$version</string>
</dict>
</plist>
APP_PLIST
cat > "$app_bundle_path/Contents/MacOS/AgentHero" <<APP_SCRIPT
#!/usr/bin/env bash
set -euo pipefail
install_dir="$install_dir"
node_path="$node_path"
log_dir="\$HOME/Library/Logs/AgentHero"
manifest_url="$manifest_url"
port="$port"
mkdir -p "\$log_dir"
exec >> "\$log_dir/launcher.log" 2>&1
echo "AgentHero launcher started at \$(date '+%Y-%m-%d %H:%M:%S')"
plist_path="\$HOME/Library/LaunchAgents/$label.plist"
if [[ -f "\$plist_path" ]]; then
  launchctl bootstrap "gui/\$UID" "\$plist_path" >/dev/null 2>&1 || true
  launchctl kickstart -kp "gui/\$UID/$label" >/dev/null 2>&1 || true
else
  echo "LaunchAgent plist not found: \$plist_path"
fi
deadline=\$((SECONDS + 20))
while [[ \$SECONDS -lt \$deadline ]]; do
  if curl -fsS "http://127.0.0.1:\$port/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
if ! curl -fsS "http://127.0.0.1:\$port/api/health" >/dev/null 2>&1; then
  echo "LaunchAgent did not become healthy; starting AgentHero directly."
  (
    cd "\$install_dir"
    export AGENTHERO_INSTALL_MODE="installed"
    export AGENTHERO_UPDATE_MANIFEST_URL="\$manifest_url"
    export HOST="127.0.0.1"
    export PORT="\$port"
    nohup "\$node_path" "\$install_dir/server/dist/index.js" >> "\$log_dir/agent-hero.out.log" 2>> "\$log_dir/agent-hero.err.log" &
  )
  deadline=\$((SECONDS + 20))
  while [[ \$SECONDS -lt \$deadline ]]; do
    if curl -fsS "http://127.0.0.1:\$port/api/health" >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
fi
open "http://127.0.0.1:\$port"
APP_SCRIPT
chmod +x "$app_bundle_path/Contents/MacOS/AgentHero"

if [[ "$no_start" != "1" ]]; then
  launchctl bootout "gui/$UID" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$plist_path"
  launchctl kickstart -k "gui/$UID/$label"
fi

echo "AgentHero installed to $install_dir"
echo "Application launcher: $app_bundle_path"
echo "LaunchAgent: $plist_path"
echo "Version: $version"
echo "Open http://127.0.0.1:$port"
