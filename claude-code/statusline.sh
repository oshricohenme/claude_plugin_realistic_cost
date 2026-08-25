#!/usr/bin/env bash
# realistic-cost statusline for Claude Code.
#
# Claude Code pipes the status-line JSON payload to this script's stdin.
# This script forwards it to the `realistic-cost status` command, which parses
# the session transcript and prints a one-line human-team cost summary.
#
# Wiring (in ~/.claude/settings.json or .claude/settings.json):
#   { "statusLine": { "type": "command", "command": "~/.claude/statusline.sh", "padding": 2 } }
#
# Silently no-ops if the binary isn't installed (Claude Code tolerates empty
# output, so the built-in footer still renders).
#
# Deliberately does NOT fall back to `npx realistic-cost`: the status line
# re-runs on every UI refresh, and resolving a package from the registry in
# that loop would be both slow and a supply-chain risk. Install the CLI once
# (./claude-code/install.sh) instead.

# 1. Global install on PATH (preferred)
if command -v realistic-cost >/dev/null 2>&1; then
  exec realistic-cost status
fi

# 2. Local user bin
if [ -x "$HOME/.local/bin/realistic-cost" ]; then
  exec "$HOME/.local/bin/realistic-cost" status
fi

# 3. Repo-local dev build (when Claude Code is running inside a clone of this
#    repo). Paths are quoted so a checkout under a directory with spaces works.
if [ -x "$PWD/node_modules/.bin/realistic-cost" ]; then
  exec "$PWD/node_modules/.bin/realistic-cost" status
fi
if [ -f "$PWD/dist/bin/realistic-cost.js" ] && command -v node >/dev/null 2>&1; then
  exec node "$PWD/dist/bin/realistic-cost.js" status
fi

# Nothing installed: print nothing — Claude Code shows its default footer.
exit 0
