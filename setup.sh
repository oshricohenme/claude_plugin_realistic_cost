#!/usr/bin/env bash
# setup.sh — install realistic-cost into Claude Code and/or opencode.
#
# Interactive: asks which target(s) before touching anything. Re-runnable;
# overwrites prior installs. Run from anywhere — it locates its own repo dir.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_DIR:-$HOME/.claude}"
OPENCODE_DIR="${OPENCODE_DIR:-$HOME/.config/opencode}"

# ───────────────────────── helpers ─────────────────────────

c_dim()   { printf '\033[2m%s\033[0m\n' "$*"; }
c_bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_cyan()  { printf '\033[36m%s\033[0m\n' "$*"; }
c_red()   { printf '\033[31m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

# This script edits ~/.claude/settings.json and installs files into $HOME, so
# it must never proceed on assumed answers. Piped into a shell (`curl | bash`)
# there is no /dev/tty and every prompt would silently take its default —
# installing everything unattended. Require a tty, or an explicit opt-in.
ASSUME_YES="${REALISTIC_COST_ASSUME_YES:-0}"

require_tty() {
  [ "$ASSUME_YES" = "1" ] && return 0
  if ! { exec 3</dev/tty; } 2>/dev/null; then
    c_red "No interactive terminal available, and this installer modifies files in \$HOME."
    c_dim "  Clone the repo and run ./setup.sh directly, or re-run with"
    c_dim "  REALISTIC_COST_ASSUME_YES=1 to accept every prompt (installs both targets)."
    exit 1
  fi
  exec 3<&-
}

confirm() {
  # confirm <prompt> [default(y|n)]
  local prompt="$1" default="${2:-y}" choice
  local hint
  if [ "$ASSUME_YES" = "1" ]; then return 0; fi
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  read -r -p "$(c_bold "$prompt") $hint " choice </dev/tty
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
    2) opencode       (/realistic-cost skill + global CLI; no status line*)
    3) Both           (recommended)
    4) Cancel

  * opencode has no status-line bar; only the skill + CLI are installed there.
MENU
  local sel
  if [ "$ASSUME_YES" = "1" ]; then echo "3"; return 0; fi
  read -r -p "$(c_bold 'Choose [1-4]')" sel </dev/tty
  sel="${sel:-3}"
  echo "$sel"
}

# ───────────────────────── shared build ─────────────────────────

build_and_link() {
  c_cyan "▸ Building realistic-cost in $REPO_DIR ..."
  ( cd "$REPO_DIR" && npm install --silent 2>/dev/null && npm run build --silent 2>/dev/null )
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
  cp "$REPO_DIR/claude-code/statusline.sh" "$CLAUDE_DIR/statusline.sh"
  chmod +x "$CLAUDE_DIR/statusline.sh"
  cp "$REPO_DIR/claude-code/print-cost.sh" "$CLAUDE_DIR/print-cost.sh"
  chmod +x "$CLAUDE_DIR/print-cost.sh"
  # rm first: `cp -R src dst` nests as dst/realistic-cost when dst exists,
  # so a second run would create skills/realistic-cost/realistic-cost.
  rm -rf "${CLAUDE_DIR:?}/skills/realistic-cost"
  cp -R "$REPO_DIR/claude-code/skills/realistic-cost" "$CLAUDE_DIR/skills/realistic-cost"
  c_green "  ✓ statusline.sh + print-cost.sh + skill installed"

  local settings="$CLAUDE_DIR/settings.json"
  if [ ! -f "$settings" ]; then
    cp "$REPO_DIR/claude-code/settings.example.json" "$settings"
    c_green "  ✓ created $settings"
  elif command -v node >/dev/null 2>&1; then
    # Always take a fresh timestamped backup — settings.json holds the user's
    # own hooks and status line, and a lossy edit here is unrecoverable.
    local backup
    backup="$settings.bak-realistic-cost-$(date +%Y%m%d%H%M%S)"
    cp "$settings" "$backup"
    c_dim "  · backed up $settings -> $(basename "$backup")"

    node -e '
      const fs = require("fs");
      const p = process.argv[1];
      const s = JSON.parse(fs.readFileSync(p, "utf8"));
      const STATUSLINE = "~/.claude/statusline.sh";
      const HOOK = "~/.claude/print-cost.sh";
      const notes = [];

      // statusLine: only one can exist, so replacing it is the install. Report
      // the displaced command instead of silently dropping it.
      const prev = s.statusLine && s.statusLine.command;
      if (prev && prev !== STATUSLINE) notes.push("replaced statusLine (was: " + prev + ")");
      s.statusLine = { type: "command", command: STATUSLINE, padding: 2 };

      // hooks.Stop: MERGE. Other tools register Stop hooks here; assigning the
      // array destroys them.
      s.hooks = s.hooks || {};
      const stop = Array.isArray(s.hooks.Stop) ? s.hooks.Stop : [];
      const has = stop.some((g) => (g && Array.isArray(g.hooks) ? g.hooks : []).some((h) => h && h.command === HOOK));
      if (!has) stop.push({ matcher: "", hooks: [{ type: "command", command: HOOK }] });
      s.hooks.Stop = stop;
      if (stop.length > 1) notes.push("kept " + (stop.length - 1) + " existing Stop hook group(s)");

      s.permissions = s.permissions || {};
      s.permissions.allow = Array.from(new Set([
        ...(s.permissions.allow || []),
        "Bash(realistic-cost:*)",
        "Bash(~/.claude/statusline.sh:*)",
        "Bash(~/.claude/print-cost.sh:*)",
      ]));
      fs.writeFileSync(p, JSON.stringify(s, null, 2) + "\n");
      for (const n of notes) console.log("  · " + n);
    ' "$settings"
    c_green "  ✓ updated $settings (statusLine + Stop hook + permissions)"
  else
    c_yellow "  ! node not found — add statusLine key to $settings manually"
  fi
}

# ───────────────────────── opencode ─────────────────────────

install_opencode() {
  c_cyan "▸ Installing opencode skill + TUI sidebar plugin..."

  # Skill (slash command)
  mkdir -p "$OPENCODE_DIR/skills"
  rm -rf "${OPENCODE_DIR:?}/skills/realistic-cost"   # see note in install_claude_code
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

  require_tty

  local sel
  sel="$(pick_target)"
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
