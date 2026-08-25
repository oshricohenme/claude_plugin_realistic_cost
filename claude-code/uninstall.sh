#!/usr/bin/env bash
# uninstall.sh — remove the realistic-cost Claude Code integration.
#
# Reverses install.sh: removes statusline.sh, print-cost.sh and the skill from
# ~/.claude/, restores whatever statusLine you had before installing, removes
# only our Stop-hook entry (leaving your other hooks intact), drops our
# permission entries, and unlinks the global CLI.
#
# Re-runnable; exits cleanly if nothing is installed.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

echo "▸ Removing files from $CLAUDE_DIR ..."
rm -f "$CLAUDE_DIR/statusline.sh" "$CLAUDE_DIR/print-cost.sh"
rm -rf "$CLAUDE_DIR/skills/realistic-cost"
c_green "  ✓ statusline.sh, print-cost.sh, skills/realistic-cost removed"

# Per-session Stop-hook counters (see print-cost.sh).
rm -f "${TMPDIR:-/tmp}"/realistic-cost-stop-* 2>/dev/null || true
rm -f "${TMPDIR:-/tmp}"/realistic-cost-cache-*.json 2>/dev/null || true
c_green "  ✓ temp counters and parse cache cleared"

if [ -f "$CLAUDE_DIR/settings.json" ]; then
  if command -v node >/dev/null 2>&1; then
    echo "▸ Updating $CLAUDE_DIR/settings.json ..."
    node "$REPO_DIR/claude-code/configure-settings.mjs" uninstall "$CLAUDE_DIR/settings.json"
    c_green "  ✓ settings.json cleaned"
  else
    c_yellow "  ! node not found — remove the statusLine and hooks.Stop entries from settings.json manually"
  fi
fi

echo "▸ Unlinking global CLI ..."
if command -v npm >/dev/null 2>&1; then
  ( cd "$REPO_DIR" && npm unlink --silent 2>/dev/null ) || \
    npm rm -g realistic-cost --silent 2>/dev/null || true
fi
if command -v realistic-cost >/dev/null 2>&1; then
  c_yellow "  ! realistic-cost is still on PATH ($(command -v realistic-cost)) — remove it manually if it came from elsewhere"
else
  c_green "  ✓ realistic-cost unlinked"
fi

echo "✓ Uninstalled. Restart Claude Code for the change to take effect."
echo "  (opencode integration, if installed, is removed separately: opencode plugin remove \"$REPO_DIR/opencode\")"
