#!/usr/bin/env bash
# uninstall.sh — remove the realistic-cost Claude Code integration.
#
# Reverses install.sh: removes statusline.sh, print-cost.sh, and the skill
# from ~/.claude/, removes the statusLine / Stop-hook / permission entries
# from settings.json (backing it up first), and unlinks the global CLI.
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

SETTINGS="$CLAUDE_DIR/settings.json"
if [ -f "$SETTINGS" ]; then
  if command -v node >/dev/null 2>&1; then
    cp "$SETTINGS" "$SETTINGS.bak.$(date +%Y%m%d%H%M%S)"
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      delete s.statusLine;
      if (s.hooks?.Stop) {
        s.hooks.Stop = s.hooks.Stop.filter(
          (h) => !(h.hooks || []).some(
            (x) => typeof x.command === "string" && x.command.includes("print-cost.sh"),
          ),
        );
        if (s.hooks.Stop.length === 0) delete s.hooks.Stop;
        if (Object.keys(s.hooks).length === 0) delete s.hooks;
      }
      if (s.permissions?.allow) {
        s.permissions.allow = s.permissions.allow.filter(
          (a) => !["Bash(realistic-cost:*)", "Bash(~/.claude/statusline.sh:*)", "Bash(~/.claude/print-cost.sh:*)"].includes(a),
        );
        if (s.permissions.allow.length === 0) delete s.permissions.allow;
        if (Object.keys(s.permissions).length === 0) delete s.permissions;
      }
      fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
    ' "$SETTINGS"
    c_green "  ✓ settings.json cleaned (backup saved alongside)"
  else
    c_yellow "  ! node not found — remove the statusLine and hooks.Stop keys from $SETTINGS manually"
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
