#!/usr/bin/env bash
# Stops and removes the LaunchAgent. Config, logs and review state are left in place.
set -euo pipefail

LABEL="${REVIEW_AUTOMATOR_LABEL:-com.github.review-automator}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
if [[ -f "$PLIST" ]]; then
  mv "$PLIST" "$PLIST.removed"
  echo "unloaded $LABEL; plist moved to $PLIST.removed"
else
  echo "unloaded $LABEL (no plist at $PLIST)"
fi
