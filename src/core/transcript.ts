import { readFileSync } from "node:fs"
import type {
  FileDomain,
  FileWriteOp,
  StatusLineInput,
  TranscriptStats,
} from "./types.js"

// ---------------------------------------------------------------------------
// Domain classification by file path/extension
// ---------------------------------------------------------------------------

const TEST_PATH = /(\.|_|-)(test|spec)\.(t|j)sx?$|(^|\/)(test|tests|__tests__|spec|specs)\//i
const DOCS_EXT = /\.(md|mdx|rst|txt|adoc|asciidoc|tex)$/i
const DOCS_NAME = /(readme|changelog|contributing|license|licence|authors|maintainers|code_of_conduct)/i
const DESIGN_EXT = /\.(png|jpg|jpeg|gif|svg|webp|ico|bmp|tiff?|fig|sketch|psd|ai|eps|pdf|icns|heic)$/i
const FRONTEND_EXT = /\.(tsx|jsx|vue|svelte|astro|css|scss|sass|less|styl|html|htm)$/i
const FULLSTACK_PATH = /(^|\/)app\/.*\/route\.(ts|js)$|(^|\/)app\/.*\/(layout|template|loading|error|not-found)\.(ts|tsx|js|jsx)$|(^|\/)(actions|loaders)\.(ts|js)$|(^|\/)(trpc|rpc)\//i
const CONFIG_PATH =
  /(^|\/)(package\.json|tsconfig.*|jsconfig.*|\.eslintrc.*|\.prettierrc.*|webpack\.config.*|vite\.config.*|rollup\.config.*|turbo\.json|nx\.json|pnpm-workspace.*|Cargo\.toml|Cargo\.lock|go\.mod|requirements.*|Pipfile.*|pyproject\.toml|Gemfile.*|pom\.xml|build\.gradle.*|composer\.json|\.gitignore|\.editorconfig)$/i
const CONFIG_INFER = /(^|\/)(\.github\/|\.gitlab\/|\.circleci\/|ci\/|cd\/|deploy\/|infra\/|infrastructure\/|k8s\/|kubernetes\/|helm\/|terraform\/|docker\/|scripts\/|ops\/|sre\/)/i
const CONFIG_EXT = /\.(config|rc)\.(t|j)sx?$|\.config\.(m|c)?js$|^(dockerfile|docker-compose|compose|jenkinsfile|makefile|taskfile)$/i
const CONFIG_FILE_EXT = /\.(tf|tfvars|yaml|yml|toml|ini|env)$/i
const BACKEND_EXT = /\.(ts|js|mjs|cjs|py|rb|go|rs|java|kt|kts|scala|sc|c|cpp|cc|cxx|h|hpp|cs|swift|php|clj|cljs|ex|exs|erl|fs|hs|lua|r|jl|dart|sql)$/i

const AUTH_HINT = /(auth|login|logout|signin|signout|signup|register|session|jwt|token|password|credential|oauth|sso|saml|permission|rbac|passport|cognito|authoriz|authentic)/i
const DATA_HINT = /(migration|migrate|schema|model|entity|prisma|sequelize|typeorm|knex|db|database|dao|repository|orm|drizzle|supabase|dynamodb|redis|mongo|etl|pipeline)/i
const INFRA_HINT = /(dockerfile|compose|\.github\/workflows|terraform|\.tf|k8s|kubernetes|helm|deploy|infrastructure|infra\/|ci\/|cd\/|\.circleci|jenkinsfile|ansible|nomad|consul|vault|argocd|skaffold|kustomize|nginx|istio|serverless|cloudformation|\.eks|gke|aks)/i

export function classifyDomain(filePath: string): FileDomain {
  const p = filePath
  if (TEST_PATH.test(p)) return "test"
  if (DESIGN_EXT.test(p)) return "design"
  if (DOCS_EXT.test(p) || DOCS_NAME.test(p.split("/").pop() ?? "")) return "docs"
  if (CONFIG_PATH.test(p) || CONFIG_INFER.test(p) || CONFIG_EXT.test(p) || CONFIG_FILE_EXT.test(p)) {
    return "config"
  }
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
  const stats: TranscriptStats = {
    transcriptPath,
    toolCalls: {
      read: 0,
      write: 0,
      edit: 0,
      glob: 0,
      grep: 0,
      bash: 0,
      task: 0,
      other: 0,
      total: 0,
    },
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

  let raw: string
  try {
    raw = readFileSync(transcriptPath, "utf8")
  } catch (err) {
    process.stderr.write(
      `realistic-cost: cannot read transcript ${transcriptPath} (${err instanceof Error ? err.message : String(err)}) — falling back to empty stats\n`,
    )
    return stats
  }

  const lines = raw.split("\n")
  // Map tool_use_id -> name, so we can match results.
  const toolNameById = new Map<string, string>()

  for (const line of lines) {
    if (!line.trim()) continue
    let entry: TranscriptLine
    try {
      entry = JSON.parse(line) as TranscriptLine
    } catch {
      continue
    }
    // Skip meta / sidechain (subagent) lines — we only want the main thread.
    if (entry.isMeta || entry.isSidechain) continue

    const blocks = getBlocks(entry)
    const role = entry.message?.role ?? entry.role ?? entry.type

    if (role === "assistant") {
      stats.assistantTurns += 1
      let hadThinking = false
      for (const b of blocks) {
        if (b?.type === "thinking") {
          hadThinking = true
          const text = (b as ThinkingBlock).thinking ?? ""
          stats.thinkingTokens += Math.ceil(text.length / 4)
        }
      }
      if (hadThinking) stats.thinkingTurns += 1
      for (const b of blocks) {
        if (!isToolUse(b)) continue
        const name = b.name ?? ""
        const id = b.id ?? ""
        if (id) toolNameById.set(id, name)
        recordToolCall(stats, name, b.input)
      }
    }
    // User-role tool_result lines don't change counts; results already
    // accounted for by the tool_use that produced them.
  }

  // Aggregate auth/data/infra flags from written + read file paths.
  const allPaths = [
    ...stats.fileWrites.map((w) => w.path),
    ...stats.filesReadPaths,
  ]
  for (const p of allPaths) {
    if (AUTH_HINT.test(p)) stats.touchesAuth = true
    if (DATA_HINT.test(p)) stats.touchesData = true
    if (INFRA_HINT.test(p)) stats.touchesInfra = true
  }

  // Line counts default to the sum of parsed write ops. Callers with more
  // authoritative numbers (status-line cost block) overwrite these.
  stats.linesAdded = stats.fileWrites.reduce((s, w) => s + w.linesAdded, 0)
  stats.linesRemoved = stats.fileWrites.reduce((s, w) => s + w.linesRemoved, 0)

  return stats
}

function recordToolCall(stats: TranscriptStats, name: string, input: Record<string, unknown>): void {
  stats.toolCalls.total += 1
  switch (name) {
    case "Read":
    case "read":
      stats.toolCalls.read += 1
      {
        const p = String(input.filePath ?? input.path ?? input.file_path ?? "")
        if (p) stats.filesReadPaths.push(p)
      }
      break
    case "Write":
    case "write":
      stats.toolCalls.write += 1
      stats.fileWrites.push(buildWriteOp("Write", input))
      break
    case "Edit":
    case "edit":
      stats.toolCalls.edit += 1
      stats.fileWrites.push(buildWriteOp("Edit", input))
      break
    case "MultiEdit":
    case "multiedit":
      stats.toolCalls.edit += 1
      stats.fileWrites.push(buildWriteOp("MultiEdit", input))
      break
    case "Glob":
    case "glob":
      stats.toolCalls.glob += 1
      break
    case "Grep":
    case "grep":
      stats.toolCalls.grep += 1
      break
    case "Bash":
    case "bash":
    case "Pty":
      stats.toolCalls.bash += 1
      break
    case "Task":
    case "task":
      stats.toolCalls.task += 1
      break
    default:
      stats.toolCalls.other += 1
      break
  }
}

// Edit/MultiEdit tool inputs use snake_case (`old_string`/`new_string`) in real
// Claude Code transcripts. Older fixtures — and some third-party harnesses —
// use camelCase. Read both, or every Edit contributes zero lines.
function editStr(input: Record<string, unknown>, which: "old" | "new"): string {
  const snake = which === "old" ? input.old_string : input.new_string
  const camel = which === "old" ? input.oldString : input.newString
  return String(snake ?? camel ?? "")
}

function buildWriteOp(
  tool: FileWriteOp["tool"],
  input: Record<string, unknown>,
): FileWriteOp {
  const p = String(input.filePath ?? input.path ?? input.file_path ?? "<unknown>")
  const domain = classifyDomain(p)
  let linesAdded = 0
  let linesRemoved = 0
  if (tool === "Write") {
    // Full content write = all lines "added".
    const content = String(input.content ?? "")
    linesAdded = lineCount(content)
  } else if (tool === "Edit") {
    linesRemoved = lineCount(editStr(input, "old"))
    linesAdded = lineCount(editStr(input, "new"))
  } else if (tool === "MultiEdit") {
    // edits: array of {old_string, new_string}
    const edits = Array.isArray(input.edits) ? input.edits : []
    for (const e of edits) {
      if (e && typeof e === "object") {
        const edit = e as Record<string, unknown>
        linesRemoved += lineCount(editStr(edit, "old"))
        linesAdded += lineCount(editStr(edit, "new"))
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
  const base: TranscriptStats = transcriptPath
    ? parseTranscript(transcriptPath)
    : emptyStats(transcriptPath)
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
