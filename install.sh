#!/usr/bin/env bash
#
#   realistic-cost — installer for Claude Code and opencode
#
# Works two ways, and figures out which on its own:
#
#   From anywhere, no clone:
#     curl -fsSL https://raw.githubusercontent.com/oshricohenme/claude_plugin_realistic_cost/main/install.sh | bash
#
#   From a clone (what you want when developing on it):
#     ./install.sh
#
# Interactive by default: it shows what it found, asks which harness to set up,
# and confirms every step before touching anything in your home directory.
#
# Environment overrides:
#   PREFIX        where the package lands, no-clone mode only
#                 (default ~/.local/share/realistic-cost)
#   BIN_DIR       where the `realistic-cost` symlink goes (default ~/.local/bin)
#   CLAUDE_DIR    Claude Code config dir (default ~/.claude)
#   OPENCODE_DIR  opencode config dir    (default ~/.config/opencode)
#   VERSION       npm version or tag     (default latest)
#   NO_COLOR      set to anything to disable colour

set -euo pipefail

PKG="pre_ai_dev_cost_receipt"
REPO_URL="https://github.com/oshricohenme/claude_plugin_realistic_cost"
VERSION="${VERSION:-latest}"
PREFIX="${PREFIX:-$HOME/.local/share/realistic-cost}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"

ASSUME_YES=0
TARGET=""
WITH_PERMISSIONS=""

# ═══════════════════════════════════════════════════════════════════════════
# Presentation
#
# Colour is opt-out (NO_COLOR), and is dropped automatically when stdout is not
# a terminal or the terminal reports fewer than 8 colours — installer output
# gets piped into logs and pasted into issues, and escape codes there are
# noise. Every colour helper degrades to plain text, so nothing below needs to
# care which mode it is in.
# ═══════════════════════════════════════════════════════════════════════════

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RESET=$'\033[0m'
  RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'
  BLUE=$'\033[34m'; CYAN=$'\033[36m'; GREY=$'\033[90m'
else
  BOLD=""; DIM=""; RESET=""
  RED=""; GREEN=""; YELLOW=""; BLUE=""; CYAN=""; GREY=""
fi

say()   { printf '%s\n' "$*"; }
dim()   { printf '%s%s%s\n' "$DIM" "$*" "$RESET"; }
bold()  { printf '%s%s%s\n' "$BOLD" "$*" "$RESET"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
info()  { printf '%s▸%s %s\n' "$CYAN" "$RESET" "$*"; }
fail()  { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
rule()  { printf '%s%s%s\n' "$GREY" "────────────────────────────────────────────────────────────" "$RESET"; }

banner() {
  printf '\n'
  printf '  %s%srealistic-cost%s  %s\n' "$BOLD" "$BLUE" "$RESET" "${DIM}installer${RESET}"
  printf '  %swhat a human engineering team would have charged for this%s\n\n' "$DIM" "$RESET"
}

# step <n> <total> <title>
step() {
  printf '\n%s%s[%s/%s]%s %s%s%s\n' "$BOLD" "$CYAN" "$1" "$2" "$RESET" "$BOLD" "$3" "$RESET"
  rule
}

# found <label> <value-or-empty> [note]
found() {
  if [ -n "$2" ]; then
    printf '  %s✓%s %-14s %s%s%s\n' "$GREEN" "$RESET" "$1" "$DIM" "$2" "$RESET"
  else
    printf '  %s·%s %-14s %s%s%s\n' "$GREY" "$RESET" "$1" "$DIM" "${3:-not found}" "$RESET"
  fi
}

usage() {
  cat <<USAGE
${BOLD}usage${RESET}  install.sh [options]

  --target <claude-code|opencode|both>  what to set up (skips the menu)
  --yes, -y                             don't prompt; requires --target
  --with-permissions                    allow-list realistic-cost commands in
                                        ~/.claude/settings.json (opt-in)
  -h, --help                            this help

With no options it is interactive and confirms every step.

${BOLD}examples${RESET}
  ./install.sh
  ./install.sh --target both --yes
  ./install.sh --target claude-code --with-permissions --yes
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET="${2:-}"; shift 2 ;;
    --target=*) TARGET="${1#*=}"; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --with-permissions) WITH_PERMISSIONS="--with-permissions"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) printf '%sunknown option:%s %s\n\n' "$RED" "$RESET" "$1" >&2; usage >&2; exit 2 ;;
  esac
done

# ═══════════════════════════════════════════════════════════════════════════
# Prompts
#
# This writes into your home directory, so it never proceeds on an assumption.
# `curl | bash` leaves stdin consumed by the script itself, so prompts read
# from /dev/tty; with no terminal at all we stop and name the flags instead.
# ═══════════════════════════════════════════════════════════════════════════

# Prompts read from fd 3, opened once from /dev/tty, rather than redirecting
# `</dev/tty` per read. bash reports a failed redirection on its own stderr
# BEFORE any 2>/dev/null on that command takes effect, so the per-read form
# leaks "Device not configured" into otherwise clean output. Opening once also
# means the "is there a terminal?" question is answered by actually opening it,
# not by a readability test that can pass on a tty which then returns EOF.
TTY_OPEN=0
open_tty() {
  [ "$TTY_OPEN" = "1" ] && return 0
  # The brace group is required: `exec 3</dev/tty 2>/dev/null` still leaks
  # "Device not configured", because bash reports a failed redirection before
  # applying the 2>/dev/null on the same command. Wrapping it puts the stderr
  # redirect in place first.
  if { exec 3</dev/tty; } 2>/dev/null; then TTY_OPEN=1; return 0; fi
  return 1
}

no_answer() {
  printf '\n'
  fail "no answer received — there is no terminal to ask.
    Re-run attached to one, or install without prompting:
      curl -fsSL $REPO_URL/raw/main/install.sh | bash -s -- --target both --yes"
}

require_tty() {
  open_tty || no_answer
}

# run_bounded <seconds> <command...>
#
# Nothing in an installer should be able to hang forever. `bun install` in the
# plugin directory can: its `file:..` self-dependency points at the package
# root, which contains the plugin directory again, and bun has been seen
# spinning on that layout for minutes. macOS has no timeout(1) by default, so
# this polls a background job instead of relying on one.
run_bounded() {
  local limit="$1"; shift
  "$@" &
  local pid=$! waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$limit" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid"
}

confirm() {
  local prompt="$1" default="${2:-y}" choice hint
  [ "$ASSUME_YES" = "1" ] && return 0
  require_tty
  if [ "$default" = "y" ]; then hint="${DIM}[Y/n]${RESET}"; else hint="${DIM}[y/N]${RESET}"; fi
  printf '  %s%s%s %s ' "$BOLD" "$prompt" "$RESET" "$hint"
  # A FAILED read is end-of-input, not consent. Treating it as "pressed Enter"
  # would take the default and install into someone's home directory unasked —
  # which is exactly what an earlier draft of this script did. An empty but
  # SUCCESSFUL read is a real Enter keypress, and does take the default.
  IFS= read -r choice <&3 || no_answer
  case "${choice:-$default}" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ═══════════════════════════════════════════════════════════════════════════
# Where the files come from
#
# Two sources, resolved automatically:
#   repo — this script sits in a checkout: build from source, link the CLI.
#   npm  — anything else (piped from curl): fetch the published package, which
#          ships the built engine, both harness integrations and the skills.
# The detection insists on BOTH a matching package.json and a src/ tree, so a
# stray copy of this script next to an unrelated package.json cannot make it
# try to build something that is not this project.
# ═══════════════════════════════════════════════════════════════════════════

SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

SOURCE_MODE="npm"
if [ -n "$SELF_DIR" ] && [ -d "$SELF_DIR/src" ] && [ -f "$SELF_DIR/package.json" ] &&
  grep -q "\"$PKG\"" "$SELF_DIR/package.json" 2>/dev/null; then
  SOURCE_MODE="repo"
fi

SRC=""   # set by prepare_source(); the tree we install FROM

prepare_source() {
  if [ "$SOURCE_MODE" = "repo" ]; then
    SRC="$SELF_DIR"
    info "Building from this checkout"
    dim  "  $SRC"
    # Build failures are shown, never swallowed: a silent one surfaces much
    # later as a baffling "realistic-cost not on PATH".
    ( cd "$SRC" && npm install --silent && npm run build --silent )
    ok "engine built"
  else
    SRC="$PREFIX/node_modules/$PKG"
    info "Fetching $PKG@$VERSION from npm"
    mkdir -p "$PREFIX"
    npm install --prefix "$PREFIX" --no-fund --no-audit --loglevel=error "$PKG@$VERSION"
    [ -f "$SRC/package.json" ] || fail "unexpected package layout — no $SRC/package.json"
    ok "installed to $PREFIX"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# Steps
# ═══════════════════════════════════════════════════════════════════════════

# The status line shells out to `realistic-cost` on every UI refresh, so the
# CLI has to be resolvable by name. BIN_DIR is used rather than a global npm
# install because it needs no sudo, and statusline.sh already looks there.
link_cli() {
  info "Putting realistic-cost on PATH"
  mkdir -p "$BIN_DIR"

  local linked=""
  if [ "$SOURCE_MODE" = "repo" ]; then
    if ( cd "$SRC" && npm link --silent >/dev/null 2>&1 ); then
      linked="$(command -v realistic-cost 2>/dev/null || true)"
    fi
  fi

  if [ -z "$linked" ] && [ -x "$PREFIX/node_modules/.bin/realistic-cost" ]; then
    ln -sf "$PREFIX/node_modules/.bin/realistic-cost" "$BIN_DIR/realistic-cost"
    linked="$BIN_DIR/realistic-cost"
  elif [ -z "$linked" ] && [ -f "$SRC/dist/bin/realistic-cost.js" ]; then
    chmod +x "$SRC/dist/bin/realistic-cost.js" 2>/dev/null || true
    ln -sf "$SRC/dist/bin/realistic-cost.js" "$BIN_DIR/realistic-cost"
    linked="$BIN_DIR/realistic-cost"
  fi

  if [ -n "$linked" ]; then
    ok "realistic-cost → $linked"
    case ":$PATH:" in
      *":$BIN_DIR:"*) ;;
      *) warn "$BIN_DIR is not on your PATH — the status line still works, but
    add it if you want to run realistic-cost yourself." ;;
    esac
  else
    warn "could not link the CLI; the status line will fall back to its own lookup"
  fi
}

install_claude_code() {
  info "Wiring up Claude Code in $CLAUDE_DIR"
  mkdir -p "$CLAUDE_DIR/skills"
  install -m 0755 "$SRC/claude-code/statusline.sh" "$CLAUDE_DIR/statusline.sh"
  install -m 0755 "$SRC/claude-code/print-cost.sh" "$CLAUDE_DIR/print-cost.sh"
  # rm first: `cp -R src dst` nests into dst when dst exists, so a second run
  # would otherwise produce skills/realistic-cost/realistic-cost/.
  rm -rf "$CLAUDE_DIR/skills/realistic-cost"
  cp -R "$SRC/claude-code/skills/realistic-cost" "$CLAUDE_DIR/skills/realistic-cost"
  ok "status line, Stop hook and /realistic-cost skill installed"

  # configure-settings.mjs is the single implementation of the settings merge:
  # it backs up first, appends the Stop hook rather than replacing the array,
  # and remembers any statusLine it displaces so uninstall can restore it.
  info "Merging into $CLAUDE_DIR/settings.json"
  # shellcheck disable=SC2086 # deliberate: empty means "no flag"
  node "$SRC/claude-code/configure-settings.mjs" install \
    "$CLAUDE_DIR/settings.json" $WITH_PERMISSIONS
  ok "settings.json updated (a backup was taken first)"
}

install_opencode() {
  info "Installing the /realistic-cost skill"
  mkdir -p "$OPENCODE_DIR/skills"
  rm -rf "$OPENCODE_DIR/skills/realistic-cost"
  cp -R "$SRC/opencode/skills/realistic-cost" "$OPENCODE_DIR/skills/realistic-cost"
  ok "$OPENCODE_DIR/skills/realistic-cost"

  # The TUI plugin imports @opentui/solid and solid-js directly. bun is what
  # opencode loads plugins with, and it is often installed without being on
  # PATH, so check its usual home before falling back to npm.
  info "Installing TUI plugin dependencies"
  local bun=""
  if command -v bun >/dev/null 2>&1; then bun="bun"
  elif [ -x "$HOME/.bun/bin/bun" ]; then bun="$HOME/.bun/bin/bun"
  fi
  if [ -n "$bun" ]; then
    # A stale self-link from a previous run is one of the shapes bun spins on,
    # so start from a clean tree.
    rm -rf "$SRC/opencode/node_modules"
    if run_bounded 180 env -C "$SRC/opencode" "$bun" install --silent; then
      ok "via bun"
    else
      warn "bun install did not finish within 3 minutes — falling back to npm."
      dim  "    (bun can spin on this package's file:.. self-reference.)"
      rm -rf "$SRC/opencode/node_modules"
      ( cd "$SRC/opencode" && npm install --no-fund --no-audit --loglevel=error )
      ok "via npm"
    fi
  else
    ( cd "$SRC/opencode" && npm install --no-fund --no-audit --loglevel=error )
    ok "via npm"
    dim "    bun not found. npm works here because opencode supplies @opentui"
    dim "    and solid-js at runtime — but if the sidebar never appears,"
    dim "    install bun (https://bun.sh) and re-run this."
  fi

  # `opencode plugin <path> --global` writes tui.json itself. A hand-written
  # `file:` entry in opencode.json is ignored, so this is the only mechanism
  # that actually registers a TUI plugin.
  info "Registering the TUI plugin"
  if command -v opencode >/dev/null 2>&1; then
    opencode plugin "$SRC/opencode" --global --force </dev/null >/dev/null 2>&1
    ok "registered in $OPENCODE_DIR/tui.json"
  else
    warn "opencode is not on PATH — finish with:"
    say  "      opencode plugin \"$SRC/opencode\" --global"
  fi
}

# ═══════════════════════════════════════════════════════════════════════════
# Main
# ═══════════════════════════════════════════════════════════════════════════

banner

# ── What is on this machine ────────────────────────────────────────────────
NODE_V="$(node --version 2>/dev/null || true)"
NPM_V="$(npm --version 2>/dev/null || true)"
BUN_V="$(bun --version 2>/dev/null || { [ -x "$HOME/.bun/bin/bun" ] && "$HOME/.bun/bin/bun" --version; } 2>/dev/null || true)"
HAS_CLAUDE="$(command -v claude 2>/dev/null || { [ -d "$CLAUDE_DIR" ] && echo "$CLAUDE_DIR"; } || true)"
HAS_OPENCODE="$(command -v opencode 2>/dev/null || { [ -d "$OPENCODE_DIR" ] && echo "$OPENCODE_DIR"; } || true)"

bold "  Environment"
rule
found "node"      "$NODE_V"       "required — https://nodejs.org"
found "npm"       "$NPM_V"        "required — ships with node"
found "bun"       "$BUN_V"        "optional — only for the opencode plugin"
found "Claude Code" "$HAS_CLAUDE" "not detected"
found "opencode"  "$HAS_OPENCODE" "not detected"
found "source"    "$([ "$SOURCE_MODE" = repo ] && echo "local checkout" || echo "npm ($PKG@$VERSION)")"

[ -n "$NODE_V" ] || fail "node is required (>= 20.6) — https://nodejs.org"
[ -n "$NPM_V" ]  || fail "npm is required — it ships with node"

if [ "$ASSUME_YES" = "1" ] && [ -z "$TARGET" ]; then
  fail "--yes requires --target <claude-code|opencode|both>"
fi

# ── Which harness ──────────────────────────────────────────────────────────
case "$TARGET" in
  claude-code|claude) SEL=1 ;;
  opencode)           SEL=2 ;;
  both)               SEL=3 ;;
  "")
    printf '\n'
    bold "  Set up for"
    rule
    printf '    %s1%s  Claude Code   %sstatus line, Stop hook, /realistic-cost%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
    printf '    %s2%s  opencode      %ssidebar footer, /realistic-cost dialog%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
    printf '    %s3%s  Both          %s(recommended)%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
    printf '    %s4%s  Cancel\n\n' "$BOLD" "$RESET"
    require_tty
    printf '  %sChoose [1-4]%s %s[3]%s ' "$BOLD" "$RESET" "$DIM" "$RESET"
    # See the note in confirm(): EOF is not an answer.
    IFS= read -r SEL <&3 || no_answer
    SEL="${SEL:-3}"
    ;;
  *) fail "invalid --target: '$TARGET' (expected claude-code, opencode or both)" ;;
esac

case "$SEL" in
  1|2|3) ;;
  4) printf '\n'; dim "  Cancelled. Nothing was changed."; exit 0 ;;
  *) fail "invalid choice: '$SEL'" ;;
esac

# Warn, but do not block: installing before the harness is a legitimate order.
case "$SEL" in
  1|3) [ -n "$HAS_CLAUDE" ] || { printf '\n'; warn "Claude Code was not detected — installing anyway."; } ;;
esac
case "$SEL" in
  2|3) [ -n "$HAS_OPENCODE" ] || { printf '\n'; warn "opencode was not detected — installing anyway."; } ;;
esac

TOTAL=2                                            # source + CLI link
case "$SEL" in 1|3) TOTAL=$((TOTAL + 1)) ;; esac    # + Claude Code
case "$SEL" in 2|3) TOTAL=$((TOTAL + 1)) ;; esac    # + opencode
N=0

step $((N += 1)) "$TOTAL" "Get the package"
prepare_source

step $((N += 1)) "$TOTAL" "Link the CLI"
link_cli

DID_CLAUDE=0
case "$SEL" in
  1|3)
    step $((N += 1)) "$TOTAL" "Claude Code"
    if confirm "Install into $CLAUDE_DIR?" y; then
      install_claude_code
      DID_CLAUDE=1
    else
      dim "  skipped."
    fi
    ;;
esac

DID_OPENCODE=0
case "$SEL" in
  2|3)
    step $((N += 1)) "$TOTAL" "opencode"
    if confirm "Install into $OPENCODE_DIR?" y; then
      install_opencode
      DID_OPENCODE=1
    else
      dim "  skipped."
    fi
    ;;
esac

# ── Summary ────────────────────────────────────────────────────────────────
printf '\n'
rule
printf '  %s%s✓ done%s\n\n' "$BOLD" "$GREEN" "$RESET"

if [ "$DID_CLAUDE" = "1" ]; then
  bold "  Claude Code"
  dim  "    Restart it, or open a new session."
  dim  "    The bottom bar shows live cost; the receipt prints every 5th turn."
  printf '\n'
fi
if [ "$DID_OPENCODE" = "1" ]; then
  bold "  opencode"
  dim  "    Restart it. The sidebar footer shows live cost."
  printf '\n'
fi
if [ "$DID_CLAUDE" = "1" ] || [ "$DID_OPENCODE" = "1" ]; then
  bold "  In either harness"
  printf '    %s/realistic-cost%s              %sthe full receipt%s\n' "$BOLD" "$RESET" "$DIM" "$RESET"
  printf '    %s/realistic-cost export pdf%s   %ssave it%s\n\n' "$BOLD" "$RESET" "$DIM" "$RESET"
fi

dim "  Re-run this installer to upgrade."
if [ "$SOURCE_MODE" = "npm" ]; then
  dim "  Uninstall: rm -rf \"$PREFIX\" \"$BIN_DIR/realistic-cost\""
  [ "$DID_CLAUDE" = "1" ] && dim "             node \"$SRC/claude-code/configure-settings.mjs\" uninstall \"$CLAUDE_DIR/settings.json\""
  [ "$DID_OPENCODE" = "1" ] && dim "             rm -rf \"$OPENCODE_DIR/skills/realistic-cost\" (and its tui.json entry)"
else
  [ "$DID_CLAUDE" = "1" ] && dim "  Uninstall Claude Code: ./claude-code/uninstall.sh"
  [ "$DID_OPENCODE" = "1" ] && dim "  Uninstall opencode:    rm -rf \"$OPENCODE_DIR/skills/realistic-cost\" (and its tui.json entry)"
fi
printf '\n'
