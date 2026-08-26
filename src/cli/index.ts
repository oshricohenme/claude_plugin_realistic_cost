import { Command, InvalidArgumentError, Option } from "commander"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import kleur from "kleur"
import {
  computeCost,
  estimateHours,
  parseStatusLineStdin,
  parseTranscript,
  transcriptSignature,
  emptyStats,
  formatStatusLine,
  type CostReport,
  type EstimateOptions,
  type StatusLineInput,
  type TranscriptStats,
} from "../core/index.js"
import { renderTerminal } from "./render.js"
import { exportReport, type ExportFormat, type ExportResult } from "./export.js"

const EXPORT_FORMATS = ["html", "md", "pdf", "png"] as const
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

/** "--review-overhead <x>" -> "--review-overhead" (for error messages). */
function flagName(flag: string): string {
  return flag.split(/\s/, 1)[0] ?? flag
}

function num(label: string, { min = 0 }: { min?: number } = {}) {
  return (v: string): number => {
    const n = Number(v)
    if (!Number.isFinite(n) || n < min) {
      throw new InvalidArgumentError(`${label} must be a number ≥ ${min} (got "${v}")`)
    }
    return n
  }
}

const int =
  (label: string, { min = 0 }: { min?: number } = {}) =>
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
// stats keyed by path, invalidated by a signature over every file the parse
// reads. Best-effort: any cache error falls back to a full parse.
// ---------------------------------------------------------------------------

interface CacheEntry {
  /**
   * mtime+size across the parent transcript AND its subagent sidecars. Keying
   * on the parent alone would serve stale stats for the minutes a subagent
   * runs, during which only the sidecar file grows.
   */
  signature: string
  stats: TranscriptStats
}

/**
 * Cache files live in a private per-user directory (0700) rather than directly
 * in a shared temp dir: a predictable path in a world-writable directory lets
 * another local user pre-create the name as a symlink and redirect our write.
 */
function cacheDir(): string {
  const dir = join(
    tmpdir(),
    `realistic-cost-${typeof process.getuid === "function" ? process.getuid() : "user"}`,
  )
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function cachePathFor(transcript: string): string {
  const key = createHash("sha256").update(transcript).digest("hex").slice(0, 20)
  return join(cacheDir(), `cache-${key}.json`)
}

function readCachedStats(transcript: string, signature: string): TranscriptStats | null {
  try {
    const entry = JSON.parse(readFileSync(cachePathFor(transcript), "utf8")) as CacheEntry
    if (entry.signature === signature && entry.stats) {
      return structuredClone(entry.stats)
    }
  } catch {
    // cache miss / corrupt / unsupported — fall through
  }
  return null
}

function writeCachedStats(transcript: string, signature: string, stats: TranscriptStats): void {
  try {
    const entry: CacheEntry = { signature, stats }
    writeFileSync(cachePathFor(transcript), JSON.stringify(entry), { mode: 0o600 })
  } catch {
    // cache write failures are non-fatal
  }
}

function parseTranscriptCached(transcript: string): TranscriptStats {
  try {
    const signature = transcriptSignature(transcript)
    const cached = readCachedStats(transcript, signature)
    if (cached) return cached
    const stats = parseTranscript(transcript)
    writeCachedStats(transcript, signature, stats)
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
  hoursPerDay?: number
  /** Model-tuning flags, keyed by commander's camelCased option name. */
  [modelFlag: string]: unknown
}

/**
 * Build EstimateOptions from whichever model flags the user passed. Driven by
 * MODEL_FLAGS, so a new knob needs one table entry and nothing else.
 */
function modelOptions(o: CliOpts): EstimateOptions {
  const eo: Record<string, number> = {}
  for (const { flag, key } of MODEL_FLAGS) {
    const v = o[optionKey(flag)]
    if (typeof v === "number") eo[key] = v
  }
  return eo as EstimateOptions
}

function buildReport(input: StatusLineInput, opts: CliOpts, useCache: boolean): CostReport {
  let transcript = opts.transcript
  // An explicit --transcript that does not exist is a user error, not a reason
  // to silently price an empty session as $0.
  if (transcript && !existsSync(transcript)) {
    throw new Error(`transcript not found: ${transcript}`)
  }
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
  const { rates, currency } = readRatesFile(opts.rates)
  return computeCost({
    stats,
    estimate,
    rates,
    options: {
      estimateOptions,
      currency,
      productiveHoursPerDay: opts.hoursPerDay,
      aiCost: opts.aiCost ?? input.cost?.total_cost_usd ?? 0,
    },
  })
}

// ---------------------------------------------------------------------------
// Stdin reader
// ---------------------------------------------------------------------------

/**
 * Read the status-line JSON from stdin.
 *
 * `isTTY` is not a sufficient guard: when the CLI is launched from an agent
 * harness, a hook, or CI, stdin is a pipe that is open but that nobody ever
 * writes to or closes — waiting for "end" there hangs forever. So we also give
 * up if no byte has arrived within `STDIN_FIRST_BYTE_TIMEOUT_MS`. Once data
 * starts flowing we wait for the real end of stream.
 */
const STDIN_FIRST_BYTE_TIMEOUT_MS = 150

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ""
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let settled = false
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      process.stdin.pause()
      resolve(Buffer.concat(chunks).toString("utf8"))
    }
    const timer = setTimeout(() => {
      if (chunks.length === 0) done()
    }, STDIN_FIRST_BYTE_TIMEOUT_MS)
    process.stdin.on("data", (c: Buffer) => chunks.push(c))
    process.stdin.on("end", done)
    process.stdin.on("error", done)
  })
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * Every EstimateOptions knob, as a CLI flag. Each entry maps a flag to the
 * `EstimateOptions` key it sets, so adding a knob here wires it end-to-end —
 * there is no second list to keep in step and no index to keep in step with.
 * `--hours-per-day` is deliberately absent: it is a CostOption, not an
 * EstimateOption, and is registered separately.
 */
export const MODEL_FLAGS: ReadonlyArray<{
  flag: string
  key: keyof EstimateOptions
  desc: string
}> = [
  {
    flag: "--review-overhead <x>",
    key: "reviewOverheadMultiplier",
    desc: "peer-review overhead multiplier (default 0.35)",
  },
  {
    flag: "--qa-overhead <x>",
    key: "qaOverheadMultiplier",
    desc: "QA overhead when no tests were written (default 0.50)",
  },
  {
    flag: "--qa-with-tests <x>",
    key: "qaWithTestsMultiplier",
    desc: "QA overhead when tests were written (default 0.35)",
  },
  {
    flag: "--design-overhead <x>",
    key: "designOverheadMultiplier",
    desc: "design overhead of FE+FS impl (default 0.60)",
  },
  {
    flag: "--pm-overhead <x>",
    key: "pmOverheadMultiplier",
    desc: "PM overhead of impl hours (default 0.15)",
  },
  {
    flag: "--em-overhead <x>",
    key: "emOverheadMultiplier",
    desc: "EM overhead of impl hours (default 0.10)",
  },
  {
    flag: "--devops-deploy <x>",
    key: "devopsDeployMultiplier",
    desc: "deploy/CI overhead of eng impl (default 0.15)",
  },
  {
    flag: "--security-sensitive <x>",
    key: "securitySensitiveMultiplier",
    desc: "security overhead when auth/data/infra touched (default 0.15)",
  },
  {
    flag: "--security-normal <x>",
    key: "securityNormalMultiplier",
    desc: "security overhead otherwise (default 0.05)",
  },
  {
    flag: "--techwriter-overhead <x>",
    key: "techwriterOverheadMultiplier",
    desc: "changelog/docs overhead of impl (default 0.10)",
  },
  {
    flag: "--thinking-cost-per-token <x>",
    key: "thinkingCostPerToken",
    desc: "USD per reasoning token billed as design time (default 0.05)",
  },
  {
    flag: "--tool-call-work-hours <x>",
    key: "toolCallWorkHours",
    desc: "hours of work time per tool call (default 0.5)",
  },
  {
    flag: "--tool-call-coordination-hours <x>",
    key: "toolCallCoordinationHours",
    desc: "hours of email/meeting time per tool call (default 0.5)",
  },
  {
    flag: "--web-request-min-hours <x>",
    key: "webRequestMinHours",
    desc: "lower bound on time spent reading one fetched page (default 0.5)",
  },
  {
    flag: "--web-request-max-hours <x>",
    key: "webRequestMaxHours",
    desc: "upper bound on time spent reading one fetched page (default 1.0)",
  },
  {
    flag: "--discovery-search-hours <x>",
    key: "discoverySearchHours",
    desc: "code-comprehension hours per glob/grep call (default 0.25)",
  },
  {
    flag: "--discovery-read-hours <x>",
    key: "discoveryReadHours",
    desc: "code-comprehension hours per file read (default 0.15)",
  },
  {
    flag: "--mcp-coordination-hours <x>",
    key: "mcpCallCoordinationHours",
    desc: "extra cross-team coordination per MCP call (default 1.0)",
  },
  {
    flag: "--mcp-management-hours <x>",
    key: "mcpServerManagementHours",
    desc: "management hours per MCP server engaged (default 4)",
  },
  {
    flag: "--mcp-engineering-hours <x>",
    key: "mcpServerEngineeringHours",
    desc: "engineer meeting hours per MCP server (default 4)",
  },
  {
    flag: "--mcp-coordination-factor <x>",
    key: "mcpCallCoordinationFactor",
    desc: "multiplier on email/meeting time for MCP calls (default 2)",
  },
  {
    flag: "--mcp-dept-work-min-hours <x>",
    key: "mcpCallDepartmentMinHours",
    desc: "lower bound on the other department's work per MCP call (default 2)",
  },
  {
    flag: "--mcp-dept-work-max-hours <x>",
    key: "mcpCallDepartmentMaxHours",
    desc: "upper bound on the other department's work per MCP call (default 5)",
  },
  {
    flag: "--subagent-coordination-hours <x>",
    key: "subagentCoordinationHours",
    desc: "coordination hours per subagent team (default 2)",
  },
  {
    flag: "--subagent-management-hours <x>",
    key: "subagentManagementHours",
    desc: "EM hours per subagent team (default 4)",
  },
  {
    flag: "--discovery-thinking-hours <x>",
    key: "discoveryThinkingHours",
    desc: "hours per thinking turn (default 0.10)",
  },
]

/** commander camelCases "--qa-with-tests" to "qaWithTests". */
function optionKey(flag: string): string {
  return flagName(flag)
    .replace(/^--/, "")
    .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

export function createProgram(): Command {
  const program = new Command()

  program
    .name("realistic-cost")
    .description(
      "Estimate what a 100% human-driven engineering team would cost to produce the work in this Claude Code session.",
    )
    .version(getVersion())

  const commonOpts = (cmd: Command) => {
    cmd
      .option("--transcript <path>", "transcript JSONL path (overrides stdin)")
      .option("--lines-added <n>", "override lines added", num("--lines-added"))
      .option("--lines-removed <n>", "override lines removed", num("--lines-removed"))
      .option("--duration-ms <n>", "override session duration in ms", int("--duration-ms"))
      .option("--ai-cost <n>", "AI session cost in USD", num("--ai-cost"))
      .option("--rates <path>", "path to rates JSON override")
      .option(
        "--hours-per-day <n>",
        "productive hours per man-day (default 8)",
        num("--hours-per-day", { min: 1 }),
      )
    for (const { flag, desc } of MODEL_FLAGS) {
      cmd.option(flag, desc, num(flagName(flag)))
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
    program.command("review").description("Print the full human-team cost review to the terminal."),
  ).action(async (local: CliOpts) => {
    const stdin = await readStdin()
    const input = stdin ? parseStatusLineStdin(stdin) : {}
    const report = buildReport(input, local, false)
    process.stdout.write(renderTerminal(report) + "\n")
  })

  commonOpts(program.command("export").description("Export the cost review to HTML, PDF, or PNG."))
    .addOption(new Option("-f, --format <fmt>", "output format").choices(EXPORT_FORMATS).default("html"))
    .option("-o, --out <path>", "output file path")
    .action(async (local: { format?: ExportFormat; out?: string } & CliOpts) => {
      const stdin = await readStdin()
      const input = stdin ? parseStatusLineStdin(stdin) : {}
      const report = buildReport(input, local, false)
      const result: ExportResult = exportReport(report, { format: local.format ?? "html", out: local.out })
      // A graceful degrade (no Chrome -> HTML) is a successful run, so the
      // exit code stays 0; the note explains what happened.
      process.stdout.write(`${result.note}\n  → ${result.outPath}\n`)
    })

  return program
}

export async function runCli(argv: string[]): Promise<void> {
  const program = createProgram()
  await program.parseAsync(argv, { from: "user" })
}
