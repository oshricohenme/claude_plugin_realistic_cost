#!/usr/bin/env bash
# install.sh — install the realistic-cost Claude Code integration.
#
# Builds the package, links the CLI globally, and wires the statusline +
# print-cost hook + skill into ~/.claude/.
#
# Safe to re-run: files are replaced (not nested), settings.json is backed up
# on every run, and the Stop hook is merged alongside any hooks you already
# have rather than replacing them.
#
# Flags:
#   --with-permissions   also allow-list realistic-cost commands in settings.json
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"

WITH_PERMISSIONS=""
for arg in "$@"; do
  case "$arg" in
    --with-permissions) WITH_PERMISSIONS="--with-permissions" ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "! node is required (>= 20.6) but was not found on PATH" >&2
  exit 1
fi

echo "▸ Building realistic-cost..."
cd "$REPO_DIR"
npm install --silent
npm run build --silent

echo "▸ Linking CLI globally..."
npm link --silent 2>/dev/null || npm install -g . --silent

echo "▸ Installing Claude Code integration into $CLAUDE_DIR ..."
mkdir -p "$CLAUDE_DIR/skills"
install -m 0755 "$REPO_DIR/claude-code/statusline.sh" "$CLAUDE_DIR/statusline.sh"
install -m 0755 "$REPO_DIR/claude-code/print-cost.sh" "$CLAUDE_DIR/print-cost.sh"
# rm first: `cp -R src dst` nests into dst when dst already exists, which on a
# second run produces skills/realistic-cost/realistic-cost/SKILL.md.
rm -rf "$CLAUDE_DIR/skills/realistic-cost"
cp -R "$REPO_DIR/claude-code/skills/realistic-cost" "$CLAUDE_DIR/skills/realistic-cost"

echo "▸ Updating $CLAUDE_DIR/settings.json ..."
node "$REPO_DIR/claude-code/configure-settings.mjs" install \
  "$CLAUDE_DIR/settings.json" $WITH_PERMISSIONS

echo "✓ Done. Restart Claude Code (or open a new session) to see the status line."
echo "  • Bottom bar shows live cost (statusline.sh)"
echo "  • Pre-AI cost prints to the terminal every 5th assistant turn (print-cost.sh)"
echo "  Try: /realistic-cost        (full receipt)"
echo "       /realistic-cost export pdf"
