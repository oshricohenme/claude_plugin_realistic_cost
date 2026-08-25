import { test } from "node:test"
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { ok } from "node:assert"
import { emptyStats, estimateHours, computeCost } from "../src/core/index.js"
import type { TranscriptStats, FileWriteOp } from "../src/core/index.js"

// ---------------------------------------------------------------------------
// The opencode TUI plugin ships a self-contained copy of the cost engine — it
// is loaded standalone by opencode and cannot import from src/. That copy has
// silently drifted before (PM/EM derived from the grand total instead of role
// hours, a missing new-file multiplier, complexity applied per domain instead
// of per write), so the same session was priced differently in each harness.
//
// This test executes BOTH engines on the same fixtures and asserts they agree.
// It extracts the plugin's engine section — everything between the "INLINED
// ENGINE" and "SESSION BRIDGE" banners, which is plain TypeScript with no JSX
// — and imports it. The suite already runs under tsx, so a .ts file imports
// directly.
// ---------------------------------------------------------------------------

const TUI_PATH = resolve(import.meta.dirname, "../opencode/plugins/realistic-cost-tui.tsx")

function loadTuiEngine(): Promise<Record<string, any>> {
  const src = readFileSync(TUI_PATH, "utf8")

  const startMarker = src.indexOf("// INLINED ENGINE")
  const endMarker = src.indexOf("// SESSION BRIDGE")
  ok(startMarker > 0, "TUI plugin must still contain the INLINED ENGINE banner")
  ok(endMarker > startMarker, "TUI plugin must still contain the SESSION BRIDGE banner")

  // Back up to the start of each banner's rule line.
  const start = src.lastIndexOf("// ═", startMarker)
  const end = src.lastIndexOf("// ═", endMarker)
  const engine = src.slice(start, end)

  ok(/function estimateHours/.test(engine), "engine slice must include estimateHours")
  ok(/function computeCost/.test(engine), "engine slice must include computeCost")

  const dir = mkdtempSync(join(tmpdir(), "rc-parity-"))
  const file = join(dir, "tui-engine.ts")
  writeFileSync(file, engine + "\nexport { estimateHours, computeCost }\n", "utf8")
  return import(file).finally(() => rmSync(dir, { recursive: true, force: true }))
}

function statsWith(writes: Array<Partial<FileWriteOp>>, over: Partial<TranscriptStats> = {}): TranscriptStats {
  const s = emptyStats()
  s.fileWrites = writes.map((w) => ({
    path: w.path ?? "src/a.ts",
    tool: w.tool ?? "Edit",
    linesAdded: w.linesAdded ?? 0,
    linesRemoved: w.linesRemoved ?? 0,
    domain: w.domain ?? "backend",
  })) as FileWriteOp[]
  s.linesAdded = s.fileWrites.reduce((n, w) => n + w.linesAdded, 0)
  s.linesRemoved = s.fileWrites.reduce((n, w) => n + w.linesRemoved, 0)
  return Object.assign(s, over)
}

// Fixtures chosen to exercise each place the two engines previously diverged.
const FIXTURES: Array<{ name: string; stats: TranscriptStats }> = [
  {
    name: "empty session (management floor only)",
    stats: emptyStats(),
  },
  {
    name: "edits only, no new files",
    stats: statsWith([
      { tool: "Edit", linesAdded: 40, linesRemoved: 10, domain: "backend" },
      { tool: "Edit", linesAdded: 25, linesRemoved: 5, domain: "frontend" },
    ]),
  },
  {
    name: "new files (exercises the 1.5x new-file multiplier)",
    stats: statsWith([
      { tool: "Write", linesAdded: 120, linesRemoved: 0, domain: "backend" },
      { tool: "Write", linesAdded: 60, linesRemoved: 0, domain: "frontend" },
    ]),
  },
  {
    name: "one large write among small edits (per-write vs per-domain weighting)",
    stats: statsWith([
      { tool: "Write", linesAdded: 400, linesRemoved: 0, domain: "backend" },
      { tool: "Edit", linesAdded: 5, linesRemoved: 2, domain: "backend" },
      { tool: "Edit", linesAdded: 3, linesRemoved: 1, domain: "backend" },
    ]),
  },
  {
    name: "tests written (exercises the QA multiplier branch)",
    stats: statsWith([
      { tool: "Write", linesAdded: 90, linesRemoved: 0, domain: "test" },
      { tool: "Edit", linesAdded: 30, linesRemoved: 8, domain: "backend" },
    ]),
  },
  {
    name: "no tests written (opposite QA branch)",
    stats: statsWith([{ tool: "Edit", linesAdded: 30, linesRemoved: 8, domain: "backend" }]),
  },
  {
    name: "read-heavy session with thinking",
    stats: statsWith([{ tool: "Edit", linesAdded: 12, linesRemoved: 4, domain: "backend" }], {
      toolCalls: { ...emptyStats().toolCalls, read: 20, grep: 6, glob: 3, edit: 1 },
      thinkingTurns: 9,
      thinkingTokens: 4000,
    } as Partial<TranscriptStats>),
  },
]

test("opencode TUI engine prices sessions identically to src/core", async () => {
  const tui = await loadTuiEngine()

  for (const f of FIXTURES) {
    const coreReport = computeCost({ stats: f.stats, estimate: estimateHours(f.stats) })
    const tuiReport = tui.computeCost(f.stats, tui.estimateHours(f.stats), 0)

    const dCost = Math.abs(coreReport.totalCost - tuiReport.totalCost)
    const dHours = Math.abs(coreReport.totalHours - tuiReport.totalHours)

    ok(
      dCost < 0.01,
      `[${f.name}] total cost drifted: core $${coreReport.totalCost.toFixed(2)} vs TUI $${tuiReport.totalCost.toFixed(2)}`,
    )
    ok(
      dHours < 0.01,
      `[${f.name}] total hours drifted: core ${coreReport.totalHours.toFixed(2)}h vs TUI ${tuiReport.totalHours.toFixed(2)}h`,
    )
  }
})

test("opencode TUI engine matches src/core per activity line item", async () => {
  const tui = await loadTuiEngine()

  for (const f of FIXTURES) {
    const core = computeCost({ stats: f.stats, estimate: estimateHours(f.stats) })
    const plugin = tui.computeCost(f.stats, tui.estimateHours(f.stats), 0)

    const coreByName = new Map(core.activities.map((a: any) => [a.activity, a]))
    const tuiByName = new Map(plugin.activities.map((a: any) => [a.activity, a]))

    ok(
      coreByName.size === tuiByName.size,
      `[${f.name}] different line items: core [${[...coreByName.keys()].join(", ")}] vs TUI [${[...tuiByName.keys()].join(", ")}]`,
    )

    for (const [name, a] of coreByName) {
      const b = tuiByName.get(name)
      ok(b, `[${f.name}] TUI is missing line item "${name}"`)
      ok(
        Math.abs(a.cost - b.cost) < 0.01,
        `[${f.name}] "${name}" cost drifted: core $${a.cost.toFixed(2)} vs TUI $${b.cost.toFixed(2)}`,
      )
    }
  }
})
