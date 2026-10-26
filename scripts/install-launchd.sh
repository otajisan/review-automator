#!/usr/bin/env bash
# Installs review-automator as a per-user LaunchAgent and starts it.
# Re-run after `git pull && pnpm build` to restart with the new build.
set -euo pipefail

LABEL="${REVIEW_AUTOMATOR_LABEL:-com.github.review-automator}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$APP_DIR/launchd/com.github.review-automator.plist.template"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/review-automator"
DOMAIN="gui/$(id -u)"

die() { echo "error: $*" >&2; exit 1; }

[[ "$(uname -s)" == "Darwin" ]] || die "launchd is macOS only"
[[ -f "$APP_DIR/dist/index.js" ]] || die "dist/index.js not found; run: pnpm install && pnpm build"
command -v node >/dev/null || die "node not found in PATH"
command -v gh >/dev/null || die "gh not found in PATH (https://cli.github.com)"
command -v git >/dev/null || die "git not found in PATH"

# Resolve the real node binary so version-manager shims (volta, mise, nvm) are not needed at runtime.
NODE_BIN="$(node -p 'process.execPath')"

# launchd starts with a minimal environment. Keep the current PATH so `gh`, `git` and any tools your
# skills call resolve the same way they do in your terminal.
RUNTIME_PATH="$(dirname "$NODE_BIN"):$PATH"

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }
sed_escape() { sed -e 's/[\\|&]/\\&/g' <<<"$1"; }
fill() { sed_escape "$(xml_escape "$1")"; }

mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
sed \
  -e "s|__LABEL__|$(fill "$LABEL")|g" \
  -e "s|__NODE__|$(fill "$NODE_BIN")|g" \
  -e "s|__APP_DIR__|$(fill "$APP_DIR")|g" \
  -e "s|__PATH__|$(fill "$RUNTIME_PATH")|g" \
  -e "s|__HOME__|$(fill "$HOME")|g" \
  -e "s|__LOG_DIR__|$(fill "$LOG_DIR")|g" \
  "$TEMPLATE" >"$PLIST.tmp"
# Carry over settings that choose which config to load; otherwise the daemon silently falls back
# to the default location. plutil does the XML escaping.
for var in REVIEW_AUTOMATOR_CONFIG REVIEW_AUTOMATOR_ENV XDG_CONFIG_HOME LOG_LEVEL; do
  if [[ -n "${!var:-}" ]]; then
    plutil -replace "EnvironmentVariables.$var" -string "${!var}" "$PLIST.tmp"
    echo "keeping $var=${!var}"
  fi
done
plutil -lint "$PLIST.tmp" >/dev/null || die "generated plist is invalid: $PLIST.tmp"
mv "$PLIST.tmp" "$PLIST"
chmod 644 "$PLIST"

# Replace a previously loaded copy, if any. bootout returns before the job is gone, and
# bootstrapping while it still exists fails with "Input/output error", so wait for it.
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 60); do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 0.5
  done
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && die "the previous $LABEL did not stop; try again"
fi
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

echo "installed: $PLIST"
echo "logs:      $LOG_DIR/review-automator.log (stderr: review-automator.err.log)"
echo "status:    launchctl print $DOMAIN/$LABEL | head -20"
