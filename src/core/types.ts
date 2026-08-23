/**
 * realistic-cost — core type contract & cost-model specification.
 *
 * SINGLE SOURCE OF TRUTH. Implementations live in transcript.ts, estimate.ts,
 * cost.ts, report.ts. This docstring describes the model AS IMPLEMENTED —
 * if code and doc ever disagree, fix one of them deliberately.
 *
 * ============================================================================
 * THE MODEL (metadata-driven, no git diff)
 * ============================================================================
 *
 * GOAL: Given Claude Code session metadata — line counts, duration, and a
 * parsed transcript of tool calls — estimate what a 100% human-driven
 * engineering team would cost to produce the same work, across ALL job
 * functions. Numbers are estimates for framing, not invoices.
 *
 * INPUTS (all available as metadata, no source-code analysis):
 *   status-line stdin JSON:
 *     cost.total_lines_added, cost.total_lines_removed
 *     cost.total_duration_ms, cost.total_cost_usd
 *     transcript_path  -> JSONL of every turn
 *   transcript JSONL parse (main thread only; subagent sidechains excluded):
 *     tool-call counts (Read, Write, Edit, Glob, Grep, Bash, Task)
 *     per-write file paths + line counts (for role split by file extension)
 *     thinking turns/tokens (assistant reasoning volume)
 *
 * ----------------------------------------------------------------------------
 * 1. DOMAIN CLASSIFICATION (by file path of Write/Edit targets):
 *    backend   (.ts/.js/.py/.go/.rs/.java/... minus FE/test/docs)
 *    frontend  (.tsx/.jsx/.vue/.svelte/.css/.html/...)
 *    fullstack (app/ route files)
 *    docs      (.md/.mdx/.rst)
 *    config    (dockerfile/.tf/.github/yaml/toml/package.json/tsconfig)
 *    test      (files named .test. or .spec. or under a __tests__ dir)
 *    design    (.png/.svg/.fig/...)
 *    other     (fallback)
 *
 * 2. IMPLEMENTATION HOURS (productive lines/hr by domain):
 *    backend 12, frontend 15, fullstack 13, docs 30, config 8, test 20, other 10
 *    Deletions (linesRemoved) billed at 0.3x (faster to remove).
 *    Per-write complexity multipliers (product capped at 6x):
 *      new file (Write tool, full content)        x1.5
 *      large change (single write > 100 lines)    x1.3
 *    implHours(domain) = weightedLinesAdded / base + (removed / base) * 0.3
 *
 * 3. READING & THINKING TIME:
 *    searchReadHours = searches*0.25 + reads*0.15   (defaults; configurable)
 *    Half is billed to engineers as code comprehension (added to their impl
 *    hours); the other half plus thinkingTurns*0.10 is reported as
 *    discoveryHours — an informational metric (planning/research a human
 *    team would also spend).
 *
 * 4. ROLE ALLOCATION of implementation:
 *    backend   -> backend role
 *    frontend  -> frontend role
 *    fullstack -> fullstack (split 50/50 be/fe if both present)
 *    docs      -> techwriter role
 *    config    -> devops role
 *    test      -> qa role (QA writing tests themselves)
 *    design    -> designer role (count * 2h)
 *    other     -> backend role (most common fallback)
 *
 * 5. ROLE OVERHEAD (multipliers configurable via EstimateOptions):
 *    peer review: each eng role +0.35x its impl
 *    PM:          0.15 x implHours, min 3h  (spec, acceptance, coordination)
 *    EM:          0.10 x implHours, min 3h  (planning, standups, unblocking)
 *    QA:          0.35 x implHours if the session wrote test files, else 0.50
 *    Designer:    +0.60 x (FE+FS) if frontend present
 *    DevOps:      +0.15 x (BE+FE+FS)  (deploy/CI)
 *    Security:    0.15 x implHours if auth/data/infra files touched else 0.05
 *    TechWriter:  +0.10 x implHours  (changelogs/API docs beyond docs written)
 *
 * 6. COST — the receipt (single source of the grand total):
 *    Value creation cost X = thinking (reasoning tokens x $0.05) +
 *      comprehension + coding + design + peer review + QA + deploy +
 *      security review — all derived from the role estimate above.
 *    Management = the estimate's PM and EM role costs, verbatim.
 *    Coordination tax = 20% of the grand total (meetings, issue management),
 *      so: grandTotal = (X + pmCost + emCost) / 0.80.
 *    report.roles is a parallel per-role VIEW of the same work: role costs
 *    are role.totalHours x rate with percentage relative to the grand total
 *    (they do not include the cross-role coordination tax, so they sum to
 *    ~80%, not 100%).
 *
 * 7. CALENDAR (team effort, not elapsed wall-clock):
 *    manDays = totalHours / productiveHoursPerDay (default 8)
 *    humanReadable = "X hours" / "Y man-days" / "Z weeks, D man-days"
 * ============================================================================
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type RoleId =
  | "pm"
  | "em"
  | "designer"
  | "backend"
  | "frontend"
  | "fullstack"
  | "qa"
  | "devops"
  | "security"
  | "data"
  | "techwriter"

export type RoleCategory =
  | "management"
  | "design"
  | "engineering"
  | "quality"
  | "ops"
  | "security"
  | "data"

export interface Role {
  id: RoleId
  title: string
  category: RoleCategory
  defaultHourlyRate: number
}

// ---------------------------------------------------------------------------
// Status-line stdin JSON (subset we consume)
// ---------------------------------------------------------------------------

export interface StatusLineInput {
  model?: { display_name?: string }
  workspace?: { current_dir?: string; project_dir?: string }
  cost?: {
    total_cost_usd?: number
    total_duration_ms?: number
    total_lines_added?: number
    total_lines_removed?: number
  }
  context_window?: {
    used?: number
    total?: number
  }
  session_id?: string
  session_name?: string
  transcript_path?: string
  version?: string
}

// ---------------------------------------------------------------------------
// Transcript parse output
// ---------------------------------------------------------------------------

export type FileDomain =
  | "backend"
  | "frontend"
  | "fullstack"
  | "docs"
  | "config"
  | "test"
  | "design"
  | "other"

export interface FileWriteOp {
  path: string
  tool: "Write" | "Edit" | "MultiEdit"
  linesAdded: number
  linesRemoved: number
  domain: FileDomain
}

export interface TranscriptStats {
  transcriptPath: string
  toolCalls: {
    read: number
    write: number
    edit: number
    glob: number
    grep: number
    bash: number
    task: number
    other: number
    total: number
  }
  thinkingTurns: number
  thinkingTokens: number
  assistantTurns: number
  fileWrites: FileWriteOp[]
  filesReadPaths: string[]
  durationMs: number
  linesAdded: number
  linesRemoved: number
  /** file paths that touched auth/data/infra (by name heuristics) */
  touchesAuth: boolean
  touchesData: boolean
  touchesInfra: boolean
}

// ---------------------------------------------------------------------------
// Estimation
// ---------------------------------------------------------------------------

export interface EstimateOptions {
  reviewOverheadMultiplier?: number
  qaOverheadMultiplier?: number
  qaWithTestsMultiplier?: number
  designOverheadMultiplier?: number
  pmOverheadMultiplier?: number
  emOverheadMultiplier?: number
  devopsDeployMultiplier?: number
  securitySensitiveMultiplier?: number
  securityNormalMultiplier?: number
  techwriterOverheadMultiplier?: number
  discoverySearchHours?: number
  discoveryReadHours?: number
  discoveryThinkingHours?: number
}

export interface RoleEstimate {
  role: RoleId
  title: string
  category: RoleCategory
  implementationHours: number
  overheadHours: number
  totalHours: number
  note: string
}

export interface DomainStats {
  files: number
  /** number of full-file Write ops (new files) */
  newFiles: number
  linesAdded: number
  /** linesAdded weighted by per-write complexity multipliers (new file, large change) */
  weightedLinesAdded: number
  linesRemoved: number
  hours: number
}

export interface EstimateResult {
  roles: RoleEstimate[]
  implementationHours: number
  discoveryHours: number
  totalProductiveHours: number
  domainBreakdown: Record<FileDomain, DomainStats>
}

// ---------------------------------------------------------------------------
// Cost & calendar
// ---------------------------------------------------------------------------

export interface CostOptions {
  rates?: Partial<Record<RoleId, number>>
  productiveHoursPerDay?: number
  /** Actual AI session cost in USD, shown alongside the human estimate. */
  aiCost?: number
  /**
   * The EstimateOptions used to produce `estimate`. Passed through so the
   * activity receipt applies the same multipliers as the role model.
   */
  estimateOptions?: EstimateOptions
}

export interface RoleCost {
  role: RoleId
  title: string
  category: RoleCategory
  hours: number
  hourlyRate: number
  cost: number
  percentage: number
}

export interface CalendarEstimate {
  manDays: number
  humanReadable: string
}

export type ActivitySection = "management" | "value" | "coordination"

export interface ActivityCost {
  activity: string
  hours: number
  cost: number
  percentage: number
  section: ActivitySection
}

export interface CostReport {
  stats: TranscriptStats
  estimate: EstimateResult
  roles: RoleCost[]
  activities: ActivityCost[]
  totalCost: number
  totalHours: number
  calendar: CalendarEstimate
  generatedAt: string
  rates: Record<RoleId, number>
  aiCost: number
  aiDurationMs: number
  aiLinesAdded: number
  aiLinesRemoved: number
}

// ---------------------------------------------------------------------------
// Public engine API — see sibling modules for implementations:
//   transcript.ts: classifyDomain, parseTranscript, parseStatusLineStdin,
//                  buildStatsFromStatusLine
//   estimate.ts:   estimateHours(stats, options?) -> EstimateResult
//   cost.ts:       computeCost({ stats, estimate, rates?, options? }) -> CostReport
//   report.ts:     formatStatusLine, formatMarkdown,
//                  formatHtml  (each (report: CostReport) => string)
// ---------------------------------------------------------------------------

