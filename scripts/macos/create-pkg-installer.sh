#!/usr/bin/env bash
set -euo pipefail

manifest_url=""
output_path=""
identifier="com.agenthero.installer"
label="com.agenthero"
port="4317"
install_dir=""
no_start="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-url) manifest_url="${2:-}"; shift 2 ;;
    --output-path) output_path="${2:-}"; shift 2 ;;
    --identifier) identifier="${2:-}"; shift 2 ;;
    --label) label="${2:-}"; shift 2 ;;
    --port) port="${2:-}"; shift 2 ;;
    --install-dir) install_dir="${2:-}"; shift 2 ;;
    --no-start) no_start="1"; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

[[ -n "$manifest_url" ]] || { echo "--manifest-url is required" >&2; exit 2; }
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS pkg installers must be built on macOS with pkgbuild." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
version="$(node -p "require('$repo_root/package.json').version")"
artifacts_dir="$repo_root/artifacts"
build_dir="$artifacts_dir/macos-pkg-build"
scripts_dir="$build_dir/scripts"
target_path="${output_path:-$artifacts_dir/AgentHeroSetup.pkg}"

rm -rf "$build_dir" "$target_path"
mkdir -p "$scripts_dir" "$(dirname "$target_path")"
cp "$repo_root/scripts/macos/install-agent-hero.sh" "$scripts_dir/install-agent-hero.sh"
chmod +x "$scripts_dir/install-agent-hero.sh"

installer_manifest_url="$manifest_url"
if [[ -f "$manifest_url" ]]; then
  manifest_path="$(cd "$(dirname "$manifest_url")" && pwd)/$(basename "$manifest_url")"
  cp "$manifest_path" "$scripts_dir/manifest.json"
  installer_manifest_url="\$SCRIPT_DIR/manifest.json"

  asset_url="$(node -e "const fs=require('fs'); const m=JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const a=(m.assets||[]).find((x)=>x.platform==='macos'); if(!a) process.exit(2); console.log(a.url);" "$manifest_path")" || {
    echo "Local manifest does not contain a macOS asset." >&2
    exit 1
  }
  if [[ "$asset_url" != http://* && "$asset_url" != https://* ]]; then
    asset_path="$(cd "$(dirname "$manifest_path")" && pwd)/$asset_url"
    [[ -f "$asset_path" ]] || { echo "Local asset not found: $asset_path" >&2; exit 1; }
    cp "$asset_path" "$scripts_dir/$(basename "$asset_path")"
  fi
fi

cat > "$scripts_dir/postinstall" <<SCRIPT
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
console_user="\$(stat -f %Su /dev/console)"
if [[ -z "\$console_user" || "\$console_user" == "root" ]]; then
  echo "AgentHero must be installed from a logged-in user session." >&2
  exit 1
fi
user_home="\$(dscl . -read "/Users/\$console_user" NFSHomeDirectory | awk '{print \$2}')"
args=(--manifest-url "$installer_manifest_url" --label "$label" --port "$port")
if [[ -n "$install_dir" ]]; then
  args+=(--install-dir "$install_dir")
fi
if [[ "$no_start" == "1" ]]; then
  args+=(--no-start)
fi

sudo -u "\$console_user" HOME="\$user_home" /bin/bash "\$SCRIPT_DIR/install-agent-hero.sh" "\${args[@]}"
SCRIPT
chmod +x "$scripts_dir/postinstall"

pkgbuild \
  --nopayload \
  --scripts "$scripts_dir" \
  --identifier "$identifier" \
  --version "$version" \
  "$target_path"

echo "Created $target_path"
