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
 *   transcript JSONL parse (main thread AND every subagent it spawned):
 *     tool-call counts (Read, Write, Edit, Glob, Grep, Bash, Task)
 *     per-write file paths + line counts (for role split by file extension)
 *     thinking turns/tokens (assistant reasoning volume)
 *   Subagent work is real work a human team would also have done, so it is
 *   counted. Claude Code stores it two ways depending on version — inline in
 *   the main JSONL as `isSidechain: true` lines, or in sidecar transcripts
 *   under `<transcript-without-.jsonl>/subagents/**\/agent-*.jsonl` — and both
 *   are ingested. A subagent's writes never also appear on the main thread
 *   (the parent only sees the Task call and its text result), so the merge is
 *   additive, not double-counting.
 *   NOTE: tool inputs are read in BOTH snake_case (file_path, old_string —
 *   what Claude Code writes) and camelCase. Reading one spelling only scores
 *   the other's writes as zero lines.
 *
 * ----------------------------------------------------------------------------
 * 1. DOMAIN CLASSIFICATION (by file path of Write/Edit targets):
 *    backend   (.ts/.js/.py/.go/.rs/.java/... minus FE/data/test/docs)
 *    frontend  (.tsx/.jsx/.vue/.svelte/.css/.html/...)
 *    fullstack (app/ route files)
 *    data      (.sql, migrations/, schema.prisma, dbt/, etl/)
 *    docs      (.md/.mdx/.rst)
 *    config    (dockerfile/.tf/.github/yaml/toml/package.json/tsconfig)
 *    test      (files named .test. or .spec. or under a __tests__ dir)
 *    design    (.png/.svg/.fig/...)
 *    other     (fallback)
 *
 * 2. IMPLEMENTATION HOURS (productive lines/hr by domain):
 *    backend 12, frontend 15, fullstack 13, data 10, docs 30, config 8,
 *    test 20, other 10
 *    Deletions (linesRemoved) billed at 0.3x (faster to remove).
 *    Per-write complexity multipliers:
 *      new file (Write tool, full content)        x1.5
 *      large change (single write > 100 lines)    x1.3
 *    implHours(domain) = weightedLinesAdded / base + (removed / base) * 0.3
 *
 * 3. TOOL-CALL TIME (two separate charges, deliberately stacked):
 *    a) COMPREHENSION — reading code to understand it, which is not the same
 *       activity as operating the tool:
 *         searchReadHours = searches*0.25 + reads*0.15
 *       Half is billed to engineers as the "Code Comprehension" line (added to
 *       their impl hours); the other half plus thinkingTurns*0.10 is reported
 *       as discoveryHours, an informational metric.
 *    b) TOOL OPERATION — see below. A read therefore costs BOTH its
 *       comprehension time and its half-hour of tool work: understanding a
 *       file and the act of pulling it up are different costs.
 *    Every tool call stands in for a half-hour of human work
 *    (toolCallWorkHours, default 0.5) plus a half-hour of email and meeting
 *    time (toolCallCoordinationHours, default 0.5).
 *      toolWorkHours         = nonWebCalls * 0.5 + webRequestHours
 *      toolCoordinationHours = totalCalls * 0.5
 *    A web fetch or search costs a VARYING 0.5-1.0h instead of the flat 0.5h,
 *    because reading a page takes longer than reading a file and how much
 *    longer depends on the page. The variation is drawn from a generator
 *    seeded by the transcript path, so it varies call to call but a given
 *    session always prices identically — a status line that re-renders every
 *    second must not quote a different number each time.
 *    toolWorkHours is added to the engineering roles' implementation hours and
 *    billed as the "Tool Work" line. toolCoordinationHours is billed as its
 *    own coordination line, ON TOP OF the flat coordination tax in (6).
 *    thinkingTurns*0.10 is reported as discoveryHours — an informational
 *    metric (planning/research a human team would also spend).
 *
 * 4. ROLE ALLOCATION of implementation:
 *    backend   -> backend role
 *    frontend  -> frontend role
 *    fullstack -> fullstack (split 50/50 be/fe if both present)
 *    data      -> data role
 *    docs      -> techwriter role
 *    config    -> devops role
 *    test      -> qa role (QA writing tests themselves)
 *    design    -> designer role (count * 2h)
 *    other     -> backend role (most common fallback)
 *
 * 4b. CROSS-TEAM OVERHEAD — MCP servers and subagents are other teams:
 *    An MCP call is a request to another department's system and a subagent is
 *    another team entirely, so both cost more than doing the work in-house.
 *      mcpCoordinationHours      = mcpCalls * 1.0        (on top of 3's 0.5/call)
 *      subagentCoordinationHours = subagents * 2.0
 *      management                = distinctMcpServers * 4  (split PM/EM)
 *                                + subagents * 4           (EM only)
 *      mcpEngineeringHours       = distinctMcpServers * 4  (engineer OVERHEAD:
 *                                  the dev sits in those meetings too, and the
 *                                  time produces nothing)
 *      mcpDepartmentWorkHours    = mcpCalls * [2h, 5h]     (varying: the other
 *                                  department's own labour, since an MCP call
 *                                  is a request another team's system does
 *                                  real work to satisfy)
 *    MCP calls also pay a MULTIPLE of the per-call email time (factor 2):
 *    correspondence with another department costs more than with yourself.
 *    Coordination lands in the coordination section as its own line items;
 *    management is added to the PM and EM role overheads, so the roles table
 *    and the receipt agree.
 *    MCP calls are identified by the `mcp__<server>__<tool>` naming Claude Code
 *    uses. opencode flattens MCP tools to `<server>_<tool>`, indistinguishable
 *    from a builtin by name alone, so there the plugin passes the configured
 *    server list in and the match is made against that.
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
 *    All model parameters resolve through ESTIMATE_DEFAULTS in estimate.ts;
 *    cost.ts does not restate them.
 *    Value creation cost X = thinking (reasoning tokens x thinkingCostPerToken,
 *      default $0.05) +
 *      comprehension + coding + design + peer review + QA + deploy +
 *      security review — all derived from the role estimate above.
 *    Management = the estimate's PM and EM role costs, verbatim.
 *    Coordination tax = 20% of the grand total (meetings, issue management),
 *      so: grandTotal = (X + pmCost + emCost) / 0.80.
 *    report.roles is a parallel per-role VIEW of the same work: role costs
 *    are role.totalHours x rate with percentage relative to the grand total
 *    (they do not include the cross-role coordination tax, so they sum to
 *    ~80%, not 100%).
 *    Every activity line item is derived as hours x a strictly positive rate,
 *    and items below MIN_DISPLAY_HOURS are dropped — a row can never print a
 *    quantity of "0.0h" beside a non-zero amount.
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

export type RoleCategory = "management" | "design" | "engineering" | "quality" | "ops" | "security" | "data"

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
  "backend" | "frontend" | "fullstack" | "data" | "docs" | "config" | "test" | "design" | "other"

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
    /** Web fetches and searches — billed at a longer, varying read time. */
    web: number
    other: number
    total: number
  }
  thinkingTurns: number
  thinkingTokens: number
  assistantTurns: number
  /** Distinct subagents whose work is folded into these stats (0 = none). */
  subagents: number
  /** Tool calls that went to an MCP server rather than a local tool. */
  mcpCalls: number
  /** Distinct MCP servers this session talked to. */
  mcpServers: string[]
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
  /** USD per reasoning token billed as senior design time (default 0.05). */
  thinkingCostPerToken?: number
  /**
   * Hours of engineering work a single tool call stands in for (default 0.5).
   * Uniform across tool types: opening a file, running a command and making an
   * edit all represent roughly a half-hour of a human's attention.
   */
  toolCallWorkHours?: number
  /**
   * Hours of email and meeting time a single tool call drags along (default
   * 0.5) — billed as its own coordination line, on top of the flat tax.
   */
  toolCallCoordinationHours?: number
  /**
   * A web fetch or search costs somewhere in [min, max] hours instead of
   * `toolCallWorkHours` (defaults 0.5 and 1.0): reading a page is slower than
   * reading a file, and how much slower varies by page.
   */
  webRequestMinHours?: number
  webRequestMaxHours?: number
  /** Hours of code comprehension per glob/grep call (default 0.25). */
  discoverySearchHours?: number
  /** Hours of code comprehension per file read (default 0.15). */
  discoveryReadHours?: number
  /**
   * Extra coordination hours per MCP tool call (default 1.0), on top of the
   * per-call email time every tool call carries. An MCP call is a request to
   * another team's system: it comes with a thread, a wait and a follow-up that
   * a local tool call does not.
   */
  mcpCallCoordinationHours?: number
  /**
   * Management hours per distinct MCP server engaged (default 4), split evenly
   * between PM and EM. Bringing another department into a piece of work costs
   * alignment before anyone touches a keyboard, once per department rather
   * than once per request.
   */
  mcpServerManagementHours?: number
  /**
   * Engineering hours per distinct MCP server engaged (default 4). The dev
   * gets pulled into the cross-department meetings too — time that produces
   * nothing, so it is billed as engineering OVERHEAD rather than value.
   */
  mcpServerEngineeringHours?: number
  /**
   * Multiplier on the per-call email/meeting time for MCP calls (default 2).
   * Correspondence with another department costs more than correspondence
   * with yourself.
   */
  mcpCallCoordinationFactor?: number
  /**
   * Work the OTHER department performs per MCP call, a varying [min, max]
   * hours (defaults 2 and 5). An MCP call is not a library function: it is a
   * request that another team's system does real work to satisfy, and that
   * work would have been someone's day job.
   */
  mcpCallDepartmentMinHours?: number
  mcpCallDepartmentMaxHours?: number
  /**
   * Coordination hours per subagent (default 2). A subagent is another team:
   * briefing it, chasing it and reconciling what it hands back is time the
   * delegating engineer spends not writing code.
   */
  subagentCoordinationHours?: number
  /**
   * Engineering-management hours per subagent (default 4), billed to the EM.
   * Running work across N teams is N times the standups, the status chasing
   * and the integration risk.
   */
  subagentManagementHours?: number
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
  /**
   * Engineering hours the session's tool calls stand in for, already folded
   * into the engineering roles' implementation hours. Exposed so the receipt
   * bills the exact same number the role model used instead of recomputing it.
   */
  toolWorkHours: number
  /**
   * Code-comprehension hours from reads and searches, also folded into the
   * engineering roles' implementation hours. Separate from `toolWorkHours`:
   * operating a tool and understanding what it returned are different costs.
   */
  comprehensionHours: number
  /** Email/meeting hours the session's tool calls drag along. */
  toolCoordinationHours: number
  /** Cross-team coordination with MCP servers (other departments). */
  mcpCoordinationHours: number
  /** Cross-department meeting time the engineers are dragged into. */
  mcpEngineeringHours: number
  /**
   * The same hours, split across the engineering roles that carry them.
   * Exposed so the receipt prices them at those roles' rates rather than at
   * the blended rate — otherwise the receipt and the roles table disagree
   * about a cost they both contain.
   */
  mcpEngineeringHoursByRole: Partial<Record<RoleId, number>>
  /** Work performed by the other department, on our behalf, via MCP. */
  mcpDepartmentWorkHours: number
  /** Cross-team coordination with subagents (other teams). */
  subagentCoordinationHours: number
  totalProductiveHours: number
  domainBreakdown: Record<FileDomain, DomainStats>
}

// ---------------------------------------------------------------------------
// Cost & calendar
// ---------------------------------------------------------------------------

export interface CostOptions {
  rates?: Partial<Record<RoleId, number>>
  /** ISO 4217 code used to format amounts (default "USD"). */
  currency?: string
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
  /** ISO 4217 code the amounts in this report are denominated in. */
  currency: string
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
