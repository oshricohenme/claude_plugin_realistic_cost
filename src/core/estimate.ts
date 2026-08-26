import type {
  DomainStats,
  EstimateOptions,
  EstimateResult,
  FileDomain,
  FileWriteOp,
  RoleEstimate,
  RoleId,
  TranscriptStats,
} from "./types.js"
import { ROLES, ROLE_ORDER } from "./roles.js"

// ---------------------------------------------------------------------------
// Base productivity rates (productive lines/hour) by domain
// ---------------------------------------------------------------------------

const BASE_RATE: Record<FileDomain, number> = {
  backend: 12,
  frontend: 15,
  fullstack: 13,
  // Migrations and schema changes are slow and high-blast-radius per line.
  data: 10,
  docs: 30,
  config: 8,
  test: 20,
  design: 0, // counted separately (count * 2h)
  other: 10,
}

/** Per-write complexity multipliers. */
const COMPLEXITY = {
  /** Full-file Write (new file) — setting up a file from scratch. */
  newFile: 1.5,
  /** A single write exceeding this many lines counts as a "large change". */
  largeChangeThreshold: 100,
  largeChange: 1.3,
}
const DELETION_FACTOR = 0.3
const DESIGN_ASSET_HOURS_EACH = 2

/**
 * Default model parameters — the single source of truth for every tunable in
 * the model. cost.ts resolves its own options through `resolveEstimateOptions`
 * below rather than restating these, so the role model and the receipt cannot
 * be tuned apart (regression-tested in test/estimate.test.ts).
 *
 * Keys MUST match EstimateOptions exactly: the merge is by name, so a typo
 * silently disables the option.
 */
export const ESTIMATE_DEFAULTS: Required<EstimateOptions> = {
  reviewOverheadMultiplier: 0.35,
  qaOverheadMultiplier: 0.5,
  qaWithTestsMultiplier: 0.35,
  designOverheadMultiplier: 0.6,
  pmOverheadMultiplier: 0.15,
  emOverheadMultiplier: 0.1,
  devopsDeployMultiplier: 0.15,
  securitySensitiveMultiplier: 0.15,
  securityNormalMultiplier: 0.05,
  techwriterOverheadMultiplier: 0.1,
  thinkingCostPerToken: 0.05,
  toolCallWorkHours: 0.5,
  toolCallCoordinationHours: 0.5,
  webRequestMinHours: 0.5,
  webRequestMaxHours: 1,
  discoverySearchHours: 0.25,
  discoveryReadHours: 0.15,
  mcpCallCoordinationHours: 1,
  mcpServerManagementHours: 4,
  mcpServerEngineeringHours: 4,
  mcpCallCoordinationFactor: 2,
  mcpCallDepartmentMinHours: 2,
  mcpCallDepartmentMaxHours: 5,
  subagentCoordinationHours: 2,
  subagentManagementHours: 4,
  discoveryThinkingHours: 0.1,
}

// ---------------------------------------------------------------------------
// Web-request read time
// ---------------------------------------------------------------------------

/**
 * Reading a fetched page takes longer than reading a local file, and how much
 * longer depends on the page — so a web request costs a VARYING
 * [webRequestMinHours, webRequestMaxHours] rather than a flat rate.
 *
 * The variation is deterministic on purpose. `Math.random()` here would be a
 * defect, not a feature: the status line re-renders on every keystroke and
 * `review` is run repeatedly on the same session, so a genuinely random draw
 * would quote a different total every time for work that had not changed.
 * Seeding from the transcript path instead gives per-call variation that is
 * stable for a given session and differs between sessions.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** FNV-1a — a small, stable string hash. Any stable seed would do. */
function hashString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/**
 * `count` draws from [min, max], summed. Deterministic for a given seed — see
 * the note above on why this must not be `Math.random()`.
 *
 * Callers pass distinct seeds for distinct kinds of work, so web requests and
 * MCP calls in the same session do not replay the identical sequence.
 */
export function variableHours(count: number, min: number, max: number, seed: string): number {
  if (count <= 0) return 0
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  if (hi === lo) return count * lo
  const rand = mulberry32(hashString(seed))
  let hours = 0
  for (let i = 0; i < count; i++) hours += lo + rand() * (hi - lo)
  return hours
}

export function webRequestHours(
  count: number,
  o: Pick<Required<EstimateOptions>, "webRequestMinHours" | "webRequestMaxHours">,
  seed: string,
): number {
  return variableHours(count, o.webRequestMinHours, o.webRequestMaxHours, seed + ":web")
}

/** Merge user overrides over the model defaults. */
export function resolveEstimateOptions(o?: EstimateOptions): Required<EstimateOptions> {
  return { ...ESTIMATE_DEFAULTS, ...o }
}

const pct = (x: number): string => `${Math.round(x * 100)}%`

// ---------------------------------------------------------------------------
// Aggregate writes by domain
// ---------------------------------------------------------------------------

function emptyDomainBreakdown(): EstimateResult["domainBreakdown"] {
  const out = {} as EstimateResult["domainBreakdown"]
  const domains: FileDomain[] = [
    "backend",
    "frontend",
    "fullstack",
    "data",
    "docs",
    "config",
    "test",
    "design",
    "other",
  ]
  for (const d of domains)
    out[d] = { files: 0, newFiles: 0, linesAdded: 0, weightedLinesAdded: 0, linesRemoved: 0, hours: 0 }
  return out
}

/**
 * Complexity multiplier for a single write op: new files are slower to set
 * up, and a single very large write is slower per line than small edits.
 */
function writeMultiplier(w: FileWriteOp): number {
  let mult = 1
  if (w.tool === "Write") mult *= COMPLEXITY.newFile
  if (w.linesAdded > COMPLEXITY.largeChangeThreshold) mult *= COMPLEXITY.largeChange
  return mult
}

function aggregateWrites(writes: FileWriteOp[]) {
  const byDomain = emptyDomainBreakdown()
  for (const w of writes) {
    const b: DomainStats = byDomain[w.domain]
    b.files += 1
    if (w.tool === "Write") b.newFiles += 1
    b.linesAdded += w.linesAdded
    b.linesRemoved += w.linesRemoved
    b.weightedLinesAdded += w.linesAdded * writeMultiplier(w)
  }
  return byDomain
}

// ---------------------------------------------------------------------------
// Per-domain implementation hours
// ---------------------------------------------------------------------------

function domainHours(breakdown: EstimateResult["domainBreakdown"]): void {
  for (const domain of Object.keys(breakdown) as FileDomain[]) {
    const b = breakdown[domain]
    if (domain === "design") {
      b.hours = b.files * DESIGN_ASSET_HOURS_EACH
      continue
    }
    const base = BASE_RATE[domain] ?? BASE_RATE.other
    if (base <= 0) {
      b.hours = 0
      continue
    }
    const addedHours = b.weightedLinesAdded / base
    const removedHours = (b.linesRemoved / base) * DELETION_FACTOR
    b.hours = addedHours + removedHours
  }
}

// ---------------------------------------------------------------------------
// estimateHours
// ---------------------------------------------------------------------------

export function estimateHours(stats: TranscriptStats, options?: EstimateOptions): EstimateResult {
  const o = resolveEstimateOptions(options)

  const domainBreakdown = aggregateWrites(stats.fileWrites)
  domainHours(domainBreakdown)

  // If the transcript had no Write ops but status-line reports lines added
  // (e.g. transcript parse failed or work was via hooks), fall back to the
  // authoritative line counts as an undifferentiated "other" bucket.
  const totalWriteLines = sumWriteLines(stats.fileWrites)
  if (totalWriteLines === 0 && stats.linesAdded > 0) {
    const base = BASE_RATE.other
    domainBreakdown.other.files = Math.max(1, stats.fileWrites.length)
    domainBreakdown.other.linesAdded = stats.linesAdded
    domainBreakdown.other.weightedLinesAdded = stats.linesAdded
    domainBreakdown.other.linesRemoved = stats.linesRemoved
    domainBreakdown.other.hours = stats.linesAdded / base + (stats.linesRemoved / base) * DELETION_FACTOR
  }

  // Per-role implementation hour accumulators.
  const impl: Record<RoleId, number> = {
    pm: 0,
    em: 0,
    designer: 0,
    backend: 0,
    frontend: 0,
    fullstack: 0,
    qa: 0,
    devops: 0,
    security: 0,
    data: 0,
    techwriter: 0,
  }

  const hasBackend = domainBreakdown.backend.files > 0
  const hasFrontend = domainBreakdown.frontend.files > 0
  const splitFullstack = hasBackend && hasFrontend

  impl.backend = domainBreakdown.backend.hours
  impl.frontend = domainBreakdown.frontend.hours
  // Fullstack: split 50/50 if both be & fe present, else keep as fullstack role.
  if (splitFullstack) {
    impl.backend += domainBreakdown.fullstack.hours * 0.5
    impl.frontend += domainBreakdown.fullstack.hours * 0.5
  } else {
    impl.fullstack = domainBreakdown.fullstack.hours
  }
  impl.techwriter = domainBreakdown.docs.hours
  impl.devops = domainBreakdown.config.hours
  impl.data = domainBreakdown.data.hours
  impl.qa = domainBreakdown.test.hours
  impl.designer = domainBreakdown.design.hours
  // "other" domain: allocate to backend (most common fallback).
  impl.backend += domainBreakdown.other.hours

  // Every tool call stands in for a half-hour of human work — opening a file,
  // running a command, making an edit — except a web request, which costs a
  // varying 0.5-1.0h because reading a page is slower than reading a file.
  const webCalls = Math.min(stats.toolCalls.web, stats.toolCalls.total)
  const otherCalls = Math.max(0, stats.toolCalls.total - webCalls)
  const toolWorkHours = otherCalls * o.toolCallWorkHours + webRequestHours(webCalls, o, stats.transcriptPath)
  // ...and drags along its own half-hour of email and meetings, billed
  // separately in cost.ts so it is visible rather than buried in impl.
  // Email/meeting time per call, at a multiple for MCP calls: corresponding
  // with another department costs more than corresponding with yourself.
  const mcpCallCount = Math.min(stats.mcpCalls ?? 0, stats.toolCalls.total)
  const localCallCount = Math.max(0, stats.toolCalls.total - mcpCallCount)
  const toolCoordinationHours =
    localCallCount * o.toolCallCoordinationHours +
    mcpCallCount * o.toolCallCoordinationHours * o.mcpCallCoordinationFactor

  // Comprehension is charged SEPARATELY from tool operation, and on purpose:
  // understanding a file and the act of pulling it up are different costs, so
  // a read bills its comprehension time on top of its half-hour of tool work.
  const searchReadHours =
    (stats.toolCalls.glob + stats.toolCalls.grep) * o.discoverySearchHours +
    stats.toolCalls.read * o.discoveryReadHours
  const engineerReadHours = searchReadHours * 0.5
  const discoveryHours = searchReadHours * 0.5 + stats.thinkingTurns * o.discoveryThinkingHours

  // Cross-team overhead. An MCP call is a request to another department's
  // system and a subagent is another team outright, so both cost more than the
  // same work done in-house: coordination per interaction, and management once
  // per team you had to involve at all.
  // Defensive reads: stats can arrive from the status-line cache on disk,
  // which may have been written by an older version that had no cross-team
  // fields at all. A missing field must price as zero, not throw.
  const mcpCalls = stats.mcpCalls ?? 0
  const mcpServerCount = stats.mcpServers?.length ?? 0
  const subagentCount = stats.subagents ?? 0
  const mcpCoordinationHours = mcpCalls * o.mcpCallCoordinationHours
  const subagentCoordinationHours = subagentCount * o.subagentCoordinationHours
  const mcpManagementHours = mcpServerCount * o.mcpServerManagementHours
  const subagentManagementHours = subagentCount * o.subagentManagementHours
  // The dev is in those cross-department meetings too. Non-value-generating,
  // so it is engineering OVERHEAD and is deliberately kept out of implHours —
  // otherwise it would inflate every multiplier that scales off implementation.
  const mcpEngineeringHours = mcpServerCount * o.mcpServerEngineeringHours
  // An MCP call is a request another team's system does real work to satisfy.
  // That work would have been someone's day job, so it is billed as such.
  const mcpDepartmentWorkHours = variableHours(
    mcpCalls,
    o.mcpCallDepartmentMinHours,
    o.mcpCallDepartmentMaxHours,
    stats.transcriptPath + ":mcp",
  )

  // Tool work and comprehension both land on the dominant engineering domain.
  const engineerHours = toolWorkHours + engineerReadHours
  if (hasBackend && hasFrontend) {
    impl.backend += engineerHours * 0.5
    impl.frontend += engineerHours * 0.5
  } else if (hasBackend) {
    impl.backend += engineerHours
  } else if (hasFrontend) {
    impl.frontend += engineerHours
  } else if (impl.fullstack > 0) {
    impl.fullstack += engineerHours
  } else {
    impl.backend += engineerHours
  }

  const BE = impl.backend
  const FE = impl.frontend
  const FS = impl.fullstack
  const DEVOPS_IMPL = impl.devops
  const DATA_IMPL = impl.data
  const DOC = impl.techwriter
  const DESIGN_IMPL = impl.designer

  const implHours = BE + FE + FS + DEVOPS_IMPL + DATA_IMPL + DOC + impl.qa

  // "Tests written" means test-domain files were written — any Write at all
  // does NOT qualify (a session that only wrote prod code still needs full
  // human QA coverage).
  const wroteTests = impl.qa > 0
  const qaMult = wroteTests ? o.qaWithTestsMultiplier : o.qaOverheadMultiplier
  const sensitive = stats.touchesAuth || stats.touchesData || stats.touchesInfra
  const securityMult = sensitive ? o.securitySensitiveMultiplier : o.securityNormalMultiplier
  const hasFrontendWork = FE + FS > 0

  const departments = mcpServerCount > 0 ? `${mcpServerCount} MCP department(s)` : ""

  /**
   * Cross-department meeting time, spread over whichever engineering roles
   * actually worked. Overhead, never implementation: it produces nothing, and
   * folding it into implHours would silently inflate the PM, EM, QA, security
   * and tech-writer multipliers that all scale off implementation hours.
   */
  const engMeeting: Record<"backend" | "frontend" | "fullstack", number> = {
    backend: 0,
    frontend: 0,
    fullstack: 0,
  }
  if (mcpEngineeringHours > 0) {
    if (hasBackend && hasFrontend) {
      engMeeting.backend = mcpEngineeringHours * 0.5
      engMeeting.frontend = mcpEngineeringHours * 0.5
    } else if (hasBackend) {
      engMeeting.backend = mcpEngineeringHours
    } else if (hasFrontend) {
      engMeeting.frontend = mcpEngineeringHours
    } else if (impl.fullstack > 0) {
      engMeeting.fullstack = mcpEngineeringHours
    } else {
      engMeeting.backend = mcpEngineeringHours
    }
  }
  const meetingNote = (h: number) => (h > 0 ? ` + ${h.toFixed(1)}h cross-dept meetings` : "")

  const roles: RoleEstimate[] = []
  const push = (role: RoleId, implementationHours: number, overheadHours: number, note: string) => {
    roles.push({
      role,
      title: ROLES[role].title,
      category: ROLES[role].category,
      implementationHours,
      overheadHours,
      totalHours: implementationHours + overheadHours,
      note,
    })
  }

  for (const id of ROLE_ORDER) {
    switch (id) {
      case "backend": {
        const review = BE * o.reviewOverheadMultiplier
        push(
          "backend",
          BE,
          review + engMeeting.backend,
          `Implementation ${BE.toFixed(1)}h + peer review ${pct(o.reviewOverheadMultiplier)}` +
            meetingNote(engMeeting.backend),
        )
        break
      }
      case "frontend": {
        const review = FE * o.reviewOverheadMultiplier
        push(
          "frontend",
          FE,
          review + engMeeting.frontend,
          `Implementation ${FE.toFixed(1)}h + peer review ${pct(o.reviewOverheadMultiplier)}` +
            meetingNote(engMeeting.frontend),
        )
        break
      }
      case "fullstack": {
        const review = FS * o.reviewOverheadMultiplier
        const note = splitFullstack
          ? `Split 50/50 into backend/frontend (both stacks present)`
          : `Implementation ${FS.toFixed(1)}h + peer review ${pct(o.reviewOverheadMultiplier)}`
        push("fullstack", FS, review + engMeeting.fullstack, note + meetingNote(engMeeting.fullstack))
        break
      }
      case "devops": {
        const review = DEVOPS_IMPL * o.reviewOverheadMultiplier
        const deploy = o.devopsDeployMultiplier * (BE + FE + FS)
        push(
          "devops",
          DEVOPS_IMPL,
          review + deploy,
          `Infra ${DEVOPS_IMPL.toFixed(1)}h + review ${pct(o.reviewOverheadMultiplier)} + deploy ${pct(o.devopsDeployMultiplier)} of eng`,
        )
        break
      }
      case "techwriter": {
        const review = DOC * o.reviewOverheadMultiplier
        const overhead = o.techwriterOverheadMultiplier * implHours
        push(
          "techwriter",
          DOC,
          review + overhead,
          `Docs ${DOC.toFixed(1)}h + review ${pct(o.reviewOverheadMultiplier)} + changelog ${pct(o.techwriterOverheadMultiplier)} of impl`,
        )
        break
      }
      case "designer": {
        const designOverhead = hasFrontendWork ? o.designOverheadMultiplier * (FE + FS) : 0
        push(
          "designer",
          DESIGN_IMPL,
          designOverhead,
          `${domainBreakdown.design.files} assets + design work ${pct(o.designOverheadMultiplier)} of FE+FS`,
        )
        break
      }
      case "pm": {
        // Half the per-department alignment cost; the EM carries the other half.
        const crossTeam = mcpManagementHours * 0.5
        const pmHours = Math.max(3, o.pmOverheadMultiplier * implHours) + crossTeam
        const note = `${pct(o.pmOverheadMultiplier)} of impl (min 3h baseline)`
        push("pm", 0, pmHours, crossTeam > 0 ? `${note} + ${departments} alignment` : note)
        break
      }
      case "em": {
        // Subagent management is the EM's alone: running work across N teams is
        // N times the standups, the chasing and the integration risk.
        const crossTeam = mcpManagementHours * 0.5 + subagentManagementHours
        const emHours = Math.max(3, o.emOverheadMultiplier * implHours) + crossTeam
        const note = `${pct(o.emOverheadMultiplier)} of impl (min 3h baseline)`
        const extras = [subagentCount > 0 ? `${subagentCount} subagent team(s)` : "", departments].filter(
          Boolean,
        )
        push("em", 0, emHours, extras.length > 0 ? `${note} + ${extras.join(" + ")}` : note)
        break
      }
      case "qa": {
        const qaOverheadTotal = qaMult * implHours
        push(
          "qa",
          impl.qa,
          qaOverheadTotal,
          wroteTests
            ? `Tests written by AI -> ${pct(o.qaWithTestsMultiplier)} of impl for human QA`
            : `${pct(o.qaOverheadMultiplier)} of impl for human QA (no tests written)`,
        )
        break
      }
      case "security": {
        push(
          "security",
          0,
          securityMult * implHours,
          sensitive
            ? `${pct(o.securitySensitiveMultiplier)} of impl (sensitive: auth/data/infra touched)`
            : `${pct(o.securityNormalMultiplier)} of impl (routine review)`,
        )
        break
      }
      case "data": {
        const review = DATA_IMPL * o.reviewOverheadMultiplier
        push(
          "data",
          DATA_IMPL,
          review,
          DATA_IMPL > 0
            ? `Schema/migrations ${DATA_IMPL.toFixed(1)}h + peer review ${pct(o.reviewOverheadMultiplier)}`
            : `No schema or migration files touched`,
        )
        break
      }
    }
  }

  const totalProductiveHours = roles.reduce((s, r) => s + r.totalHours, 0)

  return {
    roles,
    implementationHours: implHours,
    discoveryHours,
    toolWorkHours,
    comprehensionHours: engineerReadHours,
    mcpEngineeringHours,
    mcpEngineeringHoursByRole: { ...engMeeting },
    mcpDepartmentWorkHours,
    toolCoordinationHours,
    mcpCoordinationHours,
    subagentCoordinationHours,
    totalProductiveHours,
    domainBreakdown,
  }
}

function sumWriteLines(writes: FileWriteOp[]): number {
  let n = 0
  for (const w of writes) n += w.linesAdded + w.linesRemoved
  return n
}
