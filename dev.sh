#!/usr/bin/env bash
# dev.sh — wire realistic-cost into opencode for local development.
#
# Builds the CLI, registers the TUI plugin as a local file: package in
# opencode.json (so the TUI runtime loads it), symlinks the skill for live
# edits, then launches opencode in this repo.
#
# Re-runnable. Use `./dev.sh --clean` to unregister and remove symlinks.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"
SKILL_LINK="$OPENCODE_DIR/skills/realistic-cost"

c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
c_bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }

clean() {
  c_yellow "▸ Removing dev registration..."
  # Remove from tui.json (opencode plugin's registry)
  local tui_json="$OPENCODE_DIR/tui.json"
  if [ -f "$tui_json" ] && command -v node >/dev/null 2>&1; then
    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      const dir = process.argv[2];
      s.plugin = (s.plugin || []).filter(e => e !== dir);
      fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
      console.log("  removed " + dir + " from tui.json");
    ' "$tui_json" "$REPO_DIR/opencode"
  fi
  rm -rf "$SKILL_LINK"
  c_green "✓ cleaned."
  exit 0
}

if [ "${1:-}" = "--clean" ] || [ "${1:-}" = "clean" ]; then
  clean
fi

# ── build ──
c_cyan "▸ Building realistic-cost (npm install + build)..."
( cd "$REPO_DIR" && npm install --silent 2>/dev/null && npm run build --silent 2>/dev/null )
c_green "  ✓ dist/ built"

# ── link CLI globally so `realistic-cost` is on PATH ──
c_cyan "▸ Linking CLI globally..."
( cd "$REPO_DIR" && npm link --silent 2>/dev/null ) || true
if command -v realistic-cost >/dev/null 2>&1; then
  c_green "  ✓ $(command -v realistic-cost)"
else
  c_yellow "  ! not on PATH — use: node $REPO_DIR/dist/bin/realistic-cost.js"
fi

# ── install TUI plugin deps (required for JSX runtime) ──
c_cyan "▸ Installing TUI plugin dependencies (bun install)..."
if command -v bun >/dev/null 2>&1; then
  ( cd "$REPO_DIR/opencode" && bun install --silent 2>/dev/null )
  c_green "  ✓ opencode/node_modules/ ready"
else
  c_yellow "  ! bun not found — TUI plugin will fail to load. Install bun first."
fi

# ── register TUI plugin via opencode plugin (writes tui.json) ──
c_cyan "▸ Registering TUI plugin via opencode plugin ..."
if command -v opencode >/dev/null 2>&1; then
  opencode plugin "$REPO_DIR/opencode" --global --force </dev/null 2>&1 | sed 's/^/  /'
  c_green "  ✓ registered in $OPENCODE_DIR/tui.json"
else
  c_yellow "  ! opencode not on PATH — run: opencode plugin \"$REPO_DIR/opencode\" --global"
fi

# ── symlink skill (live edits) ──
c_cyan "▸ Symlinking skill into $OPENCODE_DIR/skills/ ..."
mkdir -p "$OPENCODE_DIR/skills"
rm -rf "$SKILL_LINK"
ln -s "$REPO_DIR/opencode/skills/realistic-cost" "$SKILL_LINK"
c_green "  ✓ $SKILL_LINK -> $REPO_DIR/opencode/skills/realistic-cost"

echo
c_bold "Launching opencode in $REPO_DIR"
c_dim  "  • sidebar_footer shows live human-cost line"
c_dim  "  • /realistic-cost opens the full review dialog"
c_dim  "  • edit the .tsx in opencode/plugins/, restart opencode, see changes"
c_dim  "  • run: ./dev.sh --clean  to unregister + remove symlinks"
echo

cd "$REPO_DIR"
exec opencode
