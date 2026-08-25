#!/usr/bin/env bash
# dev.sh — run realistic-cost against a live harness for local development.
#
# Usage:
#   ./dev.sh                    # Claude Code dev mode (default)
#   ./dev.sh claude             # same, explicit
#   ./dev.sh opencode           # opencode dev mode
#   ./dev.sh -- <args>          # forward extra args to the harness
#   ./dev.sh --clean            # unregister both targets
#   ./dev.sh opencode --clean   # unregister one target
#
# Both targets build dist/ and `npm link` the CLI so `realistic-cost` on PATH
# resolves to this repo. Neither copies files: the harness runs the scripts and
# skill straight out of the working tree, so edits are live on next launch.
#
# Claude Code dev mode is deliberately NON-DESTRUCTIVE — unlike
# claude-code/install.sh it never writes to ~/.claude/settings.json. It
# generates a throwaway settings file in .dev/ and passes it via
# `claude --settings`, and symlinks the skill into this repo's .claude/skills/
# as a project-level skill. Your global config is untouched.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"
SKILL_LINK="$OPENCODE_DIR/skills/realistic-cost"

DEV_DIR="$REPO_DIR/.dev"
CC_SETTINGS="$DEV_DIR/claude-settings.json"
CC_SKILL_LINK="$REPO_DIR/.claude/skills/realistic-cost"

c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
c_bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }
c_yellow(){ printf '\033[33m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }

# ───────────────────────── arg parsing ─────────────────────────

TARGET=""
DO_CLEAN=0
PASSTHRU=()

while [ $# -gt 0 ]; do
  case "$1" in
    claude|claude-code|cc)   TARGET="claude"; shift ;;
    opencode|oc)             TARGET="opencode"; shift ;;
    --clean|clean)           DO_CLEAN=1; shift ;;
    --)                      shift; PASSTHRU=("$@"); break ;;
    -h|--help)
      sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      c_red "Unknown argument: $1"
      c_dim  "Try: ./dev.sh --help"
      exit 1 ;;
  esac
done

# ───────────────────────── shared build ─────────────────────────

build_and_link() {
  c_cyan "▸ Building realistic-cost (npm install + build)..."
  ( cd "$REPO_DIR" && npm install --silent 2>/dev/null && npm run build --silent 2>/dev/null )
  c_green "  ✓ dist/ built"

  c_cyan "▸ Linking CLI globally..."
  ( cd "$REPO_DIR" && npm link --silent 2>/dev/null ) || true
  if command -v realistic-cost >/dev/null 2>&1; then
    c_green "  ✓ $(command -v realistic-cost)"
  else
    c_yellow "  ! not on PATH (check your npm global bin dir)"
    c_dim    "    harmless for ./dev.sh claude — RC_DEV points the harness at dist/ directly"
  fi
}

# ───────────────────────── Claude Code ─────────────────────────

clean_claude() {
  c_yellow "▸ Removing Claude Code dev registration..."
  rm -f  "$CC_SETTINGS"
  rm -rf "$CC_SKILL_LINK"
  rmdir "$DEV_DIR" 2>/dev/null || true
  rmdir "$REPO_DIR/.claude/skills" "$REPO_DIR/.claude" 2>/dev/null || true
  # Per-session Stop-hook counters written by print-cost.sh.
  rm -f /tmp/realistic-cost-stop-* 2>/dev/null || true
  c_green "  ✓ .dev/claude-settings.json + .claude/skills/realistic-cost removed"
  c_dim  "  (global ~/.claude was never modified by dev mode)"
}

run_claude() {
  if ! command -v claude >/dev/null 2>&1; then
    c_red "claude not on PATH — install Claude Code first."
    exit 1
  fi

  build_and_link

  # ── generate throwaway dev settings (statusline + Stop hook, repo paths) ──
  c_cyan "▸ Generating dev settings ..."
  mkdir -p "$DEV_DIR"
  if ! command -v node >/dev/null 2>&1; then
    c_red "node is required to generate $CC_SETTINGS"
    exit 1
  fi
  node -e '
    const fs = require("fs");
    const [out, repo] = process.argv.slice(1);
    const statusline = repo + "/claude-code/statusline.sh";
    const printcost  = repo + "/claude-code/print-cost.sh";
    fs.writeFileSync(out, JSON.stringify({
      $schema: "https://json.schemastore.org/claude-code-settings.json",
      statusLine: { type: "command", command: statusline, padding: 2 },
      hooks: {
        Stop: [{ matcher: "", hooks: [{ type: "command", command: printcost }] }],
      },
      permissions: {
        allow: [
          "Bash(realistic-cost:*)",
          `Bash(${statusline}:*)`,
          `Bash(${printcost}:*)`,
        ],
      },
    }, null, 2) + "\n");
  ' "$CC_SETTINGS" "$REPO_DIR"
  chmod +x "$REPO_DIR/claude-code/statusline.sh" "$REPO_DIR/claude-code/print-cost.sh"
  c_green "  ✓ $CC_SETTINGS (points at claude-code/*.sh in this repo)"

  # ── symlink skill as a project-level skill (live edits) ──
  c_cyan "▸ Symlinking skill into .claude/skills/ ..."
  mkdir -p "$REPO_DIR/.claude/skills"
  rm -rf "$CC_SKILL_LINK"
  ln -s "$REPO_DIR/claude-code/skills/realistic-cost" "$CC_SKILL_LINK"
  c_green "  ✓ .claude/skills/realistic-cost -> claude-code/skills/realistic-cost"

  echo
  c_bold "Launching claude in $REPO_DIR"
  c_dim  "  • bottom status bar shows the live human-cost line"
  c_dim  "  • Pre-AI cost prints to the terminal every 5 assistant turns"
  c_dim  "  • /realistic-cost opens the full receipt"
  c_dim  "  • edit claude-code/statusline.sh, print-cost.sh or SKILL.md, then"
  c_dim  "    restart claude — no reinstall needed"
  c_dim  "  • rebuild the CLI after editing src/: npm run build"
  c_dim  "  • run: ./dev.sh --clean   to remove dev artifacts"
  echo

  # Force the statusline + Stop hook onto this working tree's build, even if a
  # globally installed realistic-cost is also on PATH.
  export RC_DEV="node $REPO_DIR/dist/bin/realistic-cost.js"

  cd "$REPO_DIR"
  exec claude --settings "$CC_SETTINGS" ${PASSTHRU[@]+"${PASSTHRU[@]}"}
}

# ───────────────────────── opencode ─────────────────────────

clean_opencode() {
  c_yellow "▸ Removing opencode dev registration..."
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
  c_green "  ✓ cleaned."
}

run_opencode() {
  build_and_link

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
  c_dim  "  • run: ./dev.sh opencode --clean  to unregister + remove symlinks"
  echo

  cd "$REPO_DIR"
  exec opencode ${PASSTHRU[@]+"${PASSTHRU[@]}"}
}

# ───────────────────────── main ─────────────────────────

if [ "$DO_CLEAN" -eq 1 ]; then
  case "$TARGET" in
    claude)   clean_claude ;;
    opencode) clean_opencode ;;
    *)        clean_claude; clean_opencode ;;   # no target: clean both
  esac
  exit 0
fi

case "${TARGET:-claude}" in
  claude)   run_claude ;;
  opencode) run_opencode ;;
esac
