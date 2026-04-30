#!/usr/bin/env bash
set -Eeuo pipefail

SERVICE_NAME="${AGENTHERO_SERVICE_NAME:-${AGENTCONTROL_SERVICE_NAME:-AgentHero}}"
RESTART_COMMAND="${AGENTHERO_RESTART_COMMAND:-${AGENTCONTROL_RESTART_COMMAND:-}}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_PATH="${TMPDIR:-/tmp}/agent-hero-update.log"

log() {
  local message="$1"
  local timestamp
  timestamp="$(date '+%Y-%m-%d %H:%M:%S')"
  printf '[%s] %s\n' "$timestamp" "$message" | tee -a "$LOG_PATH"
}

run_step() {
  log ""
  log "> $*"
  "$@"
}

restart_service() {
  if [[ -n "$RESTART_COMMAND" ]]; then
    log ""
    log "> $RESTART_COMMAND"
    bash -lc "$RESTART_COMMAND"
    return 0
  fi

  if [[ "$(uname -s)" == "Darwin" ]]; then
    local launch_label="${AGENTHERO_LAUNCH_LABEL:-${AGENTCONTROL_LAUNCH_LABEL:-com.agenthero}}"
    if launchctl print "gui/$UID/$launch_label" >/dev/null 2>&1; then
      log ""
      log "> launchctl kickstart -k gui/$UID/$launch_label"
      launchctl kickstart -k "gui/$UID/$launch_label"
      return 0
    fi
    log "No launchd service found. Set AGENTHERO_LAUNCH_LABEL or AGENTHERO_RESTART_COMMAND to restart automatically."
    return 0
  fi

  if command -v systemctl >/dev/null 2>&1; then
    if systemctl --user status "$SERVICE_NAME" >/dev/null 2>&1; then
      log ""
      log "> systemctl --user restart $SERVICE_NAME"
      systemctl --user restart "$SERVICE_NAME"
      return 0
    fi
    if systemctl status "$SERVICE_NAME" >/dev/null 2>&1; then
      log ""
      log "> sudo systemctl restart $SERVICE_NAME"
      sudo systemctl restart "$SERVICE_NAME"
      return 0
    fi
  fi

  log "No service restart target found. Set AGENTHERO_RESTART_COMMAND to restart automatically."
}

cd "$REPO_ROOT"
log "AgentHero update started in $REPO_ROOT"

run_step git pull
run_step npm ci
run_step npm run build
restart_service

log ""
log "AgentHero update complete."
log "You may close this window. Please wait 30 seconds and refresh AgentHero."
log "Log written to $LOG_PATH"
