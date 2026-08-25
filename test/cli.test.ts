import { test } from "node:test"
import { strictEqual, ok } from "node:assert"
import { spawnSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MODEL_FLAGS, createProgram, getVersion } from "../src/cli/index.js"
import { ESTIMATE_DEFAULTS } from "../src/core/index.js"
import type { CostReport } from "../src/core/index.js"

// ---------------------------------------------------------------------------
// Version — the CLI must report the package version, never a hardcoded one.
// ---------------------------------------------------------------------------

test("CLI version matches package.json", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string
  }
  strictEqual(getVersion(), pkg.version)
})

// ---------------------------------------------------------------------------
// Numeric option validation — regression for silent NaN overrides.
// ---------------------------------------------------------------------------

// exitOverride must be applied to the root AND each subcommand — commander
// otherwise process.exit()s from the subcommand's option parser and kills
// the test runner.
function testProgram() {
  const program = createProgram().exitOverride()
  for (const cmd of program.commands) cmd.exitOverride()
  return program
}

test("non-numeric --lines-added is rejected with a helpful error", async () => {
  const program = testProgram()
  await assertRejectsMessage(
    program.parseAsync(["status", "--lines-added", "abc"], { from: "user" }),
    /must be a number/,
  )
})

test("negative --ai-cost is rejected", async () => {
  const program = testProgram()
  // =-5 form: commander would otherwise treat a bare "-5" as a flag
  await assertRejectsMessage(
    program.parseAsync(["status", "--ai-cost=-5"], { from: "user" }),
    /must be a number/,
  )
})

test("fractional --duration-ms is rejected", async () => {
  const program = testProgram()
  await assertRejectsMessage(
    program.parseAsync(["status", "--duration-ms", "1.5"], { from: "user" }),
    /must be an integer/,
  )
})

test("--hours-per-day below 1 is rejected", async () => {
  const program = testProgram()
  await assertRejectsMessage(
    program.parseAsync(["status", "--hours-per-day", "0"], { from: "user" }),
    /hours-per-day/,
  )
})

async function assertRejectsMessage(p: Promise<unknown>, re: RegExp): Promise<void> {
  try {
    await p
    throw new Error("expected parseAsync to reject")
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    ok(re.test(msg), `error message matches ${re}: "${msg}"`)
  }
}

// ---------------------------------------------------------------------------
// End-to-end: run the real CLI as a subprocess with statusline JSON on stdin.
// ---------------------------------------------------------------------------

const CLI = ["--import", "tsx", "src/bin/realistic-cost.ts"]

function runCli(args: string[], stdin: string): { stdout: string; stderr: string; status: number | null } {
  const res = spawnSync(process.execPath, [...CLI, ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 60_000,
  })
  return { stdout: res.stdout ?? "", stderr: res.stderr ?? "", status: res.status }
}

function tempTranscript(): string {
  const dir = mkdtempSync(join(tmpdir(), "rc-cli-"))
  const tp = join(dir, "session.jsonl")
  const lines = [
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "u1", name: "Write", input: { filePath: "src/api.ts", content: "a\nb\n" } },
        ],
      },
    },
  ]
  writeFileSync(tp, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return tp
}

test("status --json produces a full report from stdin JSON", () => {
  const tp = tempTranscript()
  try {
    const input = JSON.stringify({
      transcript_path: tp,
      cost: { total_lines_added: 2, total_cost_usd: 0.42 },
    })
    const { stdout, status, stderr } = runCli(["status", "--json", "--no-cache"], input)
    strictEqual(status, 0, `CLI exited cleanly (stderr: ${stderr})`)
    const report = JSON.parse(stdout) as CostReport
    ok(report.totalCost > 0, "totalCost populated")
    strictEqual(report.aiCost, 0.42, "aiCost taken from stdin cost.total_cost_usd")
    strictEqual(report.stats.linesAdded, 2, "authoritative line count honored")
    ok(report.roles.length === 11)
  } finally {
    rmSync(join(tp, ".."), { recursive: true, force: true })
  }
})

test("status prints a one-line statusline and caches the transcript parse", () => {
  const tp = tempTranscript()
  try {
    const input = JSON.stringify({ transcript_path: tp })
    const first = runCli(["status"], input)
    strictEqual(first.status, 0)
    ok(first.stdout.includes("Pre-AI:"), `statusline rendered: "${first.stdout.trim()}"`)
    strictEqual(first.stdout.trim().split("\n").length, 1)

    // Second run hits the mtime+size cache: identical output, and a cache
    // file now exists in tmpdir.
    const second = runCli(["status"], input)
    strictEqual(second.status, 0)
    strictEqual(second.stdout, first.stdout, "cached run produces identical output")
    // Cache lives in a private per-user directory, not loose in the shared
    // temp dir (see cacheDir() in src/cli/index.ts).
    const key = createHash("sha256").update(tp).digest("hex").slice(0, 20)
    const dir = join(tmpdir(), `realistic-cost-${process.getuid?.() ?? "user"}`)
    ok(existsSync(join(dir, `cache-${key}.json`)), "cache file written")
  } finally {
    rmSync(join(tp, ".."), { recursive: true, force: true })
  }
})

test("model flags change the estimate end-to-end", () => {
  const tp = tempTranscript()
  try {
    const input = JSON.stringify({ transcript_path: tp })
    const base = JSON.parse(runCli(["status", "--json", "--no-cache"], input).stdout) as CostReport
    const tuned = JSON.parse(
      runCli(["status", "--json", "--no-cache", "--review-overhead", "0.9"], input).stdout,
    ) as CostReport
    ok(tuned.totalCost > base.totalCost, "higher review overhead raises the total")
  } finally {
    rmSync(join(tp, ".."), { recursive: true, force: true })
  }
})

test("invalid numeric flag fails with exit code 2 and a stderr message", () => {
  const { status, stderr } = runCli(["status", "--lines-added", "abc"], "{}")
  strictEqual(status, 1, "commander validation failure exit code")
  ok(stderr.includes("must be a number"), `stderr explains the problem: "${stderr.trim()}"`)
})

// ---------------------------------------------------------------------------
// Flag table coverage.
//
// The model flags used to be registered via `MODEL_FLAG_HELP.slice(0, 13)` — a
// magic index that would silently drop any flag appended to the table. The
// table is now the single source for both help text and option plumbing, and
// this test pins that every tunable is reachable from the command line.
// ---------------------------------------------------------------------------

test("every model parameter is exposed as a CLI flag and reaches the estimate", () => {
  const flagKeys = new Set(MODEL_FLAGS.map((f) => f.key))
  for (const key of Object.keys(ESTIMATE_DEFAULTS)) {
    ok(flagKeys.has(key as keyof typeof ESTIMATE_DEFAULTS), `${key} has a --flag`)
  }
  strictEqual(flagKeys.size, MODEL_FLAGS.length, "no duplicate keys in the flag table")

  // The help output must list them all, with no truncation.
  const help = runCli(["review", "--help"], "").stdout
  for (const { flag } of MODEL_FLAGS) {
    ok(help.includes(flag.split(" ")[0]), `${flag} appears in --help`)
  }
})

test("a bad value for any model flag names the flag in the error", () => {
  for (const { flag } of MODEL_FLAGS) {
    const name = flag.split(" ")[0]
    const { stderr } = runCli(["status", name, "not-a-number"], "{}")
    ok(stderr.includes(name), `error names ${name}: "${stderr.trim()}"`)
  }
})

test("an explicit --transcript that does not exist fails loudly", () => {
  const { status, stderr } = runCli(["review", "--transcript", "/definitely/not/here.jsonl"], "")
  strictEqual(status, 1, "missing transcript is an error, not a $0 report")
  ok(stderr.includes("transcript not found"), `stderr explains: "${stderr.trim()}"`)
})
