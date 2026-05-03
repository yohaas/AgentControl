#!/usr/bin/env bash
set -euo pipefail

label="${1:-com.agenthero}"
port="${2:-4317}"
user_name="$(id -un)"
user_home="$HOME"
install_dir="$user_home/Applications/AgentHero"
user_app="$user_home/Applications/AgentHero.app"
system_app="/Applications/AgentHero.app"
state_dir="$user_home/Library/Application Support/AgentHero"
log_dir="$user_home/Library/Logs/AgentHero"
plist_path="$user_home/Library/LaunchAgents/$label.plist"

mkdir -p "$log_dir" "$user_home/Applications" "$user_home/Library/LaunchAgents"

for path in "$install_dir" "$user_app" "$state_dir" "$log_dir" "$plist_path"; do
  if [[ -e "$path" ]]; then
    sudo chown -R "$user_name":staff "$path"
  fi
done

if [[ -d "$user_app" ]]; then
  sudo rm -rf "$system_app"
  sudo cp -R "$user_app" "$system_app"
  sudo chown -R "$user_name":staff "$system_app"
  echo "Copied launcher to $system_app"
else
  echo "User launcher not found at $user_app" >&2
fi

if [[ -f "$plist_path" ]]; then
  launchctl bootout "gui/$UID" "$plist_path" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID" "$plist_path"
  launchctl kickstart -kp "gui/$UID/$label" >/dev/null 2>&1 || true
fi

deadline=$((SECONDS + 30))
while [[ $SECONDS -lt $deadline ]]; do
  if curl -fsS "http://127.0.0.1:$port/api/health" >/dev/null 2>&1; then
    echo "AgentHero is running at http://127.0.0.1:$port"
    exit 0
  fi
  sleep 1
done

echo "AgentHero did not become healthy. Check $log_dir/agent-hero.err.log and $log_dir/launcher.log" >&2
exit 1
