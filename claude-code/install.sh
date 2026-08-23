#!/usr/bin/env bash
# install.sh — install the realistic-cost Claude Code integration.
#
# Builds the package, links the CLI globally, and wires the statusline +
# print-cost hook + skill into ~/.claude/. Re-runnable; overwrites prior installs.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

echo "▸ Building realistic-cost..."
cd "$REPO_DIR"
npm install --silent
npm run build --silent

echo "▸ Linking CLI globally..."
if command -v npm >/dev/null 2>&1; then
  npm link --silent 2>/dev/null || npm install -g . --silent
fi

echo "▸ Installing Claude Code integration into $CLAUDE_DIR ..."
mkdir -p "$CLAUDE_DIR/skills"
cp "$REPO_DIR/claude-code/statusline.sh" "$CLAUDE_DIR/statusline.sh"
chmod +x "$CLAUDE_DIR/statusline.sh"
cp "$REPO_DIR/claude-code/print-cost.sh" "$CLAUDE_DIR/print-cost.sh"
chmod +x "$CLAUDE_DIR/print-cost.sh"
cp -R "$REPO_DIR/claude-code/skills/realistic-cost" "$CLAUDE_DIR/skills/realistic-cost"

# Merge statusLine + Stop hook config into settings.json (create if absent).
# A one-time backup of the pre-install settings is kept alongside it.
SETTINGS="$CLAUDE_DIR/settings.json"
if [ ! -f "$SETTINGS" ]; then
  cp "$REPO_DIR/claude-code/settings.example.json" "$SETTINGS"
  echo "  created $SETTINGS"
else
  if command -v node >/dev/null 2>&1; then
    if [ ! -f "$CLAUDE_DIR/settings.json.bak-realistic-cost" ]; then
      cp "$SETTINGS" "$CLAUDE_DIR/settings.json.bak-realistic-cost"
      echo "  backed up original settings to $CLAUDE_DIR/settings.json.bak-realistic-cost"
    fi
    node -e "
      const fs = require('fs');
      const p = process.argv[1];
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      s.statusLine = { type: 'command', command: '~/.claude/statusline.sh', padding: 2 };
      s.hooks = s.hooks || {};
      s.hooks.Stop = [{ matcher: '', hooks: [{ type: 'command', command: '~/.claude/print-cost.sh' }] }];
      s.permissions = s.permissions || {};
      s.permissions.allow = Array.from(new Set([...(s.permissions.allow||[]), 'Bash(realistic-cost:*)', 'Bash(~/.claude/statusline.sh:*)', 'Bash(~/.claude/print-cost.sh:*)']));
      fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
    " "$SETTINGS"
    echo "  updated $SETTINGS (statusLine + Stop hook + permissions)"
  else
    echo "  ! node not found — please add the statusLine key to $SETTINGS manually"
  fi
fi

echo "✓ Done. Restart Claude Code (or open a new session) to see the status line."
echo "  • Bottom bar shows live cost (statusline.sh)"
echo "  • Pre-AI cost prints to terminal after each assistant turn (print-cost.sh)"
echo "  Try: /realistic-cost        (full receipt)"
echo "       /realistic-cost export pdf"
