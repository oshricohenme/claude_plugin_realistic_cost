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

# 1. Global install on PATH (preferred)
if command -v realistic-cost >/dev/null 2>&1; then
  exec realistic-cost status
fi

# 2. Local user bin
if [ -x "$HOME/.local/bin/realistic-cost" ]; then
  exec "$HOME/.local/bin/realistic-cost" status
fi

# 3. Repo-local dev build (when run from a clone of this repo)
RC_DEV="${RC_DEV:-}"
if [ -z "$RC_DEV" ] && [ -f "$PWD/node_modules/.bin/realistic-cost" ]; then
  RC_DEV="$PWD/node_modules/.bin/realistic-cost"
fi
if [ -z "$RC_DEV" ] && [ -x "$PWD/dist/bin/realistic-cost.js" ]; then
  RC_DEV="node $PWD/dist/bin/realistic-cost.js"
fi
if [ -n "$RC_DEV" ]; then
  exec $RC_DEV status
fi

# 4. Last resort: npx (adds latency on first run)
if command -v npx >/dev/null 2>&1; then
  npx --yes realistic-cost status 2>/dev/null
fi

# If nothing worked, print nothing — Claude Code shows its default footer.
