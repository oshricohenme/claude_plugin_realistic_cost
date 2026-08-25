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
# Parsed with node when available (the payload is JSON and sed is not a JSON
# parser); sed is the fallback so the hook still works without node.
SESSION_KEY=""
if command -v node >/dev/null 2>&1; then
  SESSION_KEY="$(printf '%s' "$INPUT" | node -e '
    let s = ""
    process.stdin.on("data", (c) => (s += c))
    process.stdin.on("end", () => {
      try {
        const j = JSON.parse(s)
        process.stdout.write(String(j.session_id ?? j.transcript_path ?? ""))
      } catch { /* not JSON — fall back below */ }
    })
  ' 2>/dev/null || true)"
fi
if [ -z "$SESSION_KEY" ]; then
  SESSION_KEY="$(printf '%s' "$INPUT" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
fi
if [ -z "$SESSION_KEY" ]; then
  SESSION_KEY="default"
fi
# Sanitize for use in a filename (shell-safe, no slashes/spaces).
SAFE_KEY="$(printf '%s' "$SESSION_KEY" | tr -cd 'a-zA-Z0-9._-' | cut -c 1-64)"
[ -n "$SAFE_KEY" ] || SAFE_KEY="default"

# Counters live in a private per-user directory, not directly in a shared
# world-writable /tmp: a predictable path there lets another local user
# pre-create the name as a symlink and redirect our write.
STATE_DIR="${XDG_STATE_HOME:-${TMPDIR:-/tmp}}/realistic-cost-$(id -u)"
mkdir -p "$STATE_DIR" 2>/dev/null || true
chmod 700 "$STATE_DIR" 2>/dev/null || true
COUNTER_FILE="$STATE_DIR/stop-${SAFE_KEY}"

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

# Resolve the realistic-cost binary from the usual global install locations.
RC_BIN=""
RC_ARGS=()
if command -v realistic-cost >/dev/null 2>&1; then
  RC_BIN="realistic-cost"
elif [ -x "$HOME/.npm-global/bin/realistic-cost" ]; then
  RC_BIN="$HOME/.npm-global/bin/realistic-cost"
elif [ -x "$HOME/.claude/realistic-cost" ]; then
  RC_BIN="$HOME/.claude/realistic-cost"
elif [ -x "$HOME/.local/bin/realistic-cost" ]; then
  RC_BIN="$HOME/.local/bin/realistic-cost"
elif [ -n "${CLAUDE_PLUGIN_ROOT:-}" ] \
  && [ -f "$CLAUDE_PLUGIN_ROOT/dist/bin/realistic-cost.js" ] \
  && command -v node >/dev/null 2>&1; then
  # Installed as a Claude Code plugin from a source that ships a build
  # (npm tarball, or a clone that has been built).
  RC_BIN="node"
  RC_ARGS=("$CLAUDE_PLUGIN_ROOT/dist/bin/realistic-cost.js")
fi

# Forward the captured hook payload to the CLI; it reads the JSON, extracts
# transcript_path, parses the transcript, and prints the status line.
# No npx fallback on purpose: a hook that runs every few turns must not
# resolve a package from the registry.
#
# If the CLI is not installed, say so exactly once per session rather than
# failing silently — a plugin that quietly does nothing is worse than one that
# tells you the single command that fixes it.
if [ -z "$RC_BIN" ]; then
  HINT_FILE="$STATE_DIR/hint-${SAFE_KEY}"
  if [ ! -f "$HINT_FILE" ]; then
    : > "$HINT_FILE" 2>/dev/null || true
    printf '%s\n' "realistic-cost: CLI not found — run 'npm install -g pre_ai_dev_cost_receipt' to enable the cost receipt."
  fi
  exit 0
fi
OUTPUT="$(printf '%s' "$INPUT" | "$RC_BIN" "${RC_ARGS[@]+"${RC_ARGS[@]}"}" status 2>/dev/null)" || true

if [ -n "$OUTPUT" ]; then
  printf '%s\n' "$OUTPUT"
fi
