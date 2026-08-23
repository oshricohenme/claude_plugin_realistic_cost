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
  docs: 30,
  config: 8,
  test: 20,
  design: 0, // counted separately (count * 2h)
  other: 10,
}

/** Per-write complexity multipliers (product capped at MAX_MULTIPLIER). */
const COMPLEXITY = {
  /** Full-file Write (new file) — setting up a file from scratch. */
  newFile: 1.5,
  /** A single write exceeding this many lines counts as a "large change". */
  largeChangeThreshold: 100,
  largeChange: 1.3,
}
const MAX_MULTIPLIER = 6.0
const DELETION_FACTOR = 0.3
const DESIGN_ASSET_HOURS_EACH = 2

/**
 * Default model parameters. Keys MUST match EstimateOptions exactly —
 * `opts()` merges user overrides over these by name, so a key mismatch
 * silently disables the option (regression-tested in test/estimate.test.ts).
 */
const DEFAULTS: Required<EstimateOptions> = {
  reviewOverheadMultiplier: 0.35,
  qaOverheadMultiplier: 0.5,
  qaWithTestsMultiplier: 0.35,
  designOverheadMultiplier: 0.6,
  pmOverheadMultiplier: 0.15,
  emOverheadMultiplier: 0.10,
  devopsDeployMultiplier: 0.15,
  securitySensitiveMultiplier: 0.15,
  securityNormalMultiplier: 0.05,
  techwriterOverheadMultiplier: 0.1,
  discoverySearchHours: 0.25,
  discoveryReadHours: 0.15,
  discoveryThinkingHours: 0.1,
}

function opts(o?: EstimateOptions): Required<EstimateOptions> {
  return { ...DEFAULTS, ...o }
}

const pct = (x: number): string => `${Math.round(x * 100)}%`

// ---------------------------------------------------------------------------
// Aggregate writes by domain
// ---------------------------------------------------------------------------

function emptyDomainBreakdown(): EstimateResult["domainBreakdown"] {
  const out = {} as EstimateResult["domainBreakdown"]
  const domains: FileDomain[] = ["backend", "frontend", "fullstack", "docs", "config", "test", "design", "other"]
  for (const d of domains) out[d] = { files: 0, newFiles: 0, linesAdded: 0, weightedLinesAdded: 0, linesRemoved: 0, hours: 0 }
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
  return Math.min(mult, MAX_MULTIPLIER)
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

export function estimateHours(
  stats: TranscriptStats,
  options?: EstimateOptions,
): EstimateResult {
  const o = opts(options)

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
  impl.qa = domainBreakdown.test.hours
  impl.designer = domainBreakdown.design.hours
  // "other" domain: allocate to backend (most common fallback).
  impl.backend += domainBreakdown.other.hours

  // Engineers spend significant time reading code to understand context.
  // Split read/search time: 50% → engineer code comprehension (implementation),
  // 50% → PM/EM/Designer discovery (management overhead).
  const searchReadHours =
    (stats.toolCalls.glob + stats.toolCalls.grep) * o.discoverySearchHours +
    stats.toolCalls.read * o.discoveryReadHours
  const thinkingHours = stats.thinkingTurns * o.discoveryThinkingHours
  const engineerReadHours = searchReadHours * 0.5
  const discoveryHours = searchReadHours * 0.5 + thinkingHours

  // Add engineer read time to the dominant engineering domain.
  if (hasBackend && hasFrontend) {
    impl.backend += engineerReadHours * 0.5
    impl.frontend += engineerReadHours * 0.5
  } else if (hasBackend) {
    impl.backend += engineerReadHours
  } else if (hasFrontend) {
    impl.frontend += engineerReadHours
  } else if (impl.fullstack > 0) {
    impl.fullstack += engineerReadHours
  } else {
    impl.backend += engineerReadHours
  }

  const BE = impl.backend
  const FE = impl.frontend
  const FS = impl.fullstack
  const DEVOPS_IMPL = impl.devops
  const DOC = impl.techwriter
  const DESIGN_IMPL = impl.designer

  const implHours = BE + FE + FS + DEVOPS_IMPL + DOC + impl.qa

  // "Tests written" means test-domain files were written — any Write at all
  // does NOT qualify (a session that only wrote prod code still needs full
  // human QA coverage).
  const wroteTests = impl.qa > 0
  const qaMult = wroteTests ? o.qaWithTestsMultiplier : o.qaOverheadMultiplier
  const sensitive = stats.touchesAuth || stats.touchesData || stats.touchesInfra
  const securityMult = sensitive ? o.securitySensitiveMultiplier : o.securityNormalMultiplier
  const hasFrontendWork = FE + FS > 0

  const roles: RoleEstimate[] = []
  const push = (
    role: RoleId,
    implementationHours: number,
    overheadHours: number,
    note: string,
  ) => {
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
        push("backend", BE, review, `Implementation ${BE.toFixed(1)}h + peer review ${pct(o.reviewOverheadMultiplier)}`)
        break
      }
      case "frontend": {
        const review = FE * o.reviewOverheadMultiplier
        push("frontend", FE, review, `Implementation ${FE.toFixed(1)}h + peer review ${pct(o.reviewOverheadMultiplier)}`)
        break
      }
      case "fullstack": {
        const review = FS * o.reviewOverheadMultiplier
        const note = splitFullstack
          ? `Split 50/50 into backend/frontend (both stacks present)`
          : `Implementation ${FS.toFixed(1)}h + peer review ${pct(o.reviewOverheadMultiplier)}`
        push("fullstack", FS, review, note)
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
        const pmHours = Math.max(3, o.pmOverheadMultiplier * implHours)
        push("pm", 0, pmHours, `${pct(o.pmOverheadMultiplier)} of impl (min 3h baseline)`)
        break
      }
      case "em": {
        const emHours = Math.max(3, o.emOverheadMultiplier * implHours)
        push("em", 0, emHours, `${pct(o.emOverheadMultiplier)} of impl (min 3h baseline)`)
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
      case "data":
        push("data", 0, 0, `No data-engineer work (migrations tracked under devops/data domains)`)
        break
    }
  }

  const totalProductiveHours = roles.reduce((s, r) => s + r.totalHours, 0)

  return {
    roles,
    implementationHours: implHours,
    discoveryHours,
    totalProductiveHours,
    domainBreakdown,
  }
}

function sumWriteLines(writes: FileWriteOp[]): number {
  let n = 0
  for (const w of writes) n += w.linesAdded + w.linesRemoved
  return n
}


