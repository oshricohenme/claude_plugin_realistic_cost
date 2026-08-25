#!/usr/bin/env node
/**
 * configure-settings.mjs — the ONLY thing that edits ~/.claude/settings.json.
 *
 * install.sh, setup.sh and uninstall.sh all call this, so there is a single
 * implementation of "wire realistic-cost in" and a single implementation of
 * "take it back out again".
 *
 * Design rules, learned the hard way:
 *
 *   1. NEVER assign to hooks.Stop. It is a shared array; other tools live
 *      there. We append our entry if it is missing and remove only our entry
 *      on uninstall.
 *   2. ALWAYS back up before writing, every run — not just the first.
 *   3. A pre-existing statusLine belongs to the user. We stash it in a sidecar
 *      file and put it back on uninstall.
 *   4. Permissions are opt-in. Granting yourself Bash permissions in someone
 *      else's global config without asking is not acceptable.
 *
 * Usage:
 *   configure-settings.mjs install   <settings.json> [--with-permissions]
 *   configure-settings.mjs uninstall <settings.json>
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"

const STATUS_LINE_COMMAND = "~/.claude/statusline.sh"
const STOP_HOOK_COMMAND = "~/.claude/print-cost.sh"
const PERMISSIONS = [
  "Bash(realistic-cost:*)",
  `Bash(${STATUS_LINE_COMMAND}:*)`,
  `Bash(${STOP_HOOK_COMMAND}:*)`,
]

const [, , mode, settingsPath, ...flags] = process.argv
const withPermissions = flags.includes("--with-permissions")

if (!mode || !settingsPath) {
  console.error("usage: configure-settings.mjs <install|uninstall> <settings.json> [--with-permissions]")
  process.exit(2)
}

/** Sidecar state, so uninstall can undo exactly what install did. */
const statePath = join(dirname(settingsPath), ".realistic-cost-install.json")

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function backup(path) {
  if (!existsSync(path)) return null
  const dest = `${path}.${timestamp()}.bak`
  copyFileSync(path, dest)
  return dest
}

/**
 * Ownership tests match the exact command we install, never a substring: a
 * user's own `~/.claude/my-statusline.sh` contains "statusline.sh", and
 * treating it as ours would silently discard it instead of restoring it.
 */
function isOurCommand(command, ours) {
  if (typeof command !== "string") return false
  const normalize = (c) =>
    c
      .trim()
      .replace(/^~/, "")
      .replace(/^["']|["']$/g, "")
  return normalize(command) === normalize(ours)
}

/** True if this Stop-hook group is one of ours. */
function isOurStopEntry(entry) {
  return (entry?.hooks ?? []).some((h) => isOurCommand(h?.command, STOP_HOOK_COMMAND))
}

function isOurStatusLine(sl) {
  return isOurCommand(sl?.command, STATUS_LINE_COMMAND)
}

function install() {
  const settings = readJson(settingsPath, {})
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
    console.error(`  ! ${settingsPath} is not a JSON object — refusing to touch it`)
    process.exit(1)
  }
  const backedUp = backup(settingsPath)
  const state = readJson(statePath, {})
  const notes = []

  // ── statusLine: stash whatever was there so uninstall can restore it ──
  if (settings.statusLine && !isOurStatusLine(settings.statusLine)) {
    // Only record the FIRST displaced statusLine; re-running must not
    // overwrite the stash with our own value.
    if (state.previousStatusLine === undefined) {
      state.previousStatusLine = settings.statusLine
      notes.push("saved your existing statusLine (restored on uninstall)")
    }
  } else if (!settings.statusLine && state.previousStatusLine === undefined) {
    state.previousStatusLine = null // there was none; uninstall should remove ours
  }
  settings.statusLine = { type: "command", command: STATUS_LINE_COMMAND, padding: 2 }

  // ── Stop hook: APPEND, never replace. Other tools live in this array. ──
  settings.hooks = settings.hooks ?? {}
  const stop = Array.isArray(settings.hooks.Stop) ? settings.hooks.Stop : []
  const existing = stop.filter(isOurStopEntry).length
  if (existing === 0) {
    stop.push({ matcher: "", hooks: [{ type: "command", command: STOP_HOOK_COMMAND }] })
    const others = stop.length - 1
    notes.push(others > 0 ? `added Stop hook alongside ${others} existing hook(s)` : "added Stop hook")
  } else {
    notes.push("Stop hook already present")
  }
  settings.hooks.Stop = stop

  // ── Permissions: opt-in only ──
  if (withPermissions) {
    settings.permissions = settings.permissions ?? {}
    const allow = Array.isArray(settings.permissions.allow) ? settings.permissions.allow : []
    const added = PERMISSIONS.filter((p) => !allow.includes(p))
    settings.permissions.allow = [...allow, ...added]
    state.grantedPermissions = true
    if (added.length) notes.push(`allow-listed ${added.length} realistic-cost command(s)`)
  } else {
    notes.push("skipped permission entries (pass --with-permissions to pre-approve)")
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n")

  if (backedUp) console.log(`  backup: ${backedUp}`)
  for (const n of notes) console.log(`  ${n}`)
}

function uninstall() {
  if (!existsSync(settingsPath)) return
  const settings = readJson(settingsPath, null)
  if (!settings) {
    console.error(`  ! ${settingsPath} is not readable JSON — leaving it alone`)
    process.exit(1)
  }
  const backedUp = backup(settingsPath)
  const state = readJson(statePath, {})
  const notes = []

  // ── statusLine: put back whatever we displaced ──
  if (isOurStatusLine(settings.statusLine)) {
    if (state.previousStatusLine) {
      settings.statusLine = state.previousStatusLine
      notes.push("restored your previous statusLine")
    } else {
      delete settings.statusLine
      notes.push("removed statusLine")
    }
  }

  // ── Stop hook: remove only ours, leave everyone else's alone ──
  if (Array.isArray(settings.hooks?.Stop)) {
    const before = settings.hooks.Stop.length
    settings.hooks.Stop = settings.hooks.Stop.filter((e) => !isOurStopEntry(e))
    const removed = before - settings.hooks.Stop.length
    if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks
    if (removed) notes.push(`removed ${removed} Stop hook entry(ies)`)
  }

  // ── Permissions: only the ones we added ──
  if (Array.isArray(settings.permissions?.allow)) {
    const before = settings.permissions.allow.length
    settings.permissions.allow = settings.permissions.allow.filter((a) => !PERMISSIONS.includes(a))
    if (settings.permissions.allow.length !== before) notes.push("removed permission entries")
    if (settings.permissions.allow.length === 0) delete settings.permissions.allow
    if (Object.keys(settings.permissions).length === 0) delete settings.permissions
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n")
  rmSync(statePath, { force: true })

  if (backedUp) console.log(`  backup: ${backedUp}`)
  for (const n of notes) console.log(`  ${n}`)
}

if (mode === "install") install()
else if (mode === "uninstall") uninstall()
else {
  console.error(`unknown mode: ${mode}`)
  process.exit(2)
}
