import { test } from "node:test"
import { strictEqual, ok } from "node:assert"

/** assert actual ≈ expected within delta. */
function approx(actual: number, expected: number, delta: number, msg?: string): void {
  ok(Math.abs(actual - expected) <= delta, msg ?? `${actual} ≉ ${expected} (±${delta})`)
}
import { computeCost, estimateHours, formatStatusLine } from "../src/core/index.js"
import type { TranscriptStats } from "../src/core/index.js"

function stats(overrides: Partial<TranscriptStats> = {}): TranscriptStats {
  return {
    transcriptPath: "",
    toolCalls: { read: 4, write: 3, edit: 1, glob: 1, grep: 1, bash: 1, task: 0, other: 0, total: 11 },
    thinkingTurns: 3,
    thinkingTokens: 4000,
    assistantTurns: 5,
    fileWrites: [
      { path: "src/api.ts", tool: "Write", linesAdded: 120, linesRemoved: 0, domain: "backend" },
      { path: "src/ui/Button.tsx", tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "frontend" },
      { path: "docs/guide.md", tool: "Write", linesAdded: 40, linesRemoved: 0, domain: "docs" },
      { path: "src/auth/login.ts", tool: "Edit", linesAdded: 20, linesRemoved: 8, domain: "backend" },
    ],
    filesReadPaths: [],
    durationMs: 600_000,
    linesAdded: 240,
    linesRemoved: 8,
    touchesAuth: true,
    touchesData: false,
    touchesInfra: false,
    ...overrides,
  }
}

const S = stats()
const EST = estimateHours(S)
const REPORT = computeCost({ stats: S, estimate: EST })

test("grand total equals the sum of activity line items", () => {
  const sum = REPORT.activities.reduce((s, a) => s + a.cost, 0)
  approx(REPORT.totalCost, sum, 1e-6)
  const sumH = REPORT.activities.reduce((s, a) => s + a.hours, 0)
  approx(REPORT.totalHours, sumH, 1e-6)
})

test("coordination tax is 20% of the grand total", () => {
  const coord = REPORT.activities.filter((a) => a.section === "coordination")
  const coordCost = coord.reduce((s, a) => s + a.cost, 0)
  approx(coordCost / REPORT.totalCost, 0.2, 1e-9)
  strictEqual(coord.length, 4, "four coordination buckets")
  const buckets = new Set(coord.map((a) => a.cost))
  strictEqual(buckets.size, 1, "buckets split the tax evenly")
})

test("receipt PM/EM lines equal the role estimate's PM/EM totals", () => {
  const pmEst = EST.roles.find((r) => r.role === "pm")!
  const emEst = EST.roles.find((r) => r.role === "em")!
  const pmAct = REPORT.activities.find((a) => a.activity === "Product Management")!
  const emAct = REPORT.activities.find((a) => a.activity === "Engineering Management")!
  approx(pmAct.cost, pmEst.totalHours * REPORT.rates.pm, 1e-6)
  approx(emAct.cost, emEst.totalHours * REPORT.rates.em, 1e-6)
  approx(pmAct.hours, pmEst.totalHours, 1e-6)
  approx(emAct.hours, emEst.totalHours, 1e-6)
})

test("role percentages are relative to the grand total and sum below 100%", () => {
  const roleCost = REPORT.roles.reduce((s, r) => s + r.cost, 0)
  // Roles exclude the coordination tax (and the token-billed thinking
  // activity), so they sum to slightly under 80% of the grand total.
  const share = roleCost / REPORT.totalCost
  ok(share > 0.7 && share < 0.85, `role costs sum to a sub-total share (${(share * 100).toFixed(1)}%)`)
  for (const r of REPORT.roles) {
    approx(r.percentage, (r.cost / REPORT.totalCost) * 100, 1e-6)
  }
})

test("activity percentages sum to 100%", () => {
  const sum = REPORT.activities.reduce((s, a) => s + a.percentage, 0)
  approx(sum, 100, 1e-6)
})

test("aiCost flows through CostOptions instead of post-hoc mutation", () => {
  const r = computeCost({ stats: S, estimate: EST, options: { aiCost: 1.25 } })
  strictEqual(r.aiCost, 1.25)
  const line = formatStatusLine(r)
  ok(line.includes("AI $1.25"), `statusline shows AI cost: "${line}"`)
})

test("estimateOptions thread through to the receipt", () => {
  const est2 = estimateHours(S, { reviewOverheadMultiplier: 0.9 })
  const r = computeCost({ stats: S, estimate: est2, options: { estimateOptions: { reviewOverheadMultiplier: 0.9 } } })
  const base = computeCost({ stats: S, estimate: EST })
  const review = (rep: typeof base) => rep.activities.find((a) => a.activity === "Peer Review")!
  ok(review(r).cost > review(base).cost, "review multiplier affects receipt")
})

test("humanReadable is populated and man-days use the configured day length", () => {
  ok(REPORT.calendar.humanReadable.length > 0)
  const r6 = computeCost({ stats: S, estimate: EST, options: { productiveHoursPerDay: 6 } })
  approx(REPORT.calendar.manDays / r6.calendar.manDays, 6 / 8, 1e-9)
})

test("statusline format is one line and contains the totals", () => {
  const line = formatStatusLine(REPORT)
  strictEqual(line.split("\n").length, 1)
  ok(line.includes("Pre-AI"))
  ok(line.includes(REPORT.totalCost.toFixed(0)))
  ok(line.includes(REPORT.totalHours.toFixed(1) + "h"))
})
