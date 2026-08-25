#!/usr/bin/env bash
# setup.sh — install realistic-cost into Claude Code and/or opencode.
#
# Interactive: asks which target(s) before touching anything. Re-runnable;
# overwrites prior installs. Run from anywhere — it locates its own repo dir.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"

ASSUME_YES=0
TARGET=""
WITH_PERMISSIONS=""

usage() {
  cat <<'USAGE'
usage: ./setup.sh [options]

  --target <claude-code|opencode|both>  what to install (skips the menu)
  --yes                                 don't prompt; requires --target
  --with-permissions                    allow-list realistic-cost commands in
                                        ~/.claude/settings.json (opt-in)
  -h, --help                            show this help

With no options the script is interactive and confirms every step.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --with-permissions) WITH_PERMISSIONS="--with-permissions"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$ASSUME_YES" = "1" ] && [ -z "$TARGET" ]; then
  echo "--yes requires --target <claude-code|opencode|both>" >&2
  exit 2
fi

# ───────────────────────── helpers ─────────────────────────

c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
c_bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

# This script modifies files in your home directory, so it must never proceed
# on assumptions. If there is no terminal to ask (`curl | bash`, CI), we stop
# and tell the caller to use the non-interactive flags instead.
require_tty() {
  if [ ! -r /dev/tty ]; then
    c_red "No terminal available to confirm an interactive install."
    echo   "Re-run attached to a terminal, or use the non-interactive flags:"
    echo   "  ./setup.sh --target claude-code [--with-permissions] --yes"
    echo   "  ./setup.sh --target opencode --yes"
    echo   "  ./setup.sh --target both --yes"
    exit 1
  fi
}

confirm() {
  # confirm <prompt> [default(y|n)]
  local prompt="$1" default="${2:-y}" choice hint
  [ "$ASSUME_YES" = "1" ] && return 0
  require_tty
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  printf '\033[1m%s\033[0m %s ' "$prompt" "$hint"
  read -r choice </dev/tty || choice=""
  choice="${choice:-$default}"
  case "$choice" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

pick_target() {
  # echoes 1 (claude), 2 (opencode), 3 (both), or 4 (cancel)
  cat <<'MENU'

  Install realistic-cost for:
    1) Claude Code   (statusline + /realistic-cost skill + global CLI)
    2) opencode      (/realistic-cost skill + TUI sidebar + global CLI)
    3) Both          (recommended)
    4) Cancel
MENU
  local sel
  require_tty
  printf '\033[1m%s\033[0m ' 'Choose [1-4]'
  read -r sel </dev/tty || sel=""
  sel="${sel:-3}"
  echo "$sel"
}

# ───────────────────────── shared build ─────────────────────────

build_and_link() {
  c_cyan "▸ Building realistic-cost in $REPO_DIR ..."
  # Build errors are shown, not swallowed — a silent build failure here
  # surfaces much later as a confusing "not on PATH" warning.
  ( cd "$REPO_DIR" && npm install --silent && npm run build --silent )
  c_cyan "▸ Linking CLI globally (realistic-cost on PATH) ..."
  if command -v npm >/dev/null 2>&1; then
    ( cd "$REPO_DIR" && npm link --silent 2>/dev/null ) || npm install -g "$REPO_DIR" --silent 2>/dev/null || true
  fi
  if command -v realistic-cost >/dev/null 2>&1; then
    c_green "  ✓ realistic-cost -> $(command -v realistic-cost)"
  else
    c_yellow "  ! realistic-cost not on PATH yet; rerun this script or run: cd \"$REPO_DIR\" && npm link"
  fi
}

# ───────────────────────── Claude Code ─────────────────────────

install_claude_code() {
  c_cyan "▸ Installing Claude Code integration into $CLAUDE_DIR ..."
  mkdir -p "$CLAUDE_DIR/skills"
  install -m 0755 "$REPO_DIR/claude-code/statusline.sh" "$CLAUDE_DIR/statusline.sh"
  install -m 0755 "$REPO_DIR/claude-code/print-cost.sh" "$CLAUDE_DIR/print-cost.sh"
  # rm first: `cp -R src dst` nests into dst when dst exists, so a second run
  # would otherwise create skills/realistic-cost/realistic-cost/.
  rm -rf "$CLAUDE_DIR/skills/realistic-cost"
  cp -R "$REPO_DIR/claude-code/skills/realistic-cost" "$CLAUDE_DIR/skills/realistic-cost"
  c_green "  ✓ statusline.sh + print-cost.sh + skill installed"

  # configure-settings.mjs is the single implementation of the settings merge:
  # it backs up first, appends the Stop hook instead of replacing the array,
  # and remembers any statusLine it displaces so uninstall can restore it.
  c_cyan "▸ Updating $CLAUDE_DIR/settings.json ..."
  node "$REPO_DIR/claude-code/configure-settings.mjs" install \
    "$CLAUDE_DIR/settings.json" $WITH_PERMISSIONS
  c_green "  ✓ settings.json updated"
}

# ───────────────────────── opencode ─────────────────────────

install_opencode() {
  c_cyan "▸ Installing opencode skill + TUI sidebar plugin..."

  # Skill (slash command). rm first — see the note in install_claude_code.
  mkdir -p "$OPENCODE_DIR/skills"
  rm -rf "$OPENCODE_DIR/skills/realistic-cost"
  cp -R "$REPO_DIR/opencode/skills/realistic-cost" "$OPENCODE_DIR/skills/realistic-cost"
  c_green "  ✓ skill installed ($OPENCODE_DIR/skills/realistic-cost/SKILL.md)"

  # Install TUI plugin dependencies (@opentui/solid, solid-js) in opencode/
  # Without these, the .tsx can't resolve its JSX runtime and silently fails.
  c_cyan "▸ Installing TUI plugin dependencies..."
  if command -v bun >/dev/null 2>&1; then
    ( cd "$REPO_DIR/opencode" && bun install --silent 2>/dev/null )
    c_green "  ✓ dependencies installed in opencode/node_modules/"
  else
    c_yellow "  ! bun not found — run: cd \"$REPO_DIR/opencode\" && bun install"
  fi

  # TUI plugin — use `opencode plugin <path> --global` which writes to tui.json
  # (the correct mechanism; manual file: entries in opencode.json are ignored)
  c_cyan "▸ Registering TUI plugin via opencode plugin ..."
  if command -v opencode >/dev/null 2>&1; then
    opencode plugin "$REPO_DIR/opencode" --global --force </dev/null 2>&1 | sed 's/^/  /'
    c_green "  ✓ TUI plugin registered in $OPENCODE_DIR/tui.json"
  else
    c_yellow "  ! opencode not on PATH — run: opencode plugin \"$REPO_DIR/opencode\" --global"
  fi
  c_dim "  sidebar footer shows live cost; /realistic-cost opens full review dialog."
  c_dim "  restart opencode for the TUI plugin to load."
}

# ───────────────────────── main ─────────────────────────

step_header() {
  # step_header <n> <total> <title>
  echo
  c_cyan "■ Step $1/$2 — $3"
}

main() {
  c_bold "realistic-cost setup"
  c_dim  "repo: $REPO_DIR"
  echo

  local sel
  case "$TARGET" in
    claude-code|claude) sel=1 ;;
    opencode)           sel=2 ;;
    both)               sel=3 ;;
    "")                 sel="$(pick_target)" ;;
    *) c_red "Invalid --target: '$TARGET' (expected claude-code, opencode or both)"; exit 2 ;;
  esac
  echo

  case "$sel" in
    1|2|3) ;;                            # valid selection
    4)    c_yellow "Cancelled. Nothing was changed."; exit 0 ;;
    *)    c_red "Invalid choice: '$sel'"; exit 1 ;;
  esac

  # Plan summary so the user knows what they're confirming into.
  local total=1            # build is always step 1
  case "$sel" in 1|3) total=$((total+1));; esac   # +claude
  case "$sel" in 2|3) total=$((total+1));; esac   # +opencode
  c_bold "Plan: $total step(s) ahead — you'll confirm each before it runs."

  # Step numbers: build=1, claude=2, opencode=2 or 3.
  local oc_step=2
  case "$sel" in 1|3) oc_step=3;; esac

  # Step 1: build + link (shared prerequisite).
  step_header 1 "$total" "Build + link CLI"
  if confirm "Build realistic-cost and link it globally?" y; then
    build_and_link
  else
    c_yellow "  ! skipped build — downstream installs will use whatever is already linked."
  fi

  # Step 2: Claude Code (if selected).
  case "$sel" in
    1|3)
      step_header 2 "$total" "Claude Code"
      if confirm "Install into Claude Code ($CLAUDE_DIR)?" y; then
        install_claude_code
      else
        c_dim "  skipped Claude Code."
      fi
      ;;
  esac

  # Step $oc_step: opencode (if selected).
  case "$sel" in
    2|3)
      step_header "$oc_step" "$total" "opencode"
      if confirm "Install skill into opencode ($OPENCODE_DIR)?" y; then
        install_opencode
      else
        c_dim "  skipped opencode."
      fi
      ;;
  esac

  c_green "✓ setup complete."
  echo
  c_bold "Next:"
  case "$sel" in
    1|3) c_dim "  • Restart Claude Code (or open a new session) to see the status line." ;;
  esac
  case "$sel" in
    2|3) c_dim "  • Restart opencode (or start a new session) so the skill is discovered." ;;
  esac
  echo  "  • In either harness, run: /realistic-cost            (full review)"
  echo  "                          /realistic-cost export pdf    (export a PDF)"
  case "$sel" in
    2|3) c_dim "  • In opencode: the sidebar footer (right panel) shows live cost." ;;
  esac
}

main "$@"
