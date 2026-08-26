import { readFileSync, readdirSync, statSync, type Dirent } from "node:fs"
import { join } from "node:path"
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
  /** Identifies which subagent produced a sidechain line (newer transcripts). */
  agentId?: string
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
 * Every subagent sidecar transcript belonging to a session, sorted by path.
 *
 * Claude Code writes a subagent's turns to a sidecar JSONL next to the parent
 * transcript: `<transcript-without-.jsonl>/subagents/**\/agent-*.jsonl`, one
 * file per subagent, nested a further level for workflow runs
 * (`subagents/workflows/<wf-id>/agent-*.jsonl`). Files that are not subagent
 * transcripts (a workflow's `journal.jsonl`, the `.meta.json` sidecars) live in
 * the same directories, so match on the `agent-` prefix rather than on
 * `.jsonl` alone.
 *
 * Older Claude Code versions kept subagent turns inline in the parent file as
 * `isSidechain: true` lines instead; those need no discovery and are handled
 * by the parser directly.
 */
export function listSubagentTranscripts(transcriptPath: string): string[] {
  if (!transcriptPath) return []
  const root = join(transcriptPath.replace(/\.jsonl$/i, ""), "subagents")
  const out: string[] = []
  // Bounded walk: a runaway directory must not stall a status line that
  // re-runs on every UI refresh.
  const MAX_DEPTH = 6
  const MAX_FILES = 1000
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile() && /^agent-.*\.jsonl$/i.test(e.name)) out.push(full)
    }
  }
  walk(root, 0)
  return out.sort()
}

/**
 * A cheap fingerprint of everything `parseTranscript` will read: the parent
 * transcript plus every subagent sidecar. Callers cache parse results against
 * this, so a subagent appending to its own file still invalidates the cache
 * even when the parent transcript has not moved for minutes.
 */
export function transcriptSignature(transcriptPath: string): string {
  const parts: string[] = []
  for (const p of [transcriptPath, ...listSubagentTranscripts(transcriptPath)]) {
    try {
      const st = statSync(p)
      parts.push(`${p}:${st.mtimeMs}:${st.size}`)
    } catch {
      parts.push(`${p}:missing`)
    }
  }
  return parts.join("|")
}

/**
 * Parse a Claude Code transcript JSONL file into TranscriptStats.
 *
 * The transcript is append-only JSONL; each line is a message (user/assistant/
 * system). Assistant messages carry tool_use blocks; user messages carry
 * tool_result blocks keyed by tool_use_id.
 *
 * Subagent work counts: a human team would have done it too. Sidechain lines
 * in this file and every `subagents/` sidecar transcript are folded into the
 * same stats. That is additive rather than double-counting — the parent thread
 * records only the Task call and its text result, never the subagent's own
 * writes.
 */
export function parseTranscript(transcriptPath: string): TranscriptStats {
  const stats = emptyStats(transcriptPath)
  const agents = new Set<string>()

  ingestTranscriptFile(stats, agents, transcriptPath, { warn: true })
  for (const sub of listSubagentTranscripts(transcriptPath)) {
    // One sidecar file is one subagent by construction, so the file itself is
    // the identity — no need for the lines inside it to carry an agentId.
    ingestTranscriptFile(stats, agents, sub, { warn: false, subagentKey: sub })
  }
  stats.subagents = agents.size

  applyPathFlags(stats, [...stats.fileWrites.map((w) => w.path), ...stats.filesReadPaths])

  // Line counts default to the sum of parsed write ops. Callers with more
  // authoritative numbers (status-line cost block) overwrite these.
  stats.linesAdded = stats.fileWrites.reduce((s, w) => s + w.linesAdded, 0)
  stats.linesRemoved = stats.fileWrites.reduce((s, w) => s + w.linesRemoved, 0)

  return stats
}

/**
 * Fold one JSONL file's assistant turns into `stats`. `agents` collects an id
 * per distinct subagent seen, so the caller can report how many contributed.
 *
 * `warn` is set only for the parent transcript: a missing sidecar is normal
 * (the session simply spawned no subagents), a missing parent is worth saying.
 * `subagentKey` names the one subagent a sidecar file belongs to; without it
 * (the parent transcript) each sidechain line is attributed by its own
 * `agentId`.
 */
function ingestTranscriptFile(
  stats: TranscriptStats,
  agents: Set<string>,
  path: string,
  { warn, subagentKey }: { warn: boolean; subagentKey?: string },
): void {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch (err) {
    if (warn) {
      process.stderr.write(
        `realistic-cost: cannot read transcript ${path} (${err instanceof Error ? err.message : String(err)}) — falling back to empty stats\n`,
      )
    }
    return
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue
    let entry: TranscriptLine
    try {
      entry = JSON.parse(line) as TranscriptLine
    } catch {
      continue
    }
    // Meta lines are harness bookkeeping, not work — still skipped.
    if (entry.isMeta) continue

    const role = entry.message?.role ?? entry.role ?? entry.type
    // User-role tool_result lines don't change counts; results are already
    // accounted for by the tool_use that produced them.
    if (role !== "assistant") continue

    stats.assistantTurns += 1
    // Attribute the turn to a subagent, if it came from one. `agentId` is
    // absent on older inline-sidechain transcripts, so the file is the
    // fallback identity there too.
    if (subagentKey) agents.add(subagentKey)
    else if (entry.isSidechain) {
      agents.add(typeof entry.agentId === "string" && entry.agentId ? entry.agentId : path)
    }
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
}

function recordToolCall(stats: TranscriptStats, name: string, input: Record<string, unknown>): void {
  stats.toolCalls.total += 1
  // Cross-team tagging is deliberately NOT one of the buckets below: an MCP
  // call is still a read, a search or a fetch for the purpose of work time.
  // It just costs extra coordination on top.
  recordMcpCall(stats, name)
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
      if (isWebTool(name)) stats.toolCalls.web += 1
      else stats.toolCalls.other += 1
      break
  }
}

/**
 * Whether a tool call is a web request — a fetch or a search that returns a
 * page to read, rather than a local file or command.
 *
 * Matched on a normalized substring so plugin- and MCP-prefixed variants
 * (`mcp__something__webfetch`) count too, since the reading cost is the same
 * whoever wrapped the call.
 */
/**
 * The MCP server behind a tool call, or "" if the call was a local tool.
 *
 * Claude Code names MCP tools `mcp__<server>__<tool>`, which is unambiguous.
 * opencode flattens them to `<server>_<tool>`, which is NOT — `pty_spawn` and
 * `graphify_recall` look identical, and only one of them is another team. So
 * the caller may pass the servers it knows are configured, and a flattened
 * name is only treated as MCP when it matches one of them. Given no list,
 * opencode-style calls stay unattributed rather than being guessed at: over-
 * counting departments would inflate the bill on every plugin tool.
 */
export function mcpServerOf(name: string, knownServers: readonly string[] = []): string {
  const explicit = /^mcp__([^_].*?)__/.exec(name)
  if (explicit?.[1]) return explicit[1]
  for (const server of knownServers) {
    if (!server) continue
    if (name === server || name.startsWith(server + "_")) return server
  }
  return ""
}

export function isWebTool(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z]/g, "")
  return n.includes("webfetch") || n.includes("websearch")
}

/**
 * Tag a tool call as cross-team if it went to an MCP server, tracking the
 * distinct servers so the management cost can be charged per department
 * rather than per request.
 */
export function recordMcpCall(
  stats: Pick<TranscriptStats, "mcpCalls" | "mcpServers">,
  name: string,
  knownServers: readonly string[] = [],
): void {
  const server = mcpServerOf(name, knownServers)
  if (!server) return
  stats.mcpCalls += 1
  if (!stats.mcpServers.includes(server)) stats.mcpServers.push(server)
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
    toolCalls: { read: 0, write: 0, edit: 0, glob: 0, grep: 0, bash: 0, task: 0, web: 0, other: 0, total: 0 },
    thinkingTurns: 0,
    thinkingTokens: 0,
    assistantTurns: 0,
    subagents: 0,
    mcpCalls: 0,
    mcpServers: [],
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
