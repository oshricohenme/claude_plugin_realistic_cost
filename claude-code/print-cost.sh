#!/usr/bin/env bash
# print-cost.sh — prints Pre-AI cost line to the terminal every 5 assistant turns.
#
# Wired as a Claude Code Stop hook.  Claude Code pipes a JSON object on stdin
# that includes `session_id` / `transcript_path`.  We forward it to
# `realistic-cost status` which parses the transcript and prints the one-line
# cost summary.
#
# The every-5-turns counter is PER SESSION (keyed by session id / transcript
# path from stdin), so parallel sessions don't share or reset each other's
# counters.  The script is a no-op if realistic-cost is not installed.
set -euo pipefail

# ── Read the hook payload once; we forward it to the CLI afterwards ──
INPUT=""
if [ ! -t 0 ]; then
  INPUT="$(cat || true)"
fi

# ── Per-session key: session_id, else transcript_path, else "default" ──
SESSION_KEY="$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
if [ -z "$SESSION_KEY" ]; then
  SESSION_KEY="$(printf '%s' "$INPUT" | sed -n 's/.*"transcript_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi
if [ -z "$SESSION_KEY" ]; then
  SESSION_KEY="default"
fi
# Sanitize for use in a filename (shell-safe, no slashes/spaces).
SAFE_KEY="$(printf '%s' "$SESSION_KEY" | tr -cd 'a-zA-Z0-9._-' | cut -c 1-64)"
[ -n "$SAFE_KEY" ] || SAFE_KEY="default"
COUNTER_FILE="/tmp/realistic-cost-stop-${SAFE_KEY}"

# ── Counter: only print every 5th turn (validate before arithmetic) ──
COUNT=0
if [ -f "$COUNTER_FILE" ]; then
  RAW="$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)"
  case "$RAW" in
    ''|*[!0-9]*) COUNT=0 ;;
    *) COUNT="$RAW" ;;
  esac
fi
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"
if [ "$COUNT" -lt 5 ]; then
  exit 0
fi
# Reset counter
echo 0 > "$COUNTER_FILE"

# Resolve the realistic-cost binary (global install, local, or npx).
RC_BIN=""
if command -v realistic-cost >/dev/null 2>&1; then
  RC_BIN="realistic-cost"
elif [ -x "$HOME/.npm-global/bin/realistic-cost" ]; then
  RC_BIN="$HOME/.npm-global/bin/realistic-cost"
elif [ -x "$HOME/.claude/realistic-cost" ]; then
  RC_BIN="$HOME/.claude/realistic-cost"
fi

# Forward the captured hook payload to the CLI; it reads the JSON, extracts
# transcript_path, parses the transcript, and prints the status line.
if [ -n "$RC_BIN" ]; then
  OUTPUT="$(printf '%s' "$INPUT" | "$RC_BIN" status 2>/dev/null)" || true
else
  OUTPUT="$(printf '%s' "$INPUT" | npx --yes realistic-cost status 2>/dev/null)" || true
fi

if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
fi
