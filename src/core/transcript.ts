import { readFileSync } from "node:fs"
import type { FileDomain, FileWriteOp, StatusLineInput, TranscriptStats } from "./types.js"

// ---------------------------------------------------------------------------
// Domain classification by file path/extension
// ---------------------------------------------------------------------------

const TEST_PATH = /(\.|_|-)(test|spec)\.(t|j)sx?$|(^|\/)(test|tests|__tests__|spec|specs)\//i
const DOCS_EXT = /\.(md|mdx|rst|txt|adoc|asciidoc|tex)$/i
const DOCS_NAME = /(readme|changelog|contributing|license|licence|authors|maintainers|code_of_conduct)/i
const DESIGN_EXT = /\.(png|jpg|jpeg|gif|svg|webp|ico|bmp|tiff?|fig|sketch|psd|ai|eps|pdf|icns|heic)$/i
const FRONTEND_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|styl|html|htm)$/i
const FULLSTACK_PATH =
  /(^|\/)app\/.*\/route\.(ts|js)$|(^|\/)app\/.*\/(layout|template|loading|error|not-found)\.(ts|tsx|js|jsx)$|(^|\/)(actions|loaders)\.(ts|js)$|(^|\/)(trpc|rpc)\//i
const CONFIG_PATH =
  /(^|\/)(package\.json|tsconfig.*|jsconfig.*|\.eslintrc.*|\.prettierrc.*|webpack\.config.*|vite\.config.*|rollup\.config.*|turbo\.json|nx\.json|pnpm-workspace.*|Cargo\.toml|Cargo\.lock|go\.mod|requirements.*|Pipfile.*|pyproject\.toml|Gemfile.*|pom\.xml|build\.gradle.*|composer\.json|\.gitignore|\.editorconfig)$/i
const CONFIG_INFER =
  /(^|\/)(\.github\/|\.gitlab\/|\.circleci\/|ci\/|cd\/|deploy\/|infra\/|infrastructure\/|k8s\/|kubernetes\/|helm\/|terraform\/|docker\/|scripts\/|ops\/|sre\/)/i
const CONFIG_EXT =
  /\.(config|rc)\.(t|j)sx?$|\.config\.(m|c)?js$|^(dockerfile|docker-compose|compose|jenkinsfile|makefile|taskfile)$/i
const CONFIG_FILE_EXT = /\.(tf|tfvars|yaml|yml|toml|ini|env)$/i
const BACKEND_EXT =
  /\.(ts|js|mjs|cjs|py|rb|go|rs|java|kt|kts|scala|sc|c|cpp|cc|cxx|h|hpp|cs|swift|php|clj|cljs|ex|exs|erl|fs|hs|lua|r|jl|dart)$/i
/**
 * Data-engineering work: schema and migration files, and anything under a
 * migrations directory. Checked before the backend extension list, since a
 * migration written in TypeScript is data work, not backend work.
 */
const DATA_PATH =
  /\.sql$|(^|\/)(migrations?|seeds?)\/|(^|\/)schema\.(prisma|sql|rb|ts|js)$|(^|\/)(prisma\/|dbt\/|warehouse\/|etl\/|pipelines?\/)|\.(avsc|parquet)$/i

const AUTH_HINT =
  /(auth|login|logout|signin|signout|signup|register|session|jwt|token|password|credential|oauth|sso|saml|permission|rbac|passport|cognito|authoriz|authentic)/i
const DATA_HINT =
  /(migration|migrate|schema|model|entity|prisma|sequelize|typeorm|knex|db|database|dao|repository|orm|drizzle|supabase|dynamodb|redis|mongo|etl|pipeline)/i
const INFRA_HINT =
  /(dockerfile|compose|\.github\/workflows|terraform|\.tf|k8s|kubernetes|helm|deploy|infrastructure|infra\/|ci\/|cd\/|\.circleci|jenkinsfile|ansible|nomad|consul|vault|argocd|skaffold|kustomize|nginx|istio|serverless|cloudformation|\.eks|gke|aks)/i

/**
 * Set the auth/data/infra sensitivity flags from a batch of file paths.
 * Mutates `stats` and is additive — flags are never cleared, so callers can
 * feed paths in from several sources (writes, reads, a VCS diff).
 */
export function applyPathFlags(
  stats: Pick<TranscriptStats, "touchesAuth" | "touchesData" | "touchesInfra">,
  paths: readonly string[],
): void {
  for (const p of paths) {
    if (AUTH_HINT.test(p)) stats.touchesAuth = true
    if (DATA_HINT.test(p)) stats.touchesData = true
    if (INFRA_HINT.test(p)) stats.touchesInfra = true
  }
}

export function classifyDomain(filePath: string): FileDomain {
  const p = filePath
  if (TEST_PATH.test(p)) return "test"
  if (DESIGN_EXT.test(p)) return "design"
  if (DOCS_EXT.test(p) || DOCS_NAME.test(p.split("/").pop() ?? "")) return "docs"
  if (CONFIG_PATH.test(p) || CONFIG_INFER.test(p) || CONFIG_EXT.test(p) || CONFIG_FILE_EXT.test(p)) {
    return "config"
  }
  if (DATA_PATH.test(p)) return "data"
  if (FULLSTACK_PATH.test(p)) return "fullstack"
  if (FRONTEND_EXT.test(p)) return "frontend"
  if (BACKEND_EXT.test(p)) return "backend"
  return "other"
}

// ---------------------------------------------------------------------------
// Count lines in a string
// ---------------------------------------------------------------------------

function lineCount(s: string | undefined | null): number {
  if (!s) return 0
  // A trailing newline ends the last line rather than starting a new one:
  // "a\nb\n" is 2 lines, not 3.
  const withoutTrailing = s.endsWith("\n") ? s.slice(0, -1) : s
  if (withoutTrailing === "") return s.length > 0 ? 1 : 0
  return withoutTrailing.split("\n").length
}

// ---------------------------------------------------------------------------
// Stdin parsing
// ---------------------------------------------------------------------------

export function parseStatusLineStdin(input: string): StatusLineInput {
  const trimmed = input.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed) as StatusLineInput
  } catch {
    process.stderr.write("realistic-cost: ignoring invalid status-line JSON on stdin\n")
    return {}
  }
}

// ---------------------------------------------------------------------------
// Transcript JSONL parsing
// ---------------------------------------------------------------------------

interface ToolUseBlock {
  type: "tool_use"
  id: string
  name: string
  input: Record<string, unknown>
}

interface TextBlock {
  type: "text"
  text: string
}

interface ThinkingBlock {
  type: "thinking"
  thinking: string
}

type ContentBlock = ToolUseBlock | TextBlock | ThinkingBlock | { type: string; [k: string]: unknown }

interface TranscriptLine {
  type?: string
  role?: string
  message?: { role?: string; content?: ContentBlock | ContentBlock[] | string }
  content?: ContentBlock | ContentBlock[] | string
  toolUseResult?: unknown
  isMeta?: boolean
  isSidechain?: boolean
}

function asArray<T>(x: T | T[] | undefined): T[] {
  if (x === undefined) return []
  return Array.isArray(x) ? x : [x]
}

function getBlocks(line: TranscriptLine): ContentBlock[] {
  const content = line.message?.content ?? line.content
  if (typeof content === "string") {
    return [{ type: "text", text: content } as TextBlock]
  }
  return asArray(content)
}

function isToolUse(b: ContentBlock): b is ToolUseBlock {
  return b?.type === "tool_use"
}

/**
 * Parse a Claude Code transcript JSONL file into TranscriptStats.
 *
 * The transcript is append-only JSONL; each line is a message (user/assistant/
 * system). Assistant messages carry tool_use blocks; user messages carry
 * tool_result blocks keyed by tool_use_id.
 */
export function parseTranscript(transcriptPath: string): TranscriptStats {
  const stats = emptyStats(transcriptPath)

  let raw: string
  try {
    raw = readFileSync(transcriptPath, "utf8")
  } catch (err) {
    process.stderr.write(
      `realistic-cost: cannot read transcript ${transcriptPath} (${err instanceof Error ? err.message : String(err)}) — falling back to empty stats\n`,
    )
    return stats
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let entry: TranscriptLine
    try {
      entry = JSON.parse(line) as TranscriptLine
    } catch {
      continue
    }
    // Skip meta / sidechain (subagent) lines — we only want the main thread.
    if (entry.isMeta || entry.isSidechain) continue

    const role = entry.message?.role ?? entry.role ?? entry.type
    // User-role tool_result lines don't change counts; results are already
    // accounted for by the tool_use that produced them.
    if (role !== "assistant") continue

    stats.assistantTurns += 1
    let hadThinking = false
    for (const b of getBlocks(entry)) {
      if (b?.type === "thinking") {
        hadThinking = true
        stats.thinkingTokens += Math.ceil(((b as ThinkingBlock).thinking ?? "").length / 4)
      } else if (isToolUse(b)) {
        recordToolCall(stats, b.name ?? "", b.input ?? {})
      }
    }
    if (hadThinking) stats.thinkingTurns += 1
  }

  applyPathFlags(stats, [...stats.fileWrites.map((w) => w.path), ...stats.filesReadPaths])

  // Line counts default to the sum of parsed write ops. Callers with more
  // authoritative numbers (status-line cost block) overwrite these.
  stats.linesAdded = stats.fileWrites.reduce((s, w) => s + w.linesAdded, 0)
  stats.linesRemoved = stats.fileWrites.reduce((s, w) => s + w.linesRemoved, 0)

  return stats
}

function recordToolCall(stats: TranscriptStats, name: string, input: Record<string, unknown>): void {
  stats.toolCalls.total += 1
  // Harnesses disagree on tool-name casing (Claude Code "Edit", opencode
  // "edit"), so match on a single normalized form.
  switch (name.toLowerCase()) {
    case "read":
      stats.toolCalls.read += 1
      {
        const p = filePathOf(input)
        if (p) stats.filesReadPaths.push(p)
      }
      break
    case "write":
      stats.toolCalls.write += 1
      stats.fileWrites.push(buildWriteOp("Write", input))
      break
    case "edit":
    case "notebookedit":
      stats.toolCalls.edit += 1
      stats.fileWrites.push(buildWriteOp("Edit", input))
      break
    case "multiedit":
      stats.toolCalls.edit += 1
      stats.fileWrites.push(buildWriteOp("MultiEdit", input))
      break
    case "glob":
    case "list":
      stats.toolCalls.glob += 1
      break
    case "grep":
    case "search":
      stats.toolCalls.grep += 1
      break
    case "bash":
    case "pty":
      stats.toolCalls.bash += 1
      break
    case "task":
      stats.toolCalls.task += 1
      break
    default:
      stats.toolCalls.other += 1
      break
  }
}

/**
 * Tool inputs are recorded verbatim from the harness, and the harnesses do not
 * agree on casing: Claude Code writes snake_case (`file_path`, `old_string`),
 * other clients and older transcripts use camelCase. Reading only one spelling
 * silently scores those writes as zero lines, so every accessor tries both.
 */
function pick(input: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = input[k]
    if (typeof v === "string") return v
    if (typeof v === "number" || typeof v === "boolean") return String(v)
  }
  return ""
}

function filePathOf(input: Record<string, unknown>): string {
  return pick(input, "file_path", "filePath", "path", "notebook_path", "notebookPath")
}

function buildWriteOp(tool: FileWriteOp["tool"], input: Record<string, unknown>): FileWriteOp {
  const p = filePathOf(input) || "<unknown>"
  const domain = classifyDomain(p)
  let linesAdded = 0
  let linesRemoved = 0
  if (tool === "Write") {
    // Full content write = all lines "added".
    linesAdded = lineCount(pick(input, "content", "new_string", "newString"))
  } else if (tool === "Edit") {
    linesRemoved = lineCount(pick(input, "old_string", "oldString"))
    linesAdded = lineCount(pick(input, "new_string", "newString"))
  } else if (tool === "MultiEdit") {
    // edits: array of {old_string, new_string}
    const edits = Array.isArray(input.edits) ? input.edits : []
    for (const e of edits) {
      if (e && typeof e === "object") {
        const edit = e as Record<string, unknown>
        linesRemoved += lineCount(pick(edit, "old_string", "oldString"))
        linesAdded += lineCount(pick(edit, "new_string", "newString"))
      }
    }
  }
  return { path: p, tool, linesAdded, linesRemoved, domain }
}

// ---------------------------------------------------------------------------
// Build stats from a StatusLineInput (uses parseTranscript if transcript_path)
// ---------------------------------------------------------------------------

export function buildStatsFromStatusLine(input: StatusLineInput): TranscriptStats {
  const transcriptPath = input.transcript_path ?? ""
  const base: TranscriptStats = transcriptPath ? parseTranscript(transcriptPath) : emptyStats(transcriptPath)
  // Override with authoritative line/duration numbers from the status line.
  base.linesAdded = input.cost?.total_lines_added ?? base.linesAdded
  base.linesRemoved = input.cost?.total_lines_removed ?? base.linesRemoved
  base.durationMs = input.cost?.total_duration_ms ?? base.durationMs
  return base
}

/**
 * A zeroed-out stats object — the neutral baseline when no transcript can be
 * resolved (empty stdin, TTY, auto-discovery miss).
 */
export function emptyStats(transcriptPath = ""): TranscriptStats {
  return {
    transcriptPath,
    toolCalls: { read: 0, write: 0, edit: 0, glob: 0, grep: 0, bash: 0, task: 0, other: 0, total: 0 },
    thinkingTurns: 0,
    thinkingTokens: 0,
    assistantTurns: 0,
    fileWrites: [],
    filesReadPaths: [],
    durationMs: 0,
    linesAdded: 0,
    linesRemoved: 0,
    touchesAuth: false,
    touchesData: false,
    touchesInfra: false,
  }
}
