import { test } from "node:test"
import { strictEqual, ok, deepStrictEqual } from "node:assert"
import { ESTIMATE_DEFAULTS, computeCost, estimateHours, resolveEstimateOptions } from "../src/core/index.js"
import type { TranscriptStats } from "../src/core/index.js"

function stats(overrides: Partial<TranscriptStats> = {}): TranscriptStats {
  return {
    transcriptPath: "",
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
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Option plumbing — regression for the EstimateOptions/DEFAULTS key mismatch
// that silently ignored every *Multiplier override.
// ---------------------------------------------------------------------------

test("EstimateOptions overrides actually change the estimate", () => {
  const s = stats({
    fileWrites: [{ path: "src/api.ts", tool: "Write", linesAdded: 120, linesRemoved: 0, domain: "backend" }],
  })
  const base = estimateHours(s)
  const overridden = estimateHours(s, {
    reviewOverheadMultiplier: 0.9,
    pmOverheadMultiplier: 0.5,
    qaOverheadMultiplier: 0.2,
  })

  const role = (e: ReturnType<typeof estimateHours>, id: string) => e.roles.find((r) => r.role === id)
  ok(
    role(overridden, "backend")!.overheadHours > role(base, "backend")!.overheadHours,
    "review override applied",
  )
  ok(role(overridden, "pm")!.overheadHours > role(base, "pm")!.overheadHours, "pm override applied")

  // 120 lines > threshold of 100 → impl already carries the large-change
  // multiplier; check percentage math directly instead.
  const impl = role(base, "backend")!.implementationHours
  strictEqual(
    Math.round((role(base, "backend")!.overheadHours / impl) * 100),
    35,
    "default review overhead is 35%",
  )
  strictEqual(
    Math.round((role(overridden, "backend")!.overheadHours / impl) * 100),
    90,
    "overridden review overhead is 90%",
  )
  // No test files written → QA at qaOverheadMultiplier (0.2 override).
  strictEqual(
    Math.round((role(overridden, "qa")!.overheadHours / overridden.implementationHours) * 100),
    20,
    "qa override applied",
  )
})

// ---------------------------------------------------------------------------
// QA multiplier — regression for "any Write triggers the tests-written rate"
// ---------------------------------------------------------------------------

test("QA overhead uses the no-tests rate unless test files were written", () => {
  const prodOnly = stats({
    fileWrites: [{ path: "src/api.ts", tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "backend" }],
  })
  const withTests = stats({
    fileWrites: [
      { path: "src/api.ts", tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "backend" },
      { path: "src/api.test.ts", tool: "Write", linesAdded: 20, linesRemoved: 0, domain: "test" },
    ],
  })

  const qaShare = (s: TranscriptStats) => {
    const e = estimateHours(s)
    const qa = e.roles.find((r) => r.role === "qa")!
    return qa.overheadHours / e.implementationHours
  }
  ok(Math.abs(qaShare(prodOnly) - 0.5) < 1e-9, "prod-only writes → 50% QA overhead")
  ok(Math.abs(qaShare(withTests) - 0.35) < 1e-9, "test files written → 35% QA overhead")
})

// ---------------------------------------------------------------------------
// Per-write complexity multipliers
// ---------------------------------------------------------------------------

test("new-file (Write) ops cost more than equivalent Edit ops", () => {
  const viaWrite = stats({
    fileWrites: [{ path: "src/a.ts", tool: "Write", linesAdded: 40, linesRemoved: 0, domain: "backend" }],
  })
  const viaEdit = stats({
    fileWrites: [{ path: "src/a.ts", tool: "Edit", linesAdded: 40, linesRemoved: 0, domain: "backend" }],
  })
  const hw = estimateHours(viaWrite).domainBreakdown.backend.hours
  const he = estimateHours(viaEdit).domainBreakdown.backend.hours
  ok(Math.abs(hw / he - 1.5) < 1e-9, `Write 40 lines = 1.5x Edit 40 lines (got ${hw}/${he})`)
})

test("large-change multiplier applies per write, not on domain average", () => {
  // 150-line write: 150 * 1.5 (new file) * 1.3 (large) weighted lines.
  const oneBig = stats({
    fileWrites: [{ path: "src/big.ts", tool: "Write", linesAdded: 150, linesRemoved: 0, domain: "backend" }],
  })
  // 3x 50-line writes: 150 * 1.5 (new files), no large-change multiplier.
  const threeSmall = stats({
    fileWrites: [
      { path: "src/s1.ts", tool: "Write", linesAdded: 50, linesRemoved: 0, domain: "backend" },
      { path: "src/s2.ts", tool: "Write", linesAdded: 50, linesRemoved: 0, domain: "backend" },
      { path: "src/s3.ts", tool: "Write", linesAdded: 50, linesRemoved: 0, domain: "backend" },
    ],
  })
  const wb = estimateHours(oneBig).domainBreakdown.backend.weightedLinesAdded
  const ws = estimateHours(threeSmall).domainBreakdown.backend.weightedLinesAdded
  strictEqual(wb, 150 * 1.5 * 1.3, "single 150-line write weighted 1.5*1.3")
  strictEqual(ws, 150 * 1.5, "three 50-line writes weighted 1.5 only")
})

test("complexity multiplier applies per write and stays under the 6x cap", () => {
  const s = stats({
    fileWrites: [{ path: "src/x.ts", tool: "Write", linesAdded: 500, linesRemoved: 0, domain: "backend" }],
  })
  const w = estimateHours(s).domainBreakdown.backend.weightedLinesAdded
  ok(Math.abs(w - 500 * 1.5 * 1.3) < 1e-9, "new file + large change multiply (1.95x)")
  ok(w / 500 <= 6, "weight never exceeds 6x")
})

// ---------------------------------------------------------------------------
// Domain breakdown shape
// ---------------------------------------------------------------------------

test("domainBreakdown tracks newFiles and raw line counts separately from weights", () => {
  const s = stats({
    fileWrites: [
      { path: "src/a.ts", tool: "Write", linesAdded: 30, linesRemoved: 0, domain: "backend" },
      { path: "src/a.ts", tool: "Edit", linesAdded: 10, linesRemoved: 4, domain: "backend" },
    ],
  })
  const b = estimateHours(s).domainBreakdown.backend
  strictEqual(b.files, 2)
  strictEqual(b.newFiles, 1)
  strictEqual(b.linesAdded, 40)
  strictEqual(b.linesRemoved, 4)
  strictEqual(b.weightedLinesAdded, 30 * 1.5 + 10)
})

test("role notes quote the configured percentages, not hardcoded strings", () => {
  const s = stats({
    fileWrites: [{ path: "src/api.ts", tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "backend" }],
  })
  const note = estimateHours(s, { reviewOverheadMultiplier: 0.45 }).roles.find(
    (r) => r.role === "backend",
  )!.note
  ok(note.includes("45%"), `note reflects configured review overhead: "${note}"`)
})

test("discovery options are honored", () => {
  const s = stats({
    toolCalls: { read: 10, write: 0, edit: 0, glob: 0, grep: 0, bash: 0, task: 0, other: 0, total: 10 },
  })
  const base = estimateHours(s)
  const tuned = estimateHours(s, { discoveryReadHours: 0.5 })
  ok(tuned.discoveryHours > base.discoveryHours, "discoveryReadHours override increases discovery hours")
})

test("empty stats produce a near-zero estimate with all roles present", () => {
  const e = estimateHours(stats())
  strictEqual(e.roles.length, 11)
  strictEqual(e.implementationHours, 0)
  // PM and EM carry 3h minimums even with no work — the standing cost of
  // having a team at all.
  strictEqual(e.totalProductiveHours, 6)
  deepStrictEqual(Object.keys(e.domainBreakdown).sort(), [
    "backend",
    "config",
    "data",
    "design",
    "docs",
    "frontend",
    "fullstack",
    "other",
    "test",
  ])
})

test("schema and migration files are billed to the data engineer", () => {
  const s = stats({
    fileWrites: [
      {
        path: "db/migrations/0007_add_users.sql",
        tool: "Write",
        linesAdded: 40,
        linesRemoved: 0,
        domain: "data",
      },
      { path: "prisma/schema.prisma", tool: "Edit", linesAdded: 10, linesRemoved: 2, domain: "data" },
    ],
  })
  const e = estimateHours(s)
  const data = e.roles.find((r) => r.role === "data")!
  ok(data.implementationHours > 0, "data role gets implementation hours, not a hardcoded zero")
  ok(data.overheadHours > 0, "data work is peer reviewed like any other engineering")
  ok(e.implementationHours >= data.implementationHours, "data hours are part of total impl")
})

// ---------------------------------------------------------------------------
// Single source of truth for the model parameters.
//
// cost.ts used to restate the whole DEFAULTS table verbatim. Nothing pinned
// the two copies together, so tuning the role model and tuning the receipt
// could silently diverge. Both now resolve through resolveEstimateOptions.
// ---------------------------------------------------------------------------

test("every EstimateOptions key has exactly one default, shared by estimate and cost", () => {
  const resolved = resolveEstimateOptions()
  deepStrictEqual(
    resolved,
    ESTIMATE_DEFAULTS,
    "resolveEstimateOptions() with no overrides is the defaults table",
  )

  // Every default must be a real, finite number — a typo'd key would show up
  // here as undefined rather than silently disabling an option.
  for (const [key, value] of Object.entries(ESTIMATE_DEFAULTS)) {
    ok(typeof value === "number" && Number.isFinite(value), `${key} has a numeric default`)
  }

  // An override of any single key must survive resolution untouched, and must
  // reach the receipt: computeCost resolves the same options object.
  for (const key of Object.keys(ESTIMATE_DEFAULTS) as (keyof typeof ESTIMATE_DEFAULTS)[]) {
    const bumped = ESTIMATE_DEFAULTS[key] + 1
    strictEqual(resolveEstimateOptions({ [key]: bumped })[key], bumped, `${key} override is applied`)
  }
})

test("thinking cost per token is tunable rather than hard-coded", () => {
  const s = stats({
    thinkingTokens: 5000,
    toolCalls: { read: 2, write: 1, edit: 0, glob: 0, grep: 0, bash: 0, task: 0, other: 0, total: 3 },
    fileWrites: [{ path: "src/api.ts", tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "backend" }],
  })
  const est = estimateHours(s)
  const base = computeCost({ stats: s, estimate: est })
  const cheap = computeCost({
    stats: s,
    estimate: est,
    options: { estimateOptions: { thinkingCostPerToken: 0.005 } },
  })
  const think = (r: typeof base) => r.activities.find((a) => a.activity === "Thinking")?.cost ?? 0
  ok(think(cheap) < think(base), "lowering the per-token price lowers the thinking line item")
})
