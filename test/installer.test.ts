import { test } from "node:test"
import { strictEqual, ok, deepStrictEqual } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------------------
// Installer safety.
//
// The installer used to do `settings.hooks.Stop = [ours]` — a plain assignment
// over a shared array — which silently destroyed any Stop hook the user
// already had, and setup.sh took no backup at all. It also clobbered an
// existing statusLine with no way to get it back.
//
// These tests pin the three properties that failure violated:
//   1. foreign hooks and unrelated settings survive an install
//   2. installing twice is idempotent, and every run leaves a backup
//   3. uninstall restores the original file exactly
// ---------------------------------------------------------------------------

// fileURLToPath, not URL.pathname: on Windows the latter yields "/C:/..."
// with a leading slash that spawn cannot resolve.
const SCRIPT = fileURLToPath(new URL("../claude-code/configure-settings.mjs", import.meta.url))

interface HookEntry {
  matcher?: string
  hooks?: { type: string; command: string }[]
}

interface Settings {
  statusLine?: { type: string; command: string; padding?: number }
  hooks?: { Stop?: HookEntry[]; PreToolUse?: HookEntry[] }
  permissions?: { allow?: string[] }
  model?: string
}

function configure(mode: "install" | "uninstall", settingsPath: string, ...flags: string[]) {
  const res = spawnSync(process.execPath, [SCRIPT, mode, settingsPath, ...flags], { encoding: "utf8" })
  strictEqual(res.status, 0, `configure-settings ${mode} failed: ${res.stderr}`)
  return res
}

function withSandbox(initial: Settings | null, fn: (paths: { dir: string; settings: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "rc-install-"))
  const settings = join(dir, "settings.json")
  if (initial) writeFileSync(settings, JSON.stringify(initial, null, 2))
  try {
    fn({ dir, settings })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const read = (p: string): Settings => JSON.parse(readFileSync(p, "utf8")) as Settings
const backups = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".bak"))

const isOurs = (e: HookEntry) => (e.hooks ?? []).some((h) => h.command.includes("print-cost.sh"))

const USER_SETTINGS: Settings = {
  statusLine: { type: "command", command: "~/.claude/my-statusline.sh" },
  hooks: {
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "~/.claude/hooks/other-tool" }] }],
    PreToolUse: [{ matcher: "Bash" }],
  },
  model: "opus",
}

test("install appends the Stop hook instead of replacing the array", () => {
  withSandbox(USER_SETTINGS, ({ settings }) => {
    configure("install", settings)
    const s = read(settings)
    const stop = s.hooks?.Stop ?? []
    strictEqual(stop.filter(isOurs).length, 1, "our hook was added")
    ok(
      stop.some((e) => (e.hooks ?? []).some((h) => h.command.includes("other-tool"))),
      "a pre-existing Stop hook must survive the install",
    )
    strictEqual(s.model, "opus", "unrelated settings are untouched")
    ok(s.hooks?.PreToolUse, "unrelated hook types are untouched")
  })
})

test("install is idempotent and backs up on every run", () => {
  withSandbox(USER_SETTINGS, ({ dir, settings }) => {
    configure("install", settings)
    const afterFirst = readFileSync(settings, "utf8")
    strictEqual(backups(dir).length, 1, "first run leaves a backup")

    configure("install", settings)
    strictEqual(readFileSync(settings, "utf8"), afterFirst, "second install changes nothing")
    strictEqual(read(settings).hooks?.Stop?.filter(isOurs).length, 1, "no duplicate hook entries")
    strictEqual(backups(dir).length, 2, "every run backs up, not just the first")
  })
})

test("uninstall restores the original settings exactly", () => {
  withSandbox(USER_SETTINGS, ({ settings }) => {
    const before = read(settings)
    configure("install", settings, "--with-permissions")
    configure("uninstall", settings)
    deepStrictEqual(read(settings), before, "install -> uninstall is a lossless round-trip")
  })
})

test("a statusline whose name merely contains 'statusline.sh' is still restored", () => {
  // Ownership used to be a substring test, so "~/.claude/my-statusline.sh"
  // looked like ours and was discarded rather than stashed.
  withSandbox({ statusLine: { type: "command", command: "~/.claude/my-statusline.sh" } }, ({ settings }) => {
    configure("install", settings)
    configure("uninstall", settings)
    strictEqual(read(settings).statusLine?.command, "~/.claude/my-statusline.sh")
  })
})

test("permissions are opt-in", () => {
  withSandbox({}, ({ settings }) => {
    configure("install", settings)
    strictEqual(read(settings).permissions, undefined, "no permissions written without the flag")
  })
  withSandbox({}, ({ settings }) => {
    configure("install", settings, "--with-permissions")
    ok((read(settings).permissions?.allow ?? []).length > 0, "--with-permissions writes the allow-list")
  })
})

test("uninstall on a clean settings file leaves no realistic-cost traces", () => {
  withSandbox({ model: "opus" }, ({ dir, settings }) => {
    configure("install", settings)
    configure("uninstall", settings)
    const s = read(settings)
    strictEqual(s.statusLine, undefined, "statusLine removed when there was none to restore")
    strictEqual(s.hooks, undefined, "empty hooks object is cleaned up")
    strictEqual(s.model, "opus")
    ok(!existsSync(join(dir, ".realistic-cost-install.json")), "sidecar state file is removed")
  })
})
