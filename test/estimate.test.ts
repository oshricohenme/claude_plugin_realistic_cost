import { test } from "node:test"
import { strictEqual, ok, deepStrictEqual } from "node:assert"
import { estimateHours } from "../src/core/index.js"
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
  const overridden = estimateHours(s, { reviewOverheadMultiplier: 0.9, pmOverheadMultiplier: 0.5, qaOverheadMultiplier: 0.2 })

  const role = (e: ReturnType<typeof estimateHours>, id: string) => e.roles.find((r) => r.role === id)
  ok(role(overridden, "backend")!.overheadHours > role(base, "backend")!.overheadHours, "review override applied")
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
  const note = estimateHours(s, { reviewOverheadMultiplier: 0.45 }).roles.find((r) => r.role === "backend")!.note
  ok(note.includes("45%"), `note reflects configured review overhead: "${note}"`)
})

test("discovery options are honored", () => {
  const s = stats({ toolCalls: { read: 10, write: 0, edit: 0, glob: 0, grep: 0, bash: 0, task: 0, other: 0, total: 10 } })
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
  deepStrictEqual(
    Object.keys(e.domainBreakdown).sort(),
    ["backend", "config", "design", "docs", "frontend", "fullstack", "other", "test"],
  )
})
