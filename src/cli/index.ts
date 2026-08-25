import { Command, InvalidArgumentError } from "commander"
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import kleur from "kleur"
import {
  computeCost,
  estimateHours,
  parseStatusLineStdin,
  parseTranscript,
  emptyStats,
  formatStatusLine,
  type CostReport,
  type EstimateOptions,
  type StatusLineInput,
  type TranscriptStats,
} from "../core/index.js"
import { renderTerminal } from "./render.js"
import { exportReport, type ExportResult } from "./export.js"
import { readRatesFile } from "./rates.js"

// ---------------------------------------------------------------------------
// Version — read from package.json so the CLI never drifts from npm.
// Works both from src/ (ts via tsx) and dist/ (compiled, same relative depth).
// ---------------------------------------------------------------------------

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string
}
export function getVersion(): string {
  return pkg.version
}

// ---------------------------------------------------------------------------
// Option parsing helpers
// ---------------------------------------------------------------------------

function num(label: string, { min = 0 }: { min?: number } = {}) {
  return (v: string): number => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < min) {
      throw new InvalidArgumentError(`${label} must be a number ≥ ${min} (got "${v}")`)
    }
    return n
  }
}

const int = (label: string, { min = 0 }: { min?: number } = {}) =>
  (v: string): number => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < min) {
      throw new InvalidArgumentError(`${label} must be an integer ≥ ${min} (got "${v}")`)
    }
    return n
  }

// ---------------------------------------------------------------------------
// Transcript auto-discovery: Claude Code stores transcripts under
// ~/.claude/projects/<project-dir-slash-encoded>/<session-id>.jsonl
// ---------------------------------------------------------------------------

function autoDiscoverTranscript(projectDir?: string): string {
  const cwd = projectDir ?? process.cwd()
  const encoded = cwd.replace(/\//g, "-")
  const projectsDir = join(homedir(), ".claude", "projects")
  let dir = join(projectsDir, encoded)
  // Some versions also prefix with a leading dash; try both.
  if (!existsSync(dir)) dir = join(projectsDir, "-" + encoded)
  if (existsSync(dir)) return newestJsonl([dir])

  if (!existsSync(projectsDir)) return ""

  // Fallback for moved checkouts / symlinks: project dirs whose name ends
  // with the encoded tail. Only safe when exactly one candidate exists —
  // with several we cannot tell which project this session belongs to, and
  // pricing the wrong project's transcript is worse than pricing nothing.
  const candidates = readdirSync(projectsDir)
    .map((d) => join(projectsDir, d))
    .filter((d) => {
      try {
        return statSync(d).isDirectory()
      } catch {
        return false
      }
    })
    .filter((d) => d.replace(/\\/g, "-").endsWith(encoded))
  if (candidates.length === 1) return newestJsonl(candidates)
  if (candidates.length > 1) {
    process.stderr.write(
      `realistic-cost: transcript directory for this project is ambiguous (${candidates.length} candidates) — pass --transcript explicitly\n`,
    )
  }
  return ""
}

function newestJsonl(dirs: string[]): string {
  let best = ""
  let bestMtime = 0
  for (const d of dirs) {
    let entries: string[]
    try {
      entries = readdirSync(d).filter((f) => f.endsWith(".jsonl"))
    } catch {
      continue
    }
    for (const f of entries) {
      const p = join(d, f)
      try {
        const m = statSync(p).mtimeMs
        if (m > bestMtime) {
          bestMtime = m
          best = p
        }
      } catch {
        // ignore
      }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Statusline parse cache — the status line re-runs on every UI refresh, and
// re-parsing a multi-MB transcript JSONL each time is wasteful. Cache parsed
// stats keyed by path, invalidated by mtime+size. Best-effort: any cache
// error falls back to a full parse.
// ---------------------------------------------------------------------------

interface CacheEntry {
  mtimeMs: number
  size: number
  stats: TranscriptStats
}

function cachePathFor(transcript: string): string {
  const key = createHash("sha1").update(transcript).digest("hex").slice(0, 20)
  return join(tmpdir(), `realistic-cost-cache-${key}.json`)
}

function readCachedStats(transcript: string, mtimeMs: number, size: number): TranscriptStats | null {
  try {
    const entry = JSON.parse(readFileSync(cachePathFor(transcript), "utf8")) as CacheEntry
    if (entry.mtimeMs === mtimeMs && entry.size === size && entry.stats) {
      return structuredClone(entry.stats)
    }
  } catch {
    // cache miss / corrupt / unsupported — fall through
  }
  return null
}

function writeCachedStats(transcript: string, mtimeMs: number, size: number, stats: TranscriptStats): void {
  try {
    const entry: CacheEntry = { mtimeMs, size, stats }
    writeFileSync(cachePathFor(transcript), JSON.stringify(entry))
  } catch {
    // cache write failures are non-fatal
  }
}

function parseTranscriptCached(transcript: string): TranscriptStats {
  try {
    const st = statSync(transcript)
    const cached = readCachedStats(transcript, st.mtimeMs, st.size)
    if (cached) return cached
    const stats = parseTranscript(transcript)
    writeCachedStats(transcript, st.mtimeMs, st.size, stats)
    return stats
  } catch {
    return parseTranscript(transcript)
  }
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

interface CliOpts {
  transcript?: string
  linesAdded?: number
  linesRemoved?: number
  durationMs?: number
  aiCost?: number
  rates?: string
  reviewOverhead?: number
  qaOverhead?: number
  qaWithTests?: number
  designOverhead?: number
  pmOverhead?: number
  emOverhead?: number
  devopsDeploy?: number
  securitySensitive?: number
  securityNormal?: number
  techwriterOverhead?: number
  discoverySearchHours?: number
  discoveryReadHours?: number
  discoveryThinkingHours?: number
  hoursPerDay?: number
}

/** Build EstimateOptions from whichever model flags the user passed. */
function modelOptions(o: CliOpts): EstimateOptions {
  const eo: EstimateOptions = {}
  if (o.reviewOverhead != null) eo.reviewOverheadMultiplier = o.reviewOverhead
  if (o.qaOverhead != null) eo.qaOverheadMultiplier = o.qaOverhead
  if (o.qaWithTests != null) eo.qaWithTestsMultiplier = o.qaWithTests
  if (o.designOverhead != null) eo.designOverheadMultiplier = o.designOverhead
  if (o.pmOverhead != null) eo.pmOverheadMultiplier = o.pmOverhead
  if (o.emOverhead != null) eo.emOverheadMultiplier = o.emOverhead
  if (o.devopsDeploy != null) eo.devopsDeployMultiplier = o.devopsDeploy
  if (o.securitySensitive != null) eo.securitySensitiveMultiplier = o.securitySensitive
  if (o.securityNormal != null) eo.securityNormalMultiplier = o.securityNormal
  if (o.techwriterOverhead != null) eo.techwriterOverheadMultiplier = o.techwriterOverhead
  if (o.discoverySearchHours != null) eo.discoverySearchHours = o.discoverySearchHours
  if (o.discoveryReadHours != null) eo.discoveryReadHours = o.discoveryReadHours
  if (o.discoveryThinkingHours != null) eo.discoveryThinkingHours = o.discoveryThinkingHours
  return eo
}

function buildReport(input: StatusLineInput, opts: CliOpts, useCache: boolean): CostReport {
  let transcript = opts.transcript
  if (!transcript && input.transcript_path) transcript = input.transcript_path
  if (!transcript) transcript = autoDiscoverTranscript(input.workspace?.current_dir)

  const stats: TranscriptStats = transcript
    ? useCache
      ? parseTranscriptCached(transcript)
      : parseTranscript(transcript)
    : emptyStats()

  // Override with authoritative status-line numbers when present.
  if (input.cost?.total_lines_added != null) stats.linesAdded = input.cost.total_lines_added
  if (input.cost?.total_lines_removed != null) stats.linesRemoved = input.cost.total_lines_removed
  if (input.cost?.total_duration_ms != null) stats.durationMs = input.cost.total_duration_ms

  if (opts.linesAdded != null) stats.linesAdded = opts.linesAdded
  if (opts.linesRemoved != null) stats.linesRemoved = opts.linesRemoved
  if (opts.durationMs != null) stats.durationMs = opts.durationMs

  const estimateOptions = modelOptions(opts)
  const estimate = estimateHours(stats, estimateOptions)
  const rates = readRatesFile(opts.rates)
  const report = computeCost({
    stats,
    estimate,
    rates,
    options: {
      estimateOptions,
      productiveHoursPerDay: opts.hoursPerDay,
      aiCost: opts.aiCost ?? input.cost?.total_cost_usd ?? 0,
    },
  })
  return report
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

// `isTTY` is false whenever stdin is a pipe — including an *open pipe with no
// writer*, which is how agent harnesses (and CI) commonly invoke a CLI. Waiting
// on "end" there never returns, so `realistic-cost review` would hang forever.
// Bound the wait: if nothing arrives promptly, treat it as "no piped input".
const STDIN_IDLE_MS = Number(process.env.REALISTIC_COST_STDIN_TIMEOUT_MS ?? 250)

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false

    const finish = (value: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.removeListener("data", onData)
      process.stdin.removeListener("end", onEnd)
      process.stdin.removeListener("error", onError)
      process.stdin.pause()
      // pause() alone still leaves the handle referenced, so an open-but-idle
      // pipe keeps the event loop alive and the process never exits. unref()
      // exists on socket/pipe stdin but not when stdin is a plain file
      // (`< /dev/null`, `< file`), where the loop is not held open anyway.
      const stdin = process.stdin as NodeJS.ReadStream & { unref?: () => void }
      if (typeof stdin.unref === "function") stdin.unref()
      resolve(value)
    }

    const collected = () => Buffer.concat(chunks).toString("utf8")
    // Re-armed on every chunk, so a slow writer is not cut off mid-stream.
    let timer = setTimeout(() => finish(collected()), STDIN_IDLE_MS)
    const onData = (c: Buffer) => {
      chunks.push(c)
      clearTimeout(timer)
      timer = setTimeout(() => finish(collected()), STDIN_IDLE_MS)
    }
    const onEnd = () => finish(collected())
    const onError = () => finish("")

    process.stdin.on("data", onData)
    process.stdin.on("end", onEnd)
    process.stdin.on("error", onError)
  })
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const MODEL_FLAG_HELP = [
  ["--review-overhead <x>", "peer-review overhead multiplier (default 0.35)"],
  ["--qa-overhead <x>", "QA overhead when no tests were written (default 0.50)"],
  ["--qa-with-tests <x>", "QA overhead when tests were written (default 0.35)"],
  ["--design-overhead <x>", "design overhead of FE+FS impl (default 0.60)"],
  ["--pm-overhead <x>", "PM overhead of impl hours (default 0.15)"],
  ["--em-overhead <x>", "EM overhead of impl hours (default 0.10)"],
  ["--devops-deploy <x>", "deploy/CI overhead of eng impl (default 0.15)"],
  ["--security-sensitive <x>", "security overhead when auth/data/infra touched (default 0.15)"],
  ["--security-normal <x>", "security overhead otherwise (default 0.05)"],
  ["--techwriter-overhead <x>", "changelog/docs overhead of impl (default 0.10)"],
  ["--discovery-search-hours <x>", "hours per glob+grep call (default 0.25)"],
  ["--discovery-read-hours <x>", "hours per file read (default 0.15)"],
  ["--discovery-thinking-hours <x>", "hours per thinking turn (default 0.10)"],
  ["--hours-per-day <n>", "productive hours per man-day (default 8)"],
] as const

export function createProgram(): Command {
  const program = new Command()

  program
    .name("realistic-cost")
    .description("Estimate what a 100% human-driven engineering team would cost to produce the work in this Claude Code session.")
    .version(getVersion())

  const commonOpts = (cmd: Command) => {
    cmd
      .option("--transcript <path>", "transcript JSONL path (overrides stdin)")
      .option("--lines-added <n>", "override lines added", num("lines-added"))
      .option("--lines-removed <n>", "override lines removed", num("lines-removed"))
      .option("--duration-ms <n>", "override session duration in ms", int("duration-ms"))
      .option("--ai-cost <n>", "AI session cost in USD", num("ai-cost"))
      .option("--rates <path>", "path to rates JSON override")
      .option("--hours-per-day <n>", "productive hours per man-day (default 8)", num("hours-per-day", { min: 1 }))
    for (const [flag, desc] of MODEL_FLAG_HELP) {
      // --hours-per-day is registered above with its own min constraint.
      // Skipping it by name (rather than by a magic slice index) means a new
      // model flag appended to MODEL_FLAG_HELP is registered, not dropped.
      if (flag.startsWith("--hours-per-day")) continue
      // Strip the leading dashes first, then the ` <x>` placeholder. A single
      // [ <-] class matches the leading "-" too, which emptied every label and
      // produced errors reading "argument 'abc' is invalid.  must be a number".
      const label = flag.replace(/^-+/, "").replace(/[\s<].*$/, "")
      cmd.option(flag, desc, num(label))
    }
    return cmd
  }

  commonOpts(
    program
      .command("status")
      .description("Print a one-line status-bar summary (reads status-line JSON on stdin)."),
  )
    .option("--no-cache", "bypass the statusline transcript cache")
    .option("--json", "emit the full CostReport as JSON instead of a status line")
    .action(async (local: { json?: boolean; cache?: boolean } & CliOpts) => {
      const stdin = await readStdin()
      const input = stdin ? parseStatusLineStdin(stdin) : {}
      if (!stdin && !local.transcript) {
        // Nothing to do; print a neutral status.
        process.stdout.write(kleur.gray("realistic-cost: no session data"))
        return
      }
      const report = buildReport(input, local, local.cache !== false)
      if (local.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n")
      } else {
        process.stdout.write(formatStatusLine(report) + "\n")
      }
    })

  commonOpts(
    program
      .command("review")
      .description("Print the full human-team cost review to the terminal."),
  )
    .action(async (local: CliOpts) => {
      const stdin = await readStdin()
      const input = stdin ? parseStatusLineStdin(stdin) : {}
      const report = buildReport(input, local, false)
      process.stdout.write(renderTerminal(report) + "\n")
    })

  commonOpts(
    program
      .command("export")
      .description("Export the cost review to HTML, PDF, or PNG."),
  )
    .option("-f, --format <fmt>", "output format: html | pdf | png", "html")
    .option("-o, --out <path>", "output file path")
    .action(async (local: { format?: string; out?: string } & CliOpts) => {
      const stdin = await readStdin()
      const input = stdin ? parseStatusLineStdin(stdin) : {}
      const report = buildReport(input, local, false)
      const fmt = (local.format ?? "html") as "html" | "pdf" | "png"
      const result: ExportResult = exportReport(report, { format: fmt, out: local.out })
      process.stdout.write(`${result.note}\n  → ${result.outPath}\n`)
      if (!result.converted) {
        process.exitCode = 0 // graceful degrade is not an error
      }
    })

  return program
}

export async function runCli(argv: string[]): Promise<void> {
  const program = createProgram()
  await program.parseAsync(argv, { from: "user" })
}
